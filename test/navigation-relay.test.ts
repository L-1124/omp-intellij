import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { type DefinitionInput, NavigationRelay } from '../src/shared/navigation-relay.js';
import { encode, frameParser } from '../src/shared/protocol.js';

const uri = pathToFileURL('Screen.kt').href;
const target = {
  uri: pathToFileURL('strings.xml').href,
  range: { start: { line: 2, character: 18 }, end: { line: 2, character: 21 } },
};
function decode(frame: Buffer): Record<string, unknown> {
  let message: unknown;
  frameParser((value) => {
    message = value;
  })(frame);
  return message as Record<string, unknown>;
}
function definition(id = 1): Record<string, unknown> {
  return {
    id,
    method: 'textDocument/definition',
    params: { textDocument: { uri }, position: { line: 0, character: 18 } },
  };
}
function open(text = 'val x = R.string.old'): Record<string, unknown> {
  return { method: 'textDocument/didOpen', params: { textDocument: { uri, text, version: 1 } } };
}
function harness(resolve: (input: DefinitionInput) => Promise<unknown[] | null>, timeoutMs = 1000) {
  const client: Record<string, unknown>[] = [];
  const server: Record<string, unknown>[] = [];
  const relay = new NavigationRelay({
    resolve,
    timeoutMs,
    invalidate: () => {},
    sendClient: (frame) => client.push(decode(frame)),
    sendServer: (message) => server.push(message),
  });
  return { relay, client, server };
}

test('definition uses unsaved incremental UTF-16 document content', async (t) => {
  const { relay, client } = harness(async (input) => {
    assert.equal(input.text, 'val x = R.string.new\r\n// 😀');
    return [target];
  });
  t.after(() => relay.close());
  await relay.fromClient(open('val x = R.string.old\r\n// 😀'));
  await relay.fromClient({
    method: 'textDocument/didChange',
    params: {
      textDocument: { uri, version: 2 },
      contentChanges: [
        {
          range: { start: { line: 0, character: 17 }, end: { line: 0, character: 20 } },
          text: 'new',
        },
      ],
    },
  });
  await relay.fromClient(definition());
  relay.receive(encode({ jsonrpc: '2.0', id: 1, result: null }));
  await nextTurn();
  assert.deepEqual(client, [{ jsonrpc: '2.0', id: 1, result: [target] }]);
});

test('native errors remain exclusive and release locally rejected definitions', async (t) => {
  const { relay, client } = harness(async () => {
    throw new Error('Must not resolve failed requests');
  });
  t.after(() => relay.close());
  await relay.fromClient(open());
  await relay.fromClient(definition());
  const error = {
    jsonrpc: '2.0',
    id: 1,
    error: { code: -32800, message: 'Cancelled while queued' },
  };
  relay.receive(encode(error));
  assert.deepEqual(client, [error]);
  relay.receive(encode({ jsonrpc: '2.0', id: 1, result: [] }));
  assert.deepEqual(client[1], { jsonrpc: '2.0', id: 1, result: [] });
});

test('nested native requests do not block unrelated responses or leak internal IDs', async (t) => {
  let relay!: NavigationRelay;
  const state = harness(async () => {
    const result = await relay.request('workspace/symbol', { query: 'MainActivity' });
    assert.deepEqual(result, ['native-symbol']);
    return [target];
  });
  relay = state.relay;
  t.after(() => relay.close());
  await relay.fromClient(open());
  await relay.fromClient(definition());
  relay.receive(encode({ jsonrpc: '2.0', id: 1, result: [] }));
  relay.receive(encode({ jsonrpc: '2.0', id: 9, result: { contents: 'hover' } }));
  assert.deepEqual(state.client, [{ jsonrpc: '2.0', id: 9, result: { contents: 'hover' } }]);
  const id = state.server[0].id;
  relay.receive(encode({ jsonrpc: '2.0', id, result: ['native-symbol'] }));
  await nextTurn();
  assert.deepEqual(state.client[1], { jsonrpc: '2.0', id: 1, result: [target] });
  relay.receive(encode({ jsonrpc: '2.0', id, result: ['late-duplicate'] }));
  assert.equal(state.client.length, 2);
});

for (const action of ['cancel', 'change'] as const) {
  test(`${action} during navigation prevents stale successful output`, async (t) => {
    const completion = Promise.withResolvers<unknown[] | null>();
    const { relay, client } = harness(() => completion.promise);
    t.after(() => relay.close());
    await relay.fromClient(open());
    await relay.fromClient(definition());
    relay.receive(encode({ jsonrpc: '2.0', id: 1, result: [] }));
    await relay.fromClient(
      action === 'cancel'
        ? { method: '$/cancelRequest', params: { id: 1 } }
        : {
            method: 'textDocument/didChange',
            params: {
              textDocument: { uri, version: 2 },
              contentChanges: [{ text: 'val x = R.string.changed' }],
            },
          },
    );
    completion.resolve([target]);
    await nextTurn();
    assert.deepEqual(client, [
      {
        jsonrpc: '2.0',
        id: 1,
        error: {
          code: action === 'cancel' ? -32800 : -32801,
          message:
            action === 'cancel'
              ? 'Request cancelled'
              : 'Document or workspace changed during navigation',
        },
      },
    ]);
  });
}

test('navigation timeout preserves native result and ignores late replacement', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const completion = Promise.withResolvers<unknown[] | null>();
  const { relay, client } = harness(() => completion.promise);
  t.after(() => relay.close());
  await relay.fromClient(open());
  await relay.fromClient(definition());
  const original = { jsonrpc: '2.0', id: 1, result: [{ uri: 'jar:///R.class' }] };
  relay.receive(encode(original));
  t.mock.timers.tick(1001);
  assert.deepEqual(client, [original]);
  completion.resolve([target]);
  await nextTurn();
  assert.deepEqual(client, [original]);
});

test('lost document synchronization never falls back to old disk text', async (t) => {
  const { relay, client } = harness(async () => {
    throw new Error('Cannot resolve an unknown buffer');
  });
  t.after(() => relay.close());
  await relay.fromClient(open());
  await relay.fromClient({
    method: 'textDocument/didChange',
    params: {
      textDocument: { uri, version: 2 },
      contentChanges: [
        {
          range: { start: { line: 9, character: 0 }, end: { line: 9, character: 1 } },
          text: 'bad',
        },
      ],
    },
  });
  await assert.rejects(relay.readDocument(uri), /synchronization/);
  await relay.fromClient(definition());
  const original = { jsonrpc: '2.0', id: 1, result: [] };
  relay.receive(encode(original));
  assert.deepEqual(client, [original]);
});

test('initial import completion does not invalidate a definition queued before readiness', async (t) => {
  const { relay, client } = harness(async () => [target]);
  t.after(() => relay.close());
  await relay.fromClient(open());
  await relay.fromClient(definition());
  relay.receive(
    encode({
      jsonrpc: '2.0',
      method: 'intellij/workspaceImportState',
      params: { phase: 'FINISHED' },
    }),
  );
  relay.receive(encode({ jsonrpc: '2.0', id: 1, result: [] }));
  await nextTurn();
  assert.deepEqual(client.at(-1), { jsonrpc: '2.0', id: 1, result: [target] });
});
