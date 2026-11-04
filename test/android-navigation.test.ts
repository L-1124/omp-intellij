import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AndroidNavigation } from '../src/android/navigation.js';
import { namespace, resourceFixture } from './helpers/android-resource-fixture.js';

const range = { start: { line: 3, character: 6 }, end: { line: 3, character: 18 } };
const title = {
  folder: 'values',
  file: 'strings.xml',
  type: 'string',
  name: 'title',
  text: '<resources>\n<string name="title">Title</string>\n</resources>',
};
async function fixture(t: { after: (callback: () => Promise<unknown>) => void }) {
  const f = await resourceFixture([title]);
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const sourceRoot = join(f.moduleRoot, 'src/main');
  const sourceFile = join(sourceRoot, 'java/Screen.kt');
  const classUri = pathToFileURL(join(sourceRoot, 'java/MainActivity.kt')).href;
  const calls: string[] = [];
  const modules: unknown[] = [
    {
      name: 'Probe.app.debug',
      externalProjectPath: f.moduleRoot,
      externalProjectId: ':app',
      contentRoots: [{ path: sourceRoot }],
      dependencies: [],
    },
  ];
  const classes: Array<{
    name: string;
    containerName: string;
    location: { uri: string; range: typeof range };
  }> = [
    { name: 'MainActivity', containerName: namespace, location: { uri: classUri, range } },
    { name: 'MainActivity', containerName: 'wrong.package', location: { uri: classUri, range } },
    {
      name: 'MainActivity',
      containerName: namespace,
      location: { uri: f.rUri.replace('R.class', 'MainActivity.class'), range },
    },
  ];
  let classpath = [f.jar];
  const navigation = new AndroidNavigation(
    async (method, raw) => {
      calls.push(method);
      const params = raw as { query?: string; command?: string; arguments?: unknown[] };
      if (method === 'workspace/executeCommand' && params.command === 'exportWorkspace') {
        await f.put(
          join(String(params.arguments?.[0]), 'workspace.json'),
          JSON.stringify({ modules }),
        );
        return null;
      }
      if (method === 'workspace/executeCommand' && params.command === 'intellij.java.resolveLaunch')
        return { classpath };
      if (method === 'workspace/symbol')
        return params.query === 'R'
          ? [{ name: 'R', containerName: namespace, location: { uri: f.rUri, range } }]
          : classes.filter((symbol) => symbol.name === params.query);
      throw new Error(`Unexpected native request ${method}`);
    },
    (uri) => readFile(fileURLToPath(uri), 'utf8'),
  );
  const options = (
    text: string,
    word: string,
    upstreamResult: unknown = [],
    fileUri = pathToFileURL(join(sourceRoot, 'AndroidManifest.xml')).href,
  ) => {
    const offset = text.indexOf(word);
    const lines = text.slice(0, offset).split('\n');
    return {
      projectRoot: f.root,
      fileUri,
      text,
      upstreamResult,
      position: { line: lines.length - 1, character: lines[lines.length - 1].length + 1 },
    };
  };
  return {
    ...f,
    sourceFile,
    classUri,
    navigation,
    options,
    calls,
    modules,
    classes,
    setClasspath: (value: string[]) => {
      classpath = value;
    },
  };
}
function manifest(value: string, prefix = 'android'): string {
  return `<manifest xmlns:${prefix}="http://schemas.android.com/apk/res/android"><application><activity ${prefix}:name="${value}" /></application></manifest>`;
}

test('Manifest navigation uses exact native class identity, not filenames or bytecode candidates', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(
    await f.navigation.resolve(f.options(manifest('.MainActivity'), '.MainActivity')),
    [{ uri: f.classUri, range }],
  );
  assert.deepEqual(
    await f.navigation.resolve(f.options(manifest('.MainActivity', 'a'), '.MainActivity')),
    [{ uri: f.classUri, range }],
  );
  const inner = `${namespace}.Outer`;
  f.classes.push({ name: 'Inner', containerName: inner, location: { uri: f.classUri, range } });
  assert.deepEqual(
    await f.navigation.resolve(f.options(manifest('.Outer$Inner'), '.Outer$Inner')),
    [{ uri: f.classUri, range }],
  );
});

test('Manifest rejects non-component names, placeholders, aliases and shadowed namespace bindings', async (t) => {
  const f = await fixture(t);
  for (const text of [
    '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application><activity><intent-filter><action android:name=".MainActivity" /></intent-filter></activity></application></manifest>',
    '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application><activity-alias android:name=".MainActivity" /></application></manifest>',
    '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><activity android:name=".MainActivity" /></manifest>',
    '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application><activity xmlns:android="urn:other" android:name=".MainActivity" /></application></manifest>',
    manifest('$' + '{applicationId}.MainActivity'),
  ])
    assert.equal(
      await f.navigation.resolve(
        f.options(text, text.includes('${') ? '$' + '{applicationId}' : '.MainActivity'),
      ),
      null,
    );
  assert.deepEqual(f.calls, []);
});

