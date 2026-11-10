import assert from 'node:assert/strict';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createDebugControl } from '../src/debug/control.js';
import { createLease, getActiveLeases } from '../src/project/metadata.js';
import { acceptServerEula, readServerEula } from '../src/server/eula.js';
import {
  acquireLifecycleLock,
  connectWithLease,
  endpoint,
  getProcessInfo,
  isProcessAlive,
  restartServer,
  type ServerOwnerRecord,
  status,
  stopServer,
  verifyServerOwnership,
} from '../src/server/service.js';

interface FakeServer {
  child: ChildProcess;
  port: number;
  token: string;
  cleanup: () => Promise<void>;
}

async function startFakeServer(systemPath: string): Promise<FakeServer> {
  await mkdir(systemPath, { recursive: true });
  const portFile = join(systemPath, 'server.port');
  const ownerFile = join(systemPath, 'omp-server.json');

  const script = `
    import net from 'node:net';
    import { writeFile } from 'node:fs/promises';
    const server = net.createServer((socket) => {
      socket.on('data', (d) => socket.write(d));
    });
    server.listen(0, '127.0.0.1', async () => {
      const port = server.address().port;
      await writeFile(${JSON.stringify(portFile)}, String(port), 'utf8');
    });
    setInterval(() => {}, 1000);
  `;

  const scriptFile = join(systemPath, 'fake-server.mjs');
  await writeFile(scriptFile, script, 'utf8');

  const child = spawn(process.execPath, [scriptFile, `--system-path=${resolve(systemPath)}`], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
  });

  const childPid = child.pid;
  if (!childPid) throw new Error('Failed to spawn fake server child');

  const deadline = Date.now() + 8000;
  let port = 0;
  while (Date.now() < deadline) {
    try {
      const text = (await readFile(portFile, 'utf8')).trim();
      port = Number(text);
      if (port > 0) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!port) {
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(childPid)], { windowsHide: true });
      } else {
        child.kill('SIGKILL');
      }
    } catch {}
    throw new Error('Fake server failed to start in time');
  }

  const procInfo = await getProcessInfo(childPid);
  assert.ok(procInfo?.startTime, 'Must capture real OS process start time');

  const token = randomUUID();
  const ownerRecord: ServerOwnerRecord = {
    pid: childPid,
    token,
    systemPath: resolve(systemPath),
    createdAt: Date.now(),
    processStartTime: procInfo.startTime,
    executable: procInfo.executable || process.execPath,
  };
  await writeFile(ownerFile, JSON.stringify(ownerRecord, null, 2), 'utf8');

  return {
    child,
    port,
    token,
    cleanup: async () => {
      try {
        if (child.pid && isProcessAlive(child.pid)) {
          if (process.platform === 'win32') {
            spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(child.pid)], {
              windowsHide: true,
            });
          } else {
            child.kill('SIGKILL');
          }
        }
      } catch {}
    },
  };
}

