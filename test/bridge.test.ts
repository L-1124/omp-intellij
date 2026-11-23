import assert from 'node:assert/strict';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  getHostInitializationOptions,
  loadProjectConfiguration,
} from '../src/project/configuration.js';
import { canonicalizeProject } from '../src/project/metadata.js';
import { encode, frameParser } from '../src/shared/protocol.js';

type Message = Record<string, unknown> & {
  error?: { code?: number; message?: string; data?: { failure?: { kind?: string } } };
};

async function bridgeFixture(
  t: TestContext,
  onServerMessage: (message: Message, socket: net.Socket) => void,
  options: { blockMetadata?: boolean } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'omp-bridge-'));
  const systemPath = join(root, 'system');
  const project = join(root, 'project');
  await mkdir(systemPath);
  await mkdir(project);
  if (options.blockMetadata) await writeFile(join(systemPath, 'plugin-metadata'), 'blocked');
  const sockets = new Set<net.Socket>();
  const messages: Message[] = [];
  const pending = new Set<{
    predicate: (message: Message) => boolean;
    resolve: (message: Message) => void;
    reject: (error: Error) => void;
  }>();
  let child: ChildProcessWithoutNullStreams | undefined;
  let exited: Promise<unknown> | undefined;
  let stderr = '';
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on(
      'data',
      frameParser((raw) => onServerMessage(raw as Message, socket)),
    );
  });
  t.after(async () => {
    if (child) {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    }
    for (const socket of sockets) socket.destroy();
    if (server.listening) {
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await writeFile(join(systemPath, 'server.port'), String(address.port));
  await writeFile(join(systemPath, 'omp-server.json'), JSON.stringify({ pid: process.pid }));
  const config = join(root, 'settings.json');
  await writeFile(
    config,
    JSON.stringify({
      host: '127.0.0.1',
      executable: 'unused-existing-server',
      systemPath,
      startupTimeoutMs: 1000,
      initializeTimeoutMs: 1000,
      requestWaitTimeoutMs: 2000,
      idleTimeout: '30m',
      workspaceConfigPath: join(root, 'profiles'),
      cachePolicy: { retentionDays: 30, warnAboveGiB: 5, automaticDeletion: false },
    }),
  );
  const bridge = spawn(
    process.execPath,
    [fileURLToPath(new URL('../src/bridge.js', import.meta.url))],
    {
      cwd: project,
      env: { ...process.env, OMP_INTELLIJ_SETTINGS: config },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  child = bridge;
  exited = once(bridge, 'close');
  bridge.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  bridge.stdout.on(
    'data',
    frameParser((raw) => {
      const message = raw as Message;
      messages.push(message);
      for (const waiter of pending) {
        if (waiter.predicate(message)) {
          pending.delete(waiter);
          waiter.resolve(message);
        }
      }
    }),
  );
  bridge.once('close', () => {
    for (const waiter of pending)
      waiter.reject(new Error(stderr || 'Bridge closed before response'));
    pending.clear();
  });
  return {
    root,
    systemPath,
    project,
    messages,
    send(message: Message) {
      bridge.stdin.write(encode(message));
    },
    initialize(capabilities: Message = {}) {
      bridge.stdin.write(
        encode({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { rootUri: pathToFileURL(project).href, capabilities },
        }),
      );
    },
    waitFor(predicate: (message: Message) => boolean): Promise<Message> {
      const found = messages.find(predicate);
      if (found) return Promise.resolve(found);
      if (bridge.exitCode !== null || bridge.signalCode !== null) {
        return Promise.reject(new Error(stderr || 'Bridge already closed'));
      }
      const result = Promise.withResolvers<Message>();
      pending.add({ predicate, resolve: result.resolve, reject: result.reject });
      return result.promise;
    },
    async close() {
      bridge.stdin.end();
      return exited;
    },
    exited,
  };
}

test('cancelled requests stay cancelled after indexing completes and initialize responds once', {
  timeout: 15000,
}, async (t) => {
  let serverSocket: net.Socket | undefined;
  let semanticRequests = 0;
  const h = await bridgeFixture(t, (message, socket) => {
    serverSocket = socket;
    if (message.method === 'initialize') {
      socket.write(encode({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } }));
    } else if (message.method === 'workspace/symbol') {
      semanticRequests++;
    } else if (message.id !== undefined) {
      socket.write(encode({ jsonrpc: '2.0', id: message.id, result: null }));
    }
  });
  h.initialize();
  await h.waitFor((m) => m.id === 1);
  h.send({ jsonrpc: '2.0', id: 2, method: 'workspace/symbol', params: { query: 'Queued' } });
  h.send({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: 2 } });
  const response = await h.waitFor((m) => m.id === 2);
  assert.equal(response.error?.code, -32800);
  assert.ok(serverSocket);
  serverSocket.write(encode({ jsonrpc: '2.0', method: 'intellij/ready-for-test', params: {} }));
  h.send({ jsonrpc: '2.0', id: 3, method: 'custom/fence', params: {} });
  await h.waitFor((m) => m.id === 3);
  assert.deepEqual(await h.close(), [0, null]);
  assert.equal(semanticRequests, 0);
  assert.equal(h.messages.filter((m) => m.id === 1).length, 1);
});

test('shutdown and exit close only the client connection', {
  timeout: 15000,
}, async (t) => {
  const serverMessages: Message[] = [];
  const disconnected = Promise.withResolvers<void>();
  const h = await bridgeFixture(t, (message, socket) => {
    serverMessages.push(message);
    if (message.method === 'initialize') {
      socket.once('close', disconnected.resolve);
      socket.write(encode({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } }));
    }
  });
  h.initialize();
  await h.waitFor((message) => message.id === 1);
  h.send({ jsonrpc: '2.0', id: 8, method: 'workspace/symbol', params: { query: 'Queued' } });
  h.send({ jsonrpc: '2.0', id: 9, method: 'shutdown', params: null });
  assert.deepEqual(await h.waitFor((message) => message.id === 9), {
    jsonrpc: '2.0',
    id: 9,
    result: null,
  });
  assert.equal((await h.waitFor((message) => message.id === 8)).error?.code, -32803);
  h.send({ jsonrpc: '2.0', method: 'exit' });
  assert.deepEqual(await h.exited, [0, null]);
  await disconnected.promise;
  assert.equal(
    serverMessages.some((message) => message.method === 'shutdown' || message.method === 'exit'),
    false,
  );
});

for (const failure of ['timeout', 'disconnect', 'configuration'] as const) {
  test(`initialize returns one error before EOF on ${failure}`, { timeout: 15000 }, async (t) => {
    const h = await bridgeFixture(
      t,
      (message, socket) => {
        if (message.method === 'initialize' && failure === 'disconnect') socket.end();
      },
      { blockMetadata: failure === 'configuration' },
    );
    h.initialize();
    const response = await h.waitFor((m) => m.id === 1);
    assert.equal(response.error?.code, -32803);
    assert.equal('result' in response, false);
    if (failure === 'timeout') {
      assert.equal(response.error?.data?.failure?.kind, 'timeout');
    }
    await h.exited;
    assert.equal(h.messages.filter((m) => m.id === 1).length, 1);
  });
}

test('backend initialize errors are forwarded without a second response on close', {
  timeout: 15000,
}, async (t) => {
  const h = await bridgeFixture(t, (message, socket) => {
    if (message.method === 'initialize') {
      socket.write(
        encode({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32002, message: 'Initialization failed' },
        }),
      );
    }
  });
  h.initialize();
  const response = await h.waitFor((m) => m.id === 1);
  assert.equal(response.error?.code, -32002);
  await h.close();
  assert.equal(h.messages.filter((m) => m.id === 1).length, 1);
});

