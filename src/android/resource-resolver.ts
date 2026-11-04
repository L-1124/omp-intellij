import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { LspLocation, ResolveResourceDefinitionOptions, XmlElement } from './types.js';
import { locationAt, parseXml, positionAt } from './xml.js';

export type { ResolveResourceDefinitionOptions } from './types.js';

export function computeSourceSetId(
  namespace: string,
  moduleRoot: string,
  parent: string,
  index: number,
): string {
  const module = basename(moduleRoot);
  return `${namespace}${namespace.endsWith(module) ? '' : `.${module}`}-${parent}-${index}`.replaceAll(
    ' ',
    '_',
  );
}

function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return (
    rel === '' ||
    (!rel.startsWith(`..${sep}`) &&
      rel !== '..' &&
      !resolve(path).startsWith(`${sep}${sep}`) &&
      !/^[A-Za-z]:/.test(rel))
  );
}

function key(type: string, name: string): string {
  return `${type === 'string-array' || type === 'integer-array' ? 'array' : type}\0${name.replace(/[.:]/g, '_')}`;
}

function declaration(el: XmlElement): string | null {
  const name = el.attributes.name?.value;
  if (!name) return null;
  if (
    el.parent?.name !== 'resources' &&
    !(el.name === 'attr' && el.parent?.name === 'declare-styleable')
  )
    return null;
  const type = el.name === 'item' ? el.attributes.type?.value : el.name;
  return type ? key(type, name) : null;
}

function declarations(text: string): Map<string, { start: number; end: number }[]> {
  const result = new Map<string, { start: number; end: number }[]>();
  for (const el of parseXml(text)) {
    const name = declaration(el);
    if (name) {
      const attr = el.attributes.name;
      result.set(name, [...(result.get(name) ?? []), attr]);
    }
    for (const attr of Object.values(el.attributes)) {
      const id = /^@\+id\/([A-Za-z_][\w]*)$/.exec(attr.value);
      if (id) result.set(key('id', id[1]), [...(result.get(key('id', id[1])) ?? []), attr]);
    }
  }
  return result;
}

async function metadata(path: string): Promise<{ mtimeMs: number; size: number } | null> {
  try {
    const value = await stat(path);
    return { mtimeMs: value.mtimeMs, size: value.size };
  } catch {
    return null;
  }
}

function numbers(value: unknown): number[] {
  if (typeof value !== 'string') return [];
  const result = value.split(',').map(Number);
  return result.every(Number.isSafeInteger) ? result : [];
}

interface Snapshot {
  roots: string[];
  files: Map<string, Set<string>>;
  ids: Map<string, string>;
  merger: string;
  merged: string;
  blame: string;
}

async function snapshot(
  moduleRoot: string,
  variant: string,
  namespace: string,
  read: (path: string) => Promise<string>,
): Promise<Snapshot> {
  const task = `merge${variant[0].toUpperCase()}${variant.slice(1)}Resources`;
  const intermediates = join(moduleRoot, 'build', 'intermediates');
  const incremental = join(intermediates, 'incremental', variant, task);
  const merger = join(incremental, 'merger.xml');
  const elements = parseXml(await read(merger));
  if (elements[0]?.name !== 'merger' || elements[0].attributes.version?.value !== '3')
    throw new Error('Unsupported AGP merge state');
  const roots = new Set<string>();
  const files = new Map<string, Set<string>>();
  for (const el of elements) {
    if (el.name !== 'source' || el.parent?.name !== 'dataSet' || !el.attributes.path) continue;
    const root = resolve(el.attributes.path.value);
    roots.add(root);
    for (const file of el.children ?? []) {
      if (file.name !== 'file' || !file.attributes.path) continue;
      const path = resolve(file.attributes.path.value);
      if (!contained(root, path)) throw new Error('Source outside registered resource root');
      const names = files.get(path) ?? new Set<string>();
      if (file.attributes.name && file.attributes.type)
        names.add(key(file.attributes.type.value, file.attributes.name.value));
      for (const child of file.children ?? []) {
        const name = child.attributes.name?.value;
        const type = child.name === 'item' ? child.attributes.type?.value : child.name;
        if (name && type) names.add(key(type, name));
        if (child.name === 'declare-styleable') {
          for (const attr of child.children ?? [])
            if (attr.name === 'attr' && attr.attributes.name)
              names.add(key('attr', attr.attributes.name.value));
        }
      }
      files.set(path, names);
    }
  }
  const destination = join(intermediates, 'merged_res', variant, task);
  // These are the extra roots used by AGP 9.4.1 MergeResources, not MapSourceSetPathsTask.
  const all = new Set([
    ...roots,
    destination,
    join(incremental, 'merged.dir'),
    join(incremental, 'stripped.dir'),
  ]);
  const pngs = join(moduleRoot, 'build', 'generated', 'res', 'pngs', variant);
  if (await metadata(pngs)) all.add(pngs);
  const ordered = [...all].sort((a, b) => {
    const x = a.replaceAll('\\', '/');
    const y = b.replaceAll('\\', '/');
    return x < y ? -1 : x > y ? 1 : 0;
  });
  const ids = new Map(
    ordered.map((path, i) => [
      computeSourceSetId(namespace, moduleRoot, basename(dirname(path)), i),
      path,
    ]),
  );
  return {
    roots: [...roots],
    files,
    ids,
    merger,
    merged: join(incremental, 'merged.dir'),
    blame: join(intermediates, 'merged_res_blame_folder', variant, task, 'out'),
  };
}

