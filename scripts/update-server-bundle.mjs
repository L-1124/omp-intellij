import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { replaceFile } from '../dist/shared/atomic-file.js';

const execFileAsync = promisify(execFile);

export const LATEST_VERSION_URL =
  'https://raw.githubusercontent.com/JetBrains/intellij-lsp.nvim/HEAD/lua/intellij-lsp/server_bundles.lua';
const VERSION_REGEX = /^\d+(?:\.\d+){2,3}$/;
const VSIX_VERSION_REGEX = /^\d+(?:\.\d+){1,3}$/;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const VSX_ARTIFACT_MAX_BYTES = 32 * 1024 * 1024;
const VSX_ARTIFACT_TIMEOUT_MS = 120_000;

export const PLATFORM_CONFIG = {
  darwin: {
    extension: 'sit',
    arches: ['arm64', 'x64'],
  },
  linux: {
    extension: 'tar.gz',
    arches: ['arm64', 'x64'],
  },
  win32: {
    extension: 'win.zip',
    arches: ['arm64', 'x64'],
  },
};

export function validateServerVersion(version) {
  if (typeof version !== 'string' || !VERSION_REGEX.test(version)) {
    throw new Error(
      `Invalid server version "${version}": expected 3 or 4 dot-separated numeric segments (e.g. 263.7084.0)`,
    );
  }
  return version;
}

export function validateVsixVersion(version) {
  if (typeof version !== 'string' || !VSIX_VERSION_REGEX.test(version)) {
    throw new Error(
      `Invalid VSIX version "${version}": expected 2 to 4 dot-separated numeric segments (e.g. 1.0.86)`,
    );
  }
  return version;
}

export function parseBundleMetadataFile(content) {
  const serverVersionMatch = content.match(
    /export\s+const\s+DEFAULT_SERVER_VERSION\s*=\s*['"]([^'"]+)['"]\s*;/,
  );
  const vsixVersionMatch = content.match(
    /export\s+const\s+DEFAULT_VSIX_VERSION\s*=\s*['"]([^'"]+)['"]\s*;/,
  );
  return {
    serverVersion: serverVersionMatch ? validateServerVersion(serverVersionMatch[1].trim()) : null,
    vsixVersion: vsixVersionMatch ? validateVsixVersion(vsixVersionMatch[1].trim()) : null,
  };
}

export async function verifyJvmAssets({ targetVersion, resourcesDir }) {
  const targetDir = join(resourcesDir, targetVersion, 'android.lsp');
  let verifyExtensionDirectory;
  try {
    const mod = await import('../dist/server/android-extension.js');
    verifyExtensionDirectory = mod.verifyExtensionDirectory;
  } catch (err) {
    throw new Error(
      `Cannot load verifyExtensionDirectory from ../dist/server/android-extension.js. Run 'npm run build' first (${err.message})`,
    );
  }
  const res = await verifyExtensionDirectory(targetDir, targetVersion);
  if (res.pluginPath) {
    return { ok: true, pluginPath: res.pluginPath };
  }
  return { ok: false, reason: res.reason ?? 'Extension verification failed' };
}