test('bridge owns server progress for clients without progress support and preserves partial results', {
  timeout: 15000,
}, async (t) => {
  let progressAccepted = false;
  const h = await bridgeFixture(t, (message, socket) => {
    if (message.method === 'initialize') {
      socket.write(encode({ jsonrpc: '2.0', id: 1, result: { capabilities: {} } }));
      socket.write(
        encode({
          jsonrpc: '2.0',
          id: 80,
          method: 'window/workDoneProgress/create',
          params: { token: 'index' },
        }),
      );
    } else if (message.id === 80 && !message.method) {
      progressAccepted = message.result === null;
      socket.write(
        encode({
          jsonrpc: '2.0',
          method: '$/progress',
          params: {
            token: 'index',
            value: { kind: 'begin', title: 'Indexing' },
          },
        }),
      );
      socket.write(
        encode({
          jsonrpc: '2.0',
          method: '$/progress',
          params: {
            token: 'index',
            value: { kind: 'end' },
          },
        }),
      );
      socket.write(encode({ jsonrpc: '2.0', method: 'intellij/ready-for-test', params: {} }));
    } else if (message.method === 'workspace/symbol') {
      socket.write(
        encode({
          jsonrpc: '2.0',
          method: '$/progress',
          params: {
            token: 'symbols',
            value: [{ name: 'Example' }],
          },
        }),
      );
      socket.write(encode({ jsonrpc: '2.0', id: message.id, result: null }));
    }
  });
  h.initialize();
  await h.waitFor((m) => m.id === 1);
  h.send({
    jsonrpc: '2.0',
    id: 2,
    method: 'workspace/symbol',
    params: {
      query: 'Example',
      partialResultToken: 'symbols',
    },
  });
  await h.waitFor((m) => m.id === 2);
  assert.equal(progressAccepted, true);
  assert.equal(
    h.messages.some((m) => m.method === 'window/workDoneProgress/create'),
    false,
  );
  assert.deepEqual(
    h.messages.filter((m) => m.method === '$/progress').map((m) => m.params),
    [{ token: 'symbols', value: [{ name: 'Example' }] }],
  );
  await h.close();
});

