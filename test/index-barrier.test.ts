import assert from 'node:assert/strict';
import test from 'node:test';
import { IndexBarrier } from '../src/project/index-barrier.js';
import { encode, frameParser } from '../src/shared/protocol.js';

interface DecodedMessage {
  id?: unknown;
  method?: string;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: {
      reason?: string;
      phase?: string;
      projectStillIndexing?: boolean;
      elapsed?: number;
    };
  };
  params?: Record<string, unknown>;
}

function harness(waitMs = 1000) {
  const upstream: DecodedMessage[] = [];
  const downstream: DecodedMessage[] = [];
  const decode = (frame: Buffer): DecodedMessage =>
    JSON.parse(frame.subarray(frame.indexOf('\r\n\r\n') + 4).toString('utf8'));
  const barrier = new IndexBarrier({
    waitMs,
    sendServer: (frame) => upstream.push(decode(frame)),
    sendClient: (frame) => downstream.push(decode(frame)),
  });
  return {
    barrier,
    upstream,
    downstream,
    client(message: Record<string, unknown>) {
      barrier.fromClient(message, encode(message));
    },
    server(message: Record<string, unknown>) {
      barrier.fromServer(message, encode(message));
    },
  };
}

const query = (id: unknown, uri = 'file:///project/A.java') => ({
  jsonrpc: '2.0',
  id,
  method: 'textDocument/definition',
  params: { textDocument: { uri }, position: { line: 1, character: 2 } },
});

const ready = { jsonrpc: '2.0', method: 'intellij/ready-for-test', params: {} };

test('unadvertised workspace-folder changes preserve ready queries', () => {
  const h = harness();
  try {
    h.client({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { rootUri: 'file:///project' },
    });
    h.server({
      jsonrpc: '2.0',
      id: 1,
      result: { capabilities: { workspace: { workspaceFolders: { supported: true } } } },
    });
    h.server(ready);
    h.client({
      jsonrpc: '2.0',
      method: 'workspace/didChangeWorkspaceFolders',
      params: {
        event: { added: [{ uri: 'file:///project/subdir', name: 'subdir' }], removed: [] },
      },
    });
    h.client(query(2));
    assert.equal(h.barrier.getState().phase, 'ready');
    assert.equal(h.barrier.getState().generation, 0);
    assert.equal(h.barrier.pending.size, 0);
    assert.ok(h.upstream.some((message) => message.id === 2));
    assert.equal(
      h.downstream.some((message) => message.error),
      false,
    );
  } finally {
    h.barrier.dispose();
  }
});

test('advertised workspace-folder changes reject stale queries and await new readiness', () => {
  for (const changeNotifications of [true, 'workspace-folder-registration']) {
    const h = harness();
    try {
      h.client({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { rootUri: 'file:///project' },
      });
      h.server({
        jsonrpc: '2.0',
        id: 1,
        result: { capabilities: { workspace: { workspaceFolders: { changeNotifications } } } },
      });
      h.client(query(2));
      h.client({
        jsonrpc: '2.0',
        method: 'workspace/didChangeWorkspaceFolders',
        params: { event: { added: [], removed: [{ uri: 'file:///old', name: 'old' }] } },
      });
      assert.equal(h.downstream.find((message) => message.id === 2)?.error?.code, -32803);
      assert.equal(h.barrier.getState().phase, 'importing');
      assert.equal(h.barrier.getState().generation, 1);
      h.client(query(3));
      assert.equal(
        h.upstream.some((message) => message.id === 3),
        false,
      );
      h.server(ready);
      assert.ok(h.upstream.some((message) => message.id === 3));
    } finally {
      h.barrier.dispose();
    }
  }
});

test('initialize and import completion do not release queries before indexing readiness', () => {
  const h = harness();
  h.client({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { rootUri: 'file:///project' } });
  h.server({ jsonrpc: '2.0', id: 1, result: { capabilities: {} } });
  h.client({ jsonrpc: '2.0', method: 'initialized', params: {} });
  h.client(query(2));
  h.server({
    jsonrpc: '2.0',
    method: 'intellij/workspaceImportState',
    params: { phase: 'FINISHED', folders: [{ status: 'SUCCESS' }] },
  });
  assert.equal(
    h.upstream.some((m) => m.id === 2),
    false,
  );
  h.server(ready);
  assert.equal(h.upstream.filter((m) => m.id === 2).length, 1);
  h.barrier.dispose();
});

test('client responses and document notifications are not trapped behind semantic queries', () => {
  const h = harness();
  h.client(query(2));
  h.client({ jsonrpc: '2.0', id: 'server-config', result: [null] });
  h.client({
    jsonrpc: '2.0',
    method: 'textDocument/didOpen',
    params: { textDocument: { uri: 'file:///project/A.java' } },
  });
  assert.deepEqual(
    h.upstream.map((m) => m.id ?? m.method),
    ['server-config', 'textDocument/didOpen'],
  );
  h.barrier.dispose();
});

