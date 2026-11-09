import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { executeIntellij } from '../../src/extension/intellij-tool.js';
import type { ExtensionContext } from '../../src/shared/extension-types.js';
import { encode } from '../../src/shared/protocol.js';
import {
  copyCachedWrapper,
  createIntegrationSandbox,
  createLspClientDriver,
  type IntegrationSandbox,
  type LspClientDriver,
  verifyPrerequisites,
} from './fixture.js';

interface LspPosition {
  line: number;
  character: number;
}

interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

interface LspLocation {
  uri: string;
  range: LspRange;
}

interface LspDocumentSymbol {
  name: string;
  kind: number;
  range: LspRange;
  selectionRange: LspRange;
  children?: LspDocumentSymbol[];
}

interface LspSymbolInformation {
  name: string;
  kind: number;
  location: LspLocation;
  containerName?: string;
}

const SymbolKind = {
  Module: 2,
  Namespace: 3,
  Class: 5,
  Property: 7,
  Interface: 11,
  Variable: 13,
  Constant: 14,
  String: 15,
  Number: 16,
  Boolean: 17,
  Array: 18,
} as const;

function hasPrerequisitesEnvironment(): boolean {
  return Boolean(
    process.env.OMP_INTELLIJ_TEST_SERVER &&
      process.env.OMP_INTELLIJ_TEST_JDK17 &&
      process.env.OMP_INTELLIJ_TEST_JDK21 &&
      process.env.OMP_INTELLIJ_TEST_ACCEPTED_EULA_HASH,
  );
}

function findPositionInText(text: string, target: string, occurrence = 1): LspPosition {
  let index = -1;
  let currentOccur = 0;
  while (currentOccur < occurrence) {
    index = text.indexOf(target, index + 1);
    if (index === -1) {
      throw new Error(`Target "${target}" (occurrence ${occurrence}) not found in text`);
    }
    currentOccur++;
  }
  const lines = text.slice(0, index).split(/\r?\n/);
  return { line: lines.length - 1, character: lines[lines.length - 1].length };
}

function findRangeInText(text: string, target: string, occurrence = 1): LspRange {
  const start = findPositionInText(text, target, occurrence);
  const targetLines = target.split(/\r?\n/);
  const endLine = start.line + targetLines.length - 1;
  const endChar =
    targetLines.length === 1
      ? start.character + targetLines[0].length
      : targetLines[targetLines.length - 1].length;
  return { start, end: { line: endLine, character: endChar } };
}

function findFieldRangeInText(text: string, expression: string, occurrence = 1): LspRange {
  const range = findRangeInText(text, expression, occurrence);
  return {
    start: {
      line: range.start.line,
      character: range.start.character + expression.lastIndexOf('.') + 1,
    },
    end: range.end,
  };
}

function normalizeUri(uri: string): string {
  if (!uri.startsWith('file:')) return uri;
  const file = fileURLToPath(uri);
  return process.platform === 'win32' ? file.toLowerCase() : file;
}

function locationToKey(loc: LspLocation): string {
  const uri = normalizeUri(loc.uri);
  return `${uri}#${loc.range.start.line}:${loc.range.start.character}-${loc.range.end.line}:${loc.range.end.character}`;
}

function locationsEqual(l1: LspLocation, l2: LspLocation): boolean {
  return (
    normalizeUri(l1.uri) === normalizeUri(l2.uri) &&
    l1.range.start.line === l2.range.start.line &&
    l1.range.start.character === l2.range.start.character &&
    l1.range.end.line === l2.range.end.line &&
    l1.range.end.character === l2.range.end.character
  );
}

function normalizeLocations(raw: unknown): LspLocation[] {
  if (!raw) return [];
  return Array.isArray(raw) ? (raw as LspLocation[]) : [raw as LspLocation];
}

async function copyAndroidFixture(sandbox: IntegrationSandbox): Promise<string> {
  const sourceDir = resolve('test-fixtures', 'android-xml');
  const targetDir = join(sandbox.workspacesDir, 'android-xml');
  await cp(sourceDir, targetDir, { recursive: true });

  const androidSdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!androidSdk || !existsSync(androidSdk)) {
    throw new Error('ANDROID_HOME or ANDROID_SDK_ROOT must be set to a valid directory');
  }

  await writeFile(
    join(targetDir, 'local.properties'),
    `sdk.dir=${androidSdk.replace(/\\/g, '/')}\n`,
    'utf8',
  );

  const jdk21Normalized = sandbox.prerequisites.jdk21Path.replace(/\\/g, '/');
  const gradleProps = [
    'org.gradle.java.installations.auto-download=false',
    'org.gradle.java.installations.auto-detect=false',
    `org.gradle.java.installations.paths=${jdk21Normalized}`,
    `org.gradle.java.home=${jdk21Normalized}`,
    'org.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8',
    'android.useAndroidX=false',
    'android.nonTransitiveRClass=true',
    '',
  ].join('\n');
  await writeFile(join(targetDir, 'gradle.properties'), gradleProps, 'utf8');

  const cache = process.env.OMP_INTELLIJ_TEST_GRADLE_CACHE;
  if (cache) {
    await cp(
      join(cache, 'caches', 'modules-2'),
      join(sandbox.gradleUserHome, 'caches', 'modules-2'),
      {
        recursive: true,
        filter: (source) => !source.endsWith('.lock') && basename(source) !== 'gc.properties',
      },
    );
  }

  await copyCachedWrapper(sandbox);

  const wrapperJarSrc = resolve(
    'test-fixtures',
    'gradle-execution',
    'gradle',
    'wrapper',
    'gradle-wrapper.jar',
  );
  const targetWrapperDir = join(targetDir, 'gradle', 'wrapper');
  await cp(wrapperJarSrc, join(targetWrapperDir, 'gradle-wrapper.jar'));

  const javaExe = join(
    sandbox.prerequisites.jdk21Path,
    'bin',
    process.platform === 'win32' ? 'java.exe' : 'java',
  );
  const libraryInputs = join(sandbox.sandboxDir, 'binary-library');
  const classes = join(libraryInputs, 'classes');
  const libraryJar = join(targetDir, 'app', 'libs', 'no-sources.jar');
  await mkdir(classes, { recursive: true });
  await mkdir(join(targetDir, 'app', 'libs'), { recursive: true });
  const librarySource = join(libraryInputs, 'NoSourcesActivity.java');
  await writeFile(
    librarySource,
    'package com.example.nosource; public final class NoSourcesActivity {}',
  );
  for (const [name, args] of [
    ['javac', ['--release', '21', '-d', classes, librarySource]],
    ['jar', ['--create', '--file', libraryJar, '-C', classes, '.']],
  ] as const) {
    const binary = join(
      sandbox.prerequisites.jdk21Path,
      'bin',
      process.platform === 'win32' ? `${name}.exe` : name,
    );
    const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 30000 });
    assert.equal(
      result.status,
      0,
      `${name}: ${result.error ?? ''}\n${result.stdout}\n${result.stderr}`,
    );
  }
  const composeInputs = join(sandbox.sandboxDir, 'compose-library');
  const composeClasses = join(composeInputs, 'classes');
  const composeJar = join(targetDir, 'app', 'libs', 'compose-runtime.jar');
  await mkdir(composeClasses, { recursive: true });
  const composeSource = join(composeInputs, 'Composable.java');
  await writeFile(
    composeSource,
    'package androidx.compose.runtime; import java.lang.annotation.*; @Retention(RetentionPolicy.CLASS) public @interface Composable {}',
  );
  for (const [name, args] of [
    ['javac', ['--release', '21', '-d', composeClasses, composeSource]],
    ['jar', ['--create', '--file', composeJar, '-C', composeClasses, '.']],
  ] as const) {
    const binary = join(
      sandbox.prerequisites.jdk21Path,
      'bin',
      process.platform === 'win32' ? `${name}.exe` : name,
    );
    const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 30000 });
    assert.equal(
      result.status,
      0,
      `${name}: ${result.error ?? ''}\n${result.stdout}\n${result.stderr}`,
    );
  }

  const wrapperJar = join(targetWrapperDir, 'gradle-wrapper.jar');
  const buildResult = spawnSync(
    javaExe,
    [
      '-cp',
      wrapperJar,
      'org.gradle.wrapper.GradleWrapperMain',
      ':app:processDebugResources',
      ':lib:packageDebugResources',
      ':lib:generateDebugRFile',
      ':core:packageDebugResources',
      ':core:generateDebugRFile',
      ':independent:packageDebugResources',
      ':independent:generateDebugRFile',
      ':independent:generateReleaseRFile',
      '--offline',
      '--no-daemon',
    ],
    {
      cwd: targetDir,
      env: sandbox.env,
      encoding: 'utf8',
      timeout: 180000,
    },
  );
  if (buildResult.status !== 0) {
    throw new Error(
      `processDebugResources failed with status ${buildResult.status}:\nSTDOUT:\n${buildResult.stdout}\nSTDERR:\n${buildResult.stderr}`,
    );
  }

  return targetDir;
}

async function startLspClient(
  projectDir: string,
  sandbox: IntegrationSandbox,
  options?: { hierarchicalDocumentSymbolSupport?: boolean },
): Promise<LspClientDriver> {
  const driver = createLspClientDriver(projectDir, sandbox);
  const hierarchical = options?.hierarchicalDocumentSymbolSupport ?? true;
  await driver.request('initialize', {
    processId: process.pid,
    rootUri: pathToFileURL(projectDir).href,
    rootPath: projectDir,
    initializationOptions: { indexDir: join(sandbox.sandboxDir, 'index') },
    capabilities: {
      textDocument: {
        documentSymbol: { hierarchicalDocumentSymbolSupport: hierarchical },
        references: { dynamicRegistration: false },
        definition: { dynamicRegistration: false },
        synchronization: { dynamicRegistration: false },
        diagnostic: { dynamicRegistration: false },
      },
      window: { workDoneProgress: true },
      experimental: { licensingUi: true },
    },
  });
  driver.notify('initialized', {});
  return driver;
}

