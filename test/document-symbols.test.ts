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
