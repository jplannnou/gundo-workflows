import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const scripts = fileURLToPath(new URL("./", import.meta.url));
const hygiene = join(scripts, "runner-docker-cache-hygiene.sh");
const admission = join(scripts, "runner-job-admission.sh");
const installer = join(scripts, "install-runner-docker-cache-guard.sh");
const units = ["actions-runner@one.service", "personal-actions-runner@two.service"];
const canonicalLock = "/run/lock/gundo-docker-cache-hygiene.lock";
const canonicalTmpfiles = "/etc/tmpfiles.d/gundo-runner-docker-cache-admission.conf";

function run(file, args, { env = {}, waitFor } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (v) => { output += v; }); child.stderr.on("data", (v) => { output += v; }); child.once("error", reject);
    if (!waitFor) return child.once("close", (code) => resolve({ code, output }));
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${waitFor}`)), 3000);
    const poll = setInterval(async () => { try { await access(waitFor); clearInterval(poll); clearTimeout(timer); resolve({ child, output: () => output }); } catch {} }, 10);
    child.once("close", (code) => { clearInterval(poll); clearTimeout(timer); reject(new Error(`exited ${code} before ${waitFor}: ${output}`)); });
  });
}

async function fixture({ worker = false, ready = true, hookLoaded = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "gundo-runner-cache-guard-"));
  const bin = join(root, "bin"), proc = join(root, "proc"), state = join(root, "state"), systemd = join(root, "systemd"), trace = join(root, "trace"), prefix = join(root, "prefix");
  await Promise.all([bin, proc, state, systemd, prefix].map((v) => mkdir(v, { recursive: true })));
  const hook = join(prefix, "bin", "gundo-runner-job-admission.sh");
  for (const [index, unit] of units.entries()) {
    const pid = String(101 + index); await mkdir(join(proc, pid));
    await writeFile(join(proc, pid, "comm"), "Runner.Listener\n");
    await writeFile(join(proc, pid, "cgroup"), `0::/system.slice/${unit}\n`);
    await writeFile(join(proc, pid, "environ"), Buffer.from(`${hookLoaded ? `ACTIONS_RUNNER_HOOK_JOB_STARTED=${hook}` : "OTHER=1"}\0`));
  }
  if (worker) { await mkdir(join(proc, "200")); await writeFile(join(proc, "200", "comm"), "Runner.Worker\n"); await writeFile(join(proc, "200", "cgroup"), "0::/system.slice/actions-runner@one.service\n"); }
  await writeFile(join(state, "listeners"), `${units.join("\n")}\n`); if (ready) await writeFile(join(state, "ready"), `${units.join("\n")}\n`);
  const systemctl = `#!/usr/bin/env bash
set -eu; echo "$*" >> "$FIXTURE_TRACE"
if [[ "$1" == list-units ]]; then printf 'actions-runner@one.service loaded active running\\npersonal-actions-runner@two.service loaded active running\\n'; exit 0; fi
if [[ "$1" == is-active || "$1" == show || "$1" == daemon-reload || "$1" == stop || "$1" == start ]]; then exit 0; fi
exit 1
`;
  const docker = `#!/usr/bin/env bash
printf 'docker %s\\n' "$*" >> "$FIXTURE_TRACE"
if [[ "$*" == *'buildx prune --help'* ]]; then printf '%s\\n' '--max-used-space --reserved-space'; fi
`;
  const fstrim = `#!/usr/bin/env bash\nprintf 'fstrim %s\\n' "$*" >> "$FIXTURE_TRACE"\n`;
  const tmpfiles = `#!/usr/bin/env bash
set -eu
printf 'tmpfiles %s\\n' "$*" >> "$FIXTURE_TRACE"
target="$GUNDO_TMPFILES_ROOT/run/lock/gundo-docker-cache-hygiene.lock"
if [[ ! -e "$target" ]]; then mkdir -p "$(dirname "$target")"; : > "$target"; chmod 0644 "$target"; fi
`;
  const policy = `import json\nprint(json.dumps({"until": 1793040922, "retention_seconds": 21600}))\n`;
  await Promise.all([writeFile(join(bin, "systemctl"), systemctl, { mode: 0o755 }), writeFile(join(bin, "docker"), docker, { mode: 0o755 }), writeFile(join(bin, "fstrim"), fstrim, { mode: 0o755 }), writeFile(join(bin, "tmpfiles"), tmpfiles, { mode: 0o755 }), writeFile(join(bin, "policy.py"), policy, { mode: 0o644 }), writeFile(trace, "")]);
  const env = { GUNDO_PROC_ROOT: proc, GUNDO_RUNNER_ADMISSION_STATE_DIR: state, GUNDO_DOCKER_CACHE_LOCK: join(root, "guard.lock"), GUNDO_SYSTEMCTL: join(bin, "systemctl"), GUNDO_DOCKER: join(bin, "docker"), GUNDO_FSTRIM: join(bin, "fstrim"), GUNDO_DOCKER_RETENTION_POLICY: join(bin, "policy.py"), GUNDO_SYSTEMD_TMPFILES: join(bin, "tmpfiles"), GUNDO_EXPECTED_RUNNER_LISTENERS: "2", GUNDO_INSTALL_PREFIX: prefix, GUNDO_JOB_STARTED_HOOK: hook, FIXTURE_TRACE: trace };
  return { root, bin, proc, state, systemd, trace, prefix, hook, env };
}
async function trace(f) { return readFile(f.trace, "utf8"); }
async function dispose(f) { await rm(f.root, { recursive: true, force: true }); }
function installerEnv(f) {
  const { GUNDO_DOCKER_CACHE_LOCK: _ignored, ...env } = f.env;
  return { ...env, GUNDO_SYSTEMD_DIR: f.systemd, GUNDO_TMPFILES_ROOT: f.root };
}

