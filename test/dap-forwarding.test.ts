import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDapTestHarness, type DapRequest, type DapTestHarness } from './dap-fixture.js';

function commandOf(params: unknown): unknown {
  return params && typeof params === 'object' && 'command' in params ? params.command : undefined;
}

function capabilitiesOf(body: unknown): Record<string, unknown> | undefined {
  if (!body || typeof body !== 'object' || !('capabilities' in body)) return undefined;
  const caps = body.capabilities;
  if (!caps || typeof caps !== 'object' || Array.isArray(caps)) return undefined;
  return caps as Record<string, unknown>;
}

const androidLspCapabilities = {
  capabilities: {
    executeCommandProvider: {
      commands: ['start_debug_server', 'org.intellij.android.debug.startServer'],
    },
  },
};

test('ordinary JVM loopback attach uses start_debug_server and never invokes legacy Android RPCs', async (t) => {
  for (const host of ['127.0.0.1', '[::1]', '[0:0:0:0:0:0:0:1]', '192.0.2.1', '[::1:8080]']) {
    const harness = await createDapTestHarness(t, {
      onLspRequest(method) {
        if (method === 'initialize') return androidLspCapabilities;
        return undefined;
      },
    });
    await harness.request('initialize');
    assert.equal(
      (await harness.request('attach', { host, port: 50558, timeout: 30000 })).success,
      true,
    );
    const executedCommands = harness.lspRequests
      .filter((r) => r.method === 'workspace/executeCommand')
      .map((r) => commandOf(r.params));
    assert.deepEqual(executedCommands, ['start_debug_server']);
    if (host === '[::1]' || host === '[0:0:0:0:0:0:0:1]') {
      assert.equal(
        harness.backendRequests.find((request) => request.command === 'attach')?.arguments
          ?.hostName,
        '::1',
      );
    } else if (host === '[::1:8080]') {
      assert.equal(
        harness.backendRequests.find((request) => request.command === 'attach')?.arguments
          ?.hostName,
        '::1:8080',
      );
    }
    assert.equal(
      harness.backendRequests.find((request) => request.command === 'attach')?.arguments?.timeout,
      30000,
    );
    assert.equal((await harness.request('disconnect')).success, true);
  }
});

test('attach rejects malformed hosts before opening backend', async (t) => {
  const harness = await createDapTestHarness(t);
  await harness.request('initialize');
  for (const host of ['[::1', '::1]', '[127.0.0.1]', 'foo[bar]', '[[::1]]']) {
    const res = await harness.request('attach', { host, port: 50558 });
    assert.equal(res.success, false);
    assert.match(res.message ?? '', /Malformed/);
  }
  assert.equal(harness.backendRequests.length, 0);
});

for (const mode of ['launch', 'attach'] as const) {
  test(`Android ${mode} routes via org.intellij.android.debug.startServer({}) and forwards raw arguments`, async (t) => {
    const rawArgs: Record<string, unknown> =
      mode === 'launch'
        ? {
            android: {
              deviceId: 'emulator-5554',
              target: { kind: 'apks', files: ['app-debug.apk'] },
            },
            program: 'app-debug.apk',
            cwd: process.cwd(),
            noDebug: false,
          }
        : {
            android: {
              deviceId: 'emulator-5554',
              packageName: 'com.example.app',
            },
            cwd: process.cwd(),
          };

    let seenStartRequest: DapRequest | undefined;
    let configDoneCountAtStart = -1;
    const heldStart = Promise.withResolvers<DapRequest>();
    const configured = Promise.withResolvers<void>();
    const harness = await createDapTestHarness(t, {
      capabilities: {
        supportsTerminateRequest: false,
        supportsCancelRequest: true,
        supportTerminateDebuggee: false,
        supportsThreadDumpRequest: false,
      },
      onLspRequest(method) {
        if (method === 'initialize') return androidLspCapabilities;
        return undefined;
      },
      onDapRequest(request) {
        if (request.command === 'configurationDone') configured.resolve();
        if (request.command === mode) {
          seenStartRequest = request;
          configDoneCountAtStart = harness.backendRequests.filter(
            (r) => r.command === 'configurationDone',
          ).length;
          heldStart.resolve(request);
          return true;
        }
        return undefined;
      },
    });

    await harness.request('initialize');
    const startSeq = harness.send(mode, rawArgs);
    await heldStart.promise;

    assert.deepEqual(seenStartRequest?.arguments, rawArgs);
    assert.equal(configDoneCountAtStart, 0);
    assert.equal(
      harness.backendRequests.some((r) => r.command === 'intellij/threadDump'),
      false,
    );

    const startCommands = harness.lspRequests
      .filter((r) => r.method === 'workspace/executeCommand')
      .map((r) => ({
        command: commandOf(r.params),
        arguments:
          r.params && typeof r.params === 'object' && 'arguments' in r.params
            ? r.params.arguments
            : undefined,
      }));
    assert.deepEqual(startCommands, [
      { command: 'org.intellij.android.debug.startServer', arguments: [{}] },
    ]);
    assert.equal(
      harness.lspRequests.some(
        (r) => r.method === 'textDocument/codeLens' || r.method === 'textDocument/didOpen',
      ),
      false,
    );

    await harness.waitFor((m) => m.type === 'event' && m.event === 'initialized');
    assert.equal(
      harness.backendRequests.some((r) => r.command === 'configurationDone'),
      false,
    );
    assert.equal((await harness.request('configurationDone')).success, true);
    await configured.promise;
    assert.equal(
      harness.backendRequests.filter((r) => r.command === 'configurationDone').length,
      1,
    );

    harness.respond(seenStartRequest!, {});
    const startRes = await harness.waitFor(
      (m) => m.type === 'response' && m.request_seq === startSeq,
    );
    assert.equal(startRes.type === 'response' && startRes.success, true);

    assert.equal((await harness.request('disconnect', { terminateDebuggee: false })).success, true);
    assert.equal(await harness.closed, 0);
  });
}

