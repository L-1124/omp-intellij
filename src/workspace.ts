import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  canonicalizeProject,
  getAllProjectLedgers,
  getProjectLedger,
  type ProjectRecord,
} from './metadata.js';
import { settings } from './service.js';

export function cleanPath(input: unknown): string {
  if (typeof input !== 'string') return String(input ?? '');
  let s = input.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

export function getWorkspaceConfigDir(options: { configDir?: string } = {}): string {
  if (options.configDir) return options.configDir;
  if (settings.workspaceConfigPath) return settings.workspaceConfigPath;
  return join(homedir(), '.omp', 'agent', 'intellij-workspaces');
}

async function writeAtomicJson(filePath: string, data: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(tempPath, JSON.stringify(data, null, 2), 'utf8');
  await rename(tempPath, filePath);
}

export interface WorkspaceConfigFile {
  id: string;
  canonicalPath: string;
  nativePath: string;
  rootUri: string;
  javaHome: string;
  javaVersion: string;
  updatedAt: number;
}

async function readWorkspaceConfig(
  configDir: string,
  projectId: string,
): Promise<WorkspaceConfigFile | null> {
  const filePath = join(configDir, `${projectId}.json`);
  try {
    const content = await readFile(filePath, 'utf8');
    return JSON.parse(content) as WorkspaceConfigFile;
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return null;
    throw err;
  }
}

export interface InspectedJdk {
  javaHome: string;
  version: string;
  vendor: string;
  majorVersion: number | null;
  source: string;
  _key: string;
}

export function inspectJdk(dirPath: unknown, source: string = 'system'): InspectedJdk | null {
  if (!dirPath || typeof dirPath !== 'string') return null;
  const cleaned = cleanPath(dirPath);
  let resolved: string;
  try {
    resolved = resolve(cleaned);
    if (!existsSync(resolved)) return null;
    const stat = statSync(resolved);
    if (!stat.isDirectory()) return null;
  } catch {
    return null;
  }

  const isWin = process.platform === 'win32';
  const javaCandidates = isWin
    ? [join(resolved, 'bin', 'java.exe'), join(resolved, 'bin', 'java')]
    : [join(resolved, 'bin', 'java'), join(resolved, 'bin', 'java.exe')];
  const javacCandidates = isWin
    ? [join(resolved, 'bin', 'javac.exe'), join(resolved, 'bin', 'javac')]
    : [join(resolved, 'bin', 'javac'), join(resolved, 'bin', 'javac.exe')];

  const javaOk = javaCandidates.some((c) => {
    try {
      return statSync(c).isFile();
    } catch {
      return false;
    }
  });
  if (!javaOk) return null;

  const javacOk = javacCandidates.some((c) => {
    try {
      return statSync(c).isFile();
    } catch {
      return false;
    }
  });
  if (!javacOk) return null;

  const releasePath = join(resolved, 'release');
  let version: string | null = null;
  let vendor: string | null = null;
  let majorVersion: number | null = null;

  try {
    if (statSync(releasePath).isFile()) {
      const content = readFileSync(releasePath, 'utf8');
      const vMatch = /JAVA_VERSION="?([^"\r\n]+)"?/.exec(content);
      if (vMatch) {
        const rawVersion = vMatch[1].trim();
        if (/^\d+(\.\d+)*/.test(rawVersion)) {
          version = rawVersion;
          const parts = version.split('.');
          if (parts[0] === '1' && parts[1]) {
            majorVersion = parseInt(parts[1], 10) || null;
          } else {
            majorVersion = parseInt(parts[0], 10) || null;
          }
        }
      }
      const iMatch = /IMPLEMENTOR="?([^"\r\n]+)"?/.exec(content);
      if (iMatch) {
        vendor = iMatch[1].trim();
      }
    } else {
      return null;
    }
  } catch {
    return null;
  }

  if (!version) return null;

  let canonicalKey: string;
  try {
    canonicalKey = realpathSync(resolved).replace(/\\/g, '/').toLowerCase();
  } catch {
    canonicalKey = resolved.replace(/\\/g, '/').toLowerCase();
  }

  return {
    javaHome: resolved.replace(/\\/g, '/'),
    version,
    vendor: vendor || 'Unknown',
    majorVersion,
    source,
    _key: canonicalKey,
  };
}

