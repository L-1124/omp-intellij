import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonicalizeProject } from './metadata.js';

export interface ProjectConfigurationSnapshot {
  id: string;
  projectPath: string;
  rootUri: string;
  updatedAt: number;
  settings: Record<string, unknown>;
  sectionResponses?: Record<string, unknown>;
  rawInitializationOptions?: Record<string, unknown>;
}

export interface ConfigurationItemQuery {
  scopeUri?: string;
  section?: string;
}

export function resolveConfigurationSection(settings: unknown, section?: string | null): unknown {
  if (settings === null || settings === undefined || typeof settings !== 'object') {
    return null;
  }
  if (section === undefined || section === null || section === '') {
    return settings;
  }
  if (typeof section !== 'string') {
    return null;
  }

  const record = settings as Record<string, unknown>;

  // Literal key match (including keys with spaces or dots) takes precedence
  if (Object.hasOwn(record, section)) {
    const val = record[section];
    return val !== undefined ? val : null;
  }

  // Dotted traversal preferring longest literal prefix key
  const keys = Object.keys(record);
  const candidatePrefixes = keys.filter((key) => section.startsWith(`${key}.`));
  candidatePrefixes.sort((a, b) => b.length - a.length);

  for (const prefix of candidatePrefixes) {
    const remainder = section.slice(prefix.length + 1);
    const child = record[prefix];
    const resolved = resolveConfigurationSection(child, remainder);
    if (resolved !== null && resolved !== undefined) {
      return resolved;
    }
  }

  return null;
}

export function normalizeScopeUri(scopeUri?: string | null): string | null {
  if (!scopeUri) return null;
  try {
    const targetPath = scopeUri.startsWith('file:') ? fileURLToPath(scopeUri) : resolve(scopeUri);
    return pathToFileURL(resolve(targetPath)).href;
  } catch {
    return scopeUri;
  }
}

export function makeResponseKey(scopeUri?: string | null, section?: string | null): string {
  const normScope = normalizeScopeUri(scopeUri);
  const normSec = section === undefined || section === null || section === '' ? null : section;
  return JSON.stringify([normScope, normSec]);
}

export function isPathInside(filePath: string, dirPath: string): boolean {
  const normFile = resolve(filePath).replace(/\\/g, '/');
  const normDir = resolve(dirPath).replace(/\\/g, '/');

  const fileCased = process.platform === 'win32' ? normFile.toLowerCase() : normFile;
  const dirCased = process.platform === 'win32' ? normDir.toLowerCase() : normDir;

  if (fileCased === dirCased) return true;
  // Ensure trailing separator boundary so adjacent prefix paths do not match
  const prefix = dirCased.endsWith('/') ? dirCased : `${dirCased}/`;
  return fileCased.startsWith(prefix);
}

export function getRawConfigDir(systemPath: string): string {
  return join(systemPath, 'plugin-metadata', 'raw-config');
}

export function getProjectConfigPath(systemPath: string, projectId: string): string {
  return join(getRawConfigDir(systemPath), `${projectId}.json`);
}

export async function loadProjectConfiguration(
  systemPath: string,
  projectId: string,
): Promise<ProjectConfigurationSnapshot | null> {
  const target = getProjectConfigPath(systemPath, projectId);
  let raw: string;
  try {
    raw = await readFile(target, 'utf8');
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }

  // Validate critical snapshot fields; reject truncated or malformed records
  const parsed: unknown = JSON.parse(raw);
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    typeof (parsed as ProjectConfigurationSnapshot).id !== 'string' ||
    (parsed as ProjectConfigurationSnapshot).id !== projectId ||
    typeof (parsed as ProjectConfigurationSnapshot).projectPath !== 'string' ||
    typeof (parsed as ProjectConfigurationSnapshot).rootUri !== 'string' ||
    !(parsed as ProjectConfigurationSnapshot).settings ||
    typeof (parsed as ProjectConfigurationSnapshot).settings !== 'object' ||
    Array.isArray((parsed as ProjectConfigurationSnapshot).settings)
  ) {
    throw new Error(`Malformed project configuration snapshot for ${projectId}`);
  }
  return parsed as ProjectConfigurationSnapshot;
}

export async function saveProjectConfiguration(
  systemPath: string,
  snapshot: ProjectConfigurationSnapshot,
): Promise<void> {
  const dir = getRawConfigDir(systemPath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = getProjectConfigPath(systemPath, snapshot.id);
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(snapshot, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temp, target);
  } finally {
    // Ensure leftover temp file is cleaned up if write or rename fails
    await rm(temp, { force: true }).catch(() => {});
  }
}

