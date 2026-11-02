export interface ServerBundle {
  version: string;
  url: string;
  sha256: string;
  size?: number;
  archive: 'zip' | 'tar.gz';
}

// Published archive metadata: https://github.com/JetBrains/intellij-lsp.nvim/blob/HEAD/lua/intellij-lsp/server_bundles.lua
const VERSION = '263.7084.0';
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
    version: VERSION,
    url: `https://download.jetbrains.com/language-server/intellij-server/${VERSION}/intellij-server-${VERSION}${suffix}.${entry.extension}`,
    sha256,
    size: entry.sizes[arch],
    archive: entry.extension === 'tar.gz' ? 'tar.gz' : 'zip',
  };
}