test('cancelled requests are never sent when readiness arrives later', () => {
  const h = harness();
  h.client(query('cancel-me'));
  h.client({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: 'cancel-me' } });
  assert.equal(h.downstream[0].error?.code, -32800);
  h.server(ready);
  assert.equal(
    h.upstream.some((m) => m.id === 'cancel-me'),
    false,
  );
  assert.equal(h.barrier.queuedBytes, 0);
  h.barrier.dispose();
});

test('timeout returns an explicit structured error, stays indexing, and cannot later become an empty success or late query', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const h = harness(10);
  h.client({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { rootUri: 'file:///project' } });
  h.server({ jsonrpc: '2.0', id: 1, result: { capabilities: {} } });
  h.server({
    jsonrpc: '2.0',
    method: 'intellij/workspaceImportState',
    params: { phase: 'FINISHED', folders: [{ status: 'SUCCESS' }] },
  });
  assert.equal(h.barrier.getState().phase, 'indexing');

  h.client(query(7));
  t.mock.timers.tick(30);

  const failure = h.downstream.find((m) => m.error);
  assert.ok(failure);
  assert.equal(failure.id, 7);
  assert.equal(failure.error?.code, -32803);
  assert.match(failure.error?.message || '', /not ready/);
  assert.equal(failure.error?.data?.reason, 'request-wait-timeout');
  assert.equal(failure.error?.data?.phase, 'indexing');
  assert.equal(failure.error?.data?.projectStillIndexing, true);
  assert.ok((failure.error?.data?.elapsed ?? 0) >= 10);
  assert.equal('result' in failure, false);

  assert.equal(h.barrier.getState().phase, 'indexing');
  assert.equal(h.barrier.failure, null);

  h.client(query(8));
  h.server(ready);
  assert.deepEqual(
    h.upstream.filter((m) => m.id !== undefined).map((m) => m.id),
    [1, 8],
  );
  h.barrier.dispose();
});

test('a failed import rejects waiting and future queries, even if a ready signal follows', () => {
  const h = harness();
  h.client(query(3));
  h.server({
    jsonrpc: '2.0',
    method: 'intellij/workspaceImportState',
    params: { phase: 'FINISHED', folders: [{ status: 'FAILED' }] },
  });
  h.server(ready);
  h.client(query(4));
  assert.deepEqual(
    h.downstream.filter((m) => m.error).map((m) => m.id),
    [3, 4],
  );
  assert.equal(h.upstream.length, 0);
  h.barrier.dispose();
});

test('document changes and closes preserve queued queries until readiness or client cancellation', () => {
  const h = harness();
  h.client(query(3, 'file:///project/A.java'));
  h.client(query(4, 'file:///project/B.java'));
  h.client({ jsonrpc: '2.0', id: 5, method: 'workspace/symbol', params: { query: 'Example' } });
  h.client({
    jsonrpc: '2.0',
    method: 'textDocument/didChange',
    params: { textDocument: { uri: 'file:///project/A.java', version: 2 }, contentChanges: [] },
  });
  h.client({
    jsonrpc: '2.0',
    method: 'textDocument/didClose',
    params: { textDocument: { uri: 'file:///project/B.java' } },
  });
  assert.equal(h.downstream.length, 0);
  h.client({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: 3 } });
  assert.deepEqual(
    h.downstream.map((m) => [m.id, m.error?.code]),
    [[3, -32800]],
  );
  h.server(ready);
  assert.deepEqual(
    h.upstream.filter((m) => m.id !== undefined).map((m) => m.id),
    [4, 5],
  );
  h.barrier.dispose();
});

test('project readiness is independent per connection and reimport closes only its own barrier', () => {
  const a = harness();
  const b = harness();
  a.client(query(1));
  b.client(query(2));
  b.server(ready);
  assert.equal(a.upstream.length, 0);
  assert.deepEqual(
    b.upstream.map((m) => m.id),
    [2],
  );
  b.server({
    jsonrpc: '2.0',
    method: 'intellij/workspaceImportState',
    params: { phase: 'STARTED', folders: [] },
  });
  b.client(query(3));
  assert.equal(
    b.upstream.some((m) => m.id === 3),
    false,
  );
  a.server(ready);
  assert.deepEqual(
    a.upstream.map((m) => m.id),
    [1],
  );
  assert.equal(
    b.upstream.some((m) => m.id === 3),
    false,
  );
  a.barrier.dispose();
  b.barrier.dispose();
});

