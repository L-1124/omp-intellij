import type { LspSession } from './run-core.js';

export type TestKind = 'SUITE' | 'TEST';

export interface TestDescriptor {
  id: string;
  kind: TestKind;
  displayName?: string;
}

export interface ResolvedTestLaunchSpec {
  mainClass: string;
  args: string[];
  runtimeClasspath: string[];
  runtimeModulePath: string[];
  file?: string;
}

export interface ResolvedTestTarget {
  mainClass: string;
  args: string[];
  additionalClassPaths: string[];
  additionalModulePaths: string[];
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
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
    if (record.kind !== 'SUITE' && record.kind !== 'TEST') {
      throw new Error(
        `intellij.jvm.discoverTestsInFile: element at index ${i} has unsupported kind`,
      );
    }
    const descriptor: TestDescriptor = { id: record.id, kind: record.kind };
    if (typeof record.displayName === 'string') descriptor.displayName = record.displayName;
    descriptors.push(descriptor);
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
    if (typeof id !== 'string' || id.trim().length === 0) {
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
    if (!isStringArray(record.args)) {
      throw new Error(
        `intellij.jvm.resolveTestLaunch: element at index ${i} args must be an array of strings`,
      );
    }
    if (!isStringArray(record.runtimeClasspath)) {
      throw new Error(
        `intellij.jvm.resolveTestLaunch: element at index ${i} runtimeClasspath must be an array of strings`,
      );
    }
    if (!isStringArray(record.runtimeModulePath)) {
      throw new Error(
        `intellij.jvm.resolveTestLaunch: element at index ${i} runtimeModulePath must be an array of strings`,
      );
    }
    const spec: ResolvedTestLaunchSpec = {
      mainClass: record.mainClass,
      args: record.args,
      runtimeClasspath: record.runtimeClasspath,
      runtimeModulePath: record.runtimeModulePath,
    };
    if (typeof record.file === 'string' && record.file.length > 0) spec.file = record.file;
    specs.push(spec);
  }

  return specs;
}

/**
 * Resolves a runnable test target using the native IntelliJ test launch provider.
 *
 * The returned class paths and module paths are additional to the native module runtime the
 * debug adapter derives for the launch file; they never replace it.
 */
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
    const suites = discovered.filter((d) => d.kind === 'SUITE');
    if (suites.length > 0) {
      targetIds = suites.map((d) => d.id);
    } else {
      const tests = discovered.filter((d) => d.kind === 'TEST');
      if (tests.length > 0) {
        targetIds = tests.map((d) => d.id);
      } else {
        throw new Error(
          'No runnable tests discovered; provide explicit test IDs if discovery is unavailable',
        );
      }
    }
  }

  const specs = await resolveTestLaunch(session, targetIds);

  if (specs.length === 0) {
    throw new Error('No test launch specification returned');
  }
  if (specs.length > 1) {
    throw new Error(
      'Selected tests require multiple launch specifications; launch each group separately',
    );
  }

  const spec = specs[0];
  return {
    mainClass: spec.mainClass,
    args: spec.args,
    additionalClassPaths: spec.runtimeClasspath,
    additionalModulePaths: spec.runtimeModulePath,
  };
}