function decode(path: string, state: Snapshot): string {
  const split = path.indexOf(':/');
  if (split >= 0 && !/^[A-Za-z]:[\\/]/.test(path)) {
    const root = state.ids.get(path.slice(0, split));
    if (!root) throw new Error('Resource source ID does not belong to this snapshot');
    const result = resolve(root, path.slice(split + 2));
    if (!contained(root, result)) throw new Error('Invalid resource source path');
    return result;
  }
  return resolve(path);
}

function resourceFile(path: string, type: string, name: string): boolean {
  const folder = basename(dirname(path));
  return (
    (folder === type || folder.startsWith(`${type}-`)) &&
    basename(path).replace(/(?:\.9)?\.[^.]+$/, '') === name
  );
}

/** Verify membership, not historical line numbers, including newly introduced overrides. */
async function validateSources(
  state: Snapshot,
  wanted: string,
  type: string,
  name: string,
  moduleRoot: string,
  read: (path: string) => Promise<string>,
  documentPaths: readonly string[],
): Promise<void> {
  const current = new Set<string>();
  const mergeInfo = await metadata(state.merger);
  for (const root of state.roots) {
    let folders: string[];
    try {
      folders = await readdir(root);
    } catch {
      if ([...state.files].some(([path, keys]) => contained(root, path) && keys.has(wanted)))
        throw new Error('Resource directory removed');
      folders = [];
    }
    const dirty = documentPaths.filter((path) => contained(root, path));
    for (const path of dirty) {
      const folder = relative(root, path).split(sep)[0];
      if (!folders.includes(folder)) folders.push(folder);
    }
    for (const folder of folders) {
      const values = folder === 'values' || folder.startsWith('values-');
      const typed = folder === type || folder.startsWith(`${type}-`);
      if (!values && !typed && type !== 'id') continue;
      const directory = join(root, folder);
      let filenames: string[];
      try {
        filenames = await readdir(directory);
      } catch {
        filenames = [];
      }
      const paths = new Set(filenames.map((file) => join(directory, file)));
      for (const path of dirty)
        if (dirname(path).toLowerCase() === directory.toLowerCase()) paths.add(path);
      for (const path of paths) {
        const built = state.files.get(path)?.has(wanted) ?? false;
        if (values || type === 'id') {
          if (!path.endsWith('.xml')) continue;
          const info = await metadata(path);
          const inspect =
            built ||
            contained(dirname(moduleRoot), path) ||
            documentPaths.includes(path) ||
            !state.files.has(path) ||
            !info ||
            !mergeInfo ||
            info.mtimeMs > mergeInfo.mtimeMs;
          if (inspect) {
            const actual = declarations(await read(path)).has(wanted);
            if (actual !== built) throw new Error('Resource declarations changed since merge');
            if (actual) current.add(path);
          }
        } else if (typed && resourceFile(path, type, name)) {
          if (!built) throw new Error('New file resource override');
          current.add(path);
        }
      }
    }
  }
  for (const [path, keys] of state.files)
    if (keys.has(wanted) && !current.has(path)) throw new Error('Resource source removed');
}

