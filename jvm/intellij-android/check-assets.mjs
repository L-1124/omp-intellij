#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..');
const TARGET_VERSION = '271.2085.0';
const EXPECTED_CLASS_MAJOR = 69; // Java 25

const EXPECTED_ASSETS = ['intellij-android.jar', 'adblib-9.4.1.jar', 'adblib-tools-9.4.1.jar'];

const LOCKED_UPSTREAM_SHAS = {
  'adblib-9.4.1.jar': 'ee4362dba99b5c64f72cc69073f66913e17318289204e861971a0b901a9a1ef9',
  'adblib-tools-9.4.1.jar': '2ff23e54a6989a2417aee3da1b1ff6d58ed7b6abce38bfdde6ba567fe14b918c',
};

function parseZipEntries(buffer) {
  let offset = 0;
  const entries = [];
  while (offset + 30 <= buffer.length) {
    const sig = buffer.readUInt32LE(offset);
    if (sig !== 0x04034b50) break; // End of local headers
    const method = buffer.readUInt16LE(offset + 8);
    const compSize = buffer.readUInt32LE(offset + 18);
    const uncompSize = buffer.readUInt32LE(offset + 22);
    const nameLen = buffer.readUInt16LE(offset + 26);
    const extraLen = buffer.readUInt16LE(offset + 28);
    const name = buffer.toString('utf8', offset + 30, offset + 30 + nameLen);
    const dataOffset = offset + 30 + nameLen + extraLen;
    entries.push({ name, method, compSize, uncompSize, dataOffset });
    offset = dataOffset + compSize;
  }
  return entries;
}

function extractEntryData(buffer, entry) {
  if (entry.method !== 0) {
    throw new Error(
      `Unsupported zip compression method ${entry.method} for "${entry.name}". Native ZIP inspect approach requires stored ZIP (method 0).`,
    );
  }
  return buffer.subarray(entry.dataOffset, entry.dataOffset + entry.compSize);
}

