import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatPluginOption,
  getIjPluginPaths,
  mergeIjJavaOptions,
} from '../src/server/plugin-options.js';

test('formatPluginOption normalizes slashes and quotes path', () => {
  assert.equal(formatPluginOption('C:\\my\\path'), '-Dplugin.path="C:/my/path"');
  assert.equal(formatPluginOption('/opt/my/path'), '-Dplugin.path="/opt/my/path"');
  assert.equal(
    formatPluginOption('C:/Path With Spaces/ext'),
    '-Dplugin.path="C:/Path With Spaces/ext"',
  );
  assert.equal(formatPluginOption('C:/path1,D:/path2'), '-Dplugin.path="C:/path1,D:/path2"');
});

test('formatPluginOption rejects invalid option characters', () => {
  assert.throws(() => formatPluginOption('C:/bad"path'), /Invalid characters in plugin\.path/);
  assert.throws(() => formatPluginOption('C:/bad\npath'), /Invalid characters in plugin\.path/);
  assert.throws(() => formatPluginOption('C:/bad\rpath'), /Invalid characters in plugin\.path/);
  assert.throws(() => formatPluginOption('C:/bad\0path'), /Invalid characters in plugin\.path/);
});

test('mergeIjJavaOptions preserves options and normalizes plugin paths', () => {
  for (const [label, existing, pluginPath, expected] of [
    ['absent options', undefined, 'C:\\ext', '-Dplugin.path="C:/ext"'],
    ['empty options', '', 'C:\\ext', '-Dplugin.path="C:/ext"'],
    ['whitespace-only options', '   ', 'C:\\ext', '-Dplugin.path="C:/ext"'],
    ['other VM options', '-Xmx2048m -ea', 'C:\\ext', '-Xmx2048m -ea -Dplugin.path="C:/ext"'],
    [
      'other VM options with a POSIX extension path',
      '-Xmx4g -Didea.is.internal=true',
      '/opt/android-ext',
      '-Xmx4g -Didea.is.internal=true -Dplugin.path="/opt/android-ext"',
    ],
    ['unquoted plugin path', '-Dplugin.path=/opt/p1', 'C:\\ext', '-Dplugin.path="/opt/p1,C:/ext"'],
    [
      'unquoted plugin path among options',
      '-Xmx1g -Dplugin.path=/opt/p1 -ea',
      'C:\\ext',
      '-Xmx1g -ea -Dplugin.path="/opt/p1,C:/ext"',
    ],
    [
      'quoted plugin path with spaces',
      '-Dplugin.path="/Existing Plugins/p1"',
      'C:\\ext',
      '-Dplugin.path="/Existing Plugins/p1,C:/ext"',
    ],
    [
      'fully quoted option token',
      '"-Dplugin.path=/Existing Plugins/p1"',
      'C:\\ext',
      '-Dplugin.path="/Existing Plugins/p1,C:/ext"',
    ],
    [
      'comma-separated plugin paths',
      '-Dplugin.path="/opt/p1,/opt/p2"',
      'C:\\ext',
      '-Dplugin.path="/opt/p1,/opt/p2,C:/ext"',
    ],
    [
      'repeated plugin path options',
      '-Dplugin.path=/opt/p1 -Xmx2g -Dplugin.path="/opt/p2"',
      'C:\\ext',
      '-Xmx2g -Dplugin.path="/opt/p1,/opt/p2,C:/ext"',
    ],
    ['already present plugin path', '-Dplugin.path="/p1,/ext"', '/ext', '-Dplugin.path="/p1,/ext"'],
    ['single existing plugin path', '-Dplugin.path="/ext"', '/ext', '-Dplugin.path="/ext"'],
    [
      'other quoted option with spaces',
      '-Xmx2g -Dtitle="Hello   World" -ea',
      'C:\\ext',
      '-Xmx2g -Dtitle="Hello   World" -ea -Dplugin.path="C:/ext"',
    ],
    [
      'plugin path containing spaces',
      '-Xmx2g',
      'C:/Program Files/Android LS Extension',
      '-Xmx2g -Dplugin.path="C:/Program Files/Android LS Extension"',
    ],
    [
      'native list separator',
      `-Dplugin.path="/one${process.platform === 'win32' ? ';' : ':'}/two" -ea`,
      '/two',
      '-ea -Dplugin.path="/one,/two"',
    ],
  ] as const) {
    assert.equal(mergeIjJavaOptions(existing, pluginPath), expected, label);
  }
});

test('mergeIjJavaOptions normalizes Windows backslashes in existing paths', {
  skip: process.platform !== 'win32',
}, () => {
  assert.equal(
    mergeIjJavaOptions('-Dplugin.path="C:\\p1\\dir,D:\\p2\\dir"', 'C:\\ext'),
    '-Dplugin.path="C:/p1/dir,D:/p2/dir,C:/ext"',
  );
});

