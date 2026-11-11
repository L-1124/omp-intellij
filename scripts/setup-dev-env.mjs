#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');

export function resolveTargetVersion() {
  const sourceMetadataPath = join(REPO_ROOT, 'src', 'server', 'bundle-metadata.ts');
  if (existsSync(sourceMetadataPath)) {
    try {
      const text = readFileSync(sourceMetadataPath, 'utf8');
      const m = text.match(/export\s+const\s+DEFAULT_SERVER_VERSION\s*=\s*['"]([^'"]+)['"]/);
      if (m?.[1]) {
        return m[1].trim();
      }
    } catch {}
  }
  const compiledBundlesPath = join(REPO_ROOT, 'dist', 'server', 'bundles.js');
  if (existsSync(compiledBundlesPath)) {
    try {
      const text = readFileSync(compiledBundlesPath, 'utf8');
      const m = text.match(/DEFAULT_SERVER_VERSION\s*=\s*['"]([^'"]+)['"]/);
      if (m?.[1]) {
        return m[1].trim();
      }
    } catch {}
  }
  return '271.2085.0';
}

export async function loadBundleMetadata() {
  try {
    const bundles = await import('../dist/server/bundles.js');
    const meta = await import('../dist/server/bundle-metadata.js');
    return {
      TARGET_VERSION: bundles.DEFAULT_SERVER_VERSION,
      serverBundle: bundles.serverBundle,
      SERVER_BUNDLE_PLATFORMS: meta.SERVER_BUNDLE_PLATFORMS,
    };
  } catch (err) {
    throw new Error(
      `Cannot load bundle metadata from ../dist/server/. Did you build the TypeScript project first? (${err.message})`,
    );
  }
}

export function parseArgs(args) {
  let explicitHome = null;
  const remaining = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--ils-home') {
      const next = args[++i];
      if (!next || next.startsWith('--')) {
        throw new Error('Missing value for --ils-home');
      }
      explicitHome = next;
    } else if (arg.startsWith('--ils-home=')) {
      explicitHome = arg.slice('--ils-home='.length);
    } else {
      remaining.push(arg);
    }
  }
  return { explicitHome, remaining };
}

export function verifyIlsHome(dir, expectedVersion) {
  if (!dir || !existsSync(dir)) return false;
  const buildTxt = join(dir, 'build.txt');
  if (!existsSync(buildTxt)) return false;
  try {
    const content = readFileSync(buildTxt, 'utf8').trim();
    return content === `ILS-${expectedVersion}`;
  } catch {
    return false;
  }
}

export function resolveIlsJbr(ilsHome, platform = process.platform) {
  if (!ilsHome || typeof ilsHome !== 'string') return null;
  const jbrDir = join(ilsHome, 'jbr');
  if (!existsSync(jbrDir)) return null;

  if (platform === 'darwin') {
    const macHome = join(jbrDir, 'Contents', 'Home');
    const javaBin = join(macHome, 'bin', 'java');
    if (existsSync(javaBin)) {
      return macHome;
    }
  }

  const isWin = platform === 'win32';
  const javaExe = join(jbrDir, 'bin', isWin ? 'java.exe' : 'java');
  if (existsSync(javaExe)) {
    return jbrDir;
  }
  return null;
}

export function findExistingIlsHome(explicitHome, targetVersion) {
  if (explicitHome) {
    const resolved = resolve(explicitHome);
    if (!verifyIlsHome(resolved, targetVersion)) {
      throw new Error(
        `Explicit --ils-home path "${resolved}" is not a valid ILS-${targetVersion} SDK directory.`,
      );
    }
    return resolved;
  }

  const localPropsPath = join(REPO_ROOT, 'jvm', 'intellij-android', 'local.properties');
  if (existsSync(localPropsPath)) {
    try {
      const text = readFileSync(localPropsPath, 'utf8');
      const m = text.match(/^\s*ils\.home\s*=\s*(.+)$/m);
      if (m?.[1]) {
        const rawPath = m[1].trim().replace(/\\:/g, ':').replace(/\\\\/g, '\\');
        const candidate = resolve(rawPath);
        if (verifyIlsHome(candidate, targetVersion)) return candidate;
      }
    } catch {}
  }

  const configPath =
    process.env.OMP_INTELLIJ_CONFIG || join(homedir(), '.omp', 'agent', 'intellij.json');
  if (existsSync(configPath)) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
      if (cfg?.server?.installDir) {
        const candidate = join(cfg.server.installDir, 'versions', targetVersion);
        if (verifyIlsHome(candidate, targetVersion)) return resolve(candidate);
      }
    } catch {}
  }

  const defaultDir = join(homedir(), '.omp', 'servers', 'intellij', 'versions', targetVersion);
  if (verifyIlsHome(defaultDir, targetVersion)) return resolve(defaultDir);

  return null;
}

