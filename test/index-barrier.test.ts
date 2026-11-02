import assert from 'node:assert/strict';
import test from 'node:test';
import { IndexBarrier } from '../src/index-barrier.js';
import { encode, frameParser } from '../src/protocol.js';

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

test('document changes invalidate stale positions without cancelling unrelated document queries', () => {
  const h = harness();
  h.client(query(3, 'file:///project/A.java'));
  h.client(query(4, 'file:///project/B.java'));
  h.client({ jsonrpc: '2.0', id: 5, method: 'workspace/symbol', params: { query: 'Example' } });
  h.client({
    jsonrpc: '2.0',
    method: 'textDocument/didChange',
    params: { textDocument: { uri: 'file:///project/A.java', version: 2 }, contentChanges: [] },
  });
  assert.deepEqual(
    h.downstream.filter((m) => m.error).map((m) => [m.id, m.error?.code]),
    [
      [3, -32801],
      [5, -32801],
    ],
  );
  h.server(ready);
  assert.deepEqual(
    h.upstream.filter((m) => m.id !== undefined).map((m) => m.id),
    [4],
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