test('reimported connection releases queued queries after its indexing task ends without a second ready notification', () => {
  const h = harness();
  const progress = (token: string, value: unknown) =>
    h.server({ method: '$/progress', params: { token, value } });
  h.server(ready);
  h.server({ method: 'intellij/workspaceImportState', params: { phase: 'FINISHED', folders: [] } });
  progress('index', { kind: 'begin', title: 'Indexing' });
  h.client(query(20));
  progress('other', { kind: 'begin', title: 'Building' });
  progress('other', { kind: 'end' });
  assert.equal(
    h.upstream.some((m) => m.id === 20),
    false,
  );
  progress('index', { kind: 'end' });
  assert.equal(h.barrier.getState().phase, 'ready');
  assert.equal(h.upstream.filter((m) => m.id === 20).length, 1);
  h.client(query(21));
  assert.equal(h.upstream.filter((m) => m.id === 21).length, 1);
  h.barrier.dispose();
});

test('initial indexing completion cannot release requests before native ready', () => {
  const h = harness();
  h.client(query(20));
  h.server({
    method: '$/progress',
    params: { token: 'index', value: { kind: 'begin', title: 'Indexing' } },
  });
  h.server({ method: '$/progress', params: { token: 'index', value: { kind: 'end' } } });
  assert.equal(h.upstream.length, 0);
  h.server(ready);
  assert.equal(h.upstream.filter((m) => m.id === 20).length, 1);
  h.barrier.dispose();
});

test('shutdown does not wait for indexing and rejects queued semantic requests', () => {
  const h = harness();
  h.client(query(8));
  h.client({ jsonrpc: '2.0', id: 9, method: 'shutdown', params: null });
  assert.deepEqual(
    h.upstream.map((m) => m.id),
    [9],
  );
  assert.equal(h.downstream[0].id, 8);
  assert.equal(h.downstream[0].error?.code, -32803);
  h.barrier.dispose();
});

test('fragmented UTF-8 frames and multiple frames in one chunk retain their messages', () => {
  const seen: unknown[] = [];
  const parse = frameParser((message) => seen.push(message));
  const first = { jsonrpc: '2.0', id: 1, method: 'workspace/symbol', params: { query: '解码器' } };
  const second = { jsonrpc: '2.0', method: 'intellij/ready-for-test', params: {} };
  const bytes = Buffer.concat([encode(first), encode(second)]);
  for (let offset = 0; offset < bytes.length; offset += 3)
    parse(bytes.subarray(offset, offset + 3));
  assert.deepEqual(seen, [first, second]);
});

test('invalid or oversized Content-Length is rejected before buffering a payload', () => {
  assert.throws(
    () => frameParser(() => {})(Buffer.from('Content-Length: 999999999\r\n\r\n')),
    /frame length/,
  );
});

test('initialization failure drains queued requests with sanitized failure and passes raw error frame', () => {
  const h = harness();
  h.client({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { rootUri: 'file:///project' } });
  h.client(query(10));
  assert.equal(h.upstream.filter((m) => m.id === 10).length, 0);

  const rawInitError = {
    jsonrpc: '2.0',
    id: 1,
    error: { code: -32001, message: 'Invalid SDK: secret-token=xyz', data: { token: 'secret' } },
  };
  h.server(rawInitError);

  // Original response frame forwarded untouched to client
  const initFwd = h.downstream.find((m) => m.id === 1);
  assert.deepEqual(initFwd, rawInitError);

  // Queued request 10 drained and rejected
  const qReject = h.downstream.find((m) => m.id === 10);
  assert.ok(qReject);
  assert.equal(qReject.error?.code, -32803);
  assert.match(qReject.error?.message ?? '', /Initialize failed/);
  assert.equal(h.barrier.pending.size, 0);
  h.barrier.dispose();
});

test('import failure with folder error message drains queue and preserves root cause', () => {
  const h = harness();
  h.client({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { rootUri: 'file:///project' } });
  h.server({ jsonrpc: '2.0', id: 1, result: { capabilities: {} } });
  h.client(query(11));
  assert.equal(h.barrier.pending.size, 1);

  h.server({
    jsonrpc: '2.0',
    method: 'intellij/workspaceImportState',
    params: {
      phase: 'FAILED',
      folders: [
        {
          folderUri: 'file:///project/app',
          tool: 'gradle',
          status: 'ERROR',
          message: 'Cannot resolve plugin: internal error',
        },
      ],
    },
  });

  assert.equal(h.barrier.pending.size, 0);
  const qReject = h.downstream.find((m) => m.id === 11);
  assert.ok(qReject);
  assert.equal(qReject.error?.code, -32803);
  assert.match(qReject.error?.message ?? '', /Cannot resolve plugin: internal error/);
  h.barrier.dispose();
});

