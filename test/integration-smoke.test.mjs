import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const runner = pathToFileURL(resolve('scripts/integration-smoke.mjs')).href;

async function runFixture(t, sources) {
  const root = await mkdtemp(join(tmpdir(), 'omp-smoke-selection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = [];
  for (const [index, source] of sources.entries()) {
    const file = join(root, `${index}.test.mjs`);
    await writeFile(file, source);
    files.push(file);
  }
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const entry = join(root, 'run-smoke.mjs');
  await writeFile(
    entry,
    `import {runSmokeTests} from ${JSON.stringify(runner)}; runSmokeTests(JSON.parse(process.argv[2])).then(code => { process.exitCode = code; });`,
  );
  const result = spawnSync(process.execPath, [entry, JSON.stringify(files)], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
  });
  return { root, files, result };
}

const passing = `
import test from 'node:test';
import {writeFile} from 'node:fs/promises';
test('representative [smoke]', async (t) => {
  await t.test('nested behavior', () => writeFile(new URL('./ran', import.meta.url), 'executed'));
});
test('full-only matrix', () => { throw new Error('Full-only case must not run'); });
`;

test('smoke executes tagged nested behavior and excludes the full-only matrix', async (t) => {
  const { root, result } = await runFixture(t, [passing]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(await readFile(join(root, 'ran'), 'utf8'), 'executed');
});

test('every selected file must execute a successful smoke case', async (t) => {
  const { files, result } = await runFixture(t, [
    passing,
    `import test from 'node:test'; test('full-only', () => { throw new Error('Not selected'); });`,
  ]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.ok(result.stderr.includes(files[1]), 'Missing coverage identifies the unexercised file');
});

for (const option of ['skip', 'todo']) {
  test(`${option} smoke cases cannot satisfy coverage`, async (t) => {
    const { result } = await runFixture(t, [
      `import test from 'node:test'; test('unexercised [smoke]', {${option}: true});`,
    ]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
  });
}

test('a failing smoke preserves the original failure and returns failure status', async (t) => {
  const { result } = await runFixture(t, [
    `import test from 'node:test'; test('broken [smoke]', () => { throw new Error('deliberate smoke failure'); });`,
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /deliberate smoke failure/);
});

test('an empty smoke selection fails instead of discovering arbitrary tests', async (t) => {
  const { result } = await runFixture(t, []);
  assert.equal(result.status, 1);
});
