import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { existsSync, readFileSync, realpathSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type { LspSession } from '../debug/run-core.js';
import { settings } from '../server/service.js';
import { sanitizeString } from '../shared/runtime-status.js';
import { getHostInitializationOptions } from './configuration.js';
import {
  type CanonicalProject,
  canonicalizeProject,
  getAllProjectLedgers,
  getProjectLedger,
  type ProjectRecord,
  pathsEqual,
  verifyRecordedPathAttribution,
} from './metadata.js';

export function cleanPath(input: unknown): string {
  if (typeof input !== 'string') return String(input ?? '');
  let s = input.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

const registeredSystemPaths = new Set<string>();
let exitHookInstalled = false;

function normalizeSystemPath(systemPath: string): string {
  const resolved = resolve(cleanPath(systemPath));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function cleanupProcessLeases(systemPath: string, pid: number = process.pid): void {
  try {
    const leasesDir = join(systemPath, 'plugin-metadata', 'leases');
    if (!existsSync(leasesDir)) return;
    const entries = readdirSync(leasesDir);
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const file = join(leasesDir, entry);
      try {
        const content = readFileSync(file, 'utf8');
        const parsed: unknown = JSON.parse(content);
        if (parsed && typeof parsed === 'object' && 'pid' in parsed && parsed.pid === pid) {
          try {
            unlinkSync(file);
          } catch (unlinkErr: unknown) {
            if (unlinkErr && typeof unlinkErr === 'object' && 'code' in unlinkErr && unlinkErr.code !== 'ENOENT') {
              // ignore
            }
          }
        }
      } catch (readErr: unknown) {
        if (readErr && typeof readErr === 'object' && 'code' in readErr && readErr.code !== 'ENOENT') {
          // ignore corrupt/inaccessible files during exit
        }
      }
    }
  } catch {}
}

function cleanupAllRegisteredSystemPaths(pid: number = process.pid): void {
  for (const path of registeredSystemPaths) {
    cleanupProcessLeases(path, pid);
  }
}

function ensureExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    cleanupAllRegisteredSystemPaths();
  });
}

export function registerSystemPath(systemPath?: string): void {
  if (!systemPath || typeof systemPath !== 'string') return;
  const normalized = normalizeSystemPath(systemPath);
  registeredSystemPaths.add(normalized);
  ensureExitHook();
}

export function getWorkspaceConfigDir(options: { configDir?: string } = {}): string {
  if (options.configDir) return options.configDir;
  if (settings.workspaceConfigPath) return settings.workspaceConfigPath;
  return join(homedir(), '.omp', 'agent', 'intellij-workspaces');
}

async function writeAtomicJson(filePath: string, data: unknown): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, JSON.stringify(data, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(tempPath, filePath);
  } finally {
    await rm(tempPath, { force: true }).catch(() => {});
  }
}

export interface WorkspaceConfigFile {
  id: string;
  canonicalPath: string;
  nativePath: string;
  rootUri: string;
  javaHome?: string;
  javaVersion?: string;
  env?: Record<string, string>;
  updatedAt: number;
  [key: string]: unknown;
}

export function maskEnvValue(val: unknown): string {
  if (typeof val !== 'string') return '';
  if (val.length === 0) return '""';
  return '***';
}

export function maskConfiguredSecrets(text: string, env?: Record<string, string> | null): string {
  if (typeof text !== 'string') return '';
  let result = text;
  if (env && typeof env === 'object') {
    for (const val of Object.values(env)) {
      if (typeof val === 'string' && val.length > 0) {
        result = result.replaceAll(val, '[REDACTED]');
      }
    }
  }
  return result;
}

export function validateEnvMap(env: unknown): Record<string, string> {
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    throw new Error('Environment variables must be a non-null object of string key-value pairs');
  }
  const result: Record<string, string> = Object.create(null);
  for (const [rawKey, rawVal] of Object.entries(env)) {
    const key = typeof rawKey === 'string' ? rawKey.trim() : '';
    if (!key) {
      throw new Error('Invalid environment variable key: empty key is not allowed');
    }
    if (key.includes('=')) {
      throw new Error(`Invalid environment variable key "${key}": key cannot contain '='`);
    }
    if (key.includes('\0')) {
      throw new Error(`Invalid environment variable key "${key}": key cannot contain null bytes`);
    }
    if (typeof rawVal !== 'string') {
      throw new Error(
        `Invalid environment variable value for "${key}": value must be a string, got ${typeof rawVal}`,
      );
    }
    if (rawVal.includes('\0')) {
      throw new Error(
        `Invalid environment variable value for "${key}": value cannot contain null bytes`,
      );
    }
    result[key] = rawVal;
  }
  return result;
}

