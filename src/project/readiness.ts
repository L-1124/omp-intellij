import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { settings } from '../server/service.js';
import type { FailureDetail, LicenseSummary } from '../shared/runtime-status.js';
import { type ProjectStateResult, readProjectState } from './connection-state.js';

export const PROJECT_ROOT_MARKERS = [
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
  '.idea',
] as const;

function hasProjectMarker(dir: string): boolean {
  for (const marker of PROJECT_ROOT_MARKERS) {
    if (existsSync(join(dir, marker))) {
      return true;
    }
  }
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.iml')) {
        return true;
      }
    }
  } catch {}
  return false;
}

export function findProjectRoot(startPath?: string): string {
  const raw = startPath && startPath.trim().length > 0 ? startPath : process.cwd();
  const normalizedPath = raw.startsWith('file:') ? fileURLToPath(raw) : raw;

  let current = resolve(normalizedPath);
  try {
    if (existsSync(current) && statSync(current).isFile()) {
      current = dirname(current);
    }
  } catch {
    current = dirname(current);
  }

  let fallbackGit: string | null = null;
  let cursor = current;
  while (true) {
    if (hasProjectMarker(cursor)) {
      return cursor;
    }
    if (!fallbackGit && existsSync(join(cursor, '.git'))) {
      fallbackGit = cursor;
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  return fallbackGit || current;
}

export function failureContentKey(failure?: FailureDetail): string {
  return JSON.stringify(failure ?? null);
}

export function licenseContentKey(license?: LicenseSummary): string {
  return JSON.stringify(license ?? null);
}

export function watchIndex(
  root: string,
  onState: (snapshot: ProjectStateResult) => void,
  options: {
    systemPath?: string;
    readState?: (systemPath: string, projectPath?: string) => Promise<ProjectStateResult>;
    intervalMs?: number;
    delay?: number;
    signal?: AbortSignal;
  } = {},
): () => void {
  const systemPath = options.systemPath || settings.systemPath;
  const readState = options.readState || readProjectState;
  const intervalMs = options.intervalMs ?? options.delay ?? 500;
  const targetRoot = findProjectRoot(root);

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let generation = 0;

  let lastPhase: string | null = null;
  let lastDetail: string | null = null;
  let lastPercentage: number | undefined;
  let lastMessage: string | undefined;
  let lastConnectionId: string | undefined;
  let lastFailureKey: string | null = null;
  let lastLicenseKey: string | null = null;

  async function poll() {
    if (stopped) return;
    const thisGen = ++generation;
    try {
      const snapshot = await readState(systemPath, targetRoot);
      if (stopped || thisGen !== generation) return;

      const currentPercentage = snapshot.progress?.percentage;
      const currentMessage = snapshot.progress?.message;

      const currentFailureKey = failureContentKey(snapshot.failure);
      const currentLicenseKey = licenseContentKey(snapshot.license);

      const isChanged =
        snapshot.phase !== lastPhase ||
        snapshot.detail !== lastDetail ||
        currentPercentage !== lastPercentage ||
        currentMessage !== lastMessage ||
        snapshot.connectionId !== lastConnectionId ||
        currentFailureKey !== lastFailureKey ||
        currentLicenseKey !== lastLicenseKey;

      if (isChanged) {
        lastPhase = snapshot.phase;
        lastDetail = snapshot.detail;
        lastPercentage = currentPercentage;
        lastMessage = currentMessage;
        lastConnectionId = snapshot.connectionId;
        lastFailureKey = currentFailureKey;
        lastLicenseKey = currentLicenseKey;
        try {
          onState(snapshot);
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error);
          console.error('intellij readiness: ' + msg);
        }
      }
    } catch (error: unknown) {
      if (stopped || thisGen !== generation) return;
      const msg = error instanceof Error ? error.message : String(error);
      console.error('intellij readiness poll error: ' + msg);
    } finally {
      if (!stopped) {
        timer = setTimeout(poll, intervalMs);
      }
    }
  }

  void poll();

  const stop = () => {
    stopped = true;
    generation++;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  if (options.signal) {
    if (options.signal.aborted) {
      stop();
    } else {
      options.signal.addEventListener('abort', stop, { once: true });
    }
  }

  return stop;
}