export async function updateProjectSettings(
  systemPath: string,
  projectId: string,
  newSettings: Record<string, unknown>,
  context?: {
    projectPath?: string;
    rootUri?: string;
    rawInitializationOptions?: Record<string, unknown>;
  },
): Promise<ProjectConfigurationSnapshot> {
  const existing = await loadProjectConfiguration(systemPath, projectId);

  // LSP didChangeConfiguration is a replacement snapshot:
  // discard stale section responses so deleted settings do not resurrect
  const snapshot: ProjectConfigurationSnapshot = {
    id: projectId,
    projectPath: context?.projectPath ?? existing?.projectPath ?? '',
    rootUri: context?.rootUri ?? existing?.rootUri ?? '',
    updatedAt: Date.now(),
    settings: newSettings,
    sectionResponses: undefined,
    rawInitializationOptions:
      context?.rawInitializationOptions ?? existing?.rawInitializationOptions,
  };

  await saveProjectConfiguration(systemPath, snapshot);
  return snapshot;
}

export async function findProjectIdForScope(
  systemPath: string,
  defaultProjectId: string,
  scopeUri?: string,
): Promise<string | null> {
  if (!scopeUri) {
    return defaultProjectId;
  }

  let targetPath: string;
  try {
    targetPath = scopeUri.startsWith('file:') ? fileURLToPath(scopeUri) : resolve(scopeUri);
  } catch {
    return null;
  }

  const defaultSnap = await loadProjectConfiguration(systemPath, defaultProjectId);
  let bestId =
    defaultSnap?.projectPath && isPathInside(targetPath, defaultSnap.projectPath)
      ? defaultProjectId
      : null;
  let bestLength = bestId && defaultSnap ? resolve(defaultSnap.projectPath).length : -1;

  const configDir = getRawConfigDir(systemPath);
  let entries: string[];
  try {
    entries = await readdir(configDir);
  } catch {
    return bestId;
  }

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const projectId = entry.slice(0, -5);
    if (projectId === defaultProjectId) continue;
    const snapshot = await loadProjectConfiguration(systemPath, projectId).catch(() => null);
    if (!snapshot?.projectPath || !isPathInside(targetPath, snapshot.projectPath)) continue;
    const length = resolve(snapshot.projectPath).length;
    if (
      length > bestLength ||
      (length === bestLength &&
        bestId !== defaultProjectId &&
        (bestId === null || projectId < bestId))
    ) {
      bestId = projectId;
      bestLength = length;
    }
  }

  return bestId;
}

export async function recordConfigurationItems(
  systemPath: string,
  defaultProjectId: string,
  items: ConfigurationItemQuery[],
  results: unknown[],
): Promise<void> {
  const byProject = new Map<string, Record<string, unknown>>();

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const val = results[i];
    if (!item) continue;

    const projectId = await findProjectIdForScope(systemPath, defaultProjectId, item.scopeUri);
    if (!projectId) continue;

    let map = byProject.get(projectId);
    if (!map) {
      map = {};
      byProject.set(projectId, map);
    }

    // Binary key encoding [scopeUri, section] ensures scopes never overwrite each other
    const key = makeResponseKey(item.scopeUri, item.section);
    map[key] = val;
  }

  for (const [projId, capturedResponses] of byProject.entries()) {
    const existing = await loadProjectConfiguration(systemPath, projId);
    if (!existing) continue;

    const updatedResponses = {
      ...(existing.sectionResponses || {}),
      ...capturedResponses,
    };

    const snapshot: ProjectConfigurationSnapshot = {
      ...existing,
      updatedAt: Date.now(),
      sectionResponses: updatedResponses,
    };

    await saveProjectConfiguration(systemPath, snapshot);
  }
}

