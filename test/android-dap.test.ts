import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { ANDROID_DEBUG_COMMANDS } from '../src/android/debug-attach.js';
import { createDapTestHarness } from './dap-fixture.js';

function commandOf(params: unknown): unknown {
  return params && typeof params === 'object' && 'command' in params ? params.command : undefined;
}

const cleanupKey = '550e8400-e29b-41d4-a716-446655440000';
const capabilities = {
  capabilities: {
    executeCommandProvider: {
      commands: ['start_debug_server', ...Object.values(ANDROID_DEBUG_COMMANDS)],
    },
  },
};

for (const releaseFails of [false, true]) {
  test(`Android attach disconnects before releasing and closes LSP${releaseFails ? ' after release failure' : ''}`, async (t) => {
    const events: string[] = [];
    const closed = Promise.withResolvers<void>();
    const harness = await createDapTestHarness(t, {
      onLspRequest(method, params) {
        if (method === 'initialize') return capabilities;
        const command = commandOf(params);
        if (command === ANDROID_DEBUG_COMMANDS.claim) {
          events.push('claim');
          return { claimed: true, cleanupKey };
        }
        if (command === ANDROID_DEBUG_COMMANDS.release) {
          events.push('release');
          assert.ok(params && typeof params === 'object' && 'arguments' in params);
          assert.deepEqual(params.arguments, [{ cleanupKey }]);
          if (releaseFails) return Promise.reject(new Error('child close failed'));
          return { success: true, cleaned: true };
        }
        return undefined;
      },
      onDapRequest(request) {
        if (request.command === 'disconnect') {
          events.push('disconnect');
          assert.equal(request.arguments?.terminateDebuggee, false);
        }
        return undefined;
      },
      onLspClose() {
        events.push('close');
        closed.resolve();
      },
    });
    await harness.request('initialize');
    const attached = await harness.request('attach', { port: 50558, timeout: 60 });
    assert.equal(attached.success, true, attached.message);
    const detached = await harness.request('disconnect');
    assert.equal(detached.success, !releaseFails, detached.message);
    await closed.promise;
    assert.deepEqual(events, ['claim', 'disconnect', 'release', 'close']);
    assert.equal(await harness.closed, releaseFails ? 1 : 0);
  });
}

test('Android claim failure prevents native debugger creation', async (t) => {
  const harness = await createDapTestHarness(t, {
    onLspRequest(method, params) {
      if (method === 'initialize') return capabilities;
      if (commandOf(params) === ANDROID_DEBUG_COMMANDS.claim) {
        return Promise.reject(new Error('lease_expired'));
      }
      return undefined;
    },
  });
  await harness.request('initialize');
  const result = await harness.request('attach', { port: 50558 });
  assert.equal(result.success, false);
  assert.match(result.message ?? '', /lease_expired/);
  assert.equal(harness.backendRequests.length, 0);
  assert.equal(
    harness.lspRequests.some((request) => commandOf(request.params) === 'start_debug_server'),
    false,
  );
  assert.equal(await harness.closed, 1);
});

test('EOF during claim waits for ownership then releases before closing LSP', async (t) => {
  const entered = Promise.withResolvers<void>();
  const claim = Promise.withResolvers<{ claimed: true; cleanupKey: string }>();
  const closed = Promise.withResolvers<void>();
  const events: string[] = [];
  const harness = await createDapTestHarness(t, {
    onLspRequest(method, params) {
      if (method === 'initialize') return capabilities;
      const command = commandOf(params);
      if (command === ANDROID_DEBUG_COMMANDS.claim) {
        entered.resolve();
        return claim.promise;
      }
      if (command === ANDROID_DEBUG_COMMANDS.release) {
        events.push('release');
        return { success: true, cleaned: true };
      }
      return undefined;
    },
    onLspClose() {
      events.push('close');
      closed.resolve();
    },
  });
  await harness.request('initialize');
  harness.send('attach', { port: 50558 });
  await entered.promise;
  harness.stdin.end();
  await setImmediate();
  assert.deepEqual(events, []);
  claim.resolve({ claimed: true, cleanupKey });
  await harness.closed;
  await closed.promise;
  assert.deepEqual(events, ['release', 'close']);
  assert.equal(harness.backendRequests.length, 0);
});

test('unclaimed loopback attach and remote attach preserve ordinary JVM behavior', async (t) => {
  for (const host of ['127.0.0.1', '192.0.2.1']) {
    let claims = 0;
    const harness = await createDapTestHarness(t, {
      onLspRequest(method, params) {
        if (method === 'initialize') return capabilities;
        if (commandOf(params) === ANDROID_DEBUG_COMMANDS.claim) {
          claims++;
          return { claimed: false };
        }
        return undefined;
      },
    });
    await harness.request('initialize');
    assert.equal(
      (await harness.request('attach', { host, port: 50558, timeout: 30000 })).success,
      true,
    );
    assert.equal(claims, host === '127.0.0.1' ? 1 : 0);
    assert.equal(
      harness.backendRequests.find((request) => request.command === 'attach')?.arguments?.timeout,
      30000,
    );
    assert.equal((await harness.request('disconnect')).success, true);
  }
});
