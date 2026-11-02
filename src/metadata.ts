import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export interface CanonicalProject {
  canonicalPath: string;
  nativePath: string;
  rootUri: string;
  id: string;
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

export function canonicalizeProject(inputPathOrUri: string): CanonicalProject {
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
  const id = createHash('sha256').update(normalized.toLowerCase()).digest('hex');
  return { canonicalPath: normalized, nativePath: resolved, rootUri, id };
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
  const line = JSON.stringify({ id, canonicalPath, nativePath, rootUri, ...event }) + '\n';
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

export async function createLease(
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
    try {
      const lease = JSON.parse(await readFile(file, 'utf8')) as LeaseRecord;
      if (!Number.isSafeInteger(lease.pid) || lease.pid < 1) continue;
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
        } catch {}
      }
    } catch {}
  }
  return active;
}

export async function getProjectLedger(
  systemPath: string,
  projectPath: string,
): Promise<ProjectRecord | null> {
  if (!projectPath) return null;
  const { id } = canonicalizeProject(projectPath);
  const dirs = getMetadataDirs(systemPath);
  try {
    return foldLedger(await readFile(eventsFile(dirs, id), 'utf8'));
  } catch (e: unknown) {
    if ((e as { code?: string }).code !== 'ENOENT') return null;
  }
  try {
    return JSON.parse(await readFile(join(dirs.projects, `${id}.json`), 'utf8')) as ProjectRecord;
  } catch {
    return null;
  }
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
