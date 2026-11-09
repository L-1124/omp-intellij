import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SERVER_VERSION } from './bundle-metadata.js';

const EXTENSION_ASSETS = [
  'intellij-android.jar',
  'adblib-9.4.1.jar',
  'adblib-tools-9.4.1.jar',
  'lint-api-32.4.1.jar',
  'lint-checks-32.4.1.jar',
  'lint-model-32.4.1.jar',
  'common-32.4.1.jar',
  'sdklib-32.4.1.jar',
  'kxml2-2.3.0.jar',
  'sdk-common-32.4.1.jar',
  'layoutlib-api-32.4.1.jar',
] as const;
const UPSTREAM_SHA256: Readonly<Record<string, string>> = {
  'adblib-9.4.1.jar': 'ee4362dba99b5c64f72cc69073f66913e17318289204e861971a0b901a9a1ef9',
  'adblib-tools-9.4.1.jar': '2ff23e54a6989a2417aee3da1b1ff6d58ed7b6abce38bfdde6ba567fe14b918c',
  'lint-api-32.4.1.jar': 'e6a6e0244b5a9a325580c0a8901b94e1a8b37e0cca7030f5fcb06186f7f46b61',
  'lint-checks-32.4.1.jar': '61e6b0a90d6fe8a5ac5d4d8519fb1134fd064fbba12525dcfc08ce4b43ffd0ae',
  'lint-model-32.4.1.jar': '81ac1f03f390f0aa8308d389a8bbe4238f9bd843ff705556f68564f6ee257cf1',
  'common-32.4.1.jar': 'cace5b28f2342119fe1a2db5baa36f8bd3391a086788e04fb8326bb70d6c4989',
  'sdklib-32.4.1.jar': 'd0bbe0e03155a7bdd9bac03567b6b26797f81a778f55d5eadc3e71e7a0a27434',
  'kxml2-2.3.0.jar': 'f264dd9f79a1fde10ce5ecc53221eff24be4c9331c830b7d52f2f08a7b633de2',
  'sdk-common-32.4.1.jar': '0ef83f5f212f2fce8300a167ba256d1cd81e4cda6adc868f7025a8dbdd2ae14f',
  'layoutlib-api-32.4.1.jar': '24d9d0877a956ebd6e586640147bc6bd52ce904f0e6ab740be0899271e354543',
};

export interface AndroidExtensionResolution {
  pluginPath?: string;
  reason?: string;
}

function hasInvalidOptionChars(value: string, allowComma = false): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127 || code === 34 || (!allowComma && code === 44)) {
      return true;
    }
  }
  return false;
}

