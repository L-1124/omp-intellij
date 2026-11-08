#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const TARGET_VERSION = '271.2085.0';

function parseArgs(args) {
  let ilsHome = null;
  let targetVersion = TARGET_VERSION;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--ils-home') {
      if (i + 1 >= args.length) {
        throw new Error('Missing value for --ils-home');
      }
      ilsHome = args[++i];
    } else if (arg.startsWith('--ils-home=')) {
      ilsHome = arg.slice('--ils-home='.length);
    } else if (arg === '--target-version') {
      if (i + 1 >= args.length) {
        throw new Error('Missing value for --target-version');
      }
      targetVersion = args[++i];
    } else if (arg.startsWith('--target-version=')) {
      targetVersion = arg.slice('--target-version='.length);
    } else {
      throw new Error(`Unrecognized argument: "${arg}"`);
    }
  }

  if (targetVersion !== TARGET_VERSION) {
    throw new Error(`Only ILS ${TARGET_VERSION} is supported, received "${targetVersion}"`);
  }

  return { ilsHome, targetVersion };
}

function resolveIlsHome(explicitHome) {
  const home = explicitHome || process.env.OMP_ILS_HOME;
  if (!home) {
    throw new Error(
      'ILS home must be specified via --ils-home or OMP_ILS_HOME environment variable',
    );
  }
  const resolved = resolve(home);
  if (!existsSync(resolved)) {
    throw new Error(`ILS home directory does not exist: "${resolved}"`);
  }
  return resolved;
}

function verifyIlsVersion(ilsHome, expectedVersion) {
  const buildTxtPath = join(ilsHome, 'build.txt');
  if (!existsSync(buildTxtPath)) {
    throw new Error(`ILS installation build.txt missing at: "${buildTxtPath}"`);
  }
  const content = readFileSync(buildTxtPath, 'utf8').trim();
  const match = /^ILS-(.+)$/.exec(content);
  const ver = match ? match[1] : content;
  if (ver !== expectedVersion) {
    throw new Error(
      `ILS installation at "${ilsHome}" has version "${ver}", expected "${expectedVersion}"`,
    );
  }
  return ver;
}

function locateJbrJava(ilsHome) {
  const isWin = process.platform === 'win32';
  const jbrJava = join(ilsHome, 'jbr', 'bin', isWin ? 'java.exe' : 'java');
  if (!existsSync(jbrJava)) {
    throw new Error(`Bundled JBR java not found at: "${jbrJava}"`);
  }
  return jbrJava;
}

function main() {
  const { ilsHome: rawIlsHome, targetVersion } = parseArgs(process.argv.slice(2));
  const ilsHome = resolveIlsHome(rawIlsHome);
  verifyIlsVersion(ilsHome, targetVersion);

  const jbrJava = locateJbrJava(ilsHome);
  const jbrHome = join(ilsHome, 'jbr');

  const jvmDir = join(REPO_ROOT, 'jvm', 'intellij-android');
  const wrapperJar = join(jvmDir, 'gradle', 'wrapper', 'gradle-wrapper.jar');
  if (!existsSync(wrapperJar)) {
    throw new Error(`Gradle wrapper JAR not found at: "${wrapperJar}"`);
  }

  console.log(`[build:jvm] Invoking Gradle stageExtension using JBR: "${jbrJava}"...`);

  const gradleArgs = [
    `-Dorg.gradle.java.installations.paths=${jbrHome}`,
    '-cp',
    wrapperJar,
    'org.gradle.wrapper.GradleWrapperMain',
    'stageExtension',
    '--no-daemon',
    `-PilsHome=${ilsHome}`,
  ];

  const env = {
    ...process.env,
    JAVA_HOME: jbrHome,
  };

  const result = spawnSync(jbrJava, gradleArgs, {
    cwd: jvmDir,
    stdio: 'inherit',
    env,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

main();
