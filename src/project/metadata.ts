import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { appendFile, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withLifecycleLock } from '../server/lifecycle-lock.js';

export interface CanonicalProject {
  canonicalPath: string;
  nativePath: string;
  rootUri: string;
  id: string;
  legacyId?: string;
  isCaseSensitive?: boolean;
}

export interface CanonicalizeOptions {
  caseSensitive?: boolean;
}
export interface MetadataDirs {
  base: string;
  projects: string;
  leases: string;
  connections: string;
}

export interface ProjectRecord {
  id: string | null;
  canonicalPath: string | null;
  nativePath: string | null;
  rootUri: string | null;
  lastConnected: number | null;
  lastReady: number | null;
  connectionsCount: number;
  pinned: boolean;
}

export interface LeaseRecord {
  id: string;
  pid: number;
  kind: string;
  projectId: string | null;
  canonicalPath: string | null;
  rootUri: string | null;
  createdAt: number;
}

export interface LeaseHandle {
  id: string;
  record: LeaseRecord;
  release: () => Promise<void>;
}

const MAX_CASE_CACHE_SIZE = 512;
const caseSensitivityCache = new Map<string, boolean>();

function getCachedCaseSensitivity(key: string): boolean | undefined {
  const value = caseSensitivityCache.get(key);
  if (value !== undefined) {
    caseSensitivityCache.delete(key);
    caseSensitivityCache.set(key, value);
  }
  return value;
}

function setCachedCaseSensitivity(key: string, value: boolean): void {
  if (caseSensitivityCache.has(key)) {
    caseSensitivityCache.delete(key);
  } else if (caseSensitivityCache.size >= MAX_CASE_CACHE_SIZE) {
    const oldestKey = caseSensitivityCache.keys().next().value;
    if (oldestKey !== undefined) {
      caseSensitivityCache.delete(oldestKey);
    }
  }
  caseSensitivityCache.set(key, value);
}

export function isPathCaseSensitive(targetPath: string): boolean {
  const resolved = resolve(targetPath);
  const cached = getCachedCaseSensitivity(resolved);
  if (cached !== undefined) return cached;

  if (!existsSync(resolved)) {
    const fallback = process.platform !== 'win32' && process.platform !== 'darwin';
    return fallback;
  }

  let result = process.platform !== 'win32' && process.platform !== 'darwin';
  try {
    const base = basename(resolved);
    const parent = dirname(resolved);
    if (base && parent !== resolved && /[a-zA-Z]/.test(base)) {
      const toggled = base.replace(/[a-zA-Z]/, (c) =>
        c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase(),
      );
      const toggledPath = join(parent, toggled);
      if (!existsSync(toggledPath)) {
        result = true;
      } else {
        try {
          const s1 = statSync(resolved, { bigint: true });
          const s2 = statSync(toggledPath, { bigint: true });
          result = s1.ino !== s2.ino || s1.dev !== s2.dev;
        } catch {
          result = true;
        }
      }
    } else {
      try {
        const entries = readdirSync(resolved);
        for (const entry of entries) {
          if (/[a-zA-Z]/.test(entry)) {
            const toggled = entry.replace(/[a-zA-Z]/, (c) =>
              c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase(),
            );
            const childPath = join(resolved, entry);
            const toggledPath = join(resolved, toggled);
            if (!existsSync(toggledPath)) {
              result = true;
              break;
            }
            const s1 = statSync(childPath, { bigint: true });
            const s2 = statSync(toggledPath, { bigint: true });
            result = s1.ino !== s2.ino || s1.dev !== s2.dev;
            break;
          }
        }
      } catch {}
    }
  } catch {}

  setCachedCaseSensitivity(resolved, result);
  return result;
}

export function pathsEqual(a: string, b: string, options?: CanonicalizeOptions): boolean {
  const ca = canonicalizeProject(a, options);
  const cb = canonicalizeProject(b, options);
  return ca.id === cb.id;
}