export async function resolveResourceDefinition(
  options: ResolveResourceDefinitionOptions,
): Promise<LspLocation[] | null> {
  const { variant, namespace, type, name } = options;
  if (
    !/^[A-Za-z][\w]*$/.test(variant) ||
    !namespace ||
    !/^[a-z][a-z0-9_]*$/.test(type) ||
    !/^[A-Za-z_][\w]*$/.test(name)
  )
    return null;
  const moduleRoot = resolve(options.moduleRoot);
  let documentPaths = (options.documentPaths ?? []).map((path) => resolve(path));
  const readDocument = options.readDocument ?? ((path: string) => readFile(path, 'utf8'));
  const stamps = new Map<string, string>();
  const readArtifact = async (path: string): Promise<string> => {
    const before = await metadata(path);
    const text = await readFile(path, 'utf8');
    const after = await metadata(path);
    if (!before || JSON.stringify(before) !== JSON.stringify(after))
      throw new Error('Build outputs are changing');
    stamps.set(path, JSON.stringify(after));
    return text;
  };
  try {
    const state = await snapshot(moduleRoot, variant, namespace, readArtifact);
    if (process.platform === 'win32') {
      documentPaths = documentPaths.map(
        (path) =>
          [...state.files.keys()].find((known) => known.toLowerCase() === path.toLowerCase()) ??
          path,
      );
    }
    const mergeMetadata = await metadata(state.merger);
    if (!mergeMetadata) return null;
    const mergeTime = mergeMetadata.mtimeMs;
    for (const path of [
      join(moduleRoot, 'build.gradle.kts'),
      join(moduleRoot, 'build.gradle'),
      join(dirname(moduleRoot), 'settings.gradle.kts'),
      join(dirname(moduleRoot), 'settings.gradle'),
      join(dirname(moduleRoot), 'gradle', 'libs.versions.toml'),
    ]) {
      const info = await metadata(path);
      if (
        info &&
        (info.mtimeMs > mergeTime ||
          (documentPaths.includes(path) &&
            (await readDocument(path)) !== (await readFile(path, 'utf8'))))
      )
        return null;
    }
    const wanted = key(type, name);
    await validateSources(state, wanted, type, name, moduleRoot, readDocument, documentPaths);
    const results = new Map<string, LspLocation>();
    const addValue = async (path: string): Promise<void> => {
      if (!state.files.get(path)?.has(wanted)) throw new Error('Source is absent from merge state');
      const text = await readDocument(path);
      const matches = declarations(text).get(wanted);
      if (!matches?.length) throw new Error('Declaration no longer exists');
      for (const attr of matches) {
        const location = locationAt(path, text, attr.start, attr.end);
        results.set(JSON.stringify(location), location);
      }
    };
    let folders: string[] = [];
    try {
      folders = await readdir(state.merged);
    } catch {
      /* File-only resources do not require merged values. */
    }
    for (const folder of folders) {
      if (folder !== 'values' && !folder.startsWith('values-')) continue;
      const mergedFile = join(
        state.merged,
        folder,
        folder === 'values' ? 'values.xml' : `${folder}.xml`,
      );
      let mergedText: string;
      try {
        mergedText = await readArtifact(mergedFile);
      } catch {
        continue;
      }
      const element = parseXml(mergedText).find((el) => declaration(el) === wanted);
      if (!element) continue;
      const blame = JSON.parse(
        await readArtifact(join(state.blame, 'multi-v2', `${folder}.json`)),
      ) as {
        logs: Array<{
          outputFile: string;
          map: Array<{
            source: string;
            to: { startOffsets?: string; endOffsets?: string; startLines?: string };
          }>;
        }>;
      };
      let found = false;
      for (const log of blame.logs) {
        if (decode(log.outputFile, state) !== mergedFile) continue;
        for (const item of log.map) {
          const starts = numbers(item.to.startOffsets);
          const ends = numbers(item.to.endOffsets);
          const lines = numbers(item.to.startLines);
          const line = positionAt(mergedText, element.start).line;
          if (
            starts.some((start, i) => start <= element.start && ends[i] >= element.start) ||
            (!starts.length && lines.includes(line))
          ) {
            await addValue(decode(item.source, state));
            found = true;
          }
        }
      }
      if (!found) throw new Error('Missing values provenance');
    }
    const task = `merge${variant[0].toUpperCase()}${variant.slice(1)}Resources`;
    const singlePath = join(state.blame, 'single', `${task}.json`);
    if (await metadata(singlePath)) {
      const entries = JSON.parse(await readArtifact(singlePath)) as Array<{
        merged: string;
        source: string;
      }>;
      for (const entry of entries) {
        const path = decode(entry.source, state);
        if (!resourceFile(path, type, name)) continue;
        const output = decode(entry.merged, state);
        if (
          !contained(
            join(moduleRoot, 'build', 'intermediates', 'merged_res', variant, task),
            output,
          )
        )
          throw new Error('Wrong resource output scope');
        if (!state.files.get(path)?.has(wanted) || !(await metadata(path)))
          throw new Error('Missing file provenance');
        results.set(path, {
          uri: pathToFileURL(path).href,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        });
      }
    }
    for (const [path, stamp] of stamps)
      if (JSON.stringify(await metadata(path)) !== stamp) return null;
    return results.size ? [...results.values()] : null;
  } catch {
    return null;
  }
}
