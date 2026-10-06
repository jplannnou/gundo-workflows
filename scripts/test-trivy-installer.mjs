import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";

const workflow = await readFile(
  new URL(
    "../.github/workflows/reusable-private-security.yml",
    import.meta.url,
  ),
  "utf8",
);
const installerStep = workflow
  .split("      - name: Install verified Trivy with retry\n")[1]
  ?.split("\n      - name:")[0];
assert.ok(installerStep, "The production installer step must exist");
const installer = installerStep
  .split("        run: |\n")[1]
  .split("\n")
  .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
  .join("\n");
const version = "v0.74.0";
const asset = "trivy_0.74.0_Linux-64bit.tar.gz";

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      output += data;
    });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, output }));
  });
}

// Only the external transport is redirected. Bash, extraction, hashing,
// executable validation and PATH publication are the production inline code.
// The wrapper runs REAL curl against loopback; no internet/tool installation.
const curlWrapper = `#!/usr/bin/env node
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const original = process.argv.slice(2);
fs.appendFileSync(process.env.FIXTURE_CURL_ARGS, JSON.stringify(original) + '\\n');
const args = [];
for (let i = 0; i < original.length; i++) {
  const arg = original[i];
  if (arg === '--proto' || arg === '--proto-redir') { i++; continue; }
  if (arg === '--retry-delay') { args.push(arg, '1'); i++; continue; }
  if (arg === '--retry-max-time') { args.push(arg, '1'); i++; continue; }
  if (arg === '--max-time' || arg === '--connect-timeout') { args.push(arg, '1'); i++; continue; }
  if (arg.startsWith('https://github.com/aquasecurity/trivy/releases/download/')) {
    args.push(process.env.FIXTURE_ORIGIN + '/' + arg.split('/').at(-1));
  } else { args.push(arg); }
}
const result = spawnSync(process.env.FIXTURE_REAL_CURL, args, { stdio: 'inherit' });
process.exit(result.status === null ? 99 : result.status);
`;

