import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const workflow = (
  await readFile(
    new URL(
      "../.github/workflows/reusable-private-security.yml",
      import.meta.url,
    ),
    "utf8",
  )
).replace(/\r\n/g, "\n");
const block = workflow
  .split("      - name: Scan dependencies and configuration\n")[1]
  ?.split("\n      - name:")[0];
assert(block, "Real production scanner step required");
const scan = block
  .split("        run: |\n")[1]
  .split("\n")
  .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
  .join("\n");

// Execute the real Bash step. Only the external scanner is a fixture. Two
// independent jobs share toolcache + temp roots and synchronize with files,
// never an assumed 80ms window. Shared cache writers collide deterministically.
const scanner = `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2); const cache = args[args.indexOf('--cache-dir') + 1];
const signals = process.env.FIXTURE_SIGNALS; const id = process.env.FIXTURE_JOB;
fs.writeFileSync(path.join(signals, id + '.args'), JSON.stringify(args));
fs.writeFileSync(path.join(signals, id + '.started'), '1');
fs.mkdirSync(cache, { recursive: true });
try { fs.mkdirSync(path.join(cache, 'writer')); }
catch { fs.writeFileSync(path.join(signals, id + '.attempted'), '1'); process.exit(73); }
fs.writeFileSync(path.join(signals, id + '.attempted'), '1');
(async () => {
 const deadline = Date.now() + 5000;
 while (fs.readdirSync(signals).filter(v => v.endsWith('.attempted')).length < Number(process.env.FIXTURE_PEERS)) {
   if (Date.now() > deadline) process.exit(74);
   await new Promise(resolve => setTimeout(resolve, 5));
 }
 fs.rmdirSync(path.join(cache, 'writer'));
 process.exit(Number(process.env.FIXTURE_SCAN_EXIT));
})();
`;

function bash(source, env, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", source], {
      env,
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (v) => {
      output += v;
    });
    child.stderr.on("data", (v) => {
      output += v;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
}

async function exercise({
  source = scan,
  jobs = 2,
  sameRun = false,
  scanExit = 0,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "gundo-trivy-cache-test-"));
  try {
    const bin = join(root, "bin"),
      runnerTemp = join(root, "temp"),
      toolcache = join(root, "tools"),
      signals = join(root, "signals");
    await Promise.all(
      [bin, runnerTemp, toolcache, signals].map((v) => mkdir(v)),
    );
    const shared = join(toolcache, "gundo-trivy-cache");
    await mkdir(shared);
    await writeFile(
      join(shared, "metadata.json"),
      "fixture-incomplete-metadata",
    );
    await writeFile(join(bin, "trivy"), scanner, { mode: 0o755 });
    const result = await Promise.all(
      Array.from({ length: jobs }, (_, i) =>
        bash(
          source,
          {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            RUNNER_TEMP: runnerTemp,
            RUNNER_TOOL_CACHE: toolcache,
            GITHUB_RUN_ID: sameRun ? "same-run" : `run-${i}`,
            GITHUB_RUN_ATTEMPT: "1",
            GITHUB_EVENT_NAME: "pull_request",
            TRIVY_SEVERITY: "HIGH,CRITICAL",
            FIXTURE_SIGNALS: signals,
            FIXTURE_JOB: String(i),
            FIXTURE_PEERS: String(jobs),
            FIXTURE_SCAN_EXIT: String(scanExit),
          },
          root,
        ),
      ),
    );
    const args = await Promise.all(
      result.map((_, i) =>
        readFile(join(signals, `${i}.args`), "utf8").then(JSON.parse),
      ),
    );
    const caches = args.map((v) => v[v.indexOf("--cache-dir") + 1]);
    const removed = await Promise.all(
      caches.map((v) =>
        access(v).then(
          () => false,
          () => true,
        ),
      ),
    );
    assert.equal(
      await readFile(join(shared, "metadata.json"), "utf8"),
      "fixture-incomplete-metadata",
    );
    return { result, args, caches, removed, runnerTemp, shared };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

for (const sameRun of [false, true])
  test(`concurrent jobs have exclusive fresh caches (same run: ${sameRun})`, async () => {
    const x = await exercise({ sameRun });
    assert.deepEqual(
      x.result.map((v) => v.code),
      [0, 0],
    );
    assert.equal(new Set(x.caches).size, 2);
    assert(
      x.caches.every((v) => v.startsWith(x.runnerTemp + "/gundo-trivy-db-")),
    );
    assert.deepEqual(x.removed, [true, true]);
  });

test("a scanner refusal is propagated and its private cache is removed", async () => {
  const x = await exercise({ jobs: 1, scanExit: 1 });
  assert.equal(x.result[0].code, 1);
  assert.deepEqual(x.removed, [true]);
  for (const flag of [
    "--scanners",
    "vuln,misconfig",
    "--include-dev-deps",
    "--severity",
    "HIGH,CRITICAL",
    "--ignore-unfixed",
    "--exit-code",
    "1",
  ])
    assert(x.args[0].includes(flag), flag);
});

test("mutation: restoring the shared cache exposes a concurrent writer", async () => {
  const mutation = scan
    .replace(
      /cache_dir=.*\n/,
      'cache_dir="${RUNNER_TOOL_CACHE}/gundo-trivy-cache"\n',
    )
    .replace(/^trap .*\n/gm, "");
  assert.notEqual(mutation, scan, "Mutation must change the production code");
  const x = await exercise({ source: mutation });
  assert(x.result.some((v) => v.code === 73));
  assert.equal(new Set(x.caches).size, 1);
});

test("the concurrency regression runs in shared workflow CI", async () => {
  const ci = await readFile(
    new URL(
      "../.github/workflows/validate-workflow-contracts.yml",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(ci, /run: node --test scripts\/test-trivy-cache-isolation\.mjs/);
});