async function createFakeServerExecutable(dir: string): Promise<string> {
  const binDir = join(dir, 'bin');
  await mkdir(binDir, { recursive: true });
  await writeFile(join(dir, 'EULA.txt'), 'JetBrains Server User Agreement Test Fixture');

  if (process.platform === 'win32') {
    const csFile = join(binDir, 'FakeServer.cs');
    const exeFile = join(binDir, 'fake-server.exe');
    const csCode = [
      'using System;',
      'using System.IO;',
      'using System.Net;',
      'using System.Net.Sockets;',
      'using System.Threading;',
      'class FakeServer {',
      '    static void Main(string[] args) {',
      '        string portFile = "";',
      '        for (int i = 0; i < args.Length; i++) {',
      '            if (args[i].StartsWith("--port-file=")) {',
      '                portFile = args[i].Substring("--port-file=".Length);',
      '            }',
      '        }',
      '        var listener = new TcpListener(IPAddress.Loopback, 0);',
      '        listener.Start();',
      '        int port = ((IPEndPoint)listener.LocalEndpoint).Port;',
      '        if (!string.IsNullOrEmpty(portFile)) {',
      '            File.WriteAllText(portFile, port.ToString());',
      '        }',
      '        Thread.Sleep(Timeout.Infinite);',
      '    }',
      '}',
    ].join('\r\n');
    await writeFile(csFile, csCode, 'utf8');

    const cscPath = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
    const res = spawnSync(cscPath, ['/nologo', `/out:${exeFile}`, csFile], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 10000,
    });
    if (res.status !== 0) {
      throw new Error(`Failed to compile fake server executable: ${res.stderr || res.stdout}`);
    }
    return exeFile;
  }

  const jsFile = join(binDir, 'server.mjs');
  const serverScript = `
    import net from 'node:net';
    import { writeFile } from 'node:fs/promises';

    let portFile = '';
    for (const arg of process.argv) {
      if (arg.startsWith('--port-file=')) {
        portFile = arg.slice('--port-file='.length);
      }
    }

    const server = net.createServer((socket) => {
      socket.on('data', (d) => socket.write(d));
    });
    server.listen(0, '127.0.0.1', async () => {
      if (portFile) {
        await writeFile(portFile, String(server.address().port), 'utf8');
      }
    });
    setInterval(() => {}, 1000);
  `;
  await writeFile(jsFile, serverScript, 'utf8');

  const exePath = join(binDir, 'fake-server');
  await writeFile(exePath, `#!/bin/sh\nexec "${process.execPath}" "${jsFile}" "$@"\n`, {
    encoding: 'utf8',
    mode: 0o755,
  });
  return exePath;
}

test('endpoint and status accept the ILS 271 three-line port file (port, pid, build)', async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'omp-portfile-271-'));
  let fake: FakeServer | null = null;

  t.after(async () => {
    if (fake) await fake.cleanup();
    await rm(tempRoot, { recursive: true, force: true });
  });

  fake = await startFakeServer(tempRoot);
  // ILS 271 publishes "<port>\n<pid>\n<build>" instead of a bare port.
  await writeFile(
    join(tempRoot, 'server.port'),
    `${fake.port}\n${fake.child.pid}\nILS-271.2085.0\n`,
    'utf8',
  );

  assert.equal((await endpoint(tempRoot)).port, fake.port);
  assert.equal(await status(tempRoot), true);
});

test('stopServer: successfully stops running verified fake server and frees endpoint/metadata', async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'omp-lifecycle-stop-'));
  let fake: { child: ChildProcess; port: number; cleanup: () => Promise<void> } | undefined;
  t.after(async () => {
    if (fake) await fake.cleanup();
    await rm(tempRoot, { recursive: true, force: true });
  });

  try {
    fake = await startFakeServer(tempRoot);
    const serverPid = fake.child.pid;
    assert.ok(serverPid);

    assert.equal(await status(tempRoot), true);
    const ep = await endpoint(tempRoot);
    assert.equal(ep.port, fake.port);

    const stopResult = await stopServer({ systemPath: tempRoot });
    assert.equal(stopResult.stopped, true);
    assert.equal(stopResult.pid, serverPid);

    // Verify process is terminated
    assert.equal(isProcessAlive(serverPid), false);

    // Verify endpoint files are cleaned up
    assert.equal(await status(tempRoot), false);
    await assert.rejects(() => endpoint(tempRoot));

    // Calling stopServer again is a safe no-op
    const secondStop = await stopServer({ systemPath: tempRoot });
    assert.equal(secondStop.stopped, false);
    assert.equal(secondStop.pid, null);
  } finally {
    if (fake) await fake.cleanup();
  }
});

test('stopServer: cleans up stale dead PID owner and port file only when PID is dead and port closed', async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'omp-lifecycle-stale-'));
  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  await mkdir(tempRoot, { recursive: true });
  const staleOwner: ServerOwnerRecord = {
    pid: 99999998,
    token: 'stale-token',
    systemPath: resolve(tempRoot),
    createdAt: Date.now() - 100000,
    processStartTime: 12345,
    executable: process.execPath,
  };
  await writeFile(join(tempRoot, 'omp-server.json'), JSON.stringify(staleOwner, null, 2), 'utf8');
  await writeFile(join(tempRoot, 'server.port'), '54321', 'utf8');

  const result = await stopServer({ systemPath: tempRoot });
  assert.equal(result.stopped, false);
  assert.equal(result.pid, null);
  assert.match(result.detail || '', /not running/i);

  // Stale files must have been cleaned up
  const verification = await verifyServerOwnership(tempRoot);
  assert.equal(verification.status, 'not-found');
});

