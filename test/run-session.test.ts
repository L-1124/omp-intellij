import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createLspSession } from '../src/debug/run-core.js';
import { canonicalizeProject } from '../src/project/metadata.js';
import { encode, frameParser } from '../src/shared/protocol.js';
import { RpcResponseError } from '../src/shared/runtime-status.js';

interface RpcMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

async function createFakeLspServer(
  t: TestContext,
  options: {
    onRequest?: (method: string, params: unknown, id: number, socket: net.Socket) => void;
    autoReady?: boolean;
  } = {},
) {
  const systemPath = await mkdtemp(join(tmpdir(), 'omp-intellij-session-'));
  t.after(() => rm(systemPath, { recursive: true, force: true }));
  const { promise: serverSocketPromise, resolve: resolveServerSocket } =
    Promise.withResolvers<net.Socket>();
  const sockets = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    resolveServerSocket(socket);
    socket.on('close', () => sockets.delete(socket));
    // Cancellation may reset the peer while its response is still in flight.
    socket.on('error', (error: NodeJS.ErrnoException) => {
      assert.equal(error.code, 'ECONNRESET');
    });

    socket.on(
      'data',
      frameParser((rawMsg: unknown) => {
        const msg = rawMsg as RpcMessage;
        if (msg.method && msg.id !== undefined) {
          if (options.onRequest) {
            options.onRequest(msg.method, msg.params, msg.id, socket);
          } else if (msg.method === 'initialize') {
            socket.write(encode({ jsonrpc: '2.0', id: msg.id, result: { capabilities: {} } }));
            if (options.autoReady !== false) {
              setImmediate(() => {
                socket.write(
                  encode({ jsonrpc: '2.0', method: 'intellij/ready-for-test', params: {} }),
                );
              });
            }
          } else {
            socket.write(encode({ jsonrpc: '2.0', id: msg.id, result: {} }));
          }
        }
      }),
    );
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as net.AddressInfo).port;

  const clientSocket = net.createConnection({ host: '127.0.0.1', port });
  await once(clientSocket, 'connect');
  sockets.add(clientSocket);

  const serverSocket = await serverSocketPromise;

  t.after(() => {
    for (const s of sockets) {
      try {
        s.destroy();
      } catch {}
    }
    server.close();
  });

  return {
    systemPath,
    clientSocket,
    serverSocket,
    sendNotification: (method: string, params: unknown) => {
      serverSocket.write(encode({ jsonrpc: '2.0', method, params }));
    },
    sendResponse: (id: number, result: unknown, error?: unknown) => {
      serverSocket.write(encode({ jsonrpc: '2.0', id, result, error }));
    },
  };
}

test('timeout validation rejects non-positive or non-finite timeouts', async (t) => {
  const fake = await createFakeLspServer(t);

  for (const badTimeout of [0, -1, -100, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      createLspSession(process.cwd(), {
        socket: fake.clientSocket,
        systemPath: fake.systemPath,
        initializeTimeoutMs: badTimeout,
      }),
      /initializeTimeoutMs must be a positive finite number/,
    );

    await assert.rejects(
      createLspSession(process.cwd(), {
        socket: fake.clientSocket,
        systemPath: fake.systemPath,
        requestWaitTimeoutMs: badTimeout,
      }),
      /requestWaitTimeoutMs must be a positive finite number/,
    );
  }
});

test('explicit timeout precedence enforces short initialize timeout override', async (t) => {
  const fake = await createFakeLspServer(t, {
    onRequest: () => {
      // Intentionally do not respond to initialize to test timeout precedence
    },
  });

  const start = Date.now();
  await assert.rejects(
    createLspSession(process.cwd(), {
      socket: fake.clientSocket,
      systemPath: fake.systemPath,
      initializeTimeoutMs: 75,
    }),
    (err: unknown) => {
      assert(err instanceof Error);
      assert.match(err.message, /LSP request initialize timed out after 75ms/);
      assert.equal((err as Error & { code?: string }).code, 'ETIMEDOUT');
      return true;
    },
  );
  const elapsed = Date.now() - start;
  assert(elapsed < 2000, `Expected explicit 75ms timeout to trigger quickly, took ${elapsed}ms`);
});

test('legacy timeout alias initTimeoutMs is accepted and validated', async (t) => {
  const fake = await createFakeLspServer(t);

  await assert.rejects(
    createLspSession(process.cwd(), {
      socket: fake.clientSocket,
      systemPath: fake.systemPath,
      initTimeoutMs: 0,
    }),
    /initializeTimeoutMs must be a positive finite number/,
  );

  await assert.rejects(
    createLspSession(process.cwd(), {
      socket: fake.clientSocket,
      systemPath: fake.systemPath,
      indexWaitTimeoutMs: -5,
    }),
    /requestWaitTimeoutMs must be a positive finite number/,
  );
});