function verifyAssets(version = TARGET_VERSION) {
  console.log(`[check:assets] Verifying assets for ILS ${version}...`);

  if (version !== TARGET_VERSION) {
    throw new Error(`Only ILS ${TARGET_VERSION} is supported, got: ${version}`);
  }
  const extensionDir = join(REPO_ROOT, 'resources', 'ils', version, 'intellij-android');
  if (!existsSync(extensionDir)) {
    throw new Error(`Extension directory not found at: "${extensionDir}"`);
  }

  const libDir = join(extensionDir, 'lib');
  if (!existsSync(libDir)) {
    throw new Error(`Extension lib directory not found at: "${libDir}"`);
  }

  // 1. Check exact set of files in lib/
  const expectedFiles = new Set(EXPECTED_ASSETS.flatMap((name) => [name, `${name}.sha256`]));
  const actualFiles = readdirSync(libDir).sort();
  console.log(
    `[check:assets] Found ${actualFiles.length} file(s) in "${libDir}": ${actualFiles.join(', ')}`,
  );

  if (actualFiles.length !== expectedFiles.size || actualFiles.some((f) => !expectedFiles.has(f))) {
    throw new Error(
      `Library files mismatch in "${libDir}": expected exact set [${[...expectedFiles].join(', ')}], found [${actualFiles.join(', ')}]`,
    );
  }

  // 2. Manifest and SHA verification
  const manifestPath = join(extensionDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`Asset manifest not found at: "${manifestPath}"`);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.serverVersion !== version) {
    throw new Error(
      `Manifest version mismatch: manifest specifies "${manifest.serverVersion}", expected "${version}"`,
    );
  }

  if (manifest.classFileVersion !== EXPECTED_CLASS_MAJOR) {
    throw new Error(
      `Manifest classFileVersion mismatch: expected ${EXPECTED_CLASS_MAJOR}, got ${manifest.classFileVersion}`,
    );
  }

  if (manifest.targetJavaVersion !== 25) {
    throw new Error(
      `Manifest targetJavaVersion mismatch: expected 25, got ${manifest.targetJavaVersion}`,
    );
  }

  if (!Array.isArray(manifest.assets) || manifest.assets.length !== EXPECTED_ASSETS.length) {
    throw new Error(
      `Manifest assets count mismatch: expected ${EXPECTED_ASSETS.length} assets, found ${manifest.assets?.length}`,
    );
  }

  const remainingAssets = new Set(EXPECTED_ASSETS);

  for (const asset of manifest.assets) {
    if (
      !asset ||
      typeof asset !== 'object' ||
      typeof asset.name !== 'string' ||
      !remainingAssets.delete(asset.name) ||
      asset.path !== `lib/${asset.name}` ||
      typeof asset.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(asset.sha256) ||
      typeof asset.size !== 'number' ||
      asset.size <= 0
    ) {
      throw new Error(`Invalid manifest asset record: ${JSON.stringify(asset)}`);
    }

    const resolvedJarPath = resolve(extensionDir, asset.path);
    const rel = relative(extensionDir, resolvedJarPath);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`Asset path escapes extension directory: "${asset.path}"`);
    }

    const jarBuffer = readFileSync(resolvedJarPath);
    const actualSha256 = createHash('sha256').update(jarBuffer).digest('hex');

    if (
      asset.size !== jarBuffer.length ||
      actualSha256.toLowerCase() !== asset.sha256.toLowerCase()
    ) {
      throw new Error(
        `SHA-256 or size mismatch for asset "${asset.name}":\n  Manifest: ${asset.sha256} (${asset.size} bytes)\n  Actual:   ${actualSha256} (${jarBuffer.length} bytes)`,
      );
    }

    // Companion .sha256 file verification
    const shaFilePath = join(libDir, `${asset.name}.sha256`);
    if (!existsSync(shaFilePath)) {
      throw new Error(`Missing required companion SHA file: "${shaFilePath}"`);
    }
    const shaContent = readFileSync(shaFilePath, 'utf8').trim();
    const shaMatch = /^([a-f0-9]{64})(?:\s+\*?([^\s]+))?$/i.exec(shaContent);
    if (
      !shaMatch ||
      shaMatch[1].toLowerCase() !== actualSha256.toLowerCase() ||
      (shaMatch[2] && shaMatch[2] !== asset.name)
    ) {
      throw new Error(
        `Companion .sha256 file mismatch for "${asset.name}": expected ${actualSha256} *${asset.name}, got "${shaContent}"`,
      );
    }

    // Upstream locked SHA check
    if (LOCKED_UPSTREAM_SHAS[asset.name]) {
      const lockedSha = LOCKED_UPSTREAM_SHAS[asset.name].toLowerCase();
      if (actualSha256.toLowerCase() !== lockedSha) {
        throw new Error(
          `Upstream locked SHA-256 mismatch for "${asset.name}": expected ${lockedSha}, got ${actualSha256}`,
        );
      }
    }
  }

  if (remainingAssets.size !== 0) {
    throw new Error(`Missing asset records in manifest: [${[...remainingAssets].join(', ')}]`);
  }

  // 3. ABI verification for intellij-android.jar
  console.log(`[check:assets] Verifying ABI and classfile version for "intellij-android.jar"...`);
  const extensionJarBuffer = readFileSync(join(libDir, 'intellij-android.jar'));
  const entries = parseZipEntries(extensionJarBuffer);
  if (entries.length === 0) {
    throw new Error(`JAR "intellij-android.jar" is empty or not a valid zip archive.`);
  }

  const pluginXmlEntry = entries.find((e) => e.name === 'META-INF/plugin.xml');
  if (!pluginXmlEntry) {
    throw new Error(
      `Missing required descriptor "META-INF/plugin.xml" inside "intellij-android.jar"`,
    );
  }

  const pluginXmlContent = extractEntryData(extensionJarBuffer, pluginXmlEntry).toString('utf8');
  if (!pluginXmlContent.includes('<idea-plugin>')) {
    throw new Error(`"META-INF/plugin.xml" does not contain <idea-plugin> root`);
  }
  if (!pluginXmlContent.includes('<id>org.jetbrains.android</id>')) {
    throw new Error(
      `"META-INF/plugin.xml" does not contain expected plugin id "org.jetbrains.android"`,
    );
  }
  if (!pluginXmlContent.includes('org.jetbrains.android.navigation.AndroidResourceNavigation')) {
    throw new Error(
      `"META-INF/plugin.xml" does not declare entry point "org.jetbrains.android.navigation.AndroidResourceNavigation"`,
    );
  }
  if (!pluginXmlContent.includes('org.jetbrains.android.compose.ComposeSuppressor')) {
    throw new Error(
      `"META-INF/plugin.xml" does not declare entry point "org.jetbrains.android.compose.ComposeSuppressor"`,
    );
  }
  const spiEntry = entries.find(
    (e) => e.name === 'META-INF/services/com.jetbrains.ls.api.features.LanguageServerExtension',
  );
  if (!spiEntry) {
    throw new Error(
      `Missing required SPI descriptor "META-INF/services/com.jetbrains.ls.api.features.LanguageServerExtension" inside "intellij-android.jar"`,
    );
  }
  const spiContent = extractEntryData(extensionJarBuffer, spiEntry).toString('utf8');
  const spiClasses = spiContent
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
  if (!spiClasses.includes('org.jetbrains.android.AndroidExtension')) {
    throw new Error(
      `SPI descriptor does not declare implementation "org.jetbrains.android.AndroidExtension"`,
    );
  }

  const requiredEntryClasses = [
    'org/jetbrains/android/AndroidExtension.class',
    'org/jetbrains/android/navigation/AndroidResourceNavigation.class',
    'org/jetbrains/android/compose/ComposeSuppressor.class',
  ];
  for (const entryClass of requiredEntryClasses) {
    if (!entries.some((e) => e.name === entryClass)) {
      throw new Error(`Missing required entry class "${entryClass}" inside "intellij-android.jar"`);
    }
  }

  const classEntries = entries.filter((e) => e.name.endsWith('.class'));
  if (classEntries.length === 0) {
    throw new Error(
      `No .class files found inside "intellij-android.jar". Compilation produced zero classes.`,
    );
  }

  for (const classEntry of classEntries) {
    const classBytes = extractEntryData(extensionJarBuffer, classEntry);
    if (classBytes.length < 8) {
      throw new Error(`Truncated class file: "${classEntry.name}" in "intellij-android.jar"`);
    }
    const magic = classBytes.readUInt32BE(0);
    if (magic !== 0xcafebabe) {
      throw new Error(
        `Invalid class magic for "${classEntry.name}": 0x${magic.toString(16)}, expected 0xcafebabe`,
      );
    }
    const majorVersion = classBytes.readUInt16BE(6);
    if (majorVersion !== EXPECTED_CLASS_MAJOR) {
      throw new Error(
        `ABI mismatch in "${classEntry.name}": compiled classfile major version is ${majorVersion}, expected ${EXPECTED_CLASS_MAJOR} (Java 25)`,
      );
    }
  }

  console.log(
    `[check:assets] ABI verified: ${classEntries.length} class(es) inspected with major version ${EXPECTED_CLASS_MAJOR} (Java 25), valid plugin.xml, SPI, and entry classes.`,
  );
  console.log(`[check:assets] OK: ${EXPECTED_ASSETS.length} assets verified for ILS ${version}.`);
}

try {
  verifyAssets(TARGET_VERSION);
} catch (err) {
  console.error(`[check:assets] FAILED: ${err.message}`);
  process.exit(1);
}
