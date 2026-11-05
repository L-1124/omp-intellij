import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ServerBundle {
  version: string;
  url: string;
  sha256: string;
  size?: number;
  archive: 'zip' | 'tar.gz';
}

// Published archive metadata: https://github.com/JetBrains/intellij-lsp.nvim/blob/HEAD/lua/intellij-lsp/server_bundles.lua
export const DEFAULT_SERVER_VERSION = '271.2085.0';
export const LATEST_VERSION_URL =
  'https://raw.githubusercontent.com/JetBrains/intellij-lsp.nvim/HEAD/lua/intellij-lsp/server_bundles.lua';

const VERSION_REGEX = /^\d+(?:\.\d+){2,3}$/;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
// The Open VSX package bundles the server manifest inside a ~13.5 MB VSIX.
const VSX_ARTIFACT_MAX_BYTES = 32 * 1024 * 1024;
const VSX_ARTIFACT_TIMEOUT_MS = 120_000;
const platforms: Record<
  string,
  { extension: string; hashes: Record<string, string>; sizes: Record<string, number> }
> = {
  darwin: {
    extension: 'sit',
    hashes: {
      arm64: '0b8022627f20cdbe52508afbd5dcb3a6e18afc170fb84d8f70d92ad87b815a78',
      x64: '860e9ab04b99640790112a96de7f7df024b28bf3d6b573e5102a1a627b8e4a8e',
    },
    sizes: { arm64: 385899733, x64: 387873566 },
  },
  linux: {
    extension: 'tar.gz',
    hashes: {
      arm64: 'ba6d0831043c197edede20518e3137974bc53838ef6601e71c23ff785070fc34',
      x64: 'fb4fbac78a5043ce568e8b93ec57a1c40c4ba8136db68139d8813d7de3a4f7e4',
    },
    sizes: { arm64: 394206359, x64: 395255755 },
  },
  win32: {
    extension: 'win.zip',
    hashes: {
      arm64: 'b8cab4d3e30849440fe4d318c352981012ffb9b3895b2ceda1f73e430407274f',
      x64: '9ab4ecd982a8abdfaa1fff1bcdd4246db2d071653168c78555a5869271ee3f9f',
    },
    sizes: { arm64: 368571128, x64: 389022064 },
  },
};

export function serverBundle(
  platform: string = process.platform,
  arch: string = process.arch,
): ServerBundle {
  const entry = platforms[platform];
  const sha256 = entry?.hashes[arch];
  if (!entry || !sha256) throw new Error(`No IntelliJ server bundle for ${platform}/${arch}`);
  const suffix = arch === 'arm64' ? '-aarch64' : '';
  return {
    version: DEFAULT_SERVER_VERSION,
    url: `https://download.jetbrains.com/language-server/intellij-server/${DEFAULT_SERVER_VERSION}/intellij-server-${DEFAULT_SERVER_VERSION}${suffix}.${entry.extension}`,
    sha256,
    size: entry.sizes[arch],
    archive: entry.extension === 'tar.gz' ? 'tar.gz' : 'zip',
  };
}

export function validateServerVersion(version: string): string {
  if (typeof version !== 'string' || !VERSION_REGEX.test(version)) {
    throw new Error(
      `Invalid server version "${version}": expected 3 or 4 dot-separated numeric segments (e.g. 263.7084.0)`,
    );
  }
  return version;
}

