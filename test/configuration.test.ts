import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  loadProjectConfiguration,
  makeResponseKey,
  recordConfigurationItems,
  saveProjectConfiguration,
} from '../src/project/configuration.js';
import { canonicalizeProject } from '../src/project/metadata.js';

test('configuration capture routes explicit scopes only to the deepest active root', async (t) => {
  const systemPath = await mkdtemp(join(tmpdir(), 'omp-config-active-roots-'));
  t.after(() => rm(systemPath, { recursive: true, force: true }));
  const primary = canonicalizeProject(join(systemPath, 'parent'));
  const nested = canonicalizeProject(join(primary.nativePath, 'nested'));
  const stale = canonicalizeProject(join(nested.nativePath, 'stale'));
  const external = canonicalizeProject(join(systemPath, 'external'));
  for (const project of [primary, nested, stale, external]) {
    await saveProjectConfiguration(systemPath, {
      id: project.id,
      projectPath: project.nativePath,
      rootUri: project.rootUri,
      settings: {},
      updatedAt: Date.now(),
    });
  }
  const scopeUri = pathToFileURL(join(stale.nativePath, 'File.java')).href;
  await recordConfigurationItems(
    systemPath,
    primary.id,
    [
      { scopeUri, section: 'java' },
      { scopeUri: external.rootUri, section: 'java' },
      { scopeUri: '', section: 'java' },
      { section: 'java' },
    ],
    ['deepest active', 'external', 'invalid', 'unscoped'],
    new Map([
      [primary.id, primary.nativePath],
      [nested.id, nested.nativePath],
    ]),
  );
  assert.deepEqual((await loadProjectConfiguration(systemPath, nested.id))?.sectionResponses, {
    [makeResponseKey(scopeUri, 'java')]: 'deepest active',
  });
  assert.deepEqual((await loadProjectConfiguration(systemPath, primary.id))?.sectionResponses, {
    [makeResponseKey(undefined, 'java')]: 'unscoped',
  });
  for (const id of [stale.id, external.id]) {
    assert.equal((await loadProjectConfiguration(systemPath, id))?.sectionResponses, undefined);
  }
});
