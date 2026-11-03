import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { serverConfigFile } from './config.js';

export interface EulaDocument {
  executable: string;
  path: string;
  hash: string;
  text: string;
}

export interface EulaOptions {
  configFile?: string;
}

export class EulaNotAcceptedError extends Error {
  readonly code = 'EULA_NOT_ACCEPTED';
  readonly document: EulaDocument;

  constructor(document: EulaDocument) {
    super(
      `IntelliJ Server EULA has not been accepted for ${document.path} ` +
        `(hash: ${document.hash}). ` +
        'Use "/intellij eula view" to inspect the agreement and ' +
        `"/intellij eula accept ${document.hash}" to accept it.`,
    );
    this.name = 'EulaNotAcceptedError';
    this.document = document;
  }
}

const VALID_HASH_REGEX = /^[0-9a-f]{16}$/;

class SystemPathError extends Error {
  code?: string | number;

  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'SystemPathError';
    if (cause && typeof cause === 'object' && 'code' in cause) {
      const code = cause.code;
      if (typeof code === 'string' || typeof code === 'number') {
        this.code = code;
      }
    }
  }
}

export function eulaConfigFile(options: EulaOptions = {}): string {
  const configFile = serverConfigFile(options);
  return join(dirname(configFile), 'intellij-eula.json');
}

export async function readServerEula(executable: string): Promise<EulaDocument> {
  let resolvedExecutable: string;
  try {
    resolvedExecutable = await realpath(executable);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SystemPathError(
      `Failed to resolve server executable at ${executable}: ${message}`,
      error,
    );
  }

  const eulaPath = join(dirname(dirname(resolvedExecutable)), 'EULA.txt');

  let bytes: Buffer;
  try {
    bytes = await readFile(eulaPath);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SystemPathError(`Failed to read EULA at ${eulaPath}: ${message}`, error);
  }

  const hash = createHash('sha256').update(bytes).digest('hex').toLowerCase().slice(0, 16);
  const text = bytes.toString('utf8');

  return {
    executable,
    path: eulaPath,
    hash,
    text,
  };
}

export async function readEulaAcceptance(
  options: EulaOptions = {},
): Promise<{ acceptedHashes: string[] }> {
  const file = eulaConfigFile(options);
  let content: string;
  try {
    content = await readFile(file, 'utf8');
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return { acceptedHashes: [] };
    }
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error: unknown) {
    throw new Error(`Invalid EULA acceptance file (malformed JSON) at ${file}`, { cause: error });
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid EULA acceptance file at ${file}: root must be an object`);
  }

  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'version' && key !== 'acceptedHashes') {
      throw new Error(`Invalid EULA acceptance file at ${file}: unexpected property "${key}"`);
    }
  }

  if (record.version !== 1) {
    throw new Error(
      `Invalid EULA acceptance file at ${file}: expected version 1, got ${String(record.version)}`,
    );
  }

  if (!Array.isArray(record.acceptedHashes)) {
    throw new Error(`Invalid EULA acceptance file at ${file}: acceptedHashes must be an array`);
  }

  const acceptedHashes: string[] = [];
  const seen = new Set<string>();
  let prev: string | null = null;
  for (const item of record.acceptedHashes) {
    if (typeof item !== 'string' || !VALID_HASH_REGEX.test(item)) {
      throw new Error(
        `Invalid EULA acceptance file at ${file}: accepted hash must be a ` +
          `16-character lowercase hex string, got ${JSON.stringify(item)}`,
      );
    }
    if (seen.has(item)) {
      throw new Error(`Invalid EULA acceptance file at ${file}: duplicate accepted hash "${item}"`);
    }
    if (prev !== null && item <= prev) {
      throw new Error(
        `Invalid EULA acceptance file at ${file}: acceptedHashes must be strictly sorted`,
      );
    }
    seen.add(item);
    prev = item;
    acceptedHashes.push(item);
  }

  return { acceptedHashes };
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

export async function acceptServerEula(
  document: EulaDocument,
  options: EulaOptions = {},
): Promise<void> {
  if (!VALID_HASH_REGEX.test(document.hash)) {
    throw new Error(`Invalid EULA hash format: "${document.hash}"`);
  }

  const fresh = await readServerEula(document.executable);
  if (fresh.path !== document.path || fresh.hash !== document.hash) {
    throw new Error(
      `EULA document for ${document.executable} has changed ` +
        `(path: ${fresh.path}, hash: ${fresh.hash}; expected path: ${document.path}, hash: ${document.hash}). ` +
        'Please view and accept the updated agreement.',
    );
  }

  const current = await readEulaAcceptance(options);
  const hashSet = new Set(current.acceptedHashes);
  hashSet.add(document.hash);
  const sortedHashes = Array.from(hashSet).sort();

  const file = eulaConfigFile(options);
  await writeDocument(file, {
    version: 1,
    acceptedHashes: sortedHashes,
  });
}

export async function requireAcceptedEula(
  executable: string,
  options: EulaOptions = {},
): Promise<EulaDocument> {
  const document = await readServerEula(executable);
  const acceptance = await readEulaAcceptance(options);
  if (!acceptance.acceptedHashes.includes(document.hash)) {
    throw new EulaNotAcceptedError(document);
  }
  return document;
}
