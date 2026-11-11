import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ANDROID_DEBUG_COMMANDS,
  AndroidDebugCapabilityError,
  claimAndroidDebug,
  type LspSessionLike,
  prepareAndroidDebug,
  releaseAndroidDebug,
} from '../src/android/debug-attach.js';
import { parseCliArgs, runCli } from '../src/android/debug-attach-cli.js';
import type { LspSession } from '../src/debug/run-core.js';
import { RpcResponseError } from '../src/shared/runtime-status.js';

const scriptPath = fileURLToPath(new URL('../src/android/debug-attach-cli.js', import.meta.url));
const key = '550e8400-e29b-41d4-a716-446655440000';

function sessionFor(
  request: LspSessionLike['request'],
  commands = Object.values(ANDROID_DEBUG_COMMANDS),
): LspSessionLike {
  return { serverCapabilities: { executeCommandProvider: { commands } }, request };
}

test('unadvertised claim preserves ordinary JVM attach while prepare and cleanup fail explicitly', async () => {
  let requests = 0;
  const session = sessionFor(async () => {
    requests++;
  }, []);
  assert.deepEqual(await claimAndroidDebug(session, { host: '127.0.0.1', port: 1234 }), {
    claimed: false,
  });
  await assert.rejects(prepareAndroidDebug(session, { pid: 123 }), AndroidDebugCapabilityError);
  await assert.rejects(releaseAndroidDebug(session, key), AndroidDebugCapabilityError);
  assert.equal(requests, 0);
});

test('advertised command failures preserve RPC code and target candidates', async () => {
  const failure = new RpcResponseError({
    code: -32803,
    message: 'Multiple processes',
    data: {
      reason: 'ambiguous_process',
      candidates: [
        { pid: 12, processName: 'example:a' },
        { pid: 13, processName: 'example:b' },
      ],
    },
  });
  const session = sessionFor(async () => {
    throw failure;
  });
  for (const request of [
    () => prepareAndroidDebug(session, { packageName: 'example' }),
    () => claimAndroidDebug(session, { host: '127.0.0.1', port: 1234 }),
    () => releaseAndroidDebug(session, key),
  ]) {
    await assert.rejects(request(), (error: unknown) => error === failure);
  }
});

test('malformed claim and prepare responses cannot be interpreted as successful ownership', async () => {
  for (const response of [null, [], {}, { claimed: true }, { claimed: 'false' }]) {
    await assert.rejects(
      claimAndroidDebug(
        sessionFor(async () => response),
        { host: '127.0.0.1', port: 1234 },
      ),
    );
  }
  for (const response of [null, [], {}, { success: true }, { success: false, cleanupKey: key }]) {
    await assert.rejects(
      prepareAndroidDebug(
        sessionFor(async () => response),
        { pid: 123 },
      ),
    );
  }
});

test('CLI timeout units and selector boundaries are preserved', () => {
  const seconds = parseCliArgs(['prepare', '--pid', '123', '--timeout', '0.001']);
  const milliseconds = parseCliArgs(['prepare', '--package', 'example', '--timeout-ms', '300000']);
  assert.equal(seconds.command, 'prepare');
  assert.equal(milliseconds.command, 'prepare');
  if (seconds.command === 'prepare' && milliseconds.command === 'prepare') {
    assert.equal(seconds.timeoutMs, 1);
    assert.equal(seconds.pid, 123);
    assert.equal(milliseconds.timeoutMs, 300000);
    assert.equal(milliseconds.packageName, 'example');
  }
});

