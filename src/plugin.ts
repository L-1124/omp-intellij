import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const rootToken = '$' + '{OMP_PLUGIN_ROOT}';
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
        ? value.replaceAll(rootToken, root.replace(/\\/g, '/').replace(/\/$/, ''))
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
