import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

for (const invalid of [
  { host: '0.0.0.0' },
  { startupTimeoutMs: -1 },
  { initializeTimeoutMs: 'invalid' },
  { cachePolicy: { retentionDays: 30, warnAboveGiB: 5, automaticDeletion: true } },
]) {
  test(`explicit service settings reject ${Object.keys(invalid)[0]} without fallback`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'omp-intellij-settings-'));
    try {
      const config = join(root, 'settings.json');
      await writeFile(
        config,
        JSON.stringify({
          executable: 'not-started',
          host: '127.0.0.1',
          systemPath: root,
          startupTimeoutMs: 1000,
          initializeTimeoutMs: 1000,
          requestWaitTimeoutMs: 1000,
          idleTimeout: '30m',
          cachePolicy: { retentionDays: 30, warnAboveGiB: 5, automaticDeletion: false },
          ...invalid,
        }),
      );
      const child = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `await import(${JSON.stringify(new URL('../src/service.js', import.meta.url).href)})`,
        ],
        {
          env: { ...process.env, OMP_INTELLIJ_SETTINGS: config },
          encoding: 'utf8',
          windowsHide: true,
        },
      );
      assert.equal(child.status, 1);
      assert.match(child.stderr, /Invalid IntelliJ|must be positive/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