test('Android routing forwards empty or null android objects to backend without proxy validation', async (t) => {
  for (const androidValue of [{}, null]) {
    const harness = await createDapTestHarness(t, {
      onLspRequest(method) {
        if (method === 'initialize') return androidLspCapabilities;
        return undefined;
      },
      onDapRequest(request) {
        if (request.command === 'launch') {
          harness.respond(
            request,
            undefined,
            false,
            '[invalid_params] configuring: android.deviceId is required',
          );
          return true;
        }
        return undefined;
      },
    });
    await harness.request('initialize');
    const res = await harness.request('launch', { android: androidValue });
    assert.equal(res.success, false);
    assert.equal(res.message, '[invalid_params] configuring: android.deviceId is required');
    assert.deepEqual(
      harness.backendRequests.find((r) => r.command === 'launch')?.arguments?.android,
      androidValue,
    );
    assert.equal(
      harness.backendRequests.some((r) => r.command === 'terminate' || r.command === 'disconnect'),
      false,
    );
    assert.equal(await harness.closed, 1);
  }
});

test('Android startServer capability check and port validation fail cleanly', async (t) => {
  const missingCmdHarness = await createDapTestHarness(t, {
    onLspRequest(method) {
      if (method === 'initialize') {
        return {
          capabilities: {
            executeCommandProvider: { commands: ['start_debug_server'] },
          },
        };
      }
      return undefined;
    },
  });
  await missingCmdHarness.request('initialize');
  const missingRes = await missingCmdHarness.request('launch', {
    android: { deviceId: 'emulator-5554', target: { kind: 'installed', packageName: 'pkg' } },
  });
  assert.equal(missingRes.success, false);
  assert.match(missingRes.message ?? '', /org\.intellij\.android\.debug\.startServer/);
  assert.equal(
    missingCmdHarness.lspRequests.some((r) => r.method === 'workspace/executeCommand'),
    false,
  );
  assert.equal(await missingCmdHarness.closed, 1);

  for (const badResult of [null, {}, { port: '5005' }, { port: 0 }, { port: 65536 }]) {
    const badPortHarness = await createDapTestHarness(t, {
      onLspRequest(method, params) {
        if (method === 'initialize') return androidLspCapabilities;
        if (
          method === 'workspace/executeCommand' &&
          commandOf(params) === 'org.intellij.android.debug.startServer'
        ) {
          return badResult;
        }
        return undefined;
      },
    });
    await badPortHarness.request('initialize');
    const res = await badPortHarness.request('attach', {
      android: { deviceId: 'emulator-5554', packageName: 'pkg' },
    });
    assert.equal(res.success, false);
    assert.match(res.message ?? '', /Invalid Android debug server port/);
    assert.equal(badPortHarness.backendRequests.length, 0);
    assert.equal(await badPortHarness.closed, 1);
  }
});

