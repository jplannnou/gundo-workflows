import { pathToFileURL } from "node:url";

const API_BASE_URL = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 10_000;

function required(env, name) {
  const value = env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `[canary-failure-reporter] missing required environment variable: ${name}`,
    );
  }
  return value;
}

function optional(env, name, fallback = "desconocida") {
  const value = env[name];
  return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

function assertRepository(repository) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error(
      "[canary-failure-reporter] GITHUB_REPOSITORY must be owner/repository",
    );
  }
}

function buildNotification(env) {
  const service = required(env, "SERVICE");
  const status = required(env, "STATUS");
  const repository = required(env, "GITHUB_REPOSITORY");
  const runId = required(env, "GITHUB_RUN_ID");
  const sha = required(env, "GITHUB_SHA");
  const revision = optional(env, "REVISION");
  const serving = optional(env, "SERVING");
  const project = required(env, "GCP_PROJECT");
  const region = required(env, "GCP_REGION");

  assertRepository(repository);

  const title = `🔴 Deploy no promovió: ${service} — el tráfico NO está en la última revisión`;
  const body = `El deploy de \`${service}\` terminó con estado **${status}**: la revisión nueva no tomó el 100% del tráfico (rollback o fallo). **La versión nueva NO está sirviendo** — producción quedó en la revisión anterior.

- **Commit:** \`${sha}\`
- **Revisión intentada:** \`${revision}\`
- **Revisión que sirve el tráfico:** \`${serving}\`
- **Run:** https://github.com/${repository}/actions/runs/${runId}

**Qué revisar primero:** logs de arranque de la revisión en Cloud Run (\`Container called exit(1)\`, \`failed to start and listen on PORT\`). Causa típica: el contenedor no bootea aunque \`nest build\`/\`docker build\` pasen (patrón "built ≠ boots"; ver gundo-payments-api #43).

\`\`\`sh
gcloud run services describe ${service} --region=${region} --project=${project} --format='value(status.traffic)'
gcloud run revisions logs read ${revision === "desconocida" ? "REVISION" : revision} --region=${region} --project=${project} --limit=100
\`\`\`

Cerrar este issue cuando el deploy vuelva a promover.`;

  return { body, repository, title };
}

async function responseJson(response, context) {
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(
      `[canary-failure-reporter] ${context}: GitHub API returned HTTP ${response.status}`,
    );
    error.githubStatus = response.status;
    throw error;
  }
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `[canary-failure-reporter] ${context}: GitHub API returned invalid JSON`,
    );
  }
}

function requestOptions(token, method, body) {
  const options = {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  };
  if (body !== undefined) options.body = JSON.stringify(body);
  return options;
}

async function githubJson(fetchImpl, token, path, method, body, context) {
  let response;
  try {
    response = await fetchImpl(
      `${API_BASE_URL}${path}`,
      requestOptions(token, method, body),
    );
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new Error(
        `[canary-failure-reporter] ${context}: GitHub API timed out`,
      );
    }
    throw new Error(
      `[canary-failure-reporter] ${context}: GitHub API request failed`,
    );
  }
  return responseJson(response, context);
}

export async function reportCanaryFailure({
  env = process.env,
  fetchImpl = globalThis.fetch,
  log = console.log,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("[canary-failure-reporter] fetch is unavailable");
  }

  const token = required(env, "GITHUB_TOKEN");
  const notification = buildNotification(env);
  const query = `repo:${notification.repository} is:issue is:open in:title "${notification.title}"`;
  const search = await githubJson(
    fetchImpl,
    token,
    `/search/issues?q=${encodeURIComponent(query)}&per_page=100`,
    "GET",
    undefined,
    "searching the existing deployment-failure issue",
  );
  const existing = Array.isArray(search?.items)
    ? search.items.find(
        (item) => !item.pull_request && item.title === notification.title,
      )
    : undefined;

  if (existing?.number) {
    await githubJson(
      fetchImpl,
      token,
      `/repos/${notification.repository}/issues/${existing.number}/comments`,
      "POST",
      { body: notification.body },
      "commenting on the existing deployment-failure issue",
    );
    log(`Deployment failure notification updated on issue #${existing.number}`);
    return { action: "commented", issueNumber: existing.number };
  }

  const issuePath = `/repos/${notification.repository}/issues`;
  const issuePayload = { body: notification.body, title: notification.title };
  let issue;
  try {
    issue = await githubJson(
      fetchImpl,
      token,
      issuePath,
      "POST",
      { ...issuePayload, labels: ["deploy-failed"] },
      "creating the deployment-failure issue",
    );
  } catch (error) {
    // A 422 means GitHub rejected the first write, so it could not have created
    // an issue. Preserve the previous reporter's missing-label fallback without
    // retrying ambiguous transport or server failures, which could duplicate it.
    if (error?.githubStatus !== 422) throw error;
    issue = await githubJson(
      fetchImpl,
      token,
      issuePath,
      "POST",
      issuePayload,
      "creating the deployment-failure issue without its optional label",
    );
  }
  if (!issue?.number) {
    throw new Error(
      "[canary-failure-reporter] creating the deployment-failure issue: missing issue number",
    );
  }
  log(`Deployment failure notification created as issue #${issue.number}`);
  return { action: "created", issueNumber: issue.number };
}

const isExecutedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isExecutedDirectly) {
  reportCanaryFailure().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