export function parseLatestVersionFromLua(text) {
  const matches = [
    ...text.matchAll(/^[ \t]*M\.version[ \t]*=[ \t]*(['"])([^'"]+)\1[ \t]*(?:--[^\r\n]*)?\r?$/gm),
  ];
  if (matches.length !== 1) {
    throw new Error(
      `Failed to parse latest server version: expected exactly one M.version assignment, found ${matches.length}`,
    );
  }
  return matches[0][2];
}

export function parseSha256Sidecar(text, expectedBasename) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length !== 1) {
    throw new Error(
      `Invalid checksum file: expected exactly 1 non-empty line, got ${lines.length}`,
    );
  }
  const line = lines[0].trim();
  const match = line.match(/^([0-9a-fA-F]{64})(?:$|[ \t]+(.*)$)/);
  if (!match) {
    throw new Error('Invalid checksum format: expected 64-hex SHA-256 hash');
  }
  const hash = match[1].toLowerCase();
  const trailer = match[2];
  if (trailer !== undefined) {
    const trimmed = trailer.trim();
    if (trimmed.length > 0) {
      if (trimmed === '*') {
        throw new Error('Invalid checksum format: trailing asterisk without filename');
      }
      const name = trimmed.startsWith('*') ? trimmed.slice(1).trim() : trimmed;
      if (name.length === 0 || /\s/.test(name)) {
        throw new Error('Invalid checksum format: trailing garbage after archive filename');
      }
      if (name !== expectedBasename) {
        throw new Error(
          `Invalid checksum format: archive basename mismatch (expected "${expectedBasename}", got "${name}")`,
        );
      }
    }
  }
  return hash;
}

function timeoutSignal(ms = DEFAULT_TIMEOUT_MS, parentSignal) {
  return parentSignal
    ? AbortSignal.any([parentSignal, AbortSignal.timeout(ms)])
    : AbortSignal.timeout(ms);
}

async function readBoundedBytes(response, maxBytes) {
  const contentLength = response.headers.get('content-length');
  if (contentLength && Number.parseInt(contentLength, 10) > maxBytes) {
    await response.body?.cancel();
    throw new Error(`Response exceeds maximum allowed size of ${maxBytes} bytes`);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        throw new Error(`Response exceeded maximum allowed size of ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function readBoundedText(response) {
  return new TextDecoder('utf-8', { fatal: true }).decode(
    await readBoundedBytes(response, MAX_RESPONSE_BYTES),
  );
}

async function latestLuaVersion(fetchFn, signal) {
  const response = await fetchFn(LATEST_VERSION_URL, { signal });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Lua manifest: HTTP ${response.status} ${response.statusText}`);
  }
  return validateServerVersion(parseLatestVersionFromLua(await readBoundedText(response)));
}

async function latestVsxVersion(fetchFn, signal, platform = 'linux', arch = 'x64') {
  const base = 'https://open-vsx.org/api/JetBrains/intellij-server';
  const target = `${platform}-${arch}`;
  const response = await fetchFn(`${base}/${target}/latest`, { signal, redirect: 'error' });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Open VSX metadata: HTTP ${response.status} ${response.statusText}`);
  }
  const metadata = JSON.parse(await readBoundedText(response));
  if (
    metadata?.namespace !== 'JetBrains' ||
    metadata?.name !== 'intellij-server' ||
    metadata?.targetPlatform !== target ||
    metadata?.preRelease === true ||
    typeof metadata?.version !== 'string' ||
    !/^\d+(?:\.\d+){1,3}$/.test(metadata.version)
  ) {
    throw new Error('Invalid Open VSX extension metadata');
  }
  const expectedUrl = `${base}/${target}/${metadata.version}/file/JetBrains.intellij-server-${metadata.version}@${target}.vsix`;
  if (metadata.files?.download !== expectedUrl) {
    throw new Error('Unexpected Open VSX download URL');
  }
  const artifactSignal = AbortSignal.any([signal, AbortSignal.timeout(VSX_ARTIFACT_TIMEOUT_MS)]);
  let archive = await fetchFn(expectedUrl, { signal: artifactSignal, redirect: 'manual' });
  if ([301, 302, 303, 307, 308].includes(archive.status)) {
    const location = archive.headers.get('location');
    await archive.body?.cancel();
    const storageUrl = `https://openvsx.eclipsecontent.org/JetBrains/intellij-server/${target}/${metadata.version}/JetBrains.intellij-server-${metadata.version}@${target}.vsix`;
    if (location !== storageUrl) throw new Error('Unexpected Open VSX storage redirect');
    archive = await fetchFn(storageUrl, { signal: artifactSignal, redirect: 'error' });
  }
  if (!archive.ok) {
    await archive.body?.cancel();
    throw new Error(`Open VSX archive: HTTP ${archive.status} ${archive.statusText}`);
  }
  const bytes = await readBoundedBytes(archive, VSX_ARTIFACT_MAX_BYTES);
  artifactSignal.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), 'omp-intellij-vsx-'));
  try {
    const file = join(directory, 'extension.vsix');
    await writeFile(file, bytes);
    const entry = 'extension/server-bundle.json';
    const { stdout } = await execFileAsync(
      process.platform === 'linux' ? 'unzip' : 'tar',
      process.platform === 'linux' ? ['-p', file, entry] : ['-xf', file, '-O', entry],
      {
        signal: artifactSignal,
        maxBuffer: MAX_RESPONSE_BYTES,
        encoding: 'utf8',
        windowsHide: true,
      },
    );
    const bundle = JSON.parse(stdout);
    const version = validateServerVersion(bundle?.version);
    const suffix = arch === 'arm64' ? '-aarch64' : '';
    const ext = PLATFORM_CONFIG[platform]?.extension ?? 'tar.gz';
    const name = `intellij-server-${version}${suffix}.${ext}`;
    if (
      bundle?.archiveName !== name ||
      bundle?.url !==
        `https://download.jetbrains.com/language-server/intellij-server/${version}/${name}` ||
      typeof bundle?.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(bundle.sha256)
    ) {
      throw new Error('Invalid Open VSX server bundle');
    }
    return version;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function latestServerVersion(options = {}) {
  const fetchFn = options.fetch ?? fetch;
  const platform = options.platform ?? 'linux';
  const arch = options.arch ?? 'x64';
  const metaSignal = timeoutSignal(DEFAULT_TIMEOUT_MS, options.signal);
  const vsxSignal = timeoutSignal(VSX_ARTIFACT_TIMEOUT_MS, options.signal);

  metaSignal.throwIfAborted();
  const results = await Promise.allSettled([
    latestLuaVersion(fetchFn, metaSignal),
    latestVsxVersion(fetchFn, vsxSignal, platform, arch),
  ]);
  options.signal?.throwIfAborted();
  const versions = results.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : [],
  );
  if (!versions.length) {
    throw new Error(
      `Remote version lookup failed: ${results
        .map((result) => (result.status === 'rejected' ? String(result.reason) : ''))
        .join('; ')}`,
    );
  }
  versions.sort((a, b) => {
    const left = a.split('.').map(BigInt);
    const right = b.split('.').map(BigInt);
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      const delta = (right[i] ?? 0n) - (left[i] ?? 0n);
      if (delta !== 0n) return delta > 0n ? 1 : -1;
    }
    return 0;
  });
  return versions[0];
}