test('bridge declines refactors that require a conflicts decision', {
  timeout: 15000,
}, async (t) => {
  const answered = Promise.withResolvers<Record<string, unknown>>();
  const h = await bridgeFixture(t, (message, socket) => {
    if (message.method === 'initialize') {
      socket.write(encode({ jsonrpc: '2.0', id: 1, result: { capabilities: {} } }));
      socket.write(
        encode({
          jsonrpc: '2.0',
          id: 90,
          method: 'intellij/showConflicts',
          params: {
            title: 'Remove unused parameter',
            conflicts: [{ messages: ['Used in Main.kt'], location: {} }],
            continueLabel: 'Continue',
            cancelLabel: 'Cancel',
          },
        }),
      );
    } else if (message.id === 90 && !message.method) {
      answered.resolve(message);
    }
  });
  h.initialize();
  await h.waitFor((m) => m.id === 1);
  const message = await answered.promise;
  assert.deepEqual(message.result, { decision: 'cancel' });
  assert.equal(
    h.messages.some((m) => m.method === 'intellij/showConflicts'),
    false,
  );
  await h.close();
});

test('bridge reports a fix that needed a variant choice instead of a false success', {
  timeout: 15000,
}, async (t) => {
  const choiceCommand = {
    title: 'Apply ModCommand',
    command: 'applyModCommand',
    arguments: [{ kind: 'LazyAction', sessionId: 42, index: 1 }],
  };
  let serverSocket: net.Socket | undefined;
  const h = await bridgeFixture(t, (message, socket) => {
    serverSocket = socket;
    if (message.method === 'initialize') {
      socket.write(encode({ jsonrpc: '2.0', id: 1, result: { capabilities: {} } }));
    } else if (message.method === 'workspace/executeCommand') {
      socket.write(
        encode({
          jsonrpc: '2.0',
          method: 'intellij/chooseAction',
          params: {
            title: 'Change visibility',
            entries: [{ name: 'Make public', command: choiceCommand }, { name: 'Make private' }],
          },
        }),
      );
      socket.write(encode({ jsonrpc: '2.0', id: message.id, result: true }));
    }
  });
  h.initialize();
  await h.waitFor((m) => m.id === 1);
  assert.ok(serverSocket);
  serverSocket.write(encode({ jsonrpc: '2.0', method: 'intellij/ready-for-test', params: {} }));
  h.send({
    jsonrpc: '2.0',
    id: 7,
    method: 'workspace/executeCommand',
    params: { command: 'applyModCommand', arguments: [] },
  });
  const response = await h.waitFor((m) => m.id === 7);
  assert.equal(response.error?.code, -32803);
  assert.match(String(response.error?.message), /variant choice/);
  assert.equal('result' in response, false);
  assert.deepEqual((response.error?.data as Record<string, unknown>)?.choices, [
    { name: 'Make public', command: choiceCommand },
    { name: 'Make private' },
  ]);
  await h.close();
});

