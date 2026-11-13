import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SERVER_VERSION } from './bundle-metadata.js';

interface ExtensionAssetSpec {
  readonly name: string;
  readonly path: string;
}

const EXTENSION_ASSETS: readonly ExtensionAssetSpec[] = [
  {
    name: 'language-server-plugins-android-lsp.jar',
    path: 'lib/language-server-plugins-android-lsp.jar',
  },
  {
    name: 'language-server.api.features.impl.android.jar',
    path: 'lib/modules/language-server.api.features.impl.android.jar',
  },
  {
    name: 'language-server.api.features.impl.android.dap.jar',
    path: 'lib/modules/language-server.api.features.impl.android.dap.jar',
  },
  {
    name: 'adblib-9.4.1.jar',
    path: 'lib/adblib-9.4.1.jar',
  },
  {
    name: 'adblib-tools-9.4.1.jar',
    path: 'lib/adblib-tools-9.4.1.jar',
  },
  {
    name: 'builder-model-9.4.1.jar',
    path: 'lib/builder-model-9.4.1.jar',
  },
  {
    name: 'lint-api-32.4.1.jar',
    path: 'lib/lint-api-32.4.1.jar',
  },
  {
    name: 'lint-checks-32.4.1.jar',
    path: 'lib/lint-checks-32.4.1.jar',
  },
  {
    name: 'lint-model-32.4.1.jar',
    path: 'lib/lint-model-32.4.1.jar',
  },
  {
    name: 'common-32.4.1.jar',
    path: 'lib/common-32.4.1.jar',
  },
  {
    name: 'sdklib-32.4.1.jar',
    path: 'lib/sdklib-32.4.1.jar',
  },
  {
    name: 'kxml2-2.3.0.jar',
    path: 'lib/kxml2-2.3.0.jar',
  },
  {
    name: 'sdk-common-32.4.1.jar',
    path: 'lib/sdk-common-32.4.1.jar',
  },
  {
    name: 'layoutlib-api-32.4.1.jar',
    path: 'lib/layoutlib-api-32.4.1.jar',
  },
  {
    name: 'manifest-merger-32.4.1.jar',
    path: 'lib/manifest-merger-32.4.1.jar',
  },
  {
    name: 'groovy-4.0.29.jar',
    path: 'lib/groovy-4.0.29.jar',
  },
] as const;

const EXPECTED_ASSET_PATHS = new Map<string, string>(
  EXTENSION_ASSETS.map((asset) => [asset.name, asset.path]),
);

const EXPECTED_RELATIVE_FILES = new Set<string>(
  EXTENSION_ASSETS.flatMap((asset) => [asset.path, `${asset.path}.sha256`]),
);