test('stopServer: refuses to stop foreign live owner (command line does not match systemPath)', async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'omp-lifecycle-foreign-'));
  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  await mkdir(tempRoot, { recursive: true });
  const procInfo = await getProcessInfo(process.pid);
  assert.ok(procInfo);

  const foreignOwner: ServerOwnerRecord = {
    pid: process.pid,
    token: randomUUID(),
    systemPath: resolve(tempRoot),
    createdAt: Date.now(),
    processStartTime: procInfo.startTime,
    executable: procInfo.executable,
  };
  await writeFile(join(tempRoot, 'omp-server.json'), JSON.stringify(foreignOwner, null, 2), 'utf8');
  await writeFile(join(tempRoot, 'server.port'), '54321', 'utf8');

  await assert.rejects(
    () => stopServer({ systemPath: tempRoot }),
    /Refusing to stop unverified server process.*command line does not contain exact --system-path/i,
  );

  // The foreign process (test runner) must remain alive
  assert.equal(isProcessAlive(process.pid), true);
});

test('stopServer: refuses to stop legacy PID-only owner record without token/systemPath/startTime', async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'omp-lifecycle-legacy-'));
  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  await mkdir(tempRoot, { recursive: true });
  await writeFile(join(tempRoot, 'omp-server.json'), JSON.stringify({ pid: process.pid }), 'utf8');
  await writeFile(join(tempRoot, 'server.port'), '54321', 'utf8');

  await assert.rejects(
    () => stopServer({ systemPath: tempRoot }),
    /Refusing to stop unverified server process.*legacy PID-only/i,
  );

  // The live process must NOT be killed
  assert.equal(isProcessAlive(process.pid), true);
});

test('verifyServerOwnership accepts owner record with valid empty or populated pluginPaths and distinguishes legacy undefined', async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'omp-lifecycle-pluginpaths-'));
  let fake: FakeServer | null = null;
  t.after(async () => {
    if (fake) await fake.cleanup();
    await rm(tempRoot, { recursive: true, force: true });
  });

  fake = await startFakeServer(tempRoot);
  const ownerFile = join(tempRoot, 'omp-server.json');
  const baseRecord = JSON.parse(await readFile(ownerFile, 'utf8')) as ServerOwnerRecord;

  // 1. Legacy record without pluginPaths
  delete baseRecord.pluginPaths;
  await writeFile(ownerFile, JSON.stringify(baseRecord, null, 2), 'utf8');
  let verification = await verifyServerOwnership(tempRoot);
  assert.equal(verification.status, 'running-owned');
  assert.equal(verification.owner?.pluginPaths, undefined);

  // 2. Modern record with empty pluginPaths []
  baseRecord.pluginPaths = [];
  await writeFile(ownerFile, JSON.stringify(baseRecord, null, 2), 'utf8');
  verification = await verifyServerOwnership(tempRoot);
  assert.equal(verification.status, 'running-owned');
  assert.deepEqual(verification.owner?.pluginPaths, []);

  // 3. Modern record with populated pluginPaths
  baseRecord.pluginPaths = ['/opt/plugins/test-plugin'];
  await writeFile(ownerFile, JSON.stringify(baseRecord, null, 2), 'utf8');
  verification = await verifyServerOwnership(tempRoot);
  assert.equal(verification.status, 'running-owned');
  assert.deepEqual(verification.owner?.pluginPaths, ['/opt/plugins/test-plugin']);
});

