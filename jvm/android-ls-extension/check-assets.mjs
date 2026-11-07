#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..');
const TARGET_VERSION = '271.2085.0';
const EXPECTED_CLASS_MAJOR = 69; // Java 25

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
  const extensionDir = join(REPO_ROOT, 'resources', 'ils', version, 'android-ls-extension');
  if (!existsSync(extensionDir)) {
    throw new Error(`Extension directory not found at: "${extensionDir}"`);
  }

  const libDir = join(extensionDir, 'lib');
  if (!existsSync(libDir)) {
    throw new Error(`Extension lib directory not found at: "${libDir}"`);
  }

  // 1. Asset count check: A/B-only scope requires EXACTLY ONE JAR (android-ls-extension.jar)
  const jarFiles = readdirSync(libDir)
    .filter((f) => f.endsWith('.jar'))
    .sort();
  console.log(
    `[check:assets] Found ${jarFiles.length} JAR(s) in "${libDir}": ${jarFiles.join(', ')}`,
  );

  if (jarFiles.length !== 1) {
    throw new Error(
      `A/B-only asset count mismatch: expected exactly 1 JAR in lib/, but found ${jarFiles.length} (${jarFiles.join(', ')}). Do NOT bundle unrelated Lint or auxiliary JARs.`,
    );
  }

  const targetJarName = jarFiles[0];
  if (targetJarName !== 'android-ls-extension.jar') {
    throw new Error(
      `Unexpected asset JAR name: "${targetJarName}", expected "android-ls-extension.jar"`,
    );
  }

  const jarPath = join(libDir, targetJarName);
  const jarBuffer = readFileSync(jarPath);
  const actualSha256 = createHash('sha256').update(jarBuffer).digest('hex');

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
  if (!Array.isArray(manifest.assets) || manifest.assets.length !== 1) {
    throw new Error(
      `Manifest assets count mismatch: expected 1 asset for A/B, found ${manifest.assets?.length}`,
    );
  }

  const assetRecord = manifest.assets[0];
  if (assetRecord.name !== 'android-ls-extension.jar') {
    throw new Error(
      `Manifest asset name mismatch: expected "android-ls-extension.jar", got "${assetRecord.name}"`,
    );
  }

  if (assetRecord.path !== 'lib/android-ls-extension.jar') {
    throw new Error(
      `Manifest asset path mismatch: expected "lib/android-ls-extension.jar", got "${assetRecord.path}"`,
    );
  }
  if (assetRecord.sha256 !== actualSha256) {
    throw new Error(
      `SHA-256 integrity failure for "${targetJarName}":\n  Manifest: ${assetRecord.sha256}\n  Actual:   ${actualSha256}`,
    );
  }

  if (typeof assetRecord.size !== 'number' || assetRecord.size !== jarBuffer.length) {
    throw new Error(
      `Asset size mismatch for "${targetJarName}": manifest specifies ${assetRecord.size}, actual is ${jarBuffer.length}`,
    );
  }

  console.log(`[check:assets] SHA-256 verified: ${actualSha256}`);
  console.log(`[check:assets] Size verified: ${jarBuffer.length} bytes`);

  // Companion .sha256 file REQUIRED
  const shaFilePath = join(libDir, 'android-ls-extension.jar.sha256');
  if (!existsSync(shaFilePath)) {
    throw new Error(`Missing required companion SHA file: "${shaFilePath}"`);
  }
  const shaContent = readFileSync(shaFilePath, 'utf8').trim();
  const shaMatch = /^([a-f0-9]{64})(?:\s+\*?android-ls-extension\.jar)?$/i.exec(shaContent);
  if (!shaMatch || shaMatch[1].toLowerCase() !== actualSha256.toLowerCase()) {
    throw new Error(
      `Companion .sha256 file content mismatch: expected ${actualSha256}, got "${shaContent}"`,
    );
  }
  console.log(`[check:assets] Companion SHA-256 verified`);

  // 3. ABI verification: inspect zip structure, plugin.xml and classfile version
  console.log(`[check:assets] Verifying ABI and classfile version for "${targetJarName}"...`);
  const entries = parseZipEntries(jarBuffer);
  if (entries.length === 0) {
    throw new Error(`JAR "${targetJarName}" is empty or not a valid zip archive.`);
  }

  const pluginXmlEntry = entries.find((e) => e.name === 'META-INF/plugin.xml');
  if (!pluginXmlEntry) {
    throw new Error(`Missing required descriptor "META-INF/plugin.xml" inside "${targetJarName}"`);
  }

  const pluginXmlContent = extractEntryData(jarBuffer, pluginXmlEntry).toString('utf8');
  if (!pluginXmlContent.includes('<idea-plugin>')) {
    throw new Error(
      `"META-INF/plugin.xml" inside "${targetJarName}" does not contain <idea-plugin> root`,
    );
  }
  if (!pluginXmlContent.includes('<id>org.omp.intellij.android</id>')) {
    throw new Error(
      `"META-INF/plugin.xml" inside "${targetJarName}" does not contain expected plugin id "org.omp.intellij.android"`,
    );
  }
  if (!pluginXmlContent.includes('org.omp.intellij.android.AndroidResourceNavigation')) {
    throw new Error(
      `"META-INF/plugin.xml" inside "${targetJarName}" does not declare entry point "org.omp.intellij.android.AndroidResourceNavigation"`,
    );
  }
  if (!pluginXmlContent.includes('org.omp.intellij.android.ComposeSuppressor')) {
    throw new Error(
      `"META-INF/plugin.xml" inside "${targetJarName}" does not declare entry point "org.omp.intellij.android.ComposeSuppressor"`,
    );
  }

  // SPI verification
  const spiEntry = entries.find(
    (e) => e.name === 'META-INF/services/com.jetbrains.ls.api.features.LanguageServerExtension',
  );
  if (!spiEntry) {
    throw new Error(
      `Missing required SPI descriptor "META-INF/services/com.jetbrains.ls.api.features.LanguageServerExtension" inside "${targetJarName}"`,
    );
  }
  const spiContent = extractEntryData(jarBuffer, spiEntry).toString('utf8');
  const spiClasses = spiContent
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
  if (!spiClasses.includes('org.omp.intellij.android.AndroidExtension')) {
    throw new Error(
      `SPI descriptor inside "${targetJarName}" does not declare implementation "org.omp.intellij.android.AndroidExtension"`,
    );
  }

  // Entry classes existence
  const requiredEntryClasses = [
    'org/omp/intellij/android/AndroidExtension.class',
    'org/omp/intellij/android/AndroidResourceNavigation.class',
    'org/omp/intellij/android/ComposeSuppressor.class',
  ];
  for (const entryClass of requiredEntryClasses) {
    if (!entries.some((e) => e.name === entryClass)) {
      throw new Error(`Missing required entry class "${entryClass}" inside "${targetJarName}"`);
    }
  }

  // Find all .class entries and verify major version = 69 (Java 25)
  const classEntries = entries.filter((e) => e.name.endsWith('.class'));
  if (classEntries.length === 0) {
    throw new Error(
      `No .class files found inside "${targetJarName}". Compilation produced zero classes.`,
    );
  }

  for (const classEntry of classEntries) {
    const classBytes = extractEntryData(jarBuffer, classEntry);
    if (classBytes.length < 8) {
      throw new Error(`Truncated class file: "${classEntry.name}" in "${targetJarName}"`);
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
  console.log(
    `[check:assets] OK: 1 asset verified for ILS ${version} (SHA-256: ${actualSha256}, size: ${jarBuffer.length}, ABI: Java 25 / classfile 69).`,
  );
}

try {
  verifyAssets(TARGET_VERSION);
} catch (err) {
  console.error(`[check:assets] FAILED: ${err.message}`);
  process.exit(1);
}
