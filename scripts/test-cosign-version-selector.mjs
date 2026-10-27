import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const source = readFileSync(
  new URL("../.github/workflows/reusable-deploy-cloudrun.yml", import.meta.url),
  "utf8",
);
const installer = source
  .split("- name: Install Cosign")[1]
  .split("- name: Login cosign")[0];
const selector = installer
  .split("run: |\n")[1]
  .split('mkdir -p "$RUNNER_TEMP/bin"')[0];
const legacyChecksum =
  "c3b4f5410e608af03a5eb0aaac84a4313d8da131248e08ff1759ac70c79d1644";
const modernChecksum =
  "424e2c97d0b45fd7a6b608a87f090f35633f4c23ece5f092d48bba11aaf4bbfa";

function select(version) {
  return spawnSync(
    "bash",
    ["-c", selector + '\nprintf "%s %s" "$COSIGN_VERSION" "$COSIGN_SHA256"'],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        COSIGN_VERSION: "v2.6.5",
        COSIGN_SHA256: legacyChecksum,
        REQUESTED_COSIGN_VERSION: version,
      },
    },
  );
}

test("legacy callers keep their reviewed verifier and checksum by default", () => {
  assert.match(
    source,
    /cosign-version:\s*\n\s+description:.*\n\s+type: string\s*\n\s+default: v2\.6\.5/,
  );
  assert.match(
    installer,
    /REQUESTED_COSIGN_VERSION: \$\{\{ inputs\.cosign-version \}\}/,
  );
  const result = select("v2.6.5");
  assert.ifError(result.error);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, `v2.6.5 ${legacyChecksum}`);
});

test("modern bundles select the proven v3 verifier and its exact checksum", () => {
  const result = select("v3.1.4");
  assert.ifError(result.error);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, `v3.1.4 ${modernChecksum}`);
  assert.match(installer, /sha256sum -c -/);
});

test("unreviewed versions and shell text fail before download", () => {
  for (const version of [
    "",
    "v2.4.1",
    "v3.1.5",
    "v3.1.4; echo injected",
    "$(echo injected)",
  ]) {
    const result = select(version);
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /Unsupported Cosign verifier version/);
    assert.doesNotMatch(result.stdout, /injected/);
  }
});
