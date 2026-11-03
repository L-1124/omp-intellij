import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  defaultInstallDir,
  readObservedInstallState,
  readServerConfig,
  saveServerConfig,
  trackInstallation,
} from '../src/server/config.js';

async function temporaryConfig(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'omp server config '));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, configFile: join(root, 'agent', 'intellij.json') };
}

test('first use selects managed installation while explicit external selection remains authoritative', async (t) => {
  const options = await temporaryConfig(t);
  assert.deepEqual(await readServerConfig('', options), {
    mode: 'managed',
    installDir: defaultInstallDir(),
  });
  const executable = join(options.root, 'external server');
  await saveServerConfig({ mode: 'external', executable }, options);
  assert.deepEqual(await readServerConfig('', options), {
    mode: 'external',
    executable: resolve(executable),
  });
});

test('managed selection overrides external fallback, preserves unrelated user options, and can switch back', async (t) => {
  const options = await temporaryConfig(t);
  const fallback = join(options.root, 'external', 'server');
  assert.deepEqual(await readServerConfig(fallback, options), {
    mode: 'external',
    executable: fallback,
  });
  await mkdir(join(options.root, 'agent'), { recursive: true });
  await writeFile(options.configFile, JSON.stringify({ custom: { keep: true } }));
  const installDir = join(options.root, 'my install');
  await saveServerConfig({ mode: 'managed', installDir }, options);
  assert.deepEqual(await readServerConfig(fallback, options), {
    mode: 'managed',
    installDir: resolve(installDir),
  });
  const stored = JSON.parse(await readFile(options.configFile, 'utf8')) as {
    custom: { keep: boolean };
  };
  assert.equal(stored.custom.keep, true);
  await saveServerConfig({ mode: 'external', executable: fallback }, options);
  assert.deepEqual(await readServerConfig('different-fallback', options), {
    mode: 'external',
    executable: resolve(fallback),
  });
});

test('malformed or conflicting user selection fails without silently using the old binary', async (t) => {
  const options = await temporaryConfig(t);
  await mkdir(join(options.root, 'agent'), { recursive: true });
  for (const value of [
    null,
    [],
    { server: { mode: 'unknown' } },
    { server: { mode: 'managed', installDir: '', executable: '/old' } },
    { server: { mode: 'managed', installDir: '/new', executable: '/old' } },
  ]) {
    const original = JSON.stringify(value);
    await writeFile(options.configFile, original);
    await assert.rejects(readServerConfig('/fallback', options), /Invalid IntelliJ/);
    assert.equal(await readFile(options.configFile, 'utf8'), original);
  }
});

test('invalid persisted document cannot be overwritten by an install selection', async (t) => {
  const options = await temporaryConfig(t);
  await mkdir(join(options.root, 'agent'), { recursive: true });
  await writeFile(options.configFile, 'broken-json');
  await assert.rejects(
    saveServerConfig({ mode: 'managed', installDir: options.root }, options),
    SyntaxError,
  );
  assert.equal(await readFile(options.configFile, 'utf8'), 'broken-json');
});

test('cross-process progress discovery does not change the active external selection', async (t) => {
  const options = await temporaryConfig(t);
  const executable = join(options.root, 'existing-server');
  await saveServerConfig({ mode: 'external', executable }, options);
  assert.equal(await readObservedInstallState(options), null);
  const installDir = join(options.root, 'new install');
  await mkdir(installDir);
  await trackInstallation(installDir, options);
  await writeFile(
    join(installDir, 'install-state.json'),
    JSON.stringify({
      installId: 'config-progress',
      pid: process.pid,
      installDir,
      version: 'test-version',
      phase: 'downloading',
      downloadedBytes: 123,
      totalBytes: 1000,
      updatedAt: Date.now(),
    }),
  );
  const observed = await readObservedInstallState(options);
  assert.equal(observed?.phase, 'downloading');
  assert.equal(observed?.downloadedBytes, 123);
  assert.deepEqual(await readServerConfig('fallback', options), {
    mode: 'external',
    executable: resolve(executable),
  });
});
