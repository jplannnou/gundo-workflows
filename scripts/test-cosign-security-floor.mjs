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
const deploySource = sources[1];
const reusableBuildSigner =
  "https://github.com/jplannnou/gundo-workflows/.github/workflows/reusable-build-sign.yml@refs/heads/v1";
const githubActionsIssuer = "https://token.actions.githubusercontent.com";

function verifyIdentityContract(source) {
  const identityStep = source
    .split("- name: Resolve expected Cosign signer")[1]
    ?.split("- name: Verify image signature (Cosign)")[0];
  assert.ok(identityStep, "signer resolution must precede verification");
  assert.match(
    source,
    /signature-mode:\s*\n\s+description:[\s\S]*?type: string\s*\n\s+default: caller-workflow/,
    "signature mode must default to the existing inline caller workflow",
  );
  assert.match(
    identityStep,
    /caller-workflow\)\s*\n\s+expected_identity="https:\/\/github\.com\/\$\{CALLER_WORKFLOW_REF\}"/,
  );
  assert.match(
    identityStep,
    new RegExp(
      `reusable-build-sign\\)\\s*\\n\\s+expected_identity="${reusableBuildSigner.replaceAll(".", "\\.")}"`,
    ),
  );
  assert.match(identityStep, /Unsupported signature-mode:[\s\S]*?exit 1/);
  assert.match(
    source,
    /--certificate-identity="\$\{\{ steps\.cosign-identity\.outputs\.identity \}\}"/,
  );
  assert.match(
    source,
    /--certificate-github-workflow-repository="\$\{\{ github\.repository \}\}"/,
  );
  assert.match(
    source,
    /--certificate-github-workflow-ref="\$\{\{ github\.ref \}\}"/,
  );
  assert.match(
    source,
    /--certificate-oidc-issuer="https:\/\/token\.actions\.githubusercontent\.com"/,
  );
  assert.doesNotMatch(source, /certificate-identity-regexp/);
}

function expectedIdentity(mode, callerWorkflowRef) {
  if (mode === "caller-workflow")
    return `https://github.com/${callerWorkflowRef}`;
  if (mode === "reusable-build-sign") return reusableBuildSigner;
  throw new Error(`Unsupported signature-mode: ${mode}`);
}

function verifyCertificate(context, certificate) {
  if (!context.verifySignature) return { skipped: true, identity: null };
  assert.equal(
    certificate.identity,
    expectedIdentity(context.mode, context.workflowRef),
  );
  assert.equal(certificate.repository, context.repository);
  assert.equal(certificate.ref, context.ref);
  assert.equal(certificate.issuer, githubActionsIssuer);
  return { skipped: false, identity: certificate.identity };
}
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

test("pins the caller or shared signer identity plus the caller repository and ref", () => {
  verifyIdentityContract(deploySource);
});

test("accepts the verified current Radar certificate metadata", () => {
  const context = {
    verifySignature: true,
    mode: "caller-workflow",
    repository: "jplannnou/Gundo_Radar",
    workflowRef:
      "jplannnou/Gundo_Radar/.github/workflows/ci.yml@refs/heads/main",
    ref: "refs/heads/main",
  };
  const certificate = {
    identity:
      "https://github.com/jplannnou/Gundo_Radar/.github/workflows/ci.yml@refs/heads/main",
    repository: "jplannnou/Gundo_Radar",
    ref: "refs/heads/main",
    issuer: githubActionsIssuer,
  };
  assert.deepEqual(verifyCertificate(context, certificate), {
    skipped: false,
    identity: certificate.identity,
  });
});

test("rejects owner-wide identity, foreign repository, wrong ref and invalid mode", () => {
  const context = {
    verifySignature: true,
    mode: "caller-workflow",
    repository: "jplannnou/Gundo_Radar",
    workflowRef:
      "jplannnou/Gundo_Radar/.github/workflows/ci.yml@refs/heads/main",
    ref: "refs/heads/main",
  };
  const certificate = {
    identity:
      "https://github.com/jplannnou/Gundo_Radar/.github/workflows/ci.yml@refs/heads/main",
    repository: "jplannnou/Gundo_Radar",
    ref: "refs/heads/main",
  };
  assert.throws(() =>
    verifyCertificate(context, {
      ...certificate,
      identity:
        "https://github.com/jplannnou/iatra/.github/workflows/ci.yml@refs/heads/main",
    }),
  );
  assert.throws(() =>
    verifyCertificate(context, {
      ...certificate,
      repository: "jplannnou/other-repository",
    }),
  );
  assert.throws(() =>
    verifyCertificate(context, { ...certificate, ref: "refs/heads/develop" }),
  );
  assert.throws(() =>
    verifyCertificate({ ...context, mode: "owner-wide" }, certificate),
  );
});

test("keeps all eight current callers compatible without inventing signer claims for opt-outs", () => {
  const callers = [
    ["Gundo-Health-and-Food/gundo-payments-api", "deploy.yml", true],
    ["Gundo-Health-and-Food/genie-ui", "deploy.yml", true],
    ["Gundo-Health-and-Food/gundo-user-engine-api", "deploy.yml", false],
    ["Gundo-Health-and-Food/gundo-ecommerce-ui", "deploy.yml", true],
    ["Gundo-Health-and-Food/genie-api", "deploy.yml", true],
    ["jplannnou/Gundo_Engine", "ci.yml", true],
    ["jplannnou/Gundo_Radar", "ci.yml", true],
    ["jplannnou/gundo-feedback", "ci.yml", false],
  ];
  for (const [repository, workflow, verifySignature] of callers) {
    const workflowRef = `${repository}/.github/workflows/${workflow}@refs/heads/main`;
    const result = verifyCertificate(
      {
        verifySignature,
        mode: "caller-workflow",
        repository,
        workflowRef,
        ref: "refs/heads/main",
      },
      {
        identity: `https://github.com/${workflowRef}`,
        repository,
        ref: "refs/heads/main",
        issuer: githubActionsIssuer,
      },
    );
    assert.equal(result.skipped, !verifySignature);
    assert.equal(
      result.identity,
      verifySignature ? `https://github.com/${workflowRef}` : null,
    );
  }
});

test("supports the fixed reusable build signer while binding its caller", () => {
  const context = {
    verifySignature: true,
    mode: "reusable-build-sign",
    repository: "Gundo-Health-and-Food/photo-generator",
    workflowRef:
      "Gundo-Health-and-Food/photo-generator/.github/workflows/ci.yml@refs/heads/main",
    ref: "refs/heads/main",
  };
  assert.doesNotThrow(() =>
    verifyCertificate(context, {
      identity: reusableBuildSigner,
      repository: context.repository,
      ref: context.ref,
      issuer: githubActionsIssuer,
    }),
  );
});

test("mutation guard rejects a return to owner-wide or incomplete identity checks", () => {
  const mutations = [
    deploySource.replace(
      /--certificate-identity="[^\n]+/,
      '--certificate-identity-regexp="https://github.com/${{ github.repository_owner }}/.*" \\',
    ),
    deploySource.replace(
      /\s+--certificate-github-workflow-repository="[^\n]+/,
      "",
    ),
    deploySource.replace(/\s+--certificate-github-workflow-ref="[^\n]+/, ""),
    deploySource.replace("default: caller-workflow", "default: owner-wide"),
    deploySource.replace(
      /(::error::Unsupported signature-mode: \$SIGNATURE_MODE"\s*\n\s+)exit 1/,
      "$1exit 0",
    ),
  ];
  for (const mutation of mutations)
    assert.throws(() => verifyIdentityContract(mutation));
});
