import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import test from 'node:test';
import {
  copyWorkspaceFixture,
  createIntegrationSandbox,
  isProcessAlive,
  verifyPrerequisites,
} from './fixture.js';
import { createOmpHostDriver, type OmpHostDriver } from './omp-host-client.js';

const prerequisites = await verifyPrerequisites();

async function getFreePort(): Promise<number> {
  const server = net.createServer();
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const port = (server.address() as net.AddressInfo).port;
    server.close((error) => (error ? reject(error) : resolve(port)));
  });
  return promise;
}

test('OMP host JVM lifecycle: initial capabilities select disconnect and external attach preserves its target [smoke]', async () => {
  const sandbox = await createIntegrationSandbox(prerequisites);
  let host: OmpHostDriver | undefined;
  let target: ChildProcess | undefined;
  try {
    const project = await copyWorkspaceFixture('jdk21', sandbox);
    const source = join(project, 'src/main/java/com/example/App.java');
    host = createOmpHostDriver(
      {
        mode: 'launch',
        cwd: project,
        program: source,
        launchDefaults: { stopOnEntry: true },
      },
      sandbox,
    );
    const launched = await host.ready;
    assert.equal(
      (launched.capabilities as Record<string, unknown>).supportsTerminateRequest,
      false,
    );
    await host.close();
    assert.deepEqual((await host.closed).sessions, []);
    const classpath = join(project, 'build/classes/java/main');
    assert.ok(existsSync(join(classpath, 'com/example/App.class')));
    const port = await getFreePort();
    target = spawn(
      join(prerequisites.jdk21Path, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'),
      [
        `-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:${port}`,
        '-cp',
        classpath,
        'com.example.App',
      ],
      { cwd: project, env: sandbox.env, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true },
    );
    sandbox.trackProcess(target);
    const ready = Promise.withResolvers<void>();
    let targetOutput = '';
    assert.ok(target.stdout);
    target.stdout.on('data', (chunk: Buffer) => {
      targetOutput = (targetOutput + chunk.toString()).slice(-4096);
      if (targetOutput.includes('HEARTBEAT_21=')) ready.resolve();
    });
    target.once('error', ready.reject);
    target.once('exit', (code) =>
      ready.reject(new Error(`Fixture JVM exited before heartbeat: ${code}`)),
    );
    // The external JVM heartbeat is outside the test clock.
    const timer = setTimeout(
      () => ready.reject(new Error('Fixture JVM did not report heartbeat')),
      10000,
    );
    try {
      await ready.promise;
    } finally {
      clearTimeout(timer);
    }
    host = createOmpHostDriver({ mode: 'attach', cwd: project, host: '127.0.0.1', port }, sandbox);
    await host.ready;
    await host.close();
    assert.ok(
      target.pid && isProcessAlive(target.pid),
      'Real OMP host disconnect must preserve external JVM',
    );
  } finally {
    try {
      await host?.close();
    } finally {
      try {
        if (target && target.exitCode === null && target.signalCode === null) {
          const exited = once(target, 'exit');
          target.kill();
          await exited;
        }
      } finally {
        await sandbox.cleanup();
      }
    }
  }
});
