import type { Dirent } from 'node:fs';
import { lstat, readdir, readFile, rm, statfs } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { isServerAlive, settings } from '../server/service.js';
import {
  canonicalizeProject,
  getActiveLeases,
  getAllProjectLedgers,
  type LeaseRecord,
  type ProjectRecord,
} from './metadata.js';

export async function computeDirectorySize(dirPath: string): Promise<number> {
  let totalBytes = 0;
  async function recurse(current: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = join(current, ent.name);
      try {
        const info = await lstat(full);
        if (info.isSymbolicLink()) continue;
        if (info.isDirectory()) {
          await recurse(full);
        } else if (info.isFile()) {
          totalBytes += info.size;
        }
      } catch {}
    }
  }
  await recurse(dirPath);
  return totalBytes;
}

export interface WorkspaceMapping {
  status: 'confirmed' | 'unknown';
  projectPath?: string;
  rootUri?: string;
}

export async function verifyWorkspaceEvidence(
  workspaceDir: string,
  knownLedgersMap: Map<string, ProjectRecord> = new Map(),
): Promise<WorkspaceMapping> {
  const cacheFile = join(workspaceDir, 'index', 'intellij-server', 'workspace-model-v2.cache');
  let buffer: Buffer;
  try {
    buffer = await readFile(cacheFile);
  } catch {
    return { status: 'unknown' };
  }

  const text = buffer.toString('latin1').toLowerCase().replace(/\\/g, '/');

  for (const [canonicalPath, record] of knownLedgersMap.entries()) {
    const key = canonicalPath.toLowerCase();
    if (text.includes(key)) {
      return {
        status: 'confirmed',
        projectPath: record.canonicalPath || canonicalPath,
        rootUri: record.rootUri || `file:///${canonicalPath}`,
      };
    }
  }

  const uriMatches = text.match(/file:\/\/\/[a-z]:\/[^\s\p{Cc}"'$<>]+/giu) || [];
  for (const raw of uriMatches) {
    try {
      const canonical = canonicalizeProject(raw);
      const buildMarker = ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle'];
      const hasBuild = buildMarker.some((m) =>
        text.includes(`${canonical.canonicalPath.toLowerCase()}/${m}`),
      );
      if (hasBuild) {
        return {
          status: 'confirmed',
          projectPath: canonical.canonicalPath,
          rootUri: canonical.rootUri,
        };
      }
    } catch {}
  }

  return { status: 'unknown' };
}

export interface WorkspaceInventoryItem {
  hash: string;
  path: string;
  logicalBytes: number;
  mapping: WorkspaceMapping;
  ledger: ProjectRecord | null;
  lastUsed: number | null;
  hasActiveLease: boolean;
}

export interface CacheInventory {
  workspacesDir: string;
  workspaces: WorkspaceInventoryItem[];
  totalLogicalBytes: number;
  confirmedLogicalBytes: number;
  unknownLogicalBytes: number;
  serverAlive: boolean;
  serverPid: number | null;
  activeLeases: LeaseRecord[];
}

export async function getCacheInventory(
  systemPath: string = settings.systemPath,
): Promise<CacheInventory> {
  const workspacesDir = join(systemPath, 'workspaces');
  const ledgers = await getAllProjectLedgers(systemPath);
  const activeLeases = await getActiveLeases(systemPath);
  const server = await isServerAlive(systemPath);

  let entries: string[] = [];
  try {
    entries = await readdir(workspacesDir);
  } catch (e: unknown) {
    if (e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT') {
      return {
        workspacesDir,
        workspaces: [],
        totalLogicalBytes: 0,
        confirmedLogicalBytes: 0,
        unknownLogicalBytes: 0,
        serverAlive: server.alive,
        serverPid: server.pid,
        activeLeases,
      };
    }
    throw e;
  }

  const workspaces: WorkspaceInventoryItem[] = [];
  let totalLogicalBytes = 0;
  let confirmedLogicalBytes = 0;
  let unknownLogicalBytes = 0;

  for (const entry of entries) {
    const candidatePath = join(workspacesDir, entry);
    try {
      const info = await lstat(candidatePath);
      if (info.isSymbolicLink() || !info.isDirectory()) continue;

      const logicalBytes = await computeDirectorySize(candidatePath);
      totalLogicalBytes += logicalBytes;

      const mapping = await verifyWorkspaceEvidence(candidatePath, ledgers);
      let ledger: ProjectRecord | null = null;
      let lastUsed: number | null = null;
      let hasActiveLease = false;

      const mappedPath = mapping.projectPath;
      if (mapping.status === 'confirmed' && mappedPath) {
        confirmedLogicalBytes += logicalBytes;
        ledger = ledgers.get(mappedPath) ?? null;
        if (ledger) {
          lastUsed = ledger.lastReady ?? ledger.lastConnected ?? null;
        }
        hasActiveLease = activeLeases.some(
          (l) => l.canonicalPath && l.canonicalPath.toLowerCase() === mappedPath.toLowerCase(),
        );
      } else {
        unknownLogicalBytes += logicalBytes;
      }

      workspaces.push({
        hash: entry,
        path: candidatePath,
        logicalBytes,
        mapping,
        ledger,
        lastUsed,
        hasActiveLease,
      });
    } catch {}
  }

  return {
    workspacesDir,
    workspaces,
    totalLogicalBytes,
    confirmedLogicalBytes,
    unknownLogicalBytes,
    serverAlive: server.alive,
    serverPid: server.pid,
    activeLeases,
  };
}

export interface PruneCandidate {
  hash: string;
  path: string;
  projectPath?: string;
  rootUri?: string;
  logicalBytes: number;
  lastUsed: number;
}

export function computePruneCandidates(
  inventory: CacheInventory,
  cachePolicy = settings.cachePolicy,
) {
  if (cachePolicy?.automaticDeletion === true) {
    throw new Error('automaticDeletion=true is not supported; must be false');
  }

  const retentionDays = Number.isFinite(cachePolicy?.retentionDays)
    ? cachePolicy.retentionDays
    : 30;
  const retentionMs = retentionDays * 86400 * 1000;
  const cutoffTime = Date.now() - retentionMs;

  const candidates: PruneCandidate[] = [];
  let candidateBytes = 0;
  const skipped = {
    unknownCount: 0,
    unknownBytes: 0,
    activeLeaseCount: 0,
    pinnedCount: 0,
    retainedCount: 0,
  };

  const canonicalWorkspacesDir = resolve(inventory.workspacesDir);

  for (const ws of inventory.workspaces) {
    if (ws.mapping.status !== 'confirmed') {
      skipped.unknownCount++;
      skipped.unknownBytes += ws.logicalBytes;
      continue;
    }

    if (ws.hasActiveLease) {
      skipped.activeLeaseCount++;
      continue;
    }

    if (ws.ledger?.pinned) {
      skipped.pinnedCount++;
      continue;
    }

    if (!ws.lastUsed || ws.lastUsed > cutoffTime) {
      skipped.retainedCount++;
      continue;
    }

    const resolvedPath = resolve(ws.path);
    const rel = relative(canonicalWorkspacesDir, resolvedPath);
    if (!rel || rel.includes('..') || isAbsolute(rel)) {
      continue;
    }

    candidates.push({
      hash: ws.hash,
      path: resolvedPath,
      projectPath: ws.mapping.projectPath,
      rootUri: ws.mapping.rootUri,
      logicalBytes: ws.logicalBytes,
      lastUsed: ws.lastUsed,
    });
    candidateBytes += ws.logicalBytes;
  }

  return {
    candidates,
    candidateBytes,
    retentionDays,
    cutoffTime,
    skipped,
  };
}

export async function applyPrune(
  candidates: PruneCandidate[],
  systemPath: string = settings.systemPath,
) {
  if (!Array.isArray(candidates)) throw new Error('Candidates array is required');
  const workspacesDir = resolve(join(systemPath, 'workspaces'));

  const server = await isServerAlive(systemPath);
  if (server.alive) {
    throw new Error(
      'Cannot prune cache while shared IntelliJ server is running (PID ' +
        server.pid +
        '). Server must be stopped before pruning.',
    );
  }

  const activeLeases = await getActiveLeases(systemPath);
  for (const cand of candidates) {
    const hasLease = activeLeases.some(
      (l) => l.canonicalPath && l.canonicalPath.toLowerCase() === cand.projectPath?.toLowerCase(),
    );
    if (hasLease) {
      throw new Error(`Cannot prune workspace ${cand.hash}: active connection lease detected.`);
    }
  }

  let initialFree = 0n;
  let finalFree = 0n;
  try {
    const st = await statfs(systemPath);
    initialFree = BigInt(st.bfree) * BigInt(st.bsize);
  } catch {}

  let deletedLogicalBytes = 0;
  const pruned: PruneCandidate[] = [];
  const failures: Array<{ hash: string; error: string }> = [];

  for (const cand of candidates) {
    const resolvedPath = resolve(cand.path);
    const rel = relative(workspacesDir, resolvedPath);
    if (!rel || rel.includes('..') || isAbsolute(rel)) {
      failures.push({ hash: cand.hash, error: `Path outside workspaces directory: ${cand.path}` });
      continue;
    }

    try {
      const st = await lstat(resolvedPath);
      if (st.isSymbolicLink()) {
        failures.push({
          hash: cand.hash,
          error: `Refusing to delete symlink or reparse target: ${cand.path}`,
        });
        continue;
      }
      await rm(resolvedPath, { recursive: true, force: true });
      deletedLogicalBytes += cand.logicalBytes;
      pruned.push(cand);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push({ hash: cand.hash, error: msg });
    }
  }

  try {
    const st = await statfs(systemPath);
    finalFree = BigInt(st.bfree) * BigInt(st.bsize);
  } catch {}

  const freeSpaceDelta = Number(finalFree - initialFree);

  return {
    deletedLogicalBytes,
    freeSpaceDelta,
    pruned,
    failures,
  };
}

export function formatBytes(bytes: unknown): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(1)} ${units[i]}`;
}
