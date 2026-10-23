import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { evaluateTrivyReport } from "./gate-trivy-report.mjs";

const activeNodeForge = {
  ghsa_id: "GHSA-86w9-cpqp-85rv", cve_id: "CVE-2026-85393", withdrawn_at: null,
  vulnerabilities: [{ package: { ecosystem: "npm", name: "node-forge" } }],
};
function vulnerability({ id, packageName, severity = "HIGH", references = [] }) {
  return { VulnerabilityID: id, PkgName: packageName, Severity: severity, References: references };
}
function report(results) { return { SchemaVersion: 2, Results: results }; }
function npm(vulnerabilities, extras = {}) { return { Class: "lang-pkgs", Type: "npm", Vulnerabilities: vulnerabilities, ...extras }; }
function fixtureFetch(records, requested) {
  return async (url) => {
    requested.push(url);
    const record = url.includes("CVE-2026-93687") ? records.braces : records.nodeForge;
    return { ok: true, json: async () => url.includes("?") ? [record] : record };
  };
}
async function readFixture(name) {
  return JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
}
const withdrawnBraces = await readFixture("github-advisory-braces-withdrawn.json");

test("withdrawn npm advisory is suppressed while active node-forge remains blocking", async () => {
  const requested = [];
  const result = await evaluateTrivyReport(await readFixture("trivy-withdrawn-and-active.json"), { severity: "HIGH,CRITICAL", fetchImpl: fixtureFetch({ braces: withdrawnBraces, nodeForge: activeNodeForge }, requested) });
  assert.equal(result.blocking, 1);
  assert.deepEqual(result.suppressed, ["GHSA-vfj7-8cjw-p6xm"]);
  assert.deepEqual(result.retained, ["CVE-2026-85393"]);
  assert.equal(requested.length, 2);
});

test("withdrawn-only report passes and lower severity stays outside the configured floor", async () => {
  const requested = [];
  const result = await evaluateTrivyReport(await readFixture("trivy-withdrawn-only.json"), { severity: "HIGH,CRITICAL", fetchImpl: fixtureFetch({ braces: withdrawnBraces }, requested) });
  assert.equal(result.blocking, 0);
  assert.deepEqual(result.suppressed, ["GHSA-vfj7-8cjw-p6xm"]);
  assert.equal(requested.length, 1);
});

test("secrets and misconfigurations remain blocking without advisory lookups", async () => {
  const requested = [];
  const result = await evaluateTrivyReport(await readFixture("trivy-secret-misconfiguration.json"), { severity: "HIGH,CRITICAL", fetchImpl: fixtureFetch({}, requested) });
  assert.equal(result.blocking, 2);
  assert.deepEqual(requested, []);
});

test("sanitized Trivy 0.74 secret and config result shapes remain blocking", async () => {
  const secret = await evaluateTrivyReport(await readFixture("trivy-v074-secret-sanitized.json"), { severity: "HIGH,CRITICAL" });
  const config = await evaluateTrivyReport(await readFixture("trivy-v074-config-sanitized.json"), { severity: "HIGH,CRITICAL" });
  assert.equal(secret.blocking, 1);
  assert.equal(config.blocking, 1);
});

test("malicious identifiers and references fail closed without an external request", async () => {
  const requested = [];
  await assert.rejects(evaluateTrivyReport(await readFixture("trivy-malicious-reference.json"), { severity: "HIGH,CRITICAL", fetchImpl: fixtureFetch({}, requested) }));
  assert.deepEqual(requested, []);
});

test("API errors and malformed metadata retain the finding", async () => {
  const finding = report([npm([vulnerability({ id: "CVE-2026-93687", packageName: "braces" })])]);
  const unavailable = await evaluateTrivyReport(finding, { severity: "HIGH,CRITICAL", fetchImpl: async () => ({ ok: false }) });
  const malformed = await evaluateTrivyReport(finding, { severity: "HIGH,CRITICAL", fetchImpl: async () => ({ ok: true, json: async () => [{}] }) });
  assert.equal(unavailable.blocking, 1);
  assert.equal(malformed.blocking, 1);
});

test("withdrawal timestamp must be canonical past RFC3339 UTC", async () => {
  const finding = await readFixture("trivy-withdrawn-only.json");
  for (const withdrawn_at of ["0", "2026-02-30T12:53:02Z", "2999-01-01T00:00:00Z"]) {
    const result = await evaluateTrivyReport(finding, {
      severity: "HIGH,CRITICAL",
      fetchImpl: fixtureFetch({ braces: { ...withdrawnBraces, withdrawn_at } }, []),
    });
    assert.equal(result.blocking, 1, withdrawn_at);
  }
});

test("unknown or malformed Trivy findings fail closed", async () => {
  for (const invalid of [
    { SchemaVersion: 2, Results: [{}] },
    report([npm([null])]),
    report([{ Class: "secret", Secrets: [{ RuleID: "fixture", Severity: "UNKNOWN" }] }]),
    report([{ Class: "config", Type: "dockerfile", Misconfigurations: [{ Severity: "HIGH" }] }]),
    { SchemaVersion: 999, Results: [] },
    { SchemaVersion: "evil", Results: [] },
    { Results: [] },
  ]) {
    await assert.rejects(evaluateTrivyReport(invalid, { severity: "HIGH,CRITICAL", fetchImpl: async () => { throw new Error("must-not-fetch"); } }));
  }
});

test("Trivy PASS misconfiguration is schema failure; reported FAIL remains blocking", async () => {
  const base = { Class: "config", Type: "dockerfile", Misconfigurations: [{ Severity: "HIGH", Status: "PASS" }] };
  const failed = await evaluateTrivyReport(report([{ ...base, Misconfigurations: [{ Severity: "HIGH", Status: "FAIL" }] }]), { severity: "HIGH,CRITICAL" });
  await assert.rejects(evaluateTrivyReport(report([base]), { severity: "HIGH,CRITICAL" }));
  assert.equal(failed.blocking, 1);
});

test("a GHSA finding must match the returned GHSA even when a different reference is present", async () => {
  const requested = [];
  const result = await evaluateTrivyReport(report([npm([vulnerability({
    id: "GHSA-86w9-cpqp-85rv", packageName: "braces", references: ["https://github.com/advisories/GHSA-vfj7-8cjw-p6xm"],
  })])]), { severity: "HIGH,CRITICAL", fetchImpl: fixtureFetch({ braces: withdrawnBraces }, requested) });
  assert.equal(result.blocking, 1);
  assert.deepEqual(result.retained, ["GHSA-86w9-cpqp-85rv"]);
  assert.match(requested[0], /GHSA-86w9-cpqp-85rv$/);
});

test("workflow runs Trivy JSON gate and retains scanner transport failures", async () => {
  const workflow = await readFile(new URL("../.github/workflows/reusable-private-security.yml", import.meta.url), "utf8");
  assert.match(workflow, /--format json/);
  assert.match(workflow, /--exit-code 0/);
  assert.match(workflow, /node \.gundo-workflows\/scripts\/gate-trivy-report\.mjs/);
  assert.match(workflow, /--skip-dirs \.gundo-workflows/);
  assert.match(workflow, /--exclude \.gundo-workflows/);
  assert.doesNotMatch(workflow, /Scan current files for secrets/);
});

test("the CLI accepts an actual empty Trivy JSON report without a network request", () => {
  const reportPath = new URL("./fixtures/trivy-empty.json", import.meta.url);
  const run = spawnSync(process.execPath, ["scripts/gate-trivy-report.mjs", "--report", fileURLToPath(reportPath), "--severity", "HIGH,CRITICAL"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /0 blocking/);
});
