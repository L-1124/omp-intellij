import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { settings } from '../server/service.js';
import type { FailureDetail, LicenseSummary } from '../shared/runtime-status.js';
import { type ProjectStateResult, readProjectState } from './connection-state.js';
import { isPathCaseSensitive, pathsEqual } from './metadata.js';
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

export function parsePomModules(pomContent: string, pomDir: string): Set<string> {
  const cleaned = pomContent
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');

  const modules = new Set<string>();
  const tagRegex = /<(module|subproject)(?:\s+[^>]*)?>([\s\S]*?)<\/\1>/g;
  let match = tagRegex.exec(cleaned);
  while (match !== null) {
    const rawVal = match[2].trim();
    if (rawVal) {
      let modPath = resolve(pomDir, rawVal);
      if (modPath.endsWith('.xml')) {
        modPath = dirname(modPath);
      }
      modules.add(normalize(modPath));
    }
    match = tagRegex.exec(cleaned);
  }
  return modules;
}

export function parseGradleSettingsIncludes(
  settingsContent: string,
  settingsDir: string,
): Set<string> {
  const cleaned = settingsContent.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  const included = new Set<string>();
  const includeRegex = /\binclude\s*(?:\(([^)]+)\)|([^\r\n;]+))/g;
  let match = includeRegex.exec(cleaned);
  while (match !== null) {
    const args = match[1] || match[2];
    const strRegex = /['"]([^'"]+)['"]/g;
    let strMatch = strRegex.exec(args);
    while (strMatch !== null) {
      let mod = strMatch[1].trim();
      if (mod.startsWith(':')) {
        mod = mod.slice(1);
      }
      const relPath = mod.replace(/:/g, sep);
      included.add(normalize(resolve(settingsDir, relPath)));
      strMatch = strRegex.exec(args);
    }
    match = includeRegex.exec(cleaned);
  }

  const includeBuildRegex = /\bincludeBuild\s*(?:\(([^)]+)\)|([^\r\n;]+))/g;
  let buildMatch = includeBuildRegex.exec(cleaned);
  while (buildMatch !== null) {
    const args = buildMatch[1] || buildMatch[2];
    const strRegex = /['"]([^'"]+)['"]/g;
    let strMatch = strRegex.exec(args);
    while (strMatch !== null) {
      const relPath = strMatch[1].trim();
      included.add(normalize(resolve(settingsDir, relPath)));
      strMatch = strRegex.exec(args);
    }
    buildMatch = includeBuildRegex.exec(cleaned);
  }
  return included;
}

export function isGradleSettingsDynamic(settingsContent: string): boolean {
  const cleaned = settingsContent.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  return /\b(includeFlat|subprojects|eachDir|eachFile|fileTree|walk|rootDir|listFiles)\b|\.projectDir\s*=|projectDir\s*=|\.each\s*\{|\.each\s*\(/.test(
    cleaned,
  );
}

export function findModuleRoot(startPath?: string): string {
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

export function findBuildRoot(startPath?: string): string {
  const moduleRoot = findModuleRoot(startPath);
  const home = homedir();
  const caseSensitive = isPathCaseSensitive(moduleRoot);

  const pathEquals = (a: string, b: string): boolean => pathsEqual(a, b, { caseSensitive });

  const pathSetHas = (set: Set<string>, target: string): boolean => {
    for (const item of set) {
      if (pathEquals(item, target)) return true;
    }
    return false;
  };

  // 1. Gradle widening
  const hasSettings =
    existsSync(join(moduleRoot, 'settings.gradle')) ||
    existsSync(join(moduleRoot, 'settings.gradle.kts'));
  if (hasSettings) {
    return moduleRoot;
  }

  const hasGradleBuild =
    existsSync(join(moduleRoot, 'build.gradle')) ||
    existsSync(join(moduleRoot, 'build.gradle.kts'));

  if (hasGradleBuild) {
    let cursor = dirname(moduleRoot);
    while (cursor && cursor !== home) {
      const settingsFile = existsSync(join(cursor, 'settings.gradle.kts'))
        ? join(cursor, 'settings.gradle.kts')
        : existsSync(join(cursor, 'settings.gradle'))
          ? join(cursor, 'settings.gradle')
          : null;

      if (settingsFile) {
        try {
          const content = readFileSync(settingsFile, 'utf8');
          const includes = parseGradleSettingsIncludes(content, cursor);
          const isDynamic = isGradleSettingsDynamic(content);
          if (!isDynamic) {
            if (pathSetHas(includes, moduleRoot)) {
              return cursor;
            }
            return moduleRoot;
          }
        } catch {}
        return cursor;
      }

      if (existsSync(join(cursor, '.git'))) {
        break;
      }
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    return moduleRoot;
  }

  // 2. Maven widening
  const pomFile = join(moduleRoot, 'pom.xml');
  if (existsSync(pomFile)) {
    let currentRoot = moduleRoot;
    let cursor = dirname(moduleRoot);

    while (cursor && cursor !== home) {
      const parentPom = join(cursor, 'pom.xml');
      if (existsSync(parentPom)) {
        try {
          const content = readFileSync(parentPom, 'utf8');
          const modules = parsePomModules(content, cursor);
          if (pathSetHas(modules, currentRoot)) {
            currentRoot = cursor;
          }
        } catch {}
      }

      if (existsSync(join(cursor, '.git')) && cursor !== currentRoot) {
        break;
      }
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    return currentRoot;
  }

  return moduleRoot;
}

export function findProjectRoot(
  startPath?: string,
  options?: { scope?: 'build' | 'module' },
): string {
  if (options?.scope === 'module') {
    return findModuleRoot(startPath);
  }
  return findBuildRoot(startPath);
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
          console.error(`intellij readiness: ${msg}`);
        }
      }
    } catch (error: unknown) {
      if (stopped || thisGen !== generation) return;
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`intellij readiness poll error: ${msg}`);
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