export function verifyRecordedPathAttribution(
  rawContent: string,
  canonical: CanonicalProject,
): boolean {
  try {
    const parsed = JSON.parse(rawContent) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return false;

    const recordedCanonical = parsed.canonicalPath ?? parsed.canonical;
    const recordedNative =
      parsed.projectPath ?? parsed.nativePath ?? parsed.projectRoot ?? parsed.rootPath;
    if (typeof recordedCanonical === 'string' && recordedCanonical) {
      return pathsEqual(recordedCanonical, canonical.canonicalPath, {
        caseSensitive: canonical.isCaseSensitive,
      });
    }
    if (typeof recordedNative === 'string' && recordedNative) {
      return (
        pathsEqual(recordedNative, canonical.nativePath, {
          caseSensitive: canonical.isCaseSensitive,
        }) ||
        pathsEqual(recordedNative, canonical.canonicalPath, {
          caseSensitive: canonical.isCaseSensitive,
        })
      );
    }

    const rootUri =
      parsed.rootUri ?? (parsed.workspaceFolders as Array<{ uri?: string }> | undefined)?.[0]?.uri;
    if (typeof rootUri === 'string' && rootUri) {
      return pathsEqual(rootUri, canonical.rootUri, {
        caseSensitive: canonical.isCaseSensitive,
      });
    }

    if (parsed.__metadata && typeof parsed.__metadata === 'object') {
      const meta = parsed.__metadata as Record<string, unknown>;
      const metaPath = meta.canonicalPath ?? meta.projectPath ?? meta.nativePath;
      if (typeof metaPath === 'string' && metaPath) {
        return pathsEqual(metaPath, canonical.canonicalPath, {
          caseSensitive: canonical.isCaseSensitive,
        });
      }
    }
  } catch {}
  return false;
}

export async function migrateProjectMetadata(
  systemPath: string,
  canonical: CanonicalProject,
): Promise<void> {
  const { id, legacyId } = canonical;
  if (!legacyId || legacyId === id) return;

  const metaDir = join(systemPath, 'plugin-metadata');

  // 1. raw-config/<legacyId>.json -> raw-config/<id>.json
  const rawConfigDir = join(metaDir, 'raw-config');
  const targetRawConfig = join(rawConfigDir, `${id}.json`);
  const legacyRawConfig = join(rawConfigDir, `${legacyId}.json`);
  if (!existsSync(targetRawConfig) && existsSync(legacyRawConfig)) {
    try {
      const raw = await readFile(legacyRawConfig, 'utf8');
      if (verifyRecordedPathAttribution(raw, canonical)) {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if ('id' in parsed) parsed.id = id;
        if (parsed.__metadata && typeof parsed.__metadata === 'object') {
          (parsed.__metadata as Record<string, unknown>).id = id;
        }
        await mkdir(rawConfigDir, { recursive: true });
        await writeAtomicJson(targetRawConfig, parsed);
      }
    } catch {}
  }

  // 2. initialize-<legacyId>.json -> initialize-<id>.json
  const targetInit = join(metaDir, `initialize-${id}.json`);
  const legacyInit = join(metaDir, `initialize-${legacyId}.json`);
  if (!existsSync(targetInit) && existsSync(legacyInit)) {
    try {
      const raw = await readFile(legacyInit, 'utf8');
      if (verifyRecordedPathAttribution(raw, canonical)) {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if ('id' in parsed) parsed.id = id;
        await mkdir(metaDir, { recursive: true });
        await writeAtomicJson(targetInit, parsed);
      }
    } catch {}
  }

  // 3. receipts/<legacyId>.applied.json and receipts/<legacyId>.import-status.json
  const receiptsDir = join(metaDir, 'receipts');
  for (const suffix of ['.applied.json', '.import-status.json']) {
    const targetReceipt = join(receiptsDir, `${id}${suffix}`);
    const legacyReceipt = join(receiptsDir, `${legacyId}${suffix}`);
    if (!existsSync(targetReceipt) && existsSync(legacyReceipt)) {
      try {
        const raw = await readFile(legacyReceipt, 'utf8');
        if (verifyRecordedPathAttribution(raw, canonical)) {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          if ('id' in parsed) parsed.id = id;
          await mkdir(receiptsDir, { recursive: true });
          await writeAtomicJson(targetReceipt, parsed);
        }
      } catch {}
    }
  }

  // 4. projects/<legacyId>.events.jsonl -> projects/<id>.events.jsonl
  const projectsDir = join(metaDir, 'projects');
  const targetEvents = join(projectsDir, `${id}.events.jsonl`);
  const legacyEvents = join(projectsDir, `${legacyId}.events.jsonl`);
  if (!existsSync(targetEvents) && existsSync(legacyEvents)) {
    try {
      const raw = await readFile(legacyEvents, 'utf8');
      const ledger = foldLedger(raw);
      if (ledger && verifyRecordedPathAttribution(JSON.stringify(ledger), canonical)) {
        await mkdir(projectsDir, { recursive: true });
        await writeFile(targetEvents, raw, 'utf8');
      }
    } catch {}
  }
}

