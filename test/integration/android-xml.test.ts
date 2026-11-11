import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { executeIntellij } from '../../src/extension/intellij-tool.js';
import type { ExtensionContext } from '../../src/shared/extension-types.js';
import { encode } from '../../src/shared/protocol.js';
import {
  copyCachedDependencies,
  createIntegrationSandbox,
  createLspClientDriver,
  type IntegrationSandbox,
  type LspClientDriver,
  seedSandboxProjectConfig,
  verifyPrerequisites,
} from './fixture.js';

const INITIAL_GRADLE_USER_HOME = process.env.GRADLE_USER_HOME;
const prereqs = await verifyPrerequisites();

interface LspPosition {
  line: number;
  character: number;
}

interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

interface LspDiagnostic {
  range: LspRange;
  severity?: number;
  code?: string | number;
  source?: string;
  message?: string;
  data?: unknown;
}

interface LspDiagnosticReport {
  kind: string;
  resultId?: string;
  items?: LspDiagnostic[];
}

interface LspInitializeResult {
  capabilities?: {
    diagnosticProvider?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface InitializedLspClientDriver extends LspClientDriver {
  initResult?: LspInitializeResult;
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

  await copyCachedDependencies(sandbox);

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
      '--daemon',
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

  await seedSandboxProjectConfig(targetDir, sandbox);
  return targetDir;
}
async function startLspClient(
  projectDir: string,
  sandbox: IntegrationSandbox,
  options?: { hierarchicalDocumentSymbolSupport?: boolean },
): Promise<InitializedLspClientDriver> {
  const rawDriver = createLspClientDriver(projectDir, sandbox);
  const driver = Object.assign(rawDriver, {
    initResult: undefined as LspInitializeResult | undefined,
  });
  const hierarchical = options?.hierarchicalDocumentSymbolSupport ?? true;
  const initResult = (await driver.request('initialize', {
    processId: process.pid,
    rootUri: pathToFileURL(projectDir).href,
    rootPath: projectDir,
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
  })) as LspInitializeResult;
  driver.initResult = initResult;
  driver.notify('initialized', {});
  return driver;
}

test('Android XML symbols and manifest references integration', async (t) => {
  const sandbox = await createIntegrationSandbox(prereqs);
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

const GLOBAL_GRADLE_USER_HOME =
  process.env.OMP_INTELLIJ_TEST_GRADLE_CACHE ||
  INITIAL_GRADLE_USER_HOME ||
  join(homedir(), '.gradle');

async function pullDiagnostics(
  client: LspClientDriver,
  uri: string,
  timeoutMs = 30000,
): Promise<LspDiagnosticReport> {
  const report = (await client.request(
    'textDocument/diagnostic',
    { textDocument: { uri } },
    timeoutMs,
  )) as LspDiagnosticReport;
  return report;
}

async function findComposeRuntimeAar(gradleCacheDir: string): Promise<string> {
  const dir = join(
    gradleCacheDir,
    'caches',
    'modules-2',
    'files-2.1',
    'androidx.compose.runtime',
    'runtime-android',
    '1.13.0-alpha01',
  );
  if (existsSync(dir)) {
    const subdirs = await readdir(dir);
    for (const sub of subdirs) {
      const aarPath = join(dir, sub, 'runtime.aar');
      if (existsSync(aarPath)) return aarPath;
    }
  }
  throw new Error(`Prerequisite Compose runtime.aar (1.13.0-alpha01) not found under ${dir}`);
}

async function findLintApiJar(gradleCacheDir: string): Promise<string> {
  const dir = join(
    gradleCacheDir,
    'caches',
    'modules-2',
    'files-2.1',
    'com.android.tools.lint',
    'lint-api',
    '32.4.1',
  );
  if (existsSync(dir)) {
    const subdirs = await readdir(dir);
    for (const sub of subdirs) {
      const jarPath = join(dir, sub, 'lint-api-32.4.1.jar');
      if (existsSync(jarPath)) return jarPath;
    }
  }
  throw new Error(`Prerequisite lint-api-32.4.1.jar not found under ${dir}`);
}

async function findCommonJar(gradleCacheDir: string): Promise<string> {
  const dir = join(
    gradleCacheDir,
    'caches',
    'modules-2',
    'files-2.1',
    'com.android.tools',
    'common',
    '32.4.1',
  );
  if (existsSync(dir)) {
    const subdirs = await readdir(dir);
    for (const sub of subdirs) {
      const jarPath = join(dir, sub, 'common-32.4.1.jar');
      if (existsSync(jarPath)) return jarPath;
    }
  }
  throw new Error(`Prerequisite common-32.4.1.jar not found under ${dir}`);
}

async function findSdkCommonJar(gradleCacheDir: string): Promise<string> {
  const dir = join(
    gradleCacheDir,
    'caches',
    'modules-2',
    'files-2.1',
    'com.android.tools',
    'sdk-common',
    '32.4.1',
  );
  if (existsSync(dir)) {
    const subdirs = await readdir(dir);
    for (const sub of subdirs) {
      const jarPath = join(dir, sub, 'sdk-common-32.4.1.jar');
      if (existsSync(jarPath)) return jarPath;
    }
  }
  throw new Error(`Prerequisite sdk-common-32.4.1.jar not found under ${dir}`);
}

async function findLayoutlibApiJar(gradleCacheDir: string): Promise<string> {
  const dir = join(
    gradleCacheDir,
    'caches',
    'modules-2',
    'files-2.1',
    'com.android.tools.layoutlib',
    'layoutlib-api',
    '32.4.1',
  );
  if (existsSync(dir)) {
    const subdirs = await readdir(dir);
    for (const sub of subdirs) {
      const jarPath = join(dir, sub, 'layoutlib-api-32.4.1.jar');
      if (existsSync(jarPath)) return jarPath;
    }
  }
  throw new Error(`Prerequisite layoutlib-api-32.4.1.jar not found under ${dir}`);
}

async function findGuavaJar(gradleCacheDir: string): Promise<string> {
  const dir = join(gradleCacheDir, 'caches', 'modules-2', 'files-2.1', 'com.google.guava', 'guava');
  if (existsSync(dir)) {
    const versions = await readdir(dir);
    for (const v of versions) {
      const vDir = join(dir, v);
      const subdirs = await readdir(vDir);
      for (const sub of subdirs) {
        const jarPath = join(vDir, sub, `guava-${v}.jar`);
        if (existsSync(jarPath)) return jarPath;
      }
    }
  }
  throw new Error(`Prerequisite guava jar not found under ${dir}`);
}

async function createCustomExternalAar(
  sandbox: IntegrationSandbox,
  lintApiJar: string,
  commonJar: string,
  sdkCommonJar: string,
  layoutlibApiJar: string,
  guavaJar: string,
  targetAarPath: string,
): Promise<void> {
  const staging = join(sandbox.sandboxDir, 'custom-external-staging');
  const classesStaging = join(staging, 'classes-staging');
  const lintStaging = join(staging, 'lint-staging');
  const aarContent = join(staging, 'aar-content');

  await mkdir(classesStaging, { recursive: true });
  await mkdir(lintStaging, { recursive: true });
  await mkdir(aarContent, { recursive: true });

  const javac = join(
    sandbox.prerequisites.jdk21Path,
    'bin',
    process.platform === 'win32' ? 'javac.exe' : 'javac',
  );
  const jar = join(
    sandbox.prerequisites.jdk21Path,
    'bin',
    process.platform === 'win32' ? 'jar.exe' : 'jar',
  );

  const dummySrc = join(staging, 'ExternalDummy.java');
  await writeFile(
    dummySrc,
    'package com.example.external; public final class ExternalDummy {}\n',
    'utf8',
  );
  spawnSync(javac, ['-d', classesStaging, dummySrc], { encoding: 'utf8' });
  const classesJar = join(aarContent, 'classes.jar');
  spawnSync(jar, ['--create', '--file', classesJar, '-C', classesStaging, '.'], {
    encoding: 'utf8',
  });

  const detectorSrc = join(staging, 'CustomExternalDetector.java');
  await writeFile(
    detectorSrc,
    [
      'package com.example.external;',
      'import com.android.tools.lint.client.api.IssueRegistry;',
      'import com.android.tools.lint.client.api.Vendor;',
      'import com.android.tools.lint.detector.api.*;',
      'import java.util.Collections;',
      'import java.util.List;',
      'public class CustomExternalDetector extends Detector implements SourceCodeScanner {',
      '    private static final java.util.concurrent.atomic.AtomicInteger RUNS = new java.util.concurrent.atomic.AtomicInteger();',
      '    public static final Issue ISSUE = Issue.create(',
      '        "CustomExternalRule",',
      '        "Custom external rule description",',
      '        "Explanation of custom external rule",',
      '        Category.CORRECTNESS,',
      '        5,',
      '        Severity.WARNING,',
      '        new Implementation(CustomExternalDetector.class, Scope.JAVA_FILE_SCOPE)',
      '    );',
      '    @Override',
      '    public void beforeCheckFile(Context context) {',
      '        CharSequence contents = context.getContents();',
      '        if (contents != null && contents.toString().contains("triggerCustomExternalRule")) {',
      '            int offset = contents.toString().indexOf("triggerCustomExternalRule");',
      '            Location loc = Location.create(context.file, new DefaultPosition(0, 0, offset), new DefaultPosition(0, 26, offset + 26));',
      '            context.report(ISSUE, loc, "Custom external rule run " + RUNS.incrementAndGet());',
      '        }',
      '    }',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );

  const xmlDetectorSrc = join(staging, 'CustomXmlDetector.java');
  await writeFile(
    xmlDetectorSrc,
    [
      'package com.example.external;',
      'import com.android.tools.lint.client.api.ResourceRepositoryScope;',
      'import com.android.tools.lint.detector.api.*;',
      'import com.android.ide.common.resources.ResourceRepository;',
      'import com.android.ide.common.resources.ResourceItem;',
      'import com.android.ide.common.rendering.api.ResourceNamespace;',
      'import com.android.ide.common.rendering.api.ResourceValue;',
      'import com.android.resources.ResourceType;',
      'import org.w3c.dom.Element;',
      'import java.util.*;',
      'public class CustomXmlDetector extends Detector implements XmlScanner {',
      '    private static final java.util.concurrent.atomic.AtomicLong visits = new java.util.concurrent.atomic.AtomicLong();',
      '    public static final Issue ISSUE = Issue.create(',
      '        "CustomXmlRule",',
      '        "Custom XML rule description",',
      '        "Explanation of custom XML rule",',
      '        Category.CORRECTNESS,',
      '        5,',
      '        Severity.WARNING,',
      '        new Implementation(CustomXmlDetector.class, Scope.RESOURCE_FILE_SCOPE)',
      '    );',
      '    @Override',
      '    public Collection<String> getApplicableElements() {',
      '        return Arrays.asList("CustomXmlView", "CustomRepoQueryView");',
      '    }',
      '    @Override',
      '    public void visitElement(XmlContext context, Element element) {',
      '        String tag = element.getTagName();',
      '        if ("CustomRepoQueryView".equals(tag)) {',
      '            try {',
      '                ResourceRepository projectRepo = context.getClient().getResources(context.getProject(), ResourceRepositoryScope.PROJECT_ONLY);',
      '                ResourceRepository localRepo = context.getClient().getResources(context.getProject(), ResourceRepositoryScope.LOCAL_DEPENDENCIES);',
      '                ResourceRepository allRepo = context.getClient().getResources(context.getProject(), ResourceRepositoryScope.ALL_DEPENDENCIES);',
      '                ResourceRepository androidRepo = context.getClient().getResources(context.getProject(), ResourceRepositoryScope.ANDROID);',
      '                List<ResourceItem> appNameItems = projectRepo != null ? projectRepo.getResources(ResourceNamespace.RES_AUTO, ResourceType.STRING, "app_name") : Collections.<ResourceItem>emptyList();',
      '                String appNameVal = !appNameItems.isEmpty() ? appNameItems.get(0).getResourceValue().getValue() : "missing";',
      '                List<ResourceItem> projLibItems = projectRepo != null ? projectRepo.getResources(ResourceNamespace.RES_AUTO, ResourceType.STRING, "lib_name") : Collections.<ResourceItem>emptyList();',
      '                boolean projHasLib = !projLibItems.isEmpty();',
      '                List<ResourceItem> localLibItems = localRepo != null ? localRepo.getResources(ResourceNamespace.RES_AUTO, ResourceType.STRING, "lib_name") : Collections.<ResourceItem>emptyList();',
      '                String libNameVal = !localLibItems.isEmpty() ? localLibItems.get(0).getResourceValue().getValue() : "missing";',
      '                List<ResourceItem> okItems = androidRepo != null ? androidRepo.getResources(ResourceNamespace.ANDROID, ResourceType.STRING, "ok") : Collections.<ResourceItem>emptyList();',
      '                boolean hasOk = !okItems.isEmpty();',
      '                String msg = "CustomRepoQuery: app_name=" + appNameVal + "; projHasLib=" + projHasLib + "; lib_name=" + libNameVal + "; hasOk=" + hasOk + "; count=" + appNameItems.size();',
      '                Location loc = context.getElementLocation(element);',
      '                context.report(ISSUE, loc, msg);',
      '            } catch (Throwable t) {',
      '                Location loc = context.getElementLocation(element);',
      '                context.report(ISSUE, loc, "CustomRepoQuery error: " + t.getMessage());',
      '            }',
      '        } else {',
      '            Location loc = context.getElementLocation(element);',
      '            context.report(ISSUE, loc, "Custom XML rule triggered on " + tag + "; visit=" + visits.incrementAndGet());',
      '        }',
      '    }',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );

  const manifestDetectorSrc = join(staging, 'CustomManifestDetector.java');
  await writeFile(
    manifestDetectorSrc,
    [
      'package com.example.external;',
      'import com.android.tools.lint.client.api.LintClient;',
      'import com.android.tools.lint.detector.api.*;',
      'import org.w3c.dom.*;',
      'import java.util.*;',
      'public class CustomManifestDetector extends Detector implements XmlScanner {',
      '  public static final Issue ISSUE = Issue.create("CustomManifestRule", "Manifest source mapping",',
      '      "Reports the merged label through its original source location.", Category.CORRECTNESS, 5,',
      '      Severity.WARNING, new Implementation(CustomManifestDetector.class, Scope.MANIFEST_SCOPE));',
      '  public Collection<String> getApplicableElements() { return Collections.singleton("application"); }',
      '  public void visitElement(XmlContext context, Element source) {',
      '    Document merged = context.getClient().getMergedManifest(context.getProject());',
      '    if (merged == null) return;',
      '    NodeList apps = merged.getElementsByTagName("application");',
      '    if (apps.getLength() == 0) return;',
      '    Attr label = ((Element) apps.item(0)).getAttributeNodeNS("http://schemas.android.com/apk/res/android", "label");',
      '    if (label == null) return;',
      '    boolean built = merged.getUserData(LintClient.MERGED_MANIFEST) != null;',
      '    Location location = context.getLocation(label);',
      '    context.report(ISSUE, label, location, "ManifestSnapshot: merged=" + built + "; label=" + label.getValue());',
      '  }',
      '}',
    ].join('\n'),
    'utf8',
  );

  const registrySrc = join(staging, 'CustomExternalIssueRegistry.java');
  await writeFile(
    registrySrc,
    [
      'package com.example.external;',
      'import com.android.tools.lint.client.api.IssueRegistry;',
      'import com.android.tools.lint.client.api.Vendor;',
      'import com.android.tools.lint.detector.api.Issue;',
      'import java.util.Arrays;',
      'import java.util.List;',
      'public class CustomExternalIssueRegistry extends IssueRegistry {',
      '    @Override',
      '    public List<Issue> getIssues() {',
      '        return Arrays.asList(CustomExternalDetector.ISSUE, CustomXmlDetector.ISSUE, CustomManifestDetector.ISSUE);',
      '    }',
      '    @Override',
      '    public int getApi() { return 16; }',
      '    @Override',
      '    public int getMinApi() { return 14; }',
      '    @Override',
      '    public Vendor getVendor() {',
      '        return new Vendor("External Vendor", "com.example.external", null, null);',
      '    }',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );

  const cp = [lintApiJar, commonJar, sdkCommonJar, layoutlibApiJar, guavaJar].join(
    process.platform === 'win32' ? ';' : ':',
  );
  const compileRes = spawnSync(
    javac,
    ['-cp', cp, '-d', lintStaging, detectorSrc, xmlDetectorSrc, manifestDetectorSrc, registrySrc],
    { encoding: 'utf8' },
  );
  assert.equal(compileRes.status, 0, `compileCustomExternal: ${compileRes.stderr}`);

  const servicesDir = join(lintStaging, 'META-INF', 'services');
  await mkdir(servicesDir, { recursive: true });
  await writeFile(
    join(servicesDir, 'com.android.tools.lint.client.api.IssueRegistry'),
    'com.example.external.CustomExternalIssueRegistry\n',
    'utf8',
  );

  const lintJar = join(aarContent, 'lint.jar');
  spawnSync(jar, ['--create', '--file', lintJar, '-C', lintStaging, '.'], { encoding: 'utf8' });

  await writeFile(
    join(aarContent, 'AndroidManifest.xml'),
    '<?xml version="1.0" encoding="utf-8"?><manifest package="com.example.external"/>\n',
    'utf8',
  );

  await mkdir(join(targetAarPath, '..'), { recursive: true });
  spawnSync(jar, ['--create', '--file', targetAarPath, '-C', aarContent, '.'], {
    encoding: 'utf8',
  });
}

async function createCorruptedAar(
  sandbox: IntegrationSandbox,
  lintApiJar: string,
  commonJar: string,
  targetAarPath: string,
): Promise<void> {
  const staging = join(sandbox.sandboxDir, 'corrupt-aar-staging');
  const classesStaging = join(staging, 'classes-staging');
  const lintStaging = join(staging, 'lint-staging');
  const aarContent = join(staging, 'aar-content');

  await mkdir(classesStaging, { recursive: true });
  await mkdir(lintStaging, { recursive: true });
  await mkdir(aarContent, { recursive: true });

  const javac = join(
    sandbox.prerequisites.jdk21Path,
    'bin',
    process.platform === 'win32' ? 'javac.exe' : 'javac',
  );
  const jar = join(
    sandbox.prerequisites.jdk21Path,
    'bin',
    process.platform === 'win32' ? 'jar.exe' : 'jar',
  );

  const dummySrc = join(staging, 'Dummy.java');
  await writeFile(dummySrc, 'package com.example.corrupt; public final class Dummy {}\n', 'utf8');
  spawnSync(javac, ['-d', classesStaging, dummySrc], { encoding: 'utf8' });
  const classesJar = join(aarContent, 'classes.jar');
  spawnSync(jar, ['--create', '--file', classesJar, '-C', classesStaging, '.'], {
    encoding: 'utf8',
  });

  // 1. CorruptConstructorIssueRegistry (loading phase LinkageError)
  const corruptConstructorSrc = join(staging, 'CorruptConstructorIssueRegistry.java');
  await writeFile(
    corruptConstructorSrc,
    [
      'package com.example.corrupt;',
      'import com.android.tools.lint.client.api.IssueRegistry;',
      'import com.android.tools.lint.detector.api.Issue;',
      'import java.util.Collections;',
      'import java.util.List;',
      'public class CorruptConstructorIssueRegistry extends IssueRegistry {',
      '    public CorruptConstructorIssueRegistry() {',
      '        throw new NoSuchMethodError("Simulated corrupt rule linkage failure in constructor");',
      '    }',
      '    @Override',
      '    public List<Issue> getIssues() { return Collections.emptyList(); }',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );

  // 2. CorruptExecutionIssueRegistry & Detector (execution phase LinkageError)
  const corruptExecutionSrc = join(staging, 'CorruptExecutionIssueRegistry.java');
  await writeFile(
    corruptExecutionSrc,
    [
      'package com.example.corrupt;',
      'import com.android.tools.lint.client.api.IssueRegistry;',
      'import com.android.tools.lint.detector.api.*;',
      'import java.util.Collections;',
      'import java.util.List;',
      'public class CorruptExecutionIssueRegistry extends IssueRegistry {',
      '    public static final Issue ISSUE = Issue.create(',
      '        "CorruptExecutionRule",',
      '        "Corrupt execution rule",',
      '        "Explanation",',
      '        Category.CORRECTNESS,',
      '        5,',
      '        Severity.ERROR,',
      '        new Implementation(CorruptExecutionDetector.class, Scope.JAVA_FILE_SCOPE)',
      '    );',
      '    public static class CorruptExecutionDetector extends Detector implements SourceCodeScanner {',
      '        @Override',
      '        public void beforeCheckFile(Context context) {',
      '            CharSequence contents = context.getContents();',
      '            if (contents != null && contents.toString().contains("triggerCorruptExecutionError")) {',
      '                throw new NoSuchMethodError("Simulated corrupt detector analyze linkage failure");',
      '            }',
      '        }',
      '    }',
      '    @Override',
      '    public List<Issue> getIssues() { return Collections.singletonList(ISSUE); }',
      '    @Override',
      '    public int getApi() { return 16; }',
      '    @Override',
      '    public int getMinApi() { return 14; }',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );

  // 3. CorruptXmlNodeIssueRegistry & CorruptXmlNodeDetector (node visit linkage error)
  const corruptXmlSrc = join(staging, 'CorruptXmlNodeIssueRegistry.java');
  await writeFile(
    corruptXmlSrc,
    [
      'package com.example.corrupt;',
      'import com.android.tools.lint.client.api.IssueRegistry;',
      'import com.android.tools.lint.detector.api.*;',
      'import org.w3c.dom.Element;',
      'import java.util.Collections;',
      'import java.util.List;',
      'import java.util.Collection;',
      'public class CorruptXmlNodeIssueRegistry extends IssueRegistry {',
      '    public static final Issue ISSUE = Issue.create(',
      '        "CorruptXmlNodeRule",',
      '        "Corrupt XML node rule",',
      '        "Explanation",',
      '        Category.CORRECTNESS,',
      '        5,',
      '        Severity.ERROR,',
      '        new Implementation(CorruptXmlNodeDetector.class, Scope.RESOURCE_FILE_SCOPE)',
      '    );',
      '    public static class CorruptXmlNodeDetector extends Detector implements XmlScanner {',
      '        @Override',
      '        public Collection<String> getApplicableElements() {',
      '            return Collections.singletonList("CorruptXmlNode");',
      '        }',
      '        @Override',
      '        public void visitElement(XmlContext context, Element element) {',
      '            if (element.hasAttribute("triggerNodeFault")) {',
      '                throw new NoSuchMethodError("Simulated corrupt detector node visit linkage failure");',
      '            }',
      '        }',
      '    }',
      '    @Override',
      '    public List<Issue> getIssues() { return Collections.singletonList(ISSUE); }',
      '    @Override',
      '    public int getApi() { return 16; }',
      '    @Override',
      '    public int getMinApi() { return 14; }',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );

  const cp = [lintApiJar, commonJar].join(process.platform === 'win32' ? ';' : ':');
  const compileCorrupt = spawnSync(
    javac,
    ['-cp', cp, '-d', lintStaging, corruptConstructorSrc, corruptExecutionSrc, corruptXmlSrc],
    { encoding: 'utf8' },
  );
  assert.equal(compileCorrupt.status, 0, `compileCorrupt: ${compileCorrupt.stderr}`);

  const servicesDir = join(lintStaging, 'META-INF', 'services');
  await mkdir(servicesDir, { recursive: true });
  await writeFile(
    join(servicesDir, 'com.android.tools.lint.client.api.IssueRegistry'),
    'com.example.corrupt.CorruptConstructorIssueRegistry\ncom.example.corrupt.CorruptExecutionIssueRegistry\ncom.example.corrupt.CorruptXmlNodeIssueRegistry\n',
    'utf8',
  );

  const lintJar = join(aarContent, 'lint.jar');
  spawnSync(jar, ['--create', '--file', lintJar, '-C', lintStaging, '.'], { encoding: 'utf8' });

  await writeFile(
    join(aarContent, 'AndroidManifest.xml'),
    '<?xml version="1.0" encoding="utf-8"?><manifest package="com.example.corrupt"/>\n',
    'utf8',
  );

  await mkdir(join(targetAarPath, '..'), { recursive: true });
  spawnSync(jar, ['--create', '--file', targetAarPath, '-C', aarContent, '.'], {
    encoding: 'utf8',
  });
}

async function copyAndroidLintFixture(sandbox: IntegrationSandbox): Promise<string> {
  const sourceDir = resolve('test-fixtures', 'android-xml');
  const targetDir = join(sandbox.workspacesDir, 'android-lint');
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
    'android.useAndroidX=true',
    'android.nonTransitiveRClass=true',
    '',
  ].join('\n');
  await writeFile(join(targetDir, 'gradle.properties'), gradleProps, 'utf8');

  await copyCachedDependencies(sandbox);

  const wrapperJarSrc = resolve(
    'test-fixtures',
    'gradle-execution',
    'gradle',
    'wrapper',
    'gradle-wrapper.jar',
  );
  const targetWrapperDir = join(targetDir, 'gradle', 'wrapper');
  await cp(wrapperJarSrc, join(targetWrapperDir, 'gradle-wrapper.jar'));

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

  // Deterministic artifact discovery
  const composeAarSrc = await findComposeRuntimeAar(GLOBAL_GRADLE_USER_HOME);
  await cp(composeAarSrc, join(targetDir, 'app', 'libs', 'compose-runtime.aar'));

  const lintApiJar = await findLintApiJar(GLOBAL_GRADLE_USER_HOME);
  const commonJar = await findCommonJar(GLOBAL_GRADLE_USER_HOME);
  const sdkCommonJar = await findSdkCommonJar(GLOBAL_GRADLE_USER_HOME);
  const layoutlibApiJar = await findLayoutlibApiJar(GLOBAL_GRADLE_USER_HOME);
  const guavaJar = await findGuavaJar(GLOBAL_GRADLE_USER_HOME);

  // Real non-AndroidX custom rule AAR
  await createCustomExternalAar(
    sandbox,
    lintApiJar,
    commonJar,
    sdkCommonJar,
    layoutlibApiJar,
    guavaJar,
    join(targetDir, 'app', 'libs', 'custom-external.aar'),
  );

  // Synthetic fault injection AAR (both constructor and execution linkage errors)
  await createCorruptedAar(
    sandbox,
    lintApiJar,
    commonJar,
    join(targetDir, 'app', 'libs', 'corrupt-rule.aar'),
  );

  // Update app/build.gradle.kts: minSdk = 21, include *.aar
  const appBuildGradle = join(targetDir, 'app', 'build.gradle.kts');
  let buildContent = await readFile(appBuildGradle, 'utf8');
  buildContent = buildContent.replace('listOf("*.jar")', 'listOf("*.jar", "*.aar")');
  buildContent = buildContent.replace('minSdk = 26', 'minSdk = 21');
  await writeFile(appBuildGradle, buildContent, 'utf8');
  for (const name of ['lib', 'core']) {
    const script = join(targetDir, name, 'build.gradle.kts');
    await writeFile(script, (await readFile(script, 'utf8')).replace('minSdk = 26', 'minSdk = 21'));
  }

  // Update app/config/manifest-main.xml to avoid manifest merger minSdk conflict with Compose AAR
  const manifestPath = join(targetDir, 'app', 'config', 'manifest-main.xml');
  let manifestContent = await readFile(manifestPath, 'utf8');
  manifestContent = manifestContent.replace(
    'xmlns:android="http://schemas.android.com/apk/res/android"',
    'xmlns:android="http://schemas.android.com/apk/res/android"\n    xmlns:tools="http://schemas.android.com/tools"',
  );
  manifestContent = manifestContent.replace(
    '<application',
    '<uses-sdk tools:overrideLibrary="androidx.compose.runtime,com.example.external,com.example.corrupt"/>\n    <application',
  );
  await writeFile(manifestPath, manifestContent, 'utf8');

  // Pre-create real placeholder source files for all probes so StandardFileSystems and findModule recognize them
  const appSrc = join(targetDir, 'app', 'src', 'main', 'java', 'com', 'example', 'app');
  await mkdir(appSrc, { recursive: true });
  const probePlaceholders: Record<string, string> = {
    'CoexistActivity.java':
      'package com.example.app;\npublic class CoexistActivity extends android.app.Activity {}\n',
    'CoexistKt.kt': 'package com.example.app\nclass CoexistKt\n',
    'MatrixJavaActivity.java':
      'package com.example.app;\npublic class MatrixJavaActivity extends android.app.Activity {}\n',
    'MatrixKotlin.kt': 'package com.example.app\nclass MatrixKotlin\n',
    'ComposeLintProbe.kt': 'package com.example.app\nclass ComposeLintProbe\n',
    'ModelTransitionActivity.java':
      'package com.example.app;\npublic class ModelTransitionActivity extends android.app.Activity {}\n',
    'LintXmlOverrideActivity.java':
      'package com.example.app;\npublic class LintXmlOverrideActivity extends android.app.Activity {}\n',
    'CorruptIsolationProbe.kt': 'package com.example.app\nclass CorruptIsolationProbe\n',
    'CacheCancelProbe.java':
      'package com.example.app;\npublic class CacheCancelProbe extends android.app.Activity {}\n',
    'CustomExternalProbe.java':
      'package com.example.app;\npublic class CustomExternalProbe extends android.app.Activity {}\n',
  };
  for (const [name, content] of Object.entries(probePlaceholders)) {
    await writeFile(join(appSrc, name), content, 'utf8');
  }

  const javaExe = join(
    sandbox.prerequisites.jdk21Path,
    'bin',
    process.platform === 'win32' ? 'java.exe' : 'java',
  );
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
      '--daemon',
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

  // Post-build XML fixture probe files
  const resDir = join(targetDir, 'app', 'src', 'main', 'res');
  await mkdir(join(resDir, 'layout'), { recursive: true });
  await mkdir(join(resDir, 'layout-v26'), { recursive: true });
  await mkdir(join(resDir, 'menu'), { recursive: true });
  await mkdir(join(targetDir, 'app', 'src', 'debug'), { recursive: true });

  await writeFile(
    join(resDir, 'layout', 'layout_probe.xml'),
    [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"',
      '    android:layout_width="match_parent"',
      '    android:layout_height="match_parent"',
      '    android:orientation="vertical">',
      '    <TextView',
      '        android:layout_width="wrap_content"',
      '        android:layout_height="wrap_content"',
      '        android:text="Hardcoded String Text" />',
      '</LinearLayout>',
      '',
    ].join('\n'),
    'utf8',
  );

  await writeFile(
    join(resDir, 'layout', 'layout_image_probe.xml'),
    [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"',
      '    android:layout_width="match_parent"',
      '    android:layout_height="match_parent">',
      '    <ImageView',
      '        android:layout_width="wrap_content"',
      '        android:layout_height="wrap_content"',
      '        android:src="@drawable/reference_drawable" />',
      '</LinearLayout>',
      '',
    ].join('\n'),
    'utf8',
  );

  await writeFile(
    join(resDir, 'layout', 'layout_ignore_probe.xml'),
    [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"',
      '    xmlns:t="http://schemas.android.com/tools"',
      '    android:layout_width="match_parent"',
      '    android:layout_height="match_parent"',
      '    android:orientation="vertical">',
      '    <TextView',
      '        t:ignore="HardcodedText"',
      '        android:layout_width="wrap_content"',
      '        android:layout_height="wrap_content"',
      '        android:text="Ignored Hardcoded Text" />',
      '    <TextView',
      '        android:layout_width="wrap_content"',
      '        android:layout_height="wrap_content"',
      '        android:text="Not Ignored Sibling Text" />',
      '    <LinearLayout',
      '        t:ignore="HardcodedText,ContentDescription"',
      '        android:layout_width="wrap_content"',
      '        android:layout_height="wrap_content">',
      '        <TextView',
      '            android:layout_width="wrap_content"',
      '            android:layout_height="wrap_content"',
      '            android:text="Ancestor Ignored Text" />',
      '        <ImageView',
      '            android:layout_width="wrap_content"',
      '            android:layout_height="wrap_content"',
      '            android:src="@drawable/reference_drawable" />',
      '    </LinearLayout>',
      '</LinearLayout>',
      '',
    ].join('\n'),
    'utf8',
  );

  await writeFile(
    join(resDir, 'layout', 'layout_edge_probe.xml'),
    [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"',
      '    xmlns:customalias="http://schemas.android.com/apk/res/android"',
      '    android:layout_width="match_parent"',
      '    android:layout_height="match_parent"',
      '    android:orientation="vertical">',
      '    <TextView',
      '        android:layout_width="wrap_content"',
      '        android:layout_height="wrap_content"',
      '        android:text="Emoji 👋 probe 🎉" />',
      '    <TextView',
      '        android:layout_width="wrap_content"',
      '        android:layout_height="wrap_content"',
      '        android:text="Entity &amp; &lt; test" />',
      '    <TextView',
      '        android:layout_width="wrap_content"',
      '        android:layout_height="wrap_content"',
      "        android:text='Single quote hardcoded' />",
      '    <TextView',
      '        android:layout_width="wrap_content"',
      '        android:layout_height="wrap_content"',
      '        android:text="Multi\nLine\nHardcoded" />',
      '    <TextView',
      '        customalias:text="Alias Hardcoded Text"',
      '        android:layout_width="wrap_content"',
      '        android:layout_height="wrap_content" />',
      '</LinearLayout>',
      '',
    ].join('\n'),
    'utf8',
  );

  await writeFile(
    join(resDir, 'layout', 'layout_api_probe.xml'),
    [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"',
      '    xmlns:tools="http://schemas.android.com/tools"',
      '    android:layout_width="match_parent"',
      '    android:layout_height="match_parent">',
      '    <TextView',
      '        android:layout_width="wrap_content"',
      '        android:layout_height="wrap_content"',
      '        android:tooltipText="Tooltip Text" />',
      '</LinearLayout>',
      '',
    ].join('\n'),
    'utf8',
  );

  await writeFile(
    join(resDir, 'layout-v26', 'layout_api_probe.xml'),
    [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"',
      '    android:layout_width="match_parent"',
      '    android:layout_height="match_parent">',
      '    <TextView',
      '        android:layout_width="wrap_content"',
      '        android:layout_height="wrap_content"',
      '        android:tooltipText="Tooltip Text" />',
      '</LinearLayout>',
      '',
    ].join('\n'),
    'utf8',
  );

  await writeFile(
    join(resDir, 'layout', 'layout_aar_probe.xml'),
    [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"',
      '    android:layout_width="match_parent"',
      '    android:layout_height="match_parent"',
      '    android:orientation="vertical">',
      '    <CustomXmlView',
      '        android:layout_width="wrap_content"',
      '        android:layout_height="wrap_content" />',
      '    <CustomRepoQueryView',
      '        android:layout_width="wrap_content"',
      '        android:layout_height="wrap_content" />',
      '    <CorruptXmlNode',
      '        triggerNodeFault="true"',
      '        android:layout_width="wrap_content"',
      '        android:layout_height="wrap_content" />',
      '    <TextView',
      '        android:layout_width="wrap_content"',
      '        android:layout_height="wrap_content"',
      '        android:text="Fault Sibling Text" />',
      '</LinearLayout>',
      '',
    ].join('\n'),
    'utf8',
  );

  await writeFile(
    join(resDir, 'menu', 'sample_menu.xml'),
    [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<menu xmlns:android="http://schemas.android.com/apk/res/android">',
      '    <item',
      '        android:id="@+id/menu_item1"',
      '        android:title="Hardcoded Menu Title" />',
      '</menu>',
      '',
    ].join('\n'),
    'utf8',
  );

  await writeFile(
    join(targetDir, 'app', 'src', 'debug', 'AndroidManifest.xml'),
    [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android"',
      '    package="com.example.app">',
      '    <application>',
      '        <activity android:name=".DebugActivity" android:exported="false" />',
      '    </application>',
      '</manifest>',
      '',
    ].join('\n'),
    'utf8',
  );

  await writeFile(
    join(targetDir, 'app', 'plain_doc.xml'),
    [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<plain-root>',
      '    <child text="Plain text document" />',
      '</plain-root>',
      '',
    ].join('\n'),
    'utf8',
  );
  await seedSandboxProjectConfig(targetDir, sandbox);
  return targetDir;
}

test('Android Lint diagnostics integration', async (t) => {
  const sandbox = await createIntegrationSandbox(prereqs);
  let projectDir = '';
  let driver: InitializedLspClientDriver | null = null;

  try {
    projectDir = await copyAndroidLintFixture(sandbox);
    const client = await startLspClient(projectDir, sandbox);
    driver = client;

    await executeIntellij(
      { action: 'wait', project: projectDir, timeout: 180 },
      undefined,
      undefined,
      { cwd: projectDir } as ExtensionContext,
      { systemPath: sandbox.systemPath },
    );

    // 1. Verify diagnosticProvider declared in server initialize capabilities
    const initCapabilities = client.initResult?.capabilities;
    assert.ok(
      Boolean(initCapabilities?.diagnosticProvider),
      'Server initialize response must declare diagnosticProvider capability',
    );

    // 2. Compiler errors coexist (Java and Kotlin)
    await t.test(
      'Diagnostics: Compiler and Lint diagnostics coexist (Java and Kotlin)',
      async () => {
        const javaCoexistUri = pathToFileURL(
          join(
            projectDir,
            'app',
            'src',
            'main',
            'java',
            'com',
            'example',
            'app',
            'CoexistActivity.java',
          ),
        ).href;
        const javaText1 = [
          'package com.example.app;',
          '',
          'public class CoexistActivity extends android.app.Activity {',
          '    public void testCoexist() {',
          '        int compilerErrorVar = "bad_type";',
          '        new android.app.NotificationChannel("chan_coexist", "Coexist Channel", 3);',
          '    }',
          '}',
          '',
        ].join('\n');

        client.notify('textDocument/didOpen', {
          textDocument: { uri: javaCoexistUri, languageId: 'java', version: 1, text: javaText1 },
        });

        try {
          const report1 = await pullDiagnostics(client, javaCoexistUri);
          assert.equal(report1.kind, 'full');
          const items1 = report1.items ?? [];
          const lintErrors1 = items1.filter(
            (d: LspDiagnostic) => d.source === 'android-lint' && d.code === 'NewApi',
          );
          const compilerErrors1 = items1.filter(
            (d: LspDiagnostic) => d.source !== 'android-lint' && d.severity === 1,
          );

          assert.ok(lintErrors1.length >= 1, 'Java must report NewApi from android-lint');
          assert.ok(
            compilerErrors1.length >= 1,
            'Java must report native compiler error for bad_type',
          );

          const targetIdRange = findRangeInText(
            javaText1,
            'new android.app.NotificationChannel("chan_coexist", "Coexist Channel", 3)',
          );
          const matchingLint = lintErrors1.find(
            (d: LspDiagnostic) =>
              d.range.start.line === targetIdRange.start.line &&
              d.range.start.character === targetIdRange.start.character,
          );
          assert.ok(matchingLint, JSON.stringify(lintErrors1));

          // Fix compiler error via didChange
          const javaText2 = javaText1.replace(
            'int compilerErrorVar = "bad_type";',
            'int compilerErrorVar = 42;',
          );
          client.notify('textDocument/didChange', {
            textDocument: { uri: javaCoexistUri, version: 2 },
            contentChanges: [{ text: javaText2 }],
          });

          const report2 = await pullDiagnostics(client, javaCoexistUri);
          const items2 = report2.items ?? [];
          const lintErrors2 = items2.filter(
            (d: LspDiagnostic) => d.source === 'android-lint' && d.code === 'NewApi',
          );
          const compilerErrors2 = items2.filter(
            (d: LspDiagnostic) => d.source !== 'android-lint' && d.severity === 1,
          );

          assert.equal(
            compilerErrors2.length,
            0,
            'Java compiler error must be cleared after type fix',
          );
          assert.ok(
            lintErrors2.length >= 1,
            'Java NewApi must remain after compiler error cleared',
          );
        } finally {
          client.notify('textDocument/didClose', { textDocument: { uri: javaCoexistUri } });
        }

        // Kotlin coexistence
        const ktCoexistUri = pathToFileURL(
          join(projectDir, 'app', 'src', 'main', 'java', 'com', 'example', 'app', 'CoexistKt.kt'),
        ).href;
        const ktText1 = [
          'package com.example.app',
          '',
          'fun testCoexistKt() {',
          '    val compilerErrorVar: Int = "bad_type"',
          '    android.app.NotificationChannel("chan_kt_coexist", "Coexist KT", 3)',
          '}',
          '',
        ].join('\n');

        client.notify('textDocument/didOpen', {
          textDocument: { uri: ktCoexistUri, languageId: 'kotlin', version: 1, text: ktText1 },
        });

        try {
          const reportKt1 = await pullDiagnostics(client, ktCoexistUri);
          const itemsKt1 = reportKt1.items ?? [];
          const lintErrorsKt1 = itemsKt1.filter(
            (d: LspDiagnostic) => d.source === 'android-lint' && d.code === 'NewApi',
          );
          const compilerErrorsKt1 = itemsKt1.filter(
            (d: LspDiagnostic) => d.source !== 'android-lint' && d.severity === 1,
          );

          assert.ok(lintErrorsKt1.length >= 1, 'Kotlin must report NewApi from android-lint');
          assert.ok(
            compilerErrorsKt1.length >= 1,
            'Kotlin must report native compiler error for bad_type',
          );

          // Fix Kotlin compiler error via didChange
          const ktText2 = ktText1.replace(
            'val compilerErrorVar: Int = "bad_type"',
            'val compilerErrorVar: Int = 42',
          );
          client.notify('textDocument/didChange', {
            textDocument: { uri: ktCoexistUri, version: 2 },
            contentChanges: [{ text: ktText2 }],
          });

          const reportKt2 = await pullDiagnostics(client, ktCoexistUri);
          const itemsKt2 = reportKt2.items ?? [];
          const lintErrorsKt2 = itemsKt2.filter(
            (d: LspDiagnostic) => d.source === 'android-lint' && d.code === 'NewApi',
          );
          const compilerErrorsKt2 = itemsKt2.filter(
            (d: LspDiagnostic) => d.source !== 'android-lint' && d.severity === 1,
          );

          assert.equal(
            compilerErrorsKt2.length,
            0,
            'Kotlin compiler error must be cleared after type fix',
          );
          assert.ok(
            lintErrorsKt2.length >= 1,
            'Kotlin NewApi must remain after compiler error cleared',
          );
        } finally {
          client.notify('textDocument/didClose', { textDocument: { uri: ktCoexistUri } });
        }
      },
    );

    // 3. Twelve NewApi positive-negative matrix and didChange (Java and Kotlin)
    await t.test(
      'Diagnostics: NewApi 12-item positive-negative matrix and didChange (Java and Kotlin)',
      async () => {
        const javaMatrixUri = pathToFileURL(
          join(
            projectDir,
            'app',
            'src',
            'main',
            'java',
            'com',
            'example',
            'app',
            'MatrixJavaActivity.java',
          ),
        ).href;

        // J1: 1 unprotected + 1 protected by Build.VERSION.SDK_INT >= 26
        const jText1 = [
          'package com.example.app;',
          '',
          'public class MatrixJavaActivity extends android.app.Activity {',
          '    public void testMatrix() {',
          '        new android.app.NotificationChannel("unprotected", "Unprotected", 3);',
          '        if (android.os.Build.VERSION.SDK_INT >= 26) {',
          '            new android.app.NotificationChannel("protected", "Protected", 3);',
          '        }',
          '    }',
          '}',
          '',
        ].join('\n');

        client.notify('textDocument/didOpen', {
          textDocument: { uri: javaMatrixUri, languageId: 'java', version: 1, text: jText1 },
        });

        try {
          const repJ1 = await pullDiagnostics(client, javaMatrixUri);
          const lintJ1 = (repJ1.items ?? []).filter(
            (d: LspDiagnostic) => d.source === 'android-lint' && d.code === 'NewApi',
          );
          assert.equal(lintJ1.length, 1, 'J1: exactly 1 NewApi error for unprotected call');
          const targetIdRangeJ = findRangeInText(jText1, 'new android.app.NotificationChannel');
          assert.deepEqual(lintJ1[0].range, targetIdRangeJ);

          // J2: both protected by >= 26
          const jText2 = [
            'package com.example.app;',
            '',
            'public class MatrixJavaActivity extends android.app.Activity {',
            '    public void testMatrix() {',
            '        if (android.os.Build.VERSION.SDK_INT >= 26) {',
            '            new android.app.NotificationChannel("p1", "P1", 3);',
            '        }',
            '        if (android.os.Build.VERSION.SDK_INT >= 26) {',
            '            new android.app.NotificationChannel("p2", "P2", 3);',
            '        }',
            '    }',
            '}',
            '',
          ].join('\n');
          client.notify('textDocument/didChange', {
            textDocument: { uri: javaMatrixUri, version: 2 },
            contentChanges: [{ text: jText2 }],
          });
          const repJ2 = await pullDiagnostics(client, javaMatrixUri);
          const lintJ2 = (repJ2.items ?? []).filter(
            (d: LspDiagnostic) => d.source === 'android-lint' && d.code === 'NewApi',
          );
          assert.equal(
            lintJ2.length,
            0,
            'J2: 0 NewApi errors when both protected by SDK_INT >= 26',
          );

          // J3: both protected only by >= 25
          const jText3 = [
            'package com.example.app;',
            '',
            'public class MatrixJavaActivity extends android.app.Activity {',
            '    public void testMatrix() {',
            '        if (android.os.Build.VERSION.SDK_INT >= 25) {',
            '            new android.app.NotificationChannel("p25_1", "P25_1", 3);',
            '        }',
            '        if (android.os.Build.VERSION.SDK_INT >= 25) {',
            '            new android.app.NotificationChannel("p25_2", "P25_2", 3);',
            '        }',
            '    }',
            '}',
            '',
          ].join('\n');
          client.notify('textDocument/didChange', {
            textDocument: { uri: javaMatrixUri, version: 3 },
            contentChanges: [{ text: jText3 }],
          });
          const repJ3 = await pullDiagnostics(client, javaMatrixUri);
          const lintJ3 = (repJ3.items ?? []).filter(
            (d: LspDiagnostic) => d.source === 'android-lint' && d.code === 'NewApi',
          );
          assert.equal(
            lintJ3.length,
            2,
            'J3: 2 NewApi errors when protected only by SDK_INT >= 25',
          );

          // J4: annotated with TargetApi(26)
          const jText4 = [
            'package com.example.app;',
            '',
            'public class MatrixJavaActivity extends android.app.Activity {',
            '    @android.annotation.TargetApi(26)',
            '    public void testMatrix() {',
            '        new android.app.NotificationChannel("targetApi", "TargetApi", 3);',
            '    }',
            '}',
            '',
          ].join('\n');
          client.notify('textDocument/didChange', {
            textDocument: { uri: javaMatrixUri, version: 4 },
            contentChanges: [{ text: jText4 }],
          });
          const repJ4 = await pullDiagnostics(client, javaMatrixUri);
          const lintJ4 = (repJ4.items ?? []).filter(
            (d: LspDiagnostic) => d.source === 'android-lint' && d.code === 'NewApi',
          );
          assert.equal(lintJ4.length, 0, 'J4: 0 NewApi errors with @TargetApi(26)');

          // J5: annotated with @SuppressWarnings("NewApi")
          const jText5 = [
            'package com.example.app;',
            '',
            'public class MatrixJavaActivity extends android.app.Activity {',
            '    @SuppressWarnings("NewApi")',
            '    public void testMatrix() {',
            '        new android.app.NotificationChannel("suppress", "Suppress", 3);',
            '    }',
            '}',
            '',
          ].join('\n');
          client.notify('textDocument/didChange', {
            textDocument: { uri: javaMatrixUri, version: 5 },
            contentChanges: [{ text: jText5 }],
          });
          const repJ5 = await pullDiagnostics(client, javaMatrixUri);
          const lintJ5 = (repJ5.items ?? []).filter(
            (d: LspDiagnostic) => d.source === 'android-lint' && d.code === 'NewApi',
          );
          assert.equal(lintJ5.length, 0, 'J5: 0 NewApi errors with @SuppressWarnings("NewApi")');

          // J6: didChange reverting back to unprotected call
          const jText6 = [
            'package com.example.app;',
            '',
            'public class MatrixJavaActivity extends android.app.Activity {',
            '    public void testMatrix() {',
            '        new android.app.NotificationChannel("revert_unprotected", "Revert", 3);',
            '    }',
            '}',
            '',
          ].join('\n');
          client.notify('textDocument/didChange', {
            textDocument: { uri: javaMatrixUri, version: 6 },
            contentChanges: [{ text: jText6 }],
          });
          const repJ6 = await pullDiagnostics(client, javaMatrixUri);
          const lintJ6 = (repJ6.items ?? []).filter(
            (d: LspDiagnostic) => d.source === 'android-lint' && d.code === 'NewApi',
          );
          assert.equal(
            lintJ6.length,
            1,
            'J6: NewApi reappears after reverting to unprotected call',
          );
        } finally {
          client.notify('textDocument/didClose', { textDocument: { uri: javaMatrixUri } });
        }

        // Kotlin 6 cases (K1 to K6)
        const ktMatrixUri = pathToFileURL(
          join(
            projectDir,
            'app',
            'src',
            'main',
            'java',
            'com',
            'example',
            'app',
            'MatrixKotlin.kt',
          ),
        ).href;

        // K1: 1 unprotected + 1 protected by Build.VERSION.SDK_INT >= 26
        const kText1 = [
          'package com.example.app',
          '',
          'class MatrixKotlin {',
          '    fun testMatrix() {',
          '        android.app.NotificationChannel("unprotected_kt", "Unprotected KT", 3)',
          '        if (android.os.Build.VERSION.SDK_INT >= 26) {',
          '            android.app.NotificationChannel("protected_kt", "Protected KT", 3)',
          '        }',
          '    }',
          '}',
          '',
        ].join('\n');
        client.notify('textDocument/didOpen', {
          textDocument: { uri: ktMatrixUri, languageId: 'kotlin', version: 1, text: kText1 },
        });

        try {
          const repK1 = await pullDiagnostics(client, ktMatrixUri);
          const lintK1 = (repK1.items ?? []).filter(
            (d: LspDiagnostic) => d.source === 'android-lint' && d.code === 'NewApi',
          );
          assert.equal(lintK1.length, 1, 'K1: exactly 1 NewApi error for unprotected call');
          const targetIdRangeK = findRangeInText(kText1, 'NotificationChannel', 1);
          assert.equal(
            lintK1[0].range.start.line,
            targetIdRangeK.start.line,
            'K1: must flag unprotected line',
          );
          assert.equal(
            lintK1[0].range.start.character,
            targetIdRangeK.start.character,
            'K1: start char must match identifier',
          );
          assert.equal(
            lintK1[0].range.end.character,
            targetIdRangeK.end.character,
            'K1: end char must match identifier',
          );

          // K2: both protected by >= 26
          const kText2 = [
            'package com.example.app',
            '',
            'class MatrixKotlin {',
            '    fun testMatrix() {',
            '        if (android.os.Build.VERSION.SDK_INT >= 26) {',
            '            android.app.NotificationChannel("p1_kt", "P1 KT", 3)',
            '        }',
            '        if (android.os.Build.VERSION.SDK_INT >= 26) {',
            '            android.app.NotificationChannel("p2_kt", "P2 KT", 3)',
            '        }',
            '    }',
            '}',
            '',
          ].join('\n');
          client.notify('textDocument/didChange', {
            textDocument: { uri: ktMatrixUri, version: 2 },
            contentChanges: [{ text: kText2 }],
          });
          const repK2 = await pullDiagnostics(client, ktMatrixUri);
          const lintK2 = (repK2.items ?? []).filter(
            (d: LspDiagnostic) => d.source === 'android-lint' && d.code === 'NewApi',
          );
          assert.equal(
            lintK2.length,
            0,
            'K2: 0 NewApi errors when both protected by SDK_INT >= 26',
          );

          // K3: both protected only by >= 25
          const kText3 = [
            'package com.example.app',
            '',
            'class MatrixKotlin {',
            '    fun testMatrix() {',
            '        if (android.os.Build.VERSION.SDK_INT >= 25) {',
            '            android.app.NotificationChannel("p25_1_kt", "P25_1 KT", 3)',
            '        }',
            '        if (android.os.Build.VERSION.SDK_INT >= 25) {',
            '            android.app.NotificationChannel("p25_2_kt", "P25_2 KT", 3)',
            '        }',
            '    }',
            '}',
            '',
          ].join('\n');
          client.notify('textDocument/didChange', {
            textDocument: { uri: ktMatrixUri, version: 3 },
            contentChanges: [{ text: kText3 }],
          });
          const repK3 = await pullDiagnostics(client, ktMatrixUri);
          const lintK3 = (repK3.items ?? []).filter(
            (d: LspDiagnostic) => d.source === 'android-lint' && d.code === 'NewApi',
          );
          assert.equal(
            lintK3.length,
            2,
            'K3: 2 NewApi errors when protected only by SDK_INT >= 25',
          );

          // K4: annotated with TargetApi(26)
          const kText4 = [
            'package com.example.app',
            '',
            'class MatrixKotlin {',
            '    @android.annotation.TargetApi(26)',
            '    fun testMatrix() {',
            '        android.app.NotificationChannel("targetApi_kt", "TargetApi KT", 3)',
            '    }',
            '}',
            '',
          ].join('\n');
          client.notify('textDocument/didChange', {
            textDocument: { uri: ktMatrixUri, version: 4 },
            contentChanges: [{ text: kText4 }],
          });
          const repK4 = await pullDiagnostics(client, ktMatrixUri);
          const lintK4 = (repK4.items ?? []).filter(
            (d: LspDiagnostic) => d.source === 'android-lint' && d.code === 'NewApi',
          );
          assert.equal(lintK4.length, 0, 'K4: 0 NewApi errors with @TargetApi(26)');

          // K5: annotated with @Suppress("NewApi")
          const kText5 = [
            'package com.example.app',
            '',
            'class MatrixKotlin {',
            '    @Suppress("NewApi")',
            '    fun testMatrix() {',
            '        android.app.NotificationChannel("suppress_kt", "Suppress KT", 3)',
            '    }',
            '}',
            '',
          ].join('\n');
          client.notify('textDocument/didChange', {
            textDocument: { uri: ktMatrixUri, version: 5 },
            contentChanges: [{ text: kText5 }],
          });
          const repK5 = await pullDiagnostics(client, ktMatrixUri);
          const lintK5 = (repK5.items ?? []).filter(
            (d: LspDiagnostic) => d.source === 'android-lint' && d.code === 'NewApi',
          );
          assert.equal(lintK5.length, 0, 'K5: 0 NewApi errors with @Suppress("NewApi")');

          // K6: didChange reverting back to unprotected call
          const kText6 = [
            'package com.example.app',
            '',
            'class MatrixKotlin {',
            '    fun testMatrix() {',
            '        android.app.NotificationChannel("revert_unprotected_kt", "Revert KT", 3)',
            '    }',
            '}',
            '',
          ].join('\n');
          client.notify('textDocument/didChange', {
            textDocument: { uri: ktMatrixUri, version: 6 },
            contentChanges: [{ text: kText6 }],
          });
          const repK6 = await pullDiagnostics(client, ktMatrixUri);
          const lintK6 = (repK6.items ?? []).filter(
            (d: LspDiagnostic) => d.source === 'android-lint' && d.code === 'NewApi',
          );
          assert.equal(
            lintK6.length,
            1,
            'K6: NewApi reappears after reverting to unprotected call',
          );
        } finally {
          client.notify('textDocument/didClose', { textDocument: { uri: ktMatrixUri } });
        }
      },
    );

    // 4. Real Compose unremembered/remember/suppress/coexist plus ComposableNaming
    await t.test(
      'Diagnostics: Real Compose unremembered/remember/suppress/coexist and ComposableNaming',
      async () => {
        const composeUri = pathToFileURL(
          join(
            projectDir,
            'app',
            'src',
            'main',
            'java',
            'com',
            'example',
            'app',
            'ComposeLintProbe.kt',
          ),
        ).href;
        const composeText = [
          'package com.example.app',
          '',
          'import androidx.compose.runtime.Composable',
          'import androidx.compose.runtime.mutableStateOf',
          'import androidx.compose.runtime.remember',
          '',
          '@Composable',
          'fun BadStateProbe() {',
          '    val state = mutableStateOf(0)',
          '}',
          '',
          '@Composable',
          'fun GoodStateProbe() {',
          '    val state = remember { mutableStateOf(0) }',
          '}',
          '',
          '@Suppress("UnrememberedMutableState")',
          '@Composable',
          'fun SuppressedStateProbe() {',
          '    val state = mutableStateOf(0)',
          '}',
          '',
          '@Composable',
          'fun CoexistStateAndApiProbe() {',
          '    val state = mutableStateOf(0)',
          '    android.app.NotificationChannel("chan_compose", "Compose Channel", 3)',
          '}',
          '',
          '@Composable',
          'fun badNamingComposable() {',
          '}',
          '',
        ].join('\n');

        client.notify('textDocument/didOpen', {
          textDocument: { uri: composeUri, languageId: 'kotlin', version: 1, text: composeText },
        });

        try {
          const report = await pullDiagnostics(client, composeUri);
          const items = report.items ?? [];

          // 1. BadStateProbe reports UnrememberedMutableState
          const badStateRange = findRangeInText(composeText, 'mutableStateOf(0)', 1);
          const unremembered1 = items.filter(
            (d: LspDiagnostic) =>
              d.source === 'android-lint' &&
              d.code === 'UnrememberedMutableState' &&
              d.range.start.line === badStateRange.start.line,
          );
          assert.equal(
            unremembered1.length,
            1,
            'BadStateProbe must report UnrememberedMutableState',
          );

          // Phase D check: BadStateProbe should NOT report Kotlin FunctionName warning
          const functionNameWarnings = items.filter(
            (d: LspDiagnostic) =>
              d.code === 'FunctionName' ||
              d.message?.includes('Function name') ||
              d.message?.includes('lowercase letter'),
          );
          const badFuncLine = composeText
            .split('\n')
            .findIndex((l: string) => l.includes('fun BadStateProbe()'));
          assert.ok(
            !functionNameWarnings.some((d: LspDiagnostic) => d.range.start.line === badFuncLine),
            'BadStateProbe FunctionName warning must be suppressed by Phase D',
          );

          // 2. GoodStateProbe does not report UnrememberedMutableState
          const goodLine = composeText
            .split('\n')
            .findIndex((l: string) => l.includes('GoodStateProbe()'));
          const goodUnremembered = items.filter(
            (d: LspDiagnostic) =>
              d.source === 'android-lint' &&
              d.code === 'UnrememberedMutableState' &&
              d.range.start.line > goodLine &&
              d.range.start.line < goodLine + 4,
          );
          assert.equal(
            goodUnremembered.length,
            0,
            'GoodStateProbe must not report UnrememberedMutableState',
          );

          // 3. SuppressedStateProbe does not report UnrememberedMutableState
          const suppLine = composeText
            .split('\n')
            .findIndex((l: string) => l.includes('SuppressedStateProbe()'));
          const suppUnremembered = items.filter(
            (d: LspDiagnostic) =>
              d.source === 'android-lint' &&
              d.code === 'UnrememberedMutableState' &&
              d.range.start.line > suppLine &&
              d.range.start.line < suppLine + 4,
          );
          assert.equal(
            suppUnremembered.length,
            0,
            'SuppressedStateProbe must not report UnrememberedMutableState',
          );

          // 4. CoexistStateAndApiProbe reports BOTH UnrememberedMutableState and NewApi
          const coexistLine = composeText
            .split('\n')
            .findIndex((l: string) => l.includes('CoexistStateAndApiProbe()'));
          const coexistUnremembered = items.filter(
            (d: LspDiagnostic) =>
              d.source === 'android-lint' &&
              d.code === 'UnrememberedMutableState' &&
              d.range.start.line > coexistLine &&
              d.range.start.line < coexistLine + 5,
          );
          const coexistNewApi = items.filter(
            (d: LspDiagnostic) =>
              d.source === 'android-lint' &&
              d.code === 'NewApi' &&
              d.range.start.line > coexistLine &&
              d.range.start.line < coexistLine + 5,
          );
          assert.equal(
            coexistUnremembered.length,
            1,
            'Coexist probe must report UnrememberedMutableState',
          );
          assert.equal(coexistNewApi.length, 1, 'Coexist probe must report NewApi');

          // 5. ComposableNaming on badNamingComposable
          const namingIssues = items.filter(
            (d: LspDiagnostic) => d.source === 'android-lint' && d.code === 'ComposableNaming',
          );
          assert.ok(namingIssues.length >= 1, 'badNamingComposable must report ComposableNaming');
          const namingRange = findRangeInText(composeText, 'badNamingComposable', 1);
          const matchingNaming = namingIssues.find(
            (d: LspDiagnostic) => d.range.start.line === namingRange.start.line,
          );
          assert.ok(matchingNaming, 'ComposableNaming range must target the function name');
        } finally {
          client.notify('textDocument/didClose', { textDocument: { uri: composeUri } });
        }
      },
    );

    // 5. Clean literal, dynamic, productFlavors and official built-model transitions
    await t.test(
      'Diagnostics: Clean literal, dynamic, productFlavors and official built-model transitions',
      async () => {
        const transUri = pathToFileURL(
          join(
            projectDir,
            'app',
            'src',
            'main',
            'java',
            'com',
            'example',
            'app',
            'ComposeLintProbe.kt',
          ),
        ).href;
        const transText = [
          'package com.example.app',
          'import androidx.compose.runtime.Composable',
          'import androidx.compose.runtime.mutableStateOf',
          '@Composable fun ModelTransition() {',
          '    val state = mutableStateOf(0)',
          '    android.app.NotificationChannel("chan_trans", "Transition Channel", 3)',
          '}',
          '',
        ].join('\n');

        client.notify('textDocument/didOpen', {
          textDocument: { uri: transUri, languageId: 'kotlin', version: 1, text: transText },
        });

        const appBuildGradlePath = join(projectDir, 'app', 'build.gradle.kts');
        const originalBuildContent = await readFile(appBuildGradlePath, 'utf8');
        const modelDir = join(
          projectDir,
          'app',
          'build',
          'intermediates',
          'lint_report_lint_model',
          'debug',
          'generateDebugLintReportModel',
        );

        try {
          await rm(join(projectDir, 'app', 'build'), { recursive: true, force: true });
          // Clean literal state (minSdk = 21 static literal): NewApi is reported
          const rep1 = await pullDiagnostics(client, transUri);
          const lint1 = (rep1.items ?? []).filter(
            (d: LspDiagnostic) => d.source === 'android-lint' && d.code === 'NewApi',
          );
          assert.equal(
            lint1.length,
            1,
            'Clean literal minSdk=21 must report NewApi for API 26 call',
          );
          assert.equal(
            (rep1.items ?? []).filter(
              (d) => d.source === 'android-lint' && d.code === 'UnrememberedMutableState',
            ).length,
            1,
          );

          await writeFile(
            appBuildGradlePath,
            originalBuildContent.replace('minSdk = 21', 'minSdk = resolveMinimumSdk()'),
          );
          const dynamic = await pullDiagnostics(client, transUri);
          assert.equal(
            (dynamic.items ?? []).filter((d) => d.source === 'android-lint' && d.code === 'NewApi')
              .length,
            0,
          );
          assert.equal(
            (dynamic.items ?? []).filter(
              (d) => d.source === 'android-lint' && d.code === 'UnrememberedMutableState',
            ).length,
            1,
          );

          // Modify build.gradle.kts to introduce productFlavors (clean state premise missing)
          const flavorBuildContent = originalBuildContent.replace(
            'defaultConfig {',
            [
              'flavorDimensions += "mode"',
              '    productFlavors {',
              '        create("demo") {',
              '            dimension = "mode"',
              '            minSdk = 21',
              '        }',
              '        create("full") {',
              '            dimension = "mode"',
              '            minSdk = 26',
              '        }',
              '    }',
              '    defaultConfig {',
            ].join('\n'),
          );
          await writeFile(appBuildGradlePath, flavorBuildContent, 'utf8');

          // Pull diagnostics: NewApi must be skipped without guessing minSdk=1
          const rep2 = await pullDiagnostics(client, transUri);
          const lint2 = (rep2.items ?? []).filter(
            (d: LspDiagnostic) => d.source === 'android-lint' && d.code === 'NewApi',
          );
          assert.equal(
            lint2.length,
            0,
            'Clean state with productFlavors must skip NewApi due to missing premise',
          );
          assert.equal(
            (rep2.items ?? []).filter(
              (d) => d.source === 'android-lint' && d.code === 'UnrememberedMutableState',
            ).length,
            1,
          );

          // Built model transition: write complete official LintModelSerialization schema
          await mkdir(modelDir, { recursive: true });
          const moduleXmlContent = [
            '<lint-module',
            '    format="1"',
            '    dir="."',
            '    name="app"',
            '    type="APP"',
            '    buildFolder="build"',
            '    javaSourceLevel="21"',
            '    compileTarget="android-37">',
            '  <lintOptions />',
            '  <variant name="debug"/>',
            '</lint-module>',
            '',
          ].join('\n');
          const debugXmlContent = [
            '<variant',
            '    name="debug"',
            '    package="com.example.app"',
            '    minSdkVersion="21"',
            '    targetSdkVersion="37"',
            '    debuggable="true">',
            '  <buildFeatures />',
            '  <sourceProviders />',
            '  <resValues />',
            '  <manifestPlaceholders />',
            '  <mainArtifact applicationId="com.example.app" />',
            '</variant>',
            '',
          ].join('\n');
          await writeFile(join(modelDir, 'module.xml'), moduleXmlContent, 'utf8');
          await writeFile(join(modelDir, 'debug.xml'), debugXmlContent, 'utf8');
          await writeFile(
            join(modelDir, 'debug-mainArtifact-libraries.xml'),
            '<libraries>\n</libraries>\n',
            'utf8',
          );
          await writeFile(
            join(modelDir, 'debug-mainArtifact-dependencies.xml'),
            '<dependencies>\n</dependencies>\n',
            'utf8',
          );

          // Pull diagnostics: NewApi must recover from official built model
          const rep3 = await pullDiagnostics(client, transUri);
          const lint3 = (rep3.items ?? []).filter(
            (d: LspDiagnostic) => d.source === 'android-lint' && d.code === 'NewApi',
          );
          assert.equal(
            lint3.length,
            1,
            'Official built model must restore NewApi detection with minSdkVersion=21',
          );
          assert.equal(
            (rep3.items ?? []).filter(
              (d) => d.source === 'android-lint' && d.code === 'UnrememberedMutableState',
            ).length,
            1,
          );
        } finally {
          client.notify('textDocument/didClose', { textDocument: { uri: transUri } });
          await writeFile(appBuildGradlePath, originalBuildContent, 'utf8');
          try {
            await rm(join(projectDir, 'app', 'build'), { recursive: true, force: true });
          } catch {
            // Ignore cleanup error
          }
        }
      },
    );

    // 6. lint.xml severity override (ignore and warning)
    await t.test('Diagnostics: lint.xml severity override (ignore and warning)', async () => {
      const xmlProbeUri = pathToFileURL(
        join(
          projectDir,
          'app',
          'src',
          'main',
          'java',
          'com',
          'example',
          'app',
          'LintXmlOverrideActivity.java',
        ),
      ).href;
      const xmlProbeText = [
        'package com.example.app;',
        '',
        'public class LintXmlOverrideActivity extends android.app.Activity {',
        '    public void testOverride() {',
        '        new android.app.NotificationChannel("override_chan", "Override Channel", 3);',
        '    }',
        '}',
        '',
      ].join('\n');

      client.notify('textDocument/didOpen', {
        textDocument: { uri: xmlProbeUri, languageId: 'java', version: 1, text: xmlProbeText },
      });

      const lintXmlFile = join(projectDir, 'app', 'lint.xml');

      try {
        // Write lint.xml with severity="ignore"
        const ignoreXml = [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<lint>',
          '    <issue id="NewApi" severity="ignore" />',
          '</lint>',
          '',
        ].join('\n');
        await writeFile(lintXmlFile, ignoreXml, 'utf8');

        const repIgnore = await pullDiagnostics(client, xmlProbeUri);
        const lintIgnore = (repIgnore.items ?? []).filter(
          (d: LspDiagnostic) => d.source === 'android-lint' && d.code === 'NewApi',
        );
        assert.equal(
          lintIgnore.length,
          0,
          'lint.xml severity="ignore" must hide NewApi diagnostic',
        );

        // Update lint.xml with severity="warning"
        const warningXml = [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<lint>',
          '    <issue id="NewApi" severity="warning" />',
          '</lint>',
          '',
        ].join('\n');
        await writeFile(lintXmlFile, warningXml, 'utf8');

        const repWarning = await pullDiagnostics(client, xmlProbeUri);
        const lintWarning = (repWarning.items ?? []).filter(
          (d: LspDiagnostic) => d.source === 'android-lint' && d.code === 'NewApi',
        );
        assert.equal(
          lintWarning.length,
          1,
          'lint.xml severity="warning" must report NewApi diagnostic',
        );
        assert.equal(
          lintWarning[0].severity,
          2,
          'DiagnosticSeverity must be Warning (2) when configured in lint.xml',
        );
      } finally {
        client.notify('textDocument/didClose', { textDocument: { uri: xmlProbeUri } });
        try {
          await rm(lintXmlFile, { force: true });
        } catch {
          // Ignore removal error
        }
      }
    });

    // 7. Corrupt/NoSuchMethodError AAR rule isolation and non-AndroidX rule support
    await t.test(
      'Diagnostics: Corrupt/NoSuchMethodError AAR rule isolation and non-AndroidX rule support',
      async () => {
        const isoUri = pathToFileURL(
          join(
            projectDir,
            'app',
            'src',
            'main',
            'java',
            'com',
            'example',
            'app',
            'CorruptIsolationProbe.kt',
          ),
        ).href;
        const isoText = [
          'package com.example.app',
          '',
          'import androidx.compose.runtime.Composable',
          'import androidx.compose.runtime.mutableStateOf',
          '',
          '@Composable',
          'fun CorruptIsolationFunction() {',
          '    val state = mutableStateOf(0)',
          '    android.app.NotificationChannel("iso_chan", "Iso Channel", 3)',
          '    val errorProbe = "triggerCorruptExecutionError"',
          '    val nativeError: Int = "native type error"',
          '}',
          '',
        ].join('\n');

        client.notify('textDocument/didOpen', {
          textDocument: { uri: isoUri, languageId: 'kotlin', version: 1, text: isoText },
        });

        try {
          // Pull diagnostics while corrupt-rule.aar (with constructor & execution NoSuchMethodError) is present
          const report = await pullDiagnostics(client, isoUri);
          assert.equal(
            report.kind,
            'full',
            'Response must be full diagnostic report despite corrupt AAR',
          );
          const items = report.items ?? [];

          const newApi = items.filter(
            (d: LspDiagnostic) => d.source === 'android-lint' && d.code === 'NewApi',
          );
          const composeRule = items.filter(
            (d: LspDiagnostic) =>
              d.source === 'android-lint' && d.code === 'UnrememberedMutableState',
          );

          assert.equal(newApi.length, 1, JSON.stringify(items));
          assert.equal(
            composeRule.length,
            1,
            'Compose rule must be safely returned despite corrupt AAR',
          );
          assert.ok(
            items.some((d) => d.source !== 'android-lint' && d.severity === 1),
            'Native compiler diagnostics must survive faulty AAR rules',
          );
        } finally {
          client.notify('textDocument/didClose', { textDocument: { uri: isoUri } });
        }

        // Non-AndroidX custom rule assertion
        const externalUri = pathToFileURL(
          join(
            projectDir,
            'app',
            'src',
            'main',
            'java',
            'com',
            'example',
            'app',
            'CustomExternalProbe.java',
          ),
        ).href;
        const externalText = [
          'package com.example.app;',
          '',
          'public class CustomExternalProbe extends android.app.Activity {',
          '    public void runExternal() {',
          '        String trigger = "triggerCustomExternalRule";',
          '    }',
          '}',
          '',
        ].join('\n');

        client.notify('textDocument/didOpen', {
          textDocument: { uri: externalUri, languageId: 'java', version: 1, text: externalText },
        });

        try {
          const externalReport = await pullDiagnostics(client, externalUri);
          const externalItems = externalReport.items ?? [];
          const customRules = externalItems.filter(
            (d: LspDiagnostic) => d.source === 'android-lint' && d.code === 'CustomExternalRule',
          );
          assert.equal(
            customRules.length,
            1,
            'Non-AndroidX dependency AAR rule CustomExternalRule must be loaded and reported',
          );
        } finally {
          client.notify('textDocument/didClose', { textDocument: { uri: externalUri } });
        }
      },
    );

    // 8. Same-version cache hit and cancel/concurrent-edit recovery
    await t.test(
      'Diagnostics: Same-version cache hit and cancel/concurrent-edit recovery',
      async () => {
        const cacheUri = pathToFileURL(
          join(
            projectDir,
            'app',
            'src',
            'main',
            'java',
            'com',
            'example',
            'app',
            'CacheCancelProbe.java',
          ),
        ).href;
        const cacheText = [
          'package com.example.app;',
          '',
          'public class CacheCancelProbe extends android.app.Activity {',
          '    public void testCacheCancel() {',
          '        String cacheSentinel = "triggerCustomExternalRule";',
          '        new android.app.NotificationChannel("chan_cc", "CC Channel", 3);',
          '    }',
          '}',
          '',
        ].join('\n');

        client.notify('textDocument/didOpen', {
          textDocument: { uri: cacheUri, languageId: 'java', version: 1, text: cacheText },
        });

        try {
          // A. Same-version cache hit
          const repFirst = await pullDiagnostics(client, cacheUri);
          const repSecond = await pullDiagnostics(client, cacheUri);
          assert.deepEqual(
            repFirst.items,
            repSecond.items,
            'Consecutive requests for same version must return identical cached diagnostics',
          );

          const firstChecks = (repFirst.items ?? []).filter(
            (d) => d.source === 'android-lint' && d.code === 'CustomExternalRule',
          );
          const secondChecks = (repSecond.items ?? []).filter(
            (d) => d.source === 'android-lint' && d.code === 'CustomExternalRule',
          );
          assert.equal(firstChecks.length, 1);
          assert.equal(secondChecks.length, 1);
          assert.equal(
            secondChecks[0].message,
            firstChecks[0].message,
            'Cache hit must not execute the dependency detector again',
          );
          client.notify('textDocument/didChange', {
            textDocument: { uri: cacheUri, version: 2 },
            contentChanges: [{ text: `${cacheText}\n` }],
          });
          const rechecked = await pullDiagnostics(client, cacheUri);
          const nextChecks = (rechecked.items ?? []).filter(
            (d) => d.source === 'android-lint' && d.code === 'CustomExternalRule',
          );
          assert.equal(nextChecks.length, 1);
          assert.notEqual(
            nextChecks[0].message,
            firstChecks[0].message,
            'A changed document must execute the detector again',
          );

          // B. In-flight cancellation recovery
          const busyText = cacheText.replace(
            '        new android.app.NotificationChannel("chan_cc", "CC Channel", 3);\n',
            '        new android.app.NotificationChannel("chan_cc", "CC Channel", 3);\n'.repeat(
              1000,
            ),
          );
          client.notify('textDocument/didChange', {
            textDocument: { uri: cacheUri, version: 3 },
            contentChanges: [{ text: busyText }],
          });
          const cancelReqId = 91919;
          client.process.stdin?.write(
            encode({
              jsonrpc: '2.0',
              id: cancelReqId,
              method: 'textDocument/diagnostic',
              params: { textDocument: { uri: cacheUri } },
            }),
          );
          client.notify('$/cancelRequest', { id: cancelReqId });
          const cancelMsg = await client.waitFor(
            (m: { id?: number | string }) => m.id === cancelReqId,
            15000,
          );
          assert.ok(cancelMsg, 'Cancellation response message must be received');
          assert.equal(cancelMsg.error?.code, -32800, 'In-flight cancellation must return -32800');

          // Subsequent request after cancel recovers normally
          client.notify('textDocument/didChange', {
            textDocument: { uri: cacheUri, version: 4 },
            contentChanges: [{ text: cacheText }],
          });
          const repRecovered = await pullDiagnostics(client, cacheUri);
          assert.equal(
            repRecovered.kind,
            'full',
            'Server must recover and serve diagnostics after cancellation',
          );

          // C. Concurrent didChange recovery
          const concurrentReqId = 82828;
          const modifiedText = cacheText.replace(
            'new android.app.NotificationChannel("chan_cc", "CC Channel", 3);',
            '// modified comment',
          );
          client.notify('textDocument/didChange', {
            textDocument: { uri: cacheUri, version: 5 },
            contentChanges: [{ text: busyText }],
          });
          client.process.stdin?.write(
            encode({
              jsonrpc: '2.0',
              id: concurrentReqId,
              method: 'textDocument/diagnostic',
              params: { textDocument: { uri: cacheUri } },
            }),
          );
          client.notify('textDocument/didChange', {
            textDocument: { uri: cacheUri, version: 6 },
            contentChanges: [{ text: modifiedText }],
          });

          const concurrentMsg = await client.waitFor(
            (m: { id?: number | string }) => m.id === concurrentReqId,
            15000,
          );
          assert.ok(concurrentMsg, 'Concurrent request response message must be received');
          if (concurrentMsg.error) {
            assert.equal(
              concurrentMsg.error.code,
              -32801,
              'Concurrent edit during analysis must yield -32801 (content_modified)',
            );
          } else {
            const latest = concurrentMsg.result as LspDiagnosticReport;
            assert.equal(latest.kind, 'full');
            assert.equal(
              (latest.items ?? []).filter((d) => d.source === 'android-lint' && d.code === 'NewApi')
                .length,
              0,
            );
          }

          // Post-change diagnostic succeeds and reflects updated content
          const repPostChange = await pullDiagnostics(client, cacheUri);
          assert.equal(repPostChange.kind, 'full');
          const postLint = (repPostChange.items ?? []).filter(
            (d: LspDiagnostic) => d.source === 'android-lint' && d.code === 'NewApi',
          );
          assert.equal(
            postLint.length,
            0,
            'Diagnostics must reflect updated content after didChange',
          );
        } finally {
          client.notify('textDocument/didClose', { textDocument: { uri: cacheUri } });
        }
      },
    );
  } finally {
    if (driver) {
      try {
        await driver.close();
      } catch {
        // Ignore close failure
      }
    }
    await sandbox.cleanup();
  }
});

test('Android XML and Manifest Lint diagnostics integration', {
  timeout: 600000,
}, async (t) => {
  // 1. Native baseline in isolated session (WITHOUT extension)
  await t.test(
    'Baseline: Isolated native ILS session without extension preserves native XML diagnostics and emits no Lint issues',
    async () => {
      const nativeSandbox = await createIntegrationSandbox(prereqs);
      let nativeProjectDir = '';
      let nativeDriver: InitializedLspClientDriver | null = null;
      try {
        const nativeExtensionDir = join(nativeSandbox.sandboxDir, 'no-extension');
        await mkdir(nativeExtensionDir);
        nativeSandbox.env.OMP_ANDROID_LS_EXTENSION_DIR = nativeExtensionDir;
        nativeProjectDir = await copyAndroidLintFixture(nativeSandbox);
        nativeDriver = await startLspClient(nativeProjectDir, nativeSandbox);

        await executeIntellij(
          { action: 'wait', project: nativeProjectDir, timeout: 180 },
          undefined,
          undefined,
          { cwd: nativeProjectDir } as ExtensionContext,
          { systemPath: nativeSandbox.systemPath },
        );

        // Verify capabilities: diagnosticProvider declared
        const initCapabilities = nativeDriver.initResult?.capabilities;
        assert.ok(
          Boolean(initCapabilities?.diagnosticProvider),
          'Native server must declare diagnosticProvider capability',
        );

        // Open an XML with syntax error
        const syntaxErrorUri = pathToFileURL(
          join(nativeProjectDir, 'app', 'src', 'main', 'res', 'layout', 'native_syntax_err.xml'),
        ).href;
        const badXmlText = [
          '<?xml version="1.0" encoding="utf-8"?>',
          '<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"',
          '    android:layout_width="match_parent"',
          '    android:layout_height="match_parent">',
          '    <TextView',
          '        android:layout_width="wrap_content"',
          '        android:layout_height="wrap_content"',
          '        android:text="Native syntax test"',
          '</LinearLayout>',
          '',
        ].join('\n');

        nativeDriver.notify('textDocument/didOpen', {
          textDocument: { uri: syntaxErrorUri, languageId: 'xml', version: 1, text: badXmlText },
        });

        try {
          const report = await pullDiagnostics(nativeDriver, syntaxErrorUri);
          const items = report.items ?? [];
          const nativeErrors = items.filter((d: LspDiagnostic) => d.source !== 'android-lint');
          const lintErrors = items.filter((d: LspDiagnostic) => d.source === 'android-lint');

          assert.ok(nativeErrors.length >= 1, 'Native server must report XML syntax error');
          assert.equal(
            lintErrors.length,
            0,
            'Native session without extension must emit zero android-lint diagnostics',
          );
        } finally {
          nativeDriver.notify('textDocument/didClose', { textDocument: { uri: syntaxErrorUri } });
        }

        // Open manifest with debuggable="true" in native session
        const nativeManifestUri = pathToFileURL(
          join(nativeProjectDir, 'app', 'config', 'manifest-main.xml'),
        ).href;
        const nativeManifestContent = (
          await readFile(fileURLToPath(nativeManifestUri), 'utf8')
        ).replace('<application', '<application android:debuggable="true"');

        nativeDriver.notify('textDocument/didOpen', {
          textDocument: {
            uri: nativeManifestUri,
            languageId: 'xml',
            version: 1,
            text: nativeManifestContent,
          },
        });

        try {
          const report = await pullDiagnostics(nativeDriver, nativeManifestUri);
          const items = report.items ?? [];
          const lintErrors = items.filter((d: LspDiagnostic) => d.source === 'android-lint');
          assert.equal(
            lintErrors.length,
            0,
            'Native session without extension must emit zero HardcodedDebugMode diagnostics',
          );
        } finally {
          nativeDriver.notify('textDocument/didClose', {
            textDocument: { uri: nativeManifestUri },
          });
        }
      } finally {
        if (nativeDriver) {
          try {
            await nativeDriver.close();
          } catch {
            // ignore
          }
        }
        await nativeSandbox.cleanup();
      }
    },
  );

  // 2. Full XML & Manifest Lint acceptance suite in isolated session (WITH extension)
  const sandbox = await createIntegrationSandbox(prereqs);
  let projectDir = '';
  let driver: InitializedLspClientDriver | null = null;

  try {
    projectDir = await copyAndroidLintFixture(sandbox);
    const client = await startLspClient(projectDir, sandbox);
    driver = client;

    await executeIntellij(
      { action: 'wait', project: projectDir, timeout: 180 },
      undefined,
      undefined,
      { cwd: projectDir } as ExtensionContext,
      { systemPath: sandbox.systemPath },
    );

    const initCapabilities = client.initResult?.capabilities;
    assert.ok(
      Boolean(initCapabilities?.diagnosticProvider),
      'Server initialize response must declare diagnosticProvider capability',
    );

    // 2. Official XML/Manifest rules positive trigger, exact ranges, and didChange fix
    await t.test(
      'Diagnostics: Official XML/Manifest rules positive trigger, exact ranges, and didChange fix',
      async () => {
        // A. Layout HardcodedText
        const layoutUri = pathToFileURL(
          join(projectDir, 'app', 'src', 'main', 'res', 'layout', 'layout_probe.xml'),
        ).href;
        const layoutText1 = await readFile(fileURLToPath(layoutUri), 'utf8');

        client.notify('textDocument/didOpen', {
          textDocument: { uri: layoutUri, languageId: 'xml', version: 1, text: layoutText1 },
        });

        try {
          const rep1 = await pullDiagnostics(client, layoutUri);
          assert.equal(rep1.kind, 'full');
          const items1 = rep1.items ?? [];
          const hardcoded1 = items1.filter(
            (d: LspDiagnostic) => d.source === 'android-lint' && d.code === 'HardcodedText',
          );
          assert.ok(hardcoded1.length >= 1, 'Must report HardcodedText for hardcoded string');
          assert.equal(hardcoded1[0].severity, 2, 'HardcodedText severity must be Warning (2)');

          const expectedAttrRange = findRangeInText(
            layoutText1,
            'android:text="Hardcoded String Text"',
          );
          const match = hardcoded1.find(
            (d: LspDiagnostic) =>
              d.range.start.line === expectedAttrRange.start.line &&
              d.range.start.character === expectedAttrRange.start.character &&
              d.range.end.line === expectedAttrRange.end.line &&
              d.range.end.character === expectedAttrRange.end.character,
          );
          assert.ok(
            match,
            `HardcodedText range must strictly match the full attribute: ${JSON.stringify(hardcoded1)}`,
          );
          // Fix via didChange
          const layoutText2 = layoutText1.replace('Hardcoded String Text', '@string/app_name');
          client.notify('textDocument/didChange', {
            textDocument: { uri: layoutUri, version: 2 },
            contentChanges: [{ text: layoutText2 }],
          });

          const rep2 = await pullDiagnostics(client, layoutUri);
          const items2 = rep2.items ?? [];
          const hardcoded2 = items2.filter(
            (d: LspDiagnostic) => d.source === 'android-lint' && d.code === 'HardcodedText',
          );
          assert.equal(
            hardcoded2.length,
            0,
            'HardcodedText must be cleared after replacing with resource reference',
          );
        } finally {
          client.notify('textDocument/didClose', { textDocument: { uri: layoutUri } });
        }

        // B. Layout ContentDescription
        const imageUri = pathToFileURL(
          join(projectDir, 'app', 'src', 'main', 'res', 'layout', 'layout_image_probe.xml'),
        ).href;
        const imageText1 = await readFile(fileURLToPath(imageUri), 'utf8');

        client.notify('textDocument/didOpen', {
          textDocument: { uri: imageUri, languageId: 'xml', version: 1, text: imageText1 },
        });

        try {
          const repImg1 = await pullDiagnostics(client, imageUri);
          const itemsImg1 = repImg1.items ?? [];
          const contentDesc1 = itemsImg1.filter(
            (d: LspDiagnostic) => d.source === 'android-lint' && d.code === 'ContentDescription',
          );
          assert.ok(
            contentDesc1.length >= 1,
            'Must report ContentDescription for ImageView without description',
          );
          assert.equal(
            contentDesc1[0].severity,
            2,
            'ContentDescription severity must be Warning (2)',
          );

          // Fix via didChange
          const imageText2 = imageText1.replace(
            '<ImageView',
            '<ImageView android:contentDescription="@string/app_name"',
          );
          client.notify('textDocument/didChange', {
            textDocument: { uri: imageUri, version: 2 },
            contentChanges: [{ text: imageText2 }],
          });

          const repImg2 = await pullDiagnostics(client, imageUri);
          const itemsImg2 = repImg2.items ?? [];
          const contentDesc2 = itemsImg2.filter(
            (d: LspDiagnostic) => d.source === 'android-lint' && d.code === 'ContentDescription',
          );
          assert.equal(
            contentDesc2.length,
            0,
            'ContentDescription must be cleared after adding attribute',
          );
        } finally {
          client.notify('textDocument/didClose', { textDocument: { uri: imageUri } });
        }

        // C. Manifest HardcodedDebugMode
        const manifestUri = pathToFileURL(
          join(projectDir, 'app', 'config', 'manifest-main.xml'),
        ).href;
        const baseManifest = await readFile(fileURLToPath(manifestUri), 'utf8');
        const manifestWithDebug = baseManifest.replace(
          '<application',
          '<application android:debuggable="true"',
        );

        client.notify('textDocument/didOpen', {
          textDocument: {
            uri: manifestUri,
            languageId: 'xml',
            version: 1,
            text: manifestWithDebug,
          },
        });

        try {
          const repMan1 = await pullDiagnostics(client, manifestUri);
          const itemsMan1 = repMan1.items ?? [];
          assert.equal(
            itemsMan1.some(
              (d) =>
                d.source === 'android-lint' &&
                d.code === 'MissingClass' &&
                d.message?.includes('com.example.app.MainApplication'),
            ),
            false,
            'Custom source Manifest checks must resolve classes in the selected production module',
          );
          const debug1 = itemsMan1.filter(
            (d: LspDiagnostic) => d.source === 'android-lint' && d.code === 'HardcodedDebugMode',
          );
          assert.ok(
            debug1.length >= 1,
            `Must report HardcodedDebugMode for android:debuggable="true": ${JSON.stringify(itemsMan1)}`,
          );
          assert.equal(
            debug1[0].severity,
            1,
            'HardcodedDebugMode severity must be Error/Fatal (1)',
          );

          const expectedDebugRange = findRangeInText(
            manifestWithDebug,
            'android:debuggable="true"',
          );
          const debugMatch = debug1.find(
            (d: LspDiagnostic) =>
              d.range.start.line === expectedDebugRange.start.line &&
              d.range.start.character === expectedDebugRange.start.character &&
              d.range.end.line === expectedDebugRange.end.line &&
              d.range.end.character === expectedDebugRange.end.character,
          );
          assert.ok(
            debugMatch,
            `HardcodedDebugMode range must strictly match android:debuggable="true": ${JSON.stringify(debug1)}`,
          );
          // Fix via didChange
          client.notify('textDocument/didChange', {
            textDocument: { uri: manifestUri, version: 2 },
            contentChanges: [{ text: baseManifest }],
          });

          const repMan2 = await pullDiagnostics(client, manifestUri);
          const itemsMan2 = repMan2.items ?? [];
          const debug2 = itemsMan2.filter(
            (d: LspDiagnostic) => d.source === 'android-lint' && d.code === 'HardcodedDebugMode',
          );
          assert.equal(
            debug2.length,
            0,
            'HardcodedDebugMode must be cleared after removing attribute',
          );
        } finally {
          client.notify('textDocument/didClose', { textDocument: { uri: manifestUri } });
        }
      },
    );

    // 3. Folder families, qualified/custom roots, variant/library manifests, and non-Android exclusions
    await t.test(
      'Diagnostics: Folder families, qualified/custom roots, variant/library manifests, and non-Android exclusions',
      async () => {
        const unusedDefault = join(projectDir, 'app', 'src', 'main', 'AndroidManifest.xml');
        const unusedUri = pathToFileURL(unusedDefault).href;
        const unusedText =
          '<manifest xmlns:android="http://schemas.android.com/apk/res/android">' +
          '<application android:debuggable="true" /></manifest>';
        await writeFile(unusedDefault, unusedText, 'utf8');
        client.notify('textDocument/didOpen', {
          textDocument: { uri: unusedUri, languageId: 'xml', version: 1, text: unusedText },
        });
        try {
          const unused = await pullDiagnostics(client, unusedUri);
          assert.equal(
            (unused.items ?? []).filter((d) => d.source === 'android-lint').length,
            0,
            'A default Manifest replaced by manifest.srcFile must remain outside the configured source set',
          );
        } finally {
          client.notify('textDocument/didClose', { textDocument: { uri: unusedUri } });
          await rm(unusedDefault);
        }
        for (const resourcePath of [
          ['src', 'main', 'res', 'layout-land', 'namespace_probe.xml'],
          ['src', 'main', 'res', 'values-es', 'namespace_probe.xml'],
          ['src', 'main', 'res', 'drawable-night', 'namespace_probe.xml'],
          ['src', 'main', 'res', 'menu-land', 'namespace_probe.xml'],
          ['src', 'main', 'res', 'xml-v26', 'namespace_probe.xml'],
          ['custom-res', 'values', 'namespace_probe.xml'],
        ]) {
          const path = join(projectDir, 'app', ...resourcePath);
          await mkdir(dirname(path), { recursive: true });
          const root =
            resourcePath.includes('values') || resourcePath.includes('values-es')
              ? 'resources'
              : resourcePath.includes('menu-land')
                ? 'menu'
                : resourcePath.includes('drawable-night')
                  ? 'shape'
                  : 'LinearLayout';
          const text = `<${root} xmlns:unused="http://schemas.android.com/apk/res/com.example.unused" />`;
          await writeFile(path, text, 'utf8');
          const uri = pathToFileURL(path).href;
          client.notify('textDocument/didOpen', {
            textDocument: { uri, languageId: 'xml', version: 1, text },
          });
          try {
            const positive = await pullDiagnostics(client, uri);
            const unused = (positive.items ?? []).filter(
              (d) => d.source === 'android-lint' && d.code === 'UnusedNamespace',
            );
            assert.equal(
              unused.length,
              1,
              `Official namespace rule must run for ${resourcePath.join('/')}: ${JSON.stringify(positive.items)}`,
            );
            assert.deepEqual(
              unused[0].range,
              findRangeInText(
                text,
                'xmlns:unused="http://schemas.android.com/apk/res/com.example.unused"',
              ),
            );
            client.notify('textDocument/didChange', {
              textDocument: { uri, version: 2 },
              contentChanges: [{ text: `<${root} />` }],
            });
            const negative = await pullDiagnostics(client, uri);
            assert.equal(
              (negative.items ?? []).filter(
                (d) => d.source === 'android-lint' && d.code === 'UnusedNamespace',
              ).length,
              0,
              `Removing the unused namespace must clear ${resourcePath.join('/')}`,
            );
          } finally {
            client.notify('textDocument/didClose', { textDocument: { uri } });
            await rm(path);
          }
        }
        // A. Menu folder: res/menu/sample_menu.xml
        const menuUri = pathToFileURL(
          join(projectDir, 'app', 'src', 'main', 'res', 'menu', 'sample_menu.xml'),
        ).href;
        const menuText = await readFile(fileURLToPath(menuUri), 'utf8');
        client.notify('textDocument/didOpen', {
          textDocument: { uri: menuUri, languageId: 'xml', version: 1, text: menuText },
        });
        try {
          const repMenu = await pullDiagnostics(client, menuUri);
          const menuItems = repMenu.items ?? [];
          const menuHardcoded = menuItems.filter(
            (d: LspDiagnostic) => d.source === 'android-lint' && d.code === 'HardcodedText',
          );
          assert.ok(
            menuHardcoded.length >= 1,
            'Menu title must trigger HardcodedText in res/menu folder',
          );
        } finally {
          client.notify('textDocument/didClose', { textDocument: { uri: menuUri } });
        }

        // B. Qualified root: res/values-es/strings.xml
        const esUri = pathToFileURL(
          join(projectDir, 'app', 'src', 'main', 'res', 'values-es', 'strings.xml'),
        ).href;
        const esText = await readFile(fileURLToPath(esUri), 'utf8');
        client.notify('textDocument/didOpen', {
          textDocument: { uri: esUri, languageId: 'xml', version: 1, text: esText },
        });
        try {
          const repEs = await pullDiagnostics(client, esUri);
          assert.equal(repEs.kind, 'full');
        } finally {
          client.notify('textDocument/didClose', { textDocument: { uri: esUri } });
        }

        // C. Custom resource root: app/custom-res/values/custom.xml
        const customResUri = pathToFileURL(
          join(projectDir, 'app', 'custom-res', 'values', 'custom.xml'),
        ).href;
        const customResText = await readFile(fileURLToPath(customResUri), 'utf8');
        client.notify('textDocument/didOpen', {
          textDocument: { uri: customResUri, languageId: 'xml', version: 1, text: customResText },
        });
        try {
          const repCustom = await pullDiagnostics(client, customResUri);
          assert.equal(repCustom.kind, 'full');
        } finally {
          client.notify('textDocument/didClose', { textDocument: { uri: customResUri } });
        }

        // D. Variant manifest: app/src/debug/AndroidManifest.xml
        const debugManifestUri = pathToFileURL(
          join(projectDir, 'app', 'src', 'debug', 'AndroidManifest.xml'),
        ).href;
        const debugManifestText = await readFile(fileURLToPath(debugManifestUri), 'utf8');
        client.notify('textDocument/didOpen', {
          textDocument: {
            uri: debugManifestUri,
            languageId: 'xml',
            version: 1,
            text: debugManifestText,
          },
        });
        try {
          const repDebug = await pullDiagnostics(client, debugManifestUri);
          assert.equal(repDebug.kind, 'full');
        } finally {
          client.notify('textDocument/didClose', { textDocument: { uri: debugManifestUri } });
        }

        // E. Library manifest: lib/src/main/AndroidManifest.xml
        const libManifestUri = pathToFileURL(
          join(projectDir, 'lib', 'src', 'main', 'AndroidManifest.xml'),
        ).href;
        const libManifestText = (await readFile(fileURLToPath(libManifestUri), 'utf8')).replace(
          '</manifest>',
          '<application android:debuggable="true" /></manifest>',
        );
        client.notify('textDocument/didOpen', {
          textDocument: {
            uri: libManifestUri,
            languageId: 'xml',
            version: 1,
            text: libManifestText,
          },
        });
        try {
          const repLib = await pullDiagnostics(client, libManifestUri);
          assert.equal(repLib.kind, 'full');
          assert.ok(
            (repLib.items ?? []).some(
              (d) => d.source === 'android-lint' && d.code === 'HardcodedDebugMode',
            ),
            `Library manifests must run official single-file checks: ${JSON.stringify(repLib.items)}`,
          );
        } finally {
          client.notify('textDocument/didClose', { textDocument: { uri: libManifestUri } });
        }

        // F. Applicability exclusion: res/raw/reference_raw.xml
        const rawUri = pathToFileURL(
          join(projectDir, 'app', 'src', 'main', 'res', 'raw', 'reference_raw.xml'),
        ).href;
        const rawText = '<raw-data hardcoded="Raw Value Text" />';
        client.notify('textDocument/didOpen', {
          textDocument: { uri: rawUri, languageId: 'xml', version: 1, text: rawText },
        });
        try {
          const repRaw = await pullDiagnostics(client, rawUri);
          const rawLint = (repRaw.items ?? []).filter(
            (d: LspDiagnostic) => d.source === 'android-lint',
          );
          assert.equal(
            rawLint.length,
            0,
            'res/raw files must not be analyzed by layout or values detectors',
          );
        } finally {
          client.notify('textDocument/didClose', { textDocument: { uri: rawUri } });
        }

        // G. Plain non-Android XML: app/plain_doc.xml
        const plainUri = pathToFileURL(join(projectDir, 'app', 'plain_doc.xml')).href;
        const plainText = await readFile(fileURLToPath(plainUri), 'utf8');
        client.notify('textDocument/didOpen', {
          textDocument: { uri: plainUri, languageId: 'xml', version: 1, text: plainText },
        });
        try {
          const repPlain = await pullDiagnostics(client, plainUri);
          const plainLint = (repPlain.items ?? []).filter(
            (d: LspDiagnostic) => d.source === 'android-lint',
          );
          assert.equal(
            plainLint.length,
            0,
            'Plain XML outside Android resource roots must emit zero android-lint diagnostics',
          );
        } finally {
          client.notify('textDocument/didClose', { textDocument: { uri: plainUri } });
        }
      },
    );

    // 4. Newly saved XML file analyzed on disk
    await t.test('Diagnostics: Newly saved XML file analyzed on disk', async () => {
      const newSavedPath = join(
        projectDir,
        'app',
        'src',
        'main',
        'res',
        'layout',
        'new_saved_layout.xml',
      );
      const newSavedUri = pathToFileURL(newSavedPath).href;

      const newSavedText1 = [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"',
        '    android:layout_width="match_parent"',
        '    android:layout_height="match_parent"',
        '    android:orientation="vertical">',
        '    <TextView',
        '        android:layout_width="wrap_content"',
        '        android:layout_height="wrap_content"',
        '        android:text="Newly Saved Hardcoded Text" />',
        '</LinearLayout>',
        '',
      ].join('\n');

      await writeFile(newSavedPath, newSavedText1, 'utf8');

      client.notify('textDocument/didOpen', {
        textDocument: { uri: newSavedUri, languageId: 'xml', version: 1, text: newSavedText1 },
      });

      try {
        const rep1 = await pullDiagnostics(client, newSavedUri);
        assert.equal(rep1.kind, 'full');
        const items1 = rep1.items ?? [];
        const hardcoded1 = items1.filter(
          (d: LspDiagnostic) => d.source === 'android-lint' && d.code === 'HardcodedText',
        );
        assert.ok(hardcoded1.length >= 1, 'Newly saved XML file must trigger HardcodedText');

        // Modify via didChange
        const newSavedText2 = newSavedText1.replace(
          'Newly Saved Hardcoded Text',
          '@string/app_name',
        );
        client.notify('textDocument/didChange', {
          textDocument: { uri: newSavedUri, version: 2 },
          contentChanges: [{ text: newSavedText2 }],
        });

        const rep2 = await pullDiagnostics(client, newSavedUri);
        const items2 = rep2.items ?? [];
        const hardcoded2 = items2.filter(
          (d: LspDiagnostic) => d.source === 'android-lint' && d.code === 'HardcodedText',
        );
        assert.equal(
          hardcoded2.length,
          0,
          'HardcodedText must be cleared in saved file after didChange fix',
        );
      } finally {
        client.notify('textDocument/didClose', { textDocument: { uri: newSavedUri } });
        if (existsSync(newSavedPath)) await rm(newSavedPath);
      }
    });

    // 5. Position and range accuracy for CRLF, emoji, entities, quotes, multiline, CDATA, and namespace alias
    await t.test(
      'Diagnostics: Position and range accuracy for CRLF, emoji, entities, quotes, multiline, CDATA, and namespace alias',
      async () => {
        const edgeUri = pathToFileURL(
          join(projectDir, 'app', 'src', 'main', 'res', 'layout', 'layout_edge_probe.xml'),
        ).href;
        const baseEdgeText = await readFile(fileURLToPath(edgeUri), 'utf8');
        // Ensure CRLF line endings
        const edgeText = baseEdgeText.replace(/\r?\n/g, '\r\n');

        client.notify('textDocument/didOpen', {
          textDocument: { uri: edgeUri, languageId: 'xml', version: 1, text: edgeText },
        });

        try {
          const rep = await pullDiagnostics(client, edgeUri);
          const items = rep.items ?? [];
          const hardcodedList = items.filter(
            (d: LspDiagnostic) => d.source === 'android-lint' && d.code === 'HardcodedText',
          );
          assert.ok(
            hardcodedList.length >= 4,
            `Must report multiple HardcodedText for edge cases: found ${hardcodedList.length}`,
          );
          const assertExactEdge = (attrSnippet: string, label: string) => {
            const attrR = findRangeInText(edgeText, attrSnippet.replace(/\r?\n/g, '\r\n'));
            const m = hardcodedList.find(
              (d) =>
                d.range.start.line === attrR.start.line &&
                d.range.start.character === attrR.start.character &&
                d.range.end.line === attrR.end.line &&
                d.range.end.character === attrR.end.character,
            );
            assert.ok(
              m,
              `${label} must strictly match the full attribute: ${JSON.stringify(hardcodedList)}`,
            );
          };

          assertExactEdge('android:text="Emoji 👋 probe 🎉"', 'Emoji UTF-16 code units range');
          assertExactEdge('android:text="Entity &amp; &lt; test"', 'XML entity range');
          assertExactEdge("android:text='Single quote hardcoded'", 'Single quote range');
          assertExactEdge(
            'android:text="Multi\nLine\nHardcoded"',
            'Multiline CRLF attribute range',
          );
          assertExactEdge(
            'customalias:text="Alias Hardcoded Text"',
            'Custom namespace alias range',
          );
        } finally {
          client.notify('textDocument/didClose', { textDocument: { uri: edgeUri } });
        }
      },
    );

    // 6. Incomplete XML retains native syntax errors and tolerates partial AST without crash
    await t.test(
      'Diagnostics: Incomplete XML retains native syntax errors and tolerates partial AST without crash',
      async () => {
        const incompleteUri = pathToFileURL(
          join(projectDir, 'app', 'src', 'main', 'res', 'layout', 'layout_incomplete_probe.xml'),
        ).href;
        const brokenXmlText = [
          '<?xml version="1.0" encoding="utf-8"?>',
          '<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"',
          '    android:layout_width="match_parent"',
          '    android:layout_height="match_parent">',
          '    <ImageView android:layout_width="wrap_content" android:layout_height="wrap_content" />',
          '    <TextView',
          '        android:layout_width="wrap_content"',
          '        android:layout_height="wrap_content"',
          '        android:text="Incomplete Broken Text"',
          '</LinearLayout>',
          '',
        ].join('\n');
        await writeFile(fileURLToPath(incompleteUri), brokenXmlText, 'utf8');

        client.notify('textDocument/didOpen', {
          textDocument: { uri: incompleteUri, languageId: 'xml', version: 1, text: brokenXmlText },
        });

        try {
          const rep = await pullDiagnostics(client, incompleteUri);
          const items = rep.items ?? [];
          const nativeErrors = items.filter((d: LspDiagnostic) => d.source !== 'android-lint');
          assert.ok(
            nativeErrors.length >= 1,
            'Native syntax error must be reported for incomplete unclosed XML tag',
          );
          assert.ok(
            items.some((d) => d.source === 'android-lint' && d.code === 'ContentDescription'),
            'Recovered valid nodes must retain Android Lint diagnostics alongside native syntax errors',
          );

          // Fix syntax error via didChange
          const fixedXmlText = brokenXmlText.replace(
            'android:text="Incomplete Broken Text"',
            'android:text="Incomplete Broken Text" />',
          );
          client.notify('textDocument/didChange', {
            textDocument: { uri: incompleteUri, version: 2 },
            contentChanges: [{ text: fixedXmlText }],
          });

          const repFixed = await pullDiagnostics(client, incompleteUri);
          const fixedNative = (repFixed.items ?? []).filter(
            (d: LspDiagnostic) => d.source !== 'android-lint' && d.severity === 1,
          );
          assert.equal(
            fixedNative.length,
            0,
            'Native syntax errors must be cleared after fixing tag',
          );
        } finally {
          client.notify('textDocument/didClose', { textDocument: { uri: incompleteUri } });
          await rm(fileURLToPath(incompleteUri), { force: true });
        }
      },
    );

    // 7. tools:ignore suppression with namespace aliases, multiple issues, ancestor inheritance, and strict sibling isolation
    await t.test(
      'Diagnostics: tools:ignore suppression with namespace aliases, multiple issues, ancestor inheritance, and strict sibling isolation',
      async () => {
        const ignoreUri = pathToFileURL(
          join(projectDir, 'app', 'src', 'main', 'res', 'layout', 'layout_ignore_probe.xml'),
        ).href;
        const ignoreText = await readFile(fileURLToPath(ignoreUri), 'utf8');

        client.notify('textDocument/didOpen', {
          textDocument: { uri: ignoreUri, languageId: 'xml', version: 1, text: ignoreText },
        });

        try {
          const rep = await pullDiagnostics(client, ignoreUri);
          const items = rep.items ?? [];
          const hardcodedList = items.filter(
            (d: LspDiagnostic) => d.source === 'android-lint' && d.code === 'HardcodedText',
          );
          const contentDescList = items.filter(
            (d: LspDiagnostic) => d.source === 'android-lint' && d.code === 'ContentDescription',
          );

          // 1. Element 1 with t:ignore="HardcodedText" is suppressed
          const ignoredMatch = hardcodedList.find((d) =>
            d.message?.includes('Ignored Hardcoded Text'),
          );
          assert.equal(
            ignoredMatch,
            undefined,
            'Element with t:ignore="HardcodedText" must be suppressed',
          );

          // 2. Element 2 (Sibling): MUST NOT BE SUPPRESSED! Sibling isolation!
          const siblingMatch = hardcodedList.find(
            (d) =>
              d.range.start.line ===
              findRangeInText(ignoreText, 'Not Ignored Sibling Text').start.line,
          );
          assert.ok(
            siblingMatch,
            'Sibling element without tools:ignore must NOT be suppressed (sibling isolation)',
          );

          // 3. Ancestor with t:ignore="HardcodedText,ContentDescription" suppresses both issues on children
          const ancestorTextMatch = hardcodedList.find((d) =>
            d.message?.includes('Ancestor Ignored Text'),
          );
          assert.equal(
            ancestorTextMatch,
            undefined,
            'Child of ancestor with multiple tools:ignore must be suppressed',
          );
          assert.equal(
            contentDescList.length,
            0,
            'ImageView inside ancestor with ContentDescription ignore must be suppressed',
          );
        } finally {
          client.notify('textDocument/didClose', { textDocument: { uri: ignoreUri } });
        }
      },
    );

    // 8. API level preconditions, tools:targetApi exemption, and folder qualifier minSdk
    await t.test(
      'Diagnostics: API level preconditions, tools:targetApi exemption, and folder qualifier minSdk',
      async () => {
        const apiLayoutUri = pathToFileURL(
          join(projectDir, 'app', 'src', 'main', 'res', 'layout', 'layout_api_probe.xml'),
        ).href;
        const apiLayoutText = await readFile(fileURLToPath(apiLayoutUri), 'utf8');

        client.notify('textDocument/didOpen', {
          textDocument: { uri: apiLayoutUri, languageId: 'xml', version: 1, text: apiLayoutText },
        });

        try {
          // API 26 tooltipText in layout with minSdk=21 triggers API warning/error
          const rep1 = await pullDiagnostics(client, apiLayoutUri);
          const items1 = rep1.items ?? [];
          const apiIssues1 = items1.filter(
            (d: LspDiagnostic) => d.source === 'android-lint' && d.code === 'UnusedAttribute',
          );
          assert.equal(
            apiIssues1.length,
            1,
            `API 26 tooltipText must produce UnusedAttribute with minSdk 21: ${JSON.stringify(items1)}`,
          );
          const scriptPath = join(projectDir, 'app', 'build.gradle.kts');
          const scriptUri = pathToFileURL(scriptPath).href;
          const scriptText = await readFile(scriptPath, 'utf8');
          client.notify('textDocument/didOpen', {
            textDocument: {
              uri: scriptUri,
              languageId: 'kotlin',
              version: 1,
              text: scriptText.replace('minSdk = 21', 'minSdk = 26'),
            },
          });
          try {
            const associatedEdit = await pullDiagnostics(client, apiLayoutUri);
            assert.equal(
              (associatedEdit.items ?? []).filter(
                (d) => d.source === 'android-lint' && d.code === 'UnusedAttribute',
              ).length,
              1,
              'Unsaved associated Gradle settings must not change the saved XML model',
            );
          } finally {
            client.notify('textDocument/didClose', { textDocument: { uri: scriptUri } });
          }

          // Now suppress with tools:targetApi="26"
          const apiLayoutTextSuppressed = apiLayoutText.replace(
            '<TextView',
            '<TextView tools:targetApi="26"',
          );
          client.notify('textDocument/didChange', {
            textDocument: { uri: apiLayoutUri, version: 2 },
            contentChanges: [{ text: apiLayoutTextSuppressed }],
          });

          const rep2 = await pullDiagnostics(client, apiLayoutUri);
          const items2 = rep2.items ?? [];
          const apiIssues2 = items2.filter(
            (d: LspDiagnostic) => d.source === 'android-lint' && d.code === 'UnusedAttribute',
          );
          assert.equal(
            apiIssues2.length,
            0,
            'tools:targetApi="26" must exempt API 26 attribute from API checks',
          );
        } finally {
          client.notify('textDocument/didClose', { textDocument: { uri: apiLayoutUri } });
        }

        // Folder qualifier -v26: res/layout-v26/layout_api_probe.xml
        const v26LayoutUri = pathToFileURL(
          join(projectDir, 'app', 'src', 'main', 'res', 'layout-v26', 'layout_api_probe.xml'),
        ).href;
        const v26Text = await readFile(fileURLToPath(v26LayoutUri), 'utf8');
        client.notify('textDocument/didOpen', {
          textDocument: { uri: v26LayoutUri, languageId: 'xml', version: 1, text: v26Text },
        });

        try {
          const repV26 = await pullDiagnostics(client, v26LayoutUri);
          const itemsV26 = repV26.items ?? [];
          const apiIssuesV26 = itemsV26.filter(
            (d: LspDiagnostic) => d.source === 'android-lint' && d.code === 'UnusedAttribute',
          );
          assert.equal(
            apiIssuesV26.length,
            0,
            'Layout in -v26 folder must implicitly have minSdk>=26 and not flag API 26 attributes',
          );
        } finally {
          client.notify('textDocument/didClose', { textDocument: { uri: v26LayoutUri } });
        }
      },
    );

    // 9. lint.xml configuration override (ignore and error severity)
    await t.test(
      'Diagnostics: lint.xml configuration override (ignore and error severity)',
      async () => {
        const lintXmlPath = join(projectDir, 'app', 'lint.xml');
        const probeUri = pathToFileURL(
          join(projectDir, 'app', 'src', 'main', 'res', 'layout', 'layout_probe.xml'),
        ).href;
        const probeText = await readFile(fileURLToPath(probeUri), 'utf8');

        client.notify('textDocument/didOpen', {
          textDocument: { uri: probeUri, languageId: 'xml', version: 1, text: probeText },
        });

        try {
          // Initial: HardcodedText is Warning (2)
          const repInit = await pullDiagnostics(client, probeUri);
          const initHardcoded = (repInit.items ?? []).filter(
            (d) => d.source === 'android-lint' && d.code === 'HardcodedText',
          );
          assert.ok(initHardcoded.length >= 1);
          assert.equal(initHardcoded[0].severity, 2);

          // Override to ignore
          await writeFile(
            lintXmlPath,
            '<?xml version="1.0" encoding="UTF-8"?>\n<lint>\n    <issue id="HardcodedText" severity="ignore" />\n</lint>\n',
            'utf8',
          );

          // Trigger check with new version
          client.notify('textDocument/didChange', {
            textDocument: { uri: probeUri, version: 2 },
            contentChanges: [{ text: `${probeText}\n` }],
          });

          const repIgnored = await pullDiagnostics(client, probeUri);
          const ignoredHardcoded = (repIgnored.items ?? []).filter(
            (d) => d.source === 'android-lint' && d.code === 'HardcodedText',
          );
          assert.equal(
            ignoredHardcoded.length,
            0,
            'lint.xml severity="ignore" must suppress HardcodedText',
          );

          // Override to error
          await writeFile(
            lintXmlPath,
            '<?xml version="1.0" encoding="UTF-8"?>\n<lint>\n    <issue id="HardcodedText" severity="error" />\n</lint>\n',
            'utf8',
          );

          client.notify('textDocument/didChange', {
            textDocument: { uri: probeUri, version: 3 },
            contentChanges: [{ text: probeText }],
          });

          const repError = await pullDiagnostics(client, probeUri);
          const errorHardcoded = (repError.items ?? []).filter(
            (d) => d.source === 'android-lint' && d.code === 'HardcodedText',
          );
          assert.ok(errorHardcoded.length >= 1);
          assert.equal(
            errorHardcoded[0].severity,
            1,
            'lint.xml severity="error" must elevate HardcodedText to Error (1)',
          );
        } finally {
          if (existsSync(lintXmlPath)) await rm(lintXmlPath);
          client.notify('textDocument/didClose', { textDocument: { uri: probeUri } });
        }
      },
    );

    // 10. Resource repository scopes, precedence, framework/library resolution, and linked unsaved edits
    await t.test(
      'Diagnostics: Resource repository scopes, precedence, framework/library resolution, and linked unsaved edits',
      async () => {
        const aarUri = pathToFileURL(
          join(projectDir, 'app', 'src', 'main', 'res', 'layout', 'layout_aar_probe.xml'),
        ).href;
        const aarText = await readFile(fileURLToPath(aarUri), 'utf8');

        client.notify('textDocument/didOpen', {
          textDocument: { uri: aarUri, languageId: 'xml', version: 1, text: aarText },
        });

        try {
          const rep = await pullDiagnostics(client, aarUri);
          const items = rep.items ?? [];
          const repoQueryMsg = items.find(
            (d: LspDiagnostic) =>
              d.source === 'android-lint' &&
              d.code === 'CustomXmlRule' &&
              d.message?.includes('CustomRepoQuery:'),
          );
          assert.ok(
            repoQueryMsg,
            `CustomRepoQuery detector must report repository availability: ${JSON.stringify(items)}`,
          );
          assert.match(
            repoQueryMsg.message ?? '',
            /app_name=Android XML Fixture/,
            'PROJECT_ONLY repository must resolve app_name to Android XML Fixture',
          );
          assert.match(
            repoQueryMsg.message ?? '',
            /projHasLib=false/,
            'PROJECT_ONLY repository must not resolve dependency lib_name',
          );
          assert.match(
            repoQueryMsg.message ?? '',
            /lib_name=Android XML Lib/,
            'LOCAL_DEPENDENCIES repository must resolve dependency lib_name',
          );
          assert.match(
            repoQueryMsg.message ?? '',
            /hasOk=true/,
            'ANDROID framework repository must resolve framework resource ok',
          );
          assert.match(
            repoQueryMsg.message ?? '',
            /count=2/,
            'Qualifier overlay must resolve count=2 for app_name across default and es',
          );

          // Saved resource edit on disk triggers cache invalidation on the SAME layout
          const stringsPath = join(
            projectDir,
            'app',
            'src',
            'main',
            'res',
            'values',
            'strings.xml',
          );
          const stringsBaseText = await readFile(stringsPath, 'utf8');
          const stringsUri = pathToFileURL(stringsPath).href;
          client.notify('textDocument/didOpen', {
            textDocument: {
              uri: stringsUri,
              languageId: 'xml',
              version: 1,
              text: stringsBaseText.replace('Android XML Fixture', 'Unrelated Unsaved Title'),
            },
          });
          try {
            const unsavedReport = await pullDiagnostics(client, aarUri);
            const unsavedQuery = (unsavedReport.items ?? []).find(
              (d) =>
                d.source === 'android-lint' &&
                d.code === 'CustomXmlRule' &&
                d.message?.includes('CustomRepoQuery:'),
            );
            assert.match(
              unsavedQuery?.message ?? '',
              /app_name=Android XML Fixture/,
              'An unsaved associated document must not replace the resource disk snapshot',
            );
            const stringsDiskModified = stringsBaseText.replace(
              'Android XML Fixture',
              'Live On-Disk Updated Title',
            );
            await writeFile(stringsPath, stringsDiskModified, 'utf8');
            try {
              const repLive = await pullDiagnostics(client, aarUri);
              const liveItems = repLive.items ?? [];
              const liveQueryMsg = liveItems.find(
                (d: LspDiagnostic) =>
                  d.source === 'android-lint' &&
                  d.code === 'CustomXmlRule' &&
                  d.message?.includes('CustomRepoQuery:'),
              );
              assert.ok(
                liveQueryMsg,
                `Resource refresh must retain query diagnostics: ${JSON.stringify(liveItems)}`,
              );
              assert.match(
                liveQueryMsg.message ?? '',
                /app_name=Live On-Disk Updated Title/,
                'A disk edit must refresh the same layout while the associated editor remains unsaved',
              );
            } finally {
              await writeFile(stringsPath, stringsBaseText, 'utf8');
            }
          } finally {
            client.notify('textDocument/didClose', { textDocument: { uri: stringsUri } });
          }

          const libraryStringsPath = join(
            projectDir,
            'lib',
            'src',
            'main',
            'res',
            'values',
            'strings.xml',
          );
          const libraryStrings = await readFile(libraryStringsPath, 'utf8');
          try {
            await writeFile(
              libraryStringsPath,
              libraryStrings.replace('Android XML Lib', 'Updated Dependency Title'),
              'utf8',
            );
            const dependencyReport = await pullDiagnostics(client, aarUri);
            const dependencyQuery = (dependencyReport.items ?? []).find(
              (d) =>
                d.source === 'android-lint' &&
                d.code === 'CustomXmlRule' &&
                d.message?.includes('CustomRepoQuery:'),
            );
            assert.match(
              dependencyQuery?.message ?? '',
              /lib_name=Updated Dependency Title/,
              'Editing an existing dependency values file must invalidate the consuming layout cache',
            );
          } finally {
            await writeFile(libraryStringsPath, libraryStrings, 'utf8');
          }
        } finally {
          client.notify('textDocument/didClose', { textDocument: { uri: aarUri } });
        }
      },
    );

    await t.test('Diagnostics: Source Manifest and workspace isolation', async () => {
      // A. Variant manifest isolation
      const debugManifestUri = pathToFileURL(
        join(projectDir, 'app', 'src', 'debug', 'AndroidManifest.xml'),
      ).href;
      const debugManifestText = await readFile(fileURLToPath(debugManifestUri), 'utf8');
      const debugWithHardcoded = debugManifestText.replace(
        '<application>',
        '<application android:debuggable="true">',
      );

      client.notify('textDocument/didOpen', {
        textDocument: {
          uri: debugManifestUri,
          languageId: 'xml',
          version: 1,
          text: debugWithHardcoded,
        },
      });

      const mainManifestUri = pathToFileURL(
        join(projectDir, 'app', 'config', 'manifest-main.xml'),
      ).href;
      const mainManifestText = await readFile(fileURLToPath(mainManifestUri), 'utf8');
      client.notify('textDocument/didOpen', {
        textDocument: {
          uri: mainManifestUri,
          languageId: 'xml',
          version: 1,
          text: mainManifestText,
        },
      });

      try {
        const debugRep = await pullDiagnostics(client, debugManifestUri);
        const debugLint = (debugRep.items ?? []).filter(
          (d) => d.source === 'android-lint' && d.code === 'HardcodedDebugMode',
        );
        assert.ok(debugLint.length >= 1, 'Debug variant manifest must report HardcodedDebugMode');

        const mainRep = await pullDiagnostics(client, mainManifestUri);
        const mainLint = (mainRep.items ?? []).filter(
          (d) => d.source === 'android-lint' && d.code === 'HardcodedDebugMode',
        );
        assert.equal(
          mainLint.length,
          0,
          'Main manifest must not leak HardcodedDebugMode from variant manifest',
        );
      } finally {
        client.notify('textDocument/didClose', { textDocument: { uri: debugManifestUri } });
        client.notify('textDocument/didClose', { textDocument: { uri: mainManifestUri } });
      }

      // B. Two Workspaces isolation
      const workspace2 = await createIntegrationSandbox(prereqs);
      const workspace2Dir = await copyAndroidLintFixture(workspace2);
      let client2: InitializedLspClientDriver | null = null;
      try {
        client2 = await startLspClient(workspace2Dir, workspace2);
        await executeIntellij(
          { action: 'wait', project: workspace2Dir, timeout: 180 },
          undefined,
          undefined,
          { cwd: workspace2Dir } as ExtensionContext,
          { systemPath: workspace2.systemPath },
        );
        const ws1ProbeUri = pathToFileURL(
          join(projectDir, 'app', 'src', 'main', 'res', 'layout', 'layout_probe.xml'),
        ).href;
        const ws2ProbeUri = pathToFileURL(
          join(workspace2Dir, 'app', 'src', 'main', 'res', 'layout', 'layout_probe.xml'),
        ).href;
        const probeContent = await readFile(fileURLToPath(ws1ProbeUri), 'utf8');

        // In workspace 1, create lint.xml to ignore HardcodedText
        const ws1LintXml = join(projectDir, 'app', 'lint.xml');
        await writeFile(
          ws1LintXml,
          '<?xml version="1.0" encoding="UTF-8"?>\n<lint>\n    <issue id="HardcodedText" severity="ignore" />\n</lint>\n',
          'utf8',
        );

        client.notify('textDocument/didOpen', {
          textDocument: { uri: ws1ProbeUri, languageId: 'xml', version: 1, text: probeContent },
        });
        client2.notify('textDocument/didOpen', {
          textDocument: { uri: ws2ProbeUri, languageId: 'xml', version: 1, text: probeContent },
        });

        try {
          const repWs1 = await pullDiagnostics(client, ws1ProbeUri);
          const hardcodedWs1 = (repWs1.items ?? []).filter(
            (d) => d.source === 'android-lint' && d.code === 'HardcodedText',
          );
          assert.equal(
            hardcodedWs1.length,
            0,
            'Workspace 1 must ignore HardcodedText per its local lint.xml',
          );

          const repWs2 = await pullDiagnostics(client2, ws2ProbeUri);
          const hardcodedWs2 = (repWs2.items ?? []).filter(
            (d) => d.source === 'android-lint' && d.code === 'HardcodedText',
          );
          assert.ok(
            hardcodedWs2.length >= 1,
            'Workspace 2 must NOT inherit Workspace 1 lint.xml suppression (workspace isolation)',
          );
        } finally {
          if (existsSync(ws1LintXml)) await rm(ws1LintXml);
          client.notify('textDocument/didClose', { textDocument: { uri: ws1ProbeUri } });
          client2.notify('textDocument/didClose', { textDocument: { uri: ws2ProbeUri } });
        }
      } finally {
        if (client2) {
          try {
            await client2.close();
          } catch {
            // ignore
          }
        }
        await workspace2.cleanup();
      }
    });

    // 12. AAR custom XML rule execution, node visit fault isolation, cancellation, and concurrency
    await t.test(
      'Diagnostics: AAR custom XML rule execution, node visit fault isolation, cancellation, and concurrency',
      async () => {
        const aarProbeUri = pathToFileURL(
          join(projectDir, 'app', 'src', 'main', 'res', 'layout', 'layout_aar_probe.xml'),
        ).href;
        const aarProbeText = await readFile(fileURLToPath(aarProbeUri), 'utf8');

        client.notify('textDocument/didOpen', {
          textDocument: { uri: aarProbeUri, languageId: 'xml', version: 1, text: aarProbeText },
        });

        try {
          // A. Fault isolation: CorruptXmlNode node visit linkage fault does not prevent sibling rules
          const rep = await pullDiagnostics(client, aarProbeUri);
          const items = rep.items ?? [];
          const customXml = items.filter(
            (d: LspDiagnostic) =>
              d.source === 'android-lint' &&
              d.code === 'CustomXmlRule' &&
              d.message?.includes('CustomXmlView'),
          );
          assert.ok(
            customXml.length >= 1,
            'CustomXmlRule on CustomXmlView must report despite CorruptXmlNode fault in same file',
          );

          const hardcoded = items.filter(
            (d: LspDiagnostic) => d.source === 'android-lint' && d.code === 'HardcodedText',
          );
          assert.ok(
            hardcoded.length >= 1,
            'HardcodedText on sibling TextView must report despite CorruptXmlNode fault',
          );
          const repeated = await pullDiagnostics(client, aarProbeUri);
          const repeatedCustom = (repeated.items ?? []).find(
            (d) =>
              d.source === 'android-lint' &&
              d.code === 'CustomXmlRule' &&
              d.message?.includes('CustomXmlView'),
          );
          assert.equal(
            repeatedCustom?.message,
            customXml[0].message,
            'An unchanged XML pull must reuse the result without visiting the custom detector again',
          );
          client.notify('textDocument/didChange', {
            textDocument: { uri: aarProbeUri, version: 2 },
            contentChanges: [{ text: `${aarProbeText}\n` }],
          });
          const rechecked = await pullDiagnostics(client, aarProbeUri);
          const recheckedCustom = (rechecked.items ?? []).find(
            (d) =>
              d.source === 'android-lint' &&
              d.code === 'CustomXmlRule' &&
              d.message?.includes('CustomXmlView'),
          );
          assert.ok(recheckedCustom);
          assert.notEqual(
            recheckedCustom.message,
            customXml[0].message,
            'A changed XML snapshot must actually visit the detector again',
          );

          // B. In-flight cancellation recovery on XML diagnostic
          const cancelId = 73737;
          client.process.stdin?.write(
            encode({
              jsonrpc: '2.0',
              id: cancelId,
              method: 'textDocument/diagnostic',
              params: { textDocument: { uri: aarProbeUri } },
            }),
          );
          client.notify('$/cancelRequest', { id: cancelId });
          const cancelMsg = await client.waitFor(
            (m: { id?: number | string }) => m.id === cancelId,
            15000,
          );
          assert.ok(cancelMsg, 'Cancel message response must be received');
          assert.equal(
            cancelMsg.error?.code,
            -32800,
            'In-flight cancellation of XML diagnostic must return -32800',
          );

          // Recovery after cancel
          const repAfterCancel = await pullDiagnostics(client, aarProbeUri);
          assert.equal(
            repAfterCancel.kind,
            'full',
            'Server must recover and serve XML diagnostics after cancellation',
          );

          // C. Concurrent didChange recovery
          const concurrentId = 64646;
          const modifiedAarText = aarProbeText.replace(
            'android:text="Fault Sibling Text"',
            'android:text="@string/app_name"',
          );
          client.process.stdin?.write(
            encode({
              jsonrpc: '2.0',
              id: concurrentId,
              method: 'textDocument/diagnostic',
              params: { textDocument: { uri: aarProbeUri } },
            }),
          );
          client.notify('textDocument/didChange', {
            textDocument: { uri: aarProbeUri, version: 3 },
            contentChanges: [{ text: modifiedAarText }],
          });

          const concurrentMsg = await client.waitFor(
            (m: { id?: number | string }) => m.id === concurrentId,
            15000,
          );
          assert.ok(concurrentMsg, 'Concurrent request response must be received');
          if (concurrentMsg.error) {
            assert.equal(
              concurrentMsg.error.code,
              -32801,
              'Concurrent didChange during XML analysis must return -32801 (content_modified)',
            );
          }

          const repFinal = await pullDiagnostics(client, aarProbeUri);
          assert.equal(repFinal.kind, 'full');
          const finalHardcoded = (repFinal.items ?? []).filter(
            (d: LspDiagnostic) => d.source === 'android-lint' && d.code === 'HardcodedText',
          );
          assert.equal(
            finalHardcoded.length,
            0,
            'Diagnostics must reflect updated content after concurrent didChange',
          );
        } finally {
          client.notify('textDocument/didClose', { textDocument: { uri: aarProbeUri } });
        }
      },
    );
    await t.test(
      'Diagnostics: Official AGP merged Manifest source ranges and stale snapshot fallback',
      async () => {
        const java = join(
          prereqs.jdk21Path,
          'bin',
          process.platform === 'win32' ? 'java.exe' : 'java',
        );
        const path = join(projectDir, 'app', 'config', 'manifest-main.xml');
        const text = await readFile(path, 'utf8');
        const uri = pathToFileURL(path).href;
        await writeFile(path, text, 'utf8');
        client.notify('textDocument/didOpen', {
          textDocument: { uri, languageId: 'xml', version: 1, text },
        });
        try {
          const clean = await pullDiagnostics(client, uri);
          const cleanSnapshot = (clean.items ?? []).find(
            (d) => d.source === 'android-lint' && d.code === 'CustomManifestRule',
          );
          assert.match(cleanSnapshot?.message ?? '', /ManifestSnapshot: merged=false;/);
          const build = spawnSync(
            java,
            [
              '-cp',
              join(projectDir, 'gradle', 'wrapper', 'gradle-wrapper.jar'),
              'org.gradle.wrapper.GradleWrapperMain',
              ':app:processDebugManifest',
              '--offline',
              '--daemon',
              '--rerun-tasks',
            ],
            { cwd: projectDir, env: sandbox.env, encoding: 'utf8', timeout: 180000 },
          );
          assert.equal(
            build.status,
            0,
            `Manifest Merger must run successfully:\n${build.stdout}\n${build.stderr}`,
          );
          const built = await pullDiagnostics(client, uri);
          const snapshot = (built.items ?? []).find(
            (d) => d.source === 'android-lint' && d.code === 'CustomManifestRule',
          );
          assert.ok(
            snapshot,
            `Merged Manifest diagnostic must map to its source: ${JSON.stringify(built.items)}`,
          );
          assert.match(snapshot.message ?? '', /ManifestSnapshot: merged=true;/);
          assert.deepEqual(
            snapshot.range,
            findRangeInText(text, 'android:label="@string/app_name"'),
          );

          const edited = text.replace(
            'android:label="@string/app_name"',
            'android:label="Unsaved Label"',
          );
          client.notify('textDocument/didChange', {
            textDocument: { uri, version: 2 },
            contentChanges: [{ text: edited }],
          });
          const unsaved = await pullDiagnostics(client, uri);
          const local = (unsaved.items ?? []).find(
            (d) => d.source === 'android-lint' && d.code === 'CustomManifestRule',
          );
          assert.match(local?.message ?? '', /ManifestSnapshot: merged=false; label=Unsaved Label/);
          assert.deepEqual(local?.range, findRangeInText(edited, 'android:label="Unsaved Label"'));
          client.notify('textDocument/didClose', { textDocument: { uri } });

          await writeFile(path, edited, 'utf8');
          client.notify('textDocument/didOpen', {
            textDocument: { uri, languageId: 'xml', version: 1, text: edited },
          });
          const stale = await pullDiagnostics(client, uri);
          const fallback = (stale.items ?? []).find(
            (d) => d.source === 'android-lint' && d.code === 'CustomManifestRule',
          );
          assert.match(
            fallback?.message ?? '',
            /ManifestSnapshot: merged=false; label=Unsaved Label/,
            'A saved source newer than merger output must invalidate the built snapshot',
          );
        } finally {
          client.notify('textDocument/didClose', { textDocument: { uri } });
          await writeFile(path, text, 'utf8');
        }
      },
    );
  } finally {
    if (driver) {
      try {
        await driver.close();
      } catch {
        // Ignore close failure
      }
    }
    await sandbox.cleanup();
  }
});