const UPSTREAM_SHA256: Readonly<Record<string, string>> = {
  'adblib-9.4.1.jar': 'ee4362dba99b5c64f72cc69073f66913e17318289204e861971a0b901a9a1ef9',
  'adblib-tools-9.4.1.jar': '2ff23e54a6989a2417aee3da1b1ff6d58ed7b6abce38bfdde6ba567fe14b918c',
  'builder-model-9.4.1.jar': '6fcae3cf38fa06c4b2d5eabe5616c8e0f5c9da86512cb9b1efbb69b2f8019b60',
  'lint-api-32.4.1.jar': 'e6a6e0244b5a9a325580c0a8901b94e1a8b37e0cca7030f5fcb06186f7f46b61',
  'lint-checks-32.4.1.jar': '61e6b0a90d6fe8a5ac5d4d8519fb1134fd064fbba12525dcfc08ce4b43ffd0ae',
  'lint-model-32.4.1.jar': '81ac1f03f390f0aa8308d389a8bbe4238f9bd843ff705556f68564f6ee257cf1',
  'common-32.4.1.jar': 'cace5b28f2342119fe1a2db5baa36f8bd3391a086788e04fb8326bb70d6c4989',
  'sdklib-32.4.1.jar': 'd0bbe0e03155a7bdd9bac03567b6b26797f81a778f55d5eadc3e71e7a0a27434',
  'kxml2-2.3.0.jar': 'f264dd9f79a1fde10ce5ecc53221eff24be4c9331c830b7d52f2f08a7b633de2',
  'sdk-common-32.4.1.jar': '0ef83f5f212f2fce8300a167ba256d1cd81e4cda6adc868f7025a8dbdd2ae14f',
  'layoutlib-api-32.4.1.jar': '24d9d0877a956ebd6e586640147bc6bd52ce904f0e6ab740be0899271e354543',
  'manifest-merger-32.4.1.jar': 'a8ade13523ccf3289fdb4946fcf23831d2eac8ad8b216f63a74850d46cdc8dd4',
  'groovy-4.0.29.jar': '16b1259f5404bc43bf066556e043769b1f7570b2ca23fdaf169f12499677e936',
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

async function scanLibDirectory(libDir: string): Promise<{ files: string[] } | { reason: string }> {
  const libStat = await lstat(libDir);
  if (libStat.isSymbolicLink() || !libStat.isDirectory()) {
    return { reason: 'Android extension library files do not match the asset set' };
  }

  const files: string[] = [];
  const libEntries = await readdir(libDir, { withFileTypes: true });

  for (const entry of libEntries) {
    if (entry.isSymbolicLink()) {
      return { reason: 'Android extension library files do not match the asset set' };
    }
    if (entry.isDirectory()) {
      if (entry.name !== 'modules') {
        return { reason: 'Android extension library files do not match the asset set' };
      }
      const modulesDir = join(libDir, 'modules');
      const modStat = await lstat(modulesDir);
      if (modStat.isSymbolicLink() || !modStat.isDirectory()) {
        return { reason: 'Android extension library files do not match the asset set' };
      }
      const modEntries = await readdir(modulesDir, { withFileTypes: true });
      for (const modEntry of modEntries) {
        if (modEntry.isSymbolicLink() || !modEntry.isFile()) {
          return { reason: 'Android extension library files do not match the asset set' };
        }
        files.push(`lib/modules/${modEntry.name}`);
      }
    } else if (entry.isFile()) {
      files.push(`lib/${entry.name}`);
    } else {
      return { reason: 'Android extension library files do not match the asset set' };
    }
  }

  return { files };
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

    const manifestPath = join(directory, 'manifest.json');
    const manifestStat = await lstat(manifestPath);
    if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
      return { reason: 'Android extension manifest version or ABI mismatch' };
    }

    const manifest: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (
      !manifest ||
      typeof manifest !== 'object' ||
      !('serverVersion' in manifest) ||
      manifest.serverVersion !== expectedVersion ||
      !('extensionId' in manifest) ||
      manifest.extensionId !== 'org.jetbrains.android' ||
      !('classFileVersion' in manifest) ||
      manifest.classFileVersion !== 69 ||
      !('targetJavaVersion' in manifest) ||
      manifest.targetJavaVersion !== 25 ||
      !('assets' in manifest) ||
      !Array.isArray(manifest.assets) ||
      manifest.assets.length !== EXTENSION_ASSETS.length
    )
      return { reason: 'Android extension manifest version or ABI mismatch' };

    const scanResult = await scanLibDirectory(join(directory, 'lib'));
    if ('reason' in scanResult) {
      return scanResult;
    }
    if (
      scanResult.files.length !== EXPECTED_RELATIVE_FILES.size ||
      scanResult.files.some((name) => !EXPECTED_RELATIVE_FILES.has(name))
    )
      return { reason: 'Android extension library files do not match the asset set' };

    const seenNames = new Set<string>();
    const seenPaths = new Set<string>();

    for (const asset of manifest.assets) {
      if (
        !asset ||
        typeof asset !== 'object' ||
        typeof asset.name !== 'string' ||
        typeof asset.path !== 'string' ||
        seenNames.has(asset.name) ||
        seenPaths.has(asset.path) ||
        EXPECTED_ASSET_PATHS.get(asset.name) !== asset.path ||
        typeof asset.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/i.test(asset.sha256) ||
        !Number.isSafeInteger(asset.size) ||
        asset.size <= 0
      )
        return { reason: 'Invalid Android extension asset manifest' };

      seenNames.add(asset.name);
      seenPaths.add(asset.path);

      const resolvedJarPath = resolve(directory, asset.path);
      const rel = relative(directory, resolvedJarPath);
      if (rel.startsWith('..') || isAbsolute(rel))
        return { reason: 'Asset path escapes extension directory' };

      const jarStat = await lstat(resolvedJarPath);
      if (jarStat.isSymbolicLink() || !jarStat.isFile())
        return { reason: `Asset cannot be a symlink: ${asset.name}` };

      const bytes = await readFile(resolvedJarPath);
      const actualSha = createHash('sha256').update(bytes).digest('hex');
      if (asset.size !== bytes.length || actualSha !== asset.sha256.toLowerCase())
        return { reason: `Android extension asset SHA-256 mismatch: ${asset.name}` };
      const upstreamSha = UPSTREAM_SHA256[asset.name];
      if (upstreamSha && actualSha !== upstreamSha)
        return { reason: `Android extension upstream SHA-256 mismatch: ${asset.name}` };

      const companionPath = `${resolvedJarPath}.sha256`;
      const companionStat = await lstat(companionPath);
      if (companionStat.isSymbolicLink() || !companionStat.isFile())
        return { reason: `Companion cannot be a symlink: ${asset.name}` };

      const content = (await readFile(companionPath, 'utf8')).trim();
      const match = /^([a-f0-9]{64})(?:\s+\*?([^\s]+))?$/i.exec(content);
      const expectedFilename = asset.name;
      const expectedPath = asset.path;
      const expectedRelative = asset.path.replace(/^lib\//, '');
      if (
        !match ||
        match[1].toLowerCase() !== actualSha ||
        (match[2] &&
          match[2] !== expectedFilename &&
          match[2] !== expectedPath &&
          match[2] !== expectedRelative)
      )
        return { reason: `Android extension asset companion SHA-256 mismatch: ${asset.name}` };
    }

    if (seenNames.size !== EXTENSION_ASSETS.length) {
      return { reason: 'Invalid Android extension asset manifest' };
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
    : fileURLToPath(new URL(`../../resources/ils/${version}/android.lsp`, import.meta.url));
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

interface ParsedIjPluginOptions {
  paths: string[];
  remainingTokens: string[];
}

function parseIjPluginOptions(
  existing: string | undefined,
  additionalPluginPath?: string,
): ParsedIjPluginOptions {
  if (additionalPluginPath !== undefined && hasInvalidOptionChars(additionalPluginPath, false)) {
    throw new Error(`Invalid characters in plugin.path option: "${additionalPluginPath}"`);
  }
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

  if (additionalPluginPath !== undefined && additionalPluginPath.length > 0) {
    const normNewPath = additionalPluginPath.replace(/\\/g, '/');
    const key = windows ? normNewPath.toLowerCase() : normNewPath;
    if (!pathKeys.has(key)) {
      paths.push(normNewPath);
    }
  }

  return { paths, remainingTokens };
}

export function getIjPluginPaths(
  existing: string | undefined,
  additionalPluginPath?: string,
  baseDir?: string,
): string[] {
  const { paths } = parseIjPluginOptions(existing, additionalPluginPath);
  if (baseDir === undefined) {
    return paths;
  }
  const resolvedPaths: string[] = [];
  const seen = new Set<string>();
  const windows = process.platform === 'win32';
  for (const p of paths) {
    const resolved = resolve(baseDir, p).replace(/\\/g, '/');
    const key = windows ? resolved.toLowerCase() : resolved;
    if (!seen.has(key)) {
      seen.add(key);
      resolvedPaths.push(resolved);
    }
  }
  return resolvedPaths;
}

export function mergeIjJavaOptions(existing: string | undefined, pluginPath: string): string {
  const { paths, remainingTokens } = parseIjPluginOptions(existing, pluginPath);
  const property = formatPluginOption(paths.join(','));
  return remainingTokens.length > 0 ? `${remainingTokens.join(' ')} ${property}` : property;
}