export function validateJdk(jdkHome: string): { javaHome: string; javaVersion: string } {
  if (!jdkHome || typeof jdkHome !== 'string') {
    throw new Error('JDK home path is required');
  }
  const cleaned = cleanPath(jdkHome);
  const resolved = resolve(cleaned);

  if (!existsSync(resolved)) {
    throw new Error(`JDK home directory does not exist: "${resolved}"`);
  }

  const stat = statSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`JDK home path is not a directory: "${resolved}"`);
  }

  const inspected = inspectJdk(resolved, 'validate');
  if (inspected) {
    return {
      javaHome: inspected.javaHome,
      javaVersion: inspected.version,
    };
  }

  const isWin = process.platform === 'win32';
  const javaCandidates = isWin
    ? [join(resolved, 'bin', 'java.exe'), join(resolved, 'bin', 'java')]
    : [join(resolved, 'bin', 'java'), join(resolved, 'bin', 'java.exe')];
  const javacCandidates = isWin
    ? [join(resolved, 'bin', 'javac.exe'), join(resolved, 'bin', 'javac')]
    : [join(resolved, 'bin', 'javac'), join(resolved, 'bin', 'javac.exe')];

  const javaOk = javaCandidates.some((c) => {
    try {
      return statSync(c).isFile();
    } catch {
      return false;
    }
  });
  const javacOk = javacCandidates.some((c) => {
    try {
      return statSync(c).isFile();
    } catch {
      return false;
    }
  });

  const releasePath = join(resolved, 'release');
  let releaseStatus: string | null = 'missing release file';
  try {
    if (statSync(releasePath).isFile()) {
      const content = readFileSync(releasePath, 'utf8');
      const vMatch = /JAVA_VERSION="?([^"\r\n]+)"?/.exec(content);
      if (!vMatch || !/^\d+(\.\d+)*/.test(vMatch[1].trim())) {
        releaseStatus = 'malformed JAVA_VERSION in release file';
      } else {
        releaseStatus = null;
      }
    }
  } catch {}

  const missing: string[] = [];
  if (!javaOk) missing.push(isWin ? 'bin/java.exe' : 'bin/java');
  if (!javacOk) missing.push(isWin ? 'bin/javac.exe' : 'bin/javac');
  if (releaseStatus) missing.push(releaseStatus);

  throw new Error(`Invalid JDK at "${resolved}": missing ${missing.join(', ')}`);
}

export function detectProjectType(projectRoot: string): 'maven' | 'gradle' | 'unknown' {
  const clean = cleanPath(projectRoot);
  const resolved = resolve(
    typeof clean === 'string' && clean.startsWith('file:') ? fileURLToPath(clean) : clean,
  );
  if (existsSync(join(resolved, 'pom.xml'))) {
    return 'maven';
  }
  if (
    existsSync(join(resolved, 'build.gradle')) ||
    existsSync(join(resolved, 'build.gradle.kts')) ||
    existsSync(join(resolved, 'settings.gradle')) ||
    existsSync(join(resolved, 'settings.gradle.kts'))
  ) {
    return 'gradle';
  }
  return 'unknown';
}

