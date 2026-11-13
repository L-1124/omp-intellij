import assert from 'node:assert/strict';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { executeIntellij } from '../../src/extension/intellij-tool.js';
import { canonicalizeProject } from '../../src/project/metadata.js';
import { setWorkspaceJdk } from '../../src/project/workspace.js';
import type { ExtensionContext } from '../../src/shared/extension-types.js';
import {
  copyWorkspaceFixture,
  createDapClientDriver,
  createIntegrationSandbox,
  createLspClientDriver,
  type IntegrationSandbox,
  isProcessAlive,
  seedSandboxProjectConfig,
  verifyPrerequisites,
} from './fixture.js';
import { createNativeAndroidClient, type NativeAndroidClient } from './native-android-client.js';
import { createOmpHostDriver, type OmpHostDriver } from './omp-host-client.js';

const prerequisites = await verifyPrerequisites();

async function getFreePort(): Promise<number> {
  const server = net.createServer();
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const addr = server.address() as net.AddressInfo;
    const port = addr.port;
    server.close((err) => (err ? reject(err) : resolve(port)));
  });
  return promise;
}

async function prepareJUnitRepository(sandbox: IntegrationSandbox): Promise<string> {
  const repoDir = join(sandbox.sandboxDir, 'local-m2');
  const junitDir = join(repoDir, 'junit', 'junit', '4.13.2');
  const hamcrestDir = join(repoDir, 'org', 'hamcrest', 'hamcrest-core', '1.3');
  await mkdir(junitDir, { recursive: true });
  await mkdir(hamcrestDir, { recursive: true });

  const cacheRoots = [
    process.env.GRADLE_USER_HOME,
    process.env.OMP_INTELLIJ_TEST_GRADLE_CACHE,
    join(homedir(), '.gradle'),
  ].filter((dir): dir is string => typeof dir === 'string' && dir.length > 0);
  let cachedJunitJar = '';
  let cachedHamcrestJar = '';
  for (const root of cacheRoots) {
    const gradleModulesCache = join(root, 'caches', 'modules-2', 'files-2.1');
    const junitJarCandidate = join(
      gradleModulesCache,
      'junit',
      'junit',
      '4.13.2',
      '8ac9e16d933b6fb43bc7f576336b8f4d7eb5ba12',
      'junit-4.13.2.jar',
    );
    const hamcrestJarCandidate = join(
      gradleModulesCache,
      'org.hamcrest',
      'hamcrest-core',
      '1.3',
      '42a25dc3219429f0e5d060061f71acb49bf010a0',
      'hamcrest-core-1.3.jar',
    );
    if (existsSync(junitJarCandidate) && existsSync(hamcrestJarCandidate)) {
      cachedJunitJar = junitJarCandidate;
      cachedHamcrestJar = hamcrestJarCandidate;
      break;
    }
  }
  if (existsSync(cachedJunitJar) && existsSync(cachedHamcrestJar)) {
    await cp(cachedJunitJar, join(junitDir, 'junit-4.13.2.jar'));
    await cp(cachedHamcrestJar, join(hamcrestDir, 'hamcrest-core-1.3.jar'));
    await writeFile(
      join(junitDir, 'junit-4.13.2.pom'),
      `<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>junit</groupId>
  <artifactId>junit</artifactId>
  <version>4.13.2</version>
  <dependencies>
    <dependency>
      <groupId>org.hamcrest</groupId>
      <artifactId>hamcrest-core</artifactId>
      <version>1.3</version>
    </dependency>
  </dependencies>
</project>`,
      'utf8',
    );
    await writeFile(
      join(hamcrestDir, 'hamcrest-core-1.3.pom'),
      `<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>org.hamcrest</groupId>
  <artifactId>hamcrest-core</artifactId>
  <version>1.3</version>
</project>`,
      'utf8',
    );
  }
  return repoDir;
}