test('bridge leaves progress negotiation with clients that support it', {
  timeout: 15000,
}, async (t) => {
  let progressAccepted = false;
  const h = await bridgeFixture(t, (message, socket) => {
    if (message.method === 'initialize') {
      socket.write(encode({ jsonrpc: '2.0', id: 1, result: { capabilities: {} } }));
      socket.write(
        encode({
          jsonrpc: '2.0',
          id: 80,
          method: 'window/workDoneProgress/create',
          params: { token: 0 },
        }),
      );
    } else if (message.id === 80 && !message.method) {
      progressAccepted = message.result === null;
      socket.write(
        encode({
          jsonrpc: '2.0',
          method: '$/progress',
          params: {
            token: 0,
            value: { kind: 'begin', title: 'Indexing' },
          },
        }),
      );
    }
  });
  h.initialize({ window: { workDoneProgress: true } });
  const create = await h.waitFor((m) => m.id === 80);
  assert.equal(create.method, 'window/workDoneProgress/create');
  h.send({ jsonrpc: '2.0', id: 80, result: null });
  const progress = await h.waitFor((m) => m.method === '$/progress');
  assert.deepEqual(progress.params, { token: 0, value: { kind: 'begin', title: 'Indexing' } });
  assert.equal(progressAccepted, true);
  await h.close();
});

