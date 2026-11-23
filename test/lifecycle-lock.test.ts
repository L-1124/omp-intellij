import assert from 'node:assert/strict';
import fs, { mkdtemp, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { acquireLifecycleLock } from '../src/server/lifecycle-lock.js';

test('lock acquisition can retry after owner metadata fails to write', async (t) => {
  const systemPath = await mkdtemp(join(tmpdir(), 'omp-lock-owner-'));
  t.after(() => rm(systemPath, { recursive: true, force: true }));
  const originalWriteFile = fs.writeFile;
  const diskFull = Object.assign(new Error('No space left on device'), { code: 'ENOSPC' });
  fs.writeFile = async (path, data, options) => {
    if (path === join(systemPath, 'omp-start.lock', 'owner.json')) {
      await originalWriteFile(path, '{');
      throw diskFull;
    }
    await originalWriteFile(path, data, options);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(acquireLifecycleLock({ systemPath }), (error) => error === diskFull);
  } finally {
    fs.writeFile = originalWriteFile;
    syncBuiltinESMExports();
  }
  const handle = await acquireLifecycleLock({ systemPath, timeoutMs: 500 });
  assert.equal(await handle.release(), true);
});
