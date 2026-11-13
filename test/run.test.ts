import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import test, { type TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { runMain, runViaDap } from '../src/debug/run-core.js';
import { encode, frameParser } from '../src/shared/protocol.js';

test('native run rejects skip-build before reading a source or opening a session', async () => {
  await assert.rejects(
    runMain({ file: 'missing-source.java', build: false }),
    /build:false is unsupported.*cannot guarantee skipping the build/,
  );
});
interface FakeDapMessage {
  command?: string;
  seq?: number;
  type?: string;
  request_seq?: number;
  arguments?: Record<string, unknown>;
  [key: string]: unknown;
}

async function fakeAdapter(
  t: TestContext,
  afterLaunch: (socket: net.Socket, message: FakeDapMessage) => void,
  onDisconnect?: (socket: net.Socket, message: FakeDapMessage) => void,
) {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on(
      'data',
      frameParser((messageRaw: unknown) => {
        const message = messageRaw as FakeDapMessage;
        if (message.command === 'initialize') {
          const response = encode({
            seq: 1,
            type: 'response',
            request_seq: message.seq,
            command: 'initialize',
            success: true,
            body: {},
          });
          socket.write(response.subarray(0, 13));
          setImmediate(() => socket.write(response.subarray(13)));
        } else if (message.command === 'launch') afterLaunch(socket, message);
        else if (message.command === 'disconnect') {
          if (onDisconnect) onDisconnect(socket, message);
          else socket.end();
        }
      }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  return (server.address() as net.AddressInfo).port;
}

test('lost DAP connection cannot become successful exit zero', async (t) => {
  const port = await fakeAdapter(t, (socket) => socket.end());
  await assert.rejects(
    runViaDap({ port, launchConfig: {}, timeoutMs: 2000 }),
    /closed|exit|disconnect/i,
  );
});

test('DAP nonzero exit survives fragmented initialization and termination', async (t) => {
  const port = await fakeAdapter(t, (socket) => {
    socket.write(encode({ seq: 2, type: 'event', event: 'exited', body: { exitCode: 7 } }));
    socket.write(encode({ seq: 3, type: 'event', event: 'terminated', body: {} }));
  });
  const result = await runViaDap({ port, launchConfig: {}, timeoutMs: 2000 });
  assert.equal(result.exitCode, 7);
});

test('run cancellation waits for native disconnect cleanup before closing its transport', async (t) => {
  const abort = new AbortController();
  const disconnect = Promise.withResolvers<{ socket: net.Socket; message: FakeDapMessage }>();
  const port = await fakeAdapter(
    t,
    (socket) =>
      socket.write(
        encode({
          seq: 2,
          type: 'event',
          event: 'output',
          body: { output: 'building\n', category: 'stdout' },
        }),
      ),
    (socket, message) => disconnect.resolve({ socket, message }),
  );
  let settled = false;
  const run = runViaDap({
    port,
    launchConfig: {},
    signal: abort.signal,
    timeoutMs: 10000,
    onOutput: () => abort.abort(new Error('cancel native build')),
  });
  const rejected = assert.rejects(run, /cancel native build/);
  void run.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  const native = await disconnect.promise;
  await nextTurn();
  assert.equal(settled, false);
  assert.equal(native.socket.destroyed, false);
  native.socket.write(
    encode({
      seq: 3,
      type: 'response',
      request_seq: native.message.seq,
      command: 'disconnect',
      success: true,
    }),
  );
  await rejected;
});

test('native build failure preserves compiler diagnostics in the failed run', async (t) => {
  const port = await fakeAdapter(t, (socket, message) => {
    socket.write(
      encode({
        seq: 2,
        type: 'event',
        event: 'output',
        body: {
          category: 'stderr',
          output: 'App.java: unresolved symbol compile-failure-sentinel\n',
        },
      }),
    );
    socket.write(
      encode({
        seq: 3,
        type: 'response',
        command: 'launch',
        request_seq: message.seq,
        success: false,
        message: 'Build failed',
      }),
    );
  });
  await assert.rejects(
    runViaDap({ port, launchConfig: {}, timeoutMs: 2000 }),
    /Build failed[\s\S]*compile-failure-sentinel/,
  );
});
