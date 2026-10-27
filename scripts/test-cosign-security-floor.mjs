import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const reviewedSha256 =
  "c3b4f5410e608af03a5eb0aaac84a4313d8da131248e08ff1759ac70c79d1644";
function verifyInstaller(source) {
  const versions = [
    ...source.matchAll(/^\s+COSIGN_VERSION:\s*v(\d+)\.(\d+)\.(\d+)\s*$/gm),
  ];
  assert.equal(
    versions.length,
    1,
    "one verifiable Cosign installer is required",
  );
  const [major, minor, patch] = versions[0].slice(1).map(Number);
  assert.ok(
    major === 2 && (minor > 6 || (minor === 6 && patch >= 2)),
    "Cosign must preserve legacy compatibility and fix GHSA-whqx-f9j3-ch6m",
  );
  assert.equal(
    versions[0][0].trim(),
    "COSIGN_VERSION: v2.6.5",
    "Cosign version needs compatibility review",
  );
  assert.match(
    source,
    new RegExp(`COSIGN_SHA256: ${reviewedSha256}\\s`),
    "Cosign checksum must match the reviewed release",
  );
  assert.match(source, /sha256sum -c -/);
}
const sources = ["reusable-build-sign.yml", "reusable-deploy-cloudrun.yml"].map(
  (name) =>
    readFileSync(
      new URL(`../.github/workflows/${name}`, import.meta.url),
      "utf8",
    ),
);
test("shared sign and verify use the patched compatible release and verified checksum", () => {
  for (const source of sources) verifyInstaller(source);
});
test("rejects a vulnerable Cosign downgrade even with a genuine checksum", () => {
  for (const source of sources)
    assert.throws(
      () =>
        verifyInstaller(
          source
            .replace("COSIGN_VERSION: v2.6.5", "COSIGN_VERSION: v2.4.1")
            .replace(
              reviewedSha256,
              "8b24b946dd5809c6bd93de08033bcf6bc0ed7d336b7785787c080f574b89249b",
            ),
        ),
      /GHSA/,
    );
});
test("rejects checksum substitution and an unreviewed format-changing major", () => {
  assert.throws(
    () => verifyInstaller(sources[0].replace(reviewedSha256, "a".repeat(64))),
    /checksum/,
  );
  assert.throws(
    () =>
      verifyInstaller(
        sources[1].replace("COSIGN_VERSION: v2.6.5", "COSIGN_VERSION: v3.1.4"),
      ),
    /legacy compatibility/,
  );
});