test('Android capabilities, terminate failure preservation, and disconnect param passthrough', async (t) => {
  const harness = await createDapTestHarness(t, {
    capabilities: {
      supportsTerminateRequest: false,
      supportsCancelRequest: true,
      supportTerminateDebuggee: false,
    },
    onLspRequest(method) {
      if (method === 'initialize') return androidLspCapabilities;
      return undefined;
    },
    onDapRequest(request) {
      if (request.command === 'terminate') {
        harness.respond(request, undefined, false, 'Terminate is not supported');
        return true;
      }
      return undefined;
    },
  });

  const initial = await harness.request('initialize');
  assert.deepEqual(initial.body, {
    supportsConfigurationDoneRequest: true,
    supportsTerminateRequest: false,
    supportTerminateDebuggee: false,
    supportSuspendDebuggee: false,
    supportsCancelRequest: false,
  });

  const launchRes = await harness.request('launch', {
    android: { deviceId: 'emulator-5554', target: { kind: 'installed', packageName: 'pkg' } },
  });
  assert.equal(launchRes.success, true);

  const capEventsBefore = harness.messages.filter(
    (m) => m.type === 'event' && m.event === 'capabilities',
  );
  const firstCaps = capabilitiesOf(capEventsBefore[0]?.body);
  assert.equal(firstCaps?.supportsTerminateRequest, false);
  assert.equal(firstCaps?.supportsCancelRequest, true);
  assert.equal(firstCaps?.supportTerminateDebuggee, false);

  harness.emit('capabilities', { capabilities: { supportTerminateDebuggee: true } });
  const updatedCapEvent = await harness.waitFor(
    (m) =>
      m.type === 'event' &&
      m.event === 'capabilities' &&
      capabilitiesOf(m.body)?.supportTerminateDebuggee === true,
  );
  const updatedCaps = capabilitiesOf(updatedCapEvent.body);
  assert.equal(updatedCaps?.supportsTerminateRequest, false);
  assert.equal(updatedCaps?.supportTerminateDebuggee, true);

  const termRes = await harness.request('terminate');
  assert.equal(termRes.success, false);
  assert.equal(termRes.message, 'Terminate is not supported');

  const threadsRes = await harness.request('threads');
  assert.equal(threadsRes.success, true);

  const disconnectRes = await harness.request('disconnect', {
    terminateDebuggee: true,
    restart: false,
  });
  assert.equal(disconnectRes.success, true);
  assert.equal(await harness.closed, 0);

  const disconnects = harness.backendRequests.filter((r) => r.command === 'disconnect');
  assert.equal(disconnects.length, 1);
  assert.deepEqual(disconnects[0]?.arguments, {
    terminateDebuggee: true,
    restart: false,
  });
  assert.equal(
    harness.backendRequests.filter((r) => r.command === 'terminate').length,
    1,
  );
});

test('Android external attach disconnect error preserves backend message and emits single terminated', async (t) => {
  const lspClosed = Promise.withResolvers<void>();
  const harness = await createDapTestHarness(t, {
    onLspRequest(method) {
      if (method === 'initialize') return androidLspCapabilities;
      return undefined;
    },
    onDapRequest(request) {
      if (request.command === 'disconnect') {
        harness.respond(
          request,
          undefined,
          false,
          '[invalid_params] disconnecting: terminateDebuggee=true is not permitted for external attach',
        );
        return true;
      }
      return undefined;
    },
    onLspClose() {
      lspClosed.resolve();
    },
  });

  await harness.request('initialize');
  assert.equal(
    (
      await harness.request('attach', {
        android: { deviceId: 'emulator-5554', packageName: 'com.example.app' },
      })
    ).success,
    true,
  );
  const res = await harness.request('disconnect', { terminateDebuggee: true });
  assert.equal(res.success, false);
  assert.equal(
    res.message,
    '[invalid_params] disconnecting: terminateDebuggee=true is not permitted for external attach',
  );
  await lspClosed.promise;
  assert.equal(await harness.closed, 1);
  assert.equal(
    harness.backendRequests.filter((r) => r.command === 'disconnect').length,
    1,
  );
  assert.equal(
    harness.backendRequests.some((r) => r.command === 'terminate'),
    false,
  );
  assert.equal(
    harness.messages.filter((m) => m.type === 'event' && m.event === 'terminated').length,
    1,
  );
});

