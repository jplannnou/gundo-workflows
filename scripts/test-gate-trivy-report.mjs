import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { evaluateTrivyReport } from "./gate-trivy-report.mjs";

const withdrawnBraces = {
  ghsa_id: "GHSA-vfj7-8cjw-p6xm", cve_id: "CVE-2026-93687", withdrawn_at: "2026-10-23T12:53:02Z",
  vulnerabilities: [{ ecosystem: "npm", package: { name: "braces" } }],
};
const activeNodeForge = {
  ghsa_id: "GHSA-86w9-cpqp-85rv", cve_id: "CVE-2026-85393", withdrawn_at: null,
  vulnerabilities: [{ ecosystem: "npm", package: { name: "node-forge" } }],
};
function vulnerability({ id, packageName, severity = "HIGH", references = [] }) {
  return { VulnerabilityID: id, PkgName: packageName, Severity: severity, References: references };
}
function report(results) { return { Results: results }; }
function npm(vulnerabilities, extras = {}) { return { Type: "npm", Vulnerabilities: vulnerabilities, ...extras }; }
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

test("malicious identifiers and references never select an external request", async () => {
  const requested = [];
  const result = await evaluateTrivyReport(await readFixture("trivy-malicious-reference.json"), { severity: "HIGH,CRITICAL", fetchImpl: fixtureFetch({}, requested) });
  assert.equal(result.blocking, 2);
  assert.deepEqual(requested, []);
});

test("API errors and malformed metadata retain the finding", async () => {
  const finding = report([npm([vulnerability({ id: "CVE-2026-93687", packageName: "braces" })])]);
  const unavailable = await evaluateTrivyReport(finding, { severity: "HIGH,CRITICAL", fetchImpl: async () => ({ ok: false }) });
  const malformed = await evaluateTrivyReport(finding, { severity: "HIGH,CRITICAL", fetchImpl: async () => ({ ok: true, json: async () => [{}] }) });
  assert.equal(unavailable.blocking, 1);
  assert.equal(malformed.blocking, 1);
});

test("workflow runs Trivy JSON gate and retains scanner transport failures", async () => {
  const workflow = await readFile(new URL("../.github/workflows/reusable-private-security.yml", import.meta.url), "utf8");
  assert.match(workflow, /--format json/);
  assert.match(workflow, /--exit-code 0/);
  assert.match(workflow, /node \.gundo-workflows\/scripts\/gate-trivy-report\.mjs/);
  assert.doesNotMatch(workflow, /Scan current files for secrets/);
});

test("the CLI accepts an actual empty Trivy JSON report without a network request", () => {
  const reportPath = new URL("./fixtures/trivy-empty.json", import.meta.url);
  const run = spawnSync(process.execPath, ["scripts/gate-trivy-report.mjs", "--report", fileURLToPath(reportPath), "--severity", "HIGH,CRITICAL"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /0 blocking/);
});