test('mergeIjJavaOptions rejects invalid characters in plugin path', () => {
  assert.throws(
    () => mergeIjJavaOptions('-Xmx2g', 'C:/bad"path'),
    /Invalid characters in plugin\.path/,
  );
  assert.throws(
    () => mergeIjJavaOptions('-Xmx2g', 'C:/bad,path'),
    /Invalid characters in plugin\.path/,
  );
  assert.throws(
    () => mergeIjJavaOptions('-Xmx2g', 'C:/bad\npath'),
    /Invalid characters in plugin\.path/,
  );
});

test('Windows plugin paths retain filesystem case-insensitive identity', {
  skip: process.platform !== 'win32',
}, () => {
  assert.equal(
    mergeIjJavaOptions('-Dplugin.path="c:/Existing;C:/EXT"', 'C:\\ext'),
    '-Dplugin.path="c:/Existing,C:/EXT"',
  );
});

test('getIjPluginPaths parses supported option forms', () => {
  for (const [label, options, expected] of [
    ['undefined options', undefined, []],
    ['empty options', '', []],
    ['whitespace-only options', '   ', []],
    ['no plugin.path among other flags', '-Xmx2048m -ea -Dfoo=bar', []],
    ['single unquoted plugin path', '-Dplugin.path=/opt/p1', ['/opt/p1']],
    ['unquoted plugin path among options', '-Xmx1g -Dplugin.path=/opt/p1 -ea', ['/opt/p1']],
    [
      'quoted plugin path with spaces',
      '-Dplugin.path="/Program Files/My Plugins/p1"',
      ['/Program Files/My Plugins/p1'],
    ],
    [
      'fully quoted option token',
      '"-Dplugin.path=/Program Files/My Plugins/p1"',
      ['/Program Files/My Plugins/p1'],
    ],
    ['comma-separated plugin paths', '-Dplugin.path="/opt/p1,/opt/p2"', ['/opt/p1', '/opt/p2']],
    [
      'native list-separated plugin paths',
      `-Dplugin.path="/opt/p1${process.platform === 'win32' ? ';' : ':'}/opt/p2"`,
      ['/opt/p1', '/opt/p2'],
    ],
    [
      'repeated plugin path options',
      '-Dplugin.path=/opt/p1 -Xmx2g -Dplugin.path="/opt/p2"',
      ['/opt/p1', '/opt/p2'],
    ],
  ] as const) {
    assert.deepEqual(getIjPluginPaths(options), expected, label);
  }
});

test('getIjPluginPaths normalizes Windows backslashes in extracted paths', {
  skip: process.platform !== 'win32',
}, () => {
  assert.deepEqual(getIjPluginPaths('-Dplugin.path="C:\\p1\\dir,D:\\p2\\dir"'), [
    'C:/p1/dir',
    'D:/p2/dir',
  ]);
});

test('getIjPluginPaths merges and deduplicates additional plugin path', () => {
  assert.deepEqual(getIjPluginPaths(undefined, 'C:\\ext'), ['C:/ext']);
  assert.deepEqual(getIjPluginPaths('-Dplugin.path=/opt/p1', 'C:\\ext'), ['/opt/p1', 'C:/ext']);
  assert.deepEqual(getIjPluginPaths('-Dplugin.path="/opt/p1,/ext"', '/ext'), ['/opt/p1', '/ext']);
});

test('getIjPluginPaths deduplicates case-insensitively on Windows', {
  skip: process.platform !== 'win32',
}, () => {
  assert.deepEqual(getIjPluginPaths('-Dplugin.path="c:/existing;C:/EXT"', 'C:\\ext'), [
    'c:/existing',
    'C:/EXT',
  ]);
});

test('getIjPluginPaths throws on invalid characters in additional plugin path', () => {
  assert.throws(
    () => getIjPluginPaths(undefined, 'C:/bad"path'),
    /Invalid characters in plugin\.path/,
  );
  assert.throws(
    () => getIjPluginPaths(undefined, 'C:/bad,path'),
    /Invalid characters in plugin\.path/,
  );
  assert.throws(
    () => getIjPluginPaths(undefined, 'C:/bad\npath'),
    /Invalid characters in plugin\.path/,
  );
});

test('getIjPluginPaths resolves relative paths to absolute paths when baseDir is specified', () => {
  const base = process.platform === 'win32' ? 'C:/workspace' : '/workspace';
  const resolved = getIjPluginPaths(
    '-Dplugin.path="relative/plugin1,./relative/plugin2"',
    'relative/plugin3',
    base,
  );
  assert.deepEqual(resolved, [
    `${base}/relative/plugin1`,
    `${base}/relative/plugin2`,
    `${base}/relative/plugin3`,
  ]);

  // Relative duplicate deduplicates against absolute
  const deduplicated = getIjPluginPaths(
    `-Dplugin.path="${base}/relative/plugin1,./relative/plugin1"`,
    undefined,
    base,
  );
  assert.deepEqual(deduplicated, [`${base}/relative/plugin1`]);
});