async function exercise({
  binaryVersion = "0.74.0",
  checksum = "valid",
  transient = 0,
  unavailable = false,
  transportTimeout = false,
  staleDirectory = false,
  os = "Linux",
  arch = "X64",
  source = installer,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "gundo-trivy-fixture-"));
  let server;
  try {
    const sourceDir = join(root, "archive-source");
    const bin = join(root, "bin");
    const runnerTemp = join(root, "runner");
    await Promise.all([sourceDir, bin, runnerTemp].map((path) => mkdir(path)));
    const victim = join(root, "previous-run");
    if (staleDirectory) {
      await mkdir(victim);
      await writeFile(join(victim, "trivy"), "untouched");
      await symlink(victim, join(runnerTemp, "gundo-trivy-fixture-1"));
    }
    await writeFile(
      join(sourceDir, "trivy"),
      `#!/usr/bin/env bash\nprintf 'Version: ${binaryVersion}\\n'\n`,
      { mode: 0o755 },
    );
    const archivePath = join(root, asset);
    assert.equal(
      (await run("tar", ["-czf", archivePath, "-C", sourceDir, "trivy"])).code,
      0,
    );
    const archive = await readFile(archivePath);
    const hash = createHash("sha256").update(archive).digest("hex");
    const checksums =
      checksum === "valid"
        ? `${hash}  ${asset}\n`
        : checksum === "duplicate"
          ? `${hash}  ${asset}\n${hash}  ${asset}\n`
          : checksum === "missing"
            ? `${hash}  other.tar.gz\n`
            : checksum === "malformed"
              ? `invalid  ${asset}\n`
              : `${"0".repeat(64)}  ${asset}\n`;
    const requests = [];
    server = createServer((request, response) => {
      requests.push(request.url);
      if (transportTimeout) {
        setTimeout(() => response.writeHead(200).end(archive), 1500);
      } else if (unavailable || requests.length <= transient) {
        response.writeHead(503).end("fixture unavailable");
      } else if (request.url === `/${asset}`) {
        response.writeHead(200).end(archive);
      } else if (request.url === "/trivy_0.74.0_checksums.txt") {
        response.writeHead(200).end(checksums);
      } else {
        response.writeHead(404).end();
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const lookup = await run("bash", ["-c", "command -v curl"]);
    assert.equal(lookup.code, 0);
    const curlArgs = join(root, "curl-args.jsonl");
    const githubPath = join(root, "github-path");
    await writeFile(curlArgs, "");
    await writeFile(githubPath, "");
    await writeFile(join(bin, "curl"), curlWrapper, { mode: 0o755 });
    const result = await run("bash", ["-c", source], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        RUNNER_OS: os,
        RUNNER_ARCH: arch,
        RUNNER_TEMP: runnerTemp,
        TRIVY_VERSION: version,
        GITHUB_RUN_ID: "fixture",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_PATH: githubPath,
        FIXTURE_CURL_ARGS: curlArgs,
        FIXTURE_REAL_CURL: lookup.output.trim(),
        FIXTURE_ORIGIN: `http://127.0.0.1:${server.address().port}`,
      },
    });
    return {
      ...result,
      requests,
      published: (await readFile(githubPath, "utf8")).trim(),
      staleContents: staleDirectory
        ? await readFile(join(victim, "trivy"), "utf8")
        : null,
      curlArgs: (await readFile(curlArgs, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse),
    };
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    // Only the exact mkdtemp fixture created by this test is removed.
    await rm(root, { recursive: true, force: true });
  }
}

test("verified pinned release is exposed to subsequent scanners", async () => {
  const result = await exercise();
  assert.equal(result.code, 0);
  assert.ok(result.published);
});

test("a checksummed archive containing the wrong version fails closed", async () => {
  const result = await exercise({ binaryVersion: "0.73.0" });
  assert.notEqual(
    result.code,
    0,
    "A different executable version must not be accepted",
  );
  assert.equal(result.published, "");
});

test("release downloads have a total retry budget as well as a per-transfer bound", async () => {
  const result = await exercise();
  assert.equal(result.code, 0);
  assert.equal(result.curlArgs.length, 2);
  for (const args of result.curlArgs) {
    assert.equal(args[args.indexOf("--retry-max-time") + 1], "240");
    assert.equal(args[args.indexOf("--max-time") + 1], "60");
    assert.equal(args[args.indexOf("--proto") + 1], "=https");
    assert.equal(args[args.indexOf("--proto-redir") + 1], "=https");
  }
});

test("installation cannot overwrite a stale per-run directory through a symlink", async () => {
  const result = await exercise({ staleDirectory: true });
  assert.equal(result.code, 0);
  assert.equal(result.staleContents, "untouched");
});

test("a transient release outage is retried by real curl before installation succeeds", async () => {
  const result = await exercise({ transient: 1 });
  assert.equal(result.code, 0);
  assert.ok(result.requests.length >= 3);
  assert.ok(result.published);
});

test("an exhausted release outage fails closed without exposing provider response text", async () => {
  const result = await exercise({ unavailable: true });
  assert.notEqual(result.code, 0);
  assert.equal(result.published, "");
  assert.match(result.output, /release-unavailable/);
  assert.doesNotMatch(result.output, /fixture unavailable/);
});

test("a transport timeout is installation failure, never a clean scan", async () => {
  const result = await exercise({ transportTimeout: true });
  assert.notEqual(result.code, 0);
  assert.equal(result.published, "");
  assert.match(result.output, /transport-timeout/);
});

for (const checksum of ["missing", "malformed", "duplicate", "mismatch"]) {
  test(`checksum ${checksum} prevents binary publication`, async () => {
    const result = await exercise({ checksum });
    assert.notEqual(result.code, 0);
    assert.equal(result.published, "");
    assert.match(result.output, /Trivy checksum verification failed/);
  });
}

test("an unsupported runner fails before any transport or binary publication", async () => {
  const result = await exercise({ os: "Unknown" });
  assert.notEqual(result.code, 0);
  assert.equal(result.published, "");
  assert.equal(result.requests.length, 0);
});

test("removing retries reproduces the transient-outage failure", async () => {
  const mutant = installer.replace("--retry 5", "--retry 0");
  assert.notEqual(mutant, installer);
  const result = await exercise({ transient: 1, source: mutant });
  assert.notEqual(result.code, 0);
  assert.equal(result.published, "");
});

test("bypassing executable verification is caught by the wrong-version fixture", async () => {
  const mutant = installer.replace(
    'if ! grep -Fxq "Version: ${TRIVY_VERSION#v}" <<< "$installed_version"; then',
    "if false; then",
  );
  assert.notEqual(mutant, installer);
  const result = await exercise({ binaryVersion: "0.73.0", source: mutant });
  assert.equal(
    result.code,
    0,
    "Mutation must be exercised, not rejected by unrelated syntax",
  );
  assert.ok(
    result.published,
    "Wrong-version oracle would reject this mutation",
  );
});

test("bypassing checksum verification is caught by the corrupt-checksum fixture", async () => {
  const mutant = installer.replace(
    'if [[ -z "$expected" || "$actual" != "$expected" ]]; then',
    "if false; then",
  );
  assert.notEqual(mutant, installer);
  const result = await exercise({ checksum: "mismatch", source: mutant });
  assert.equal(result.code, 0, "Mutation must reach binary publication");
  assert.ok(result.published, "Checksum oracle would reject this mutation");
});

test("installer failure cannot be marked non-blocking and the suite stays wired into CI", async () => {
  assert.doesNotMatch(installerStep, /continue-on-error:\s*true/);
  assert.match(installerStep, /timeout-minutes:\s*12/);
  const contracts = await readFile(
    new URL(
      "../.github/workflows/validate-workflow-contracts.yml",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(
    contracts,
    /run: node --test scripts\/test-trivy-installer\.mjs/,
  );
});
