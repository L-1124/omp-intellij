#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..');
const TARGET_VERSION = '271.2085.0';
const DETERMINISTIC_TIMESTAMP = '2026-01-01T00:00:00Z';

function parseArgs(args) {
  const options = {
    ilsHome: null,
    targetVersion: TARGET_VERSION,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--ils-home' && i + 1 < args.length) {
      options.ilsHome = args[++i];
    } else if (arg.startsWith('--ils-home=')) {
      options.ilsHome = arg.slice('--ils-home='.length);
    } else if (arg === '--target-version' && i + 1 < args.length) {
      options.targetVersion = args[++i];
    } else if (arg.startsWith('--target-version=')) {
      options.targetVersion = arg.slice('--target-version='.length);
    }
  }
  if (options.targetVersion !== TARGET_VERSION)
    throw new Error(`Only ILS ${TARGET_VERSION} is supported`);
  return options;
}

function resolveIlsHome(explicitHome) {
  if (explicitHome) {
    const resolved = resolve(explicitHome);
    if (!existsSync(resolved)) {
      throw new Error(`Specified --ils-home does not exist: "${resolved}"`);
    }
    return resolved;
  }
  if (process.env.OMP_ILS_HOME && existsSync(process.env.OMP_ILS_HOME)) {
    return resolve(process.env.OMP_ILS_HOME);
  }
  throw new Error(
    `Cannot find installed ILS ${TARGET_VERSION}. Pass --ils-home <path> or set OMP_ILS_HOME.`,
  );
}

function verifyIlsVersion(ilsHome, expectedVersion) {
  const buildTxtPath = join(ilsHome, 'build.txt');
  if (existsSync(buildTxtPath)) {
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
  const productInfoPath = join(ilsHome, 'product-info.json');
  if (existsSync(productInfoPath)) {
    const json = JSON.parse(readFileSync(productInfoPath, 'utf8'));
    const ver = json.buildNumber || json.version;
    if (ver && ver !== expectedVersion) {
      throw new Error(
        `ILS installation at "${ilsHome}" has version "${ver}", expected "${expectedVersion}"`,
      );
    }
    if (ver) return ver;
  }
  throw new Error('ILS installation version metadata is missing');
}

function locateToolchain(ilsHome) {
  const isWin = process.platform === 'win32';

  const bundledJavac = join(ilsHome, 'jbr', 'bin', isWin ? 'javac.exe' : 'javac');
  let javacBin = null;
  let javacVersion = null;

  if (existsSync(bundledJavac)) {
    try {
      const out = execFileSync(bundledJavac, ['--version'], { encoding: 'utf8' }).trim();
      javacBin = bundledJavac;
      javacVersion = out;
    } catch (err) {
      console.warn(`[build:jvm] Warning: Bundled javac failed check: ${err.message}`);
    }
  }

  if (!javacBin) {
    const sysJavac = process.env.JAVA_HOME
      ? join(process.env.JAVA_HOME, 'bin', isWin ? 'javac.exe' : 'javac')
      : isWin
        ? 'javac.exe'
        : 'javac';
    try {
      const out = execFileSync(sysJavac, ['--version'], { encoding: 'utf8' }).trim();
      javacBin = sysJavac;
      javacVersion = out;
    } catch {
      throw new Error(`Cannot locate functional javac 25 in bundled JBR or system environment.`);
    }
  }
  if (!/^javac 25(?:\.|$)/.test(javacVersion))
    throw new Error(`Expected javac 25, received ${javacVersion}`);

  // Some ILS distributions bundle javac without the jartool module.
  const bundledJava = join(ilsHome, 'jbr', 'bin', isWin ? 'java.exe' : 'java');
  let jarTool = null;
  let jarVersion = null;

  if (existsSync(bundledJava)) {
    try {
      const test = spawnSync(bundledJava, ['-m', 'jdk.jartool/sun.tools.jar.Main', '--version'], {
        encoding: 'utf8',
      });
      if (test.status === 0) {
        jarTool = {
          type: 'module',
          command: bundledJava,
          args: ['-m', 'jdk.jartool/sun.tools.jar.Main'],
        };
        jarVersion = test.stdout.trim();
      }
    } catch {}
  }

  if (!jarTool) {
    const candidateJarBins = [
      ...(process.env.JAVA_HOME
        ? [join(process.env.JAVA_HOME, 'bin', isWin ? 'jar.exe' : 'jar')]
        : []),
      isWin ? 'jar.exe' : 'jar',
    ];

    for (const candidate of candidateJarBins) {
      try {
        const out = execFileSync(candidate, ['--version'], { encoding: 'utf8' }).trim();
        if (/^(jar\s+)?25(\.|$)/.test(out)) {
          jarTool = { type: 'binary', command: candidate, args: [] };
          jarVersion = out;
          break;
        }
      } catch {}
    }
  }

  if (!jarTool) {
    throw new Error('Cannot locate JDK 25 jar tool. Set JAVA_HOME to a JDK 25 installation.');
  }

  return { javacBin, javacVersion, jarTool, jarVersion };
}

function collectJars(dir) {
  const jars = [];
  if (!existsSync(dir)) return jars;
  function recurse(current) {
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        recurse(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.jar')) {
        jars.push(fullPath);
      }
    }
  }
  recurse(dir);
  return jars.sort();
}