test('multi-module Maven reactor & Gradle: model inspection (sourceRoots, SDKs, libraries) and disambiguated module launch', async () => {
  const sandbox = await createIntegrationSandbox(prerequisites);

  try {
    const rootDir = await copyWorkspaceFixture('jdk21', sandbox);

    const alphaMainDir = join(rootDir, 'alpha', 'src', 'main', 'java', 'com', 'example');
    const betaMainDir = join(rootDir, 'beta', 'src', 'main', 'java', 'com', 'example');
    const betaIntDir = join(rootDir, 'beta', 'src', 'integrationTest', 'java', 'com', 'example');
    await mkdir(alphaMainDir, { recursive: true });
    await mkdir(betaMainDir, { recursive: true });
    await mkdir(betaIntDir, { recursive: true });

    await writeFile(
      join(rootDir, 'settings.gradle'),
      "rootProject.name = 'multi-proj'\ninclude ':alpha', ':beta'\n",
      'utf8',
    );
    await writeFile(
      join(rootDir, 'build.gradle'),
      `subprojects {
    apply plugin: 'java'
    java {
        toolchain {
            languageVersion = JavaLanguageVersion.of(21)
        }
    }
    tasks.withType(JavaCompile).configureEach {
        options.release = 21
    }
}
`,
      'utf8',
    );
    await writeFile(
      join(rootDir, 'alpha', 'build.gradle'),
      `plugins {
    id 'application'
}
application {
    mainClass = 'com.example.Main'
}
`,
      'utf8',
    );
    await writeFile(
      join(rootDir, 'beta', 'build.gradle'),
      `plugins {
    id 'application'
}
sourceSets {
    integrationTest {
        java.srcDir file('src/integrationTest/java')
        compileClasspath += sourceSets.main.output + configurations.testRuntimeClasspath
        runtimeClasspath += output + compileClasspath
    }
}
dependencies {
    implementation project(':alpha')
}
application {
    mainClass = 'com.example.Main'
}
`,
      'utf8',
    );

    const alphaSharedFile = join(alphaMainDir, 'SharedCodec.java');
    const alphaMainFile = join(alphaMainDir, 'Main.java');
    const betaMainFile = join(betaMainDir, 'Main.java');
    const betaIntFile = join(betaIntDir, 'BetaIntegration.java');

    await writeFile(
      alphaSharedFile,
      'package com.example;\npublic class SharedCodec {\n  public static String encode(String v) { return "ALPHA_" + v; }\n}\n',
      'utf8',
    );
    await writeFile(
      alphaMainFile,
      'package com.example;\nimport java.nio.file.Paths;\npublic class Main {\n  public static void main(String[] args) {\n    System.out.println("DISAMBIG_ALPHA=" + Paths.get("").toAbsolutePath().getFileName());\n  }\n}\n',
      'utf8',
    );
    await writeFile(
      betaMainFile,
      'package com.example;\nimport java.nio.file.Paths;\npublic class Main {\n  public static void main(String[] args) {\n    System.out.println("DISAMBIG_BETA=" + Paths.get("").toAbsolutePath().getFileName() + ":" + SharedCodec.encode("OK"));\n  }\n}\n',
      'utf8',
    );
    await writeFile(
      betaIntFile,
      'package com.example;\npublic class BetaIntegration {\n  public static String check() { return SharedCodec.encode("INT"); }\n}\n',
      'utf8',
    );

    const [alphaModelRes, betaModelRes, betaIntModelRes] = [
      await executeIntellij(
        { action: 'model', project: rootDir, file: alphaMainFile, timeout: 120 },
        undefined,
        undefined,
        { cwd: rootDir } as ExtensionContext,
        { systemPath: sandbox.systemPath, configDir: sandbox.configDir },
      ),
      await executeIntellij(
        { action: 'model', project: rootDir, file: betaMainFile, timeout: 120 },
        undefined,
        undefined,
        { cwd: rootDir } as ExtensionContext,
        { systemPath: sandbox.systemPath, configDir: sandbox.configDir },
      ),
      await executeIntellij(
        { action: 'model', project: rootDir, file: betaIntFile, timeout: 120 },
        undefined,
        undefined,
        { cwd: rootDir } as ExtensionContext,
        { systemPath: sandbox.systemPath, configDir: sandbox.configDir },
      ),
    ];

    assert.equal(alphaModelRes.isError, false, alphaModelRes.content[0]?.text);
    assert.equal(betaModelRes.isError, false, betaModelRes.content[0]?.text);
    assert.equal(betaIntModelRes.isError, false, betaIntModelRes.content[0]?.text);

    const alphaModel = alphaModelRes.details?.model;
    const betaModel = betaModelRes.details?.model;
    const betaIntModel = betaIntModelRes.details?.model;
    assert.ok(alphaModel && betaModel && betaIntModel, 'All three models must be resolved');

    assert.match(alphaModel.moduleName ?? '', /alpha\.main$/);
    assert.match(betaModel.moduleName ?? '', /beta\.main$/);
    assert.match(betaIntModel.moduleName ?? '', /beta\.integrationTest$/);

    assert.ok(
      alphaModel.moduleSourceRoots?.some((r) =>
        r.path.replace(/\\/g, '/').endsWith('alpha/src/main/java'),
      ),
      `Expected alpha sourceRoots in ${JSON.stringify(alphaModel.moduleSourceRoots)}`,
    );
    assert.ok(
      betaIntModel.moduleSourceRoots?.some((r) =>
        r.path.replace(/\\/g, '/').endsWith('beta/src/integrationTest/java'),
      ),
      `Expected beta integrationTest sourceRoots in ${JSON.stringify(betaIntModel.moduleSourceRoots)}`,
    );
    assert.ok(
      (alphaModel.sdks?.length ?? 0) > 0,
      'Exported workspace model must report configured SDKs',
    );
    assert.equal(typeof alphaModel.libraryCount, 'number');

    // Inspection reports registered build tooling and imported structure only. Runtime
    // classpath and build argv are resolved at execution time, so they must be absent here.
    for (const model of [alphaModel, betaModel, betaIntModel]) {
      assert.equal('classpath' in model, false, 'Inspection must not claim a runtime classpath');
      assert.equal('javaExec' in model, false, 'Inspection must not claim a JVM executable');
      assert.equal('buildCommand' in model, false, 'Inspection must not claim build argv');
      assert.equal('workingDirectory' in model, false);
      assert.equal(
        model.supported,
        model.buildTool !== undefined,
        `supported must mirror the registered build tool: ${JSON.stringify(model.buildTool)}`,
      );
      if (model.buildTool !== undefined) {
        assert.match(model.buildTool, /^(gradle|maven)$/);
      }
    }
    assert.ok(
      alphaModel.moduleContentPaths?.some((root) => root.replace(/\\/g, '/').includes('/alpha')),
      `Alpha content roots must belong to the alpha module: ${JSON.stringify(alphaModel.moduleContentPaths)}`,
    );
    assert.ok(
      betaIntModel.moduleContentPaths?.some((root) => root.replace(/\\/g, '/').includes('/beta')),
      `Beta integrationTest content roots must belong to the beta module: ${JSON.stringify(betaIntModel.moduleContentPaths)}`,
    );

    const dapAlpha = createDapClientDriver(rootDir, sandbox);
    await dapAlpha.request('initialize', { clientID: 'test-multi-alpha', adapterID: 'intellij' });
    await dapAlpha.request('launch', {
      file: alphaMainFile,
      project: rootDir,
      noDebug: true,
      build: true,
      mainClass: 'com.example.Main',
    });
    await dapAlpha.request('configurationDone');
    await dapAlpha.waitForOutputSubstring('DISAMBIG_ALPHA=alpha', 45000);
    await dapAlpha.close();

    const dapBeta = createDapClientDriver(rootDir, sandbox);
    await dapBeta.request('initialize', { clientID: 'test-multi-beta', adapterID: 'intellij' });
    await dapBeta.request('launch', {
      file: betaMainFile,
      project: rootDir,
      noDebug: true,
      build: true,
      mainClass: 'com.example.Main',
    });
    await dapBeta.request('configurationDone');
    await dapBeta.waitForOutputSubstring('DISAMBIG_BETA=beta:ALPHA_OK', 45000);
    await dapBeta.close();

    const mavenRoot = join(sandbox.workspacesDir, 'maven-reactor');
    const mvnAlphaSrc = join(mavenRoot, 'alpha', 'src', 'main', 'java', 'com', 'example');
    const mvnBetaSrc = join(mavenRoot, 'beta', 'src', 'main', 'java', 'com', 'example');
    await mkdir(mvnAlphaSrc, { recursive: true });
    await mkdir(mvnBetaSrc, { recursive: true });

    await seedSandboxProjectConfig(mavenRoot, sandbox);
    await writeFile(
      join(mavenRoot, 'pom.xml'),
      `<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>reactor-parent</artifactId>
  <version>1.0.0</version>
  <packaging>pom</packaging>
  <properties>
    <maven.compiler.source>21</maven.compiler.source>
    <maven.compiler.target>21</maven.compiler.target>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
  </properties>
  <modules>
    <module>alpha</module>
    <module>beta</module>
  </modules>
</project>`,
      'utf8',
    );
    await writeFile(
      join(mavenRoot, 'alpha', 'pom.xml'),
      `<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <parent>
    <groupId>com.example</groupId>
    <artifactId>reactor-parent</artifactId>
    <version>1.0.0</version>
  </parent>
  <artifactId>alpha</artifactId>
</project>`,
      'utf8',
    );
    await writeFile(
      join(mavenRoot, 'beta', 'pom.xml'),
      `<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <parent>
    <groupId>com.example</groupId>
    <artifactId>reactor-parent</artifactId>
    <version>1.0.0</version>
  </parent>
  <artifactId>beta</artifactId>
  <dependencies>
    <dependency>
      <groupId>com.example</groupId>
      <artifactId>alpha</artifactId>
      <version>1.0.0</version>
    </dependency>
  </dependencies>
</project>`,
      'utf8',
    );

    const mvnAlphaMain = join(mvnAlphaSrc, 'Main.java');
    const mvnBetaMain = join(mvnBetaSrc, 'Main.java');
    await writeFile(
      join(mvnAlphaSrc, 'ReactorShared.java'),
      'package com.example;\npublic class ReactorShared {\n  public static String tag() { return "MVN_SHARED_OK"; }\n}\n',
      'utf8',
    );
    await writeFile(
      mvnAlphaMain,
      'package com.example;\nimport java.nio.file.Paths;\npublic class Main {\n  public static void main(String[] args) {\n    System.out.println("MVN_ALPHA=" + Paths.get("").toAbsolutePath().getFileName());\n  }\n}\n',
      'utf8',
    );
    await writeFile(
      mvnBetaMain,
      'package com.example;\nimport java.nio.file.Paths;\npublic class Main {\n  public static void main(String[] args) {\n    System.out.println("MVN_BETA=" + Paths.get("").toAbsolutePath().getFileName() + ":" + ReactorShared.tag());\n  }\n}\n',
      'utf8',
    );

    const mvnAlphaModelRes = await executeIntellij(
      { action: 'model', project: mavenRoot, file: mvnAlphaMain, timeout: 120 },
      undefined,
      undefined,
      { cwd: mavenRoot } as ExtensionContext,
      { systemPath: sandbox.systemPath, configDir: sandbox.configDir },
    );
    const mvnBetaModelRes = await executeIntellij(
      { action: 'model', project: mavenRoot, file: mvnBetaMain, timeout: 120 },
      undefined,
      undefined,
      { cwd: mavenRoot } as ExtensionContext,
      { systemPath: sandbox.systemPath, configDir: sandbox.configDir },
    );
    assert.equal(mvnAlphaModelRes.isError, false, mvnAlphaModelRes.content[0]?.text);
    assert.equal(mvnBetaModelRes.isError, false, mvnBetaModelRes.content[0]?.text);
    const mvnAlphaModel = mvnAlphaModelRes.details?.model;
    const mvnBetaModel = mvnBetaModelRes.details?.model;
    assert.ok(mvnAlphaModel && mvnBetaModel);
    assert.match(mvnAlphaModel.moduleName ?? '', /alpha/);
    assert.match(mvnBetaModel.moduleName ?? '', /beta/);
    for (const model of [mvnAlphaModel, mvnBetaModel]) {
      assert.equal('classpath' in model, false);
      assert.equal('workingDirectory' in model, false);
      assert.ok(
        model.moduleSourceRoots?.some((root) =>
          root.path.replace(/\\/g, '/').endsWith('/src/main/java'),
        ),
        `Exported source roots must cover src/main/java: ${JSON.stringify(model.moduleSourceRoots)}`,
      );
    }
    assert.ok(
      mvnAlphaModel.moduleContentPaths?.some((root) => root.replace(/\\/g, '/').includes('/alpha')),
      `Alpha content roots must belong to the alpha module: ${JSON.stringify(mvnAlphaModel.moduleContentPaths)}`,
    );
    assert.ok(
      mvnBetaModel.moduleContentPaths?.some((root) => root.replace(/\\/g, '/').includes('/beta')),
      `Beta content roots must belong to the beta module: ${JSON.stringify(mvnBetaModel.moduleContentPaths)}`,
    );

    const dapMvnBeta = createDapClientDriver(mavenRoot, sandbox);
    await dapMvnBeta.request('initialize', { clientID: 'test-mvn-beta', adapterID: 'intellij' });
    await dapMvnBeta.request('launch', {
      file: mvnBetaMain,
      project: mavenRoot,
      noDebug: true,
      build: true,
      mainClass: 'com.example.Main',
    });
    await dapMvnBeta.request('configurationDone');
    await dapMvnBeta.waitForOutputSubstring('MVN_BETA=beta:MVN_SHARED_OK', 60000);
    await dapMvnBeta.close();
  } finally {
    await sandbox.cleanup();
  }
});