test('CLI invalid arguments exit 2 with exactly one JSON result before opening any server', () => {
  const invalid = [
    [],
    ['unknown'],
    ['prepare'],
    ['prepare', '--package'],
    ['prepare', '--package', 'example', '--pid', '1'],
    ['prepare', '--package', 'example', '--package', 'another'],
    ['prepare', '--pid', '123', '--device', 'a', '--device', 'b'],
    ['prepare', '--pid', '0'],
    ['prepare', '--pid', '-5'],
    ['prepare', '--pid', '1.5'],
    ['prepare', '--pid', 'abc'],
    ['prepare', '--pid', '1', '--unknown'],
    ['prepare', '--pid', '1', '--timeout', '10', '--timeout-ms', '10000'],
    ['prepare', '--pid', '1', '--timeout-ms', '0'],
    ['prepare', '--pid', '1', '--timeout-ms', '300001'],
    ['prepare', '--pid', '1', '--timeout-ms', '1.5'],
    ['cleanup'],
    ['cleanup', '--key'],
    ['cleanup', '--key', 'invalid'],
    ['cleanup', '--key', key, '--key', key],
  ];
  for (const args of invalid) {
    const child = spawnSync(process.execPath, [scriptPath, ...args], {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    });
    assert.equal(child.status, 2, JSON.stringify({ args, stderr: child.stderr }));
    const lines = child.stdout.trim().split(/\r?\n/);
    assert.equal(lines.length, 1);
    const result = JSON.parse(lines[0]);
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'INVALID_ARGUMENTS');
  }
});