function collectFiles(dir, pattern) {
  const matches = [];
  if (!existsSync(dir)) return matches;
  function recurse(current) {
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        recurse(fullPath);
      } else if (entry.isFile() && pattern.test(entry.name)) {
        matches.push(fullPath);
      }
    }
  }
  recurse(dir);
  return matches.sort();
}

function copyDirectoryContents(sourceDir, targetDir, filter) {
  if (!existsSync(sourceDir)) return;
  const entries = readdirSync(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(sourceDir, entry.name);
    const dstPath = join(targetDir, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(dstPath, { recursive: true });
      copyDirectoryContents(srcPath, dstPath, filter);
    } else if (entry.isFile()) {
      if (!filter || filter(srcPath)) {
        mkdirSync(dirname(dstPath), { recursive: true });
        cpSync(srcPath, dstPath);
      }
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `[build:jvm] Starting exact-version deterministic build for ILS ${args.targetVersion}...`,
  );

  const ilsHome = resolveIlsHome(args.ilsHome);
  verifyIlsVersion(ilsHome, args.targetVersion);
  console.log(`[build:jvm] Verified ILS home: "${ilsHome}" (${args.targetVersion})`);

  const toolchain = locateToolchain(ilsHome);
  console.log(
    `[build:jvm] Toolchain selected:\n  javac: "${toolchain.javacBin}" (${toolchain.javacVersion})\n  jar:   "${toolchain.jarTool.command}" (${toolchain.jarVersion})`,
  );

  const libJars = collectJars(join(ilsHome, 'lib'));
  const pluginJars = collectJars(join(ilsHome, 'plugins'));
  const allClasspathJars = [...libJars, ...pluginJars];
  console.log(
    `[build:jvm] Classpath assembly: ${libJars.length} core jars + ${pluginJars.length} plugin jars = ${allClasspathJars.length} total jars`,
  );

  const srcDir = join(SCRIPT_DIR, 'src');
  const javaSources = collectFiles(srcDir, /\.java$/);
  if (javaSources.length === 0) {
    throw new Error(`[build:jvm] No Java source files found under "${srcDir}".`);
  }
  console.log(`[build:jvm] Found ${javaSources.length} Java source files to compile.`);

  let tempBuildDir = null;
  const cleanup = () => {
    if (tempBuildDir) {
      try {
        rmSync(tempBuildDir, { recursive: true, force: true });
      } catch {}
      tempBuildDir = null;
    }
  };
  process.on('exit', cleanup);

  const extensionDir = join(
    REPO_ROOT,
    'resources',
    'ils',
    args.targetVersion,
    'android-ls-extension',
  );
  const libDir = join(extensionDir, 'lib');
  const outputJarPath = join(libDir, 'android-ls-extension.jar');

  try {
    tempBuildDir = mkdtempSync(join(tmpdir(), 'omp-jvm-build-'));
    const classesDir = join(tempBuildDir, 'classes');
    mkdirSync(classesDir, { recursive: true });
    const separator = process.platform === 'win32' ? ';' : ':';
    const classpathString = allClasspathJars.join(separator);

    // Write argument files for javac to avoid Windows command line length limits
    const optionsFile = join(tempBuildDir, 'javac-options.txt');
    const sourcesFile = join(tempBuildDir, 'javac-sources.txt');

    const normalizedClasspath = classpathString.replace(/\\/g, '/');
    const normalizedClassesDir = classesDir.replace(/\\/g, '/');

    const optionsContent = [
      '--release',
      '25',
      '-encoding',
      'UTF-8',
      '-d',
      `"${normalizedClassesDir}"`,
      '-cp',
      `"${normalizedClasspath}"`,
    ].join('\n');

    writeFileSync(optionsFile, optionsContent, 'utf8');
    writeFileSync(
      sourcesFile,
      javaSources.map((s) => `"${s.replace(/\\/g, '/')}"`).join('\n'),
      'utf8',
    );

    console.log(`[build:jvm] Compiling Java classes with javac --release 25...`);
    try {
      execFileSync(toolchain.javacBin, [`@${optionsFile}`, `@${sourcesFile}`], {
        encoding: 'utf8',
        stdio: ['ignore', 'inherit', 'inherit'],
      });
    } catch (err) {
      throw new Error(`[build:jvm] Compilation failed: ${err.message}`);
    }

    const resourcesDir = join(SCRIPT_DIR, 'resources');
    if (existsSync(resourcesDir)) {
      copyDirectoryContents(resourcesDir, classesDir);
    }
    copyDirectoryContents(srcDir, classesDir, (file) => !file.endsWith('.java'));

    for (const resource of [
      'META-INF/plugin.xml',
      'META-INF/services/com.jetbrains.ls.api.features.LanguageServerExtension',
    ]) {
      if (!existsSync(join(classesDir, resource)))
        throw new Error(`Missing required resource: ${resource}`);
    }

    mkdirSync(libDir, { recursive: true });

    if (existsSync(libDir)) {
      for (const file of readdirSync(libDir)) {
        if (file.endsWith('.jar') && file !== 'android-ls-extension.jar') {
          throw new Error(`Unexpected JAR in extension lib/: ${file}`);
        }
      }
    }

    console.log(`[build:jvm] Packaging deterministic JAR to "${outputJarPath}"...`);

    const jarCommand = toolchain.jarTool.command;
    const jarArgs = [
      ...toolchain.jarTool.args,
      '--create',
      '--no-compress',
      '--file',
      join(tempBuildDir, 'android-ls-extension.jar'),
      `--date=${DETERMINISTIC_TIMESTAMP}`,
      '-C',
      classesDir,
      '.',
    ];

    try {
      execFileSync(jarCommand, jarArgs, {
        encoding: 'utf8',
        stdio: ['ignore', 'inherit', 'inherit'],
      });
    } catch (err) {
      throw new Error(`[build:jvm] JAR creation failed: ${err.message}`);
    }
    const stagedJar = `${outputJarPath}.${randomUUID()}.tmp`;
    try {
      cpSync(join(tempBuildDir, 'android-ls-extension.jar'), stagedJar);
      renameSync(stagedJar, outputJarPath);
    } finally {
      rmSync(stagedJar, { force: true });
    }
  } finally {
    cleanup();
  }

  const jarBuffer = readFileSync(outputJarPath);
  const jarSha256 = createHash('sha256').update(jarBuffer).digest('hex');
  const jarSize = jarBuffer.length;

  const manifestData = {
    serverVersion: args.targetVersion,
    extensionId: 'org.omp.intellij.android',
    buildTimestamp: DETERMINISTIC_TIMESTAMP,
    targetJavaVersion: 25,
    classFileVersion: 69,
    toolchain: {
      javacVersion: toolchain.javacVersion,
      jarVersion: toolchain.jarVersion,
    },
    assets: [
      {
        name: 'android-ls-extension.jar',
        path: 'lib/android-ls-extension.jar',
        sha256: jarSha256,
        size: jarSize,
      },
    ],
  };

  const manifestPath = join(extensionDir, 'manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifestData, null, 2)}\n`, 'utf8');

  const shaFilePath = join(libDir, 'android-ls-extension.jar.sha256');
  writeFileSync(shaFilePath, `${jarSha256} *android-ls-extension.jar\n`, 'utf8');

  console.log(`[build:jvm] Success! Generated A/B asset:`);
  console.log(`  JAR:    ${outputJarPath} (${jarSize} bytes)`);
  console.log(`  SHA256: ${jarSha256}`);
  console.log(`  Manifest: ${manifestPath}`);
}

main().catch((err) => {
  console.error(`[build:jvm] Error: ${err.message}`);
  process.exit(1);
});