test('workspace reload: adding dependency jar and switching project JDK updates index, classpath, and runtime JVM', async () => {
  const sandbox = await createIntegrationSandbox(prerequisites);

  try {
    const projectDir = await copyWorkspaceFixture('jdk21', sandbox);
    const appSource = join(projectDir, 'src', 'main', 'java', 'com', 'example', 'App.java');

    const bridge = createLspClientDriver(projectDir, sandbox);
    await bridge.request('initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(projectDir).href,
      rootPath: projectDir,
      capabilities: { window: { workDoneProgress: true }, experimental: { licensingUi: true } },
    });
    bridge.notify('initialized', {});

    const initialWait = await executeIntellij(
      { action: 'wait', project: projectDir, timeout: 120 },
      undefined,
      undefined,
      { cwd: projectDir } as ExtensionContext,
      { systemPath: sandbox.systemPath, configDir: sandbox.configDir },
    );
    assert.equal(initialWait.details?.phase, 'ready');

    const initialModel = await executeIntellij(
      { action: 'model', project: projectDir, file: appSource, timeout: 120 },
      undefined,
      undefined,
      { cwd: projectDir } as ExtensionContext,
      { systemPath: sandbox.systemPath, configDir: sandbox.configDir },
    );
    assert.equal(initialModel.isError, false);
    const initialModelReport = initialModel.details?.model;
    assert.ok(initialModelReport);
    assert.equal(typeof initialModelReport.libraryCount, 'number');
    assert.ok(
      initialModelReport.moduleContentPaths?.some((root) => {
        const content = canonicalizeProject(root).canonicalPath;
        const project = canonicalizeProject(projectDir).canonicalPath;
        const source = canonicalizeProject(appSource).canonicalPath;
        return (
          (content === project || content.startsWith(`${project}/`)) &&
          source.startsWith(`${content}/`)
        );
      }),
      `Initial model must report a content root owning the source within the project: ${JSON.stringify(initialModelReport.moduleContentPaths)}`,
    );
    assert.ok(
      initialModelReport.moduleSourceRoots?.some((root) =>
        root.path.replace(/\\/g, '/').endsWith('src/main/java'),
      ),
      `Initial model must report the imported main source root: ${JSON.stringify(initialModelReport.moduleSourceRoots)}`,
    );
    for (const runtimeOnly of ['javaExec', 'classpath', 'modulePath', 'workingDirectory']) {
      assert.equal(runtimeOnly in initialModelReport, false);
    }

    const extSrcDir = join(sandbox.sandboxDir, 'ext-src', 'com', 'example', 'ext');
    const extClassesDir = join(sandbox.sandboxDir, 'ext-classes');
    const libsDir = join(projectDir, 'libs');
    await mkdir(extSrcDir, { recursive: true });
    await mkdir(extClassesDir, { recursive: true });
    await mkdir(libsDir, { recursive: true });

    const extJavaFile = join(extSrcDir, 'ReloadedDep.java');
    await writeFile(
      extJavaFile,
      'package com.example.ext;\npublic class ReloadedDep {\n  public static String banner() { return "RELOADED_JAR_OK"; }\n}\n',
      'utf8',
    );

    const javac17 = join(
      prerequisites.jdk17Path,
      'bin',
      process.platform === 'win32' ? 'javac.exe' : 'javac',
    );
    const jar17 = join(
      prerequisites.jdk17Path,
      'bin',
      process.platform === 'win32' ? 'jar.exe' : 'jar',
    );
    const extJarPath = join(libsDir, 'ext-reload-lib.jar');

    const compiled = spawnSync(javac17, ['--release', '17', '-d', extClassesDir, extJavaFile], {
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(compiled.status, 0, compiled.stderr);

    const packaged = spawnSync(
      jar17,
      ['--create', '--file', extJarPath, '-C', extClassesDir, '.'],
      {
        encoding: 'utf8',
        windowsHide: true,
      },
    );
    assert.equal(packaged.status, 0, packaged.stderr);

    await writeFile(
      join(projectDir, 'build.gradle'),
      `plugins {
    id 'application'
    id 'java'
}
java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(17)
    }
}
tasks.withType(JavaCompile).configureEach {
    options.release = 17
}
dependencies {
    implementation files('libs/ext-reload-lib.jar')
}
application {
    mainClass = 'com.example.App'
}
`,
      'utf8',
    );

    const updatedAppText = `package com.example;
import com.example.ext.ReloadedDep;
public class App {
    public static void main(String[] args) {
        System.out.println("RELOAD_VERIFY=" + ReloadedDep.banner() + ":JDK=" + Runtime.version().feature());
    }
}
`;
    await writeFile(appSource, updatedAppText, 'utf8');

    await setWorkspaceJdk(projectDir, prerequisites.jdk17Path, {
      configDir: join(sandbox.configDir, 'workspaces'),
    });

    const reloadResult = await executeIntellij(
      { action: 'reload', project: projectDir, timeout: 120 },
      undefined,
      undefined,
      { cwd: projectDir } as ExtensionContext,
      { systemPath: sandbox.systemPath, configDir: join(sandbox.configDir, 'workspaces') },
    );
    assert.equal(reloadResult.isError, false, reloadResult.content[0]?.text);
    assert.equal(reloadResult.details?.reloaded, true);
    assert.equal(reloadResult.details?.workspace?.isApplied, true);

    const appUri = pathToFileURL(appSource).href;
    bridge.notify('textDocument/didOpen', {
      textDocument: {
        uri: appUri,
        languageId: 'java',
        version: 1,
        text: updatedAppText,
      },
    });

    const dependencyReferenceLine = updatedAppText.split('\n')[4];
    const definitionResult = await bridge.request('textDocument/definition', {
      textDocument: { uri: appUri },
      position: { line: 4, character: dependencyReferenceLine.indexOf('ReloadedDep') + 2 },
    });
    const definition = Array.isArray(definitionResult) ? definitionResult[0] : definitionResult;
    assert.ok(definition && typeof definition === 'object', 'New dependency symbol must resolve');

    const reloadedModel = await executeIntellij(
      { action: 'model', project: projectDir, file: appSource, timeout: 120 },
      undefined,
      undefined,
      { cwd: projectDir } as ExtensionContext,
      { systemPath: sandbox.systemPath, configDir: join(sandbox.configDir, 'workspaces') },
    );
    assert.equal(reloadedModel.isError, false, reloadedModel.content[0]?.text);
    const reloadedModelReport = reloadedModel.details?.model;
    assert.ok(reloadedModelReport);
    assert.equal('classpath' in reloadedModelReport, false);
    assert.equal('javaExec' in reloadedModelReport, false);
    assert.equal(
      (reloadedModelReport.sdks ?? []).some((sdk) =>
        canonicalizeProject(sdk.homePath ?? '').canonicalPath.startsWith(
          canonicalizeProject(prerequisites.jdk17Path).canonicalPath,
        ),
      ),
      true,
      `Reloaded imported SDK must be JDK 17: ${JSON.stringify(reloadedModelReport.sdks)}`,
    );
    assert.equal(reloadedModelReport.buildTool, 'gradle');
    assert.equal(reloadedModelReport.supported, true);

    const dap = createDapClientDriver(projectDir, sandbox);
    await dap.request('initialize', { clientID: 'test-reload-run', adapterID: 'intellij' });
    await dap.request('launch', {
      file: appSource,
      project: projectDir,
      noDebug: true,
      build: true,
      mainClass: 'com.example.App',
    });
    await dap.request('configurationDone');
    await dap.waitForOutputSubstring('RELOAD_VERIFY=RELOADED_JAR_OK:JDK=17', 45000);
    await dap.close();
    await bridge.close();
  } finally {
    await sandbox.cleanup();
  }
});

test('Gradle subproject test debug: custom debugOptions port, --tests filter, DAP attach, breakpoint hit, and XML report [smoke]', async () => {
  const sandbox = await createIntegrationSandbox(prerequisites);

  try {
    const localM2 = await prepareJUnitRepository(sandbox);
    const rootDir = await copyWorkspaceFixture('jdk21', sandbox);
    const customDebugPort = await getFreePort();

    const subMainDir = join(rootDir, 'subproject', 'src', 'main', 'java', 'com', 'example');
    const subTestDir = join(rootDir, 'subproject', 'src', 'test', 'java', 'com', 'example');
    await mkdir(subMainDir, { recursive: true });
    await mkdir(subTestDir, { recursive: true });

    await writeFile(
      join(rootDir, 'settings.gradle'),
      "rootProject.name = 'gradle-debug-suite'\ninclude ':subproject'\n",
      'utf8',
    );
    const repoUri = pathToFileURL(localM2).href;
    await writeFile(
      join(rootDir, 'subproject', 'build.gradle'),
      `plugins {
    id 'java'
}
java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(21)
    }
}
repositories {
    maven { url = uri('${repoUri}') }
    mavenCentral()
}
dependencies {
    testImplementation 'junit:junit:4.13.2'
}
test {
    useJUnit()
    debugOptions {
        enabled = true
        port = ${customDebugPort}
        server = true
        suspend = true
    }
}
`,
      'utf8',
    );

    const calcFile = join(subMainDir, 'Calculator.java');
    const includedTestFile = join(subTestDir, 'IncludedDebugTest.java');
    const excludedTestFile = join(subTestDir, 'ExcludedDebugTest.java');

    await writeFile(
      calcFile,
      `package com.example;
public class Calculator {
    public static int compute(int base) {
        int doubled = base * 2;
        return doubled + 7;
    }
}
`,
      'utf8',
    );
    await writeFile(
      includedTestFile,
      `package com.example;
import org.junit.Assert;
import org.junit.Test;
public class IncludedDebugTest {
    @Test
    public void testFilteredDebug() {
        int result = Calculator.compute(10);
        Assert.assertEquals(27, result);
    }
}
`,
      'utf8',
    );
    await writeFile(
      excludedTestFile,
      `package com.example;
import org.junit.Assert;
import org.junit.Test;
public class ExcludedDebugTest {
    @Test
    public void testMustNotRun() {
        Assert.fail("ExcludedDebugTest should have been filtered out by --tests");
    }
}
`,
      'utf8',
    );

    const bridge = createLspClientDriver(rootDir, sandbox);
    await bridge.request('initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(rootDir).href,
      rootPath: rootDir,
      capabilities: { window: { workDoneProgress: true }, experimental: { licensingUi: true } },
    });
    bridge.notify('initialized', {});

    const indexed = await executeIntellij(
      { action: 'wait', project: rootDir, timeout: 120 },
      undefined,
      undefined,
      { cwd: rootDir } as ExtensionContext,
      { systemPath: sandbox.systemPath, configDir: sandbox.configDir },
    );
    assert.equal(indexed.details?.phase, 'ready');

    const javaExe = join(
      prerequisites.jdk21Path,
      'bin',
      process.platform === 'win32' ? 'java.exe' : 'java',
    );
    const wrapperJar = join(rootDir, 'gradle', 'wrapper', 'gradle-wrapper.jar');
    const gradleProc = spawn(
      javaExe,
      [
        '-cp',
        wrapperJar,
        'org.gradle.wrapper.GradleWrapperMain',
        ':subproject:test',
        '--tests',
        'com.example.IncludedDebugTest.*',
        '--info',
      ],
      {
        cwd: rootDir,
        env: sandbox.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    sandbox.trackProcess(gradleProc);

    const {
      promise: listeningReady,
      resolve: resolveListening,
      reject: rejectListening,
    } = Promise.withResolvers<void>();
    let gradleOutput = '';
    const onGradleData = (chunk: Buffer) => {
      gradleOutput += chunk.toString('utf8');
      if (gradleOutput.includes(`at address: ${customDebugPort}`)) {
        resolveListening();
      }
    };
    gradleProc.stdout?.on('data', onGradleData);
    gradleProc.stderr?.on('data', onGradleData);
    gradleProc.once('exit', (code) => {
      if (!gradleOutput.includes(`at address: ${customDebugPort}`)) {
        rejectListening(
          new Error(
            `Gradle exited early (${code}) before listening on ${customDebugPort}: ${gradleOutput}`,
          ),
        );
      }
    });

    await listeningReady;

    const dap = createDapClientDriver(rootDir, sandbox);
    await dap.request('initialize', { clientID: 'test-gradle-attach', adapterID: 'intellij' });
    await dap.request('setBreakpoints', {
      source: { path: calcFile },
      breakpoints: [{ line: 5 }],
    });

    const attachResp = await dap.request('attach', {
      project: rootDir,
      host: '127.0.0.1',
      port: customDebugPort,
      timeout: 20000,
    });
    assert.equal(attachResp.success, true);
    await dap.request('configurationDone');

    const stoppedEvent = await dap.waitForEvent('stopped', 30000);
    const threadId = (stoppedEvent.body as { threadId?: number })?.threadId ?? 1;

    const stackResp = await dap.request('stackTrace', {
      threadId,
      startFrame: 0,
      levels: 1,
    });
    const frames = (stackResp.body as { stackFrames?: Array<{ id: number; line: number }> })
      ?.stackFrames;
    assert.ok(frames && frames.length > 0, 'Top stack frame must be returned');
    const topFrameId = frames[0].id;

    const doubledVal = await dap.evaluate('doubled', topFrameId);
    assert.equal(String(doubledVal), '20');

    await dap.request('continue', { threadId });
    await dap.request('disconnect', { terminateDebuggee: false });
    await dap.waitForExit(15000);

    const { promise: gradleExitPromise, resolve: resolveGradleExit } = Promise.withResolvers<
      number | null
    >();
    if (gradleProc.exitCode !== null) {
      resolveGradleExit(gradleProc.exitCode);
    } else {
      gradleProc.once('exit', (code) => resolveGradleExit(code));
    }
    const gradleExitCode = await gradleExitPromise;
    assert.equal(
      gradleExitCode,
      0,
      `Expected Gradle test task to exit 0, output:\n${gradleOutput}`,
    );

    const includedReportPath = join(
      rootDir,
      'subproject',
      'build',
      'test-results',
      'test',
      'TEST-com.example.IncludedDebugTest.xml',
    );
    const excludedReportPath = join(
      rootDir,
      'subproject',
      'build',
      'test-results',
      'test',
      'TEST-com.example.ExcludedDebugTest.xml',
    );
    assert.equal(existsSync(includedReportPath), true, 'IncludedDebugTest XML report must exist');
    assert.equal(
      existsSync(excludedReportPath),
      false,
      'ExcludedDebugTest XML report must not exist when filtered out by --tests',
    );
    const xmlReport = await readFile(includedReportPath, 'utf8');
    assert.match(xmlReport, /tests="1"/);
    assert.match(xmlReport, /failures="0"/);
    assert.match(xmlReport, /errors="0"/);

    await bridge.close();
  } finally {
    await sandbox.cleanup();
  }
});

test('native Android DAP arguments: launch and attach traverse the official serializer before side effects', async () => {
  const sandbox = await createIntegrationSandbox(prerequisites);
  let native: NativeAndroidClient | undefined;
  try {
    const projectDirectory = await copyWorkspaceFixture('jdk21', sandbox);
    native = await createNativeAndroidClient({
      serverExecutable: prerequisites.serverExecutable,
      acceptedEulaHash: prerequisites.acceptedEulaHash,
      projectDirectory,
      jdk: prerequisites.jdk21Path,
      sandboxDirectory: sandbox.sandboxDir,
      extensionDirectory: resolve('resources/ils/271.2085.0/android.lsp'),
      env: sandbox.env,
      trackProcess: sandbox.trackProcess,
      trackSocket: sandbox.trackSocket,
    });
    for (const bootstrap of [{ nativePort: 1234 }, { host: '127.0.0.1' }, { unknown: true }]) {
      await assert.rejects(native.connectDap(bootstrap));
    }
    for (const command of ['launch', 'attach']) {
      for (const fields of [{}, { android: null }, { android: [] }, { android: {} }]) {
        const dap = await native.connectDap();
        try {
          const initialized = await dap.request('initialize', {
            clientID: 'generic-integration-client',
            adapterID: 'android',
            linesStartAt1: true,
            columnsStartAt1: true,
            pathFormat: 'path',
            supportsProgressReporting: true,
          });
          assert.equal(initialized.success, true, JSON.stringify(initialized));
          const response = await dap.request(command, fields);
          assert.equal(response.success, false, JSON.stringify(response));
          assert.match(response.message ?? '', /^\[invalid_params\] configuring: /);
          if ('android' in fields && fields.android !== null && !Array.isArray(fields.android)) {
            assert.equal(response.message, '[invalid_params] configuring: android.deviceId is required');
          }
          assert.equal(dap.messages.some((message) =>
            message.event === 'progressUpdate' &&
            /building|installing|starting|attaching/.test(String(message.body?.message)),
          ), false, 'Invalid arguments must fail before deployment');
          const disconnected = await dap.request('disconnect', { terminateDebuggee: false });
          assert.equal(disconnected.success, true, JSON.stringify(disconnected));
        } finally {
          dap.close();
        }
      }
    }
  } finally {
    try {
      await native?.close();
    } finally {
      await sandbox.cleanup();
    }
  }
});

test('OMP host JVM lifecycle: initial capabilities select disconnect and external attach preserves its target', async () => {
  const sandbox = await createIntegrationSandbox(prerequisites);
  let host: OmpHostDriver | undefined;
  let target: ChildProcess | undefined;
  try {
    const project = await copyWorkspaceFixture('jdk21', sandbox);
    const source = join(project, 'src/main/java/com/example/App.java');
    host = createOmpHostDriver({
      mode: 'launch',
      cwd: project,
      program: source,
      launchDefaults: { stopOnEntry: true },
    }, sandbox);
    const launched = await host.ready;
    assert.equal((launched.capabilities as Record<string, unknown>).supportsTerminateRequest, false);
    await host.close();
    assert.deepEqual((await host.closed).sessions, []);
    const classpath = join(project, 'build/classes/java/main');
    assert.ok(existsSync(join(classpath, 'com/example/App.class')));
    const port = await getFreePort();
    target = spawn(join(prerequisites.jdk21Path, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'), [
      `-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:${port}`,
      '-cp', classpath, 'com.example.App',
    ], { cwd: project, env: sandbox.env, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
    sandbox.trackProcess(target);
    const ready = Promise.withResolvers<void>();
    let targetOutput = '';
    target.stdout!.on('data', (chunk: Buffer) => {
      targetOutput = (targetOutput + chunk.toString()).slice(-4096);
      if (targetOutput.includes('HEARTBEAT_21=')) ready.resolve();
    });
    target.once('error', ready.reject);
    target.once('exit', (code) => ready.reject(new Error(`Fixture JVM exited before heartbeat: ${code}`)));
    // The external JVM heartbeat is outside the test clock.
    const timer = setTimeout(() => ready.reject(new Error('Fixture JVM did not report heartbeat')), 10000);
    try {
      await ready.promise;
    } finally {
      clearTimeout(timer);
    }
    host = createOmpHostDriver({ mode: 'attach', cwd: project, host: '127.0.0.1', port }, sandbox);
    await host.ready;
    await host.close();
    assert.ok(target.pid && isProcessAlive(target.pid), 'Real OMP host disconnect must preserve external JVM');
  } finally {
    try {
      await host?.close();
    } finally {
      try {
        if (target && target.exitCode === null && target.signalCode === null) {
          const exited = once(target, 'exit');
          target.kill();
          await exited;
        }
      } finally {
        await sandbox.cleanup();
      }
    }
  }
});
