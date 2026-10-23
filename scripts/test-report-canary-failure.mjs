import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { reportCanaryFailure } from "./report-canary-failure.mjs";

const workflow = readFileSync(
  new URL("../.github/workflows/reusable-deploy-cloudrun.yml", import.meta.url),
  "utf8",
);

function environment(overrides = {}) {
  return {
    GITHUB_TOKEN: "test-token",
    GITHUB_REPOSITORY: "jplannnou/example-service",
    GITHUB_RUN_ID: "123456",
    GITHUB_SHA: "abc123",
    GCP_PROJECT: "example-project",
    GCP_REGION: "us-central1",
    REVISION: "example-service-00001-abc",
    SERVICE: "example-service",
    SERVING: "example-service-00000-old",
    STATUS: "failed",
    ...overrides,
  };
}

function fakeFetch(responses, requests) {
  return async (url, options) => {
    requests.push({ options, url: String(url) });
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return new Response(JSON.stringify(response.body), {
      status: response.status ?? 200,
    });
  };
}

test("comments on the exact existing issue through GitHub REST without gh", async () => {
  const requests = [];
  const logs = [];
  const result = await reportCanaryFailure({
    env: environment(),
    fetchImpl: fakeFetch(
      [
        {
          body: {
            items: [
              {
                number: 71,
                title:
                  "🔴 Deploy no promovió: example-service — el tráfico NO está en la última revisión",
              },
            ],
          },
        },
        { body: { id: 9 } },
      ],
      requests,
    ),
    log: (message) => logs.push(message),
  });

  assert.deepEqual(result, { action: "commented", issueNumber: 71 });
  assert.equal(requests.length, 2);
  assert.match(
    requests[0].url,
    /^https:\/\/api\.github\.com\/search\/issues\?/,
  );
  assert.match(
    requests[1].url,
    /\/repos\/jplannnou\/example-service\/issues\/71\/comments$/,
  );
  assert.equal(requests[0].options.method, "GET");
  assert.equal(requests[1].options.method, "POST");
  assert.equal(requests[1].options.headers.authorization, "Bearer test-token");
  assert.match(
    JSON.parse(requests[1].options.body).body,
    /example-service-00001-abc/,
  );
  assert.deepEqual(logs, [
    "Deployment failure notification updated on issue #71",
  ]);
});

test("creates one labelled issue when no exact open issue exists", async () => {
  const requests = [];
  const result = await reportCanaryFailure({
    env: environment(),
    fetchImpl: fakeFetch(
      [{ body: { items: [] } }, { body: { number: 72 } }],
      requests,
    ),
    log: () => {},
  });

  assert.deepEqual(result, { action: "created", issueNumber: 72 });
  assert.equal(requests.length, 2);
  assert.match(requests[1].url, /\/repos\/jplannnou\/example-service\/issues$/);
  const created = JSON.parse(requests[1].options.body);
  assert.deepEqual(created.labels, ["deploy-failed"]);
  assert.equal(
    created.title,
    "🔴 Deploy no promovió: example-service — el tráfico NO está en la última revisión",
  );
});

test("an API error propagates and never reports a false success", async () => {
  await assert.rejects(
    reportCanaryFailure({
      env: environment(),
      fetchImpl: fakeFetch(
        [{ status: 403, body: { message: "forbidden" } }],
        [],
      ),
      log: () => assert.fail("must not report success"),
    }),
    /searching the existing deployment-failure issue: GitHub API returned HTTP 403/,
  );
});

test("network failure propagates without disclosing the request URL or token", async () => {
  await assert.rejects(
    reportCanaryFailure({
      env: environment(),
      fetchImpl: fakeFetch(
        [new Error("offline test-token https://internal.example")],
        [],
      ),
      log: () => assert.fail("must not report success"),
    }),
    (error) => {
      assert.match(error.message, /GitHub API request failed/);
      assert.doesNotMatch(error.message, /test-token|internal\.example/);
      return true;
    },
  );
});

test("the reusable workflow invokes the Node reporter, so a host without gh remains covered", () => {
  const marker = "      - name: Aviso ruidoso si el deploy no promovió";
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, "missing canary failure notification step");
  const end = workflow.indexOf("\n      - name:", start + marker.length);
  const step = workflow.slice(start, end === -1 ? undefined : end);

  assert.match(step, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(
    step,
    /node \.gundo-workflows\/scripts\/report-canary-failure\.mjs/,
  );
  assert.doesNotMatch(step, /\bgh\s+(issue|api)\b/);
});