test('Android disconnect succeeds when backend holds socket open waiting for client EOF', async (t) => {
  const lspClosed = Promise.withResolvers<void>();
  let harness: DapTestHarness;
  harness = await createDapTestHarness(t, {
    keepBackendAfterDisconnect: true,
    onLspRequest(method) {
      if (method === 'initialize') return androidLspCapabilities;
      return undefined;
    },
    onDapRequest(request) {
      if (request.command === 'disconnect') {
        harness.emit('terminated');
        harness.respond(request);
        return true;
      }
      return undefined;
    },
    onLspClose() {
      lspClosed.resolve();
    },
  });

  await harness.request('initialize');
  assert.equal(
    (
      await harness.request('attach', {
        android: { deviceId: 'emulator-5554', packageName: 'com.example.app' },
      })
    ).success,
    true,
  );

  const res = await harness.request('disconnect', { terminateDebuggee: false });
  assert.equal(res.success, true, res.message);
  await lspClosed.promise;
  assert.equal(await harness.closed, 0);
  assert.equal(
    harness.backendRequests.filter((r) => r.command === 'disconnect').length,
    1,
  );
  assert.equal(
    harness.backendRequests.some((r) => r.command === 'terminate'),
    false,
  );
  assert.equal(
    harness.messages.filter((m) => m.type === 'event' && m.event === 'terminated').length,
    1,
  );
});

test('Android disconnect abnormal backend EOF before response fails cleanup and emits single terminated', async (t) => {
  const lspClosed = Promise.withResolvers<void>();
  let harness: DapTestHarness;
  harness = await createDapTestHarness(t, {
    keepBackendAfterDisconnect: true,
    onLspRequest(method) {
      if (method === 'initialize') return androidLspCapabilities;
      return undefined;
    },
    onDapRequest(request) {
      if (request.command === 'disconnect') {
        harness.closeBackend(true);
        return true;
      }
      return undefined;
    },
    onLspClose() {
      lspClosed.resolve();
    },
  });

  await harness.request('initialize');
  assert.equal(
    (
      await harness.request('attach', {
        android: { deviceId: 'emulator-5554', packageName: 'com.example.app' },
      })
    ).success,
    true,
  );

  const res = await harness.request('disconnect', { terminateDebuggee: false });
  assert.equal(res.success, false);
  assert.match(res.message ?? '', /Debug server socket closed/);
  await lspClosed.promise;
  assert.equal(await harness.closed, 1);
  assert.equal(
    harness.messages.filter((m) => m.type === 'event' && m.event === 'terminated').length,
    1,
  );
});

for (const ending of ['eof', 'terminated', 'backend-close'] as const) {
  test(`Android ${ending} closes session without synthesizing terminate or disconnect`, async (t) => {
    const lspClosed = Promise.withResolvers<void>();
    const harness = await createDapTestHarness(t, {
      onLspRequest(method) {
        if (method === 'initialize') return androidLspCapabilities;
        return undefined;
      },
      onLspClose() {
        lspClosed.resolve();
      },
    });
    await harness.request('initialize');
    assert.equal(
      (
        await harness.request('launch', {
          android: { deviceId: 'emulator-5554', target: { kind: 'installed', packageName: 'pkg' } },
        })
      ).success,
      true,
    );
    if (ending === 'eof') harness.stdin.end();
    else if (ending === 'terminated') harness.emit('terminated');
    else harness.closeBackend();

    await lspClosed.promise;
    const exitCode = await harness.closed;
    assert.equal(exitCode, ending === 'backend-close' ? 1 : 0);
    assert.equal(
      harness.backendRequests.some((r) => r.command === 'terminate' || r.command === 'disconnect'),
      false,
    );
    assert.equal(
      harness.messages.filter((m) => m.type === 'event' && m.event === 'terminated').length,
      1,
    );
  });
}

test('Android startup cancel aborts bootstrap via $/cancelRequest before endpoint connection', async (t) => {
  const startServerEntered = Promise.withResolvers<void>();
  const lspClosed = Promise.withResolvers<void>();
  const harness = await createDapTestHarness(t, {
    onLspRequest(method, params) {
      if (method === 'initialize') return androidLspCapabilities;
      if (
        method === 'workspace/executeCommand' &&
        commandOf(params) === 'org.intellij.android.debug.startServer'
      ) {
        startServerEntered.resolve();
        return new Promise(() => {});
      }
      return undefined;
    },
    onLspClose() {
      lspClosed.resolve();
    },
  });

  await harness.request('initialize');
  const launchSeq = harness.send('launch', {
    android: { deviceId: 'emulator-5554', target: { kind: 'installed', packageName: 'pkg' } },
  });
  await startServerEntered.promise;
  const cancelRes = await harness.request('cancel', { requestId: launchSeq });
  assert.equal(cancelRes.success, true);

  const launchRes = await harness.waitFor(
    (m) => m.type === 'response' && m.request_seq === launchSeq,
  );
  assert.equal(launchRes.type === 'response' && launchRes.success, false);
  await setImmediate();
  assert.equal(
    harness.lspRequests.some((r) => r.method === '$/cancelRequest'),
    true,
  );
  assert.equal(harness.backendRequests.length, 0);
  await lspClosed.promise;
  assert.equal(await harness.closed, 1);
});

