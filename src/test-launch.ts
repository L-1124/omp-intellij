import { type LaunchPaths, type LspSession, resolveLaunch } from './run-core.js';

export interface TestDescriptor {
  id: string;
  kind: string;
  runnable: boolean;
}

export interface ResolvedTestLaunchSpec {
  mainClass: string;
  args: string[];
  runtimeClasspath: string[];
}

export interface ResolvedTestTarget {
  mainClass: string;
  args: string[];
  paths: LaunchPaths;
}

export async function discoverTestsInFile(
  session: LspSession,
  fileUri: string,
): Promise<TestDescriptor[]> {
  const raw = await session.request('workspace/executeCommand', {
    command: 'intellij.jvm.discoverTestsInFile',
    arguments: [{ uri: fileUri }],
  });

  if (!Array.isArray(raw)) {
    throw new Error(
      'intellij.jvm.discoverTestsInFile: expected array response from language server',
    );
  }

  const descriptors: TestDescriptor[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (typeof item !== 'object' || item === null) {
      throw new Error(`intellij.jvm.discoverTestsInFile: element at index ${i} is not an object`);
    }
    const record = item as Record<string, unknown>;
    if (typeof record.id !== 'string' || record.id.length === 0) {
      throw new Error(
        `intellij.jvm.discoverTestsInFile: element at index ${i} has invalid or empty id`,
      );
    }
    if (typeof record.kind !== 'string') {
      throw new Error(
        `intellij.jvm.discoverTestsInFile: element at index ${i} has non-string kind`,
      );
    }
    if (typeof record.runnable !== 'boolean') {
      throw new Error(
        `intellij.jvm.discoverTestsInFile: element at index ${i} has non-boolean runnable`,
      );
    }
    descriptors.push({
      id: record.id,
      kind: record.kind,
      runnable: record.runnable,
    });
  }

  return descriptors;
}

export async function resolveTestLaunch(
  session: LspSession,
  testIds: readonly string[],
): Promise<ResolvedTestLaunchSpec[]> {
  if (!Array.isArray(testIds)) {
    throw new Error('resolveTestLaunch: testIds must be an array');
  }

  const dedupedIds: string[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < testIds.length; i++) {
    const id = testIds[i];
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(`resolveTestLaunch: testId at index ${i} must be a non-empty string`);
    }
    if (!seenIds.has(id)) {
      seenIds.add(id);
      dedupedIds.push(id);
    }
  }

  const raw = await session.request('workspace/executeCommand', {
    command: 'intellij.jvm.resolveTestLaunch',
    arguments: [{ testIds: dedupedIds }],
  });

  if (!Array.isArray(raw)) {
    throw new Error('intellij.jvm.resolveTestLaunch: expected array response from language server');
  }

  const specs: ResolvedTestLaunchSpec[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (typeof item !== 'object' || item === null) {
      throw new Error(`intellij.jvm.resolveTestLaunch: element at index ${i} is not an object`);
    }
    const record = item as Record<string, unknown>;
    if (typeof record.mainClass !== 'string' || record.mainClass.length === 0) {
      throw new Error(
        `intellij.jvm.resolveTestLaunch: element at index ${i} has invalid or empty mainClass`,
      );
    }
    if (
      !Array.isArray(record.args) ||
      !record.args.every((a): a is string => typeof a === 'string')
    ) {
      throw new Error(
        `intellij.jvm.resolveTestLaunch: element at index ${i} args must be an array of strings`,
      );
    }
    if (
      !Array.isArray(record.runtimeClasspath) ||
      !record.runtimeClasspath.every((cp): cp is string => typeof cp === 'string')
    ) {
      throw new Error(
        `intellij.jvm.resolveTestLaunch: element at index ${i} runtimeClasspath must be an array of strings`,
      );
    }
    specs.push({
      mainClass: record.mainClass,
      args: record.args,
      runtimeClasspath: record.runtimeClasspath,
    });
  }

  return specs;
}

export async function resolveTestTarget(
  session: LspSession,
  fileUri: string,
  testIds: readonly string[],
): Promise<ResolvedTestTarget> {
  if (!Array.isArray(testIds)) {
    throw new Error('resolveTestTarget: testIds must be an array');
  }

  let targetIds: readonly string[];
  if (testIds.length > 0) {
    targetIds = testIds;
  } else {
    const discovered = await discoverTestsInFile(session, fileUri);
    const runnableClasses = discovered.filter((d) => d.runnable && d.kind === 'CLASS');
    if (runnableClasses.length > 0) {
      targetIds = runnableClasses.map((d) => d.id);
    } else {
      const runnableMethods = discovered.filter((d) => d.runnable && d.kind === 'METHOD');
      if (runnableMethods.length > 0) {
        targetIds = runnableMethods.map((d) => d.id);
      } else {
        throw new Error(
          'No runnable tests discovered; provide explicit test IDs if discovery is unavailable',
        );
      }
    }
  }

  const [specs, paths] = await Promise.all([
    resolveTestLaunch(session, targetIds),
    resolveLaunch(session, fileUri),
  ]);

  if (!paths || typeof paths.javaExec !== 'string' || paths.javaExec.trim().length === 0) {
    throw new Error('Project launch paths do not contain a valid javaExec');
  }

  if (specs.length === 0) {
    throw new Error('No test launch specification returned');
  }
  if (specs.length > 1) {
    throw new Error(
      'Selected tests require multiple launch specifications; launch each group separately',
    );
  }

  const spec = specs[0];

  const mergedClasspath: string[] = [];
  const seenClasspath = new Set<string>();

  if (paths.classpath !== undefined) {
    if (!Array.isArray(paths.classpath)) {
      throw new Error('Project launch paths classpath must be an array of strings');
    }
    for (let i = 0; i < paths.classpath.length; i++) {
      const entry = paths.classpath[i];
      if (typeof entry !== 'string') {
        throw new Error(`Project launch paths classpath at index ${i} must be a string`);
      }
      if (!seenClasspath.has(entry)) {
        seenClasspath.add(entry);
        mergedClasspath.push(entry);
      }
    }
  }

  for (const entry of spec.runtimeClasspath) {
    if (!seenClasspath.has(entry)) {
      seenClasspath.add(entry);
      mergedClasspath.push(entry);
    }
  }

  const mergedPaths: LaunchPaths = {
    ...paths,
    classpath: mergedClasspath,
  };

  return {
    mainClass: spec.mainClass,
    args: spec.args,
    paths: mergedPaths,
  };
}
