import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const workflow = readFileSync(
  new URL('../.github/workflows/reusable-deploy-cloudrun.yml', import.meta.url),
  'utf8',
);

function step(name) {
  const marker = `      - name: ${name}`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `missing step: ${name}`);
  const end = workflow.indexOf('\n      - name:', start + marker.length);
  return workflow.slice(start, end === -1 ? undefined : end);
}

test('stage-only is opt-in and exposes the exact staged revision and rollback target', () => {
  assert.match(workflow, /stage-only:\n\s+description:[^\n]+\n\s+type: boolean\n\s+default: false/);
  assert.match(workflow, /value: \$\{\{ jobs\.deploy\.outputs\.revision \}\}/);
  assert.match(workflow, /value: \$\{\{ jobs\.deploy\.outputs\.rollback-revision \}\}/);
  assert.match(workflow, /revision: \$\{\{ steps\.deploy-new\.outputs\.revision \}\}/);
  assert.match(workflow, /rollback-revision: \$\{\{ steps\.rollback-target\.outputs\.revision \}\}/);
});

test('invalid stage-only plus direct deployment fails before cloud auth', () => {
  const validation = step('Validate deployment mode');
  assert.match(validation, /inputs\.stage-only == true && inputs\.skip-canary == true/);
  assert.match(validation, /exit 1/);
  assert.ok(workflow.indexOf('Validate deployment mode') < workflow.indexOf('Authenticate to Google Cloud'));
});

test('staging creates a tagged revision with no traffic and never shifts or promotes it', () => {
  const deploy = step('Deploy new revision (no traffic)');
  assert.match(deploy, /if: inputs\.skip-canary == false/);
  assert.match(deploy, /--no-traffic/);
  assert.match(deploy, /--tag="\$REVISION_TAG"/);
  for (const name of [
    'Shift traffic to canary',
    'Report canary started',
    'Watch canary SLO',
    'Promote canary to 100%',
    'Rollback',
  ]) {
    assert.match(step(name), /if: inputs\.skip-canary == false && inputs\.stage-only == false/);
  }
  assert.match(step('Deploy direct (skip canary, emergency)'), /if: inputs\.skip-canary == true/);
});

test('stage-only succeeds only after cleanup and public access restoration', () => {
  assert.match(step('Cleanup canary tag (always)'), /id: cleanup-tag/);
  assert.match(step('Re-bind public access (always, post-update-traffic)'), /id: rebind-public/);
  const outcome = step('Determine outcome');
  assert.match(outcome, /inputs\.stage-only/);
  assert.match(outcome, /steps\.deploy-new\.outcome/);
  assert.match(outcome, /steps\.cleanup-tag\.outcome/);
  assert.match(outcome, /steps\.rebind-public\.outcome/);
  assert.match(outcome, /status=staged/);
  assert.match(step('Report final status'), /if: always\(\) && inputs\.stage-only == false/);
  assert.match(step('Fail job if rolled back or failed'), /status != 'staged'/);
});