test('verifyServerOwnership rejects owner record with malformed pluginPaths', async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'omp-lifecycle-bad-pluginpaths-'));
  let fake: FakeServer | null = null;
  t.after(async () => {
    if (fake) await fake.cleanup();
    await rm(tempRoot, { recursive: true, force: true });
  });

  fake = await startFakeServer(tempRoot);
  const ownerFile = join(tempRoot, 'omp-server.json');
  const baseRecord = JSON.parse(await readFile(ownerFile, 'utf8')) as Record<string, unknown>;

  // Non-array pluginPaths
  baseRecord.pluginPaths = 'not-an-array';
  await writeFile(ownerFile, JSON.stringify(baseRecord, null, 2), 'utf8');
  let verification = await verifyServerOwnership(tempRoot);
  assert.equal(verification.status, 'running-unverified');
  assert.match(verification.reason ?? '', /invalid pluginPaths/i);

  // Array containing non-string
  baseRecord.pluginPaths = [12345];
  await writeFile(ownerFile, JSON.stringify(baseRecord, null, 2), 'utf8');
  verification = await verifyServerOwnership(tempRoot);
  assert.equal(verification.status, 'running-unverified');
  assert.match(verification.reason ?? '', /invalid pluginPaths/i);
});

test('stopServer: blocked by active connection leases; succeeds after release', async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'omp-lifecycle-lease-'));
  let fake: { child: ChildProcess; port: number; cleanup: () => Promise<void> } | undefined;
  t.after(async () => {
    if (fake) await fake.cleanup();
    await rm(tempRoot, { recursive: true, force: true });
  });

  try {
    fake = await startFakeServer(tempRoot);
    const serverPid = fake.child.pid;
    assert.ok(serverPid);

    const projectDir = join(tempRoot, 'test-project');
    const lease = await createLease(tempRoot, {
      kind: 'bridge',
      projectPath: projectDir,
      pid: process.pid,
    });

    const activeBefore = await getActiveLeases(tempRoot);
    assert.equal(activeBefore.length, 1);

    // Attempting to stop while lease is active must be rejected
    await assert.rejects(
      () => stopServer({ systemPath: tempRoot }),
      /Cannot stop IntelliJ server: active consumers detected: active connection lease\(s\): bridge/i,
    );

    // Server process must still be running
    assert.equal(isProcessAlive(serverPid), true);
    assert.equal(await status(tempRoot), true);

    // Release lease
    await lease.release();
    const activeAfter = await getActiveLeases(tempRoot);
    assert.equal(activeAfter.length, 0);

    // Now stopServer must succeed
    const stopResult = await stopServer({ systemPath: tempRoot });
    assert.equal(stopResult.stopped, true);
    assert.equal(stopResult.pid, serverPid);
    assert.equal(isProcessAlive(serverPid), false);
  } finally {
    if (fake) await fake.cleanup();
  }
});

test('stopServer: blocked by active debug sessions; succeeds after close', async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'omp-lifecycle-debug-'));
  let fake: { child: ChildProcess; port: number; cleanup: () => Promise<void> } | undefined;
  t.after(async () => {
    if (fake) await fake.cleanup();
    await rm(tempRoot, { recursive: true, force: true });
  });

  try {
    fake = await startFakeServer(tempRoot);
    const serverPid = fake.child.pid;
    assert.ok(serverPid);

    const projectDir = join(tempRoot, 'debug-project');
    const control = await createDebugControl({
      systemPath: tempRoot,
      projectRoot: projectDir,
      getStatus: () => ({
        phase: 'connecting-lsp',
        mode: 'launch',
        projectRoot: projectDir,
        backendPort: 12345,
        pendingRequests: 0,
        startTime: Date.now(),
        uptimeMs: 10,
        memoryUsageBytes: 100,
      }),
      recover: async () => {},
    });

    // Attempting to stop while debug session is active must be rejected
    await assert.rejects(
      () => stopServer({ systemPath: tempRoot }),
      /Cannot stop IntelliJ server: active consumers detected: active debug session\(s\)/i,
    );

    // Server process must still be running
    assert.equal(isProcessAlive(serverPid), true);

    // Close debug session
    await control.close();

    // Now stopServer must succeed
    const stopResult = await stopServer({ systemPath: tempRoot });
    assert.equal(stopResult.stopped, true);
    assert.equal(stopResult.pid, serverPid);
    assert.equal(isProcessAlive(serverPid), false);
  } finally {
    if (fake) await fake.cleanup();
  }
});