test('importing the CLI preserves signals and emits no output', () => {
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    // Dynamic import observes listeners before module evaluation.
    await import(${JSON.stringify(pathToFileURL(scriptPath).href)});
    assert.deepEqual([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')], before);
  `,
    ],
    { encoding: 'utf8', timeout: 10000, windowsHide: true },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, '');
});

test('CLI runtime failure preserves RPC details and closes its session', async () => {
  let closed = false;
  let stdout = '';
  const failure = new RpcResponseError({
    code: -32803,
    message: 'Device unavailable',
    data: { reason: 'device_offline' },
  });
  const session: LspSession = {
    ...sessionFor(async () => {
      throw failure;
    }),
    rootUri: 'file:///project',
    nativePath: '/project',
    notify() {},
    isReady: () => true,
    reloadWorkspace: async () => ({ ready: true }),
    close: async () => {
      closed = true;
    },
  };
  const code = await runCli(['prepare', '--pid', '1'], {
    createLspSession: async () => session,
    detectProjectRoot: () => '/project',
    stdout: {
      write(text) {
        stdout += text;
      },
    },
    stderr: { write() {} },
  });
  assert.equal(code, 1);
  assert.equal(closed, true);
  const lines = stdout.trim().split(/\r?\n/);
  assert.equal(lines.length, 1);
  const result = JSON.parse(lines[0]);
  assert.equal(result.error.code, -32803);
  assert.deepEqual(result.error.details, { reason: 'device_offline' });
});

test('CLI reports project detection failures as one JSON error', async () => {
  let output = '';
  const code = await runCli(['prepare', '--pid', '1'], {
    detectProjectRoot() {
      throw new Error('project unavailable');
    },
    stdout: {
      write(text) {
        output += text;
      },
    },
    stderr: { write() {} },
  });
  assert.equal(code, 1);
  const result = JSON.parse(output);
  assert.equal(result.success, false);
  assert.equal(result.error.code, 'COMMAND_FAILED');
});

test('CLI awaits cancellation cleanup and emits one cancellation result', async () => {
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  const request = Promise.withResolvers<unknown>();
  const closing = Promise.withResolvers<void>();
  let closes = 0;
  let output = '';
  const session: LspSession = {
    ...sessionFor(() => {
      entered.resolve();
      return request.promise;
    }),
    rootUri: 'file:///project',
    nativePath: '/project',
    notify() {},
    isReady: () => true,
    reloadWorkspace: async () => ({ ready: true }),
    close() {
      closes++;
      request.reject(new Error('connection cancelled'));
      return closing.promise;
    },
  };
  const running = runCli(['prepare', '--pid', '1'], {
    createLspSession: async () => session,
    detectProjectRoot: () => '/project',
    signal: controller.signal,
    stdout: {
      write(text) {
        output += text;
      },
    },
    stderr: { write() {} },
  });
  await entered.promise;
  controller.abort();
  assert.equal(output, '');
  closing.resolve();
  assert.equal(await running, 143);
  assert.equal(closes, 1);
  const result = JSON.parse(output);
  assert.equal(result.success, false);
  assert.equal(result.error.code, 'CANCELLED');
});

test('CLI cleanup failure cannot emit a successful result', async () => {
  let output = '';
  const session: LspSession = {
    ...sessionFor(async () => ({ success: true, cleaned: true })),
    rootUri: 'file:///project',
    nativePath: '/project',
    notify() {},
    isReady: () => true,
    reloadWorkspace: async () => ({ ready: true }),
    close: async () => {
      throw new Error('cleanup failed');
    },
  };
  const code = await runCli(['cleanup', '--key', key], {
    createLspSession: async () => session,
    detectProjectRoot: () => '/project',
    stdout: {
      write(text) {
        output += text;
      },
    },
    stderr: { write() {} },
  });
  assert.equal(code, 1);
  const result = JSON.parse(output);
  assert.equal(result.success, false);
  assert.equal(result.error.code, 'COMMAND_FAILED');
});

test('malformed release responses cannot report resource cleanup', async () => {
  for (const response of [
    null,
    [],
    {},
    { success: false, cleaned: true },
    { success: true },
    { success: true, cleaned: false },
  ]) {
    await assert.rejects(
      releaseAndroidDebug(
        sessionFor(async () => response),
        key,
      ),
    );
  }
});

test('CLI parameter validation: rejects invalid args, selector conflicts, and bad UUIDs with code 2', () => {
  const cliScript = scriptPath;
  const testPackage = 'com.example.ompattachfixture';

  // Missing subcommand
  const noArgs = spawnSync(process.execPath, [cliScript], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });
  assert.equal(noArgs.status, 2);
  const parsedNoArgs = JSON.parse(noArgs.stdout.trim());
  assert.equal(parsedNoArgs.success, false);
  assert.equal(parsedNoArgs.error.code, 'INVALID_ARGUMENTS');

  // Both package and pid specified
  const bothSelectors = spawnSync(
    process.execPath,
    [cliScript, 'prepare', '--package', testPackage, '--pid', '1234'],
    { encoding: 'utf8', timeout: 5000, windowsHide: true },
  );
  assert.equal(bothSelectors.status, 2);
  const parsedBoth = JSON.parse(bothSelectors.stdout.trim());
  assert.equal(parsedBoth.success, false);
  assert.equal(parsedBoth.error.code, 'INVALID_ARGUMENTS');

  // Missing package value
  const missingPkg = spawnSync(process.execPath, [cliScript, 'prepare', '--package'], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });
  assert.equal(missingPkg.status, 2);
  const parsedMissingPkg = JSON.parse(missingPkg.stdout.trim());
  assert.equal(parsedMissingPkg.success, false);
  assert.equal(parsedMissingPkg.error.code, 'INVALID_ARGUMENTS');

  // Both timeout and timeout-ms
  const bothTimeouts = spawnSync(
    process.execPath,
    [cliScript, 'prepare', '--package', testPackage, '--timeout', '10', '--timeout-ms', '10000'],
    { encoding: 'utf8', timeout: 5000, windowsHide: true },
  );
  assert.equal(bothTimeouts.status, 2);
  const parsedTimeouts = JSON.parse(bothTimeouts.stdout.trim());
  assert.equal(parsedTimeouts.success, false);
  assert.equal(parsedTimeouts.error.code, 'INVALID_ARGUMENTS');

  // Unknown flag
  const unknownFlag = spawnSync(
    process.execPath,
    [cliScript, 'prepare', '--package', testPackage, '--bogus'],
    { encoding: 'utf8', timeout: 5000, windowsHide: true },
  );
  assert.equal(unknownFlag.status, 2);
  const parsedUnknown = JSON.parse(unknownFlag.stdout.trim());
  assert.equal(parsedUnknown.success, false);
  assert.equal(parsedUnknown.error.code, 'INVALID_ARGUMENTS');

  // Cleanup with invalid UUID
  const badUuid = spawnSync(process.execPath, [cliScript, 'cleanup', '--key', 'not-a-valid-uuid'], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });
  assert.equal(badUuid.status, 2);
  const parsedBadUuid = JSON.parse(badUuid.stdout.trim());
  assert.equal(parsedBadUuid.success, false);
  assert.equal(parsedBadUuid.error.code, 'INVALID_ARGUMENTS');
});