test("active workers, unreadable process state, and incomplete hooks defer without Docker mutation", async () => {
  const active = await fixture({ worker: true }); const incomplete = await fixture({ ready: false });
  try {
    const a = await run("bash", [hygiene, "--apply"], { env: active.env }); assert.equal(a.code, 0); assert.match(a.output, /active-runner-worker/);
    const unknown = await run("bash", [hygiene, "--apply"], { env: { ...incomplete.env, GUNDO_PROC_ROOT: join(incomplete.root, "missing") } }); assert.equal(unknown.code, 0); assert.match(unknown.output, /worker-state-unknown/);
    const coverage = await run("bash", [hygiene, "--apply"], { env: incomplete.env }); assert.equal(coverage.code, 0); assert.match(coverage.output, /admission-not-ready/);
    assert.doesNotMatch(await trace(active), /docker/); assert.doesNotMatch(await trace(incomplete), /docker/);
  } finally { await dispose(active); await dispose(incomplete); }
});

test("exclusive cleaner blocks admission; root-owned 0644 lock is read by an unprivileged hook", { skip: process.getuid?.() !== 0 }, async () => {
  const f = await fixture();
  try {
    await chmod(f.root, 0o755); await writeFile(f.env.GUNDO_DOCKER_CACHE_LOCK, ""); await chmod(f.env.GUNDO_DOCKER_CACHE_LOCK, 0o644);
    const held = join(f.root, "held");
    const holder = await run("bash", ["-c", `exec 9>>"$GUNDO_DOCKER_CACHE_LOCK"; flock -x 9; : > "${held}"; sleep 1`], { env: f.env, waitFor: held });
    const cleaner = await run("bash", [hygiene, "--apply"], { env: f.env }); assert.equal(cleaner.code, 0); assert.match(cleaner.output, /cache-cleaner-busy/);
    let done = false; const job = run("runuser", ["-u", "nobody", "--", "env", ...Object.entries(f.env).flatMap(([k, v]) => [`${k}=${v}`]), "bash", admission]).then((v) => { done = true; return v; });
    await new Promise((resolve) => setTimeout(resolve, 75)); assert.equal(done, false);
    // The holder's child may already have exited by the time an event listener
    // is added on a loaded CI runner. Its bounded sleep is sufficient here;
    // the admission promise below still proves the shared lock is released.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const granted = await job; assert.equal(granted.code, 0); assert.match(granted.output, /CACHE_ADMISSION_GRANTED/);
  } finally { await dispose(f); }
});

test("only a ready 2-listener set with non-executable Python policy may prune", async () => {
  const f = await fixture();
  try {
    const dry = await run("bash", [hygiene, "--dry-run"], { env: f.env }); assert.equal(dry.code, 0); assert.match(dry.output, /image_retention_seconds=21600/); assert.match(dry.output, /ORPHAN_BUILDER_VOLUMES.*apply=0/);
    const apply = await run("bash", [hygiene, "--apply"], { env: f.env }); assert.equal(apply.code, 0);
    const calls = (await trace(f)).split("\n").filter((v) => v.startsWith("docker ")); assert(calls.some((v) => /image prune/.test(v))); assert(calls.some((v) => /buildx prune --builder/.test(v))); assert.match(await trace(f), /fstrim/);
  } finally { await dispose(f); }
});

