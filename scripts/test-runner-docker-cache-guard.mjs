import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

function bashPath(value) {
  return value.replaceAll("\\", "/").replace(/^\/?([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`);
}

const scripts = bashPath(fileURLToPath(new URL("./", import.meta.url)));
const hygiene = join(scripts, "runner-docker-cache-hygiene.sh");
const admission = join(scripts, "runner-job-admission.sh");
const installer = join(scripts, "install-runner-docker-cache-guard.sh");

function run(file, args, { env = {}, cwd, waitFor } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (v) => { output += v; });
    child.stderr.on("data", (v) => { output += v; });
    child.once("error", reject);
    if (waitFor) {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${waitFor}`)), 3000);
      const poll = setInterval(async () => {
        try { await access(waitFor); clearInterval(poll); clearTimeout(timer); resolve({ child, output: () => output }); } catch {}
      }, 10);
      child.once("close", (code) => { clearInterval(poll); clearTimeout(timer); reject(new Error(`exited ${code} before ${waitFor}: ${output}`)); });
      return;
    }
    child.once("close", (code) => resolve({ code, output }));
  });
}

async function fixture({ worker = false, ready = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "gundo-runner-cache-guard-"));
  const bin = join(root, "bin"), proc = join(root, "proc"), state = join(root, "state"), systemd = join(root, "systemd"), trace = join(root, "trace");
  await Promise.all([bin, proc, state, systemd, join(proc, "100")].map((v) => mkdir(v, { recursive: true })));
  await writeFile(join(proc, "100", "comm"), worker ? "Runner.Worker\n" : "Runner.Listener\n");
  await writeFile(join(state, "listeners"), "actions-runner@one.service\nactions-runner@two.service\n");
  if (ready) await writeFile(join(state, "ready"), "actions-runner@one.service\nactions-runner@two.service\n");
  const systemctl = `#!/usr/bin/env bash
set -eu
echo "$*" >> "$FIXTURE_TRACE"
if [[ "$1" == list-units ]]; then printf 'actions-runner@one.service loaded active running\\nactions-runner@two.service loaded active running\\n'; exit 0; fi
if [[ "$1" == is-active ]]; then exit 0; fi
exit 0
`;
  const docker = `#!/usr/bin/env bash
printf 'docker %s\\n' "$*" >> "$FIXTURE_TRACE"
`;
  const policy = `#!/usr/bin/env bash
printf '{"until":"2026-10-26T00:00:00Z"}\\n'
`;
  await Promise.all([
    writeFile(join(bin, "systemctl"), systemctl, { mode: 0o755 }),
    writeFile(join(bin, "docker"), docker, { mode: 0o755 }),
    writeFile(join(bin, "policy"), policy, { mode: 0o755 }),
    writeFile(trace, ""),
  ]);
  const env = {
    GUNDO_PROC_ROOT: bashPath(proc),
    GUNDO_RUNNER_ADMISSION_STATE_DIR: bashPath(state),
    GUNDO_DOCKER_CACHE_LOCK: bashPath(join(root, "guard.lock")),
    GUNDO_SYSTEMCTL: bashPath(join(bin, "systemctl")),
    GUNDO_DOCKER: bashPath(join(bin, "docker")),
    GUNDO_DOCKER_RETENTION_POLICY: bashPath(join(bin, "policy")),
    FIXTURE_TRACE: bashPath(trace),
  };
  return { root, bin, proc, state, systemd, trace, env };
}

async function trace(f) { return readFile(f.trace, "utf8"); }
async function dispose(f) { await rm(f.root, { recursive: true, force: true }); }

test("active workers defer the cleaner without Docker mutation", async () => {
  const f = await fixture({ worker: true });
  try {
    const result = await run("bash", [hygiene, "--apply"], { env: f.env });
    assert.equal(result.code, 0);
    assert.match(result.output, /CACHE_DEFERRED reason=active-runner-worker/);
    assert.doesNotMatch(await trace(f), /docker/);
  } finally { await dispose(f); }
});

test("unknown worker state and incomplete hook coverage fail closed", async () => {
  const f = await fixture({ ready: false });
  try {
    const unknown = await run("bash", [hygiene, "--apply"], { env: { ...f.env, GUNDO_PROC_ROOT: bashPath(join(f.root, "missing")) } });
    assert.equal(unknown.code, 0);
    assert.match(unknown.output, /worker-state-unknown/);
    const coverage = await run("bash", [hygiene, "--apply"], { env: f.env });
    assert.equal(coverage.code, 0);
    assert.match(coverage.output, /admission-not-ready/);
    assert.doesNotMatch(await trace(f), /docker/);
  } finally { await dispose(f); }
});

