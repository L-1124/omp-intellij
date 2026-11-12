import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  createIntegrationSandbox,
  type IntegrationPrerequisites,
  readServerEula,
} from './integration/fixture.js';

const environmentKeys = [
  'OMP_INTELLIJ_CONFIG',
  'OMP_INTELLIJ_SETTINGS',
  'OMP_ANDROID_LS_EXTENSION_DIR',
  'GRADLE_USER_HOME',
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