export function renderBundleMetadata({ version, vsixVersion, platforms }) {
  if (!version || !vsixVersion) {
    throw new Error('Both version and vsixVersion are required to render bundle metadata');
  }
  validateServerVersion(version);
  validateVsixVersion(vsixVersion);

  const lines = [
    `export const DEFAULT_SERVER_VERSION = '${version}';`,
    `export const DEFAULT_VSIX_VERSION = '${vsixVersion}';`,
    '',
    'export const SERVER_BUNDLE_PLATFORMS: Record<',
    '  string,',
    '  { extension: string; hashes: Record<string, string>; sizes: Record<string, number> }',
    '> = {',
  ];

  for (const platformName of ['darwin', 'linux', 'win32']) {
    const p = platforms[platformName];
    if (!p) throw new Error(`Missing platform metadata for ${platformName}`);
    lines.push(`  ${platformName}: {`);
    lines.push(`    extension: '${p.extension}',`);
    lines.push('    hashes: {');
    for (const arch of ['arm64', 'x64']) {
      lines.push(`      ${arch}: '${p.hashes[arch]}',`);
    }
    lines.push('    },');
    lines.push('    sizes: {');
    for (const arch of ['arm64', 'x64']) {
      lines.push(`      ${arch}: ${p.sizes[arch]},`);
    }
    lines.push('    },');
    lines.push('  },');
  }

  lines.push('};');
  lines.push('');
  return lines.join('\n');
}

