import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { canonicalizeProject } from '../src/metadata.js';
import { encode, frameParser } from '../src/protocol.js';
import { createLspSession } from '../src/run-core.js';

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
  assert.equal(receivedOpts.eulaHash, 'cd82e6cdaf2790f1');
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
