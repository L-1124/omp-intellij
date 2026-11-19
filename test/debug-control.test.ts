import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createDebugControl,
  type DebugControlHandle,
  type DebugSnapshot,
  getDebugSessionsDir,
  listDebugSessions,
  recoverDebugSession,
} from '../src/debug/control.js';
import extension from '../src/extension/extension.js';
import { canonicalizeProject, pathsEqual } from '../src/project/metadata.js';
import { createMockCtx, createMockPi } from './helpers.js';

function createTempDir(prefix: string): string {
  return join(tmpdir(), `${prefix}-${Math.random().toString(36).slice(2)}`);
}

test('debug control HTTP server enforces loopback, bearer token, route and payload restrictions', async () => {
  const systemPath = createTempDir('omp-dbg-sec-sys');
  const projectRoot = createTempDir('omp-dbg-sec-prj');
  await mkdir(systemPath, { recursive: true });
  await mkdir(projectRoot, { recursive: true });

  const snapshot: DebugSnapshot = {
    phase: 'running',
    mode: 'launch',
    projectRoot,
    pendingRequests: 0,
  };

  const handle = await createDebugControl({
    systemPath,
    projectRoot,
    getStatus: () => snapshot,
    recover: async () => {},
  });

  try {
    const port = handle.port;
    const token = handle.token;

    // 1. Missing or invalid Bearer token -> 401
    const unauth = await fetch(`http://127.0.0.1:${port}/status`);
    assert.equal(unauth.status, 401);

    const badToken = await fetch(`http://127.0.0.1:${port}/status`, {
      headers: { Authorization: 'Bearer bad-token' },
    });
    assert.equal(badToken.status, 401);

    // 2. Host header loopback validation (IPv4, localhost, IPv6 loopbacks vs non-loopback/invalid)
    const checkHost = async (hostHeader: string): Promise<number> => {
      const { promise, resolve, reject } = Promise.withResolvers<number>();
      const r = httpRequest(
        {
          hostname: '127.0.0.1',
          port,
          path: '/status',
          method: 'GET',
          headers: {
            Host: hostHeader,
            Authorization: `Bearer ${token}`,
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      r.once('error', reject);
      r.end();
      return promise;
    };

    assert.equal(await checkHost('example.com:8080'), 403);
    assert.equal(await checkHost(`192.168.1.1:${port}`), 403);
    assert.equal(await checkHost(`[::2]:${port}`), 403);
    assert.equal(await checkHost('[::1:8080]'), 403);
    assert.equal(await checkHost('[::1]:abc'), 403);
    assert.equal(await checkHost(`[127.0.0.1]:${port}`), 403);
    assert.equal(await checkHost('::1:8080'), 403);
    assert.equal(await checkHost('[::1'), 403);
    assert.equal(await checkHost(`user@127.0.0.1:${port}`), 403);

    assert.equal(await checkHost(`[::1]:${port}`), 200);
    assert.equal(await checkHost('[::1]'), 200);
    assert.equal(await checkHost('::1'), 200);
    assert.equal(await checkHost(`localhost:${port}`), 200);
    assert.equal(await checkHost(`127.0.0.1:${port}`), 200);
    // 3. Valid authenticated GET /status -> 200
    const okStatus = await fetch(`http://127.0.0.1:${port}/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(okStatus.status, 200);
    const body = (await okStatus.json()) as DebugSnapshot;
    assert.equal(body.phase, 'running');

    // 4. Invalid routes -> 404
    const notFound = await fetch(`http://127.0.0.1:${port}/unknown-path`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(notFound.status, 404);

    // 5. Wrong HTTP methods -> 405
    const wrongMethod = await fetch(`http://127.0.0.1:${port}/status`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(wrongMethod.status, 405);

    // 6. Payload limit: body exceeding 1 KiB -> 413
    const oversizedBody = 'x'.repeat(2048);
    const tooLarge = await fetch(`http://127.0.0.1:${port}/recover`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(oversizedBody)),
      },
      body: oversizedBody,
    });
    assert.equal(tooLarge.status, 413);
  } finally {
    await handle.close();
    await rm(systemPath, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('project isolation and concurrent debug sessions with unique IDs', async () => {
  const systemPath = createTempDir('omp-dbg-multi-sys');
  const projectA = createTempDir('omp-dbg-prj-a');
  const projectB = createTempDir('omp-dbg-prj-b');

  await mkdir(systemPath, { recursive: true });
  await mkdir(projectA, { recursive: true });
  await mkdir(projectB, { recursive: true });

  const snapA1: DebugSnapshot = {
    phase: 'running',
    mode: 'launch',
    projectRoot: projectA,
    pendingRequests: 0,
  };
  const snapA2: DebugSnapshot = {
    phase: 'stopped',
    mode: 'attach',
    projectRoot: projectA,
    pendingRequests: 2,
  };
  const snapB: DebugSnapshot = {
    phase: 'running',
    mode: 'launch',
    projectRoot: projectB,
    pendingRequests: 0,
  };

  const handleA1 = await createDebugControl({
    systemPath,
    projectRoot: projectA,
    getStatus: () => snapA1,
    recover: async () => {},
  });
  const handleA2 = await createDebugControl({
    systemPath,
    projectRoot: projectA,
    getStatus: () => snapA2,
    recover: async () => {},
  });
  const handleB = await createDebugControl({
    systemPath,
    projectRoot: projectB,
    getStatus: () => snapB,
    recover: async () => {},
  });

  try {
    // 1. Ensure separate UUID files exist for project A and neither was overwritten
    const dirA = getDebugSessionsDir(systemPath, projectA);
    const filesA = await readdir(dirA);
    const jsonFilesA = filesA.filter((f) => f.endsWith('.json'));
    assert.equal(jsonFilesA.length, 2, 'Project A must contain exactly 2 unique session files');
    assert.ok(jsonFilesA.includes(`${handleA1.id}.json`));
    assert.ok(jsonFilesA.includes(`${handleA2.id}.json`));

    // 2. Project B resides under a distinct hash folder
    const dirB = getDebugSessionsDir(systemPath, projectB);
    const filesB = await readdir(dirB);
    const jsonFilesB = filesB.filter((f) => f.endsWith('.json'));
    assert.equal(jsonFilesB.length, 1);
    assert.ok(jsonFilesB.includes(`${handleB.id}.json`));

    // 3. listDebugSessions only returns sessions belonging to the requested project
    const sessionsA = await listDebugSessions({ systemPath, projectRoot: projectA });
    assert.equal(sessionsA.length, 2);
    assert.ok(sessionsA.every((s) => s.live));

    const sessionsB = await listDebugSessions({ systemPath, projectRoot: projectB });
    assert.equal(sessionsB.length, 1);
    assert.equal(sessionsB[0].id, handleB.id);

    // 4. Closing A1 leaves A2 untouched
    await handleA1.close();
    const afterCloseA = await listDebugSessions({ systemPath, projectRoot: projectA });
    assert.equal(afterCloseA.length, 1);
    assert.equal(afterCloseA[0].id, handleA2.id);
  } finally {
    await handleA1.close();
    await handleA2.close();
    await handleB.close();
    await rm(systemPath, { recursive: true, force: true });
    await rm(projectA, { recursive: true, force: true });
    await rm(projectB, { recursive: true, force: true });
  }
});

test('recovery timing: awaits recover callback, fires onRecovered after response, and avoids close deadlock', async () => {
  const systemPath = createTempDir('omp-dbg-rec-sys');
  const projectRoot = createTempDir('omp-dbg-rec-prj');
  await mkdir(systemPath, { recursive: true });
  await mkdir(projectRoot, { recursive: true });

  const executionOrder: string[] = [];
  let currentPhase: DebugSnapshot['phase'] = 'stopped';

  let controlHandle: DebugControlHandle | null = null;
  const { promise: onRecoveredFired, resolve: markOnRecovered } = Promise.withResolvers<void>();

  controlHandle = await createDebugControl({
    systemPath,
    projectRoot,
    getStatus: () => ({
      phase: currentPhase,
      mode: 'launch',
      projectRoot,
      pendingRequests: 0,
    }),
    recover: async () => {
      executionOrder.push('recover-start');
      // Simulate backend teardown and internal cleanup that invokes handle.close()
      // Crucial: handle.close() must not wait on the active HTTP request, avoiding deadlock!
      currentPhase = 'cleaning';
      if (controlHandle) {
        await controlHandle.close(true); // retainFailed = true
      }
      currentPhase = 'closed';
      executionOrder.push('recover-done');
    },
    onRecovered: () => {
      executionOrder.push('onRecovered');
      markOnRecovered();
    },
  });

  try {
    // Perform recovery
    const snapshot = await recoverDebugSession({
      systemPath,
      projectRoot,
      id: controlHandle.id,
    });

    executionOrder.push('client-received-response');
    assert.equal(snapshot.phase, 'closed');

    // Await onRecovered signal
    await onRecoveredFired;
    // Verify ordering: recover callback must finish BEFORE client gets response
    assert.equal(executionOrder[0], 'recover-start');
    assert.equal(executionOrder[1], 'recover-done');
    assert.ok(executionOrder.indexOf('recover-done') < executionOrder.indexOf('onRecovered'));
    assert.ok(executionOrder.includes('client-received-response'));
  } finally {
    if (controlHandle) {
      await controlHandle.close();
    }
    await rm(systemPath, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('recovery failure: returns error, does not fabricate success, and still triggers onRecovered', async () => {
  const systemPath = createTempDir('omp-dbg-err-sys');
  const projectRoot = createTempDir('omp-dbg-err-prj');
  await mkdir(systemPath, { recursive: true });
  await mkdir(projectRoot, { recursive: true });

  let onRecoveredCalled = false;
  const { promise: errRecoveredFired, resolve: markErrRecovered } = Promise.withResolvers<void>();

  const handle = await createDebugControl({
    systemPath,
    projectRoot,
    getStatus: () => ({
      phase: 'failed',
      mode: 'launch',
      projectRoot,
      error: 'Backend JVM crashed',
      pendingRequests: 0,
    }),
    recover: async () => {
      throw new Error('Socket disconnect during teardown');
    },
    onRecovered: () => {
      onRecoveredCalled = true;
      markErrRecovered();
    },
  });

  try {
    await assert.rejects(
      async () => {
        await recoverDebugSession({
          systemPath,
          projectRoot,
          id: handle.id,
        });
      },
      (err: Error) => {
        assert.match(err.message, /Socket disconnect during teardown/);
        return true;
      },
    );

    // Wait for onRecovered to fire
    await errRecoveredFired;
    assert.equal(onRecoveredCalled, true, 'onRecovered must be called even when recover throws');
  } finally {
    await handle.close();
    await rm(systemPath, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('retainFailed keeps snapshot, blanks token, marks closed, and listDebugSessions reports closed', async () => {
  const systemPath = createTempDir('omp-dbg-ret-sys');
  const projectRoot = createTempDir('omp-dbg-ret-prj');
  await mkdir(systemPath, { recursive: true });
  await mkdir(projectRoot, { recursive: true });

  const handle = await createDebugControl({
    systemPath,
    projectRoot,
    getStatus: () => ({
      phase: 'failed',
      mode: 'launch',
      projectRoot,
      error: 'OutOfMemory in target JVM',
      pendingRequests: 0,
    }),
    recover: async () => {},
  });

  try {
    await handle.close(true); // Retain failed snapshot

    const sessions = await listDebugSessions({ systemPath, projectRoot });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].live, false);
    assert.equal(sessions[0].snapshot?.phase, 'failed');
    assert.equal(sessions[0].snapshot?.error, 'OutOfMemory in target JVM');
  } finally {
    await rm(systemPath, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('dead owner proxy is reported unrecoverable without guessing port or deleting metadata arbitrarily', async () => {
  const systemPath = createTempDir('omp-dbg-dead-sys');
  const projectRoot = createTempDir('omp-dbg-dead-prj');
  const canonical = canonicalizeProject(projectRoot);
  const dir = getDebugSessionsDir(systemPath, projectRoot);
  await mkdir(dir, { recursive: true });

  // Generate a schema-compliant real session, then set its PID to a dead process
  const handle = await createDebugControl({
    systemPath,
    projectRoot,
    getStatus: () => ({
      phase: 'closed',
      mode: 'launch',
      projectRoot: canonical.nativePath,
      pendingRequests: 0,
    }),
    recover: async () => {},
  });

  const deadId = handle.id;
  const metaPath = handle.metadataPath;

  // Stop loopback server and overwrite PID with non-existent 99999999
  await handle.close(true);
  const rawRecord = await readFile(metaPath, 'utf8');
  const record = JSON.parse(rawRecord) as Record<string, unknown>;
  record.pid = 99999999;
  record.closed = false;
  record.port = 59999;
  record.token = 'deadbeef1234';
  await writeFile(metaPath, JSON.stringify(record, null, 2), 'utf8');

  try {
    // 1. listDebugSessions sees dead process and marks unrecoverable
    const sessions = await listDebugSessions({ systemPath, projectRoot });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].live, false);
    assert.match(
      sessions[0].detail,
      /unrecoverable \(proxy PID 99999999 exited; backend connection lost\)/,
    );

    // 2. Metadata file must NOT be deleted arbitrarily
    const dirContents = await readdir(dir);
    assert.ok(dirContents.includes(`${deadId}.json`));

    // 3. recoverDebugSession fails explicitly and refuses to guess port
    await assert.rejects(
      async () => {
        await recoverDebugSession({
          systemPath,
          projectRoot,
          id: deadId,
        });
      },
      (err: Error) => {
        assert.match(err.message, /unrecoverable.*proxy PID 99999999 exited/);
        return true;
      },
    );
  } finally {
    await rm(systemPath, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('recoverDebugSession ID resolution: single live vs multiple live vs prefix matching', async () => {
  const systemPath = createTempDir('omp-dbg-res-sys');
  const projectRoot = createTempDir('omp-dbg-res-prj');
  await mkdir(systemPath, { recursive: true });
  await mkdir(projectRoot, { recursive: true });

  let h1Recovered = false;
  let h2Recovered = false;

  const h1 = await createDebugControl({
    systemPath,
    projectRoot,
    getStatus: () => ({
      phase: h1Recovered ? 'closed' : 'running',
      mode: 'launch',
      projectRoot,
      pendingRequests: 0,
    }),
    recover: async () => {
      h1Recovered = true;
    },
  });

  try {
    // Exactly 1 live session: id omitted automatically selects it
    const snap1 = await recoverDebugSession({ systemPath, projectRoot });
    assert.equal(snap1.phase, 'closed');
    assert.equal(h1Recovered, true);

    // Add a second live session
    const h2 = await createDebugControl({
      systemPath,
      projectRoot,
      getStatus: () => ({
        phase: h2Recovered ? 'closed' : 'running',
        mode: 'attach',
        projectRoot,
        pendingRequests: 0,
      }),
      recover: async () => {
        h2Recovered = true;
      },
    });

    try {
      // Multiple live sessions without ID: throws error requiring ID
      await assert.rejects(
        async () => {
          await recoverDebugSession({ systemPath, projectRoot });
        },
        (err: Error) => {
          assert.match(
            err.message,
            /Multiple active debug sessions found.*Please specify session ID/,
          );
          return true;
        },
      );

      // Unique prefix matching
      const prefix = h2.id.slice(0, 8);
      const snap2 = await recoverDebugSession({ systemPath, projectRoot, id: prefix });
      assert.equal(snap2.mode, 'attach');
      assert.equal(h2Recovered, true);
    } finally {
      await h2.close();
    }
  } finally {
    await h1.close();
    await rm(systemPath, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('extension /intellij debug status and recover commands without UI selector', async () => {
  const systemPath = createTempDir('omp-dbg-ext-sys');
  const projectRoot = createTempDir('omp-dbg-ext-prj');
  await mkdir(systemPath, { recursive: true });
  await mkdir(projectRoot, { recursive: true });

  const pi = createMockPi();
  extension(pi, { systemPath });
  const cmd = pi.getCommand('intellij');
  assert.ok(cmd);

  const ctx = createMockCtx(projectRoot);
  let selectCalled = false;
  ctx.ui.select = async () => {
    selectCalled = true;
    return null;
  };

  try {
    // 1. Status with no sessions
    await cmd.handler('debug status', ctx);
    assert.equal(ctx.notifications.length, 1);
    assert.match(ctx.notifications[0].msg, /No active IntelliJ debug session found/);
    assert.equal(selectCalled, false);

    // 2. Start a debug session
    let recovered = false;
    const handle = await createDebugControl({
      systemPath,
      projectRoot,
      getStatus: () => ({
        phase: recovered ? 'closed' : 'running',
        mode: 'launch',
        projectRoot,
        pendingRequests: 0,
      }),
      recover: async () => {
        recovered = true;
      },
    });

    try {
      ctx.notifications.length = 0;

      // 3. /intellij debug status reports session
      await cmd.handler('debug status', ctx);
      assert.equal(ctx.notifications.length, 1);
      assert.match(ctx.notifications[0].msg, /IntelliJ debug \(1 session\):/);
      assert.match(ctx.notifications[0].msg, /running/);
      assert.equal(selectCalled, false);

      // 4. /intellij status mentions debug session count
      ctx.notifications.length = 0;
      await cmd.handler('status', ctx);
      assert.equal(ctx.notifications.length, 1);
      assert.match(ctx.notifications[0].msg, /debug: 1 active \/ 1 total/);

      // 5. /intellij debug recover succeeds without UI selector
      ctx.notifications.length = 0;
      await cmd.handler('debug recover', ctx);
      assert.equal(ctx.notifications.length, 1);
      assert.match(ctx.notifications[0].msg, /IntelliJ debug session recovered/);
      assert.equal(recovered, true);
      assert.equal(selectCalled, false);

      // 6. Unknown debug subcommand reports usage
      ctx.notifications.length = 0;
      await cmd.handler('debug invalidSub', ctx);
      assert.equal(ctx.notifications.length, 1);
      assert.match(ctx.notifications[0].msg, /Usage: \/intellij debug \[status\|recover \[id\]\]/);
    } finally {
      await handle.close();
    }
  } finally {
    await rm(systemPath, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('single-flight recovery: concurrent recover requests receive HTTP 409 conflict', async () => {
  const systemPath = createTempDir('omp-dbg-flight-sys');
  const projectRoot = createTempDir('omp-dbg-flight-prj');
  await mkdir(systemPath, { recursive: true });
  await mkdir(projectRoot, { recursive: true });

  const { promise: blockRecover, resolve: unblockRecover } = Promise.withResolvers<void>();
  const { promise: recoverStarted, resolve: markRecoverStarted } = Promise.withResolvers<void>();

  const handle = await createDebugControl({
    systemPath,
    projectRoot,
    getStatus: () => ({
      phase: 'stopped',
      mode: 'launch',
      projectRoot,
      pendingRequests: 0,
    }),
    recover: async () => {
      markRecoverStarted();
      await blockRecover;
    },
  });

  try {
    // Fire first recover (in flight)
    const firstRecoverRequest = fetch(`http://127.0.0.1:${handle.port}/recover`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${handle.token}` },
    });

    // Deterministically await until request 1 has entered recover()
    await recoverStarted;
    // Fire second recover concurrently
    const concurrentRecoverResponse = await fetch(`http://127.0.0.1:${handle.port}/recover`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${handle.token}` },
    });
    assert.equal(
      concurrentRecoverResponse.status,
      409,
      'Concurrent recover must return 409 Conflict',
    );

    // Unblock first recover and ensure it finishes successfully
    unblockRecover();
    const firstRecoverResponse = await firstRecoverRequest;
    assert.equal(firstRecoverResponse.status, 200);
  } finally {
    unblockRecover();
    await handle.close();
    await rm(systemPath, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('strict recovery validation: corrupt response rejects without fabricating success or fallback', async () => {
  const systemPath = createTempDir('omp-dbg-corrupt-sys');
  const projectRoot = createTempDir('omp-dbg-corrupt-prj');
  await mkdir(systemPath, { recursive: true });
  await mkdir(projectRoot, { recursive: true });

  // Setup session where getStatus returns invalid snapshot during recover response
  let sendCorruptSnapshot = false;
  const handle = await createDebugControl({
    systemPath,
    projectRoot,
    getStatus: () => {
      if (sendCorruptSnapshot) {
        return { invalid: 'not a snapshot' } as unknown as DebugSnapshot;
      }
      return {
        phase: 'running',
        mode: 'launch',
        projectRoot,
        pendingRequests: 0,
      };
    },
    recover: async () => {
      sendCorruptSnapshot = true;
    },
  });

  try {
    await assert.rejects(
      async () => {
        await recoverDebugSession({
          systemPath,
          projectRoot,
          id: handle.id,
        });
      },
      (err: Error) => {
        assert.match(err.message, /response missing valid snapshot/);
        return true;
      },
    );
  } finally {
    await handle.close();
    await rm(systemPath, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('metadata schema validation: invalid records are safely skipped', async () => {
  const systemPath = createTempDir('omp-dbg-schema-sys');
  const projectRoot = createTempDir('omp-dbg-schema-prj');
  const canonical = canonicalizeProject(projectRoot);
  const dir = getDebugSessionsDir(systemPath, projectRoot);
  await mkdir(dir, { recursive: true });

  // 1. Non-UUID file
  await writeFile(join(dir, 'not-a-uuid.json'), JSON.stringify({ id: 'not-uuid' }));

  // 2. Missing required snapshot
  await writeFile(
    join(dir, '11111111-1111-1111-1111-111111111111.json'),
    JSON.stringify({
      id: '11111111-1111-1111-1111-111111111111',
      pid: process.pid,
      canonical: canonical.canonicalPath,
      hash: canonical.id,
      projectRoot: canonical.nativePath,
      port: 8080,
      token: 'abcd1234',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );

  // 3. Invalid port range
  await writeFile(
    join(dir, '22222222-2222-2222-2222-222222222222.json'),
    JSON.stringify({
      id: '22222222-2222-2222-2222-222222222222',
      pid: process.pid,
      canonical: canonical.canonicalPath,
      hash: canonical.id,
      projectRoot: canonical.nativePath,
      port: 999999,
      token: 'abcd1234',
      snapshot: {
        phase: 'running',
        mode: 'launch',
        projectRoot: canonical.nativePath,
        pendingRequests: 0,
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );

  try {
    const sessions = await listDebugSessions({ systemPath, projectRoot });
    assert.equal(sessions.length, 0, 'Malformed or invalid metadata records must be ignored');
  } finally {
    await rm(systemPath, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});

for (const phase of ['running', 'cleaning', 'failed'] as const) {
  test(`recovery rejects an unfinished ${phase} snapshot`, async (t) => {
    const systemPath = createTempDir('omp-dbg-incomplete');
    const projectRoot = createTempDir('omp-dbg-incomplete-project');
    const handle = await createDebugControl({
      systemPath,
      projectRoot,
      getStatus: () => ({ phase, mode: 'attach', projectRoot, pendingRequests: 0 }),
      recover: async () => {},
    });
    t.after(async () => {
      await handle.close();
      await rm(systemPath, { recursive: true, force: true });
    });
    await assert.rejects(
      recoverDebugSession({ systemPath, projectRoot }),
      /Debug recovery incomplete/,
    );
  });
}

test('an abandoned recovery caller cannot leave the proxy alive after cleanup', async (t) => {
  const systemPath = createTempDir('omp-dbg-abandoned');
  const projectRoot = createTempDir('omp-dbg-abandoned-project');
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const recovered = Promise.withResolvers<void>();
  let phase: DebugSnapshot['phase'] = 'running';
  const handle = await createDebugControl({
    systemPath,
    projectRoot,
    getStatus: () => ({ phase, mode: 'attach', projectRoot, pendingRequests: 0 }),
    recover: async () => {
      entered.resolve();
      await release.promise;
      phase = 'closed';
    },
    onRecovered: () => recovered.resolve(),
  });
  t.after(async () => {
    release.resolve();
    await handle.close();
    await rm(systemPath, { recursive: true, force: true });
  });
  const request = httpRequest(`http://127.0.0.1:${handle.port}/recover`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${handle.token}` },
  });
  const clientClosed = Promise.withResolvers<void>();
  request.once('close', clientClosed.resolve);
  request.on('error', () => {});
  request.end();
  await entered.promise;
  request.destroy();
  await clientClosed.promise;
  const status = await fetch(`http://127.0.0.1:${handle.port}/status`, {
    headers: { Authorization: `Bearer ${handle.token}` },
  });
  assert.equal(status.status, 200);
  await status.arrayBuffer();
  release.resolve();
  await recovered.promise;
  assert.equal(phase, 'closed');
});
test('debug sessions isolate case-different paths and migrate legacy sessions on path match', async () => {
  const systemPath = createTempDir('omp-dbg-iso-sys');
  await mkdir(systemPath, { recursive: true });

  const projUpper = join(systemPath, 'DebugCaseProject');
  const projLower = join(systemPath, 'debugcaseproject');
  await mkdir(projUpper, { recursive: true });
  await mkdir(projLower, { recursive: true });

  const canonUpper = canonicalizeProject(projUpper);
  const canonLower = canonicalizeProject(projLower);

  const dirUpper = getDebugSessionsDir(systemPath, projUpper);
  const dirLower = getDebugSessionsDir(systemPath, projLower);
  if (!pathsEqual(projUpper, projLower)) {
    assert.notEqual(dirUpper, dirLower);
  } else {
    assert.equal(dirUpper, dirLower);
  }
  await mkdir(dirUpper, { recursive: true });
  await mkdir(dirLower, { recursive: true });

  const sessionUpperId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const sessionLowerId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

  const snapshot: DebugSnapshot = {
    projectRoot: projUpper,
    mode: 'attach',
    phase: 'closed',
    pendingRequests: 0,
  };

  await writeFile(
    join(dirUpper, `${sessionUpperId}.json`),
    JSON.stringify({
      id: sessionUpperId,
      pid: process.pid,
      canonical: canonUpper.canonicalPath,
      hash: canonUpper.id,
      projectRoot: canonUpper.nativePath,
      port: 0,
      token: 'tok_upper',
      closed: true,
      snapshot,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
    'utf8',
  );

  await writeFile(
    join(dirLower, `${sessionLowerId}.json`),
    JSON.stringify({
      id: sessionLowerId,
      pid: process.pid,
      canonical: canonLower.canonicalPath,
      hash: canonLower.id,
      projectRoot: canonLower.nativePath,
      port: 0,
      token: 'tok_lower',
      closed: true,
      snapshot: { ...snapshot, projectRoot: projLower },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
    'utf8',
  );

  try {
    const listUpper = await listDebugSessions({ systemPath, projectRoot: projUpper });
    const listLower = await listDebugSessions({ systemPath, projectRoot: projLower });

    const equivalent = pathsEqual(projUpper, projLower);
    assert.deepEqual(
      listUpper.map((s) => s.id),
      equivalent ? [sessionUpperId, sessionLowerId] : [sessionUpperId],
    );
    assert.deepEqual(
      listLower.map((s) => s.id),
      equivalent ? [sessionUpperId, sessionLowerId] : [sessionLowerId],
    );

    const legacyId = canonUpper.legacyId ?? 'legacy-id';
    const legacyDir = join(systemPath, 'plugin-metadata', 'debug-sessions', legacyId);
    await mkdir(legacyDir, { recursive: true });
    const sessionLegacyId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

    await writeFile(
      join(legacyDir, `${sessionLegacyId}.json`),
      JSON.stringify({
        id: sessionLegacyId,
        pid: process.pid,
        canonical: canonUpper.canonicalPath,
        hash: legacyId,
        projectRoot: canonUpper.nativePath,
        port: 0,
        token: 'tok_legacy',
        closed: true,
        snapshot: { ...snapshot },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
      'utf8',
    );

    const listUpperWithLegacy = await listDebugSessions({ systemPath, projectRoot: projUpper });
    assert.ok(listUpperWithLegacy.some((s) => s.id === sessionLegacyId));

    const listLowerWithLegacy = await listDebugSessions({ systemPath, projectRoot: projLower });
    assert.equal(
      listLowerWithLegacy.some((s) => s.id === sessionLegacyId),
      equivalent,
    );
  } finally {
    await rm(systemPath, { recursive: true, force: true });
  }
});
