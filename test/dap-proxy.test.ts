import assert from 'node:assert/strict';
import { type ChildProcess, type SpawnSyncReturns, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  type DebugSnapshot,
  isLoopbackHost,
  listDebugSessions,
  recoverDebugSession,
} from '../src/debug/control.js';
import {
  type DapResponseMessage,
  isDirectExecution,
  normalizeAttachHost,
  normalizeSourcePaths,
  resolveSourceFile,
} from '../src/debug/dap-proxy.js';
import { encode, frameParser } from '../src/shared/protocol.js';
import { createDapTestHarness, type DapRequest, type DapTestHarness } from './dap-fixture.js';

function breakpointResults(response: { body?: unknown }): Record<string, unknown>[] {
  const body = response.body;
  assert.ok(body && typeof body === 'object' && 'breakpoints' in body);
  assert.ok(Array.isArray(body.breakpoints));
  for (const breakpoint of body.breakpoints) {
    assert.ok(breakpoint && typeof breakpoint === 'object' && !Array.isArray(breakpoint));
  }
  return body.breakpoints as Record<string, unknown>[];
}

function getProxyScriptPath(): string {
  const compiledPath = fileURLToPath(new URL('../src/debug/dap-proxy.js', import.meta.url));
  const sourcePath = fileURLToPath(new URL('../../src/debug/dap-proxy.ts', import.meta.url));
  return existsSync(compiledPath) ? compiledPath : sourcePath;
}