export function parseLatestVersionFromLua(text: string): string {
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

export function parseSha256Sidecar(text: string, expectedBasename: string): string {
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

function timeoutSignal(signal?: AbortSignal): AbortSignal {
  return signal
    ? AbortSignal.any([signal, AbortSignal.timeout(DEFAULT_TIMEOUT_MS)])
    : AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
}

async function readBoundedBytes(response: Response, maxBytes: number): Promise<Buffer> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && Number.parseInt(contentLength, 10) > maxBytes) {
    await response.body?.cancel();
    throw new Error(`Response exceeds maximum allowed size of ${maxBytes} bytes`);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
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
  } catch (error: unknown) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function readBoundedText(response: Response): Promise<string> {
  return new TextDecoder('utf-8', { fatal: true }).decode(
    await readBoundedBytes(response, MAX_RESPONSE_BYTES),
  );
}

export interface LatestServerVersionOptions {
  signal?: AbortSignal;
  fetch?: typeof fetch;
  platform?: string;
  arch?: string;
}

async function latestLuaVersion(fetchFn: typeof fetch, signal: AbortSignal): Promise<string> {
  const response = await fetchFn(LATEST_VERSION_URL, { signal });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Lua manifest: HTTP ${response.status} ${response.statusText}`);
  }
  return validateServerVersion(parseLatestVersionFromLua(await readBoundedText(response)));
}

async function latestVsxVersion(
  fetchFn: typeof fetch,
  signal: AbortSignal,
  platform: string,
  arch: string,
): Promise<string> {
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
    const name = `intellij-server-${version}${suffix}.${platforms[platform].extension}`;
    if (
      bundle.archiveName !== name ||
      bundle.url !==
        `https://download.jetbrains.com/language-server/intellij-server/${version}/${name}` ||
      typeof bundle.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(bundle.sha256)
    ) {
      throw new Error('Invalid Open VSX server bundle');
    }
    return version;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function latestServerVersion(options?: LatestServerVersionOptions): Promise<string> {
  const fetchFn = options?.fetch ?? fetch;
  const platform = options?.platform ?? process.platform;
  const arch = options?.arch ?? process.arch;
  if (!platforms[platform]?.hashes[arch]) {
    throw new Error(`No IntelliJ server bundle for ${platform}/${arch}`);
  }
  const signal = timeoutSignal(options?.signal);
  signal.throwIfAborted();
  const results = await Promise.allSettled([
    latestLuaVersion(fetchFn, signal),
    latestVsxVersion(fetchFn, signal, platform, arch),
  ]);
  options?.signal?.throwIfAborted();
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

export interface ResolveServerBundleOptions {
  platform?: string;
  arch?: string;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

export async function resolveServerBundle(
  version: string,
  options?: ResolveServerBundleOptions,
): Promise<ServerBundle> {
  options?.signal?.throwIfAborted();

  const platform = options?.platform ?? process.platform;
  const arch = options?.arch ?? process.arch;
  const entry = platforms[platform];
  if (!entry || (arch !== 'arm64' && arch !== 'x64')) {
    throw new Error(`No IntelliJ server bundle for ${platform}/${arch}`);
  }

  if (version !== 'latest') {
    const targetVersion = validateServerVersion(version);
    if (targetVersion === DEFAULT_SERVER_VERSION) {
      return serverBundle(platform, arch);
    }
  }

  const deadlineSignal = timeoutSignal(options?.signal);
  // Latest resolution may download the ~13.5 MB Open VSX package, so it needs a wider deadline
  // than the metadata-only timeout.
  const latestSignal = AbortSignal.any([
    deadlineSignal,
    AbortSignal.timeout(VSX_ARTIFACT_TIMEOUT_MS),
  ]);
  const targetVersion =
    version === 'latest'
      ? await latestServerVersion({
          signal: latestSignal,
          fetch: options?.fetch,
          platform,
          arch,
        })
      : validateServerVersion(version);

  if (targetVersion === DEFAULT_SERVER_VERSION) {
    return serverBundle(platform, arch);
  }

  const suffix = arch === 'arm64' ? '-aarch64' : '';
  const archiveBasename = `intellij-server-${targetVersion}${suffix}.${entry.extension}`;
  const archiveUrl = `https://download.jetbrains.com/language-server/intellij-server/${targetVersion}/${archiveBasename}`;
  const sidecarUrl = `${archiveUrl}.sha256`;

  const fetchFn = options?.fetch ?? fetch;
  const response = await fetchFn(sidecarUrl, { signal: deadlineSignal });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `Failed to fetch SHA-256 for ${targetVersion} (${platform}/${arch}): HTTP ${response.status} ${response.statusText}`,
    );
  }

  const text = await readBoundedText(response);
  const sha256 = parseSha256Sidecar(text, archiveBasename);

  return {
    version: targetVersion,
    url: archiveUrl,
    sha256,
    archive: entry.extension === 'tar.gz' ? 'tar.gz' : 'zip',
  };
}
