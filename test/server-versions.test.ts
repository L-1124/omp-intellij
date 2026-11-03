import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createDebugControl } from '../src/debug/control.js';
import { createLease } from '../src/project/metadata.js';
import { readServerConfig, saveServerConfig } from '../src/server/config.js';
import { findInstalled, listInstalledVersions } from '../src/server/install.js';
import { selectServerVersion } from '../src/server/versions.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'omp-version-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installDir = join(root, 'installation');
  const systemPath = join(root, 'system');
  const configFile = join(root, 'agent', 'intellij.json');
  await mkdir(systemPath, { recursive: true });
  return { root, installDir, systemPath, configFile };
}

async function installFixture(installDir: string, version: string) {
  const directory = join(installDir, 'versions', version);
  const launcher = process.platform === 'win32' ? 'bin/intellij-server.exe' : 'bin/intellij-server';
  const executable = join(directory, launcher);
  await mkdir(join(directory, 'bin'), { recursive: true });
  await writeFile(executable, 'Local version-selection fixture, not an executable');
  await writeFile(join(directory, 'EULA.txt'), `Local fixture terms for ${version}`);
  const receipt = {
    version,
    sha256: 'a'.repeat(64),
    platform: process.platform,
    arch: process.arch,
    launcher,
    installedAt: 1,
  };
  await writeFile(join(directory, 'receipt.json'), JSON.stringify(receipt));
  return { directory, executable, receipt };
}

test('version listing excludes invalid receipts and unsafe launcher paths without modifying installations', async (t) => {
  const options = await fixture(t);
  const first = await installFixture(options.installDir, '263.9.0');
  await installFixture(options.installDir, '263.10.0');
  const invalid = await installFixture(options.installDir, '263.11.0');
  await writeFile(
    join(invalid.directory, 'receipt.json'),
    JSON.stringify({ ...invalid.receipt, arch: 'foreign' }),
  );
  const traversal = await installFixture(options.installDir, '263.12.0');
  await writeFile(
    join(traversal.directory, 'receipt.json'),
    JSON.stringify({ ...traversal.receipt, launcher: '../outside' }),
  );
  const broken = await installFixture(options.installDir, '263.13.0');
  await writeFile(join(broken.directory, 'receipt.json'), 'broken JSON');
  const result = await listInstalledVersions(options.installDir);
  assert.deepEqual(
    result.map((entry) => entry.version),
    ['263.10.0', '263.9.0'],
  );
  assert.equal(
    await readFile(first.executable, 'utf8'),
    'Local version-selection fixture, not an executable',
  );
  assert.equal(await readFile(join(broken.directory, 'receipt.json'), 'utf8'), 'broken JSON');
  assert.deepEqual(await listInstalledVersions(join(options.root, 'missing')), []);
});

test('installed version lookup rejects linked version directories and launchers escaping their version', async (t) => {
  const options = await fixture(t);
  const outside = await installFixture(join(options.root, 'outside'), '263.20.0');
  const linkedVersion = join(options.installDir, 'versions', '263.20.0');
  await mkdir(join(options.installDir, 'versions'), { recursive: true });
  await symlink(
    outside.directory,
    linkedVersion,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  assert.equal(await findInstalled(options.installDir, { version: '263.20.0' }), null);
  const local = await installFixture(options.installDir, '263.21.0');
  await rm(local.executable);
  await symlink(outside.executable, local.executable, 'file');
  assert.equal(await findInstalled(options.installDir, { version: '263.21.0' }), null);
});

test('selecting and rolling back versions preserves unrelated config, other installations, and EULA gate', async (t) => {
  const options = await fixture(t);
  const first = await installFixture(options.installDir, '263.1000.0');
  await installFixture(options.installDir, '263.2000.0');
  await mkdir(join(options.root, 'agent'));
  await writeFile(options.configFile, JSON.stringify({ unrelated: { preserve: true } }));
  for (const version of ['263.1000.0', '263.2000.0', '263.1000.0']) {
    await selectServerVersion(version, options);
    assert.deepEqual(await readServerConfig('', options), {
      mode: 'managed',
      installDir: resolve(options.installDir),
      version,
    });
  }
  const stored = JSON.parse(await readFile(options.configFile, 'utf8'));
  assert.deepEqual(stored.unrelated, { preserve: true });
  assert.deepEqual(
    (await listInstalledVersions(options.installDir)).map((entry) => entry.version),
    ['263.2000.0', '263.1000.0'],
  );
  await assert.rejects(readFile(join(options.root, 'agent', 'intellij-eula.json')), {
    code: 'ENOENT',
  });
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { ensureServer } from ${JSON.stringify(new URL('../src/server/service.js', import.meta.url).href)};
    try { await ensureServer({ systemPath: ${JSON.stringify(options.systemPath)} }); process.exitCode = 1; }
    catch (error) { console.log(JSON.stringify({ code: error.code, executable: error.document?.executable })); }
  `,
    ],
    {
      env: { ...process.env, OMP_INTELLIJ_CONFIG: options.configFile },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
    },
  );
  assert.equal(child.status, 0, child.stderr);
  const error = JSON.parse(child.stdout);
  assert.equal(error.code, 'EULA_NOT_ACCEPTED');
  assert.equal(resolve(error.executable).toLowerCase(), resolve(first.executable).toLowerCase());
});

test('invalid or missing versions leave the selected version unchanged', async (t) => {
  const options = await fixture(t);
  await installFixture(options.installDir, '263.1000.0');
  await selectServerVersion('263.1000.0', options);
  const before = await readFile(options.configFile, 'utf8');
  for (const version of ['latest', '../263.2000.0', '263.2000.0', '263.1.0?query']) {
    await assert.rejects(selectServerVersion(version, options));
    assert.equal(await readFile(options.configFile, 'utf8'), before);
  }
  await assert.rejects(
    saveServerConfig(
      { mode: 'managed', installDir: options.installDir, version: 'latest' },
      options,
    ),
  );
  assert.equal(await readFile(options.configFile, 'utf8'), before);
});

test('selection refuses live consumers and a listening server without changing config or disconnecting them', async (t) => {
  const options = await fixture(t);
  await installFixture(options.installDir, '263.1000.0');
  await installFixture(options.installDir, '263.2000.0');
  await selectServerVersion('263.1000.0', options);
  const before = await readFile(options.configFile, 'utf8');
  const lease = await createLease(options.systemPath, { projectPath: options.root });
  t.after(() => lease.release());
  await assert.rejects(selectServerVersion('263.2000.0', options), /consumers/);
  assert.equal(await readFile(options.configFile, 'utf8'), before);
  await lease.release();
  const control = await createDebugControl({
    systemPath: options.systemPath,
    projectRoot: options.root,
    getStatus: () => ({
      phase: 'running',
      mode: 'attach',
      projectRoot: options.root,
      pendingRequests: 0,
    }),
    recover: async () => {},
  });
  t.after(() => control.close());
  await assert.rejects(selectServerVersion('263.2000.0', options), /consumers/);
  assert.equal(await readFile(options.configFile, 'utf8'), before);
  await control.close();
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await writeFile(join(options.systemPath, 'server.port'), String(address.port));
  await assert.rejects(selectServerVersion('263.2000.0', options), /running|unverified/);
  assert.equal(await readFile(options.configFile, 'utf8'), before);
  assert.equal(server.listening, true);
});