test('stopServer: preserves external attach JVM while terminating server process', async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'omp-lifecycle-attach-'));
  let fake: { child: ChildProcess; cleanup: () => Promise<void> } | undefined;
  let externalDummy: ChildProcess | undefined;
  t.after(async () => {
    if (externalDummy?.pid && isProcessAlive(externalDummy.pid)) {
      if (process.platform === 'win32') {
        spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(externalDummy.pid)], {
          windowsHide: true,
        });
      } else {
        externalDummy.kill('SIGKILL');
      }
    }
    if (fake) await fake.cleanup();
    await rm(tempRoot, { recursive: true, force: true });
  });

  try {
    fake = await startFakeServer(tempRoot);
    const serverPid = fake.child.pid;
    assert.ok(serverPid);

    // Spawn an unrelated dummy external process (mimicking an external attach JVM)
    externalDummy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    });
    const externalPid = externalDummy.pid;
    assert.ok(externalPid && isProcessAlive(externalPid));

    const stopResult = await stopServer({ systemPath: tempRoot });
    assert.equal(stopResult.stopped, true);
    assert.equal(stopResult.pid, serverPid);

    // Verified server process is dead
    assert.equal(isProcessAlive(serverPid), false);

    // External process MUST still be alive!
    assert.equal(isProcessAlive(externalPid), true);
  } finally {
    if (fake) await fake.cleanup();
  }
});

test('restartServer: preserves EULA gate and preserves old running server on rejection', async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'omp-lifecycle-eula-'));
  let fake: { child: ChildProcess; port: number; cleanup: () => Promise<void> } | undefined;
  t.after(async () => {
    if (fake) await fake.cleanup();
    await rm(tempRoot, { recursive: true, force: true });
  });

  try {
    fake = await startFakeServer(tempRoot);
    const oldPid = fake.child.pid;
    assert.ok(oldPid);
    const oldPort = fake.port;

    const exe = await createFakeServerExecutable(tempRoot);

    // Attempting to restart without accepted EULA must reject with EULA error
    await assert.rejects(
      () => restartServer({ systemPath: tempRoot, executable: exe }),
      /EULA_NOT_ACCEPTED|has not been accepted/i,
    );

    // CRITICAL: The old server MUST still be running untouched!
    assert.equal(
      isProcessAlive(oldPid),
      true,
      'Old server PID must remain alive after EULA rejection',
    );
    assert.equal(await status(tempRoot), true, 'Old server must remain healthy');
    const ep = await endpoint(tempRoot);
    assert.equal(ep.port, oldPort, 'Old server port must be preserved');

    // Must NOT leave lifecycle lock locked (no deadlock)
    const handle = await acquireLifecycleLock({ systemPath: tempRoot, timeoutMs: 1000 });
    assert.ok(handle.token);
    await handle.release();
  } finally {
    if (fake) await fake.cleanup();
  }
});