export async function detectServerVersion(executable: string): Promise<string | null> {
  for (const base of [resolve(dirname(executable), '..'), dirname(executable), executable]) {
    try {
      const build = (await readFile(join(base, 'build.txt'), 'utf8')).trim();
      const firstLine = build.split(/\r?\n/)[0].trim();
      return firstLine.replace(/^ILS-/, '');
    } catch (error: unknown) {
      if (
        !error ||
        typeof error !== 'object' ||
        !('code' in error) ||
        (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')
      )
        return null;
    }
  }
  return null;
}

export async function verifyExtensionDirectory(
  directory: string,
  expectedVersion: string = DEFAULT_SERVER_VERSION,
): Promise<AndroidExtensionResolution> {
  try {
    if (hasInvalidOptionChars(directory, false))
      return {
        reason:
          'Extension path contains invalid characters and cannot be represented in plugin.path',
      };
    const manifest: unknown = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
    if (
      !manifest ||
      typeof manifest !== 'object' ||
      !('serverVersion' in manifest) ||
      manifest.serverVersion !== expectedVersion ||
      !('classFileVersion' in manifest) ||
      manifest.classFileVersion !== 69 ||
      !('targetJavaVersion' in manifest) ||
      manifest.targetJavaVersion !== 25 ||
      !('assets' in manifest) ||
      !Array.isArray(manifest.assets) ||
      manifest.assets.length !== EXTENSION_ASSETS.length
    )
      return { reason: 'Android extension manifest version or ABI mismatch' };
    const remaining = new Set<string>(EXTENSION_ASSETS);
    const files = await readdir(join(directory, 'lib'));
    const expectedFiles = new Set(EXTENSION_ASSETS.flatMap((name) => [name, `${name}.sha256`]));
    if (files.length !== expectedFiles.size || files.some((name) => !expectedFiles.has(name)))
      return { reason: 'Android extension library files do not match the asset set' };

    for (const asset of manifest.assets) {
      if (
        !asset ||
        typeof asset !== 'object' ||
        typeof asset.name !== 'string' ||
        !remaining.delete(asset.name) ||
        asset.path !== `lib/${asset.name}` ||
        typeof asset.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/i.test(asset.sha256) ||
        !Number.isSafeInteger(asset.size) ||
        asset.size <= 0
      )
        return { reason: 'Invalid Android extension asset manifest' };

      const resolvedJarPath = resolve(directory, asset.path);
      const rel = relative(directory, resolvedJarPath);
      if (rel.startsWith('..') || isAbsolute(rel))
        return { reason: 'Asset path escapes extension directory' };

      const bytes = await readFile(resolvedJarPath);
      const actualSha = createHash('sha256').update(bytes).digest('hex');
      if (asset.size !== bytes.length || actualSha !== asset.sha256.toLowerCase())
        return { reason: `Android extension asset SHA-256 mismatch: ${asset.name}` };
      const upstreamSha = UPSTREAM_SHA256[asset.name];
      if (upstreamSha && actualSha !== upstreamSha)
        return { reason: `Android extension upstream SHA-256 mismatch: ${asset.name}` };

      const content = (await readFile(`${resolvedJarPath}.sha256`, 'utf8')).trim();
      const match = /^([a-f0-9]{64})(?:\s+\*?([^\s]+))?$/i.exec(content);
      if (!match || match[1].toLowerCase() !== actualSha || (match[2] && match[2] !== asset.name))
        return { reason: `Android extension asset companion SHA-256 mismatch: ${asset.name}` };
    }

    return { pluginPath: directory };
  } catch (error: unknown) {
    return {
      reason: `Android extension unavailable at ${directory}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function resolveAndroidExtension(
  executable: string,
): Promise<AndroidExtensionResolution> {
  const version = await detectServerVersion(executable);
  if (version !== DEFAULT_SERVER_VERSION)
    return {
      reason: `Android extension requires ILS ${DEFAULT_SERVER_VERSION}; detected ${version ?? 'unknown'}`,
    };
  const directory = process.env.OMP_ANDROID_LS_EXTENSION_DIR
    ? resolve(process.env.OMP_ANDROID_LS_EXTENSION_DIR)
    : fileURLToPath(new URL(`../../resources/ils/${version}/intellij-android`, import.meta.url));
  return verifyExtensionDirectory(directory, version);
}

export function formatPluginOption(pluginPath: string): string {
  if (hasInvalidOptionChars(pluginPath, true)) {
    throw new Error(`Invalid characters in plugin.path option: "${pluginPath}"`);
  }
  const normalized = pluginPath.replace(/\\/g, '/');
  return `-Dplugin.path="${normalized}"`;
}

function parseJvmOptionTokens(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
    } else if (/\s/.test(char) && !inQuotes) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

export function mergeIjJavaOptions(existing: string | undefined, pluginPath: string): string {
  if (hasInvalidOptionChars(pluginPath, false)) {
    throw new Error(`Invalid characters in plugin.path option: "${pluginPath}"`);
  }
  const normNewPath = pluginPath.replace(/\\/g, '/');
  const tokens = parseJvmOptionTokens(existing ?? '');
  const remainingTokens: string[] = [];
  const paths: string[] = [];
  const pathKeys = new Set<string>();
  const windows = process.platform === 'win32';

  for (const token of tokens) {
    let isPluginOption = false;
    let rawValue = '';

    if (token.startsWith('-Dplugin.path=')) {
      isPluginOption = true;
      rawValue = token.slice('-Dplugin.path='.length);
    } else if (token.startsWith('"-Dplugin.path=') && token.endsWith('"')) {
      isPluginOption = true;
      rawValue = token.slice('"-Dplugin.path='.length, -1);
    }

    if (isPluginOption) {
      if (rawValue.startsWith('"') && rawValue.endsWith('"')) {
        rawValue = rawValue.slice(1, -1);
      }
      for (let segment of rawValue.split(windows ? /[;,]/ : /[:,]/)) {
        segment = segment.trim();
        if (segment.startsWith('"') && segment.endsWith('"')) {
          segment = segment.slice(1, -1).trim();
        }
        if (segment.length > 0) {
          const normSegment = segment.replace(/\\/g, '/');
          const key = windows ? normSegment.toLowerCase() : normSegment;
          if (!pathKeys.has(key)) {
            pathKeys.add(key);
            paths.push(normSegment);
          }
        }
      }
    } else {
      remainingTokens.push(token);
    }
  }

  if (!pathKeys.has(windows ? normNewPath.toLowerCase() : normNewPath)) {
    paths.push(normNewPath);
  }

  const property = formatPluginOption(paths.join(','));
  return remainingTokens.length > 0 ? `${remainingTokens.join(' ')} ${property}` : property;
}