export async function findFirstSourceFile(
  projectRoot: string,
  maxDepth: number = 6,
): Promise<string | null> {
  const root = resolve(cleanPath(projectRoot));
  const srcDir = join(root, 'src');
  if (!existsSync(srcDir)) return null;

  async function walk(dir: string, depth: number): Promise<string | null> {
    if (depth > maxDepth) return null;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const ent of entries) {
      if (ent.isFile() && (ent.name.endsWith('.java') || ent.name.endsWith('.kt'))) {
        return join(dir, ent.name);
      }
    }
    for (const ent of entries) {
      if (
        ent.isDirectory() &&
        ent.name !== 'target' &&
        ent.name !== 'build' &&
        !ent.name.startsWith('.')
      ) {
        const found = await walk(join(dir, ent.name), depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  return walk(srcDir, 1);
}

export async function setWorkspaceJdk(
  projectRoot: string,
  jdkHome: string,
  options: { systemPath?: string; configDir?: string } = {},
) {
  if (!projectRoot) throw new Error('Project root is required');
  const targetDir = getWorkspaceConfigDir(options);
  const cleanedRoot = cleanPath(projectRoot);
  const { canonicalPath, nativePath, rootUri, id } = canonicalizeProject(cleanedRoot);

  const { javaHome, javaVersion } = validateJdk(jdkHome);

  const config: WorkspaceConfigFile = {
    id,
    canonicalPath,
    nativePath,
    rootUri,
    javaHome,
    javaVersion,
    updatedAt: Date.now(),
  };

  const filePath = join(targetDir, `${id}.json`);
  await writeAtomicJson(filePath, config);

  return {
    projectRoot: cleanedRoot,
    canonicalPath,
    nativePath,
    rootUri,
    javaHome,
    javaVersion,
  };
}

export interface WorkspaceInfo {
  projectRoot: string;
  canonicalPath: string;
  nativePath: string;
  rootUri: string;
  projectType: string;
  savedJdk: string | null;
  savedVersion: string | null;
  appliedJdk: string | null;
  isApplied: boolean;
  savedEnvKeys?: string[];
  lastReady: number | null;
  lastConnected: number | null;
  hasLspRecorded: boolean;
}

export async function getWorkspaceInfo(
  projectRoot: string,
  options: { systemPath?: string; configDir?: string } = {},
): Promise<WorkspaceInfo> {
  const systemPath = options.systemPath ?? settings.systemPath;
  const configDir = options.configDir;
  if (!projectRoot) throw new Error('Project root is required');
  const cleanedRoot = cleanPath(projectRoot);
  const { canonicalPath, nativePath, rootUri, id } = canonicalizeProject(cleanedRoot);
  const targetDir = getWorkspaceConfigDir({ configDir });

  const projectType = detectProjectType(nativePath);
  const saved = await readWorkspaceConfig(targetDir, id);

  let ledger: ProjectRecord | null = null;
  try {
    ledger = await getProjectLedger(systemPath, nativePath);
  } catch {}

  const initializePath = join(systemPath, 'plugin-metadata', `initialize-${id}.json`);
  const hasLspRecorded = existsSync(initializePath);

  const receiptPath = join(systemPath, 'plugin-metadata', 'receipts', `${id}.applied.json`);
  let appliedJdk: string | null = null;
  let isApplied = false;

  try {
    if (existsSync(receiptPath)) {
      const receiptRaw: unknown = JSON.parse(await readFile(receiptPath, 'utf8'));
      const receipt = receiptRaw as { pid?: number; verified?: boolean; javaHome?: string } | null;
      let currentOwnerPid: number | null = null;
      try {
        const ownerFile = join(systemPath, 'omp-server.json');
        const ownerRaw: unknown = JSON.parse(await readFile(ownerFile, 'utf8'));
        const owner = ownerRaw as { pid?: number } | null;
        if (Number.isSafeInteger(owner?.pid) && (owner?.pid ?? 0) > 0) {
          currentOwnerPid = owner?.pid ?? null;
        }
      } catch {}

      let pidAlive = false;
      const receiptPid = receipt?.pid;
      if (typeof receiptPid === 'number' && Number.isSafeInteger(receiptPid) && receiptPid > 0) {
        if (currentOwnerPid !== null && receiptPid !== currentOwnerPid) {
          pidAlive = false;
        } else {
          try {
            process.kill(receiptPid, 0);
            pidAlive = true;
          } catch (e: unknown) {
            pidAlive = Boolean(e && typeof e === 'object' && 'code' in e && e.code !== 'ESRCH');
          }
        }
      }
      if (pidAlive && receipt?.verified === true && receipt?.javaHome) {
        appliedJdk = receipt.javaHome;
        const norm = (p?: string | null) => (p ? resolve(p).replace(/\\/g, '/').toLowerCase() : '');
        if (saved?.javaHome && norm(saved.javaHome) === norm(appliedJdk)) {
          isApplied = true;
        }
      }
    }
  } catch {}

  const savedJdk = saved?.javaHome ?? null;
  const savedVersion = saved?.javaVersion ?? null;

  return {
    projectRoot: cleanedRoot,
    canonicalPath,
    nativePath,
    rootUri,
    projectType,
    savedJdk,
    savedVersion,
    appliedJdk,
    isApplied,
    lastReady: ledger?.lastReady ?? null,
    lastConnected: ledger?.lastConnected ?? null,
    hasLspRecorded,
  };
}

export async function listWorkspaces(
  options: { systemPath?: string; configDir?: string } = {},
): Promise<WorkspaceInfo[]> {
  const systemPath = options.systemPath ?? settings.systemPath;
  const configDir = options.configDir;
  const targetDir = getWorkspaceConfigDir({ configDir });
  const map = new Map<string, string>();

  try {
    const files = await readdir(targetDir);
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const content = await readFile(join(targetDir, f), 'utf8');
        const data = JSON.parse(content) as { canonicalPath?: string; nativePath?: string };
        if (data?.canonicalPath) {
          const { id } = canonicalizeProject(data.nativePath || data.canonicalPath);
          map.set(id, data.nativePath || data.canonicalPath);
        }
      } catch {}
    }
  } catch {}

  try {
    const ledgers = await getAllProjectLedgers(systemPath);
    for (const l of Array.from(ledgers.values())) {
      if (l?.canonicalPath) {
        const { id } = canonicalizeProject(l.nativePath || l.canonicalPath);
        if (!map.has(id)) {
          map.set(id, l.nativePath || l.canonicalPath);
        }
      }
    }
  } catch {}

  try {
    const metaDir = join(systemPath, 'plugin-metadata');
    const entries = await readdir(metaDir);
    for (const e of entries) {
      if (e.startsWith('initialize-') && e.endsWith('.json')) {
        try {
          const content = await readFile(join(metaDir, e), 'utf8');
          const data = JSON.parse(content) as {
            rootUri?: string;
            rootPath?: string;
            workspaceFolders?: Array<{ uri: string }>;
          };
          const uri = data?.rootUri || data?.workspaceFolders?.[0]?.uri || data?.rootPath;
          if (uri) {
            const { id, nativePath } = canonicalizeProject(uri);
            if (!map.has(id)) {
              map.set(id, nativePath);
            }
          }
        } catch {}
      }
    }
  } catch {}

  const results: WorkspaceInfo[] = [];
  for (const root of Array.from(map.values())) {
    try {
      const info = await getWorkspaceInfo(root, { systemPath, configDir });
      results.push(info);
    } catch {}
  }

  results.sort((a, b) => a.canonicalPath.localeCompare(b.canonicalPath));
  return results;
}

export async function applyWorkspaceOptions(
  projectRoot?: string,
  initOptions: Record<string, unknown> = {},
  options: { systemPath?: string; configDir?: string } = {},
): Promise<Record<string, unknown>> {
  if (!projectRoot) return initOptions || {};
  const cleanedRoot = cleanPath(projectRoot);
  const { nativePath, id } = canonicalizeProject(cleanedRoot);
  const targetDir = getWorkspaceConfigDir(options);

  const saved = await readWorkspaceConfig(targetDir, id);
  if (!saved?.javaHome) {
    return initOptions || {};
  }

  const result: Record<string, unknown> = initOptions
    ? JSON.parse(JSON.stringify(initOptions))
    : {};
  const projects: Array<Record<string, unknown>> = Array.isArray(result.projects)
    ? [...(result.projects as Array<Record<string, unknown>>)]
    : [];

  const detected = detectProjectType(nativePath);
  const targetUri = pathToFileURL(resolve(nativePath)).href;

  let matchIndex = -1;
  for (let i = 0; i < projects.length; i++) {
    const p = projects[i];
    if (!p || typeof p.path !== 'string') continue;
    try {
      if (canonicalizeProject(p.path).id === id) {
        matchIndex = i;
        break;
      }
    } catch {}
  }

  let projectType: string | null = null;
  if (matchIndex >= 0 && typeof projects[matchIndex].type === 'string') {
    projectType = projects[matchIndex].type as string;
  } else if (detected !== 'unknown') {
    projectType = detected;
  } else {
    throw new Error(
      `Cannot determine supported project type (Maven or Gradle) for project at "${nativePath}". IntelliJ requires Maven or Gradle.`,
    );
  }

  if (matchIndex >= 0) {
    const existing = projects[matchIndex];
    projects[matchIndex] = {
      ...existing,
      type: projectType,
      path:
        typeof existing.path === 'string' && existing.path.startsWith('file:')
          ? existing.path
          : targetUri,
      'java-home': saved.javaHome,
      env: {
        ...((existing.env as Record<string, string>) || {}),
        JAVA_HOME: saved.javaHome,
      },
    };
  } else {
    projects.push({
      type: projectType,
      path: targetUri,
      'java-home': saved.javaHome,
      env: {
        JAVA_HOME: saved.javaHome,
      },
    });
  }

  result.projects = projects;
  return result;
}

export interface ReimportWorkspaceResult {
  ready: boolean;
  projectRoot: string;
  canonicalPath: string;
  appliedJdk: string | null;
  verifiedJdk?: boolean;
  submittedEnvKeys?: string[];
  elapsedMs?: number;
}

export async function reimportWorkspace(
  projectRoot: string,
  options: {
    timeoutMs?: number;
    signal?: AbortSignal;
    systemPath?: string;
    configDir?: string;
  } = {},
): Promise<ReimportWorkspaceResult> {
  const startTime = Date.now();
  if (!projectRoot) throw new Error('Project root is required');
  const cleanedRoot = cleanPath(projectRoot);
  const { canonicalPath, nativePath, rootUri, id } = canonicalizeProject(cleanedRoot);
  const systemPath = options.systemPath ?? settings.systemPath;
  const configDir = options.configDir;

  let recorded: { initializationOptions?: Record<string, unknown> } | null = null;
  const recordedPath = join(systemPath, 'plugin-metadata', `initialize-${id}.json`);
  try {
    recorded = JSON.parse(await readFile(recordedPath, 'utf8'));
  } catch {}

  const baseInitOptions = recorded?.initializationOptions || {};
  const fullInitOptions = await applyWorkspaceOptions(nativePath, baseInitOptions, {
    systemPath,
    configDir,
  });

  const { createLspSession, resolveLaunch } = await import('./run-core.js');
  const waitTimeout = options.timeoutMs ?? settings.requestWaitTimeoutMs ?? 300000;

  const session = await createLspSession(nativePath, {
    signal: options.signal,
    requestWaitTimeoutMs: waitTimeout,
    systemPath,
    configDir,
  });
  try {
    // Reload model and await real ready-for-test notification
    await session.reloadWorkspace({
      initializationOptions: fullInitOptions,
      timeoutMs: waitTimeout,
      signal: options.signal,
    });
    const targetDir = getWorkspaceConfigDir({ configDir });
    const saved = await readWorkspaceConfig(targetDir, id);
    const appliedJdk = saved?.javaHome || null;

    let serverPid: number | null = null;
    try {
      const ownerRaw: unknown = JSON.parse(
        await readFile(join(systemPath, 'omp-server.json'), 'utf8'),
      );
      const owner = ownerRaw as { pid?: number } | null;
      if (Number.isSafeInteger(owner?.pid) && (owner?.pid ?? 0) > 0) {
        serverPid = owner?.pid ?? null;
      }
    } catch {}

    let javaExec: string | null = null;
    let verified = false;

    const sourceFile = await findFirstSourceFile(nativePath);
    if (sourceFile) {
      const { toLspFileUri } = await import('./run-core.js');
      const sourceFileUri = toLspFileUri(sourceFile, rootUri);
      const launch = await resolveLaunch(session, sourceFileUri);
      if (!launch?.javaExec) {
        throw new Error(
          `Model verification failed: resolveLaunch returned no javaExec for ${sourceFileUri}`,
        );
      }
      javaExec = launch.javaExec;
      if (appliedJdk) {
        const resolvedLaunchJdk = resolve(dirname(dirname(javaExec)))
          .replace(/\\/g, '/')
          .toLowerCase();
        const expectedJdk = resolve(appliedJdk).replace(/\\/g, '/').toLowerCase();
        if (resolvedLaunchJdk !== expectedJdk) {
          throw new Error(
            `Model verification mismatch: expected JDK "${appliedJdk}" but IntelliJ resolved "${javaExec}"`,
          );
        }
        verified = true;
      }
    }

    if (appliedJdk && serverPid && verified) {
      const receiptDir = join(systemPath, 'plugin-metadata', 'receipts');
      const receiptPath = join(receiptDir, `${id}.applied.json`);
      const receipt = {
        id,
        canonicalPath,
        pid: serverPid,
        javaHome: appliedJdk,
        javaExec,
        appliedAt: Date.now(),
        verified: true,
      };
      await writeAtomicJson(receiptPath, receipt);
      const { recordReadiness } = await import('./metadata.js');
      await recordReadiness(systemPath, nativePath, Date.now()).catch(() => {});
    }
    const elapsedMs = Date.now() - startTime;
    return {
      ready: true,
      projectRoot: cleanedRoot,
      canonicalPath,
      appliedJdk,
      elapsedMs,
    };
  } finally {
    await session.close().catch(() => {});
  }
}

export interface DiscoveredJdkItem {
  javaHome: string;
  version: string;
  vendor: string;
  majorVersion: number | null;
  source: string;
}

export async function discoverJdks(
  _projectRoot?: string,
  options: {
    env?: NodeJS.ProcessEnv;
    candidateRoots?: string[];
    configDir?: string;
    systemPath?: string;
    knownRoots?: Array<{ root: string; source: string }>;
    includeDefaultRoots?: boolean;
  } = {},
): Promise<DiscoveredJdkItem[]> {
  const env = options.env || process.env;
  const discovered = new Map<string, DiscoveredJdkItem>();

  function addCandidate(dirPath: string | undefined, source: string): void {
    if (!dirPath) return;
    const inspected = inspectJdk(dirPath, source);
    if (inspected && !discovered.has(inspected._key)) {
      discovered.set(inspected._key, {
        javaHome: inspected.javaHome,
        version: inspected.version,
        vendor: inspected.vendor,
        majorVersion: inspected.majorVersion,
        source: inspected.source,
      });
    }
  }

  if (Array.isArray(options.candidateRoots)) {
    for (const root of options.candidateRoots) {
      if (!root) continue;
      addCandidate(root, 'injected');
      try {
        const entries = await readdir(root, { withFileTypes: true });
        for (const ent of entries) {
          if (ent.isDirectory() || ent.isSymbolicLink()) {
            addCandidate(join(root, ent.name), 'injected');
          }
        }
      } catch {}
    }
  }

  const configDir = getWorkspaceConfigDir(options);
  try {
    const files = await readdir(configDir);
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const content = await readFile(join(configDir, f), 'utf8');
        const data = JSON.parse(content) as { javaHome?: string };
        if (data?.javaHome) {
          addCandidate(data.javaHome, 'config');
        }
      } catch {}
    }
  } catch {}

  if (env.JAVA_HOME) addCandidate(env.JAVA_HOME, 'env');
  if (env.JDK_HOME) addCandidate(env.JDK_HOME, 'env');

  const pathVal = env.PATH || env.Path || env.path || '';
  const pathDirs = pathVal.split(delimiter);
  for (const dir of pathDirs) {
    if (!dir) continue;
    const isWin = process.platform === 'win32';
    const javaExe = isWin ? join(dir, 'java.exe') : join(dir, 'java');
    try {
      if (existsSync(javaExe)) {
        let real: string;
        try {
          real = realpathSync(javaExe);
        } catch {
          real = resolve(javaExe);
        }
        const binDir = dirname(real);
        if (basename(binDir).toLowerCase() === 'bin') {
          addCandidate(dirname(binDir), 'path');
        }
      }
    } catch {}
  }

  const knownRoots =
    options.knownRoots !== undefined
      ? options.knownRoots
      : options.includeDefaultRoots === false
        ? []
        : [
            { root: join(homedir(), '.jdks'), source: 'system' },
            { root: join(homedir(), '.sdkman', 'candidates', 'java'), source: 'system' },
            { root: 'F:/toolchains/jvms/store', source: 'store' },
          ];

  if (
    options.includeDefaultRoots !== false &&
    options.knownRoots === undefined &&
    process.platform === 'win32'
  ) {
    const programFiles = env.ProgramFiles || 'C:\\Program Files';
    knownRoots.push({ root: join(programFiles, 'Java'), source: 'system' });
    knownRoots.push({ root: join(programFiles, 'Eclipse Adoptium'), source: 'system' });
    knownRoots.push({ root: join(programFiles, 'Microsoft'), source: 'system' });
  }
  for (const { root, source } of knownRoots) {
    if (!existsSync(root)) continue;
    addCandidate(root, source);
    try {
      const entries = await readdir(root, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.isDirectory() || ent.isSymbolicLink()) {
          addCandidate(join(root, ent.name), source);
        }
      }
    } catch {}
  }

  const list = Array.from(discovered.values());
  list.sort((a, b) => {
    const majDiff = (b.majorVersion || 0) - (a.majorVersion || 0);
    if (majDiff !== 0) return majDiff;
    return (b.version || '').localeCompare(a.version || '', undefined, { numeric: true });
  });

  return list;
}
