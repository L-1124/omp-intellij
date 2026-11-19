import assert from 'node:assert/strict';
import test from 'node:test';
import { DocumentSymbolAdapter } from '../src/shared/document-symbols.js';

const range = { start: { line: 0, character: 1 }, end: { line: 3, character: 2 } };
const childRange = { start: { line: 1, character: 2 }, end: { line: 2, character: 3 } };
const tree = [
  {
    name: 'manifest',
    kind: 3,
    range,
    selectionRange: range,
    children: [
      {
        name: 'application',
        kind: 2,
        range: childRange,
        selectionRange: childRange,
        children: [{ name: '.Main', kind: 5, range: childRange, selectionRange: childRange }],
      },
    ],
  },
];

test('flat symbols preserve source ranges, DFS order and immediate parent identity', () => {
  const adapter = new DocumentSymbolAdapter();
  adapter.fromClient({ method: 'initialize', params: { capabilities: {} } });
  adapter.fromClient({
    id: 'symbols',
    method: 'textDocument/documentSymbol',
    params: { textDocument: { uri: 'file:///AndroidManifest.xml' } },
  });
  const message = { id: 'symbols', result: tree } as Record<string, unknown>;
  assert.equal(adapter.fromServer(message), true);
  assert.deepEqual(message.result, [
    { name: 'manifest', kind: 3, location: { uri: 'file:///AndroidManifest.xml', range } },
    {
      name: 'application',
      kind: 2,
      location: { uri: 'file:///AndroidManifest.xml', range: childRange },
      containerName: 'manifest',
    },
    {
      name: '.Main',
      kind: 5,
      location: { uri: 'file:///AndroidManifest.xml', range: childRange },
      containerName: 'application',
    },
  ]);
  const late = { id: 'symbols', result: tree };
  assert.equal(adapter.fromServer(late), false);
  assert.equal(late.result, tree);
});

test('failed requests release their ID without consuming another document request', () => {
  const adapter = new DocumentSymbolAdapter();
  for (const [id, uri] of [
    [1, 'file:///a.xml'],
    [2, 'file:///b.xml'],
  ] as const) {
    adapter.fromClient({
      id,
      method: 'textDocument/documentSymbol',
      params: { textDocument: { uri } },
    });
  }
  adapter.fromServer({ id: 1, error: { code: -32800, message: 'cancelled' } });
  assert.equal(adapter.fromServer({ id: 1, result: tree }), false);
  const response = { id: 2, result: tree } as Record<string, unknown>;
  adapter.fromServer(response);
  assert.deepEqual(
    (response.result as Array<{ location: { uri: string } }>).map((symbol) => symbol.location.uri),
    ['file:///b.xml', 'file:///b.xml', 'file:///b.xml'],
  );
});

test('tags follow client capability while deprecated and hierarchy remain available', () => {
  for (const hierarchical of [false, true]) {
    for (const tags of [false, true]) {
      const adapter = new DocumentSymbolAdapter();
      adapter.fromClient({
        method: 'initialize',
        params: {
          capabilities: {
            textDocument: {
              documentSymbol: {
                hierarchicalDocumentSymbolSupport: hierarchical,
                ...(tags ? { tagSupport: { valueSet: [1] } } : {}),
              },
            },
          },
        },
      });
      adapter.fromClient({
        id: 1,
        method: 'textDocument/documentSymbol',
        params: { textDocument: { uri: 'file:///a.xml' } },
      });
      const message = {
        id: 1,
        result: [{ ...structuredClone(tree[0]), tags: [1, 99], deprecated: true }],
      };
      adapter.fromServer(message);
      const symbol = message.result[0];
      assert.equal('children' in symbol, hierarchical);
      assert.deepEqual('tags' in symbol ? symbol.tags : undefined, tags ? [1, 99] : undefined);
      assert.equal(symbol.deprecated, true);
    }
  }
});

test('partial symbol arrays are flattened without consuming work-done progress or terminal results', () => {
  const adapter = new DocumentSymbolAdapter();
  adapter.fromClient({
    id: 1,
    method: 'textDocument/documentSymbol',
    params: { textDocument: { uri: 'file:///a.xml' }, partialResultToken: 0 },
  });
  const work = { method: '$/progress', params: { token: 0, value: { kind: 'begin' } } };
  assert.equal(adapter.fromServer(work), false);
  for (let chunk = 0; chunk < 2; chunk++) {
    const partial = {
      method: '$/progress',
      params: { token: 0, value: structuredClone(tree) },
    };
    assert.equal(adapter.fromServer(partial), true);
    assert.deepEqual(partial.params.value, [
      { name: 'manifest', kind: 3, location: { uri: 'file:///a.xml', range } },
      {
        name: 'application',
        kind: 2,
        location: { uri: 'file:///a.xml', range: childRange },
        containerName: 'manifest',
      },
      {
        name: '.Main',
        kind: 5,
        location: { uri: 'file:///a.xml', range: childRange },
        containerName: 'application',
      },
    ]);
  }
  assert.equal(adapter.fromServer({ id: 1, result: null }), false);
  const late = { method: '$/progress', params: { token: 0, value: tree } };
  assert.equal(adapter.fromServer(late), false);
  assert.equal(late.params.value, tree);
});

test('local rejection and server errors release symbol IDs and partial tokens for reuse', () => {
  const adapter = new DocumentSymbolAdapter();
  const request = (uri: string) => ({
    id: 1,
    method: 'textDocument/documentSymbol',
    params: { textDocument: { uri }, partialResultToken: 'symbols' },
  });
  adapter.fromClient(request('file:///a.xml'));
  adapter.discard(1);
  const discarded = { method: '$/progress', params: { token: 'symbols', value: tree } };
  assert.equal(adapter.fromServer(discarded), false);
  adapter.fromClient(request('file:///b.xml'));
  adapter.fromServer({ id: 1, error: { code: -32800 } });
  assert.equal(adapter.fromServer(discarded), false);
  adapter.fromClient(request('file:///c.xml'));
  const response = { id: 1, result: [tree[0]] } as Record<string, unknown>;
  assert.equal(adapter.fromServer(response), true);
  const result = response.result as Array<{ location: { uri: string } }>;
  assert.deepEqual(
    result.map((symbol) => symbol.location.uri),
    ['file:///c.xml', 'file:///c.xml', 'file:///c.xml'],
  );
  adapter.fromClient(request('file:///d.xml'));
  adapter.close();
  assert.equal(adapter.fromServer(discarded), false);
});