test('importing dap-proxy preserves stdin and signal listeners and exits cleanly', () => {
  const moduleUrl = new URL('../src/debug/dap-proxy.js', import.meta.url).href;
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    const counts = () => [process.stdin.listenerCount('data'), process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    const before = counts();
    await import(${JSON.stringify(moduleUrl)});
    assert.deepEqual(counts(), before);
  `,
    ],
    { encoding: 'utf8', timeout: 5000, windowsHide: true },
  );
  assert.equal(child.status, 0, child.stderr);
});

test('normalizeSourcePaths converts file URIs across structures', () => {
  const fileUri = 'file:///C:/workspace/App.java';
  const encodedUri = 'file:///c%3A/workspace/App.java';

  const flat = { path: fileUri };
  normalizeSourcePaths(flat);
  assert.ok(!flat.path.startsWith('file://'));
  assert.match(flat.path, /App\.java$/);

  const encoded = { path: encodedUri };
  normalizeSourcePaths(encoded);
  assert.ok(!encoded.path.startsWith('file://'));
  assert.match(encoded.path, /App\.java$/);

  const nestedSource = {
    source: {
      path: fileUri,
    },
  };
  normalizeSourcePaths(nestedSource);
  assert.ok(!nestedSource.source.path.startsWith('file://'));
  assert.match(nestedSource.source.path, /App\.java$/);

  const nestedSources = {
    sources: [{ path: fileUri }, { path: encodedUri }, { path: '/regular/path/Main.java' }],
  };
  normalizeSourcePaths(nestedSources);
  assert.ok(!nestedSources.sources[0].path.startsWith('file://'));
  assert.ok(!nestedSources.sources[1].path.startsWith('file://'));
  assert.equal(nestedSources.sources[2].path, '/regular/path/Main.java');

  assert.equal(normalizeSourcePaths(null), null);
  assert.equal(normalizeSourcePaths(undefined), undefined);
  assert.equal(normalizeSourcePaths(42), 42);
  assert.equal(normalizeSourcePaths('plain string'), 'plain string');
});

test('resolveSourceFile resolves existing paths and candidate extensions', () => {
  assert.equal(resolveSourceFile(process.cwd(), undefined), null);
  assert.equal(resolveSourceFile(process.cwd(), ''), null);

  const pkgPath = resolveSourceFile(process.cwd(), 'package.json');
  assert.ok(pkgPath);
  assert.ok(existsSync(pkgPath));

  const candidate = resolveSourceFile(process.cwd(), 'com.example.NonExistentClass');
  assert.ok(candidate);
});

for (const mode of ['module', 'explicit', 'project'] as const) {
  test(`launch resolves relative resources from ${mode} working directory`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'omp-launch-cwd-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const moduleDir = join(root, 'module');
    const explicitDir = join(root, 'override');
    await mkdir(moduleDir);
    await mkdir(explicitDir);
    await writeFile(join(root, 'pom.xml'), '<project/>');
    const program = join(root, 'Main.java');
    await writeFile(program, 'class Main { public static void main(String[] args) {} }');
    for (const [dir, value] of [
      [root, 'project-resource'],
      [moduleDir, 'module-resource'],
      [explicitDir, 'explicit-resource'],
    ]) {
      await writeFile(join(dir, 'launch-resource.txt'), value);
    }
    let resource: string | undefined;
    let launched: SpawnSyncReturns<string> | undefined;
    const harness = await createDapTestHarness(t, {
      fakeJavaExec: process.execPath,
      onLspRequest(method, params) {
        if (
          method === 'workspace/executeCommand' &&
          params &&
          typeof params === 'object' &&
          'command' in params &&
          params.command === 'omp.jvm.resolveLaunch'
        ) {
          return {
            javaExec: process.execPath,
            classpath: [],
            ...(mode === 'project' ? {} : { workingDirectory: moduleDir }),
          };
        }
        return undefined;
      },
      onDapRequest(request) {
        if (request.command !== 'launch') return;
        launched = spawnSync(
          process.execPath,
          ['-e', "process.stdout.write(require('node:fs').readFileSync('launch-resource.txt'))"],
          { cwd: String(request.arguments?.cwd), encoding: 'utf8', windowsHide: true },
        );
        resource = String(launched.stdout);
        return undefined;
      },
    });
    await harness.request('initialize');
    const result = await harness.request('launch', {
      program,
      build: false,
      stopOnEntry: false,
      ...(mode === 'explicit' ? { cwd: explicitDir } : {}),
    });
    assert.equal(result.success, true, result.message);
    assert.equal(launched?.status, 0, String(launched?.stderr));
    assert.equal(resource, `${mode}-resource`);
  });
}

test('isDirectExecution distinguishes direct CLI execution vs imported module', () => {
  const currentFile = fileURLToPath(import.meta.url);
  assert.equal(isDirectExecution(currentFile, import.meta.url), true);
  assert.equal(isDirectExecution('', import.meta.url), false);
  assert.equal(isDirectExecution('/some/other/script.js', import.meta.url), false);
});

interface SpawnedProxy {
  child: ChildProcess;
  messages: DapResponseMessage[];
  waitForMessage: (predicate: (msg: DapResponseMessage) => boolean) => Promise<DapResponseMessage>;
  closed: Promise<unknown[]>;
}

function spawnProxy(t: TestContext): SpawnedProxy {
  const scriptPath = getProxyScriptPath();
  const child = spawn(process.execPath, [scriptPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const closed = once(child, 'close');
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
    }
    await closed;
  });

  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });

  const messages: DapResponseMessage[] = [];
  const listeners = new Set<(msg: DapResponseMessage) => void>();

  child.stdout?.on(
    'data',
    frameParser((raw: unknown) => {
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const msg = raw as unknown as DapResponseMessage;
        messages.push(msg);
        for (const listener of listeners) {
          listener(msg);
        }
      }
    }),
  );

  function waitForMessage(
    predicate: (msg: DapResponseMessage) => boolean,
  ): Promise<DapResponseMessage> {
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);

    const { promise, resolve, reject } = Promise.withResolvers<DapResponseMessage>();

    function onMsg(msg: DapResponseMessage) {
      if (predicate(msg)) {
        cleanup();
        resolve(msg);
      }
    }

    function onClose(code: number | null) {
      cleanup();
      reject(
        new Error(`Proxy process closed (exit code ${code}) before expected message: ${stderr}`),
      );
    }

    function cleanup() {
      listeners.delete(onMsg);
      child.off('close', onClose);
    }

    listeners.add(onMsg);
    child.once('close', onClose);
    promise.catch(() => {});
    return promise;
  }

  return { child, messages, waitForMessage, closed };
}

test('dap-proxy subprocess handles initialize over stdio and exits on stdin close', async (t) => {
  const proxy = spawnProxy(t);

  const initReq = encode({
    seq: 1,
    type: 'request',
    command: 'initialize',
    arguments: {
      clientID: 'omp-test',
      adapterID: 'intellij_jvm',
      linesStartAt1: true,
      columnsStartAt1: true,
    },
  });

  proxy.child.stdin?.write(initReq);

  const resp = await proxy.waitForMessage(
    (m) => m.type === 'response' && m.command === 'initialize',
  );

  assert.equal(resp.seq, 1);
  assert.equal(resp.request_seq, 1);
  assert.equal(resp.command, 'initialize');
  assert.equal(resp.success, true);

  proxy.child.stdin?.end();
  const [exitCode] = await proxy.closed;
  assert.equal(exitCode, 0);
});

test('dap-proxy subprocess buffers breakpoints and configurationDone before launch', async (t) => {
  const proxy = spawnProxy(t);

  proxy.child.stdin?.write(
    encode({
      seq: 1,
      type: 'request',
      command: 'initialize',
      arguments: {},
    }),
  );
  await proxy.waitForMessage((m) => m.type === 'response' && m.command === 'initialize');

  proxy.child.stdin?.write(
    encode({
      seq: 2,
      type: 'request',
      command: 'setBreakpoints',
      arguments: {
        source: { path: 'C:/project/src/Main.java' },
        breakpoints: [{ line: 15 }, { line: 25 }],
      },
    }),
  );

  const bpResp = await proxy.waitForMessage(
    (m) => m.type === 'response' && m.command === 'setBreakpoints',
  );
  assert.equal(bpResp.seq, 2);
  assert.equal(bpResp.request_seq, 2);
  assert.equal(bpResp.success, true);

  const bpBody =
    bpResp.body && typeof bpResp.body === 'object' && !Array.isArray(bpResp.body)
      ? (bpResp.body as Record<string, unknown>)
      : {};
  assert.ok(Array.isArray(bpBody.breakpoints));
  assert.equal(bpBody.breakpoints.length, 2);
  const firstBpRaw = bpBody.breakpoints[0];
  assert.ok(firstBpRaw && typeof firstBpRaw === 'object');
  const firstBp = firstBpRaw as Record<string, unknown>;
  assert.equal(firstBp.verified, false);
  assert.equal(firstBp.line, 15);
  assert.match(
    typeof firstBp.message === 'string' ? firstBp.message : '',
    /Pending native debug server initialization/,
  );

  proxy.child.stdin?.write(
    encode({
      seq: 3,
      type: 'request',
      command: 'setExceptionBreakpoints',
      arguments: { filters: ['uncaught'] },
    }),
  );
  const exResp = await proxy.waitForMessage(
    (m) => m.type === 'response' && m.command === 'setExceptionBreakpoints',
  );
  assert.equal(exResp.success, true);

  proxy.child.stdin?.write(
    encode({
      seq: 4,
      type: 'request',
      command: 'configurationDone',
      arguments: {},
    }),
  );
  const configResp = await proxy.waitForMessage(
    (m) => m.type === 'response' && m.command === 'configurationDone',
  );
  assert.equal(configResp.success, true);

  proxy.child.stdin?.end();
  const [exitCode] = await proxy.closed;
  assert.equal(exitCode, 0);
});

test('dap-proxy returns error for launch request missing program or file', async (t) => {
  const proxy = spawnProxy(t);

  proxy.child.stdin?.write(
    encode({
      seq: 1,
      type: 'request',
      command: 'initialize',
      arguments: {},
    }),
  );
  await proxy.waitForMessage((m) => m.type === 'response' && m.command === 'initialize');

  proxy.child.stdin?.write(
    encode({
      seq: 2,
      type: 'request',
      command: 'launch',
      arguments: {},
    }),
  );

  const launchResp = await proxy.waitForMessage(
    (m) => m.type === 'response' && m.command === 'launch',
  );
  assert.equal(launchResp.seq, 2);
  assert.equal(launchResp.request_seq, 2);
  assert.equal(launchResp.success, false);
  assert.match(launchResp.message || '', /DAP launch requires program or file parameter/);

  proxy.child.stdin?.end();
  const [exitCode] = await proxy.closed;
  assert.equal(exitCode, 0);
});

test('dap-proxy rejects requests when native debug server is not active', async (t) => {
  const proxy = spawnProxy(t);

  proxy.child.stdin?.write(
    encode({
      seq: 1,
      type: 'request',
      command: 'threads',
      arguments: {},
    }),
  );

  const threadsResp = await proxy.waitForMessage(
    (m) => m.type === 'response' && m.command === 'threads',
  );
  assert.equal(threadsResp.success, false);
  assert.match(threadsResp.message || '', /Debug session not active/);

  proxy.child.stdin?.end();
  const [exitCode] = await proxy.closed;
  assert.equal(exitCode, 0);
});

test('dap-proxy CLI --run requires a file and exits with code 1', async (t) => {
  const scriptPath = getProxyScriptPath();
  const child = spawn(process.execPath, [scriptPath, '--run'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const closed = once(child, 'close');
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
    }
    await closed;
  });

  const [exitCode] = await closed;
  assert.equal(exitCode, 1);
});

const javaTestProgram = fileURLToPath(
  new URL(
    '../../test-fixtures/jvm-hybrid-app/src/test/java/com/example/JavaGreeterTest.java',
    import.meta.url,
  ),
);

function testLaunchArguments(): Record<string, unknown> {
  return { program: javaTestProgram, testMode: true, build: false, stopOnEntry: true };
}

test('attach rejects invalid ports and PID-only targets before opening a backend', async (t) => {
  const h = await createDapTestHarness(t);
  for (const args of [{}, { pid: 123 }, { port: 0 }, { port: 65536 }, { port: 1.5 }]) {
    const result = await h.request('attach', args);
    assert.equal(result.success, false);
    assert.match(result.message ?? '', /JDWP port/);
  }
  assert.equal(h.lspRequests.length, 0);
  assert.equal(h.backendRequests.length, 0);
});

test('launch rejects malformed and conflicting preset arguments before opening a backend', async (t) => {
  const h = await createDapTestHarness(t);
  const cases: Array<{ args: Record<string, unknown>; error: RegExp }> = [
    { args: { testMode: 'true' }, error: /testMode must be a boolean/ },
    { args: { build: 0 }, error: /build must be a boolean/ },
    { args: { stopOnEntry: 'false' }, error: /stopOnEntry must be a boolean/ },
    { args: { noDebug: null }, error: /noDebug must be a boolean/ },
    { args: { args: ['valid', 1] }, error: /args must be an array of strings/ },
    { args: { vmArgs: '-Xmx1g' }, error: /vmArgs must be an array of strings/ },
    { args: { buildTool: 'maven' }, error: /buildTool must be "gradle" or omitted/ },
    {
      args: { buildTool: 'gradle', testMode: true },
      error: /Gradle launch expects a main class, not a test target/,
    },
    { args: { gradleArgs: [] }, error: /gradleArgs requires buildTool: "gradle"/ },
    { args: { projectPath: ':app' }, error: /projectPath requires buildTool: "gradle"/ },
    { args: { sourceSet: 'main' }, error: /sourceSet requires buildTool: "gradle"/ },
    {
      args: { buildTool: 'gradle', gradleArgs: [false] },
      error: /gradleArgs must be an array of strings/,
    },
    {
      args: { buildTool: 'gradle', projectPath: '' },
      error: /projectPath must be a non-empty string/,
    },
    {
      args: { buildTool: 'gradle', sourceSet: 1 },
      error: /sourceSet must be a non-empty string/,
    },
  ];
  for (const { args, error } of cases) {
    const result = await h.request('launch', { program: javaTestProgram, ...args });
    assert.equal(result.success, false);
    assert.match(result.message ?? '', error);
  }
  assert.equal(h.lspRequests.length, 0);
  assert.equal(h.backendRequests.length, 0);
});

for (const ending of ['disconnect', 'terminate', 'eof', 'backend-close'] as const) {
  test(`attach ${ending} releases the debugger without terminating its external JVM`, async (t) => {
    let externalTargetAlive = true;
    const h = await createDapTestHarness(t, {
      onDapRequest(request) {
        if (request.command === 'terminate' || request.arguments?.terminateDebuggee === true) {
          externalTargetAlive = false;
        }
      },
    });
    const result = await h.request('attach', { host: 'localhost', port: 5005 });
    assert.equal(result.success, true);
    if (ending === 'eof') h.stdin.end();
    else if (ending === 'backend-close') h.closeBackend();
    else await h.request(ending, { terminateDebuggee: true });
    await h.closed;
    assert.equal(externalTargetAlive, true);
    assert.equal(
      h.backendRequests.some((r) => r.command === 'terminate'),
      false,
    );
    const detach = h.backendRequests.find((r) => r.command === 'disconnect');
    if (ending !== 'backend-close') {
      assert.equal(detach?.arguments?.terminateDebuggee, false);
      assert.equal(detach?.arguments?.suspendDebuggee, false);
    }
    assert.equal(
      h.messages.filter((m) => m.type === 'event' && m.event === 'terminated').length,
      1,
    );
  });
}

test('EOF during backend initialize fails the pending attach exactly once', async (t) => {
  const initializing = Promise.withResolvers<void>();
  const h = await createDapTestHarness(t, {
    onDapRequest(request) {
      if (request.command === 'initialize') {
        initializing.resolve();
        return true;
      }
    },
  });
  const seq = h.send('attach', { port: 5005 });
  await initializing.promise;
  h.stdin.end();
  await h.closed;
  const responses = h.messages.filter((m) => m.type === 'response' && m.request_seq === seq);
  assert.equal(responses.length, 1);
  assert.equal(responses[0]?.type === 'response' && responses[0].success, false);
  assert.equal(
    h.backendRequests.some((r) => r.command === 'attach' || r.command === 'terminate'),
    false,
  );
});

test('unresponsive backend initialize reaches its deadline and rejects startup once', async (t) => {
  const initializing = Promise.withResolvers<void>();
  const h = await createDapTestHarness(t, {
    onDapRequest(request) {
      if (request.command === 'initialize') {
        initializing.resolve();
        return true;
      }
    },
  });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const seq = h.send('attach', { port: 5005 });
  await initializing.promise;
  t.mock.timers.tick(14999);
  assert.equal(
    h.messages.some((m) => m.type === 'response' && m.request_seq === seq),
    false,
  );
  t.mock.timers.tick(1);
  assert.equal(await h.closed, 1);
  const responses = h.messages.filter((m) => m.type === 'response' && m.request_seq === seq);
  assert.equal(responses.length, 1);
  assert.equal(responses[0]?.type === 'response' && responses[0].success, false);
  assert.equal(
    h.backendRequests.some((request) => request.command === 'attach'),
    false,
  );
});

test('a second startup is rejected while the first backend is initializing', async (t) => {
  const initializing = Promise.withResolvers<void>();
  const h = await createDapTestHarness(t, {
    onDapRequest(request) {
      if (request.command === 'initialize') {
        initializing.resolve();
        return true;
      }
    },
  });
  const first = h.request('attach', { port: 5005 });
  await initializing.promise;
  const second = await h.request('launch', testLaunchArguments());
  assert.equal(second.success, false);
  assert.match(second.message ?? '', /already starting or active/);
  h.stdin.end();
  assert.equal((await first).success, false);
  await h.closed;
  assert.equal(h.backendRequests.filter((r) => r.command === 'initialize').length, 1);
});

for (const failure of ['refused', 'timeout', 'eof'] as const) {
  test(`backend attach ${failure} produces one failed startup and no owned-process cleanup`, async (t) => {
    let h: DapTestHarness;
    h = await createDapTestHarness(t, {
      onDapRequest(request) {
        if (request.command !== 'attach') return;
        if (failure === 'eof') h.closeBackend();
        else
          h.respond(
            request,
            undefined,
            false,
            failure === 'timeout' ? 'JDWP connection timed out' : 'JDWP connection refused',
          );
        return true;
      },
    });
    const result = await h.request('attach', { port: 5005 });
    assert.equal(result.success, false);
    assert.match(result.message ?? '', /closed|timed out|refused/);
    await h.closed;
    assert.equal(
      h.messages.filter((m) => m.type === 'response' && m.command === 'attach').length,
      1,
    );
    assert.equal(
      h.backendRequests.some((r) => r.command === 'terminate'),
      false,
    );
  });
}

test('early configuration is sent after startup and attach uses the JDWP host instead of the backend endpoint', async (t) => {
  const h = await createDapTestHarness(t);
  await h.request('configurationDone');
  await h.request('attach', { host: 'remote.example', port: 5005, timeout: 50 });
  await h.request('threads');
  const attach = h.backendRequests.find((r) => r.command === 'attach');
  assert.equal(attach?.arguments?.hostName, 'remote.example');
  assert.equal(attach?.arguments?.port, 5005);
  assert.equal(attach?.arguments?.host, undefined);
  const commands = h.backendRequests.map((r) => r.command);
  assert(commands.indexOf('configurationDone') > commands.indexOf('attach'));
  assert.equal(commands.filter((c) => c === 'configurationDone').length, 1);
});
test('attach timeout normalizes seconds to milliseconds while preserving millisecond values', async (t) => {
  const h = await createDapTestHarness(t);
  await h.request('configurationDone');
  await h.request('attach', { host: 'remote.example', port: 5005, timeout: 60 });
  const attach = h.backendRequests.find((r) => r.command === 'attach');
  assert.equal(attach?.arguments?.timeout, 60000);
});

test('concurrent backend responses preserve each client request and its failure', async (t) => {
  const pending: DapRequest[] = [];
  const received = Promise.withResolvers<void>();
  let active = false;
  const h = await createDapTestHarness(t, {
    onDapRequest(request) {
      if (active && (request.command === 'threads' || request.command === 'scopes')) {
        pending.push(request);
        if (pending.length === 2) received.resolve();
        return true;
      }
    },
  });
  await h.request('attach', { port: 5005 });
  active = true;
  const threads = h.request('threads');
  const scopes = h.request('scopes', { frameId: 1 });
  await received.promise;
  h.respond(pending[1], { scopes: [{ name: 'locals' }] });
  h.respond(pending[0], undefined, false, 'Thread no longer exists');
  assert.equal((await scopes).command, 'scopes');
  const failed = await threads;
  assert.equal(failed.command, 'threads');
  assert.equal(failed.success, false);
  assert.match(failed.message ?? '', /Thread no longer exists/);
});

test('evaluate sentinel text is normalized to DAP failure response', async (t) => {
  const h = await createDapTestHarness(t, {
    onDapRequest(request) {
      if (request.command === 'evaluate') {
        h.respond(request, { result: 'No active suspend context' });
        return true;
      }
    },
  });
  await h.request('attach', { port: 5005 });
  const evalRes = await h.request('evaluate', { expression: 'foo' });
  assert.equal(evalRes.success, false);
  assert.equal(evalRes.message, 'No active suspend context');
});

test('test entry breakpoint is removed on first stop and a failed test is never reported as passed', async (t) => {
  const h = await createDapTestHarness(t);
  assert.equal((await h.request('launch', testLaunchArguments())).success, true);
  const entry = h.backendRequests.find((r) => r.command === 'setFunctionBreakpoints');
  assert.deepEqual(entry?.arguments?.breakpoints, [
    { name: 'com.intellij.rt.junit.JUnitStarter.main' },
  ]);
  h.emit('stopped', { reason: 'breakpoint', threadId: 1 });
  await h.waitFor((m) => m.type === 'event' && m.event === 'stopped');
  await h.request('threads');
  const functions = h.backendRequests.filter((r) => r.command === 'setFunctionBreakpoints');
  assert.deepEqual(functions.at(-1)?.arguments?.breakpoints, []);
  h.emit('exited', { exitCode: 7 });
  const result = await h.waitFor(
    (m) =>
      m.type === 'event' && m.event === 'output' && JSON.stringify(m.body).includes('tests exited'),
  );
  assert.match(JSON.stringify(result.body), /code 7/);
  h.emit('terminated');
  await h.closed;
  assert.equal(h.messages.filter((m) => m.type === 'event' && m.event === 'terminated').length, 1);
});

test('user function breakpoints replace the test entry breakpoint and survive the first stop', async (t) => {
  const h = await createDapTestHarness(t);
  await h.request('launch', testLaunchArguments());
  const userBreakpoints = [{ name: 'com.example.JavaGreeter.greet' }];
  await h.request('setFunctionBreakpoints', { breakpoints: userBreakpoints });
  h.emit('stopped', { reason: 'breakpoint', threadId: 1 });
  await h.waitFor((m) => m.type === 'event' && m.event === 'stopped');
  await h.request('threads');
  const functions = h.backendRequests.filter((r) => r.command === 'setFunctionBreakpoints');
  assert.deepEqual(functions.at(-1)?.arguments?.breakpoints, userBreakpoints);
});

for (const unsupported of ['capability', 'request'] as const) {
  test(`test startup fails before launching when its entry pause ${unsupported} is unavailable`, async (t) => {
    let h: DapTestHarness;
    h = await createDapTestHarness(t, {
      capabilities: { supportsFunctionBreakpoints: unsupported !== 'capability' },
      onDapRequest(request) {
        if (unsupported === 'request' && request.command === 'setFunctionBreakpoints') {
          h.respond(request, undefined, false, 'Function breakpoints unavailable');
          return true;
        }
      },
    });
    const result = await h.request('launch', testLaunchArguments());
    assert.equal(result.success, false);
    assert.match(result.message ?? '', /Unable to pause test runner/);
    await h.closed;
    assert.equal(
      h.backendRequests.some((r) => r.command === 'launch'),
      false,
    );
  });
}

test('failed test compilation blocks launching stale classes', async (t) => {
  const h = await createDapTestHarness(t, {
    onLspRequest(_method, params) {
      if (
        params &&
        typeof params === 'object' &&
        'command' in params &&
        params.command === 'omp.jvm.resolveBuildCommand'
      ) {
        return {
          supported: true,
          command: [process.execPath, '-e', 'process.exit(17)'],
          cwd: process.cwd(),
          tool: 'node',
        };
      }
    },
  });
  const result = await h.request('launch', { ...testLaunchArguments(), build: true });
  assert.equal(result.success, false);
  assert.match(result.message ?? '', /Build failed with exit code 17/);
  await h.closed;
  assert.equal(
    h.backendRequests.some((r) => r.command === 'launch'),
    false,
  );
});

for (const spoofedOutput of [false, true]) {
  test(`attach acknowledgement and stdout=${spoofedOutput} cannot mask a failed JDWP connection`, async (t) => {
    let h: DapTestHarness;
    h = await createDapTestHarness(t, {
      onDapRequest(request) {
        if (request.command !== 'attach') return;
        h.respond(request);
        if (spoofedOutput) {
          h.emit('output', { category: 'stdout', output: 'Connected to the target VM, fake\n' });
        }
        h.emit('terminated');
        return true;
      },
    });
    const reply = await h.request('attach', { port: 5005 });
    assert.equal(reply.success, false);
    assert.match(reply.message ?? '', /JDWP connection/);
    await h.closed;
    assert.equal(
      h.messages.filter((m) => m.type === 'response' && m.command === 'attach').length,
      1,
    );
    assert.equal(
      h.backendRequests.some((r) => r.command === 'terminate'),
      false,
    );
  });
}

test('disconnect is acknowledged only after the backend has released the JDWP connection', async (t) => {
  const detaching = Promise.withResolvers<DapRequest>();
  const h = await createDapTestHarness(t, {
    onDapRequest(request) {
      if (request.command === 'disconnect') {
        detaching.resolve(request);
        return true;
      }
    },
  });
  await h.request('attach', { port: 5005 });
  const seq = h.send('disconnect');
  const backendRequest = await detaching.promise;
  assert.equal(
    h.messages.some((m) => m.type === 'response' && m.request_seq === seq),
    false,
  );
  h.respond(backendRequest);
  const response = await h.waitFor((m) => m.type === 'response' && m.request_seq === seq);
  assert.equal(response.type === 'response' && response.success, true);
  await h.closed;
});

test('attach confirms a running JVM without English output or a suspended thread context', async (t) => {
  let h: DapTestHarness;
  let queries = 0;
  h = await createDapTestHarness(t, {
    onDapRequest(request) {
      if (request.command === 'attach') {
        h.respond(request);
        return true;
      }
      if (request.command === 'threads') {
        h.respond(request, { threads: [{ id: 0, name: 'dummy thread' }] });
        return true;
      }
      if (request.command === 'intellij/threadDump') {
        queries++;
        h.respond(request, {
          text:
            queries < 3
              ? ''
              : '"main" RUNNABLE\n at com.example.AttachTarget.main(AttachTarget.java:7)',
        });
        return true;
      }
    },
  });
  const reply = await h.request('attach', { port: 5005, timeout: 1000 }, 1500);
  assert.equal(reply.success, true);
  assert.equal(queries, 3);
  await h.request('disconnect');
  await h.closed;
});

test('backend termination reaches the client only after JDWP cleanup', async (t) => {
  const disconnecting = Promise.withResolvers<DapRequest>();
  const h = await createDapTestHarness(t, {
    onDapRequest(request) {
      if (request.command === 'disconnect') {
        disconnecting.resolve(request);
        return true;
      }
    },
  });
  await h.request('attach', { port: 5005 });
  h.emit('terminated');
  const request = await disconnecting.promise;
  assert.equal(
    h.messages.some((m) => m.type === 'event' && m.event === 'terminated'),
    false,
  );
  h.respond(request);
  await h.closed;
  assert.equal(h.messages.filter((m) => m.type === 'event' && m.event === 'terminated').length, 1);
});

test('unresponsive detach uses the cleanup deadline and never terminates an external JVM', async (t) => {
  const disconnecting = Promise.withResolvers<void>();
  const h = await createDapTestHarness(t, {
    onDapRequest(request) {
      if (request.command === 'disconnect') {
        disconnecting.resolve();
        return true;
      }
    },
  });
  await h.request('attach', { port: 5005 });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  let closed = false;
  void h.closed.then(() => {
    closed = true;
  });
  h.stdin.end();
  await disconnecting.promise;
  t.mock.timers.tick(14999);
  await Promise.resolve();
  assert.equal(closed, false);
  t.mock.timers.tick(1);
  assert.equal(await h.closed, 1);
  assert.equal(
    h.backendRequests.some((request) => request.command === 'terminate'),
    false,
  );
  assert.equal(
    h.backendRequests.find((request) => request.command === 'disconnect')?.arguments
      ?.terminateDebuggee,
    false,
  );
});

for (const cleanupFails of [false, true]) {
  test(`out-of-band attach recovery reports cleanup failure=${cleanupFails} without terminating the JVM`, async (t) => {
    let h: DapTestHarness;
    h = await createDapTestHarness(t, {
      onDapRequest(request) {
        if (request.command === 'disconnect' && cleanupFails) {
          h.respond(request, undefined, false, 'JDI detach failed');
          return true;
        }
      },
    });
    await h.request('attach', { port: 5005 });
    const status = await h.request('omp/intellij/status');
    const snapshot = status.body as DebugSnapshot;
    assert.equal(snapshot.phase, 'running');
    const options = { systemPath: h.systemPath, projectRoot: snapshot.projectRoot };
    const sessions = await listDebugSessions(options);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].live, true);
    if (cleanupFails) {
      await assert.rejects(recoverDebugSession(options), /JDI detach failed/);
    } else {
      const recovered = await recoverDebugSession(options);
      assert.equal(recovered.phase, 'closed');
      assert.equal(recovered.pendingRequests, 0);
    }
    assert.equal(await h.closed, cleanupFails ? 1 : 0);
    assert.equal(
      h.backendRequests.some((r) => r.command === 'terminate'),
      false,
    );
    const disconnect = h.backendRequests.find((r) => r.command === 'disconnect');
    assert.equal(disconnect?.arguments?.terminateDebuggee, false);
    const remaining = await listDebugSessions(options);
    if (cleanupFails) {
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0].live, false);
      assert.equal(remaining[0].snapshot?.phase, 'failed');
      assert.match(remaining[0].snapshot?.cleanupError ?? '', /JDI detach failed/);
    } else {
      assert.deepEqual(remaining, []);
    }
  });
}

for (const reset of [false, true]) {
  test(`launch recovery distinguishes normal transport teardown from reset=${reset}`, async (t) => {
    let h: DapTestHarness;
    h = await createDapTestHarness(t, {
      onDapRequest(request) {
        if (request.command !== 'terminate') return;
        h.closeBackend(reset);
        return true;
      },
    });
    await h.request('launch', testLaunchArguments());
    const status = await h.request('omp/intellij/status');
    const projectRoot = (status.body as DebugSnapshot).projectRoot;
    const options = { systemPath: h.systemPath, projectRoot };
    if (reset) {
      await assert.rejects(recoverDebugSession(options), /cleanup failed/);
      assert.equal(await h.closed, 1);
      const remaining = await listDebugSessions(options);
      assert.equal(remaining[0]?.snapshot?.phase, 'failed');
    } else {
      const recovered = await recoverDebugSession(options);
      assert.equal(recovered.phase, 'closed');
      assert.equal(recovered.pendingRequests, 0);
      assert.equal(await h.closed, 0);
      assert.deepEqual(await listDebugSessions(options), []);
    }
  });
}

test('a disconnect acknowledgement cannot complete recovery before transport teardown', async (t) => {
  const acknowledged = Promise.withResolvers<void>();
  let h: DapTestHarness;
  h = await createDapTestHarness(t, {
    keepBackendAfterDisconnect: true,
    onDapRequest(request) {
      if (request.command !== 'disconnect') return;
      h.respond(request);
      acknowledged.resolve();
      return true;
    },
  });
  await h.request('attach', { port: 5005 });
  const closingSeq = h.send('disconnect');
  await acknowledged.promise;
  const status = await h.request('omp/intellij/status');
  assert.equal((status.body as DebugSnapshot).phase, 'cleaning');
  assert.equal(
    h.messages.some((m) => m.type === 'response' && m.request_seq === closingSeq),
    false,
  );
  h.closeBackend();
  const reply = await h.waitFor((m) => m.type === 'response' && m.request_seq === closingSeq);
  assert.equal(reply.type === 'response' && reply.success, true);
  assert.equal(await h.closed, 0);
});

test('capability probe: attach fails fast before sending native attach when supportsThreadDumpRequest is missing', async (t) => {
  const h = await createDapTestHarness(t, {
    capabilities: { supportsThreadDumpRequest: false },
  });
  const reply = await h.request('attach', { port: 5005 });
  assert.equal(reply.success, false);
  assert.match(
    reply.message ?? '',
    /IntelliJ backend does not support threadDump readiness checks/,
  );
  await h.closed;
  assert.equal(
    h.backendRequests.some((r) => r.command === 'attach'),
    false,
  );
});

test('capability probe: missing start_debug_server in executeCommandProvider fails fast without blocking LSP', async (t) => {
  const h = await createDapTestHarness(t, {
    onLspRequest(method) {
      if (method === 'initialize') {
        return {
          capabilities: {
            codeLensProvider: { resolveProvider: false },
            executeCommandProvider: {
              commands: ['exportWorkspace', 'omp.jvm.resolveLaunch'],
            },
          },
        };
      }
    },
  });
  const reply = await h.request('attach', { port: 5005 });
  assert.equal(reply.success, false);
  assert.match(reply.message ?? '', /IntelliJ server does not support start_debug_server/);
  await h.closed;
  assert.equal(
    h.lspRequests.some(
      (r) =>
        r.method === 'workspace/executeCommand' &&
        r.params &&
        typeof r.params === 'object' &&
        'command' in r.params &&
        r.params.command === 'start_debug_server',
    ),
    false,
  );
});

test('attach host normalization preserves loopback classification', () => {
  assert.deepEqual(normalizeAttachHost('127.0.0.1'), { host: '127.0.0.1' });
  assert.deepEqual(normalizeAttachHost('localhost'), { host: 'localhost' });
  assert.deepEqual(normalizeAttachHost('::1'), { host: '::1' });
  assert.deepEqual(normalizeAttachHost('[::1]'), { host: '::1' });
  assert.deepEqual(normalizeAttachHost('[0:0:0:0:0:0:0:1]'), { host: '::1' });
  assert.deepEqual(normalizeAttachHost('0:0:0:0:0:0:0:1'), { host: '::1' });
  assert.deepEqual(normalizeAttachHost('192.168.1.1'), { host: '192.168.1.1' });
  assert.deepEqual(normalizeAttachHost('[::2]'), { host: '::2' });

  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('LOCALHOST'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('[::1]'), true);
  assert.equal(isLoopbackHost('0:0:0:0:0:0:0:1'), true);
  assert.equal(isLoopbackHost('[0:0:0:0:0:0:0:1]'), true);

  assert.equal(isLoopbackHost('127.0.0.2'), false);
  assert.equal(isLoopbackHost('192.168.1.1'), false);
  assert.equal(isLoopbackHost('::2'), false);
  assert.equal(isLoopbackHost('[::2]'), false);
  assert.equal(isLoopbackHost('[::1:8080]'), false);
  assert.equal(isLoopbackHost(''), false);
  assert.equal(isLoopbackHost('example.com'), false);
});

test('zero-based URI clients retain locations across buffered and live breakpoint requests', async (t) => {
  let h: DapTestHarness;
  let sourcePath = '';
  h = await createDapTestHarness(t, {
    onDapRequest(request) {
      if (request.command === 'setBreakpoints') {
        h.respond(request, {
          breakpoints: [
            { id: 1, verified: true, line: 1, column: 1, source: { path: sourcePath } },
          ],
        });
        return true;
      }
      if (request.command === 'stackTrace') {
        h.respond(request, {
          stackFrames: [
            {
              id: 1,
              name: 'main',
              line: 6,
              column: 3,
              endLine: 8,
              endColumn: 5,
              source: { path: sourcePath, adapterData: { path: 'opaque', line: 99 } },
            },
          ],
          totalFrames: 1,
        });
        return true;
      }
      if (request.command === 'variables') {
        h.respond(request, {
          variables: [{ name: 'count', value: '1', type: 'int', variablesReference: 0 }],
        });
        return true;
      }
    },
  });
  sourcePath = join(h.systemPath, 'App.java');
  const sourceUri = pathToFileURL(sourcePath).href;
  await h.request('initialize', {
    pathFormat: 'uri',
    linesStartAt1: false,
    columnsStartAt1: false,
    supportsVariableType: false,
  });
  const buffered = await h.request('setBreakpoints', {
    source: { path: sourceUri },
    breakpoints: [{ line: 0, column: 0 }],
  });
  const pendingId = breakpointResults(buffered)[0].id;
  assert.equal(typeof pendingId, 'number');
  assert.deepEqual(buffered.body, {
    breakpoints: [
      {
        id: pendingId,
        verified: false,
        line: 0,
        column: 0,
        message: 'Pending native debug server initialization',
      },
    ],
  });
  assert.equal((await h.request('attach', { port: 5005 })).success, true);
  const replayed = h.backendRequests.find((request) => request.command === 'setBreakpoints');
  assert.deepEqual(replayed?.arguments, {
    source: { path: sourcePath },
    breakpoints: [{ line: 1, column: 1 }],
  });
  const changed = await h.waitFor(
    (message) => message.type === 'event' && message.event === 'breakpoint',
  );
  assert.deepEqual(changed.body, {
    reason: 'changed',
    breakpoint: {
      id: pendingId,
      verified: true,
      line: 0,
      column: 0,
      source: { path: sourceUri },
    },
  });
  const live = await h.request('setBreakpoints', {
    source: { path: sourceUri },
    breakpoints: [{ line: 0, column: 0 }],
  });
  assert.deepEqual(live.body, {
    breakpoints: [
      {
        id: pendingId,
        verified: true,
        line: 0,
        column: 0,
        source: { path: sourceUri },
      },
    ],
  });
  assert.deepEqual((await h.request('stackTrace', { threadId: 1 })).body, {
    stackFrames: [
      {
        id: 1,
        name: 'main',
        line: 5,
        column: 2,
        endLine: 7,
        endColumn: 4,
        source: { path: sourceUri, adapterData: { path: 'opaque', line: 99 } },
      },
    ],
    totalFrames: 1,
  });
  const variables = await h.request('variables', { variablesReference: 1 });
  assert.equal(variables.type, 'response');
  assert.deepEqual(variables.body, {
    variables: [{ name: 'count', value: '1', variablesReference: 0 }],
  });
});

test('proxy-created entry breakpoints stay one-based for the backend and zero-based for clients', async (t) => {
  const h = await createDapTestHarness(t);
  await h.request('initialize', { linesStartAt1: false });
  await h.request('configurationDone');
  const launched = await h.request('launch', {
    program: javaTestProgram,
    build: false,
    stopOnEntry: true,
  });
  assert.equal(launched.success, true, launched.message);
  const entry = h.backendRequests.find((request) => request.command === 'setBreakpoints');
  assert.deepEqual(entry?.arguments?.breakpoints, [{ line: 8 }]);
  const changed = await h.waitFor(
    (message) => message.type === 'event' && message.event === 'breakpoint',
  );
  assert.deepEqual(changed.body, { reason: 'new', breakpoint: { id: 1, verified: true, line: 7 } });
});

test('backend capabilities cannot enable unsupported cancellation or configuration forwarding', async (t) => {
  const h = await createDapTestHarness(t, {
    capabilities: {
      supportsCancelRequest: true,
      supportsConfigurationDoneRequest: false,
      supportsConditionalBreakpoints: false,
      exceptionBreakpointFilters: [{ filter: 'uncaught', label: 'Uncaught' }],
    },
  });
  const initial = await h.request('initialize');
  assert.ok(initial.body && typeof initial.body === 'object');
  assert.equal('supportsConditionalBreakpoints' in initial.body, false);
  await h.request('configurationDone');
  assert.equal((await h.request('attach', { port: 5005 })).success, true);
  await h.request('threads');
  assert.equal(
    h.backendRequests.some((request) => request.command === 'configurationDone'),
    false,
  );
  const event = h.messages.find(
    (message) => message.type === 'event' && message.event === 'capabilities',
  );
  const body = event?.body;
  assert.ok(body && typeof body === 'object' && 'capabilities' in body);
  const capabilities = body.capabilities;
  assert.ok(capabilities && typeof capabilities === 'object');
  assert.ok('supportsCancelRequest' in capabilities);
  assert.equal(capabilities.supportsCancelRequest, false);
  assert.ok('exceptionBreakpointFilters' in capabilities);
  assert.deepEqual(capabilities.exceptionBreakpointFilters, [
    { filter: 'uncaught', label: 'Uncaught' },
  ]);
  h.emit('capabilities', {
    capabilities: { supportsCancelRequest: true, supportsLogPoints: true },
  });
  await h.request('threads');
  const latest = h.messages
    .filter((message) => message.type === 'event' && message.event === 'capabilities')
    .at(-1)?.body;
  assert.ok(latest && typeof latest === 'object' && 'capabilities' in latest);
  assert.ok(latest.capabilities && typeof latest.capabilities === 'object');
  assert.ok('supportsCancelRequest' in latest.capabilities);
  assert.equal(latest.capabilities.supportsCancelRequest, false);
  const cancelled = await h.request('cancel', { requestId: 999 });
  assert.equal(cancelled.success, false);
  assert.match(cancelled.message ?? '', /not supported/);
  assert.equal(
    h.backendRequests.some((request) => request.command === 'cancel'),
    false,
  );
});

for (const phase of ['buffered', 'live'] as const) {
  test(`unsupported conditional breakpoints fail explicitly in the ${phase} phase`, async (t) => {
    const h = await createDapTestHarness(t, {
      capabilities: { supportsConditionalBreakpoints: false },
    });
    await h.request('initialize');
    const args = {
      source: { path: join(h.systemPath, 'App.java') },
      breakpoints: [{ line: 1, condition: 'count > 0' }],
    };
    if (phase === 'buffered') {
      await h.request('setBreakpoints', args);
      const attached = await h.request('attach', { port: 5005 });
      assert.equal(attached.success, false);
      assert.match(attached.message ?? '', /does not support breakpoint condition/);
    } else {
      await h.request('attach', { port: 5005 });
      const result = await h.request('setBreakpoints', args);
      assert.equal(result.success, false);
      assert.match(result.message ?? '', /does not support breakpoint condition/);
    }
    assert.equal(
      h.backendRequests.some((request) => request.command === 'setBreakpoints'),
      false,
    );
  });
}

test('variable types are preserved for clients that advertise support', async (t) => {
  const h = await createDapTestHarness(t, {
    onDapRequest(request) {
      if (request.command !== 'variables') return;
      h.respond(request, {
        variables: [{ name: 'count', value: '1', type: 'int', variablesReference: 0 }],
      });
      return true;
    },
  });
  await h.request('initialize', { supportsVariableType: true });
  await h.request('attach', { port: 5005 });
  assert.deepEqual((await h.request('variables', { variablesReference: 1 })).body, {
    variables: [{ name: 'count', value: '1', type: 'int', variablesReference: 0 }],
  });
});

test('buffered reference-only sources retain breakpoint identity through early events and stops', async (t) => {
  let h: DapTestHarness;
  h = await createDapTestHarness(t, {
    onDapRequest(request) {
      if (request.command !== 'setBreakpoints') return;
      const source = request.arguments?.source;
      assert.ok(source && typeof source === 'object' && 'sourceReference' in source);
      const reference = source.sourceReference;
      assert.ok(reference === 7 || reference === 8);
      if (reference === 7) {
        h.emit('breakpoint', {
          reason: 'changed',
          breakpoint: {
            id: 107,
            verified: true,
            line: 3,
            source: { sourceReference: 7 },
          },
        });
      }
      h.respond(request, {
        breakpoints: [
          {
            id: 100 + reference,
            verified: reference === 8,
            line: reference === 7 ? 1 : 2,
            source,
          },
        ],
      });
      return true;
    },
  });
  await h.request('initialize', { linesStartAt1: false });
  const first = await h.request('setBreakpoints', {
    source: { sourceReference: 7 },
    breakpoints: [{ line: 0 }],
  });
  const second = await h.request('setBreakpoints', {
    source: { sourceReference: 8 },
    lines: [1],
  });
  const firstId = breakpointResults(first)[0].id;
  const secondId = breakpointResults(second)[0].id;
  assert.equal(typeof firstId, 'number');
  assert.equal(typeof secondId, 'number');
  assert.notEqual(firstId, secondId);
  assert.equal((await h.request('attach', { port: 5005 })).success, true);
  assert.deepEqual(
    h.backendRequests
      .filter((request) => request.command === 'setBreakpoints')
      .map((request) => request.arguments),
    [
      { source: { sourceReference: 7 }, breakpoints: [{ line: 1 }] },
      { source: { sourceReference: 8 }, lines: [2] },
    ],
  );
  assert.deepEqual(
    h.messages
      .filter((message) => message.type === 'event' && message.event === 'breakpoint')
      .map((message) => message.body),
    [
      {
        reason: 'changed',
        breakpoint: { id: firstId, verified: false, line: 0, source: { sourceReference: 7 } },
      },
      {
        reason: 'changed',
        breakpoint: { id: secondId, verified: true, line: 1, source: { sourceReference: 8 } },
      },
      {
        reason: 'changed',
        breakpoint: { id: firstId, verified: true, line: 2, source: { sourceReference: 7 } },
      },
    ],
  );
  h.emit('stopped', { reason: 'breakpoint', threadId: 1, hitBreakpointIds: [107, 108] });
  const stopped = await h.waitFor(
    (message) => message.type === 'event' && message.event === 'stopped',
  );
  assert.deepEqual(stopped.body, {
    reason: 'breakpoint',
    threadId: 1,
    hitBreakpointIds: [firstId, secondId],
  });
});