export function canonicalizeProject(
  inputPathOrUri: string,
  options?: CanonicalizeOptions,
): CanonicalProject {
  if (!inputPathOrUri) throw new Error('Project path or URI is required');
  const projectPath =
    typeof inputPathOrUri === 'string' && inputPathOrUri.startsWith('file://')
      ? fileURLToPath(inputPathOrUri)
      : inputPathOrUri;
  const resolved = resolve(projectPath);
  const normalized = resolved
    .replace(/\\/g, '/')
    .replace(/^([A-Za-z]):/, (_, drive) => `${drive.toLowerCase()}:`);
  const rootUri = pathToFileURL(resolved).href;

  const caseSensitive =
    options?.caseSensitive !== undefined ? options.caseSensitive : isPathCaseSensitive(resolved);

  const legacyId = createHash('sha256').update(normalized.toLowerCase()).digest('hex');
  // Keep exact-path IDs disjoint from legacy folded IDs, including all-lowercase paths.
  const id = caseSensitive
    ? createHash('sha256').update('case-sensitive\0').update(normalized).digest('hex')
    : legacyId;

  return {
    canonicalPath: normalized,
    nativePath: resolved,
    rootUri,
    id,
    legacyId,
    isCaseSensitive: caseSensitive,
  };
}

export function getMetadataDirs(systemPath: string): MetadataDirs {
  const base = join(systemPath, 'plugin-metadata');
  return {
    base,
    projects: join(base, 'projects'),
    leases: join(base, 'leases'),
    connections: join(base, 'connections'),
  };
}

async function writeAtomicJson(filePath: string, data: unknown): Promise<void> {
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(tempPath, JSON.stringify(data, null, 2), 'utf8');
  await rename(tempPath, filePath);
}

function eventsFile(dirs: MetadataDirs, id: string): string {
  return join(dirs.projects, `${id}.events.jsonl`);
}

export function foldLedger(text: string): ProjectRecord | null {
  const record: ProjectRecord = {
    id: null,
    canonicalPath: null,
    nativePath: null,
    rootUri: null,
    lastConnected: null,
    lastReady: null,
    connectionsCount: 0,
    pinned: false,
  };
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof event.id === 'string') record.id ??= event.id;
    if (typeof event.canonicalPath === 'string') record.canonicalPath ??= event.canonicalPath;
    if (typeof event.nativePath === 'string') record.nativePath ??= event.nativePath;
    if (typeof event.rootUri === 'string') record.rootUri ??= event.rootUri;
    if (event.kind === 'connection') {
      record.connectionsCount += 1;
      const at = typeof event.at === 'number' ? event.at : Number(event.at) || 0;
      record.lastConnected = Math.max(record.lastConnected ?? 0, at);
    } else if (event.kind === 'ready') {
      const at = typeof event.at === 'number' ? event.at : Number(event.at) || 0;
      record.lastReady = Math.max(record.lastReady ?? 0, at);
    } else if (event.kind === 'pin') {
      record.pinned = event.pinned === true;
    }
  }
  if (!record.canonicalPath && record.lastConnected === null && record.lastReady === null)
    return null;
  return record;
}

async function appendLedgerEvent(
  systemPath: string,
  projectPath: string,
  event: Record<string, unknown>,
): Promise<ProjectRecord | null> {
  if (!projectPath) return null;
  const { id, canonicalPath, nativePath, rootUri } = canonicalizeProject(projectPath);
  const dirs = getMetadataDirs(systemPath);
  await mkdir(dirs.projects, { recursive: true });
  const line = `${JSON.stringify({ id, canonicalPath, nativePath, rootUri, ...event })}\n`;
  await appendFile(eventsFile(dirs, id), line, 'utf8');
  return foldLedger(await readFile(eventsFile(dirs, id), 'utf8'));
}

export async function recordConnection(
  systemPath: string,
  projectPath: string,
  timestamp: number = Date.now(),
): Promise<ProjectRecord | null> {
  return appendLedgerEvent(systemPath, projectPath, { kind: 'connection', at: timestamp });
}

export async function recordReadiness(
  systemPath: string,
  projectPath: string,
  timestamp: number = Date.now(),
): Promise<ProjectRecord | null> {
  return appendLedgerEvent(systemPath, projectPath, { kind: 'ready', at: timestamp });
}

export async function recordPinned(
  systemPath: string,
  projectPath: string,
  pinned: boolean = true,
): Promise<ProjectRecord | null> {
  return appendLedgerEvent(systemPath, projectPath, { kind: 'pin', pinned: pinned === true });
}

export async function createLeaseUnlocked(
  systemPath: string,
  options: { kind?: string; projectPath?: string; pid?: number } = {},
): Promise<LeaseHandle> {
  const { kind = 'bridge', projectPath, pid = process.pid } = options;
  const {
    canonicalPath,
    rootUri,
    id: projectId,
  } = projectPath
    ? canonicalizeProject(projectPath)
    : { canonicalPath: null, rootUri: null, id: null };
  const dirs = getMetadataDirs(systemPath);
  await mkdir(dirs.leases, { recursive: true });
  const leaseId = randomUUID();
  const leaseFile = join(dirs.leases, `${leaseId}.json`);
  const record: LeaseRecord = {
    id: leaseId,
    pid,
    kind,
    projectId,
    canonicalPath,
    rootUri,
    createdAt: Date.now(),
  };
  await writeAtomicJson(leaseFile, record);

  let released = false;
  return {
    id: leaseId,
    record,
    release: async () => {
      if (released) return;
      released = true;
      try {
        await unlink(leaseFile);
      } catch (e: unknown) {
        if ((e as { code?: string }).code !== 'ENOENT') throw e;
      }
    },
  };
}

