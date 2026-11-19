import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  createIntegrationSandbox,
  createRunDependencyCache,
  findGradleArtifact,
  type IntegrationPrerequisites,
  readServerEula,
} from './integration/fixture.js';

const environmentKeys = [
  'OMP_INTELLIJ_CONFIG',
  'OMP_INTELLIJ_SETTINGS',
  'GRADLE_USER_HOME',
  'GRADLE_RO_DEP_CACHE',
  'JAVA_HOME',
  'IJ_JAVA_OPTIONS',
] as const;

async function prerequisites(t: TestContext): Promise<IntegrationPrerequisites> {
  const root = await mkdtemp(join(tmpdir(), 'omp-fixture-prerequisites-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'bin'));
  const serverExecutable = join(root, 'bin', 'fixture-server');
  await writeFile(serverExecutable, 'fixture');
  await writeFile(join(root, 'EULA.txt'), 'Integration fixture test document\n');
  const eulaDoc = await readServerEula(serverExecutable);
  return {
    serverExecutable,
    jdk17Path: join(root, 'jdk17'),
    jdk21Path: join(root, 'jdk21'),
    acceptedEulaHash: eulaDoc.hash,
    eulaDoc,
  };
}

for (const failure of [false, true]) {
  test(`sandbox cleanup releases resources and restores environment after failure=${failure}`, async (t) => {
    const previous = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
    const sandbox = await createIntegrationSandbox(await prerequisites(t));
    const child = spawn(
      process.execPath,
      ['-e', 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0));'],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    const exited = once(child, 'exit');
    sandbox.trackProcess(child);
    const accepted = Promise.withResolvers<net.Socket>();
    const server = net.createServer((socket) => {
      sandbox.trackSocket(socket);
      accepted.resolve(socket);
    });
    sandbox.trackServer(server);
    const client = new net.Socket();
    sandbox.trackSocket(client);
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
      client.destroy();
      if (server.listening) server.close();
      for (const key of environmentKeys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
      await rm(sandbox.sandboxDir, { recursive: true, force: true });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    client.connect(address.port, '127.0.0.1');
    await once(client, 'connect');
    const peer = await accepted.promise;
    const diagnostic = join(sandbox.logDir, 'launcher.log');
    await writeFile(diagnostic, 'fixture diagnostic evidence');
    if (failure) {
      assert.ok(child.stdin);
      t.mock.method(child.stdin, 'end', () => {
        throw new Error('fixture stdin failure');
      });
      await writeFile(join(sandbox.systemPath, 'omp-server.json'), '{');
      await assert.rejects(sandbox.cleanup(), (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.match(error.message, /artifacts retained/);
        assert.ok(
          error.errors.some(
            (entry) => entry instanceof Error && /fixture stdin failure/.test(entry.message),
          ),
        );
        assert.ok(
          error.errors.some((entry) => entry instanceof Error && /ils-stop/.test(entry.message)),
        );
        return true;
      });
      assert.equal(await readFile(diagnostic, 'utf8'), 'fixture diagnostic evidence');
    } else {
      await sandbox.cleanup();
      await assert.rejects(stat(sandbox.sandboxDir), { code: 'ENOENT' });
    }
    await exited;
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    assert.equal(client.destroyed, true);
    assert.equal(peer.destroyed, true);
    assert.equal(server.listening, false);
    assert.deepEqual(
      Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]])),
      previous,
    );
  });
}

test('dependency seeds isolate local Gradle writes and survive consumer cleanup', async (t) => {
  const source = await mkdtemp(join(tmpdir(), 'omp-dependency-source-'));
  t.after(() => rm(source, { recursive: true, force: true }));
  const relativeArtifact = join(
    'files-2.1',
    'example',
    'library',
    '1.0',
    'hash',
    'library-1.0.jar',
  );
  const modules = join(source, 'caches', 'modules-2');
  await mkdir(join(modules, dirname(relativeArtifact)), { recursive: true });
  await writeFile(join(modules, relativeArtifact), 'seeded artifact');
  await writeFile(join(modules, 'modules-2.lock'), 'volatile lock');
  await writeFile(join(modules, 'gc.properties'), 'volatile GC state');
  const seed = await createRunDependencyCache(source);
  assert.ok(seed);
  t.after(() => seed.dispose());
  const seededArtifact = join(seed.dir, 'modules-2', relativeArtifact);
  assert.equal((await stat(seededArtifact)).mode & 0o222, 0);
  await assert.rejects(stat(join(seed.dir, 'modules-2', 'modules-2.lock')), { code: 'ENOENT' });
  await assert.rejects(stat(join(seed.dir, 'modules-2', 'gc.properties')), { code: 'ENOENT' });
  await writeFile(join(modules, relativeArtifact), 'later source mutation');

  const first = await createIntegrationSandbox(await prerequisites(t));
  t.after(() => first.cleanup());
  first.env.GRADLE_RO_DEP_CACHE = seed.dir;
  assert.equal(await findGradleArtifact(first, 'example', 'library', '1.0'), seededArtifact);
  const localArtifact = join(first.gradleUserHome, 'caches', 'modules-2', relativeArtifact);
  await mkdir(dirname(localArtifact), { recursive: true });
  await writeFile(localArtifact, 'consumer-local artifact');
  assert.equal(await findGradleArtifact(first, 'example', 'library', '1.0'), localArtifact);
  await first.cleanup();

  const second = await createIntegrationSandbox(await prerequisites(t));
  t.after(() => second.cleanup());
  second.env.GRADLE_RO_DEP_CACHE = seed.dir;
  const reused = await findGradleArtifact(second, 'example', 'library', '1.0');
  assert.equal(await readFile(reused, 'utf8'), 'seeded artifact');
  await assert.rejects(findGradleArtifact(second, 'example', 'missing', '1.0'), /not found/);
  assert.equal(await readFile(join(modules, relativeArtifact), 'utf8'), 'later source mutation');
  await second.cleanup();
  await seed.dispose();
  await assert.rejects(stat(seed.dir), { code: 'ENOENT' });
});

test('dependency seed creation rejects an invalid source without changing it', async (t) => {
  const source = await mkdtemp(join(tmpdir(), 'omp-dependency-invalid-'));
  t.after(() => rm(source, { recursive: true, force: true }));
  await mkdir(join(source, 'caches'));
  const invalid = join(source, 'caches', 'modules-2');
  await writeFile(invalid, 'invalid cache input');
  await assert.rejects(createRunDependencyCache(source), { code: 'ENOTDIR' });
  assert.equal(await readFile(invalid, 'utf8'), 'invalid cache input');
});