test('recorded initialize replay is used when canonical root matches', async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), 'omp-intellij-replay-'));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const projectDir = join(tempDir, 'sample-project');
  await mkdir(projectDir, { recursive: true });
  const { id, nativePath } = canonicalizeProject(projectDir);

  const pluginMeta = join(tempDir, 'plugin-metadata');
  await mkdir(pluginMeta, { recursive: true });

  const projectUri = pathToFileURL(nativePath).href;
  const recordedPayload = {
    processId: 99999,
    rootUri: projectUri,
    rootPath: nativePath,
    workspaceFolders: [{ uri: projectUri, name: 'custom-workspace-folder' }],
    capabilities: {
      textDocument: {
        codeLens: { dynamicRegistration: true },
        hover: { contentFormat: ['markdown'] },
      },
    },
    initializationOptions: {
      customNativeOption: 'preserved-value',
      runMainCodeLens: false,
    },
  };

  await writeFile(
    join(pluginMeta, `initialize-${id}.json`),
    JSON.stringify(recordedPayload),
    'utf8',
  );

  let receivedInitParams: Record<string, unknown> | null = null;
  const fake = await createFakeLspServer(t, {
    onRequest: (method, params, reqId, socket) => {
      if (method === 'initialize') {
        receivedInitParams = params as Record<string, unknown>;
        socket.write(encode({ jsonrpc: '2.0', id: reqId, result: { capabilities: {} } }));
        setImmediate(() => {
          socket.write(encode({ jsonrpc: '2.0', method: 'intellij/ready-for-test', params: {} }));
        });
      }
    },
  });

  const session = await createLspSession(projectDir, {
    socket: fake.clientSocket,
    systemPath: tempDir,
  });

  assert(receivedInitParams !== null);
  const receivedOpts = (receivedInitParams as Record<string, unknown>)
    .initializationOptions as Record<string, unknown>;
  assert.equal(receivedOpts.customNativeOption, 'preserved-value');
  assert.equal(receivedOpts.runMainCodeLens, true);

  const receivedCaps = (receivedInitParams as Record<string, unknown>).capabilities as {
    textDocument?: { codeLens?: { dynamicRegistration?: boolean } };
  };
  assert.equal(receivedCaps.textDocument?.codeLens?.dynamicRegistration, false);

  const folders = (receivedInitParams as Record<string, unknown>).workspaceFolders as Array<{
    name?: string;
  }>;
  assert.equal(folders[0]?.name, 'custom-workspace-folder');

  await session.close();
});

test('recorded initialize replay is skipped when canonical root does not match', async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), 'omp-intellij-mismatch-'));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const projectDir = join(tempDir, 'actual-project');
  await mkdir(projectDir, { recursive: true });
  const { id } = canonicalizeProject(projectDir);

  const pluginMeta = join(tempDir, 'plugin-metadata');
  await mkdir(pluginMeta, { recursive: true });

  const mismatchedRecordedPayload = {
    processId: 88888,
    rootUri: pathToFileURL(join(tempDir, 'completely-different-project')).href,
    workspaceFolders: [
      { uri: pathToFileURL(join(tempDir, 'completely-different-project')).href, name: 'other' },
    ],
    initializationOptions: {
      customNativeOption: 'should-not-be-used',
    },
  };

  await writeFile(
    join(pluginMeta, `initialize-${id}.json`),
    JSON.stringify(mismatchedRecordedPayload),
    'utf8',
  );

  let receivedInitParams: Record<string, unknown> | null = null;
  const fake = await createFakeLspServer(t, {
    onRequest: (method, params, reqId, socket) => {
      if (method === 'initialize') {
        receivedInitParams = params as Record<string, unknown>;
        socket.write(encode({ jsonrpc: '2.0', id: reqId, result: { capabilities: {} } }));
        setImmediate(() => {
          socket.write(encode({ jsonrpc: '2.0', method: 'intellij/ready-for-test', params: {} }));
        });
      }
    },
  });

  const session = await createLspSession(projectDir, {
    socket: fake.clientSocket,
    systemPath: tempDir,
  });

  assert(receivedInitParams !== null);
  const receivedOpts = (receivedInitParams as Record<string, unknown>)
    .initializationOptions as Record<string, unknown>;
  assert.equal(receivedOpts.customNativeOption, undefined);
  assert.equal(receivedOpts.runMainCodeLens, true);

  await session.close();
});