export async function collectPlatformMetadata(version, fetchFn = globalThis.fetch) {
  const platforms = {};

  for (const platformName of ['darwin', 'linux', 'win32']) {
    const p = PLATFORM_CONFIG[platformName];
    const hashes = {};
    const sizes = {};

    for (const arch of p.arches) {
      const suffix = arch === 'arm64' ? '-aarch64' : '';
      const archiveBasename = `intellij-server-${version}${suffix}.${p.extension}`;
      const archiveUrl = `https://download.jetbrains.com/language-server/intellij-server/${version}/${archiveBasename}`;
      const sidecarUrl = `${archiveUrl}.sha256`;

      const sidecarSignal = timeoutSignal(DEFAULT_TIMEOUT_MS);
      const sidecarResponse = await fetchFn(sidecarUrl, { signal: sidecarSignal });
      if (!sidecarResponse.ok) {
        await sidecarResponse.body?.cancel();
        throw new Error(
          `Failed to fetch SHA-256 for ${version} (${platformName}/${arch}): HTTP ${sidecarResponse.status} ${sidecarResponse.statusText}`,
        );
      }
      const sidecarText = await readBoundedText(sidecarResponse);
      hashes[arch] = parseSha256Sidecar(sidecarText, archiveBasename);

      const headSignal = timeoutSignal(DEFAULT_TIMEOUT_MS);
      const headResponse = await fetchFn(archiveUrl, {
        method: 'HEAD',
        redirect: 'follow',
        signal: headSignal,
      });
      if (!headResponse.ok) {
        await headResponse.body?.cancel();
        throw new Error(
          `Failed to fetch archive size for ${version} (${platformName}/${arch}): HTTP ${headResponse.status} ${headResponse.statusText}`,
        );
      }
      const clHeader = headResponse.headers.get('content-length');
      if (!clHeader) {
        throw new Error(
          `Missing Content-Length header for ${version} (${platformName}/${arch}) from ${archiveUrl}`,
        );
      }
      const parsedSize = Number.parseInt(clHeader, 10);
      if (!Number.isSafeInteger(parsedSize) || parsedSize <= 0) {
        throw new Error(
          `Invalid Content-Length header "${clHeader}" for ${version} (${platformName}/${arch}) from ${archiveUrl}`,
        );
      }
      sizes[arch] = parsedSize;
    }

    platforms[platformName] = {
      extension: p.extension,
      hashes,
      sizes,
    };
  }

  return platforms;
}