test('Android startup cancel after backend launch forwards mapped requestId and progressId', async (t) => {
  const heldLaunch = Promise.withResolvers<DapRequest>();
  const cancelForwarded = Promise.withResolvers<DapRequest>();
  const harness = await createDapTestHarness(t, {
    onLspRequest(method) {
      if (method === 'initialize') return androidLspCapabilities;
      return undefined;
    },
    onDapRequest(request) {
      if (request.command === 'launch') {
        heldLaunch.resolve(request);
        return true;
      }
      if (request.command === 'cancel') {
        cancelForwarded.resolve(request);
      }
      return undefined;
    },
  });

  await harness.request('initialize');
  const launchSeq = harness.send('launch', {
    android: { deviceId: 'emulator-5554', target: { kind: 'installed', packageName: 'pkg' } },
  });
  const backendLaunch = await heldLaunch.promise;
  const cancelSeq = harness.send('cancel', {
    requestId: launchSeq,
    progressId: 'org.intellij.android.launch',
  });
  const backendCancel = await cancelForwarded.promise;
  assert.equal(backendCancel.arguments?.requestId, backendLaunch.seq);
  assert.equal(backendCancel.arguments?.progressId, 'org.intellij.android.launch');

  const cancelRes = await harness.waitFor(
    (m) => m.type === 'response' && m.request_seq === cancelSeq,
  );
  assert.equal(cancelRes.type === 'response' && cancelRes.success, true);
  harness.respond(backendLaunch, undefined, false, '[cancelled] configuring: Cancelled');
  const launchRes = await harness.waitFor(
    (m) => m.type === 'response' && m.request_seq === launchSeq,
  );
  assert.equal(launchRes.type === 'response' && launchRes.success, false);
  assert.match(launchRes.type === 'response' ? (launchRes.message ?? '') : '', /Cancelled/);
  assert.equal(await harness.closed, 1);
});

test('Android session preserves zero-based URI source translation across requests and events', async (t) => {
  let sourcePath = '';
  const harness = await createDapTestHarness(t, {
    onLspRequest(method) {
      if (method === 'initialize') return androidLspCapabilities;
      return undefined;
    },
    onDapRequest(request) {
      if (request.command === 'setBreakpoints') {
        harness.respond(request, {
          breakpoints: [{ id: 1, verified: true, line: 10, source: { path: sourcePath } }],
        });
        return true;
      }
      if (request.command === 'stackTrace') {
        harness.respond(request, {
          stackFrames: [
            { id: 1, name: 'onCreate', line: 10, column: 1, source: { path: sourcePath } },
          ],
          totalFrames: 1,
        });
        return true;
      }
      return undefined;
    },
  });

  sourcePath = join(harness.systemPath, 'MainActivity.kt');
  const sourceUri = pathToFileURL(sourcePath).href;
  await harness.request('initialize', {
    pathFormat: 'uri',
    linesStartAt1: false,
    columnsStartAt1: false,
  });
  const bp = await harness.request('setBreakpoints', {
    source: { path: sourceUri },
    breakpoints: [{ line: 9, column: 0 }],
  });
  assert.equal(bp.success, true);
  assert.equal(
    (await harness.request('launch', {
      android: { deviceId: 'emulator-5554', target: { kind: 'installed', packageName: 'pkg' } },
    })).success,
    true,
  );
  const replayed = harness.backendRequests.find((r) => r.command === 'setBreakpoints');
  assert.deepEqual(replayed?.arguments, {
    source: { path: sourcePath },
    breakpoints: [{ line: 10, column: 1 }],
  });
  const stack = await harness.request('stackTrace', { threadId: 1 });
  assert.deepEqual(stack.body, {
    stackFrames: [
      { id: 1, name: 'onCreate', line: 9, column: 0, source: { path: sourceUri } },
    ],
    totalFrames: 1,
  });
});
