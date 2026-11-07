import { DEFAULT_SERVER_VERSION, SERVER_BUNDLE_PLATFORMS } from './bundle-metadata.js';

export { DEFAULT_SERVER_VERSION };

export interface ServerBundle {
  version: string;
  url: string;
  sha256: string;
  size?: number;
  archive: 'zip' | 'tar.gz';
}

const VERSION_REGEX = /^\d+(?:\.\d+){2,3}$/;

export function serverBundle(
  platform: string = process.platform,
  arch: string = process.arch,
): ServerBundle {
  const entry = SERVER_BUNDLE_PLATFORMS[platform];
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