function extractArchive(archivePath, destDir, isZip) {
  if (!isZip) {
    execFileSync('tar', ['-xzf', archivePath, '-C', destDir], { stdio: 'inherit' });
    return;
  }

  try {
    execFileSync('tar', ['-xf', archivePath, '-C', destDir], { stdio: 'inherit' });
    return;
  } catch {
    if (process.platform === 'win32') {
      const escapedArchive = archivePath.replace(/'/g, "''");
      const escapedDest = destDir.replace(/'/g, "''");
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$ProgressPreference = 'SilentlyContinue'; Expand-Archive -LiteralPath '${escapedArchive}' -DestinationPath '${escapedDest}' -Force`,
        ],
        { stdio: 'inherit' },
      );
      return;
    }
    execFileSync('unzip', ['-q', '-o', archivePath, '-d', destDir], { stdio: 'inherit' });
  }
}

async function downloadIls(targetDir, { TARGET_VERSION, serverBundle, SERVER_BUNDLE_PLATFORMS }) {
  const platform = process.platform;
  const arch = process.arch;
  const bundle = serverBundle(platform, arch);
  const bundleMeta = SERVER_BUNDLE_PLATFORMS[platform];
  const extension = bundleMeta?.extension ?? (bundle.archive === 'zip' ? 'win.zip' : 'tar.gz');
  const isZip = extension === 'win.zip' || bundle.archive === 'zip';

  const parentDir = dirname(targetDir);
  mkdirSync(parentDir, { recursive: true });

  const stagingDir = join(parentDir, `.staging-${TARGET_VERSION}-${Date.now()}`);
  mkdirSync(stagingDir, { recursive: true });
  const tempArchive = join(stagingDir, `download.${extension}`);

  try {
    console.log(`[setup-dev-env] Downloading ILS ${bundle.version} from ${bundle.url}...`);
    const response = await fetch(bundle.url);
    if (!response.ok || !response.body) {
      throw new Error(
        `Failed to download ILS archive: HTTP ${response.status} ${response.statusText}`,
      );
    }

    const hash = createHash('sha256');
    const hashSpy = new PassThrough();
    hashSpy.on('data', (chunk) => hash.update(chunk));

    const fileStream = createWriteStream(tempArchive);
    await pipeline(Readable.fromWeb(response.body), hashSpy, fileStream);

    const actualHash = hash.digest('hex');
    if (actualHash.toLowerCase() !== bundle.sha256.toLowerCase()) {
      throw new Error(
        `Downloaded archive SHA-256 mismatch: expected ${bundle.sha256}, got ${actualHash}`,
      );
    }

    console.log(`[setup-dev-env] Extracting archive...`);
    extractArchive(tempArchive, stagingDir, isZip);
    rmSync(tempArchive, { force: true });

    if (!verifyIlsHome(stagingDir, TARGET_VERSION)) {
      throw new Error(
        `Extraction completed, but archive does not contain valid ILS-${TARGET_VERSION}`,
      );
    }

    rmSync(targetDir, { recursive: true, force: true });
    for (let attempt = 1; ; attempt++) {
      try {
        renameSync(stagingDir, targetDir);
        break;
      } catch (err) {
        if (
          process.platform === 'win32' &&
          (err.code === 'EPERM' || err.code === 'EACCES') &&
          attempt < 5
        ) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 200);
          continue;
        }
        throw err;
      }
    }
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

export function updateLocalProperties(localPropsPath, normalizedHome) {
  mkdirSync(dirname(localPropsPath), { recursive: true });
  const propLine = `ils.home=${normalizedHome}`;

  if (existsSync(localPropsPath)) {
    const existing = readFileSync(localPropsPath, 'utf8');
    if (/^\s*ils\.home\s*=/m.test(existing)) {
      const updated = existing.replace(/^\s*ils\.home\s*=.*$/m, () => propLine);
      writeFileSync(localPropsPath, updated, 'utf8');
      return;
    }
    const prefix = existing.endsWith('\n') ? existing : `${existing}\n`;
    writeFileSync(localPropsPath, `${prefix}${propLine}\n`, 'utf8');
    return;
  }

  const content = `# Auto-generated by scripts/setup-dev-env.mjs\n${propLine}\n`;
  writeFileSync(localPropsPath, content, 'utf8');
}

export async function setupDevEnvironment({ explicitHome } = {}) {
  const targetVersion = resolveTargetVersion();
  let resolvedHome = findExistingIlsHome(explicitHome, targetVersion);

  if (!resolvedHome) {
    console.log(
      `[setup-dev-env] ILS ${targetVersion} not found locally. Initiating fallback download...`,
    );
    const metadata = await loadBundleMetadata();
    const finalTargetDir = join(
      homedir(),
      '.omp',
      'servers',
      'intellij',
      'versions',
      targetVersion,
    );

    await downloadIls(finalTargetDir, metadata);
    resolvedHome = finalTargetDir;
  }

  const normalizedHome = resolvedHome.replace(/\\/g, '/');
  const localPropsPath = join(REPO_ROOT, 'jvm', 'intellij-android', 'local.properties');
  updateLocalProperties(localPropsPath, normalizedHome);

  console.log(`[setup-dev-env] Configured jvm/intellij-android/local.properties`);
  console.log(`[setup-dev-env] ils.home=${normalizedHome}`);
  console.log(
    `[setup-dev-env] Development environment is ready for standard Gradle builds and IDE sync.`,
  );
  return { ilsHome: resolvedHome, targetVersion };
}

async function main() {
  const { explicitHome } = parseArgs(process.argv.slice(2));
  await setupDevEnvironment({ explicitHome });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(`[setup-dev-env] ERROR: ${err.message}`);
    process.exit(1);
  });
}
