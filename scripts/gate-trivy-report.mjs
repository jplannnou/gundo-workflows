import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const GITHUB_API_ORIGIN = "https://api.github.com";
const GHSA = /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/;
const CVE = /^CVE-\d{4}-\d{4,}$/;
const ADVISORY_REFERENCE = new RegExp(
  "^https://github\\.com/advisories/(GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})$",
);
const BLOCKING_SEVERITIES = new Set(["HIGH", "CRITICAL"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeId(value) {
  return typeof value === "string" && (GHSA.test(value) || CVE.test(value));
}

function severityFloor(value) {
  if (typeof value !== "string") throw new Error("invalid-severity-floor");
  const values = value.split(",").map((item) => item.trim().toUpperCase());
  if (!values.length || values.some((item) => !BLOCKING_SEVERITIES.has(item))) {
    throw new Error("invalid-severity-floor");
  }
  return new Set(values);
}

function candidateFromFinding(finding) {
  if (!isRecord(finding)) return null;
  if (typeof finding.VulnerabilityID === "string" && CVE.test(finding.VulnerabilityID)) {
    return { kind: "cve", value: finding.VulnerabilityID };
  }
  if (!Array.isArray(finding.References)) return null;
  for (const reference of finding.References) {
    if (typeof reference !== "string") continue;
    const match = ADVISORY_REFERENCE.exec(reference);
    if (match) return { kind: "ghsa", value: match[1] };
  }
  return null;
}

function advisoryMatches({ advisory, candidate, packageName }) {
  if (!isRecord(advisory) || typeof packageName !== "string" || !packageName) return false;
  if (typeof advisory.withdrawn_at !== "string" || Number.isNaN(Date.parse(advisory.withdrawn_at))) return false;
  if (!GHSA.test(advisory.ghsa_id ?? "") || !CVE.test(advisory.cve_id ?? "")) return false;
  if (candidate.kind === "cve" && advisory.cve_id !== candidate.value) return false;
  if (candidate.kind === "ghsa" && advisory.ghsa_id !== candidate.value) return false;
  if (!Array.isArray(advisory.vulnerabilities)) return false;
  return advisory.vulnerabilities.some(
    (item) => isRecord(item) && item.ecosystem === "npm" && item.package?.name === packageName,
  );
}

async function fetchJson(url, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "gundo-trivy-gate" },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response?.ok) throw new Error("github-advisory-unavailable");
  return response.json();
}

async function lookupAdvisory(candidate, fetchImpl) {
  if (candidate.kind === "ghsa") {
    return fetchJson(`${GITHUB_API_ORIGIN}/advisories/${candidate.value}`, fetchImpl);
  }
  const records = await fetchJson(
    `${GITHUB_API_ORIGIN}/advisories?cve_id=${encodeURIComponent(candidate.value)}`,
    fetchImpl,
  );
  if (!Array.isArray(records)) throw new Error("github-advisory-malformed");
  const matched = records.filter((record) => isRecord(record) && record.cve_id === candidate.value);
  if (matched.length !== 1) throw new Error("github-advisory-ambiguous");
  return matched[0];
}

function blocking(entry, floor) {
  return isRecord(entry) && typeof entry.Severity === "string" && floor.has(entry.Severity.toUpperCase());
}

/**
 * Evaluate a Trivy filesystem JSON report. The injected fetch is test-only;
 * the CLI below always supplies the platform fetch and the fixed API origin.
 */
export async function evaluateTrivyReport(report, { severity, fetchImpl = fetch } = {}) {
  const floor = severityFloor(severity);
  if (!isRecord(report) || !Array.isArray(report.Results)) throw new Error("unrecognized-trivy-report");

  const retained = [];
  const suppressed = [];
  let secrets = 0;
  let misconfigurations = 0;

  for (const result of report.Results) {
    if (!isRecord(result)) throw new Error("unrecognized-trivy-result");
    for (const key of ["Vulnerabilities", "Secrets", "Misconfigurations"]) {
      if (result[key] !== undefined && !Array.isArray(result[key])) throw new Error("unrecognized-trivy-result");
    }
    for (const secret of result.Secrets ?? []) if (blocking(secret, floor)) secrets += 1;
    for (const misconfiguration of result.Misconfigurations ?? []) if (blocking(misconfiguration, floor)) misconfigurations += 1;

    for (const finding of result.Vulnerabilities ?? []) {
      if (!blocking(finding, floor)) continue;
      const id = typeof finding?.VulnerabilityID === "string" && safeId(finding.VulnerabilityID)
        ? finding.VulnerabilityID
        : "unrecognized-vulnerability";
      if (result.Type !== "npm" || typeof finding?.PkgName !== "string") {
        retained.push(id);
        continue;
      }
      const candidate = candidateFromFinding(finding);
      if (!candidate) {
        retained.push(id);
        continue;
      }
      try {
        const advisory = await lookupAdvisory(candidate, fetchImpl);
        if (advisoryMatches({ advisory, candidate, packageName: finding.PkgName })) {
          suppressed.push(advisory.ghsa_id);
        } else {
          retained.push(id);
        }
      } catch {
        retained.push(id);
      }
    }
  }
  return { retained, suppressed, secrets, misconfigurations, blocking: retained.length + secrets + misconfigurations };
}

function usage() {
  return "Usage: node gate-trivy-report.mjs --report <trivy.json> --severity <HIGH,CRITICAL>";
}

async function main(args) {
  if (args.length !== 4 || args[0] !== "--report" || args[2] !== "--severity") throw new Error(usage());
  const report = JSON.parse(await readFile(args[1], "utf8"));
  const result = await evaluateTrivyReport(report, { severity: args[3] });
  const ids = [...new Set(result.retained)].filter(safeId).join(",") || "none";
  console.log(`Trivy gate: ${result.blocking} blocking; ${result.suppressed.length} withdrawn advisory finding(s) suppressed; retained IDs: ${ids}.`);
  if (result.blocking > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`::error::Trivy report gate failed closed: ${error.message}`);
    process.exitCode = 1;
  });
}
