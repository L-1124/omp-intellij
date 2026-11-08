export const DEFAULT_SERVER_VERSION = '271.2085.0';
export const DEFAULT_VSIX_VERSION = '1.0.86';

export const SERVER_BUNDLE_PLATFORMS: Record<
  string,
  { extension: string; hashes: Record<string, string>; sizes: Record<string, number> }
> = {
  darwin: {
    extension: 'sit',
    hashes: {
      arm64: '0b8022627f20cdbe52508afbd5dcb3a6e18afc170fb84d8f70d92ad87b815a78',
      x64: '860e9ab04b99640790112a96de7f7df024b28bf3d6b573e5102a1a627b8e4a8e',
    },
    sizes: {
      arm64: 385899733,
      x64: 387873566,
    },
  },
  linux: {
    extension: 'tar.gz',
    hashes: {
      arm64: 'ba6d0831043c197edede20518e3137974bc53838ef6601e71c23ff785070fc34',
      x64: 'fb4fbac78a5043ce568e8b93ec57a1c40c4ba8136db68139d8813d7de3a4f7e4',
    },
    sizes: {
      arm64: 394206359,
      x64: 395255755,
    },
  },
  win32: {
    extension: 'win.zip',
    hashes: {
      arm64: 'b8cab4d3e30849440fe4d318c352981012ffb9b3895b2ceda1f73e430407274f',
      x64: '9ab4ecd982a8abdfaa1fff1bcdd4246db2d071653168c78555a5869271ee3f9f',
    },
    sizes: {
      arm64: 368571128,
      x64: 389022064,
    },
  },
};