test('restartServer: stops old server and launches new server under lifecycle lock, preserving data', async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'omp-lifecycle-restart-'));
  const configDir = join(tempRoot, 'agent');
  await mkdir(configDir, { recursive: true });
  const configFile = join(configDir, 'intellij.json');
  process.env.OMP_INTELLIJ_CONFIG = configFile;

  let oldFake: { child: ChildProcess; port: number; cleanup: () => Promise<void> } | undefined;
  let newPidToClean = 0;
  t.after(async () => {
    delete process.env.OMP_INTELLIJ_CONFIG;
    if (newPidToClean && isProcessAlive(newPidToClean)) {
      if (process.platform === 'win32') {
        spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(newPidToClean)], {
          windowsHide: true,
        });
      } else {
        process.kill(newPidToClean, 'SIGKILL');
      }
    }
    if (oldFake) await oldFake.cleanup();
    await rm(tempRoot, { recursive: true, force: true });
  });

  try {
    oldFake = await startFakeServer(tempRoot);
    const oldPid = oldFake.child.pid;
    assert.ok(oldPid);

    // Create some data directory to verify it is preserved across restart
    const dataDir = join(tempRoot, 'workspaces', 'test-workspace-data');
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, 'index.bin'), 'important index cache data', 'utf8');

    const exe = await createFakeServerExecutable(tempRoot);
    const doc = await readServerEula(exe);
    await acceptServerEula(doc, { configFile });

    // Restart server
    const restartResult = await restartServer({
      systemPath: tempRoot,
      executable: exe,
      timeoutMs: 8000,
    });

    assert.equal(restartResult.restarted, true);
    assert.equal(restartResult.previousPid, oldPid);
    assert.ok(restartResult.pid > 0);
    assert.notEqual(restartResult.pid, oldPid);
    newPidToClean = restartResult.pid;

    // Old server must be terminated
    assert.equal(isProcessAlive(oldPid), false);

    // New server must be alive and listening
    assert.equal(isProcessAlive(restartResult.pid), true);
    assert.equal(await status(tempRoot), true);

    // Cached data must be preserved
    const cachedData = await readFile(join(dataDir, 'index.bin'), 'utf8');
    assert.equal(cachedData, 'important index cache data');

    // Verify omp-server.json records pluginPaths as [] when none configured
    const ownerFile = join(tempRoot, 'omp-server.json');
    const ownerRecord = JSON.parse(await readFile(ownerFile, 'utf8')) as ServerOwnerRecord;
    assert.deepEqual(ownerRecord.pluginPaths, []);

    // Clean up new server
    await stopServer({ systemPath: tempRoot });
    assert.equal(isProcessAlive(newPidToClean), false);
  } finally {
    if (oldFake) await oldFake.cleanup();
  }
});

test('restartServer: records effective -Dplugin.path in omp-server.json and avoids secret leakage', async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'omp-lifecycle-restart-pluginpaths-'));
  const configDir = join(tempRoot, 'agent');
  await mkdir(configDir, { recursive: true });
  const configFile = join(configDir, 'intellij.json');
  const originalConfig = process.env.OMP_INTELLIJ_CONFIG;
  const originalIjOptions = process.env.IJ_JAVA_OPTIONS;
  process.env.OMP_INTELLIJ_CONFIG = configFile;
  process.env.IJ_JAVA_OPTIONS =
    '-Xmx2g -Dplugin.path="C:/custom/plugin1,C:/custom/plugin2" -Dsecret.token=super-secret-1234 -ea';

  let oldFake: { child: ChildProcess; port: number; cleanup: () => Promise<void> } | undefined;
  let newPidToClean = 0;
  t.after(async () => {
    if (originalConfig === undefined) delete process.env.OMP_INTELLIJ_CONFIG;
    else process.env.OMP_INTELLIJ_CONFIG = originalConfig;
    if (originalIjOptions === undefined) delete process.env.IJ_JAVA_OPTIONS;
    else process.env.IJ_JAVA_OPTIONS = originalIjOptions;

    if (newPidToClean && isProcessAlive(newPidToClean)) {
      if (process.platform === 'win32') {
        spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(newPidToClean)], {
          windowsHide: true,
        });
      } else {
        process.kill(newPidToClean, 'SIGKILL');
      }
    }
    if (oldFake) await oldFake.cleanup();
    await rm(tempRoot, { recursive: true, force: true });
  });

  try {
    oldFake = await startFakeServer(tempRoot);
    const oldPid = oldFake.child.pid;
    assert.ok(oldPid);

    const exe = await createFakeServerExecutable(tempRoot);
    const doc = await readServerEula(exe);
    await acceptServerEula(doc, { configFile });

    const restartResult = await restartServer({
      systemPath: tempRoot,
      executable: exe,
      timeoutMs: 8000,
    });

    assert.equal(restartResult.restarted, true);
    newPidToClean = restartResult.pid;

    const rawOwner = await readFile(join(tempRoot, 'omp-server.json'), 'utf8');
    const owner = JSON.parse(rawOwner) as ServerOwnerRecord;

    // Never persist entire IJ_JAVA_OPTIONS or secrets
    assert.equal(rawOwner.includes('super-secret-1234'), false);
    assert.equal(rawOwner.includes('secret.token'), false);
    assert.equal(rawOwner.includes('-Xmx2g'), false);

    // Records effective plugin paths as resolved array
    assert.ok(Array.isArray(owner.pluginPaths));
    assert.equal(owner.pluginPaths.length, 2);
    assert.equal(owner.pluginPaths[0].endsWith('custom/plugin1'), true);
    assert.equal(owner.pluginPaths[1].endsWith('custom/plugin2'), true);

    const verification = await verifyServerOwnership(tempRoot);
    assert.equal(verification.status, 'running-owned');
    assert.deepEqual(verification.owner?.pluginPaths, owner.pluginPaths);

    await stopServer({ systemPath: tempRoot });
    assert.equal(isProcessAlive(newPidToClean), false);
  } finally {
    if (oldFake) await oldFake.cleanup();
  }
});

