import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { type InstallState, readInstallState } from './server-install.js';

export type ServerConfiguration =
  | { mode: 'managed'; installDir: string }
  | { mode: 'external'; executable: string };

interface ConfigOptions {
  configFile?: string;
}

export function serverConfigFile(options: ConfigOptions = {}): string {
  return resolve(
    options.configFile ??
      process.env.OMP_INTELLIJ_CONFIG ??
      join(homedir(), '.omp', 'agent', 'intellij.json'),
  );
}

export function defaultInstallDir(): string {
  return join(homedir(), '.omp', 'servers', 'intellij');
}

async function readDocument(file: string): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(file, 'utf8'));
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return {};
    throw error;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid IntelliJ configuration: ${file}`);
  }
  return value as Record<string, unknown>;
}

function parseServer(value: unknown): ServerConfiguration {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'mode' in value) {
    if (
      value.mode === 'managed' &&
      'installDir' in value &&
      typeof value.installDir === 'string' &&
      value.installDir.trim() &&
      !('executable' in value)
    ) {
      return { mode: 'managed', installDir: resolve(value.installDir) };
    }
    if (
      value.mode === 'external' &&
      'executable' in value &&
      typeof value.executable === 'string' &&
      value.executable.trim() &&
      !('installDir' in value)
    ) {
      return { mode: 'external', executable: resolve(value.executable) };
    }
  }
  throw new Error(
    'Invalid IntelliJ server configuration: choose managed installDir or external executable',
  );
}

export async function readServerConfig(
  fallbackExecutable: string,
  options: ConfigOptions = {},
): Promise<ServerConfiguration> {
  const document = await readDocument(serverConfigFile(options));
  if (document.server === undefined) {
    return fallbackExecutable
      ? { mode: 'external', executable: fallbackExecutable }
      : { mode: 'managed', installDir: defaultInstallDir() };
  }
  return parseServer(document.server);
}

async function writeDocument(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(value, null, 2));
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

export async function saveServerConfig(
  config: ServerConfiguration,
  options: ConfigOptions = {},
): Promise<void> {
  const normalized = parseServer(config);
  const file = serverConfigFile(options);
  const document = await readDocument(file);
  await writeDocument(file, { ...document, server: normalized });
}

export async function trackInstallation(
  installDir: string,
  options: ConfigOptions = {},
): Promise<void> {
  if (!installDir.trim()) throw new Error('IntelliJ installation directory must not be empty');
  await writeDocument(join(dirname(serverConfigFile(options)), 'intellij-install.json'), {
    installDir: resolve(installDir),
  });
}

export async function readObservedInstallState(
  options: ConfigOptions = {},
): Promise<InstallState | null> {
  // Discovery is separate from selection: a failed install must leave the active server unchanged.
  const document = await readDocument(
    join(dirname(serverConfigFile(options)), 'intellij-install.json'),
  );
  if (document.installDir === undefined) return null;
  if (typeof document.installDir !== 'string' || !document.installDir.trim()) {
    throw new Error('Invalid IntelliJ installation progress location');
  }
  return readInstallState(resolve(document.installDir));
}
