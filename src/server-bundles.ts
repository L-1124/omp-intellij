export interface ServerBundle {
  version: string;
  url: string;
  sha256: string;
  size?: number;
  archive: 'zip' | 'tar.gz';
}

// Published archive metadata: https://github.com/JetBrains/intellij-lsp.nvim/blob/HEAD/lua/intellij-lsp/server_bundles.lua
export const DEFAULT_SERVER_VERSION = '263.7084.0';
export const LATEST_VERSION_URL =
  'https://raw.githubusercontent.com/JetBrains/intellij-lsp.nvim/HEAD/lua/intellij-lsp/server_bundles.lua';

const VERSION_REGEX = /^\d+(?:\.\d+){2,3}$/;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const platforms: Record<
  string,
  { extension: string; hashes: Record<string, string>; sizes: Record<string, number> }
> = {
  darwin: {
    extension: 'sit',
    hashes: {
      arm64: 'ea728da71e3511939b4cb8e4af4aa5e4dda6e0ab7c2bdd1830a5d110bdf2bbec',
      x64: '3b31cd867ce0e361bfc763ba78cf4fa1dcb1a5324b97c817a0ec045532278420',
    },
    sizes: { arm64: 378499345, x64: 380456870 },
  },
  linux: {
    extension: 'tar.gz',
    hashes: {
      arm64: 'd5df0980acc4eeb35b1e76227caa62639fcda188649064d17b5b0de1077b38c0',
      x64: '3842f2f457e29e58cd9c37a97482b28255d598a2ff142075753d947206c0b922',
    },
    sizes: { arm64: 385782431, x64: 386777831 },
  },
  win32: {
    extension: 'win.zip',
    hashes: {
      arm64: '2ce197ad10684d55334c5611433c1479ccb574e52d78e41d023e3f2dd0be4704',
      x64: 'd84629cbdd79d58f021a15a75f05018518398906519a0e830df6f8a8d515e286',
    },
    sizes: { arm64: 361354713, x64: 381741020 },
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

async function readBoundedText(
  response: Response,
  maxBytes: number = MAX_RESPONSE_BYTES,
): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && Number.parseInt(contentLength, 10) > maxBytes) {
    await response.body?.cancel();
    throw new Error(`Response exceeds maximum allowed size of ${maxBytes} bytes`);
  }
  if (response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let totalBytes = 0;
    let result = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          throw new Error(`Response exceeded maximum allowed size of ${maxBytes} bytes`);
        }
        result += decoder.decode(value, { stream: true });
      }
      result += decoder.decode();
      return result;
    } catch (error: unknown) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
  }
  return '';
}

export interface LatestServerVersionOptions {
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

export async function latestServerVersion(options?: LatestServerVersionOptions): Promise<string> {
  const fetchFn = options?.fetch ?? fetch;
  const signal = timeoutSignal(options?.signal);

  const response = await fetchFn(LATEST_VERSION_URL, { signal });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `Failed to fetch latest server version from ${LATEST_VERSION_URL}: HTTP ${response.status} ${response.statusText}`,
    );
  }

  const text = await readBoundedText(response);
  const version = parseLatestVersionFromLua(text);
  return validateServerVersion(version);
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
  const targetVersion =
    version === 'latest'
      ? await latestServerVersion({
          signal: deadlineSignal,
          fetch: options?.fetch,
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