test('authorization denial drains queue without disconnect; valid clears only auth failure, release needs ready', () => {
  const h = harness();
  h.client({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { rootUri: 'file:///project' } });
  h.server({ jsonrpc: '2.0', id: 1, result: { capabilities: {} } });
  h.client(query(12));
  assert.equal(h.barrier.pending.size, 1);

  h.server({
    jsonrpc: '2.0',
    method: 'jetbrains/licensing/state',
    params: {
      activeLicense: { status: 'Expired' },
      featuresDeclined: true,
      parkedReason: 'LicenseExpired',
    },
  });

  // Denied queue drained immediately
  assert.equal(h.barrier.pending.size, 0);
  const qReject = h.downstream.find((m) => m.id === 12);
  assert.ok(qReject);
  assert.equal(qReject.error?.code, -32803);
  assert.match(qReject.error?.message ?? '', /LicenseExpired/);
  assert.notEqual(h.barrier.state.phase, 'disconnected');

  // License recovers to valid
  h.server({
    jsonrpc: '2.0',
    method: 'jetbrains/licensing/state',
    params: {
      activeLicense: { status: 'Valid' },
      featuresDeclined: false,
    },
  });
  assert.equal(h.barrier.failure, null);

  // New request queues and is NOT released on Valid alone
  h.client(query(13));
  assert.equal(h.upstream.filter((m) => m.id === 13).length, 0);

  // Real ready evidence releases queue
  h.server(ready);
  assert.equal(h.upstream.filter((m) => m.id === 13).length, 1);
  h.barrier.dispose();
});

test('authorization denial and recovery retain an existing import root cause', () => {
  const h = harness();
  h.client({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { rootUri: 'file:///project' } });
  h.server({ jsonrpc: '2.0', id: 1, result: { capabilities: {} } });

  h.server({
    jsonrpc: '2.0',
    method: 'intellij/workspaceImportState',
    params: {
      phase: 'FAILED',
      folders: [{ status: 'ERROR', message: 'Build file corrupted' }],
    },
  });
  assert.match(h.barrier.failure ?? '', /Build file corrupted/);
  h.server({
    jsonrpc: '2.0',
    method: 'jetbrains/licensing/state',
    params: { featuresDeclined: true },
  });
  assert.equal(h.barrier.state.failure?.kind, 'import');
  assert.match(h.barrier.failure ?? '', /Build file corrupted/);

  // Licensing recovery notification must not erase the import failure
  h.server({
    jsonrpc: '2.0',
    method: 'jetbrains/licensing/state',
    params: { activeLicense: { status: 'Valid' } },
  });
  assert.match(h.barrier.failure ?? '', /Build file corrupted/);
  h.barrier.dispose();
});

test('individual request cancellation does not abort other queued requests or fail project', () => {
  const h = harness();
  h.client({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { rootUri: 'file:///project' } });
  h.server({ jsonrpc: '2.0', id: 1, result: { capabilities: {} } });
  h.client(query(14));
  h.client(query(15));
  assert.equal(h.barrier.pending.size, 2);

  // Client cancels only request 14
  h.client({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: 14 } });
  assert.equal(h.barrier.pending.size, 1);
  assert.ok(!h.barrier.pending.has(14));
  assert.ok(h.barrier.pending.has(15));
  assert.equal(h.barrier.failure, null);
  assert.notEqual(h.barrier.state.phase, 'failed');

  const cancelResponse = h.downstream.find((m) => m.id === 14);
  assert.ok(cancelResponse);
  assert.equal(cancelResponse.error?.code, -32800);

  // Ready releases remaining request 15
  h.server(ready);
  assert.equal(h.upstream.filter((m) => m.id === 15).length, 1);
  h.barrier.dispose();
});

test('IndexBarrier onStateChange callback errors are handled cleanly without crashing or duplicate log spam', () => {
  let errorCount = 0;
  const originalError = console.error;
  const logged: string[] = [];
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  };

  try {
    const barrier = new IndexBarrier({
      sendServer: () => {},
      sendClient: () => {},
      onStateChange: () => {
        errorCount++;
        throw new Error('listener failure test');
      },
    });

    // Trigger state changes that invoke onStateChange
    barrier.fromClient(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { rootUri: 'file:///project' } },
      Buffer.from(''),
    );
    barrier.fromServer({ jsonrpc: '2.0', id: 1, result: { capabilities: {} } }, Buffer.from(''));
    barrier.fromServer({ method: 'intellij/ready-for-test', params: {} }, Buffer.from(''));

    assert.ok(errorCount >= 2, 'Listener was called multiple times');
    // The first error was logged, consecutive identical errors within 5s are throttled
    assert.ok(
      logged.some((msg) => msg.includes('IndexBarrier onStateChange error: listener failure test')),
    );
    barrier.dispose();
  } finally {
    console.error = originalError;
  }
});
