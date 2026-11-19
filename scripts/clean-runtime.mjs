#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readdir, readFile, readlink, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = join(root, '.runtime');
const args = process.argv.slice(2);
if (args.some((arg) => !['--apply', '--dry-run'].includes(arg))) {
  throw new Error('Usage: node scripts/clean-runtime.mjs [--apply|--dry-run]');
}
const apply = args.includes('--apply');

function normalize(value) {
  const normalized = value.replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function referencesTarget(value, target) {
  const text = normalize(value);
  const path = normalize(target);
  for (let index = text.indexOf(path); index !== -1; index = text.indexOf(path, index + 1)) {
    const before = text[index - 1];
    const after = text[index + path.length];
    if (
      (before === undefined || /[\s"'=,;/]/.test(before)) &&
      (after === undefined || /[\s"',;/]/.test(after))
    )
      return true;
  }
  return false;
}

function systemPathArgument(commandLine) {
  const quoted = /"--system-path=([^"]+)"|'--system-path=([^']+)'/.exec(commandLine);
  if (quoted) return quoted[1] ?? quoted[2];
  const value =
    /(?:^|\s)--system-path=(?:"([^"]+)"|'([^']+)'|(.+?)(?=\s--[\w-]+(?:=|\s|$)|$))/.exec(
      commandLine,
    );
  return value ? (value[1] ?? value[2] ?? value[3]) : null;
}

function listProcesses() {
  if (process.platform === 'win32') {
    const script =
      "$ErrorActionPreference = 'Stop'; $items = @(Get-CimInstance Win32_Process | Select-Object ProcessId, CommandLine, ExecutablePath, @{Name='StartTime';Expression={if ($_.CreationDate) {[DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds()}}}); ConvertTo-Json -InputObject $items -Compress";
    let output;
    for (const shell of ['pwsh.exe', 'powershell.exe']) {
      try {
        output = execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 15000,
          maxBuffer: 8 * 1024 * 1024,
        });
        break;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    if (output === undefined) throw new Error('Cannot inspect live runtime consumers');
    return JSON.parse(output || '[]').map((item) => ({
      pid: item.ProcessId,
      commandLine: item.CommandLine ?? '',
      executable: item.ExecutablePath ?? '',
      startTime: item.StartTime,
    }));
  }
  const output = execFileSync('ps', ['-A', '-o', 'pid=,args='], {
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return output.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    return match ? [{ pid: Number(match[1]), commandLine: match[2] }] : [];
  });
}

async function processIdentity(item) {
  if (process.platform === 'win32') return item;
  if (process.platform === 'linux') {
    const raw = await readFile(`/proc/${item.pid}/stat`, 'utf8');
    return {
      startTime: Number(raw.slice(raw.lastIndexOf(')') + 2).split(' ')[19]),
      executable: await readlink(`/proc/${item.pid}/exe`),
    };
  }
  const output = execFileSync('ps', ['-p', String(item.pid), '-o', 'lstart=,comm='], {
    encoding: 'utf8',
    timeout: 5000,
  });
  const match =
    /^([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/.exec(
      output.trim(),
    );
  return match ? { startTime: Date.parse(match[1]), executable: match[2] } : null;
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

async function consumersRunning(targets) {
  if (targets.length === 0) return false;
  const processes = listProcesses();
  if (
    processes.some(
      (item) =>
        item.pid !== process.pid &&
        targets.some((target) => referencesTarget(item.commandLine, target)),
    )
  )
    return true;

  const settings = await readJson(join(root, 'settings.json'));
  const systemPaths = new Set([
    join(homedir(), '.omp', 'cache', 'intellij', 'shared'),
    ...(typeof settings?.systemPath === 'string' ? [settings.systemPath] : []),
  ]);
  for (const item of processes) {
    const path = systemPathArgument(item.commandLine);
    if (path) systemPaths.add(path);
  }
  for (const systemPath of systemPaths) {
    const owner = await readJson(join(systemPath, 'omp-server.json'));
    if (
      !owner ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0 ||
      typeof owner.systemPath !== 'string' ||
      normalize(resolve(owner.systemPath)) !== normalize(resolve(systemPath)) ||
      !isAlive(owner.pid)
    )
      continue;
    const item = processes.find((candidate) => candidate.pid === owner.pid);
    if (!item) return true;
    let identity;
    try {
      identity = await processIdentity(item);
    } catch (error) {
      if (!isAlive(owner.pid)) continue;
      throw error;
    }
    if (
      !identity ||
      !Number.isFinite(identity.startTime) ||
      !identity.executable ||
      !Number.isFinite(owner.processStartTime) ||
      typeof owner.executable !== 'string'
    )
      return true;
    if (
      identity.startTime !== owner.processStartTime ||
      normalize(identity.executable) !== normalize(owner.executable)
    )
      continue;
    const liveSystemPath = systemPathArgument(item.commandLine);
    if (!liveSystemPath || normalize(resolve(liveSystemPath)) !== normalize(resolve(systemPath)))
      return true;
    // JVM options are inherited through the environment, not the Windows command line.
    if (
      !Array.isArray(owner.pluginPaths) ||
      owner.pluginPaths.some((path) => typeof path !== 'string')
    )
      return true;
    if (owner.pluginPaths.some((path) => targets.some((target) => referencesTarget(path, target))))
      return true;
  }
  return false;
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
const entries = await readdir(runtime, { withFileTypes: true }).catch((error) => {
  if (error.code === 'ENOENT') return [];
  throw error;
});
const targets = [];
for (const entry of entries) {
  if (!entry.isDirectory() || protectedHashes.has(entry.name)) continue;
  const temporary = /^[a-f0-9]{64}\.[a-f0-9-]+\.tmp$/.test(entry.name);
  if (!temporary && !/^[a-f0-9]{64}$/.test(entry.name)) continue;
  const target = join(runtime, entry.name);
  if (temporary && Date.now() - (await stat(target)).mtimeMs <= 3600000) continue;
  targets.push(target);
}
const busy = await consumersRunning(targets);
if (apply && busy)
  throw new Error(
    'A runtime cache is in use, or a live managed IntelliJ server lacks plugin-path ownership metadata. Stop its consumers before cleaning runtime caches.',
  );
for (const target of targets) {
  console.log(
    `${apply ? 'Removing' : 'Would remove'} ${target}${busy ? ' (consumers active; apply blocked)' : ''}`,
  );
  if (apply) await rm(target, { recursive: true });
}
