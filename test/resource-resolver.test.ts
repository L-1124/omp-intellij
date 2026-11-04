import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { computeSourceSetId, resolveResourceDefinition } from '../src/android/resource-resolver.js';
import { parseXml, positionAt } from '../src/android/xml.js';
import {
  namespace,
  type ResourceFixtureItem,
  resourceFixture,
} from './helpers/android-resource-fixture.js';

const title: ResourceFixtureItem = {
  folder: 'values',
  file: 'strings.xml',
  type: 'string',
  name: 'title',
  text: '<resources>\n<!-- <string name="ghost">ignored</string> -->\n<string\n name="title">😀Title</string>\n</resources>',
};
const icon: ResourceFixtureItem = {
  folder: 'drawable',
  file: 'icon.xml',
  type: 'drawable',
  name: 'icon',
  text: '<shape />',
};

test('XML locations preserve UTF-16 offsets and ignore comments, rejecting DTDs', () => {
  const el = parseXml(title.text).find((e) => e.name === 'string');
  assert.ok(el);
  assert.equal(title.text.slice(el.attributes.name.start, el.attributes.name.end), 'title');
  assert.deepEqual(positionAt('😀\r\ntext', 4), { line: 1, character: 0 });
  assert.throws(() => parseXml('<!DOCTYPE a [<!ENTITY e SYSTEM "file:///secret">]><a>&e;</a>'));
  assert.throws(() => parseXml('<resources><string></resources>'));
});

test('AGP source IDs follow suffix matching rather than package-segment matching', () => {
  assert.equal(
    computeSourceSetId('com.example.testapp', 'F:/app', 'main', 4),
    'com.example.testapp-main-4',
  );
  assert.equal(
    computeSourceSetId('com.app.myhook', 'F:/app', 'main', 54),
    'com.app.myhook.app-main-54',
  );
});

test('values provenance resolves current name ranges across qualifiers', async (t) => {
  const night = {
    ...title,
    folder: 'values-night',
    text: '<resources>\n<item type="string" name="title">Night</item>\n</resources>',
  };
  const fixture = await resourceFixture([title, night]);
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const options = {
    moduleRoot: fixture.moduleRoot,
    variant: 'debug',
    namespace,
    type: 'string',
    name: 'title',
  };
  const locations = await resolveResourceDefinition(options);
  assert.deepEqual(
    locations?.map((l) => l.uri).sort(),
    [title, night].map((item) => pathToFileURL(fixture.source(item)).href).sort(),
  );
  for (const location of locations ?? [])
    assert.equal(location.range.end.character - location.range.start.character, 5);
  const shifted = `\n${title.text}`;
  await writeFile(fixture.source(title), shifted);
  const updated = await resolveResourceDefinition(options);
  assert.deepEqual(
    updated?.find((l) => l.uri === pathToFileURL(fixture.source(title)).href)?.range.start,
    { line: 4, character: 7 },
  );
  assert.equal(await resolveResourceDefinition({ ...options, namespace: 'wrong.package' }), null);
});

test('file provenance retains density variants and separates anim from animator', async (t) => {
  const hdpi = { ...icon, folder: 'drawable-hdpi', file: 'icon.png', text: 'fixture image bytes' };
  const animator = {
    folder: 'animator',
    file: 'spin.xml',
    type: 'animator',
    name: 'spin',
    text: '<objectAnimator />',
  };
  const fixture = await resourceFixture([icon, hdpi, animator]);
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const options = { moduleRoot: fixture.moduleRoot, variant: 'debug', namespace };
  const icons = await resolveResourceDefinition({ ...options, type: 'drawable', name: 'icon' });
  assert.deepEqual(
    icons?.map((l) => l.uri).sort(),
    [icon, hdpi].map((item) => pathToFileURL(fixture.source(item)).href).sort(),
  );
  assert.equal(await resolveResourceDefinition({ ...options, type: 'anim', name: 'spin' }), null);
  assert.deepEqual(
    (await resolveResourceDefinition({ ...options, type: 'animator', name: 'spin' }))?.map(
      (l) => l.uri,
    ),
    [pathToFileURL(fixture.source(animator)).href],
  );
  await rm(fixture.source(icon));
  assert.equal(
    await resolveResourceDefinition({ ...options, type: 'drawable', name: 'icon' }),
    null,
  );
});

test('new disk and in-memory overrides invalidate old build provenance', async (t) => {
  const fixture = await resourceFixture([title]);
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const options = {
    moduleRoot: fixture.moduleRoot,
    variant: 'debug',
    namespace,
    type: 'string',
    name: 'title',
  };
  const override = join(fixture.moduleRoot, 'src/debug/res/values/strings.xml');
  const content = '<resources><string name="title">Override</string></resources>';
  assert.equal(
    await resolveResourceDefinition({
      ...options,
      documentPaths: [override],
      readDocument: async (path) => (path === override ? content : readFile(path, 'utf8')),
    }),
    null,
  );
  await fixture.put(override, content);
  assert.equal(await resolveResourceDefinition(options), null);
});

test('removed or renamed declarations, missing and mixed build outputs preserve native results', async (t) => {
  const fixture = await resourceFixture([title]);
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const options = {
    moduleRoot: fixture.moduleRoot,
    variant: 'debug',
    namespace,
    type: 'string',
    name: 'title',
  };
  await writeFile(
    fixture.source(title),
    '<resources><string name="other">Changed</string></resources>',
  );
  assert.equal(await resolveResourceDefinition(options), null);
  await writeFile(fixture.source(title), title.text);
  const blamePath = join(fixture.blame, 'multi-v2/values.json');
  const original = await readFile(blamePath, 'utf8');
  await writeFile(
    blamePath,
    original.replaceAll('mergeDebugResources-0', 'mergeDebugResources-99'),
  );
  assert.equal(await resolveResourceDefinition(options), null);
  await rm(blamePath);
  assert.equal(await resolveResourceDefinition(options), null);
  assert.equal(await resolveResourceDefinition({ ...options, variant: 'release' }), null);
});