test('bridge emits canonical folder changes and records standalone initialize inputs', {
  timeout: 15000,
}, async (t) => {
  const frames: Message[] = [];
  const h = await bridgeFixture(t, (message, socket) => {
    frames.push(message);
    if (message.method === 'initialize') {
      socket.write(
        encode({
          jsonrpc: '2.0',
          id: 1,
          result: {
            capabilities: { workspace: { workspaceFolders: { changeNotifications: true } } },
          },
        }),
      );
    } else if (message.method === 'test/sync') {
      socket.write(encode({ jsonrpc: '2.0', method: 'test/synced', params: message.params }));
      if (message.params === 2) {
        socket.write(encode({ jsonrpc: '2.0', id: 89, method: 'workspace/workspaceFolders' }));
      } else if (message.params === 4) {
        socket.write(
          encode({
            jsonrpc: '2.0',
            id: 90,
            method: 'workspace/configuration',
            params: {
              items: [
                { scopeUri: second.rootUri, section: 'editor' },
                { scopeUri: third.rootUri, section: 'editor' },
              ],
            },
          }),
        );
      }
    }
  });
  const first = canonicalizeProject(h.project);
  const second = canonicalizeProject(join(h.root, 'second'));
  const third = canonicalizeProject(join(h.root, 'third'));
  const profiles = join(h.root, 'profiles');
  await mkdir(profiles);
  for (const [project, mode] of [
    [first, 'first'],
    [second, 'second'],
    [third, 'third'],
  ] as const) {
    await mkdir(join(project.nativePath, 'sub-a'), { recursive: true });
    await mkdir(join(project.nativePath, 'sub-b'), { recursive: true });
    await writeFile(join(project.nativePath, 'settings.gradle'), "rootProject.name = 'fixture'\n");
    await writeFile(
      join(profiles, `${project.id}.json`),
      JSON.stringify({
        ...project,
        javaHome: join(h.root, `${mode}-jdk`),
        env: { IMPORT_MODE: mode },
        updatedAt: Date.now(),
      }),
    );
  }
  const folder = (path: string, name: string) => ({ uri: pathToFileURL(path).href, name });
  const firstFolder = folder(first.nativePath, 'first');
  const secondA = folder(join(second.nativePath, 'sub-a'), 'second-a');
  const secondB = folder(join(second.nativePath, 'sub-b'), 'second-b');
  const secondFolder = { uri: second.rootUri, name: 'second-a' };
  const thirdA = folder(join(third.nativePath, 'sub-a'), 'third-a');
  const thirdFolder = { uri: third.rootUri, name: 'third-a' };
  const rawSecond = { path: secondA.uri, type: 'gradle', env: { HOST_MODE: 'client' } };
  const fromWorkspace = join(h.root, 'source');
  h.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      rootUri: first.rootUri,
      workspaceFolders: [secondA, secondB, firstFolder],
      initializationOptions: { fromWorkspace, projects: [rawSecond] },
    },
  });
  assert.ok((await h.waitFor((m) => m.id === 1)).result);
  const init = frames[0].params as {
    rootUri: string;
    workspaceFolders: unknown[];
    initializationOptions: { fromWorkspace: string; projects: Array<Record<string, unknown>> };
  };
  assert.equal(init.rootUri, first.rootUri);
  assert.deepEqual(init.workspaceFolders, [secondFolder, { ...firstFolder, uri: first.rootUri }]);
  assert.equal(init.initializationOptions.fromWorkspace, fromWorkspace);
  const imports = init.initializationOptions.projects;
  const importedFirst = imports.find(
    (entry) => canonicalizeProject(String(entry.path)).id === first.id,
  );
  const importedSecond = imports.find(
    (entry) => canonicalizeProject(String(entry.path)).id === second.id,
  );
  assert.equal(imports.length, 2);
  assert.equal(importedFirst?.['java-home'], join(h.root, 'first-jdk'));
  assert.deepEqual(importedFirst?.env, {
    IMPORT_MODE: 'first',
    JAVA_HOME: join(h.root, 'first-jdk'),
  });
  assert.equal(importedSecond?.['java-home'], join(h.root, 'second-jdk'));
  assert.deepEqual(importedSecond?.env, {
    HOST_MODE: 'client',
    IMPORT_MODE: 'second',
    JAVA_HOME: join(h.root, 'second-jdk'),
  });

  const metadata = join(h.systemPath, 'plugin-metadata');
  const snapshot = JSON.parse(
    await readFile(join(metadata, `initialize-${second.id}.json`), 'utf8'),
  );
  assert.equal(snapshot.rootUri, second.rootUri);
  assert.deepEqual(snapshot.workspaceFolders, [secondFolder]);
  assert.deepEqual(snapshot.initializationOptions, { projects: [rawSecond] });
  assert.deepEqual(await getHostInitializationOptions(h.systemPath, second.id), {
    projects: [rawSecond],
  });
  assert.deepEqual(await getHostInitializationOptions(h.systemPath, first.id), {
    fromWorkspace,
    projects: [],
  });

  async function sync(seq: number) {
    h.send({ jsonrpc: '2.0', method: 'test/sync', params: seq });
    await h.waitFor((m) => m.method === 'test/synced' && m.params === seq);
  }
  function change(added: Array<typeof firstFolder>, removed: Array<typeof firstFolder>) {
    h.send({
      jsonrpc: '2.0',
      method: 'workspace/didChangeWorkspaceFolders',
      params: { event: { added, removed } },
    });
  }
  const changes = () =>
    frames.filter((frame) => frame.method === 'workspace/didChangeWorkspaceFolders');
  change([], [secondA]);
  await sync(2);
  assert.deepEqual(changes(), []);
  await h.waitFor((m) => m.id === 89);
  h.send({ jsonrpc: '2.0', id: 89, result: [secondB, firstFolder] });
  await sync(3);
  assert.deepEqual(frames.find((frame) => frame.id === 89)?.result, [
    secondFolder,
    { ...firstFolder, uri: first.rootUri },
  ]);
  change([thirdA], [secondB]);
  await sync(4);
  assert.deepEqual(
    changes().map((frame) => frame.params),
    [{ event: { added: [thirdFolder], removed: [secondFolder] } }],
  );

  await h.waitFor((m) => m.id === 90);
  h.send({ jsonrpc: '2.0', id: 90, result: ['removed', 'active'] });
  await sync(5);
  assert.equal(
    (await loadProjectConfiguration(h.systemPath, second.id))?.sectionResponses,
    undefined,
  );
  assert.deepEqual(
    Object.values((await loadProjectConfiguration(h.systemPath, third.id))?.sectionResponses ?? {}),
    ['active'],
  );
  const connections = join(metadata, 'connections');
  const [connection] = (await readdir(connections)).filter((file) => file.endsWith('.json'));
  const record = JSON.parse(await readFile(join(connections, connection), 'utf8'));
  assert.equal(record.rootUri, first.rootUri);
  assert.equal(typeof record.workspaceImportOptions[first.id], 'string');
  assert.equal(Object.hasOwn(record.workspaceImportOptions, second.id), false);
  assert.equal(record.workspaceImportOptions[third.id], null);
  await assert.rejects(readFile(join(metadata, `initialize-${third.id}.json`)), { code: 'ENOENT' });
  await h.close();
});
