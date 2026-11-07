#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = join(root, '.runtime');
const args = process.argv.slice(2);
if (args.some((arg) => !['--apply', '--dry-run'].includes(arg))) {
  throw new Error('Usage: node scripts/clean-runtime.mjs [--apply|--dry-run]');
}
const apply = args.includes('--apply');

function consumersRunning() {
  if (process.platform === 'win32') {
    const script =
      "$ErrorActionPreference = 'Stop'; @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $env:OMP_CLEAN_PID -and $_.Name -match '^(omp|node|bun|java|javaw|intellij-server)\\.exe$' } | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress";
    let output;
    for (const shell of ['pwsh.exe', 'powershell.exe']) {
      try {
        output = execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 15000,
          env: { ...process.env, OMP_CLEAN_PID: String(process.pid) },
        });
        break;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    if (output === undefined) throw new Error('Cannot inspect live runtime consumers');
    return output.trim() !== '' && output.trim() !== '[]';
  }
  const output = execFileSync('ps', ['-A', '-o', 'pid=,comm='], {
    encoding: 'utf8',
    timeout: 15000,
  });
  return output.split('\n').some((line) => {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    return (
      match &&
      Number(match[1]) !== process.pid &&
      /(?:^|\/)(?:omp|node|bun|java|intellij-server)$/.test(match[2])
    );
  });
}

const protectedHashes = new Set();
for (const file of ['.lsp.json', '.dap.json']) {
  const text = await readFile(join(root, file), 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  for (const match of text.matchAll(/\.runtime[\\/]+([a-f0-9]{64})/g))
    protectedHashes.add(match[1]);
}
const busy = consumersRunning();
if (apply && busy)
  throw new Error(
    'Close OMP, Bridge, DAP and IntelliJ server processes before cleaning runtime caches (to clean run: node scripts/clean-runtime.mjs --apply)',
  );
const entries = await readdir(runtime, { withFileTypes: true }).catch((error) => {
  if (error.code === 'ENOENT') return [];
  throw error;
});
for (const entry of entries) {
  if (!entry.isDirectory() || protectedHashes.has(entry.name)) continue;
  const temporary = /^[a-f0-9]{64}\.[a-f0-9-]+\.tmp$/.test(entry.name);
  if (!temporary && !/^[a-f0-9]{64}$/.test(entry.name)) continue;
  const target = join(runtime, entry.name);
  if (temporary && Date.now() - (await stat(target)).mtimeMs <= 3600000) continue;
  console.log(
    `${apply ? 'Removing' : 'Would remove'} ${target}${busy ? ' (consumers active; apply blocked)' : ''}`,
  );
  if (apply) await rm(target, { recursive: true });
}
