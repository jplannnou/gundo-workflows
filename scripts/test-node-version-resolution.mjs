// Contrato de la version de Node en los reusables que montan Node.
//
// Cada uno expone `node-version-file` (default `.nvmrc`) y un paso "Resolve Node
// version" que decide la version antes de setup-node. Sin esto el CI de un repo
// corria con el default del reusable aunque su runtime fuera otro (medido el
// 29-oct-2026: gundo-admin-fitness-api probaba en 22 lo que corre en 24).
//
// Aqui se exige que: el paso sea identico en los tres archivos, todo setup-node
// tome `steps.node.outputs.version` y nunca `inputs.node-version`, y el script
// del paso resuelva bien cada caso al ejecutarlo de verdad con bash.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS = ['reusable-ci.yml', 'reusable-deploy-firebase.yml', 'reusable-publish-npm.yml'];

const read = (name) => readFileSync(join(root, '.github/workflows', name), 'utf8');

// Devuelve el bloque `run: |` del paso con ese nombre, sin la sangria comun.
function runBlock(text, stepName) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === `- name: ${stepName}`);
  assert.notEqual(start, -1, `falta el paso "${stepName}"`);
  const stepIndent = lines[start].indexOf('-');
  const runAt = lines.findIndex((l, i) => i > start && l.trim() === 'run: |');
  assert.notEqual(runAt, -1, `el paso "${stepName}" no tiene run: |`);
  const body = [];
  for (let i = runAt + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() !== '' && l.search(/\S/) <= stepIndent) break;
    body.push(l);
  }
  while (body.length && body[body.length - 1].trim() === '') body.pop();
  const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.search(/\S/)));
  return body.map((l) => l.slice(indent)).join('\n') + '\n';
}

const script = runBlock(read(WORKFLOWS[0]), 'Resolve Node version');

function resolve({ file, fileName = '.nvmrc', input = '22' }) {
  const dir = mkdtempSync(join(tmpdir(), 'node-version-'));
  try {
    if (file !== undefined) writeFileSync(join(dir, fileName === '' ? '.nvmrc' : fileName), file);
    const out = join(dir, 'github-output');
    writeFileSync(out, '');
    const r = spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_WORKSPACE: dir, GITHUB_OUTPUT: out, NODE_VERSION_FILE: fileName, NODE_VERSION_INPUT: input },
    });
    const m = /^version=(.*)$/m.exec(readFileSync(out, 'utf8'));
    return { status: r.status, version: m?.[1], stdout: r.stdout };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the resolve step is identical in every reusable that sets up Node', () => {
  for (const name of WORKFLOWS.slice(1)) {
    assert.equal(runBlock(read(name), 'Resolve Node version'), script, `${name} diverge de ${WORKFLOWS[0]}`);
  }
});

test('every setup-node takes the resolved version, never the raw input', () => {
  for (const name of WORKFLOWS) {
    const text = read(name);
    assert.doesNotMatch(text, /node-version:\s*\$\{\{\s*inputs\.node-version\s*\}\}/, `${name} usa inputs.node-version`);
    const setups = text.match(/uses: actions\/setup-node@/g) ?? [];
    const wired = text.match(/node-version: \$\{\{ steps\.node\.outputs\.version \}\}/g) ?? [];
    assert.ok(setups.length > 0, `${name} no tiene setup-node`);
    assert.equal(wired.length, setups.length, `${name}: ${setups.length} setup-node, ${wired.length} con la version resuelta`);
    assert.match(text, /node-version-file:\n(?:\s+description: .*\n)?\s+type: string\n\s+default: '\.nvmrc'/, `${name}: falta el input node-version-file con default .nvmrc`);
  }
});

test('.nvmrc wins over node-version', () => {
  assert.deepEqual(resolve({ file: '26.13.0\n' }).version, '26.13.0');
});

test('a leading v and surrounding whitespace are accepted', () => {
  assert.equal(resolve({ file: '  v24.22.1  \r\n' }).version, '24.22.1');
});

test('a major-only .nvmrc is passed through', () => {
  assert.equal(resolve({ file: '22\n' }).version, '22');
});

test('without the file, node-version is the fallback', () => {
  const r = resolve({ input: '22' });
  assert.equal(r.status, 0);
  assert.equal(r.version, '22');
  assert.match(r.stdout, /desde node-version/);
});

test('an empty node-version-file ignores an existing .nvmrc', () => {
  assert.equal(resolve({ file: '26.13.0\n', fileName: '', input: '24' }).version, '24');
});

test('a custom node-version-file path is read from the repo root', () => {
  assert.equal(resolve({ file: '26.12.1\n', fileName: 'frontend.nvmrc' }).version, '26.12.1');
});

test('an alias such as lts/* fails instead of reaching setup-node', () => {
  const r = resolve({ file: 'lts/*\n' });
  assert.notEqual(r.status, 0);
  assert.equal(r.version, undefined);
});
