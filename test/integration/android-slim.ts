import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { canonicalizeProject } from '../../src/project/metadata.js';
import type { IntegrationSandbox } from './fixture.js';

export async function runSlimAndroidAnalysis(
  sandbox: IntegrationSandbox,
  projectPath: string,
  layoutUri: string,
  expectedTestUri: string,
): Promise<void> {
  const sdk = dirname(dirname(sandbox.prerequisites.serverExecutable));
  const root = join(sandbox.sandboxDir, 'slim');
  const classes = resolve('jvm/intellij-android/build/classes/kotlin/test');
  const packagePath = join('org', 'jetbrains', 'android', 'testing', 'slim');
  const compiled = await readdir(join(classes, packagePath));
  const jar = join(
    sandbox.prerequisites.jdk21Path,
    'bin',
    process.platform === 'win32' ? 'jar.exe' : 'jar',
  );
  const jars: string[] = [];
  for (const name of ['AndroidSlimLauncher', 'AndroidSlimInvocation']) {
    const staging = join(root, name);
    await mkdir(join(staging, packagePath), { recursive: true });
    const selected = compiled.filter(
      (file) =>
        file === `${name}.class` ||
        file.startsWith(`${name}$`) ||
        (name === 'AndroidSlimInvocation' && file.startsWith('AndroidSlimPlugins')),
    );
    assert.ok(selected.length > 0, `Missing compiled ${name}`);
    for (const file of selected) {
      await copyFile(join(classes, packagePath, file), join(staging, packagePath, file));
    }
    if (name === 'AndroidSlimInvocation') {
      const services = join(staging, 'META-INF', 'services');
      await mkdir(services, { recursive: true });
      await writeFile(
        join(services, 'java.util.function.Consumer'),
        'org.jetbrains.android.testing.slim.AndroidSlimInvocation\n',
      );
      await writeFile(
        join(services, 'java.util.function.Supplier'),
        'org.jetbrains.android.testing.slim.AndroidSlimPlugins\n',
      );
    }
    const output = join(root, `${name}.jar`);
    const packed = spawnSync(jar, ['--create', '--file', output, '-C', staging, '.'], {
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
    });
    assert.equal(
      packed.status,
      0,
      `Cannot package ${name}: ${packed.error?.message ?? packed.stderr}`,
    );
    jars.push(output);
  }
  const product = JSON.parse(await readFile(join(sdk, 'product-info.json'), 'utf8')) as {
    launch: {
      os: string;
      javaExecutablePath: string;
      vmOptionsFilePath: string;
      bootClassPathJarNames: string[];
      additionalJvmArguments: string[];
    }[];
  };
  const os =
    process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
  const launch = product.launch.find((entry) => entry.os === os);
  assert.ok(launch, `SDK product-info lacks ${os} launcher`);
  const vmOptions = (await readFile(join(sdk, launch.vmOptionsFilePath), 'utf8'))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  const args = [...vmOptions, ...launch.additionalJvmArguments].map((arg) =>
    arg.replaceAll('%IDE_HOME%', sdk),
  );
  const classpath = [
    ...launch.bootClassPathJarNames.map((file) => join(sdk, 'lib', file)),
    jars[0],
  ].join(delimiter);
  await mkdir(join(root, 'config'), { recursive: true });
  await mkdir(join(root, 'log'), { recursive: true });
  const extension = sandbox.env.OMP_ANDROID_LS_EXTENSION_DIR;
  assert.ok(extension, 'Current staged Android extension is required');
  const index = join(sandbox.sandboxDir, 'index', canonicalizeProject(projectPath).id);
  const result = spawnSync(
    join(sdk, launch.javaExecutablePath),
    [
      ...args,
      `-Didea.home.path=${sdk}`,
      `-Didea.config.path=${join(root, 'config')}`,
      `-Didea.log.path=${join(root, 'log')}`,
      `-Dplugin.path=${extension}`,
      `-Dslim.layoutUri=${layoutUri}`,
      `-Dslim.expectedTestUri=${expectedTestUri}`,
      '-cp',
      classpath,
      'org.jetbrains.android.testing.slim.AndroidSlimLauncher',
      projectPath,
      index,
      sandbox.prerequisites.jdk21Path,
      jars[1],
    ],
    {
      cwd: projectPath,
      env: sandbox.env,
      encoding: 'utf8',
      timeout: 60000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    },
  );
  const nativeLog =
    result.status === 0
      ? ''
      : await readFile(join(root, 'log', 'idea.log'), 'utf8').catch(
          (error: unknown) => `Cannot read native log: ${String(error)}`,
        );
  assert.equal(
    result.status,
    0,
    `Slim SDK analysis failed: ${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}\n${nativeLog}`,
  );
  assert.match(
    result.stdout,
    /SLIM_BOOTSTRAP_OK xml-modules=\d+ core=ENABLED dap=absent kotlin-feature=absent/,
  );
  assert.match(
    result.stdout,
    /SLIM_ANDROID_REQUESTS_OK inspections=\d+ diagnostics=[1-9]\d* targets=[1-9]\d*/,
  );
  assert.match(
    result.stdout,
    /SLIM_ANDROID_ANALYSIS_OK core=ENABLED dap=absent kotlin-feature=absent/,
  );
}