test('reloadWorkspace does not prematurely resolve on unrelated task end and waits for indexing token', async (t) => {
  const { promise: reloadReqPromise, resolve: resolveReloadReq } = Promise.withResolvers<number>();

  const fake = await createFakeLspServer(t, {
    onRequest: (method, _params, reqId, socket) => {
      if (method === 'initialize') {
        socket.write(encode({ jsonrpc: '2.0', id: reqId, result: { capabilities: {} } }));
        setImmediate(() => {
          socket.write(encode({ jsonrpc: '2.0', method: 'intellij/ready-for-test', params: {} }));
        });
      } else if (method === 'intellij/reloadWorkspace') {
        resolveReloadReq(reqId);
      }
    },
  });

  const session = await createLspSession(process.cwd(), {
    socket: fake.clientSocket,
    systemPath: fake.systemPath,
  });

  assert.equal(session.isReady(), true);

  const reloadPromise = session.reloadWorkspace({ timeoutMs: 5000 });

  // Await the reload request reaching the server directly via resolver
  const reloadReqId = await reloadReqPromise;

  // Answer reload request
  fake.sendResponse(reloadReqId, { success: true });

  // Send unrelated progress begin and end
  fake.sendNotification('$/progress', {
    token: 'unrelated-task-1',
    value: { kind: 'begin', title: 'Compiling Background Task' },
  });
  fake.sendNotification('$/progress', {
    token: 'unrelated-task-1',
    value: { kind: 'end' },
  });

  // Verify reloadPromise has NOT resolved after unrelated task end using setImmediate
  const { promise: turnPromise, resolve: resolveTurn } = Promise.withResolvers<string>();
  setImmediate(() => resolveTurn('still-waiting'));
  const raceResult = await Promise.race([
    reloadPromise.then(() => 'prematurely-resolved'),
    turnPromise,
  ]);
  assert.equal(raceResult, 'still-waiting', 'Reload should not resolve on unrelated progress end');

  // Now send actual Indexing begin and end
  fake.sendNotification('$/progress', {
    token: 'indexing-task-42',
    value: { kind: 'begin', title: 'Indexing' },
  });
  fake.sendNotification('$/progress', {
    token: 'indexing-task-42',
    value: { kind: 'end' },
  });

  // Now reloadPromise should resolve
  const reloadResult = await reloadPromise;
  assert.deepEqual(reloadResult, { ready: true });

  await session.close();
});

test('reloadWorkspace validates timeoutMs and cancellation signal', async (t) => {
  const fake = await createFakeLspServer(t);
  const session = await createLspSession(process.cwd(), {
    socket: fake.clientSocket,
    systemPath: fake.systemPath,
  });

  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      session.reloadWorkspace({ timeoutMs: bad }),
      /timeoutMs must be a positive finite number/,
    );
  }

  const preAborted = new AbortController();
  preAborted.abort(new Error('Pre-aborted reload'));
  await assert.rejects(
    session.reloadWorkspace({ signal: preAborted.signal }),
    /Pre-aborted reload/,
  );

  const midAbort = new AbortController();
  const reloadPromise = session.reloadWorkspace({ signal: midAbort.signal });
  midAbort.abort(new Error('Mid-flight reload cancelled'));
  await assert.rejects(reloadPromise, /Mid-flight reload cancelled/);

  await session.close();
});

test('session close and cancellation semantics', async (t) => {
  const preAborted = new AbortController();
  preAborted.abort(new Error('Pre-aborted session'));
  await assert.rejects(
    createLspSession(process.cwd(), { signal: preAborted.signal }),
    /Pre-aborted session/,
  );

  const fake = await createFakeLspServer(t);
  const session = await createLspSession(process.cwd(), {
    socket: fake.clientSocket,
    systemPath: fake.systemPath,
  });

  await session.close();
  await assert.rejects(session.request('workspace/executeCommand', {}), /LSP session is closed/);
  await assert.rejects(session.reloadWorkspace(), /LSP session is closed/);
});

test('runner creates kind runner connection record and marks it closed on exit', async (t) => {
  const fake = await createFakeLspServer(t);
  const session = await createLspSession(process.cwd(), {
    socket: fake.clientSocket,
    systemPath: fake.systemPath,
  });

  const connDir = join(fake.systemPath, 'plugin-metadata', 'connections');
  const filesBefore = await readdir(connDir);
  assert.equal(filesBefore.length, 1);

  const recordPath = join(connDir, filesBefore[0]);
  const activeRecord = JSON.parse(await readFile(recordPath, 'utf8')) as Record<string, unknown>;
  assert.equal(activeRecord.kind, 'runner');
  assert.equal(activeRecord.closed, false);
  assert.equal(activeRecord.phase, 'ready');

  await session.close();

  const closedRecord = JSON.parse(await readFile(recordPath, 'utf8')) as Record<string, unknown>;
  assert.equal(closedRecord.closed, true);
  assert.equal(closedRecord.phase, 'disconnected');
  assert.deepEqual(closedRecord.license, { status: 'unknown' });
});