export async function fetchVsixBundle(options = {}) {
  const fetchFn = options.fetch ?? fetch;
  const platform = options.platform ?? 'win32';
  const arch = options.arch ?? 'x64';
  const signal = options.signal;
  const vsixVersion = options.vsixVersion ?? options.version;
  const expectedServerVersion = options.expectedServerVersion;

  if (!vsixVersion) {
    throw new Error(
      'VSIX version is required to fetch Open VSX bundle (silent latest is prohibited)',
    );
  }
  validateVsixVersion(vsixVersion);

  const base = 'https://open-vsx.org/api/JetBrains/intellij-server';
  const target = `${platform}-${arch}`;

  const metaSignal = timeoutSignal(DEFAULT_TIMEOUT_MS, signal);
  const response = await fetchFn(`${base}/${target}/${vsixVersion}`, {
    signal: metaSignal,
    redirect: 'error',
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `Open VSX metadata (${vsixVersion}): HTTP ${response.status} ${response.statusText}`,
    );
  }
  const metadata = JSON.parse(await readBoundedText(response));
  if (
    metadata?.namespace !== 'JetBrains' ||
    metadata?.name !== 'intellij-server' ||
    metadata?.targetPlatform !== target ||
    metadata?.version !== vsixVersion
  ) {
    throw new Error(`Invalid Open VSX extension metadata for ${target} ${vsixVersion}`);
  }

  const expectedUrl = `${base}/${target}/${metadata.version}/file/JetBrains.intellij-server-${metadata.version}@${target}.vsix`;
  if (metadata.files?.download !== expectedUrl) {
    throw new Error('Unexpected Open VSX download URL');
  }

  const artifactSignal = timeoutSignal(VSX_ARTIFACT_TIMEOUT_MS, signal);
  let archive = await fetchFn(expectedUrl, { signal: artifactSignal, redirect: 'manual' });
  if ([301, 302, 303, 307, 308].includes(archive.status)) {
    const location = archive.headers.get('location');
    await archive.body?.cancel();
    const storageUrl = `https://openvsx.eclipsecontent.org/JetBrains/intellij-server/${target}/${metadata.version}/JetBrains.intellij-server-${metadata.version}@${target}.vsix`;
    if (location !== storageUrl) throw new Error('Unexpected Open VSX storage redirect');
    archive = await fetchFn(storageUrl, { signal: artifactSignal, redirect: 'error' });
  }
  if (!archive.ok) {
    await archive.body?.cancel();
    throw new Error(
      `Open VSX archive (${vsixVersion}): HTTP ${archive.status} ${archive.statusText}`,
    );
  }
  const bytes = await readBoundedBytes(archive, VSX_ARTIFACT_MAX_BYTES);
  artifactSignal.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), 'omp-intellij-vsx-pkg-'));
  try {
    const file = join(directory, 'extension.vsix');
    await writeFile(file, bytes);

    const serverBundleEntry = 'extension/server-bundle.json';
    const { stdout: bundleStdout } = await execFileAsync(
      process.platform === 'linux' ? 'unzip' : 'tar',
      process.platform === 'linux'
        ? ['-p', file, serverBundleEntry]
        : ['-xf', file, '-O', serverBundleEntry],
      {
        signal: artifactSignal,
        maxBuffer: MAX_RESPONSE_BYTES,
        encoding: 'utf8',
        windowsHide: true,
      },
    );
    const serverBundle = JSON.parse(bundleStdout);
    const serverVersion = validateServerVersion(serverBundle?.version);

    if (expectedServerVersion && serverVersion !== expectedServerVersion) {
      throw new Error(
        `Open VSX server-bundle version mismatch: VSIX ${vsixVersion} binds to ILS ${serverVersion}, expected ${expectedServerVersion}`,
      );
    }

    const suffix = arch === 'arm64' ? '-aarch64' : '';
    const ext = PLATFORM_CONFIG[platform]?.extension ?? 'tar.gz';
    const name = `intellij-server-${serverVersion}${suffix}.${ext}`;
    if (
      serverBundle?.archiveName !== name ||
      serverBundle?.url !==
        `https://download.jetbrains.com/language-server/intellij-server/${serverVersion}/${name}` ||
      typeof serverBundle?.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(serverBundle.sha256)
    ) {
      throw new Error('Invalid Open VSX server bundle');
    }

    const packageEntry = 'extension/package.json';
    const { stdout: pkgStdout } = await execFileAsync(
      process.platform === 'linux' ? 'unzip' : 'tar',
      process.platform === 'linux' ? ['-p', file, packageEntry] : ['-xf', file, '-O', packageEntry],
      {
        signal: artifactSignal,
        maxBuffer: 2 * 1024 * 1024,
        encoding: 'utf8',
        windowsHide: true,
      },
    );
    const packageJson = JSON.parse(pkgStdout);

    return {
      packageJson,
      serverBundle,
      vsixVersion,
      serverVersion,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export const fetchVsxBundle = fetchVsixBundle;

export async function fetchVsxPackageJson(options = {}) {
  const bundle = await fetchVsixBundle(options);
  return bundle.packageJson;
}

export function extractVsixConfig(vsixPackageJson) {
  const activationEvents = Array.isArray(vsixPackageJson?.activationEvents)
    ? vsixPackageJson.activationEvents
    : [];

  const rawMarkers = [];
  for (const event of activationEvents) {
    const match = event.match(/^workspaceContains:(?:\*\/)?([a-zA-Z0-9_.-]+)$/);
    if (match?.[1] && !rawMarkers.includes(match[1])) {
      rawMarkers.push(match[1]);
    }
  }

  const knownMarkers = [
    'pom.xml',
    'build.gradle',
    'build.gradle.kts',
    'settings.gradle',
    'settings.gradle.kts',
    'BUILD.bazel',
    'MODULE.bazel',
    'WORKSPACE',
    'WORKSPACE.bazel',
    '.bazelproject',
    '.idea',
    '*.iml',
  ];

  const rootMarkers = [
    ...knownMarkers.filter(
      (m) =>
        rawMarkers.includes(m) ||
        ['WORKSPACE', 'WORKSPACE.bazel', '.bazelproject', '.idea', '*.iml'].includes(m),
    ),
    ...rawMarkers.filter((m) => !knownMarkers.includes(m)),
  ];

  const fileTypes = [
    '.java',
    '.kt',
    '.kts',
    '.xml',
    '.properties',
    '.yaml',
    '.yml',
    '.bazelproject',
  ];

  const javaSettings = {};
  const kotlinSettings = {};
  const configurations = Array.isArray(vsixPackageJson?.contributes?.configuration)
    ? vsixPackageJson.contributes.configuration
    : [];

  for (const config of configurations) {
    for (const [key, prop] of Object.entries(config.properties || {})) {
      if (key.startsWith('jetbrains.java.') && prop.default === true) {
        javaSettings[key.slice('jetbrains.java.'.length)] = true;
      } else if (key.startsWith('jetbrains.kotlin.') && prop.default === true) {
        kotlinSettings[key.slice('jetbrains.kotlin.'.length)] = true;
      }
    }
  }

  return {
    rootMarkers,
    fileTypes,
    settings: {
      'jetbrains.java': javaSettings,
      'jetbrains.kotlin': kotlinSettings,
    },
  };
}

export function mergeMarketplaceConfig(currentMarketplace, extracted) {
  const next = JSON.parse(JSON.stringify(currentMarketplace));
  const plugin = next.plugins?.[0];
  if (!plugin) throw new Error('Invalid marketplace.json: no plugins found');

  if (plugin.lspServers?.['intellij-server']) {
    const lsp = plugin.lspServers['intellij-server'];
    lsp.fileTypes = extracted.fileTypes;
    lsp.rootMarkers = extracted.rootMarkers;
    lsp.settings = {
      ...lsp.settings,
      ...extracted.settings,
    };
  }

  const dapMarkers = extracted.rootMarkers.filter((m) => m !== '*.iml');
  if (plugin.dapAdapters?.intellij) {
    plugin.dapAdapters.intellij.rootMarkers = dapMarkers;
  }
  if (plugin.dapAdapters?.['intellij-test']) {
    plugin.dapAdapters['intellij-test'].rootMarkers = dapMarkers;
  }

  return next;
}

export async function updateServerBundle(options) {
  const {
    version: requestedVersion,
    vsixVersion: requestedVsixVersion,
    check = false,
    syncMarketplace = false,
    fetch: fetchFn = globalThis.fetch,
    outputPath = resolve(
      fileURLToPath(new URL('../src/server/bundle-metadata.ts', import.meta.url)),
    ),
    marketplacePath = resolve(
      fileURLToPath(new URL('../.omp-plugin/marketplace.json', import.meta.url)),
    ),
    resourcesDir = resolve(fileURLToPath(new URL('../resources/ils', import.meta.url))),
  } = options ?? {};

  if (!requestedVersion && !syncMarketplace && !check) {
    throw new Error(
      'Usage: npm run update-bundle -- [--version <build|latest>] [--vsix-version <version>] [--check] [--sync-marketplace]',
    );
  }

  const sourceMetadataPath = resolve(
    fileURLToPath(new URL('../src/server/bundle-metadata.ts', import.meta.url)),
  );

  let existingText = null;
  let fileExists = false;
  let targetMeta = null;

  try {
    const s = await stat(outputPath);
    if (!s.isFile()) {
      throw new Error(`Target path is not a regular file: ${outputPath}`);
    }
    existingText = await readFile(outputPath, 'utf8');
    fileExists = true;
    targetMeta = parseBundleMetadataFile(existingText);
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      fileExists = false;
    } else {
      throw err;
    }
  }

  let canonicalMeta = null;
  try {
    const sourceText = await readFile(sourceMetadataPath, 'utf8');
    canonicalMeta = parseBundleMetadataFile(sourceText);
  } catch {
    // Ignored
  }

  let targetVersion;
  if (requestedVersion) {
    targetVersion =
      requestedVersion === 'latest'
        ? await latestServerVersion({ fetch: fetchFn })
        : validateServerVersion(requestedVersion);
  } else if (targetMeta?.serverVersion) {
    targetVersion = targetMeta.serverVersion;
  } else if (canonicalMeta?.serverVersion) {
    targetVersion = canonicalMeta.serverVersion;
  } else {
    throw new Error('Target server version could not be determined from bundle metadata');
  }

  let targetVsixVersion = null;
  if (requestedVsixVersion) {
    targetVsixVersion = validateVsixVersion(requestedVsixVersion);
  } else if (targetMeta?.serverVersion === targetVersion && targetMeta?.vsixVersion) {
    targetVsixVersion = targetMeta.vsixVersion;
  } else if (canonicalMeta?.serverVersion === targetVersion && canonicalMeta?.vsixVersion) {
    targetVsixVersion = canonicalMeta.vsixVersion;
  } else {
    throw new Error(
      `Cannot determine VSIX version for ILS version "${targetVersion}". Specify --vsix-version explicitly.`,
    );
  }
  // --- PHASE 1: REMOTE VALIDATION & FETCH (NO FILE WRITES HERE) ---
  let collectedPlatforms = null;
  let renderedMetadataText = null;

  if (requestedVersion || (check && !syncMarketplace)) {
    collectedPlatforms = await collectPlatformMetadata(targetVersion, fetchFn);
    renderedMetadataText = renderBundleMetadata({
      version: targetVersion,
      vsixVersion: targetVsixVersion,
      platforms: collectedPlatforms,
    });
  }

  let vsixBundle = null;
  let mergedMarketplaceJson = null;
  let isMarketplaceUpToDate = false;

  if (syncMarketplace) {
    // 1. Fetch and verify VSIX package and server-bundle binding
    vsixBundle = await fetchVsixBundle({
      fetch: fetchFn,
      vsixVersion: targetVsixVersion,
      expectedServerVersion: targetVersion,
    });

    // 2. If platform metadata was collected, verify server-bundle sha256 matches CDN hash
    if (collectedPlatforms) {
      const defaultPlatform = 'win32';
      const defaultArch = 'x64';
      const expectedSha256 = collectedPlatforms[defaultPlatform]?.hashes[defaultArch];
      if (
        expectedSha256 &&
        vsixBundle.serverBundle?.sha256?.toLowerCase() !== expectedSha256.toLowerCase()
      ) {
        throw new Error(
          `Open VSX server-bundle SHA-256 mismatch for ${defaultPlatform}/${defaultArch}: VSIX has ${vsixBundle.serverBundle.sha256}, upstream CDN has ${expectedSha256}`,
        );
      }
    }

    // 3. Extract and merge marketplace config
    const extracted = extractVsixConfig(vsixBundle.packageJson);
    let currentMarketplace;
    try {
      currentMarketplace = JSON.parse(await readFile(marketplacePath, 'utf8'));
    } catch (err) {
      throw new Error(`Failed to read marketplace.json at ${marketplacePath}: ${err.message}`);
    }

    const merged = mergeMarketplaceConfig(currentMarketplace, extracted);
    mergedMarketplaceJson = `${JSON.stringify(merged, null, 2)}\n`;
    isMarketplaceUpToDate = JSON.stringify(currentMarketplace) === JSON.stringify(merged);
  }

  // --- PHASE 2: CHECK MODE (成组验证) ---
  if (check) {
    let hasDiff = false;

    if (renderedMetadataText !== null) {
      if (!fileExists) {
        console.log(`[check] Target bundle metadata file does not exist: ${outputPath}`);
        hasDiff = true;
      } else if (existingText === renderedMetadataText) {
        console.log(`[check] Bundle metadata is up to date: ${targetVersion}`);
      } else {
        console.log(`[check] Bundle metadata differs from upstream ${targetVersion}`);
        hasDiff = true;
      }
    }

    if (syncMarketplace) {
      if (isMarketplaceUpToDate) {
        console.log(
          `[check] Marketplace configuration is up to date with upstream VSIX ${targetVsixVersion}`,
        );
      } else {
        console.log(
          `[check] Marketplace configuration differs from upstream VSIX ${targetVsixVersion}`,
        );
        hasDiff = true;
      }
    }

    const jvmResult = await verifyJvmAssets({ targetVersion, resourcesDir });
    if (jvmResult.ok) {
      console.log(`[check] JVM extension assets verified for ILS ${targetVersion}`);
    } else {
      console.log(
        `[check] JVM extension assets missing or mismatched for ILS ${targetVersion}: ${jvmResult.reason}`,
      );
      hasDiff = true;
    }

    return hasDiff ? 1 : 0;
  }

  // --- PHASE 3: UPDATE MODE (REACHED ONLY AFTER ALL REMOTE CHECKS SUCCEED) ---
  const jvmResult = await verifyJvmAssets({ targetVersion, resourcesDir });
  if (jvmResult.ok) {
    console.log(`JVM extension assets verified for ILS ${targetVersion}`);
  } else {
    console.log(
      `[info] JVM extension assets for ILS ${targetVersion} not yet staged (${jvmResult.reason}).\n` +
        `Follow-up: run 'npm run build:jvm' then 'npm run update-bundle -- --check' to verify.`,
    );
  }

  if (renderedMetadataText !== null) {
    if (fileExists && existingText === renderedMetadataText) {
      console.log(`Bundle metadata is already up to date: ${targetVersion}`);
    } else {
      const tempFile = join(dirname(outputPath), `.bundle-metadata-${randomUUID()}.tmp`);
      try {
        await writeFile(tempFile, renderedMetadataText, 'utf8');
        await replaceFile(tempFile, outputPath);
        console.log(`Successfully updated bundle metadata to ${targetVersion} at ${outputPath}`);
      } finally {
        await rm(tempFile, { force: true }).catch(() => {});
      }
    }
  }

  if (syncMarketplace && mergedMarketplaceJson !== null) {
    if (isMarketplaceUpToDate) {
      console.log(
        `Marketplace configuration is already up to date with upstream VSIX ${targetVsixVersion}`,
      );
    } else {
      const tempJsonFile = join(dirname(marketplacePath), `.marketplace-${randomUUID()}.tmp`);
      try {
        await writeFile(tempJsonFile, mergedMarketplaceJson, 'utf8');
        await replaceFile(tempJsonFile, marketplacePath);
        console.log(`Successfully updated marketplace configuration at ${marketplacePath}`);
      } finally {
        await rm(tempJsonFile, { force: true }).catch(() => {});
      }
    }
  }

  return 0;
}

function parseCliArgs(args) {
  let version = null;
  let vsixVersion = null;
  let check = false;
  let syncMarketplace = false;
  let seenVersion = false;
  let seenVsixVersion = false;
  let seenCheck = false;
  let seenSyncMarketplace = false;

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--version' || arg.startsWith('--version=')) {
      if (seenVersion) {
        throw new Error('Duplicate --version flag');
      }
      seenVersion = true;
      if (arg.startsWith('--version=')) {
        version = arg.slice(10).trim();
      } else {
        i++;
        if (i >= args.length || args[i].startsWith('-')) {
          throw new Error('--version flag requires an argument');
        }
        version = args[i].trim();
      }
    } else if (arg === '--vsix-version' || arg.startsWith('--vsix-version=')) {
      if (seenVsixVersion) {
        throw new Error('Duplicate --vsix-version flag');
      }
      seenVsixVersion = true;
      if (arg.startsWith('--vsix-version=')) {
        vsixVersion = arg.slice(15).trim();
      } else {
        i++;
        if (i >= args.length || args[i].startsWith('-')) {
          throw new Error('--vsix-version flag requires an argument');
        }
        vsixVersion = args[i].trim();
      }
    } else if (arg === '--check') {
      if (seenCheck) {
        throw new Error('Duplicate --check flag');
      }
      seenCheck = true;
      check = true;
    } else if (arg === '--sync-marketplace') {
      if (seenSyncMarketplace) {
        throw new Error('Duplicate --sync-marketplace flag');
      }
      seenSyncMarketplace = true;
      syncMarketplace = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
    i++;
  }

  if (!version && !syncMarketplace && !check) {
    throw new Error(
      'Usage: npm run update-bundle -- [--version <build|latest>] [--vsix-version <version>] [--check] [--sync-marketplace]',
    );
  }

  return { version, vsixVersion, check, syncMarketplace };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const { version, vsixVersion, check, syncMarketplace } = parseCliArgs(process.argv.slice(2));
    const code = await updateServerBundle({ version, vsixVersion, check, syncMarketplace });
    process.exitCode = code;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