test('class candidates are limited to current source sets and native module dependencies', async (t) => {
  const f = await fixture(t);
  f.classes.push({
    name: 'MainActivity',
    containerName: namespace,
    location: {
      uri: pathToFileURL(join(f.moduleRoot, 'src/release/java/MainActivity.kt')).href,
      range,
    },
  });
  assert.deepEqual(
    await f.navigation.resolve(f.options(manifest('.MainActivity'), '.MainActivity')),
    [{ uri: f.classUri, range }],
  );
  f.classes.splice(0, f.classes.length, {
    name: 'LibraryActivity',
    containerName: 'library',
    location: {
      uri: pathToFileURL(join(f.root, 'lib/src/main/java/LibraryActivity.kt')).href,
      range,
    },
  });
  f.modules.push({
    name: 'Probe.lib.debug',
    externalProjectPath: join(f.root, 'lib'),
    externalProjectId: ':lib',
    contentRoots: [{ path: join(f.root, 'lib/src/main') }],
    dependencies: [],
  });
  assert.equal(
    await f.navigation.resolve(
      f.options(manifest('library.LibraryActivity'), 'library.LibraryActivity'),
    ),
    null,
  );
  const first = f.modules[0] as { dependencies: unknown[] };
  first.dependencies.push({ type: 'module', name: 'Probe.lib.debug' });
  f.navigation.invalidate();
  assert.deepEqual(
    await f.navigation.resolve(
      f.options(manifest('library.LibraryActivity'), 'library.LibraryActivity'),
    ),
    [f.classes[0].location],
  );
});

test('R targets resolve through real provenance for Location and LocationLink responses', async (t) => {
  const f = await fixture(t);
  const text = 'val title = R.string.title';
  const uri = pathToFileURL(f.sourceFile).href;
  for (const target of [
    { uri: f.rUri, range },
    [{ uri: f.rUri, range }],
    [{ targetUri: f.rUri, targetRange: range, targetSelectionRange: range }],
  ]) {
    const result = await f.navigation.resolve(f.options(text, 'title', target, uri));
    // Select the member rather than the local variable of the same name.
    const member = {
      ...f.options(text, 'title', target, uri),
      position: { line: 0, character: text.lastIndexOf('title') + 1 },
    };
    assert.equal(result, null);
    const resolved = await f.navigation.resolve(member);
    assert.deepEqual(
      resolved?.map((l) => l.uri),
      [pathToFileURL(f.source(title)).href],
    );
  }
});

test('native errors of identity never trigger text-only or framework redirection', async (t) => {
  const f = await fixture(t);
  const text = 'val x = R.string.title';
  const uri = pathToFileURL(f.sourceFile).href;
  for (const upstream of [
    null,
    [],
    { uri: f.classUri, range },
    { uri: 'jar:///sdk/android.jar!/android/R.class', range },
  ]) {
    assert.equal(await f.navigation.resolve(f.options(text, 'title', upstream, uri)), null);
  }
  assert.equal(
    await f.navigation.resolve(
      f.options('val x = wrong.package.R.string.title', 'title', { uri: f.rUri, range }, uri),
    ),
    null,
  );
  assert.deepEqual(f.calls, []);
});

test('unknown or conflicting variant evidence preserves native navigation', async (t) => {
  const f = await fixture(t);
  (f.modules[0] as { name: string }).name = 'Probe.app';
  f.setClasspath([]);
  assert.equal(
    await f.navigation.resolve(f.options(manifest('.MainActivity'), '.MainActivity')),
    null,
  );
  f.setClasspath([f.jar, f.jar.replaceAll('debug', 'release')]);
  f.navigation.invalidate();
  assert.equal(
    await f.navigation.resolve(f.options(manifest('.MainActivity'), '.MainActivity')),
    null,
  );
});

test('variant modules inherit project root from the matching aggregate Gradle module', async (t) => {
  const f = await fixture(t);
  delete (f.modules[0] as { externalProjectPath?: string }).externalProjectPath;
  f.modules.push({
    name: 'Probe.app',
    externalProjectId: ':app',
    externalProjectPath: f.moduleRoot,
    contentRoots: [{ path: f.moduleRoot }],
  });
  assert.deepEqual(
    await f.navigation.resolve(f.options(manifest('.MainActivity'), '.MainActivity')),
    [{ uri: f.classUri, range }],
  );
});