test('Android XML symbols and manifest references integration', {
  skip: !hasPrerequisitesEnvironment(),
}, async (t) => {
  const prereqs = await verifyPrerequisites();
  const sandbox = await createIntegrationSandbox(prereqs);
  sandbox.env.OMP_ANDROID_LS_EXTENSION_DIR = resolve('resources/ils/271.2085.0/intellij-android');
  let projectDir = '';
  let driver: LspClientDriver | null = null;
  let flatDriver: LspClientDriver | null = null;

  try {
    projectDir = await copyAndroidFixture(sandbox);
    const client = await startLspClient(projectDir, sandbox);
    driver = client;

    await executeIntellij(
      { action: 'wait', project: projectDir, timeout: 180 },
      undefined,
      undefined,
      { cwd: projectDir } as ExtensionContext,
      { systemPath: sandbox.systemPath },
    );

    const modelDir = join(sandbox.sandboxDir, 'resource-workspace-model');
    await mkdir(modelDir);
    await client.request('workspace/executeCommand', {
      command: 'exportWorkspace',
      arguments: [modelDir],
    });
    const workspaceModel = JSON.parse(await readFile(join(modelDir, 'workspace.json'), 'utf8')) as {
      modules: Array<{
        name: string;
        contentRoots?: Array<{ sourceRoots?: Array<{ path: string }> }>;
      }>;
    };
    const moduleForMainSources = (component: string): string => {
      const modules = workspaceModel.modules.filter((module) =>
        module.contentRoots?.some((root) =>
          root.sourceRoots?.some((source) =>
            source.path.replaceAll('\\', '/').endsWith(`/${component}/src/main/java`),
          ),
        ),
      );
      assert.equal(modules.length, 1, `Unique imported main source module required: ${component}`);
      return modules[0].name;
    };
    const appModuleName = moduleForMainSources('app');
    const independentModuleName = moduleForMainSources('independent');

    const appDir = join(projectDir, 'app', 'src', 'main');
    const stringsPath = join(appDir, 'res', 'values', 'strings.xml');
    const stringsText = await readFile(stringsPath, 'utf8');
    const stringsUri = pathToFileURL(stringsPath).href;

    const manifestPath = join(projectDir, 'app', 'config', 'manifest-main.xml');
    const manifestText = await readFile(manifestPath, 'utf8');
    const manifestUri = pathToFileURL(manifestPath).href;
    let manifestVersion = 1;
    const changeManifest = (text: string) =>
      client.notify('textDocument/didChange', {
        textDocument: { uri: manifestUri, version: ++manifestVersion },
        contentChanges: [{ text }],
      });

    const mainActivityPath = join(appDir, 'java', 'com', 'example', 'app', 'MainActivity.kt');
    const mainActivityText = await readFile(mainActivityPath, 'utf8');
    const mainActivityUri = pathToFileURL(mainActivityPath).href;

    const targetActivityPath = join(appDir, 'java', 'com', 'example', 'app', 'TargetActivity.kt');
    const targetActivityText = await readFile(targetActivityPath, 'utf8');
    const targetActivityUri = pathToFileURL(targetActivityPath).href;

    const zeroUsePath = join(appDir, 'java', 'com', 'example', 'app', 'ZeroUseActivity.kt');
    const zeroUseText = await readFile(zeroUsePath, 'utf8');
    const zeroUseUri = pathToFileURL(zeroUsePath).href;

    client.notify('textDocument/didOpen', {
      textDocument: { uri: stringsUri, languageId: 'xml', version: 1, text: stringsText },
    });
    client.notify('textDocument/didOpen', {
      textDocument: { uri: manifestUri, languageId: 'xml', version: 1, text: manifestText },
    });
    client.notify('textDocument/didOpen', {
      textDocument: {
        uri: mainActivityUri,
        languageId: 'kotlin',
        version: 1,
        text: mainActivityText,
      },
    });
    client.notify('textDocument/didOpen', {
      textDocument: {
        uri: targetActivityUri,
        languageId: 'kotlin',
        version: 1,
        text: targetActivityText,
      },
    });
    client.notify('textDocument/didOpen', {
      textDocument: { uri: zeroUseUri, languageId: 'kotlin', version: 1, text: zeroUseText },
    });

    await t.test(
      'DocumentSymbol: hierarchy, raw entities, value kinds, and anonymous containers',
      async () => {
        const symbols = (await client.request('textDocument/documentSymbol', {
          textDocument: { uri: stringsUri },
        })) as LspDocumentSymbol[];

        const numSym = symbols.find((s) => s.name === 'entity_1');
        assert.ok(numSym, 'Decoded symbol name "entity_1" must be found for entity_&#x0031;');
        assert.equal(numSym.kind, SymbolKind.String);

        const stringsLines = stringsText.split(/\r?\n/);
        const rawEntitySlice = stringsLines[numSym.selectionRange.start.line].slice(
          numSym.selectionRange.start.character,
          numSym.selectionRange.end.character,
        );
        assert.equal(
          rawEntitySlice,
          'entity_&#x0031;',
          'selectionRange must span raw un-decoded entity',
        );

        const customPath = join(projectDir, 'app', 'custom-res', 'values', 'custom.xml');
        const customUri = pathToFileURL(customPath).href;
        const customText = await readFile(customPath, 'utf8');
        client.notify('textDocument/didOpen', {
          textDocument: { uri: customUri, languageId: 'xml', version: 1, text: customText },
        });
        const customSymbols = (await client.request('textDocument/documentSymbol', {
          textDocument: { uri: customUri },
        })) as LspDocumentSymbol[];
        assert.deepEqual(
          customSymbols.map(({ name, kind }) => [name, kind]),
          [['custom_root_string', 15]],
        );
        assert.deepEqual(
          customSymbols[0].selectionRange,
          findRangeInText(customText, 'custom_root_string'),
        );

        const stylesPath = join(appDir, 'res', 'values', 'styles.xml');
        const stylesUri = pathToFileURL(stylesPath).href;
        client.notify('textDocument/didOpen', {
          textDocument: {
            uri: stylesUri,
            languageId: 'xml',
            version: 1,
            text: await readFile(stylesPath, 'utf8'),
          },
        });
        const styleSymbols = (await client.request('textDocument/documentSymbol', {
          textDocument: { uri: stylesUri },
        })) as LspDocumentSymbol[];
        const appTheme = styleSymbols.find((s) => s.name === 'AppTheme');
        assert.ok(appTheme && appTheme.kind === SymbolKind.Class);
        assert.ok(
          appTheme.children?.some(
            (c) => c.name === 'colorPrimary' && c.kind === SymbolKind.Property,
          ),
        );

        const attrsPath = join(appDir, 'res', 'values', 'attrs.xml');
        const attrsUri = pathToFileURL(attrsPath).href;
        client.notify('textDocument/didOpen', {
          textDocument: {
            uri: attrsUri,
            languageId: 'xml',
            version: 1,
            text: await readFile(attrsPath, 'utf8'),
          },
        });
        const attrSymbols = (await client.request('textDocument/documentSymbol', {
          textDocument: { uri: attrsUri },
        })) as LspDocumentSymbol[];
        const customComp = attrSymbols.find((s) => s.name === 'CustomComponent');
        assert.ok(customComp && customComp.kind === SymbolKind.Interface);
        assert.ok(
          customComp.children?.some(
            (c) => c.name === 'customAttribute' && c.kind === SymbolKind.Property,
          ),
        );
        assert.ok(
          attrSymbols.some((s) => s.name === 'globalAttr' && s.kind === SymbolKind.Property),
        );
        assert.ok(
          attrSymbols.some((s) => s.name === 'custom_view_id' && s.kind === SymbolKind.Variable),
        );
        assert.ok(
          attrSymbols.some((s) => s.name === 'feature_enabled' && s.kind === SymbolKind.Boolean),
        );
        assert.ok(
          attrSymbols.some((s) => s.name === 'max_retry_count' && s.kind === SymbolKind.Number),
        );
        assert.ok(attrSymbols.some((s) => s.name === 'planets' && s.kind === SymbolKind.Array));
        assert.ok(attrSymbols.some((s) => s.name === 'items_count' && s.kind === SymbolKind.Array));

        const manifestSymbols = (await client.request('textDocument/documentSymbol', {
          textDocument: { uri: manifestUri },
        })) as LspDocumentSymbol[];
        const manifestRoot = manifestSymbols.find(
          (s) => s.kind === SymbolKind.Namespace || s.name === 'manifest',
        );
        assert.ok(manifestRoot, 'Root manifest container must be present');

        const findSymbol = (
          nodes: LspDocumentSymbol[],
          name: string,
        ): LspDocumentSymbol | undefined => {
          for (const n of nodes) {
            if (n.name === name || n.name === `.${name}`) return n;
            if (n.children) {
              const found = findSymbol(n.children, name);
              if (found) return found;
            }
          }
          return undefined;
        };
        assert.equal(findSymbol(manifestSymbols, 'MainActivity')?.kind, SymbolKind.Class);
        assert.equal(findSymbol(manifestSymbols, 'AliasActivity')?.kind, SymbolKind.Interface);
        assert.equal(findSymbol(manifestSymbols, 'CustomPrefixActivity')?.kind, SymbolKind.Class);
        const anonymous = '<manifest><application/></manifest>';
        try {
          changeManifest(anonymous);
          const containers = (await client.request('textDocument/documentSymbol', {
            textDocument: { uri: manifestUri },
          })) as LspDocumentSymbol[];
          assert.deepEqual([containers[0].name, containers[0].kind], ['manifest', 3]);
          assert.deepEqual(containers[0].selectionRange, findRangeInText(anonymous, 'manifest'));
          assert.deepEqual(
            [containers[0].children?.[0].name, containers[0].children?.[0].kind],
            ['application', 2],
          );
          assert.deepEqual(
            containers[0].children?.[0].selectionRange,
            findRangeInText(anonymous, 'application'),
          );
        } finally {
          changeManifest(manifestText);
        }
      },
    );

    await t.test(
      'DocumentSymbol: unsaved didChange with invalid XML names and partial tag resilience',
      async () => {
        const modifiedStrings = stringsText.replace(
          '</resources>',
          '    <string name="item_&amp;_test">Escaped Ampersand</string>\n</resources>',
        );
        client.notify('textDocument/didChange', {
          textDocument: { uri: stringsUri, version: 2 },
          contentChanges: [{ text: modifiedStrings }],
        });

        const syms = (await client.request('textDocument/documentSymbol', {
          textDocument: { uri: stringsUri },
        })) as LspDocumentSymbol[];
        const ampSym = syms.find((s) => s.name === 'item_&_test');
        assert.ok(
          ampSym,
          'Decoded symbol name "item_&_test" must be found for unsaved invalid XML name',
        );
        const lines = modifiedStrings.split(/\r?\n/);
        assert.equal(
          lines[ampSym.selectionRange.start.line].slice(
            ampSym.selectionRange.start.character,
            ampSym.selectionRange.end.character,
          ),
          'item_&amp;_test',
          'selectionRange must span raw un-decoded ampersand entity',
        );
        assert.equal(
          await readFile(stringsPath, 'utf8'),
          stringsText,
          'Disk must remain strictly unchanged',
        );

        const partialUri = pathToFileURL(join(appDir, 'res', 'values', 'partial.xml')).href;
        client.notify('textDocument/didOpen', {
          textDocument: {
            uri: partialUri,
            languageId: 'xml',
            version: 1,
            text: '<resources>\n    <string name="valid_prior">Prior</string>\n    <string name="broken_eof',
          },
        });
        const partialSyms = (await client.request('textDocument/documentSymbol', {
          textDocument: { uri: partialUri },
        })) as LspDocumentSymbol[];
        assert.ok(
          partialSyms.some((s) => s.name === 'valid_prior'),
          'Valid prior nodes must survive partial bad XML',
        );
        client.notify('textDocument/didClose', { textDocument: { uri: partialUri } });

        client.notify('textDocument/didChange', {
          textDocument: { uri: stringsUri, version: 3 },
          contentChanges: [{ text: stringsText }],
        });
      },
    );

    await t.test(
      'DocumentSymbol: flat SymbolInformation without hierarchicalDocumentSymbolSupport',
      async () => {
        flatDriver = await startLspClient(projectDir, sandbox, {
          hierarchicalDocumentSymbolSupport: false,
        });
        const stylesUri = pathToFileURL(join(appDir, 'res', 'values', 'styles.xml')).href;
        flatDriver.notify('textDocument/didOpen', {
          textDocument: {
            uri: stylesUri,
            languageId: 'xml',
            version: 1,
            text: await readFile(join(appDir, 'res', 'values', 'styles.xml'), 'utf8'),
          },
        });
        const flatSyms = (await flatDriver.request('textDocument/documentSymbol', {
          textDocument: { uri: stylesUri },
        })) as LspSymbolInformation[];
        assert.ok(Array.isArray(flatSyms));
        for (const s of flatSyms) {
          assert.equal(
            (s as unknown as LspDocumentSymbol).children,
            undefined,
            'Flat symbols must not have children',
          );
          assert.ok(
            s.location?.uri && s.location.range,
            'Flat symbol must contain location uri and range',
          );
        }
        assert.equal(flatSyms.find((s) => s.name === 'colorPrimary')?.containerName, 'AppTheme');
        await flatDriver.close();
        flatDriver = null;
      },
    );

    await t.test(
      'References: Manifest references set equality with source code references and declaration flag',
      async () => {
        const sourcePos = findPositionInText(mainActivityText, 'MainActivity : Activity');
        const sourceRefsNoDecl = normalizeLocations(
          await client.request('textDocument/references', {
            textDocument: { uri: mainActivityUri },
            position: sourcePos,
            context: { includeDeclaration: false },
          }),
        );
        const sourceRefsWithDecl = normalizeLocations(
          await client.request('textDocument/references', {
            textDocument: { uri: mainActivityUri },
            position: sourcePos,
            context: { includeDeclaration: true },
          }),
        );

        const manifestPos = findPositionInText(manifestText, '.MainActivity');
        const expectedXmlLoc: LspLocation = {
          uri: manifestUri,
          range: findRangeInText(manifestText, '.MainActivity'),
        };

        const manifestRefsNoDecl = normalizeLocations(
          await client.request('textDocument/references', {
            textDocument: { uri: manifestUri },
            position: manifestPos,
            context: { includeDeclaration: false },
          }),
        );
        const manifestRefsWithDecl = normalizeLocations(
          await client.request('textDocument/references', {
            textDocument: { uri: manifestUri },
            position: manifestPos,
            context: { includeDeclaration: true },
          }),
        );

        const codeSourceNoDecl = sourceRefsNoDecl.filter((loc) => !loc.uri.endsWith('.xml'));
        const codeManifestNoDecl = manifestRefsNoDecl.filter((loc) => !loc.uri.endsWith('.xml'));
        const javaPath = join(appDir, 'java', 'com', 'example', 'app', 'JavaClassReference.java');
        const javaReference = {
          uri: pathToFileURL(javaPath).href,
          range: findRangeInText(await readFile(javaPath, 'utf8'), 'MainActivity'),
        };
        assert(new Set(codeSourceNoDecl.map(locationToKey)).has(locationToKey(javaReference)));
        assert.deepEqual(
          new Set(codeManifestNoDecl.map(locationToKey)),
          new Set(codeSourceNoDecl.map(locationToKey)),
          'Manifest code references must be exact set equal to native source code references',
        );

        const codeSourceWithDecl = sourceRefsWithDecl.filter((loc) => !loc.uri.endsWith('.xml'));
        const codeManifestWithDecl = manifestRefsWithDecl.filter(
          (loc) => !loc.uri.endsWith('.xml'),
        );
        assert.deepEqual(
          new Set(codeManifestWithDecl.map(locationToKey)),
          new Set(codeSourceWithDecl.map(locationToKey)),
          'Manifest code references with declaration must match source references with declaration',
        );

        const manifestXmlLocations = manifestRefsNoDecl.filter((loc) => loc.uri.endsWith('.xml'));
        assert.equal(
          manifestXmlLocations.length,
          1,
          'Relative class must append XML attribute exactly once',
        );
        assert.ok(
          locationsEqual(manifestXmlLocations[0], expectedXmlLoc),
          'Attribute location must exclude quotes',
        );
      },
    );

    await t.test(
      'References: FQN class attribute appends current attribute exactly once without quotes',
      async () => {
        const sourcePos = findPositionInText(targetActivityText, 'TargetActivity : Activity');
        const sourceRefs = normalizeLocations(
          await client.request('textDocument/references', {
            textDocument: { uri: targetActivityUri },
            position: sourcePos,
            context: { includeDeclaration: false },
          }),
        );
        const codeSourceRefs = sourceRefs.filter((loc) => !loc.uri.endsWith('.xml'));

        const fqnPos = findPositionInText(manifestText, 'com.example.app.TargetActivity');
        const expectedFqnLoc: LspLocation = {
          uri: manifestUri,
          range: findRangeInText(manifestText, 'com.example.app.TargetActivity'),
        };

        const manifestRefs = normalizeLocations(
          await client.request('textDocument/references', {
            textDocument: { uri: manifestUri },
            position: fqnPos,
            context: { includeDeclaration: false },
          }),
        );

        const xmlLocations = manifestRefs.filter((loc) => loc.uri.endsWith('.xml'));
        assert.equal(
          xmlLocations.length,
          1,
          'FQN must produce exactly one XML location without quote duplicates',
        );
        assert.ok(
          locationsEqual(xmlLocations[0], expectedFqnLoc),
          'Appended FQN location must exclude quotes',
        );

        const codeManifestRefs = manifestRefs.filter((loc) => !loc.uri.endsWith('.xml'));
        assert.deepEqual(
          new Set(codeManifestRefs.map(locationToKey)),
          new Set(codeSourceRefs.map(locationToKey)),
          'FQN Manifest code references must match source code references exactly',
        );
      },
    );

    await t.test(
      'References: zero-use class returns XML attribute alone, plus declaration when true',
      async () => {
        const zeroPos = findPositionInText(manifestText, '.ZeroUseActivity');
        const expectedAttrLoc: LspLocation = {
          uri: manifestUri,
          range: findRangeInText(manifestText, '.ZeroUseActivity'),
        };

        const refsNoDecl = normalizeLocations(
          await client.request('textDocument/references', {
            textDocument: { uri: manifestUri },
            position: zeroPos,
            context: { includeDeclaration: false },
          }),
        );
        assert.equal(
          refsNoDecl.length,
          1,
          'Zero-use without declaration must return only current XML attribute',
        );
        assert.ok(locationsEqual(refsNoDecl[0], expectedAttrLoc));

        const refsWithDecl = normalizeLocations(
          await client.request('textDocument/references', {
            textDocument: { uri: manifestUri },
            position: zeroPos,
            context: { includeDeclaration: true },
          }),
        );
        assert.equal(
          refsWithDecl.length,
          2,
          'Zero-use with declaration must return XML attribute + class declaration',
        );
        assert.ok(refsWithDecl.some((loc) => locationsEqual(loc, expectedAttrLoc)));
        assert.ok(refsWithDecl.some((loc) => normalizeUri(loc.uri) === normalizeUri(zeroUseUri)));
      },
    );

    await t.test(
      'References: qualified KDoc, alias targetActivity, library class, and inner class',
      async () => {
        const targetRefs = normalizeLocations(
          await client.request('textDocument/references', {
            textDocument: { uri: targetActivityUri },
            position: findPositionInText(targetActivityText, 'TargetActivity : Activity'),
            context: { includeDeclaration: false },
          }),
        );
        const kdocRange = findRangeInText(targetActivityText, 'com.example.app.TargetActivity');
        assert.ok(
          targetRefs.some(
            (loc) =>
              normalizeUri(loc.uri) === normalizeUri(targetActivityUri) &&
              loc.range.start.line === kdocRange.start.line,
          ),
        );

        const aliasTargetPos = findPositionInText(
          manifestText,
          'android:targetActivity=".TargetActivity"',
        );
        const aliasTargetRefs = normalizeLocations(
          await client.request('textDocument/references', {
            textDocument: { uri: manifestUri },
            position: {
              line: aliasTargetPos.line,
              character: aliasTargetPos.character + 'android:targetActivity="'.length + 1,
            },
            context: { includeDeclaration: false },
          }),
        );
        assert.ok(
          aliasTargetRefs.some((loc) => normalizeUri(loc.uri) === normalizeUri(targetActivityUri)),
        );

        const libPos = findPositionInText(
          manifestText,
          'android:name="com.example.lib.LibActivity"',
        );
        const libRefs = normalizeLocations(
          await client.request('textDocument/references', {
            textDocument: { uri: manifestUri },
            position: {
              line: libPos.line,
              character: libPos.character + 'android:name="'.length + 1,
            },
            context: { includeDeclaration: false },
          }),
        );
        assert.ok(libRefs.some((loc) => normalizeUri(loc.uri) === normalizeUri(mainActivityUri)));

        const innerPos = findPositionInText(manifestText, '.MainActivity$InnerService');
        const innerRefs = normalizeLocations(
          await client.request('textDocument/references', {
            textDocument: { uri: manifestUri },
            position: innerPos,
            context: { includeDeclaration: true },
          }),
        );
        assert.ok(innerRefs.some((loc) => normalizeUri(loc.uri) === normalizeUri(mainActivityUri)));
      },
    );

    await t.test(
      'References: unresolved class rejects -32803 target_unresolved and placeholder returns empty',
      async () => {
        const placeholderSnippet =
          '    <activity android:name="' +
          '$' +
          '{applicationId}.PlaceholderActivity" android:exported="false" />\n';
        const manifestWithUnresolved = manifestText.replace(
          '</application>',
          '    <activity android:name=".UnresolvedActivity" android:exported="false" />\n' +
            placeholderSnippet +
            '</application>',
        );
        try {
          changeManifest(manifestWithUnresolved);

          const unresolvedPos = findPositionInText(manifestWithUnresolved, '.UnresolvedActivity');
          await assert.rejects(
            () =>
              client.request('textDocument/references', {
                textDocument: { uri: manifestUri },
                position: unresolvedPos,
                context: { includeDeclaration: false },
              }),
            (err: Error) =>
              err.message.includes('-32803') && err.message.includes('target_unresolved'),
            'Unresolved target must reject with RPC -32803 target_unresolved',
          );

          const placeholderPos = findPositionInText(
            manifestWithUnresolved,
            '$\x7bapplicationId\x7d.PlaceholderActivity',
          );
          const placeholderRes = await client.request('textDocument/references', {
            textDocument: { uri: manifestUri },
            position: placeholderPos,
            context: { includeDeclaration: false },
          });
          assert.deepEqual(placeholderRes, [], 'Unsupported placeholder must return empty list');

          const binaryName = 'com.example.nosource.NoSourcesActivity';
          const binaryManifest = manifestText.replace('.SecondaryActivity', binaryName);
          changeManifest(binaryManifest);
          await assert.rejects(
            () =>
              client.request('textDocument/references', {
                textDocument: { uri: manifestUri },
                position: findPositionInText(binaryManifest, binaryName),
                context: { includeDeclaration: false },
              }),
            (error: Error) =>
              error.message.includes('-32803') && error.message.includes('target_unresolved'),
          );
        } finally {
          changeManifest(manifestText);
        }
      },
    );

    await t.test(
      'Manifest class identity distinguishes ambiguous declarations and missing namespace',
      async () => {
        const duplicateUri = pathToFileURL(
          join(appDir, 'java', 'com', 'example', 'app', 'DuplicateFqn.java'),
        ).href;
        client.notify('textDocument/didOpen', {
          textDocument: {
            uri: duplicateUri,
            languageId: 'java',
            version: 1,
            text: 'package com.example.app; class MainActivity {}',
          },
        });
        try {
          await assert.rejects(
            () =>
              client.request('textDocument/references', {
                textDocument: { uri: manifestUri },
                position: findPositionInText(manifestText, '.MainActivity'),
                context: { includeDeclaration: false },
              }),
            (error: Error) =>
              error.message.includes('-32803') && error.message.includes('ambiguous_target'),
          );
        } finally {
          client.notify('textDocument/didClose', { textDocument: { uri: duplicateUri } });
        }
        const scriptPath = join(projectDir, 'app', 'build.gradle.kts');
        const scriptUri = pathToFileURL(scriptPath).href;
        const script = await readFile(scriptPath, 'utf8');
        client.notify('textDocument/didOpen', {
          textDocument: {
            uri: scriptUri,
            languageId: 'kotlin',
            version: 1,
            text: script.replace(
              'namespace = "com.example.app"',
              'namespace = providers.gradleProperty("runtimeNamespace").get()',
            ),
          },
        });
        try {
          await assert.rejects(
            () =>
              client.request('textDocument/references', {
                textDocument: { uri: manifestUri },
                position: findPositionInText(manifestText, '.MainActivity'),
                context: { includeDeclaration: false },
              }),
            (error: Error) =>
              error.message.includes('-32803') && error.message.includes('model_unavailable'),
          );
          const fullName = 'com.example.app.TargetActivity';
          const target = normalizeLocations(
            await client.request('textDocument/definition', {
              textDocument: { uri: manifestUri },
              position: findPositionInText(manifestText, fullName),
            }),
          );
          assert(
            target.some(
              (location) => normalizeUri(location.uri) === normalizeUri(targetActivityUri),
            ),
          );
        } finally {
          client.notify('textDocument/didClose', { textDocument: { uri: scriptUri } });
        }
      },
    );

    await t.test('Definition: exact source priority and fail-closed AGP provenance', async () => {
      const start = findPositionInText(mainActivityText, 'R.string.app_name');
      const definition = async () =>
        normalizeLocations(
          await client.request('textDocument/definition', {
            textDocument: { uri: mainActivityUri },
            position: { line: start.line, character: start.character + 'R.string.'.length + 1 },
          }),
        );
      const qualifiedStringsPath = join(appDir, 'res', 'values-es', 'strings.xml');
      const expectedSource = [
        {
          uri: stringsUri,
          range: findRangeInText(stringsText, 'app_name'),
        },
        {
          uri: pathToFileURL(qualifiedStringsPath).href,
          range: findRangeInText(await readFile(qualifiedStringsPath, 'utf8'), 'app_name'),
        },
      ];
      const expectSource = (locations: LspLocation[]) =>
        assert.deepEqual(
          new Set(locations.map(locationToKey)),
          new Set(expectedSource.map(locationToKey)),
        );
      let version = 4;
      const changeStrings = (text: string) =>
        client.notify('textDocument/didChange', {
          textDocument: { uri: stringsUri, version: version++ },
          contentChanges: [{ text }],
        });
      expectSource(await definition());
      const customStart = findPositionInText(mainActivityText, 'R.string.custom_root_string');
      const customPath = join(projectDir, 'app', 'custom-res', 'values', 'custom.xml');
      const customDefinitions = normalizeLocations(
        await client.request('textDocument/definition', {
          textDocument: { uri: mainActivityUri },
          position: {
            line: customStart.line,
            character: customStart.character + 'R.string.'.length + 1,
          },
        }),
      );
      assert.deepEqual(
        customDefinitions.map(locationToKey),
        [
          {
            uri: pathToFileURL(customPath).href,
            range: findRangeInText(await readFile(customPath, 'utf8'), 'custom_root_string'),
          },
        ].map(locationToKey),
      );
      try {
        changeStrings(
          stringsText.replace(
            '</resources>',
            '<string name="unrelated_uncompiled_resource">New</string></resources>',
          ),
        );
        expectSource(await definition());
        changeStrings(stringsText.replace('name="app_name"', 'name="renamed_app_name"'));
        const nativeTarget = await definition();
        assert.equal(nativeTarget.length, 1);
        assert(nativeTarget[0].uri.startsWith('jar:') && nativeTarget[0].uri.includes('/R.jar!/'));
        const expectNative = (locations: LspLocation[]) =>
          assert.deepEqual(locations.map(locationToKey), nativeTarget.map(locationToKey));
        changeStrings(stringsText);
        expectSource(await definition());

        const overridePath = join(appDir, 'res', 'values', 'unsaved_override.xml');
        const overrideUri = pathToFileURL(overridePath).href;
        client.notify('textDocument/didOpen', {
          textDocument: {
            uri: overrideUri,
            languageId: 'xml',
            version: 1,
            text: '<resources><string name="app_name">Unbuilt override</string></resources>',
          },
        });
        try {
          expectNative(await definition());
          assert.equal(existsSync(overridePath), false);
        } finally {
          client.notify('textDocument/didClose', { textDocument: { uri: overrideUri } });
        }
        expectSource(await definition());

        const missingPath = `${stringsPath}.removed`;
        await rename(stringsPath, missingPath);
        try {
          expectNative(await definition());
        } finally {
          await rename(missingPath, stringsPath);
        }

        const blamePath = join(
          projectDir,
          'app/build/intermediates/merged_res_blame_folder/debug/mergeDebugResources/out/multi-v2/values.json',
        );
        const blame = await readFile(blamePath);
        try {
          await writeFile(blamePath, JSON.stringify({ logs: {} }));
          expectNative(await definition());
          const invalid = JSON.parse(blame.toString('utf8'));
          for (const log of invalid.logs)
            for (const mapping of log.map) mapping.source = 'unknown-source:/values/strings.xml';
          await writeFile(blamePath, JSON.stringify(invalid));
          expectNative(await definition());
        } finally {
          await writeFile(blamePath, blame);
        }
        expectSource(await definition());
        assert.equal(await readFile(stringsPath, 'utf8'), stringsText);
      } finally {
        changeStrings(stringsText);
      }
    });
    await t.test(
      'References: Resource XML declaration to code references, includeDeclaration, and legal zero-use',
      async () => {
        const usageRefPath = join(
          appDir,
          'java',
          'com',
          'example',
          'app',
          'ResourceUsageReference.kt',
        );
        const usageRefText = await readFile(usageRefPath, 'utf8');
        const usageRefUri = pathToFileURL(usageRefPath).href;

        const javaResPath = join(
          appDir,
          'java',
          'com',
          'example',
          'app',
          'JavaResourceReference.java',
        );
        const javaResText = await readFile(javaResPath, 'utf8');
        const javaResUri = pathToFileURL(javaResPath).href;

        client.notify('textDocument/didOpen', {
          textDocument: { uri: usageRefUri, languageId: 'kotlin', version: 1, text: usageRefText },
        });
        client.notify('textDocument/didOpen', {
          textDocument: { uri: javaResUri, languageId: 'java', version: 1, text: javaResText },
        });

        // 1. Strings: hello_message
        const helloDeclPos = findPositionInText(stringsText, 'hello_message');
        const expectedDeclLoc: LspLocation = {
          uri: stringsUri,
          range: findRangeInText(stringsText, 'hello_message'),
        };
        const expectedMainHelloRef: LspLocation = {
          uri: mainActivityUri,
          range: findFieldRangeInText(mainActivityText, 'R.string.hello_message'),
        };
        const expectedHelloCodeRefs: LspLocation[] = [
          expectedMainHelloRef,
          {
            uri: usageRefUri,
            range: findFieldRangeInText(usageRefText, 'ResString.hello_message'),
          },
        ];

        // Query references with includeDeclaration: false
        const helloRefsNoDecl = normalizeLocations(
          await client.request('textDocument/references', {
            textDocument: { uri: stringsUri },
            position: helloDeclPos,
            context: { includeDeclaration: false },
          }),
        );
        assert.deepEqual(
          new Set(helloRefsNoDecl.map(locationToKey)),
          new Set(expectedHelloCodeRefs.map(locationToKey)),
          'Exact set equality for hello_message code references without declaration',
        );

        // Query references with includeDeclaration: true
        const helloRefsWithDecl = normalizeLocations(
          await client.request('textDocument/references', {
            textDocument: { uri: stringsUri },
            position: helloDeclPos,
            context: { includeDeclaration: true },
          }),
        );
        const expectedHelloWithDecl = [...expectedHelloCodeRefs, expectedDeclLoc];
        assert.deepEqual(
          new Set(helloRefsWithDecl.map(locationToKey)),
          new Set(expectedHelloWithDecl.map(locationToKey)),
          'Exact set equality for hello_message code references with XML declaration',
        );
        assert.equal(
          helloRefsWithDecl.length,
          helloRefsNoDecl.length + 1,
          'includeDeclaration: true must add exactly one current XML declaration',
        );

        // 2. Legal zero references: quoted_text
        const quotedDeclPos = findPositionInText(stringsText, 'quoted_text');
        const expectedQuotedDeclLoc: LspLocation = {
          uri: stringsUri,
          range: findRangeInText(stringsText, 'quoted_text'),
        };
        const zeroRefsNoDecl = normalizeLocations(
          await client.request('textDocument/references', {
            textDocument: { uri: stringsUri },
            position: quotedDeclPos,
            context: { includeDeclaration: false },
          }),
        );
        assert.deepEqual(
          zeroRefsNoDecl,
          [],
          'Unreferenced resource with includeDeclaration: false must return exact []',
        );

        const zeroRefsWithDecl = normalizeLocations(
          await client.request('textDocument/references', {
            textDocument: { uri: stringsUri },
            position: quotedDeclPos,
            context: { includeDeclaration: true },
          }),
        );
        assert.deepEqual(
          zeroRefsWithDecl.map(locationToKey),
          [locationToKey(expectedQuotedDeclLoc)],
          'Unreferenced resource with includeDeclaration: true must return declaration alone',
        );

        // 3. App name: Java static import, qualified call, and local variable shadowing isolation
        const appNameDeclPos = findPositionInText(stringsText, 'app_name');
        const appNameRefsNoDecl = normalizeLocations(
          await client.request('textDocument/references', {
            textDocument: { uri: stringsUri },
            position: appNameDeclPos,
            context: { includeDeclaration: false },
          }),
        );
        const expectedAppNameRefs: LspLocation[] = [
          {
            uri: mainActivityUri,
            range: findFieldRangeInText(mainActivityText, 'R.string.app_name'),
          },
          {
            uri: javaResUri,
            range: findRangeInText(javaResText, 'app_name', 2),
          },
          {
            uri: javaResUri,
            range: findFieldRangeInText(javaResText, 'com.example.app.R.string.app_name', 2),
          },
          {
            uri: javaResUri,
            range: findFieldRangeInText(javaResText, 'com.example.app.R.string.app_name'),
          },
        ];
        assert.deepEqual(
          new Set(appNameRefsNoDecl.map(locationToKey)),
          new Set(expectedAppNameRefs.map(locationToKey)),
          'Exact set equality for app_name references covering Kotlin, Java static import, and qualified call',
        );
        assert.ok(
          !appNameRefsNoDecl.some(
            (loc) =>
              normalizeUri(loc.uri) === normalizeUri(usageRefUri) &&
              loc.range.start.line === findPositionInText(usageRefText, 'app_name.length').line,
          ),
          'Local shadowed variable must not be treated as resource reference',
        );
      },
    );

    await t.test(
      'References: multiple resource types (color, dimen, bool, integer, array, plurals, style, id, layout)',
      async () => {
        const usageRefPath = join(
          appDir,
          'java',
          'com',
          'example',
          'app',
          'ResourceUsageReference.kt',
        );
        const usageRefText = await readFile(usageRefPath, 'utf8');
        const usageRefUri = pathToFileURL(usageRefPath).href;

        // Color
        const colorsPath = join(appDir, 'res', 'values', 'colors.xml');
        const colorsText = await readFile(colorsPath, 'utf8');
        const colorsUri = pathToFileURL(colorsPath).href;
        client.notify('textDocument/didOpen', {
          textDocument: { uri: colorsUri, languageId: 'xml', version: 1, text: colorsText },
        });
        const colorRefs = normalizeLocations(
          await client.request('textDocument/references', {
            textDocument: { uri: colorsUri },
            position: findPositionInText(colorsText, 'primary_color'),
            context: { includeDeclaration: false },
          }),
        );
        const expectedColorRefs: LspLocation[] = [
          {
            uri: mainActivityUri,
            range: findFieldRangeInText(mainActivityText, 'R.color.primary_color'),
          },
          {
            uri: usageRefUri,
            range: findRangeInText(usageRefText, 'primary_color'),
          },
        ];
        assert.deepEqual(
          new Set(colorRefs.map(locationToKey)),
          new Set(expectedColorRefs.map(locationToKey)),
          'Exact set equality for color references (direct and wildcard)',
        );

        // Dimen
        const dimensPath = join(appDir, 'res', 'values', 'dimens.xml');
        const dimensText = await readFile(dimensPath, 'utf8');
        const dimensUri = pathToFileURL(dimensPath).href;
        client.notify('textDocument/didOpen', {
          textDocument: { uri: dimensUri, languageId: 'xml', version: 1, text: dimensText },
        });
        const dimenRefs = normalizeLocations(
          await client.request('textDocument/references', {
            textDocument: { uri: dimensUri },
            position: findPositionInText(dimensText, 'default_margin'),
            context: { includeDeclaration: false },
          }),
        );
        const expectedDimenRefs: LspLocation[] = [
          {
            uri: mainActivityUri,
            range: findFieldRangeInText(mainActivityText, 'R.dimen.default_margin'),
          },
        ];
        assert.deepEqual(
          new Set(dimenRefs.map(locationToKey)),
          new Set(expectedDimenRefs.map(locationToKey)),
          'Exact set equality for dimen references',
        );

        // Attrs: bool, integer, array, plurals, id
        const attrsPath = join(appDir, 'res', 'values', 'attrs.xml');
        const attrsText = await readFile(attrsPath, 'utf8');
        const attrsUri = pathToFileURL(attrsPath).href;
        client.notify('textDocument/didOpen', {
          textDocument: { uri: attrsUri, languageId: 'xml', version: 1, text: attrsText },
        });

        // bool
        const boolRefs = normalizeLocations(
          await client.request('textDocument/references', {
            textDocument: { uri: attrsUri },
            position: findPositionInText(attrsText, 'feature_enabled'),
            context: { includeDeclaration: false },
          }),
        );
        assert.deepEqual(
          boolRefs.map(locationToKey),
          [
            locationToKey({
              uri: usageRefUri,
              range: findFieldRangeInText(usageRefText, 'R.bool.feature_enabled'),
            }),
          ],
          'Exact set equality for bool reference',
        );

        // integer
        const intRefs = normalizeLocations(
          await client.request('textDocument/references', {
            textDocument: { uri: attrsUri },
            position: findPositionInText(attrsText, 'max_retry_count'),
            context: { includeDeclaration: false },
          }),
        );
        assert.deepEqual(
          intRefs.map(locationToKey),
          [
            locationToKey({
              uri: usageRefUri,
              range: findFieldRangeInText(usageRefText, 'R.integer.max_retry_count'),
            }),
          ],
          'Exact set equality for integer reference',
        );

        // array
        const arrayRefs = normalizeLocations(
          await client.request('textDocument/references', {
            textDocument: { uri: attrsUri },
            position: findPositionInText(attrsText, 'planets'),
            context: { includeDeclaration: false },
          }),
        );
        assert.deepEqual(
          arrayRefs.map(locationToKey),
          [
            locationToKey({
              uri: usageRefUri,
              range: findFieldRangeInText(usageRefText, 'R.array.planets'),
            }),
          ],
          'Exact set equality for array reference',
        );

        // plurals
        const pluralsRefs = normalizeLocations(
          await client.request('textDocument/references', {
            textDocument: { uri: attrsUri },
            position: findPositionInText(attrsText, 'items_count'),
            context: { includeDeclaration: false },
          }),
        );
        assert.deepEqual(
          pluralsRefs.map(locationToKey),
          [
            locationToKey({
              uri: usageRefUri,
              range: findFieldRangeInText(usageRefText, 'R.plurals.items_count'),
            }),
          ],
          'Exact set equality for plurals reference',
        );

        // id item
        const idRefs = normalizeLocations(
          await client.request('textDocument/references', {
            textDocument: { uri: attrsUri },
            position: findPositionInText(attrsText, 'custom_view_id'),
            context: { includeDeclaration: false },
          }),
        );
        assert.deepEqual(
          idRefs.map(locationToKey),
          [
            locationToKey({
              uri: usageRefUri,
              range: findFieldRangeInText(usageRefText, 'R.id.custom_view_id'),
            }),
          ],
          'Exact set equality for id reference',
        );

        // Style: AppTheme in styles.xml
        const stylesPath = join(appDir, 'res', 'values', 'styles.xml');
        const stylesText = await readFile(stylesPath, 'utf8');
        const stylesUri = pathToFileURL(stylesPath).href;
        client.notify('textDocument/didOpen', {
          textDocument: { uri: stylesUri, languageId: 'xml', version: 1, text: stylesText },
        });
        const styleRefs = normalizeLocations(
          await client.request('textDocument/references', {
            textDocument: { uri: stylesUri },
            position: findPositionInText(stylesText, 'AppTheme'),
            context: { includeDeclaration: false },
          }),
        );
        assert.deepEqual(
          styleRefs.map(locationToKey),
          [
            locationToKey({
              uri: usageRefUri,
              range: findFieldRangeInText(usageRefText, 'R.style.AppTheme'),
            }),
          ],
          'Exact set equality for style reference',
        );

        // Layout: activity_main.xml (file resource)
        const layoutPath = join(appDir, 'res', 'layout', 'activity_main.xml');
        const layoutText = await readFile(layoutPath, 'utf8');
        const layoutUri = pathToFileURL(layoutPath).href;
        client.notify('textDocument/didOpen', {
          textDocument: { uri: layoutUri, languageId: 'xml', version: 1, text: layoutText },
        });
        const layoutRefs = normalizeLocations(
          await client.request('textDocument/references', {
            textDocument: { uri: layoutUri },
            position: findPositionInText(layoutText, 'LinearLayout'),
            context: { includeDeclaration: false },
          }),
        );
        assert.deepEqual(
          layoutRefs.map(locationToKey),
          [
            locationToKey({
              uri: usageRefUri,
              range: findFieldRangeInText(usageRefText, 'R.layout.activity_main'),
            }),
          ],
          'Exact set equality for layout reference',
        );

        // Verify that clicking on an inner child element in layout file does NOT treat it as a resource declaration
        const innerLayoutRefs = normalizeLocations(
          await client.request('textDocument/references', {
            textDocument: { uri: layoutUri },
            position: findPositionInText(layoutText, 'TextView'),
            context: { includeDeclaration: false },
          }),
        );
        assert.deepEqual(
          innerLayoutRefs,
          [],
          'Inner tag in layout file must not be treated as resource declaration',
        );
      },
    );

    await t.test('References: dotted style names use the verified compiled R field', async () => {
      const file = join(appDir, 'res', 'values', 'styles.xml');
      const text = await readFile(file, 'utf8');
      const usage = join(appDir, 'java', 'com', 'example', 'app', 'ResourceUsageReference.kt');
      const usageText = await readFile(usage, 'utf8');
      const references = normalizeLocations(
        await client.request('textDocument/references', {
          textDocument: { uri: pathToFileURL(file).href },
          position: findPositionInText(text, 'Dotted.Theme'),
          context: { includeDeclaration: false },
        }),
      );
      assert.deepEqual(references.map(locationToKey), [
        locationToKey({
          uri: pathToFileURL(usage).href,
          range: findFieldRangeInText(usageText, 'R.style.Dotted_Theme'),
        }),
      ]);
    });

    for (const resource of [
      { type: 'drawable', folder: 'drawable', name: 'reference_drawable', root: 'shape' },
      {
        type: 'mipmap',
        folder: 'mipmap-anydpi-v26',
        name: 'reference_icon',
        root: 'adaptive-icon',
      },
      { type: 'anim', folder: 'anim', name: 'reference_alpha', root: 'alpha' },
      { type: 'animator', folder: 'animator', name: 'reference_animator', root: 'objectAnimator' },
      { type: 'raw', folder: 'raw', name: 'reference_raw', root: 'probe' },
      { type: 'xml', folder: 'xml', name: 'reference_config', root: 'preferences' },
    ]) {
      await t.test(
        `References: ${resource.type} XML file identity and declaration range`,
        async () => {
          const file = join(appDir, 'res', resource.folder, `${resource.name}.xml`);
          const text = await readFile(file, 'utf8');
          const uri = pathToFileURL(file).href;
          const usage = join(appDir, 'java', 'com', 'example', 'app', 'ResourceUsageReference.kt');
          const usageText = await readFile(usage, 'utf8');
          client.notify('textDocument/didOpen', {
            textDocument: { uri, languageId: 'xml', version: 1, text },
          });
          const expectedUsage = locationToKey({
            uri: pathToFileURL(usage).href,
            range: findFieldRangeInText(usageText, `R.${resource.type}.${resource.name}`),
          });
          for (const includeDeclaration of [false, true]) {
            const references = normalizeLocations(
              await client.request('textDocument/references', {
                textDocument: { uri },
                position: findPositionInText(text, resource.root),
                context: { includeDeclaration },
              }),
            );
            const expected = new Set([expectedUsage]);
            if (includeDeclaration)
              expected.add(locationToKey({ uri, range: findRangeInText(text, resource.root) }));
            assert.deepEqual(new Set(references.map(locationToKey)), expected);
          }
        },
      );
    }

    await t.test(
      'References: true transitive graph (> single edge: core -> lib -> app)',
      async () => {
        const coreStringsPath = join(
          projectDir,
          'core',
          'src',
          'main',
          'res',
          'values',
          'strings.xml',
        );
        const coreStringsText = await readFile(coreStringsPath, 'utf8');
        const coreStringsUri = pathToFileURL(coreStringsPath).href;
        client.notify('textDocument/didOpen', {
          textDocument: {
            uri: coreStringsUri,
            languageId: 'xml',
            version: 1,
            text: coreStringsText,
          },
        });

        const coreTitleRefs = normalizeLocations(
          await client.request('textDocument/references', {
            textDocument: { uri: coreStringsUri },
            position: findPositionInText(coreStringsText, 'core_title'),
            context: { includeDeclaration: false },
          }),
        );
        const usageRefPath = join(
          appDir,
          'java',
          'com',
          'example',
          'app',
          'ResourceUsageReference.kt',
        );
        const usageRefText = await readFile(usageRefPath, 'utf8');
        const usageRefUri = pathToFileURL(usageRefPath).href;

        const expectedCoreRef: LspLocation = {
          uri: usageRefUri,
          range: findFieldRangeInText(usageRefText, 'com.example.core.R.string.core_title'),
        };
        const coreUsagePath = join(
          projectDir,
          'core',
          'src',
          'main',
          'java',
          'com',
          'example',
          'core',
          'CoreUsage.java',
        );
        const coreUsageReference = locationToKey({
          uri: pathToFileURL(coreUsagePath).href,
          range: findFieldRangeInText(await readFile(coreUsagePath, 'utf8'), 'R.string.core_title'),
        });
        assert.deepEqual(
          new Set(coreTitleRefs.map(locationToKey)),
          new Set([locationToKey(expectedCoreRef), coreUsageReference]),
          'True transitive consumption (core -> lib -> app) must be found with exact location',
        );
        const sameName = normalizeLocations(
          await client.request('textDocument/references', {
            textDocument: { uri: coreStringsUri },
            position: findPositionInText(coreStringsText, 'app_name'),
            context: { includeDeclaration: false },
          }),
        );
        assert.deepEqual(
          sameName.map(locationToKey),
          [
            locationToKey({
              uri: pathToFileURL(coreUsagePath).href,
              range: findFieldRangeInText(
                await readFile(coreUsagePath, 'utf8'),
                'R.string.app_name',
              ),
            }),
          ],
          'Same resource name in a different namespace keeps its own PSI field identity',
        );
      },
    );

    await t.test(
      'References: same-namespace independent module isolation and qualifiers',
      async () => {
        // 1. Independent module with same namespace com.example.app
        const indStringsPath = join(
          projectDir,
          'independent',
          'src',
          'main',
          'res',
          'values',
          'strings.xml',
        );
        const indStringsText = await readFile(indStringsPath, 'utf8');
        const indStringsUri = pathToFileURL(indStringsPath).href;

        const indUsagePath = join(
          projectDir,
          'independent',
          'src',
          'main',
          'java',
          'com',
          'example',
          'independent',
          'IndependentUsage.java',
        );
        const indUsageText = await readFile(indUsagePath, 'utf8');
        const indUsageUri = pathToFileURL(indUsagePath).href;

        client.notify('textDocument/didOpen', {
          textDocument: { uri: indStringsUri, languageId: 'xml', version: 1, text: indStringsText },
        });
        client.notify('textDocument/didOpen', {
          textDocument: { uri: indUsageUri, languageId: 'java', version: 1, text: indUsageText },
        });

        // Querying app_name in app's strings.xml must NOT return IndependentUsage
        const appRefs = normalizeLocations(
          await client.request('textDocument/references', {
            textDocument: { uri: stringsUri },
            position: findPositionInText(stringsText, 'app_name'),
            context: { includeDeclaration: false },
          }),
        );
        assert.ok(
          !appRefs.some((loc) => normalizeUri(loc.uri) === normalizeUri(indUsageUri)),
          'app module references must not contain independent module usage',
        );

        // Querying app_name in independent module's strings.xml must return ONLY IndependentUsage
        const indRefs = normalizeLocations(
          await client.request('textDocument/references', {
            textDocument: { uri: indStringsUri },
            position: findPositionInText(indStringsText, 'app_name'),
            context: { includeDeclaration: false },
          }),
        );
        const expectedIndRef: LspLocation = {
          uri: indUsageUri,
          range: findFieldRangeInText(indUsageText, 'com.example.app.R.string.app_name'),
        };
        assert.deepEqual(
          indRefs.map(locationToKey),
          [locationToKey(expectedIndRef)],
          'Independent module references must be isolated and return exact usage',
        );

        // 2. Qualifiers: values-es/strings.xml
        const esStringsPath = join(appDir, 'res', 'values-es', 'strings.xml');
        const esStringsText = await readFile(esStringsPath, 'utf8');
        const esStringsUri = pathToFileURL(esStringsPath).href;
        client.notify('textDocument/didOpen', {
          textDocument: { uri: esStringsUri, languageId: 'xml', version: 1, text: esStringsText },
        });

        const esDeclLoc: LspLocation = {
          uri: esStringsUri,
          range: findRangeInText(esStringsText, 'app_name'),
        };

        const esRefsNoDecl = normalizeLocations(
          await client.request('textDocument/references', {
            textDocument: { uri: esStringsUri },
            position: findPositionInText(esStringsText, 'app_name'),
            context: { includeDeclaration: false },
          }),
        );
        assert.deepEqual(
          new Set(esRefsNoDecl.map(locationToKey)),
          new Set(appRefs.map(locationToKey)),
          'Qualified declaration references with includeDeclaration false must match code references',
        );

        const esRefsWithDecl = normalizeLocations(
          await client.request('textDocument/references', {
            textDocument: { uri: esStringsUri },
            position: findPositionInText(esStringsText, 'app_name'),
            context: { includeDeclaration: true },
          }),
        );
        assert.ok(
          esRefsWithDecl.some((loc) => locationsEqual(loc, esDeclLoc)),
          'includeDeclaration: true on qualified declaration must include exact values-es declaration',
        );
        assert.ok(
          !esRefsWithDecl.some((loc) => normalizeUri(loc.uri) === normalizeUri(stringsUri)),
          'includeDeclaration: true on qualified declaration must NOT include default values declaration',
        );
      },
    );

    await t.test('References: explicit field command omp.findResourceFieldReferences', async () => {
      const rJarPath = join(
        projectDir,
        'app',
        'build',
        'intermediates',
        'compile_and_runtime_r_class_jar',
        'debug',
        'processDebugResources',
        'R.jar',
      );
      const rJarUri = pathToFileURL(rJarPath).href;

      // 1. Success with code references: origin.moduleName must match real module name
      const successCmd = (await client.request('workspace/executeCommand', {
        command: 'omp.findResourceFieldReferences',
        arguments: [
          {
            protocolVersion: 1,
            moduleName: appModuleName,
            namespace: 'com.example.app',
            type: 'string',
            name: 'hello_message',
            classOrigins: [rJarUri],
          },
        ],
      })) as {
        protocolVersion: number;
        fieldResolved: boolean;
        references: LspLocation[];
        origin: { moduleName: string; namespace: string; classOrigins: string[] };
      };

      assert.equal(successCmd.protocolVersion, 1);
      assert.equal(successCmd.fieldResolved, true);
      assert.ok(Array.isArray(successCmd.references) && successCmd.references.length === 2);
      assert.equal(successCmd.origin.moduleName, appModuleName);
      assert.equal(successCmd.origin.namespace, 'com.example.app');
      assert.ok(
        successCmd.origin.classOrigins.some((uri) => normalizeUri(uri) === normalizeUri(rJarUri)),
      );

      // 2. Legal zero code references: quoted_text
      const zeroCmd = (await client.request('workspace/executeCommand', {
        command: 'omp.findResourceFieldReferences',
        arguments: [
          {
            protocolVersion: 1,
            moduleName: appModuleName,
            namespace: 'com.example.app',
            type: 'string',
            name: 'quoted_text',
            classOrigins: [rJarUri],
          },
        ],
      })) as {
        protocolVersion: number;
        fieldResolved: boolean;
        references: LspLocation[];
      };
      assert.equal(zeroCmd.fieldResolved, true);
      assert.deepEqual(zeroCmd.references, []);

      // 3. Exact moduleName resolution on independent module
      const indRJarPath = join(
        projectDir,
        'independent',
        'build',
        'intermediates',
        'compile_r_class_jar',
        'debug',
        'generateDebugRFile',
        'R.jar',
      );
      const indRJarUri = pathToFileURL(indRJarPath).href;
      const indCmd = (await client.request('workspace/executeCommand', {
        command: 'omp.findResourceFieldReferences',
        arguments: [
          {
            protocolVersion: 1,
            moduleName: independentModuleName,
            namespace: 'com.example.app',
            type: 'string',
            name: 'app_name',
            classOrigins: [indRJarUri],
          },
        ],
      })) as {
        protocolVersion: number;
        fieldResolved: boolean;
        references: LspLocation[];
        origin: { moduleName: string };
      };
      assert.equal(indCmd.fieldResolved, true);
      assert.equal(indCmd.references.length, 1);
      assert.equal(indCmd.origin.moduleName, independentModuleName);
      assert.ok(indCmd.references[0].uri.includes('IndependentUsage.java'));

      // 4. Missing protocolVersion must return -32602 (illegal typed / missing param)
      await assert.rejects(
        () =>
          client.request('workspace/executeCommand', {
            command: 'omp.findResourceFieldReferences',
            arguments: [
              {
                moduleName: appModuleName,
                namespace: 'com.example.app',
                type: 'string',
                name: 'app_name',
                classOrigins: [rJarUri],
              },
            ],
          }),
        (err: Error) => err.message.includes('-32602'),
      );

      // 5. Incompatible numeric protocolVersion must return -32803 protocol_mismatch
      await assert.rejects(
        () =>
          client.request('workspace/executeCommand', {
            command: 'omp.findResourceFieldReferences',
            arguments: [
              {
                protocolVersion: 2,
                moduleName: appModuleName,
                namespace: 'com.example.app',
                type: 'string',
                name: 'app_name',
                classOrigins: [rJarUri],
              },
            ],
          }),
        (err: Error) => err.message.includes('-32803') && err.message.includes('protocol_mismatch'),
      );

      // 6. Invalid params (missing field, invalid classOrigins)
      await assert.rejects(
        () =>
          client.request('workspace/executeCommand', {
            command: 'omp.findResourceFieldReferences',
            arguments: [
              {
                protocolVersion: 1,
                moduleName: appModuleName,
                namespace: 'com.example.app',
                type: 'string',
                classOrigins: [],
              },
            ],
          }),
        (err: Error) => err.message.includes('-32602'),
      );

      // 7. Nonexistent module name rejected with model_unavailable (-32803), no fallback to namespace!
      await assert.rejects(
        () =>
          client.request('workspace/executeCommand', {
            command: 'omp.findResourceFieldReferences',
            arguments: [
              {
                protocolVersion: 1,
                moduleName: 'does-not-exist',
                namespace: 'com.example.app',
                type: 'string',
                name: 'app_name',
                classOrigins: [rJarUri],
              },
            ],
          }),
        (err: Error) => err.message.includes('-32803') && err.message.includes('model_unavailable'),
      );

      // 8. Namespace mismatch for module rejected
      await assert.rejects(
        () =>
          client.request('workspace/executeCommand', {
            command: 'omp.findResourceFieldReferences',
            arguments: [
              {
                protocolVersion: 1,
                moduleName: appModuleName,
                namespace: 'com.wrong.namespace',
                type: 'string',
                name: 'app_name',
                classOrigins: [rJarUri],
              },
            ],
          }),
        (err: Error) => err.message.includes('-32803') && err.message.includes('target_unresolved'),
      );

      // 9. Arbitrary unverified classOrigin rejected
      await assert.rejects(
        () =>
          client.request('workspace/executeCommand', {
            command: 'omp.findResourceFieldReferences',
            arguments: [
              {
                protocolVersion: 1,
                moduleName: appModuleName,
                namespace: 'com.example.app',
                type: 'string',
                name: 'app_name',
                classOrigins: [
                  pathToFileURL(join(projectDir, 'app', 'libs', 'no-sources.jar')).href,
                ],
              },
            ],
          }),
        (err: Error) => err.message.includes('-32803'),
      );
      await assert.rejects(
        () =>
          client.request('workspace/executeCommand', {
            command: 'omp.findResourceFieldReferences',
            arguments: [
              {
                protocolVersion: 1,
                moduleName: appModuleName,
                namespace: 'com.example.app',
                type: 'string',
                name: 'app_name',
                classOrigins: [
                  rJarUri,
                  pathToFileURL(join(projectDir, 'app', 'libs', 'no-sources.jar')).href,
                ],
              },
            ],
          }),
        (error: Error) => error.message.includes('-32803'),
      );
    });

    await t.test(
      'References: missing merger snapshot fails and recovers without reimport',
      async () => {
        const merger = join(
          projectDir,
          'app',
          'build',
          'intermediates',
          'incremental',
          'debug',
          'mergeDebugResources',
          'merger.xml',
        );
        const displaced = `${merger}.missing`;
        const query = () =>
          client.request('textDocument/references', {
            textDocument: { uri: stringsUri },
            position: findPositionInText(stringsText, 'hello_message'),
            context: { includeDeclaration: false },
          });
        await rename(merger, displaced);
        try {
          await assert.rejects(
            query,
            (error: Error) =>
              error.message.includes('-32803') && error.message.includes('missing_snapshot'),
          );
        } finally {
          await rename(displaced, merger);
        }
        const usage = join(appDir, 'java', 'com', 'example', 'app', 'ResourceUsageReference.kt');
        const expected = [
          {
            uri: mainActivityUri,
            range: findFieldRangeInText(mainActivityText, 'R.string.hello_message'),
          },
          {
            uri: pathToFileURL(usage).href,
            range: findFieldRangeInText(await readFile(usage, 'utf8'), 'ResString.hello_message'),
          },
        ];
        assert.deepEqual(
          new Set(normalizeLocations(await query()).map(locationToKey)),
          new Set(expected.map(locationToKey)),
        );
      },
    );

    await t.test('References: stale declaration rename and definition regression', async () => {
      let version = 80;
      const changeStrings = (text: string) =>
        client.notify('textDocument/didChange', {
          textDocument: { uri: stringsUri, version: version++ },
          contentChanges: [{ text }],
        });

      // 1. Uncompiled rename in editor causes references to fail with stale_snapshot
      try {
        changeStrings(stringsText.replace('name="app_name"', 'name="uncompiled_renamed_app_name"'));

        await assert.rejects(
          () =>
            client.request('textDocument/references', {
              textDocument: { uri: stringsUri },
              position: findPositionInText(
                stringsText.replace('name="app_name"', 'name="uncompiled_renamed_app_name"'),
                'uncompiled_renamed_app_name',
              ),
              context: { includeDeclaration: false },
            }),
          (err: Error) =>
            err.message.includes('-32803') &&
            (err.message.includes('stale_snapshot') || err.message.includes('field_not_found')),
        );

        // 2. Definition regression test: definition for app_name cleanly falls back to native R class
        const defPos = findPositionInText(mainActivityText, 'R.string.app_name');
        const nativeDef = normalizeLocations(
          await client.request('textDocument/definition', {
            textDocument: { uri: mainActivityUri },
            position: { line: defPos.line, character: defPos.character + 'R.string.'.length + 1 },
          }),
        );
        assert.equal(nativeDef.length, 1);
        assert.ok(nativeDef[0].uri.includes('/R.jar!/'));
      } finally {
        changeStrings(stringsText);
      }

      // Subsequent query on stabilized document must succeed with exact 2 references
      const subRefs = normalizeLocations(
        await client.request('textDocument/references', {
          textDocument: { uri: stringsUri },
          position: findPositionInText(stringsText, 'hello_message'),
          context: { includeDeclaration: false },
        }),
      );
      assert.equal(subRefs.length, 2, 'Subsequent query must return exact 2 references');
    });

    await t.test(
      'References: populated PSI search cancels, rejects concurrent use edits, and recovers',
      async () => {
        const probeUris: string[] = [];
        const probeContents = new Map<string, string>();
        const usagePath = join(
          appDir,
          'java',
          'com',
          'example',
          'app',
          'ResourceUsageReference.kt',
        );
        const usageText = await readFile(usagePath, 'utf8');
        const baseReferences: LspLocation[] = [
          {
            uri: mainActivityUri,
            range: findFieldRangeInText(mainActivityText, 'R.string.hello_message'),
          },
          {
            uri: pathToFileURL(usagePath).href,
            range: findFieldRangeInText(usageText, 'ResString.hello_message'),
          },
        ];
        const expectedReferences = [...baseReferences];
        for (let i = 0; i < 60; i++) {
          const uri = pathToFileURL(
            join(
              appDir,
              'java',
              'com',
              'example',
              'app',
              i === 0 ? 'Cancel Probe 雪.kt' : `CancelProbe${i}.kt`,
            ),
          ).href;
          const text = [
            'package com.example.app',
            `class CancelProbe${i} {`,
            '    fun useResources() {',
            ...Array.from(
              { length: 200 },
              (_, index) => `        val r${index} = R.string.hello_message`,
            ),
            '    }',
            '}',
          ].join('\n');
          probeUris.push(uri);
          probeContents.set(uri, text);
          for (let occurrence = 1; occurrence <= 200; occurrence++) {
            expectedReferences.push({
              uri,
              range: findFieldRangeInText(text, 'R.string.hello_message', occurrence),
            });
          }
          client.notify('textDocument/didOpen', {
            textDocument: { uri, languageId: 'kotlin', version: 1, text },
          });
        }
        const params = {
          textDocument: { uri: stringsUri },
          position: findPositionInText(stringsText, 'hello_message'),
          context: { includeDeclaration: false },
        };
        const keys = (references: LspLocation[]) => new Set(references.map(locationToKey));
        // The external JVM's PSI traversal cannot be advanced with fake JavaScript timers.
        const delay = async () => {
          const pending = Promise.withResolvers<void>();
          setTimeout(pending.resolve, 25);
          await pending.promise;
        };
        try {
          const baseline = normalizeLocations(
            await client.request('textDocument/references', params),
          );
          assert.deepEqual(
            keys(baseline),
            keys(expectedReferences),
            'Every in-memory usage must be indexed before cancellation',
          );
          const cancelledId = 88003;
          client.process.stdin?.write(
            encode({ jsonrpc: '2.0', id: cancelledId, method: 'textDocument/references', params }),
          );
          await delay();
          client.notify('$/cancelRequest', { id: cancelledId });
          const cancelled = await client.waitFor(
            (message) => message.id === cancelledId && !message.method,
            30000,
          );
          assert.equal(cancelled.error?.code, -32800, JSON.stringify(cancelled));

          const firstProbe = baseline.find((location) =>
            probeUris.some((uri) => normalizeUri(uri) === normalizeUri(location.uri)),
          );
          assert.ok(firstProbe);
          const changedUri = probeUris.find(
            (uri) => normalizeUri(uri) === normalizeUri(firstProbe.uri),
          );
          assert.ok(changedUri);
          const original = probeContents.get(changedUri);
          assert.ok(original);
          const removedLocation = locationToKey({
            uri: changedUri,
            range: findFieldRangeInText(original, 'R.string.hello_message'),
          });
          const changedId = 88004;
          client.process.stdin?.write(
            encode({ jsonrpc: '2.0', id: changedId, method: 'textDocument/references', params }),
          );
          await delay();
          client.notify('textDocument/didChange', {
            textDocument: { uri: changedUri, version: 2 },
            contentChanges: [
              { text: original.replace('R.string.hello_message', 'R.string.app_name') },
            ],
          });
          const modified = await client.waitFor(
            (message) => message.id === changedId && !message.method,
            30000,
          );
          assert.equal(
            modified.error?.code,
            -32801,
            'Concurrent use-document edits must invalidate the old search snapshot',
          );
          const afterChange = normalizeLocations(
            await client.request('textDocument/references', params),
          );
          assert.deepEqual(
            keys(afterChange),
            keys(
              expectedReferences.filter((location) => locationToKey(location) !== removedLocation),
            ),
          );
          client.notify('textDocument/didChange', {
            textDocument: { uri: changedUri, version: 3 },
            contentChanges: [{ text: original }],
          });
          const restored = normalizeLocations(
            await client.request('textDocument/references', params),
          );
          assert.deepEqual(keys(restored), keys(expectedReferences));
        } finally {
          for (const uri of probeUris)
            client.notify('textDocument/didClose', { textDocument: { uri } });
        }
        const recovered = normalizeLocations(
          await client.request('textDocument/references', params),
        );
        assert.deepEqual(keys(recovered), keys(baseReferences));
      },
    );

    await t.test(
      'Compose: suppress FunctionName inspection on Composable functions and preserve on regular functions',
      async () => {
        const probePath = join(appDir, 'java', 'com', 'example', 'app', 'ComposeProbe.kt');
        const probeUri = pathToFileURL(probePath).href;
        const probeText = [
          'package com.example.app',
          '',
          'import androidx.compose.runtime.Composable',
          'import androidx.compose.runtime.Composable as RenderUI',
          '',
          '@Composable',
          'fun ValidComposableFunction() {}',
          '',
          '@RenderUI',
          'fun AliasedComposableFunction() {}',
          '',
          '@androidx.compose.runtime.Composable',
          'fun FullyQualifiedComposableFunction() {}',
          '',
          'fun NormalBadUppercaseFunction() {}',
          '',
          'annotation class LocalFakeComposable',
          '@LocalFakeComposable',
          'fun FakeAnnotatedFunction() {}',
          '',
        ].join('\n');

        client.notify('textDocument/didOpen', {
          textDocument: { uri: probeUri, languageId: 'kotlin', version: 1, text: probeText },
        });

        try {
          const report = (await client.request('textDocument/diagnostic', {
            textDocument: { uri: probeUri },
          })) as { items?: Array<{ code?: string; message?: string; range: LspRange }> };

          const items = report?.items ?? [];
          const functionNameWarnings = items.filter(
            (d) =>
              d.code === 'FunctionName' ||
              d.message?.includes('should start with a lowercase letter') ||
              d.message?.includes('Function name'),
          );

          const probeLines = probeText.split('\n');
          const normalBadLine = probeLines.findIndex((l) =>
            l.includes('NormalBadUppercaseFunction'),
          );
          const fakeBadLine = probeLines.findIndex((l) => l.includes('FakeAnnotatedFunction'));
          const validLine = probeLines.findIndex((l) => l.includes('ValidComposableFunction'));
          const aliasedLine = probeLines.findIndex((l) => l.includes('AliasedComposableFunction'));
          const qualifiedLine = probeLines.findIndex((l) =>
            l.includes('FullyQualifiedComposableFunction'),
          );

          const badLines = functionNameWarnings.map((d) => d.range.start.line);

          assert.ok(
            badLines.includes(normalBadLine),
            'NormalBadUppercaseFunction must report FunctionName warning',
          );
          assert.ok(
            badLines.includes(fakeBadLine),
            'FakeAnnotatedFunction must report FunctionName warning',
          );

          assert.ok(
            !badLines.includes(validLine),
            'ValidComposableFunction FunctionName warning must be suppressed',
          );
          assert.ok(
            !badLines.includes(aliasedLine),
            'AliasedComposableFunction FunctionName warning must be suppressed',
          );
          assert.ok(
            !badLines.includes(qualifiedLine),
            'FullyQualifiedComposableFunction FunctionName warning must be suppressed',
          );
        } finally {
          client.notify('textDocument/didClose', { textDocument: { uri: probeUri } });
        }
      },
    );
  } finally {
    if (flatDriver) {
      try {
        await (flatDriver as LspClientDriver).close();
      } catch {
        // Ignore driver close failure during cleanup
      }
    }
    if (driver) {
      try {
        await driver.close();
      } catch {
        // Ignore driver close failure during cleanup
      }
    }
    await sandbox.cleanup();
  }
});
