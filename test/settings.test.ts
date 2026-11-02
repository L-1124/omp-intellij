import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { acceptServerEula, readServerEula } from '../src/eula.js';

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

test('ensureServer rejects spawn when EULA is not accepted for executable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omp-intellij-eula-spawn-'));
  try {
    const serverDir = join(root, 'server');
    const binDir = join(serverDir, 'bin');
    await mkdir(binDir, { recursive: true });
    await writeFile(join(serverDir, 'EULA.txt'), 'JetBrains Server EULA Agreement Content');
    const exe = join(binDir, process.platform === 'win32' ? 'fake-server.exe' : 'fake-server');
    await writeFile(exe, '#!/bin/sh\nexit 0\n');

    const agentDir = join(root, 'agent');
    await mkdir(agentDir, { recursive: true });
    const configFile = join(agentDir, 'intellij.json');

    const config = join(root, 'settings.json');
    await writeFile(
      config,
      JSON.stringify({
        executable: exe,
        host: '127.0.0.1',
        systemPath: join(root, 'system'),
        startupTimeoutMs: 1000,
        initializeTimeoutMs: 1000,
        requestWaitTimeoutMs: 1000,
        idleTimeout: '30m',
        cachePolicy: { retentionDays: 30, warnAboveGiB: 5, automaticDeletion: false },
      }),
    );

    // Run ensureServer in child process without accepted EULA
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { ensureServer } from ${JSON.stringify(new URL('../src/service.js', import.meta.url).href)};
         try {
           await ensureServer();
           process.exit(0);
         } catch (err) {
           console.error(err.code || err.message);
           process.exit(2);
         }`,
      ],
      {
        env: {
          ...process.env,
          OMP_INTELLIJ_SETTINGS: config,
          OMP_INTELLIJ_CONFIG: configFile,
        },
        encoding: 'utf8',
        windowsHide: true,
      },
    );

    assert.equal(child.status, 2);
    assert.match(child.stderr, /EULA_NOT_ACCEPTED/);

    // Accept EULA
    const doc = await readServerEula(exe);
    await acceptServerEula(doc, { configFile });

    // Now EULA check is accepted
    const docCheck = await readServerEula(exe);
    assert.equal(docCheck.hash, doc.hash);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
