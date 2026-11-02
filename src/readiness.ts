import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { type ProjectStateResult, readProjectState } from './connection-state.js';
import type { FailureDetail, LicenseSummary } from './runtime-status.js';
import { settings } from './service.js';

export function findProjectRoot(startPath?: string): string {
  if (!startPath) return process.cwd();
  let current = resolve(startPath);
  try {
    if (existsSync(current) && statSync(current).isFile()) {
      current = dirname(current);
    }
  } catch {
    current = dirname(current);
  }

  const markers = [
    'pom.xml',
    'build.gradle',
    'build.gradle.kts',
    'settings.gradle',
    'settings.gradle.kts',
    '.idea',
    '.git',
  ];

  let candidate: string | null = null;
  let cursor = current;
  while (true) {
    for (const marker of markers) {
      if (existsSync(join(cursor, marker))) {
        candidate = cursor;
        break;
      }
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  return candidate || current;
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