export async function createLease(
  systemPath: string,
  options: { kind?: string; projectPath?: string; pid?: number } = {},
): Promise<LeaseHandle> {
  return withLifecycleLock(() => createLeaseUnlocked(systemPath, options), {
    systemPath,
    timeoutMs: 5000,
  });
}

export async function replaceLease(
  systemPath: string,
  oldLease: LeaseHandle | null,
  options: { kind?: string; projectPath?: string; pid?: number } = {},
): Promise<LeaseHandle> {
  return withLifecycleLock(
    async () => {
      const newLease = await createLeaseUnlocked(systemPath, options);
      if (oldLease) {
        await oldLease.release().catch(() => {});
      }
      return newLease;
    },
    { systemPath, timeoutMs: 5000 },
  );
}

export async function getActiveLeases(systemPath: string): Promise<LeaseRecord[]> {
  const dirs = getMetadataDirs(systemPath);
  const active: LeaseRecord[] = [];
  let entries: string[] = [];
  try {
    entries = await readdir(dirs.leases);
  } catch (e: unknown) {
    if ((e as { code?: string }).code === 'ENOENT') return [];
    throw e;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const file = join(dirs.leases, entry);
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (e: unknown) {
      if ((e as { code?: string }).code === 'ENOENT') continue;
      throw new Error(
        `Failed to read lease file at ${file}: ${e instanceof Error ? e.message : String(e)}`,
        { cause: e },
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e: unknown) {
      throw new Error(`Corrupt lease file (malformed JSON) at ${file}`, { cause: e });
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Corrupt lease file (root is not an object) at ${file}`);
    }

    const lease = parsed as LeaseRecord;
    if (!Number.isSafeInteger(lease.pid) || lease.pid < 1) {
      throw new Error(`Invalid PID ${String(lease.pid)} in lease file at ${file}`);
    }

    let alive = false;
    try {
      process.kill(lease.pid, 0);
      alive = true;
    } catch (err: unknown) {
      if ((err as { code?: string }).code !== 'ESRCH') alive = true;
    }

    if (alive) {
      active.push(lease);
    } else {
      try {
        await unlink(file);
      } catch (err: unknown) {
        if ((err as { code?: string }).code !== 'ENOENT') throw err;
      }
    }
  }
  return active;
}

export async function getProjectLedger(
  systemPath: string,
  projectPath: string,
): Promise<ProjectRecord | null> {
  if (!projectPath) return null;
  const canonical = canonicalizeProject(projectPath);
  const { id, legacyId } = canonical;
  const dirs = getMetadataDirs(systemPath);
  try {
    const record = foldLedger(await readFile(eventsFile(dirs, id), 'utf8'));
    if (record) return record;
  } catch (e: unknown) {
    if ((e as { code?: string }).code !== 'ENOENT') return null;
  }
  try {
    const record = JSON.parse(
      await readFile(join(dirs.projects, `${id}.json`), 'utf8'),
    ) as ProjectRecord;
    if (record) return record;
  } catch {}

  if (legacyId && legacyId !== id) {
    try {
      const legacyRaw = await readFile(eventsFile(dirs, legacyId), 'utf8');
      const legacyRecord = foldLedger(legacyRaw);
      if (legacyRecord && verifyRecordedPathAttribution(JSON.stringify(legacyRecord), canonical)) {
        await mkdir(dirs.projects, { recursive: true });
        await writeFile(eventsFile(dirs, id), legacyRaw, 'utf8');
        return legacyRecord;
      }
    } catch {}

    try {
      const legacyRaw = await readFile(join(dirs.projects, `${legacyId}.json`), 'utf8');
      const legacyRecord = JSON.parse(legacyRaw) as ProjectRecord;
      if (legacyRecord && verifyRecordedPathAttribution(legacyRaw, canonical)) {
        return legacyRecord;
      }
    } catch {}
  }

  return null;
}

export async function getAllProjectLedgers(
  systemPath: string,
): Promise<Map<string, ProjectRecord>> {
  const dirs = getMetadataDirs(systemPath);
  const map = new Map<string, ProjectRecord>();
  let entries: string[] = [];
  try {
    entries = await readdir(dirs.projects);
  } catch {
    return map;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.events.jsonl')) continue;
    try {
      const record = foldLedger(await readFile(join(dirs.projects, entry), 'utf8'));
      if (record?.canonicalPath) map.set(record.canonicalPath, record);
    } catch {}
  }
  return map;
}
