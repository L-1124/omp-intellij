import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const rootToken = '$' + '{OMP_PLUGIN_ROOT}';
const bun = (
  globalThis as unknown as {
    Bun?: {
      Transpiler: new (options: {
        loader: string;
        target: string;
      }) => {
        transformSync(source: string): string;
      };
    };
  }
).Bun;
if (!bun) throw new Error('The IntelliJ plugin entry must be loaded by OMP (Bun)');
const sourceRoot = join(root, 'src');
const sources = (await readdir(sourceRoot, { recursive: true }))
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'))
  .sort();
const inputs = await Promise.all(
  sources.map(async (name) => ({
    name,
    text: await readFile(join(sourceRoot, name), 'utf8'),
  })),
);
const resources = ['settings.json', '.omp-plugin/marketplace.json', 'package.json'];
const assets = await Promise.all(
  resources.map(async (name) => ({
    name,
    text: await readFile(join(root, name), 'utf8'),
  })),
);
async function collectBinaryAssets(
  dir: string,
  base: string = root,
): Promise<Array<{ name: string; buffer: Buffer }>> {
  const items: Array<{ name: string; buffer: Buffer }> = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        items.push(...(await collectBinaryAssets(full, base)));
      } else if (entry.isFile()) {
        const rel = relative(base, full).replace(/\\/g, '/');
        items.push({
          name: rel,
          buffer: await readFile(full),
        });
      }
    }
  } catch (error: unknown) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT')
      throw error;
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}
const binaryAssets = await collectBinaryAssets(join(root, 'resources', 'ils'));

const hash = createHash('sha256').update('node-transpile-v1');
for (const input of [...inputs, ...assets])
  hash.update(input.name).update('\0').update(input.text).update('\0');
for (const binAsset of binaryAssets)
  hash.update(binAsset.name).update('\0').update(binAsset.buffer).update('\0');
const runtimeBase = join(root, '.runtime');
const runtimeRoot = join(runtimeBase, hash.digest('hex'));

const marker = join(runtimeRoot, '.complete');
if ((await readFile(marker, 'utf8').catch(() => '')) !== 'ready') {
  const staging = `${runtimeRoot}.${randomUUID()}.tmp`;
  try {
    const transpiler = new bun.Transpiler({ loader: 'ts', target: 'node' });
    for (const input of inputs) {
      const target = join(staging, 'dist', input.name.replace(/\.ts$/, '.js'));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, transpiler.transformSync(input.text));
    }
    for (const asset of assets) {
      const target = join(staging, asset.name);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, asset.text);
    }
    for (const binAsset of binaryAssets) {
      const target = join(staging, binAsset.name);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, binAsset.buffer);
    }
    await writeFile(join(staging, '.complete'), 'ready');
    await mkdir(dirname(runtimeRoot), { recursive: true });
    try {
      await rename(staging, runtimeRoot);
    } catch (error) {
      if ((await readFile(marker, 'utf8').catch(() => '')) !== 'ready') throw error;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
const catalog: unknown = JSON.parse(
  await readFile(join(root, '.omp-plugin', 'marketplace.json'), 'utf8'),
);
if (
  !catalog ||
  typeof catalog !== 'object' ||
  !('plugins' in catalog) ||
  !Array.isArray(catalog.plugins)
) {
  throw new Error('Invalid IntelliJ plugin catalog');
}
const plugin: unknown = catalog.plugins.find(
  (entry: unknown) =>
    entry && typeof entry === 'object' && 'name' in entry && entry.name === 'omp-intellij',
);
if (
  !plugin ||
  typeof plugin !== 'object' ||
  !('lspServers' in plugin) ||
  !('dapAdapters' in plugin)
) {
  throw new Error('Missing IntelliJ native protocol declarations');
}

// OMP discovers these files but does not expand plugin-root tokens for LSP/DAP.
for (const [filename, wrapper, declaration] of [
  ['.lsp.json', 'servers', plugin.lspServers],
  ['.dap.json', 'adapters', plugin.dapAdapters],
] as const) {
  const content = `${JSON.stringify(
    { [wrapper]: declaration },
    (_key, value: unknown) =>
      typeof value === 'string'
        ? value.replaceAll(rootToken, runtimeRoot.replace(/\\/g, '/').replace(/\/$/, ''))
        : value,
    2,
  )}\n`;
  const target = join(root, filename);
  try {
    if ((await readFile(target, 'utf8')) === content) continue;
  } catch (error: unknown) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT')
      throw error;
  }
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content);
    try {
      await rename(temporary, target);
    } catch (error: unknown) {
      // Windows may reject replacing a file concurrently published by another session.
      if ((await readFile(target, 'utf8').catch(() => null)) !== content) throw error;
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

export { default } from './extension/extension.js';