test("exclusive cleaner lock defers another cleaner and admission waits for it", async () => {
  const f = await fixture();
  try {
    const held = join(f.root, "held");
    const holder = await run("bash", ["-c", `exec 9>\"$GUNDO_DOCKER_CACHE_LOCK\"; flock -x 9; : > \"${bashPath(held)}\"; sleep 0.25`], { env: f.env, waitFor: held });
    const deferred = await run("bash", [hygiene, "--apply"], { env: f.env });
    assert.equal(deferred.code, 0);
    assert.match(deferred.output, /cache-cleaner-busy/);
    let admittedEarly = false;
    const job = run("bash", [admission], { env: f.env }).then((value) => { admittedEarly = true; return value; });
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(admittedEarly, false, "job must wait while cleaner lock is exclusive");
    const holderExit = await new Promise((resolve) => holder.child.once("close", resolve));
    assert.equal(holderExit, 0);
    const admitted = await job;
    assert.equal(admitted.code, 0);
    assert.match(admitted.output, /CACHE_ADMISSION_GRANTED/);
    assert.doesNotMatch(await trace(f), /docker/);
  } finally { await dispose(f); }
});

test("only a ready, quiescent runner set may execute the two cache prunes", async () => {
  const f = await fixture();
  try {
    const dry = await run("bash", [hygiene, "--dry-run"], { env: f.env });
    assert.equal(dry.code, 0);
    assert.match(dry.output, /CACHE_PLAN mode=--dry-run/);
    assert.doesNotMatch(await trace(f), /docker/);
    const apply = await run("bash", [hygiene, "--apply"], { env: f.env });
    assert.equal(apply.code, 0);
    const calls = (await trace(f)).split("\n").filter((v) => v.startsWith("docker "));
    assert.equal(calls.length, 3);
    assert.match(calls[1], /image prune --all --force/);
    assert.match(calls[2], /buildx prune --builder default --all --force/);
  } finally { await dispose(f); }
});

test("installer dry-run plans exact files and never changes Docker or runner services", async () => {
  const f = await fixture();
  try {
    const result = await run("bash", [installer, "--dry-run"], { env: { ...f.env, GUNDO_SYSTEMD_DIR: bashPath(f.systemd), GUNDO_INSTALL_PREFIX: bashPath(join(f.root, "prefix")) } });
    assert.equal(result.code, 0);
    assert.match(result.output, /gundo-runner-job-admission\.sh/);
    assert.match(result.output, /actions-runner@one\.service\.d/);
    assert.doesNotMatch(await trace(f), /docker|daemon-reload|restart/);
  } finally { await dispose(f); }
});

test("installer refuses an activation restart while a worker is active", async () => {
  const f = await fixture({ worker: true });
  try {
    const prefix = join(f.root, "prefix");
    const result = await run("bash", [installer, "--apply", "--restart-idle-runners"], { env: { ...f.env, GUNDO_SYSTEMD_DIR: bashPath(f.systemd), GUNDO_INSTALL_PREFIX: bashPath(prefix) } });
    assert.notEqual(result.code, 0);
    assert.match(result.output, /RUNNER_GUARD_REFUSED active-runner-worker/);
    const calls = await trace(f);
    assert.match(calls, /daemon-reload/);
    assert.doesNotMatch(calls, /restart/);
    await access(join(prefix, "bin", "gundo-runner-job-admission.sh"));
  } finally { await dispose(f); }
});

test("idle activation restarts every listener and records complete readiness", async () => {
  const f = await fixture();
  try {
    const prefix = join(f.root, "prefix");
    const result = await run("bash", [installer, "--apply", "--restart-idle-runners"], { env: { ...f.env, GUNDO_SYSTEMD_DIR: bashPath(f.systemd), GUNDO_INSTALL_PREFIX: bashPath(prefix) } });
    assert.equal(result.code, 0);
    assert.match(result.output, /RUNNER_GUARD_READY listeners=2/);
    assert.equal(await readFile(join(f.state, "ready"), "utf8"), "actions-runner@one.service\nactions-runner@two.service\n");
    const calls = await trace(f);
    assert.match(calls, /restart actions-runner@one\.service/);
    assert.match(calls, /restart actions-runner@two\.service/);
    assert.doesNotMatch(calls, /docker/);
  } finally { await dispose(f); }
});