test('runner preserves raw RpcResponseError code and data in memory while message is sanitized', async (t) => {
  const fake = await createFakeLspServer(t, {
    onRequest: (method, _params, id, socket) => {
      if (method === 'initialize') {
        socket.write(encode({ jsonrpc: '2.0', id, result: { capabilities: {} } }));
        setImmediate(() => {
          socket.write(encode({ jsonrpc: '2.0', method: 'intellij/ready-for-test', params: {} }));
        });
      } else if (method === 'custom/failing') {
        socket.write(
          encode({
            jsonrpc: '2.0',
            id,
            error: {
              code: -32001,
              message:
                'Failed to fetch https://user:secretpass@repo.example.com Bearer token_secret_999',
              data: {
                repository: 'https://user:secretpass@repo.example.com',
                token: 'token_secret_999',
                module: ':core',
              },
            },
          }),
        );
      }
    },
  });

  const session = await createLspSession(process.cwd(), {
    socket: fake.clientSocket,
    systemPath: fake.systemPath,
  });
  t.after(() => session.close());

  let caughtError: unknown;
  try {
    await session.request('custom/failing', {});
  } catch (err: unknown) {
    caughtError = err;
  }

  assert.ok(caughtError instanceof RpcResponseError);
  assert.equal(caughtError.code, -32001);

  // Raw error data is preserved in memory for callers
  const data = caughtError.data as Record<string, unknown>;
  assert.equal(data.token, 'token_secret_999');
  assert.equal(data.repository, 'https://user:secretpass@repo.example.com');
  assert.equal(data.module, ':core');

  // Message is sanitized
  assert.ok(!caughtError.message.includes('secretpass'));
  assert.ok(!caughtError.message.includes('token_secret_999'));
  assert.ok(caughtError.message.includes('[REDACTED]'));
  const dir = join(fake.systemPath, 'plugin-metadata', 'connections');
  const recordPath = join(dir, (await readdir(dir)).find((name) => name.endsWith('.json'))!);
  const storedText = await readFile(recordPath, 'utf8');
  const stored = JSON.parse(storedText);
  assert.equal(stored.phase, 'ready');
  assert.equal(stored.failure.stage, 'request');
  assert.equal(stored.failure.code, -32001);
  assert.equal(stored.failure.data.module, ':core');
  assert.equal(storedText.includes('secretpass'), false);
  assert.equal(storedText.includes('token_secret_999'), false);
  assert.equal(session.isReady(), true);

  await session.close();
});

test('runner initialize failure retains safe RPC cause after its connection closes', async (t) => {
  const fake = await createFakeLspServer(t, {
    onRequest: (_method, _params, id, socket) => {
      socket.write(
        encode({
          jsonrpc: '2.0',
          id,
          error: {
            code: -32001,
            message: 'Cannot resolve dependency',
            data: { repository: 'https://user:secret@repo/x', token: 'secret', module: ':app' },
          },
        }),
      );
    },
  });
  await assert.rejects(
    createLspSession(process.cwd(), { socket: fake.clientSocket, systemPath: fake.systemPath }),
    (error: unknown) => error instanceof RpcResponseError && error.code === -32001,
  );
  const dir = join(fake.systemPath, 'plugin-metadata', 'connections');
  const text = await readFile(join(dir, (await readdir(dir))[0]), 'utf8');
  const stored = JSON.parse(text);
  assert.equal(stored.closed, true);
  assert.equal(stored.failure.stage, 'initialize');
  assert.equal(stored.failure.code, -32001);
  assert.equal(stored.failure.data.module, ':app');
  assert.equal(text.includes('user:secret'), false);
  assert.equal(text.includes('"secret"'), false);
});

test('runner authorization denial rejects a wait without disconnecting; recovery still needs ready', async (t) => {
  const fake = await createFakeLspServer(t);
  const session = await createLspSession(process.cwd(), {
    socket: fake.clientSocket,
    systemPath: fake.systemPath,
  });
  t.after(() => session.close());

  fake.sendNotification('jetbrains/licensing/state', {
    activeLicense: { status: 'Expired' },
    featuresDeclined: true,
    parkedReason: 'SubscriptionExpired',
  });
  await session.request('custom/fence', {});
  assert.equal(session.isReady(), false);
  await assert.rejects(
    session.reloadWorkspace(),
    /IntelliJ authorization denied: SubscriptionExpired/,
  );
  assert.equal(fake.clientSocket.destroyed, false);

  fake.sendNotification('jetbrains/licensing/state', { activeLicense: { status: 'Valid' } });
  await session.request('custom/fence', {});
  assert.equal(session.isReady(), false);

  const reloaded = session.reloadWorkspace();
  fake.sendNotification('intellij/ready-for-test', {});
  assert.deepEqual(await reloaded, { ready: true });
  assert.equal(session.isReady(), true);
  await session.close();
});