test("installer discovers both unit families, stages by default, and rejects foreign hooks", async () => {
  const f = await fixture(); const custom = await fixture();
  try {
    const dry = await run("bash", [installer, "--dry-run"], { env: installerEnv(f) }); assert.equal(dry.code, 0); assert.match(dry.output, /listeners=2/); assert.match(dry.output, /personal-actions-runner@two/);
    const staged = await run("bash", [installer, "--apply"], { env: installerEnv(f) }); assert.equal(staged.code, 0); assert.match(staged.output, /RUNNER_GUARD_PENDING external-quiescence-token-required/); assert.doesNotMatch(await trace(f), /\ndocker |\n(?:stop|start) /);
    const policy = await readFile(join(f.root, canonicalTmpfiles), "utf8"); assert.equal(policy, `f ${canonicalLock} 0644 root root -\n`);
    const dropin = await readFile(join(f.systemd, `${units[0]}.d`, "90-gundo-docker-cache-admission.conf"), "utf8"); assert.match(dropin, /ExecStartPre=\/usr\/bin\/systemd-tmpfiles --create \/etc\/tmpfiles\.d\/gundo-runner-docker-cache-admission\.conf/);
    const foreign = join(f.root, "foreign-systemctl"); await writeFile(foreign, `#!/usr/bin/env bash\nif [[ "$1" == list-units ]]; then printf 'actions-runner@one.service loaded active running\\npersonal-actions-runner@two.service loaded active running\\n'; elif [[ "$1" == show ]]; then printf 'ACTIONS_RUNNER_HOOK_JOB_STARTED=/foreign\\n'; fi\n`, { mode: 0o755 });
    const rejected = await run("bash", [installer, "--dry-run"], { env: { ...installerEnv(f), GUNDO_SYSTEMCTL: foreign } }); assert.notEqual(rejected.code, 0); assert.match(rejected.output, /foreign-job-started-hook/);
    const customPath = join(custom.root, "not-a-lock");
    const customRejected = await run("bash", [installer, "--apply"], { env: { ...installerEnv(custom), GUNDO_DOCKER_CACHE_LOCK: customPath } }); assert.notEqual(customRejected.code, 0); assert.match(customRejected.output, /custom-lock-path/);
    await assert.rejects(access(join(custom.root, canonicalTmpfiles)));
  } finally { await dispose(f); await dispose(custom); }
});

test("tmpfiles restores the admission lock after an ephemeral reset and preserves an existing inode", async () => {
  const fresh = await fixture(); const existing = await fixture();
  try {
    const freshRun = await run("bash", [installer, "--apply"], { env: installerEnv(fresh) }); assert.equal(freshRun.code, 0);
    const freshLock = join(fresh.root, canonicalLock); const created = await stat(freshLock); assert.equal(created.mode & 0o777, 0o644);
    await rm(freshLock); // Simulates WSL clearing the volatile /run tree.
    const neutralPolicy = join(fresh.root, "tmpfiles-isolated.conf"); await writeFile(neutralPolicy, `f ${canonicalLock} 0644 - - -\n`);
    const restored = await run("systemd-tmpfiles", ["--create", `--root=${fresh.root}`, neutralPolicy]); assert.equal(restored.code, 0);
    const restoredLock = await stat(freshLock); assert.equal(restoredLock.mode & 0o777, 0o644);
    const admitted = await run("bash", [admission], { env: { ...fresh.env, GUNDO_DOCKER_CACHE_LOCK: freshLock } }); assert.equal(admitted.code, 0); assert.match(admitted.output, /CACHE_ADMISSION_GRANTED/);

    const existingLock = join(existing.root, canonicalLock); await mkdir(join(existing.root, "run", "lock"), { recursive: true }); await writeFile(existingLock, "held-lock\n"); const before = await stat(existingLock);
    const existingRun = await run("bash", [installer, "--apply"], { env: installerEnv(existing) }); assert.equal(existingRun.code, 0);
    const after = await stat(existingLock); assert.equal(after.ino, before.ino); assert.equal(await readFile(existingLock, "utf8"), "held-lock\n");
  } finally { await dispose(fresh); await dispose(existing); }
});

test("unowned listener and incomplete 22-listener coverage are refused before staging", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.proc, "999")); await writeFile(join(f.proc, "999", "comm"), "Runner.Listener\n"); await writeFile(join(f.proc, "999", "cgroup"), "0::/system.slice/unknown.service\n");
    const unknown = await run("bash", [installer, "--dry-run"], { env: installerEnv(f) }); assert.notEqual(unknown.code, 0); assert.match(unknown.output, /listener-discovery-unknown/);
    await rm(join(f.proc, "999"), { recursive: true });
    const coverage = await run("bash", [installer, "--dry-run"], { env: { ...installerEnv(f), GUNDO_EXPECTED_RUNNER_LISTENERS: "22" } }); assert.notEqual(coverage.code, 0); assert.match(coverage.output, /listener-count expected=22 actual=2/);
  } finally { await dispose(f); }
});

test("activation requires an external quiescence token and never stops a worker", async () => {
  const f = await fixture({ worker: true });
  try {
    const token = join(f.root, "quiescent"); await writeFile(token, "GUNDO_RUNNER_QUIESCENT=1\n");
    const result = await run("bash", [installer, "--apply", "--activate-idle-runners", token], { env: installerEnv(f) });
    assert.notEqual(result.code, 0); assert.match(result.output, /quiescence-not-proven/); assert.doesNotMatch(await trace(f), / stop /);
  } finally { await dispose(f); }
});