export async function readWorkspaceConfig(
  configDir: string,
  projectIdOrCanonical: string | CanonicalProject,
  fallbackProjectRoot?: string,
): Promise<WorkspaceConfigFile | null> {
  let projectId: string;
  let canonical: CanonicalProject | null = null;
  if (typeof projectIdOrCanonical === 'string') {
    projectId = projectIdOrCanonical;
    if (fallbackProjectRoot) {
      try {
        canonical = canonicalizeProject(fallbackProjectRoot);
      } catch {}
    }
  } else {
    canonical = projectIdOrCanonical;
    projectId = canonical.id;
  }

  const filePath = join(configDir, `${projectId}.json`);
  try {
    const content = await readFile(filePath, 'utf8');
    try {
      return JSON.parse(content) as WorkspaceConfigFile;
    } catch (parseErr) {
      throw new Error(
        `Invalid workspace configuration: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
      );
    }
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      // File does not exist, continue to legacy fallback
    } else {
      throw err;
    }
  }

  if (canonical?.legacyId && canonical.legacyId !== projectId) {
    const legacyPath = join(configDir, `${canonical.legacyId}.json`);
    try {
      const content = await readFile(legacyPath, 'utf8');
      if (verifyRecordedPathAttribution(content, canonical)) {
        let parsed: WorkspaceConfigFile;
        try {
          parsed = JSON.parse(content) as WorkspaceConfigFile;
        } catch (parseErr) {
          throw new Error(
            `Invalid workspace configuration: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
          );
        }
        const migrated: WorkspaceConfigFile = {
          ...parsed,
          id: canonical.id,
          canonicalPath: canonical.canonicalPath,
          nativePath: canonical.nativePath,
          rootUri: canonical.rootUri,
          updatedAt: Date.now(),
        };
        await writeAtomicJson(filePath, migrated);
        return migrated;
      }
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
        // not found
      } else {
        throw err;
      }
    }
  }

  return null;
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
  const systemPath = options.systemPath ?? settings.systemPath;
  if (systemPath) registerSystemPath(systemPath);
  const targetDir = getWorkspaceConfigDir(options);
  const cleanedRoot = cleanPath(projectRoot);
  const canonical = canonicalizeProject(cleanedRoot);
  const { canonicalPath, nativePath, rootUri, id } = canonical;

  const { javaHome, javaVersion } = validateJdk(jdkHome);

  const existing = await readWorkspaceConfig(targetDir, canonical);

  const config: WorkspaceConfigFile = {
    ...(existing || {}),
    id,
    canonicalPath,
    nativePath,
    rootUri,
    javaHome,
    javaVersion,
    updatedAt: Math.max(Date.now(), (existing?.updatedAt ?? 0) + 1),
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

export interface SetWorkspaceEnvVarResult {
  projectRoot: string;
  canonicalPath: string;
  nativePath: string;
  rootUri: string;
  name: string;
  maskedValue: string;
  savedEnvKeys: string[];
}

export interface UnsetWorkspaceEnvVarResult {
  projectRoot: string;
  canonicalPath: string;
  nativePath: string;
  rootUri: string;
  name: string;
  wasSet: boolean;
  savedEnvKeys: string[];
}

export async function setWorkspaceEnvVar(
  projectRoot: string,
  name: string,
  value: string,
  options: { systemPath?: string; configDir?: string } = {},
): Promise<SetWorkspaceEnvVarResult> {
  if (!projectRoot) throw new Error('Project root is required');
  const systemPath = options.systemPath ?? settings.systemPath;
  if (systemPath) registerSystemPath(systemPath);
  const cleanedName = typeof name === 'string' ? name.trim() : '';
  if (!cleanedName) throw new Error('Environment variable name is required');
  if (typeof value !== 'string') throw new Error('Environment variable value must be a string');
  const valid = validateEnvMap({ [cleanedName]: value });

  const targetDir = getWorkspaceConfigDir(options);
  const cleanedRoot = cleanPath(projectRoot);
  const canonical = canonicalizeProject(cleanedRoot);
  const { canonicalPath, nativePath, rootUri, id } = canonical;

  const existing = await readWorkspaceConfig(targetDir, canonical);
  const existingEnv = validateEnvMap(existing?.env ?? {});
  existingEnv[cleanedName] = valid[cleanedName];

  const config: WorkspaceConfigFile = {
    ...(existing || {}),
    id,
    canonicalPath,
    nativePath,
    rootUri,
    env: existingEnv,
    updatedAt: Math.max(Date.now(), (existing?.updatedAt ?? 0) + 1),
  };

  const filePath = join(targetDir, `${id}.json`);
  await writeAtomicJson(filePath, config);

  return {
    projectRoot: cleanedRoot,
    canonicalPath,
    nativePath,
    rootUri,
    name: cleanedName,
    maskedValue: maskEnvValue(valid[cleanedName]),
    savedEnvKeys: Object.keys(existingEnv).sort(),
  };
}

export async function unsetWorkspaceEnvVar(
  projectRoot: string,
  name: string,
  options: { systemPath?: string; configDir?: string } = {},
): Promise<UnsetWorkspaceEnvVarResult> {
  if (!projectRoot) throw new Error('Project root is required');
  const cleanedName = typeof name === 'string' ? name.trim() : '';
  const systemPath = options.systemPath ?? settings.systemPath;
  if (systemPath) registerSystemPath(systemPath);
  if (!cleanedName) throw new Error('Environment variable name is required');

  const targetDir = getWorkspaceConfigDir(options);
  const cleanedRoot = cleanPath(projectRoot);
  const canonical = canonicalizeProject(cleanedRoot);
  const { canonicalPath, nativePath, rootUri, id } = canonical;

  const existing = await readWorkspaceConfig(targetDir, canonical);
  if (!existing?.env || typeof existing.env !== 'object' || !(cleanedName in existing.env)) {
    return {
      projectRoot: cleanedRoot,
      canonicalPath,
      nativePath,
      rootUri,
      name: cleanedName,
      wasSet: false,
      savedEnvKeys:
        existing?.env && typeof existing.env === 'object' ? Object.keys(existing.env).sort() : [],
    };
  }

  const existingEnv = validateEnvMap(existing.env);
  delete existingEnv[cleanedName];

  const config: WorkspaceConfigFile = {
    ...existing,
    id,
    canonicalPath,
    nativePath,
    rootUri,
    updatedAt: Math.max(Date.now(), (existing?.updatedAt ?? 0) + 1),
  };

  if (Object.keys(existingEnv).length > 0) {
    config.env = existingEnv;
  } else {
    delete config.env;
  }

  const filePath = join(targetDir, `${id}.json`);
  await writeAtomicJson(filePath, config);

  return {
    projectRoot: cleanedRoot,
    canonicalPath,
    nativePath,
    rootUri,
    name: cleanedName,
    wasSet: true,
    savedEnvKeys: Object.keys(existingEnv).sort(),
  };
}

/**
 * Structured status for project import and reload.
 * Note: 'applied' represents that the language server workspace reload completed
 * with the submitted configuration; it does not claim arbitrary env variables took effect
 * inside build tool processes/daemons.
 */
export interface WorkspaceImportStatus {
  status: 'idle' | 'pending' | 'submitted' | 'applied' | 'failed';
  stage?: 'saved' | 'connect' | 'submitted' | 'reload' | 'verification' | 'ready';
  revision?: number;
  submittedEnvKeys?: string[];
  failure?: { stage: string; message: string };
  updatedAt?: number;
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
  maskedEnv?: Record<string, string>;
  importStatus?: WorkspaceImportStatus;
  lastReady: number | null;
  lastConnected: number | null;
  hasLspRecorded: boolean;
}

export async function getWorkspaceInfo(
  projectRoot: string,
  options: { systemPath?: string; configDir?: string } = {},
): Promise<WorkspaceInfo> {
  const systemPath = options.systemPath ?? settings.systemPath;
  if (systemPath) registerSystemPath(systemPath);
  const configDir = options.configDir;
  if (!projectRoot) throw new Error('Project root is required');
  const cleanedRoot = cleanPath(projectRoot);
  const canonical = canonicalizeProject(cleanedRoot);
  const { canonicalPath, nativePath, rootUri, id } = canonical;
  const targetDir = getWorkspaceConfigDir({ configDir });

  const projectType = detectProjectType(nativePath);
  const saved = await readWorkspaceConfig(targetDir, canonical);

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

  const importReceiptPath = join(
    systemPath,
    'plugin-metadata',
    'receipts',
    `${id}.import-status.json`,
  );
  let importStatus: WorkspaceImportStatus = {
    status: 'idle',
    submittedEnvKeys: [],
  };

  const savedRevision = saved?.updatedAt ?? 0;
  try {
    if (existsSync(importReceiptPath)) {
      const r = JSON.parse(await readFile(importReceiptPath, 'utf8')) as {
        status?: WorkspaceImportStatus['status'];
        stage?: WorkspaceImportStatus['stage'];
        revision?: number;
        submittedEnvKeys?: string[];
        failure?: { stage: string; message: string } | null;
        timestamp?: number;
      };
      const receiptRev = r.revision ?? 0;
      const isOutdated = savedRevision > 0 && savedRevision !== receiptRev;
      if (isOutdated) {
        importStatus = {
          status: 'pending',
          stage: 'saved',
          revision: receiptRev,
          submittedEnvKeys: r.submittedEnvKeys || [],
          updatedAt: r.timestamp,
        };
      } else {
        importStatus = {
          status: r.status || 'idle',
          stage: r.stage,
          revision: r.revision,
          submittedEnvKeys: r.submittedEnvKeys || [],
          failure: r.failure ? { stage: r.failure.stage, message: r.failure.message } : undefined,
          updatedAt: r.timestamp,
        };
      }
    } else if (saved && (saved.javaHome || (saved.env && Object.keys(saved.env).length > 0))) {
      importStatus = {
        status: 'pending',
        stage: 'saved',
        revision: 0,
        submittedEnvKeys: [],
        updatedAt: saved.updatedAt,
      };
    }
  } catch {}

  const savedJdk = saved?.javaHome ?? null;
  const savedVersion = saved?.javaVersion ?? null;
  const savedEnv =
    saved?.env && typeof saved.env === 'object' && !Array.isArray(saved.env) ? saved.env : {};
  const savedEnvKeys = Object.keys(savedEnv).sort();
  const maskedEnv: Record<string, string> = {};
  for (const k of savedEnvKeys) {
    maskedEnv[k] = maskEnvValue(savedEnv[k]);
  }

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
    savedEnvKeys,
    maskedEnv,
    importStatus,
    lastReady: ledger?.lastReady ?? null,
    lastConnected: ledger?.lastConnected ?? null,
    hasLspRecorded,
  };
}
export async function listWorkspaces(
  options: { systemPath?: string; configDir?: string } = {},
): Promise<WorkspaceInfo[]> {
  const systemPath = options.systemPath ?? settings.systemPath;
  if (systemPath) registerSystemPath(systemPath);
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

const runGit = promisify(execFile);

async function knownWorktreeSource(
  project: string,
  systemPath: string,
): Promise<string | undefined> {
  let repository = project;
  while (!existsSync(join(repository, '.git'))) {
    const parent = dirname(repository);
    if (parent === repository) return undefined;
    repository = parent;
  }
  if (!statSync(join(repository, '.git')).isFile()) return undefined;
  let output: string;
  try {
    ({ stdout: output } = await runGit(
      'git',
      ['-C', project, 'worktree', 'list', '--porcelain', '-z'],
      {
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      },
    ));
  } catch {
    return undefined;
  }
  const fields = output.split('\0');
  if (fields[1] === 'bare') return undefined;
  const roots = fields
    .filter((field) => field.startsWith('worktree '))
    .map((field) => field.slice(9));
  const current = roots
    .filter((root) => {
      const rel = relative(root, project);
      return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
    })
    .sort((a, b) => b.length - a.length)[0];
  if (!current || !roots[0] || pathsEqual(current, roots[0])) return undefined;
  const source = resolve(roots[0], relative(current, project));
  if (!existsSync(source)) return undefined;
  const canonical = canonicalizeProject(source);
  const ledger = await getProjectLedger(systemPath, source);
  if (!ledger?.lastReady) return undefined;
  let raw: string;
  try {
    raw = await readFile(
      join(systemPath, 'plugin-metadata', `initialize-${canonical.id}.json`),
      'utf8',
    );
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return undefined;
    throw error;
  }
  try {
    const record: unknown = JSON.parse(raw);
    if (
      record &&
      typeof record === 'object' &&
      'rootUri' in record &&
      typeof record.rootUri === 'string' &&
      record.rootUri.startsWith('file:') &&
      pathsEqual(fileURLToPath(record.rootUri), source)
    )
      return record.rootUri;
  } catch {
    console.error('intellij: ignoring invalid source-workspace metadata; using a cold index');
  }
  return undefined;
}

export async function applyWorkspaceOptions(
  projectRoot?: string,
  initOptions: Record<string, unknown> = {},
  options: { systemPath?: string; configDir?: string } = {},
): Promise<Record<string, unknown>> {
  if (!projectRoot) return initOptions || {};
  const cleanedRoot = cleanPath(projectRoot);
  const canonical = canonicalizeProject(cleanedRoot);
  const { nativePath, id } = canonical;
  const targetDir = getWorkspaceConfigDir(options);
  const systemPath = options.systemPath ?? settings.systemPath;
  if (systemPath) registerSystemPath(systemPath);
  if (!Object.hasOwn(initOptions, 'fromWorkspace')) {
    const source = await knownWorktreeSource(nativePath, options.systemPath ?? settings.systemPath);
    if (source) initOptions = { ...initOptions, fromWorkspace: source };
  }

  const saved = await readWorkspaceConfig(targetDir, canonical);
  const hasSavedJdk = Boolean(saved?.javaHome);
  const hasSavedEnv = Boolean(
    saved?.env && typeof saved.env === 'object' && Object.keys(saved.env).length > 0,
  );

  if (!hasSavedJdk && !hasSavedEnv) {
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

  const savedEnv = hasSavedEnv && saved?.env ? (saved.env as Record<string, string>) : {};

  if (matchIndex >= 0) {
    const existing = projects[matchIndex];
    const existingEnv =
      existing.env && typeof existing.env === 'object' && !Array.isArray(existing.env)
        ? { ...(existing.env as Record<string, string>) }
        : {};

    const mergedEnv: Record<string, string> = {
      ...existingEnv,
      ...savedEnv,
    };

    const effectiveJdk =
      saved?.javaHome ||
      (typeof existing['java-home'] === 'string' ? existing['java-home'] : undefined);
    if (effectiveJdk) {
      mergedEnv.JAVA_HOME = effectiveJdk;
    }

    const updatedProject: Record<string, unknown> = {
      ...existing,
      type: projectType,
      path:
        typeof existing.path === 'string' && existing.path.startsWith('file:')
          ? existing.path
          : targetUri,
    };

    if (saved?.javaHome) {
      updatedProject['java-home'] = saved.javaHome;
    }

    if (Object.keys(mergedEnv).length > 0) {
      updatedProject.env = mergedEnv;
    } else {
      delete updatedProject.env;
    }

    projects[matchIndex] = updatedProject;
  } else {
    const mergedEnv: Record<string, string> = {
      ...savedEnv,
    };

    if (saved?.javaHome) {
      mergedEnv.JAVA_HOME = saved.javaHome;
    }

    const newProject: Record<string, unknown> = {
      type: projectType,
      path: targetUri,
    };

    if (saved?.javaHome) {
      newProject['java-home'] = saved.javaHome;
    }

    if (Object.keys(mergedEnv).length > 0) {
      newProject.env = mergedEnv;
    }

    projects.push(newProject);
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
  const canonical = canonicalizeProject(cleanedRoot);
  const { canonicalPath, nativePath, rootUri, id } = canonical;
  const systemPath = options.systemPath ?? settings.systemPath;
  if (systemPath) registerSystemPath(systemPath);
  const configDir = options.configDir;
  const targetDir = getWorkspaceConfigDir({ configDir });
  const saved = await readWorkspaceConfig(targetDir, canonical);
  const configRevision = saved?.updatedAt ?? Date.now();
  const plannedEnvKeys = saved?.env ? Object.keys(saved.env).sort() : [];
  const appliedJdk = saved?.javaHome || null;

  const receiptDir = join(systemPath, 'plugin-metadata', 'receipts');
  const importReceiptPath = join(receiptDir, `${id}.import-status.json`);

  const writeImportReceipt = async (
    status: 'pending' | 'submitted' | 'applied' | 'failed',
    stage: 'saved' | 'connect' | 'submitted' | 'reload' | 'verification' | 'ready',
    failure?: { stage: string; message: string } | null,
    verifiedJdk = false,
  ) => {
    try {
      const doc = {
        id,
        canonicalPath,
        status,
        stage,
        revision: configRevision,
        submittedEnvKeys: stage === 'connect' || stage === 'saved' ? [] : plannedEnvKeys,
        appliedJdk: verifiedJdk ? appliedJdk : null,
        verifiedJdk,
        failure: failure
          ? {
              stage: failure.stage,
              message: sanitizeString(maskConfiguredSecrets(failure.message, saved?.env)),
            }
          : null,
        timestamp: Date.now(),
      };
      await writeAtomicJson(importReceiptPath, doc);
    } catch {}
  };

  const rawHostOpts = await getHostInitializationOptions(systemPath, id);
  const baseInitOptions = rawHostOpts ?? {};
  const fullInitOptions = await applyWorkspaceOptions(nativePath, baseInitOptions, {
    systemPath,
    configDir,
  });

  const waitTimeout = options.timeoutMs ?? settings.requestWaitTimeoutMs ?? 300000;

  let session: LspSession | null = null;
  try {
    try {
      // Dynamic import to avoid circular dependency: run-core.ts imports workspace.ts
      const { createLspSession } = await import('../debug/run-core.js');
      session = await createLspSession(nativePath, {
        signal: options.signal,
        requestWaitTimeoutMs: waitTimeout,
        systemPath,
        configDir,
      });
    } catch (connectErr: unknown) {
      const errMsg = connectErr instanceof Error ? connectErr.message : String(connectErr);
      await writeImportReceipt('failed', 'connect', { stage: 'connect', message: errMsg });
      throw connectErr;
    }

    try {
      await writeImportReceipt('submitted', 'submitted');
      await session.reloadWorkspace({
        initializationOptions: fullInitOptions,
        timeoutMs: waitTimeout,
        signal: options.signal,
      });
    } catch (reloadErr: unknown) {
      const errMsg = reloadErr instanceof Error ? reloadErr.message : String(reloadErr);
      await writeImportReceipt('failed', 'reload', { stage: 'reload', message: errMsg });
      throw reloadErr;
    }

    let javaExec: string | null = null;
    let verified = false;

    const sourceFile = await findFirstSourceFile(nativePath);
    if (sourceFile && appliedJdk) {
      try {
        const { resolveLaunch, toLspFileUri } = await import('../debug/run-core.js');
        const sourceFileUri = toLspFileUri(sourceFile, rootUri);
        const launch = await resolveLaunch(session, sourceFileUri);
        if (!launch?.javaExec) {
          throw new Error(
            `Model verification failed: resolveLaunch returned no javaExec for ${sourceFileUri}`,
          );
        }
        javaExec = launch.javaExec;
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
      } catch (verifyErr: unknown) {
        const errMsg = verifyErr instanceof Error ? verifyErr.message : String(verifyErr);
        await writeImportReceipt('failed', 'verification', {
          stage: 'verification',
          message: errMsg,
        });
        throw verifyErr;
      }
    }

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

    if (appliedJdk && serverPid && verified) {
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

    await writeImportReceipt('applied', 'ready', null, verified);

    const elapsedMs = Date.now() - startTime;
    return {
      ready: true,
      projectRoot: cleanedRoot,
      canonicalPath,
      appliedJdk: verified ? appliedJdk : null,
      verifiedJdk: verified,
      submittedEnvKeys: plannedEnvKeys,
      elapsedMs,
    };
  } finally {
    if (session) {
      await session.close().catch(() => {});
    }
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
  const systemPath = options.systemPath ?? settings.systemPath;
  if (systemPath) registerSystemPath(systemPath);
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