test('concurrency: concurrent stopServer calls safely serialize under lifecycle lock', async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'omp-lifecycle-concurrent-'));
  let fake: { child: ChildProcess; port: number; cleanup: () => Promise<void> } | undefined;
  t.after(async () => {
    if (fake) await fake.cleanup();
    await rm(tempRoot, { recursive: true, force: true });
  });

  try {
    fake = await startFakeServer(tempRoot);
    const serverPid = fake.child.pid;
    assert.ok(serverPid);

    // Trigger two concurrent stop operations
    const [result1, result2] = await Promise.all([
      stopServer({ systemPath: tempRoot }),
      stopServer({ systemPath: tempRoot }),
    ]);

    const stoppedCount = [result1, result2].filter((r) => r.stopped).length;
    const noopCount = [result1, result2].filter((r) => !r.stopped).length;

    assert.equal(stoppedCount, 1, 'Exactly one stop call should successfully stop the server');
    assert.equal(noopCount, 1, 'The other stop call should observe the server already stopped');

    assert.equal(isProcessAlive(serverPid), false);
    assert.equal(await status(tempRoot), false);
  } finally {
    if (fake) await fake.cleanup();
  }
});

test('connection acquisition and stop cannot both succeed for the same server instance', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'omp-lifecycle-acquire-race-'));
  const fake = await startFakeServer(root);
  t.after(async () => {
    await fake.cleanup();
    await rm(root, { recursive: true, force: true });
  });
  const pid = fake.child.pid;
  assert.ok(pid);
  const lock = await acquireLifecycleLock({ systemPath: root });
  const connecting = connectWithLease({
    systemPath: root,
    projectPath: root,
    executable: join(root, 'unavailable-launcher'),
  });
  const stopping = stopServer({ systemPath: root });
  await lock.release();
  const [connection, stop] = await Promise.allSettled([connecting, stopping]);
  if (connection.status === 'fulfilled') {
    const { socket, lease } = connection.value;
    try {
      assert.equal(stop.status, 'rejected');
      const echoed = new Promise<string>((resolveEcho, reject) => {
        socket.once('data', (data) => resolveEcho(data.toString()));
        socket.once('error', reject);
      });
      socket.write('consumer-still-connected');
      assert.equal(await echoed, 'consumer-still-connected');
      assert.equal(isProcessAlive(pid), true);
    } finally {
      socket.destroy();
      await lease.release();
    }
    await stopServer({ systemPath: root });
  } else {
    assert.equal(stop.status, 'fulfilled');
    if (stop.status === 'fulfilled') assert.equal(stop.value.stopped, true);
    assert.equal(isProcessAlive(pid), false);
  }
});

test('getActiveLeases: fail-closed on corrupt or malformed lease file', async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'omp-lifecycle-corrupt-lease-'));
  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  const leasesDir = join(tempRoot, 'plugin-metadata', 'leases');
  await mkdir(leasesDir, { recursive: true });

  // Write a corrupt lease file
  await writeFile(join(leasesDir, 'bad-lease.json'), '{ not-valid-json }', 'utf8');

  await assert.rejects(() => getActiveLeases(tempRoot), /Corrupt lease file \(malformed JSON\)/i);
});
