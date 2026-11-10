import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { getProcessInfo } from '../dist/server/service.js';

const execFileAsync = promisify(execFile);
const cleanupScript = fileURLToPath(new URL('../scripts/clean-runtime.mjs', import.meta.url));
const staleHash = 'a'.repeat(64);
const protectedHash = 'b'.repeat(64);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'omp clean-runtime-'));
  const children = [];
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, 'scripts'));
  const script = join(root, 'scripts', 'clean-runtime.mjs');
  await copyFile(cleanupScript, script);
  await writeFile(join(root, 'settings.json'), '{}');
  await writeFile(
    join(root, 'metadata-scope.mjs'),
    `import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { basename, isAbsolute, relative, sep } from 'node:path';
const readFile = fs.readFile;
fs.readFile = async (path, ...args) => {
  const outside = relative(${JSON.stringify(root)}, String(path));
  if (basename(String(path)) === 'omp-server.json' &&
      (outside.split(sep)[0] === '..' || isAbsolute(outside))) {
    throw Object.assign(new Error('Ownership metadata outside the fixture'), { code: 'ENOENT' });
  }
  return readFile(path, ...args);
};
syncBuiltinESMExports();
`,
  );

  async function cache(hash) {
    const path = join(root, '.runtime', hash);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'marker'), hash);
    return path;
  }

  async function idle(path, args = []) {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, "console.log('ready'); setInterval(() => {}, 60000);\n");
    const child = spawn(process.execPath, [path, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    children.push(child);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Consumer did not become ready')), 10000);
      const finish = (error) => {
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };
      child.once('error', finish);
      child.once('exit', (code) => finish(new Error(`Consumer exited before ready: ${code}`)));
      child.stdout.once('data', (data) => {
        if (data.toString().trim() === 'ready') finish();
        else finish(new Error('Unexpected consumer readiness output'));
      });
    });
    return child;
  }

  function run(...args) {
    return execFileAsync(process.execPath, ['--import', './metadata-scope.mjs', script, ...args], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
    });
  }

  return { root, cache, idle, run };
}

async function blocked(run) {
  await assert.rejects(run('--apply'), (error) => error.code === 1);
}

test('runtime cleanup ignores unrelated Node processes and preserves the declared current cache', { timeout: 60000 }, async (t) => {
  const f = await fixture(t);
  const stale = await f.cache(staleHash);
  const current = await f.cache(protectedHash);
  await writeFile(join(f.root, '.lsp.json'), JSON.stringify({ args: [join(current, 'dist', 'bridge.js')] }));
  await f.idle(join(f.root, 'unrelated.js'));

  await f.run('--apply');

  await assert.rejects(readFile(join(stale, 'marker')), { code: 'ENOENT' });
  assert.equal(await readFile(join(current, 'marker'), 'utf8'), protectedHash);
});

test('runtime cleanup preserves an old cache used by a live Bridge', { timeout: 60000 }, async (t) => {
  const f = await fixture(t);
  const stale = await f.cache(staleHash);
  await f.idle(join(stale, 'dist', 'bridge.js'));

  await f.run('--dry-run');
  await blocked(f.run);

  assert.equal(await readFile(join(stale, 'marker'), 'utf8'), staleHash);
});

test('runtime cleanup checks JVM plugin ownership after the Bridge has exited', { timeout: 60000 }, async (t) => {
  const f = await fixture(t);
  const stale = await f.cache(staleHash);
  const systemPath = join(f.root, 'server system');
  await mkdir(systemPath);
  const child = await f.idle(join(f.root, 'managed-server.js'), [
    `--system-path=${systemPath}`,
    '--idle-timeout=30m',
  ]);
  const identity = await getProcessInfo(child.pid);
  assert.ok(identity, 'The managed process must have a live OS identity');
  const owner = {
    pid: child.pid,
    systemPath,
    processStartTime: identity.startTime,
    executable: identity.executable,
    pluginPaths: [join(stale, 'resources', 'ils', 'intellij-android')],
  };
  const ownerFile = join(systemPath, 'omp-server.json');
  await writeFile(ownerFile, JSON.stringify(owner));

  await blocked(f.run);
  assert.equal(await readFile(join(stale, 'marker'), 'utf8'), staleHash);

  delete owner.pluginPaths;
  await writeFile(ownerFile, JSON.stringify(owner));
  await blocked(f.run);
  assert.equal(await readFile(join(stale, 'marker'), 'utf8'), staleHash);

  owner.pluginPaths = [join(f.root, 'unrelated-extension')];
  await writeFile(ownerFile, JSON.stringify(owner));
  await f.run('--apply');
  await assert.rejects(readFile(join(stale, 'marker')), { code: 'ENOENT' });
});