export async function resolveConfigurationItems(
  systemPath: string,
  defaultProjectId: string,
  items: ConfigurationItemQuery[],
): Promise<unknown[]> {
  const cache = new Map<string, ProjectConfigurationSnapshot | null>();

  async function getSnapshot(projId: string): Promise<ProjectConfigurationSnapshot | null> {
    const cached = cache.get(projId);
    if (cached !== undefined) {
      return cached;
    }
    const snap = await loadProjectConfiguration(systemPath, projId);
    cache.set(projId, snap);
    return snap;
  }

  const results: unknown[] = [];

  for (const item of items) {
    const targetProjectId = await findProjectIdForScope(
      systemPath,
      defaultProjectId,
      item.scopeUri,
    );

    if (!targetProjectId) {
      // Unknown external scope returns null
      results.push(null);
      continue;
    }

    const snapshot = await getSnapshot(targetProjectId);
    if (!snapshot) {
      results.push(null);
      continue;
    }

    const normScope = normalizeScopeUri(item.scopeUri);
    const scopedKey = makeResponseKey(normScope, item.section);
    if (snapshot.sectionResponses && Object.hasOwn(snapshot.sectionResponses, scopedKey)) {
      const val = snapshot.sectionResponses[scopedKey];
      results.push(val !== undefined ? val : null);
      continue;
    }

    // Derive from same-scope parent section or whole-section response if captured
    if (item.section && snapshot.sectionResponses) {
      const candidateParents: Array<{ prefix: string | null; value: unknown }> = [];
      for (const [rawKey, respVal] of Object.entries(snapshot.sectionResponses)) {
        let parsedKey: unknown;
        try {
          parsedKey = JSON.parse(rawKey);
        } catch {
          continue;
        }
        if (!Array.isArray(parsedKey) || parsedKey.length !== 2) continue;
        const [kScope, kSec] = parsedKey as [string | null, string | null];
        if (kScope !== normScope) continue;

        if (kSec === null) {
          candidateParents.push({ prefix: null, value: respVal });
        } else if (typeof kSec === 'string' && item.section.startsWith(`${kSec}.`)) {
          candidateParents.push({ prefix: kSec, value: respVal });
        }
      }

      candidateParents.sort((a, b) => {
        const lenA = a.prefix ? a.prefix.length : -1;
        const lenB = b.prefix ? b.prefix.length : -1;
        return lenB - lenA;
      });

      let foundFromParent = false;
      for (const candidate of candidateParents) {
        const remainder = candidate.prefix
          ? item.section.slice(candidate.prefix.length + 1)
          : item.section;
        const childVal = resolveConfigurationSection(candidate.value, remainder);
        if (childVal !== null && childVal !== undefined) {
          results.push(childVal);
          foundFromParent = true;
          break;
        }
      }
      if (foundFromParent) {
        continue;
      }
    }

    // Fall back to resolving from dynamic settings; never borrow another scope's response
    const resolved = resolveConfigurationSection(snapshot.settings, item.section);
    results.push(resolved !== undefined ? resolved : null);
  }
  return results;
}

export async function loadDefaultPluginSettings(): Promise<Record<string, unknown>> {
  const candidates: URL[] = [
    new URL('../../.omp-plugin/marketplace.json', import.meta.url),
    new URL('../../../.omp-plugin/marketplace.json', import.meta.url),
  ];

  for (const url of candidates) {
    let content: string;
    try {
      content = await readFile(url, 'utf8');
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
        continue;
      }
      throw err;
    }

    const catalog = JSON.parse(content) as {
      plugins?: Array<{
        name?: string;
        lspServers?: {
          'intellij-server'?: {
            settings?: Record<string, unknown>;
          };
        };
      }>;
    };
    const plugin = catalog.plugins?.find((p) => p.name === 'omp-intellij');
    const defaultSettings = plugin?.lspServers?.['intellij-server']?.settings;
    if (defaultSettings && typeof defaultSettings === 'object') {
      return JSON.parse(JSON.stringify(defaultSettings)) as Record<string, unknown>;
    }
    throw new Error(
      'Manifest .omp-plugin/marketplace.json does not declare intellij-server settings',
    );
  }

  throw new Error('Unable to locate .omp-plugin/marketplace.json');
}

export function stripRedactedPlaceholders<T>(value: T): T {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'string') {
    return value.includes('[REDACTED]') ? (undefined as unknown as T) : value;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => stripRedactedPlaceholders(item))
      .filter((item) => item !== undefined) as unknown as T;
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      const stripped = stripRedactedPlaceholders(val);
      if (stripped !== undefined) {
        result[key] = stripped;
      }
    }
    return result as T;
  }
  return value;
}

export async function getHostInitializationOptions(
  systemPath: string,
  projectId: string,
): Promise<Record<string, unknown> | null> {
  try {
    const rawSnapshot = await loadProjectConfiguration(systemPath, projectId);
    if (
      rawSnapshot?.rawInitializationOptions &&
      typeof rawSnapshot.rawInitializationOptions === 'object'
    ) {
      // Raw host options are returned verbatim; never stripped
      return JSON.parse(JSON.stringify(rawSnapshot.rawInitializationOptions));
    }
  } catch (err: unknown) {
    if (!err || typeof err !== 'object' || !('code' in err) || err.code !== 'ENOENT') {
      throw err;
    }
  }

  // Legacy fallback: initialize-${id}.json was sanitized by sanitizeStatus, so scrub artificial placeholders
  try {
    const recordedPath = join(systemPath, 'plugin-metadata', `initialize-${projectId}.json`);
    const raw = await readFile(recordedPath, 'utf8');
    const recorded = JSON.parse(raw) as {
      rootUri?: string;
      rootPath?: string;
      workspaceFolders?: Array<{ uri?: string }>;
      rawInitializationOptions?: Record<string, unknown>;
      initializationOptions?: Record<string, unknown>;
    };
    const root = recorded?.rootUri || recorded?.rootPath || recorded?.workspaceFolders?.[0]?.uri;
    if (!root || canonicalizeProject(root).id !== projectId) return null;
    const candidate = recorded?.rawInitializationOptions || recorded?.initializationOptions;
    if (candidate && typeof candidate === 'object') {
      return stripRedactedPlaceholders(candidate);
    }
  } catch {}

  return null;
}
