import assert from 'node:assert/strict';
import test from 'node:test';
import type { LaunchPaths, LspSession } from '../src/debug/run-core.js';
import {
  discoverTestsInFile,
  resolveTestLaunch,
  resolveTestTarget,
} from '../src/debug/test-launch.js';

function createMockLspSession(
  handler: (method: string, params: unknown, timeoutMs?: number) => Promise<unknown>,
): LspSession {
  return {
    rootUri: 'file:///workspace',
    nativePath: '/workspace',
    request: handler,
    notify: () => {},
    isReady: () => true,
    reloadWorkspace: async () => ({ ready: true }),
    close: async () => {},
  };
}

test('resolveTestLaunch deduplicates testIds preserving first occurrence', async () => {
  let receivedIds: string[] | undefined;
  const session = createMockLspSession(async (_method, params) => {
    const cmd = params as { command: string; arguments: Array<{ testIds: string[] }> };
    assert.equal(cmd.command, 'intellij.jvm.resolveTestLaunch');
    receivedIds = cmd.arguments[0].testIds;
    return [
      {
        mainClass: 'com.example.Runner',
        args: [],
        runtimeClasspath: [],
      },
    ];
  });

  await resolveTestLaunch(session, [
    'com.example.Test#test1',
    'com.example.Test#test2',
    'com.example.Test#test1',
    'com.example.Test#test3',
    'com.example.Test#test2',
  ]);

  assert.deepEqual(receivedIds, [
    'com.example.Test#test1',
    'com.example.Test#test2',
    'com.example.Test#test3',
  ]);
});

test('resolveTestLaunch rejects empty or non-string testIds', async () => {
  const session = createMockLspSession(async () => []);
  await assert.rejects(
    () => resolveTestLaunch(session, ['valid.Test', '']),
    /resolveTestLaunch: testId at index 1 must be a non-empty string/,
  );
});

test('malformed discovery responses block execution with command context', async () => {
  const malformedCases: unknown[] = [
    null,
    { not: 'array' },
    ['string-not-object'],
    [{ id: '', kind: 'CLASS', runnable: true }],
    [{ id: 'com.example.Test', kind: 123, runnable: true }],
    [{ id: 'com.example.Test', kind: 'CLASS', runnable: 'not-bool' }],
  ];

  for (const badResponse of malformedCases) {
    const session = createMockLspSession(async () => badResponse);
    await assert.rejects(
      () => discoverTestsInFile(session, 'file:///workspace/Test.java'),
      /intellij\.jvm\.discoverTestsInFile:/,
    );
  }
});

test('discoverTestsInFile propagates server failure without returning empty array', async () => {
  const session = createMockLspSession(async () => {
    throw new Error('LSP discovery crash');
  });
  await assert.rejects(
    () => discoverTestsInFile(session, 'file:///workspace/Test.java'),
    /LSP discovery crash/,
  );
});

test('malformed launch specifications block launch resolution with command context', async () => {
  const malformedCases: unknown[] = [
    null,
    'not-an-array',
    [{ mainClass: '', args: [], runtimeClasspath: [] }],
    [{ mainClass: 'Runner', args: ['ok', 123], runtimeClasspath: [] }],
    [{ mainClass: 'Runner', args: [], runtimeClasspath: 'not-an-array' }],
  ];

  for (const badResponse of malformedCases) {
    const session = createMockLspSession(async () => badResponse);
    await assert.rejects(
      () => resolveTestLaunch(session, ['com.example.Test']),
      /intellij\.jvm\.resolveTestLaunch:/,
    );
  }
});

test('resolveTestLaunch propagates server error without returning empty array', async () => {
  const session = createMockLspSession(async () => {
    throw new Error('Server error in resolveTestLaunch');
  });
  await assert.rejects(
    () => resolveTestLaunch(session, ['com.example.Test']),
    /Server error in resolveTestLaunch/,
  );
});

test('resolveTestTarget with empty testIds selects CLASS over METHOD to prevent duplicate execution', async () => {
  let resolvedTestIds: string[] | undefined;
  const session = createMockLspSession(async (_method, params) => {
    const cmd = params as { command: string; arguments: unknown[] };
    if (cmd.command === 'intellij.jvm.discoverTestsInFile') {
      return [
        { id: 'com.example.JavaGreeterTest', kind: 'CLASS', runnable: true },
        { id: 'com.example.JavaGreeterTest#testGreeting', kind: 'METHOD', runnable: true },
        { id: 'com.example.JavaGreeterTest#testDefaultGreeting', kind: 'METHOD', runnable: true },
      ];
    }
    if (cmd.command === 'intellij.jvm.resolveTestLaunch') {
      const args = cmd.arguments[0] as { testIds: string[] };
      resolvedTestIds = args.testIds;
      return [
        {
          mainClass: 'com.intellij.rt.junit.JUnitStarter',
          args: ['-ideVersion5', 'com.example.JavaGreeterTest'],
          runtimeClasspath: ['/m2/junit-starter.jar'],
        },
      ];
    }
    if (cmd.command === 'intellij.java.resolveLaunch') {
      return {
        javaExec: '/jdk-21/bin/java.exe',
        classpath: ['/app/target/classes', '/m2/junit-jupiter-api.jar'],
        modulePath: ['/mods'],
        moduleName: 'com.example.app',
        moduleContentPaths: ['/app/src/main/java'],
        workingDirectory: '/app',
        vmArgs: ['-ea'],
      } satisfies LaunchPaths;
    }
    throw new Error(`Unexpected command: ${cmd.command}`);
  });

  const target = await resolveTestTarget(
    session,
    'file:///app/src/test/java/JavaGreeterTest.java',
    [],
  );

  assert.deepEqual(resolvedTestIds, ['com.example.JavaGreeterTest']);
  assert.equal(target.mainClass, 'com.intellij.rt.junit.JUnitStarter');
  assert.deepEqual(target.args, ['-ideVersion5', 'com.example.JavaGreeterTest']);

  assert.deepEqual(target.paths.classpath, [
    '/app/target/classes',
    '/m2/junit-jupiter-api.jar',
    '/m2/junit-starter.jar',
  ]);

  assert.equal(target.paths.javaExec, '/jdk-21/bin/java.exe');
  assert.deepEqual(target.paths.modulePath, ['/mods']);
  assert.equal(target.paths.moduleName, 'com.example.app');
  assert.deepEqual(target.paths.moduleContentPaths, ['/app/src/main/java']);
  assert.equal(target.paths.workingDirectory, '/app');
  assert.deepEqual(target.paths.vmArgs, ['-ea']);
});

test('resolveTestTarget with empty testIds selects runnable METHODs when no runnable CLASS is present', async () => {
  let resolvedTestIds: string[] | undefined;
  const session = createMockLspSession(async (_method, params) => {
    const cmd = params as { command: string; arguments: unknown[] };
    if (cmd.command === 'intellij.jvm.discoverTestsInFile') {
      return [
        { id: 'com.example.AbstractBaseTest', kind: 'CLASS', runnable: false },
        { id: 'com.example.ConcreteTest#method1', kind: 'METHOD', runnable: true },
        { id: 'com.example.ConcreteTest#method2', kind: 'METHOD', runnable: true },
      ];
    }
    if (cmd.command === 'intellij.jvm.resolveTestLaunch') {
      const args = cmd.arguments[0] as { testIds: string[] };
      resolvedTestIds = args.testIds;
      return [
        {
          mainClass: 'com.intellij.rt.junit.JUnitStarter',
          args: ['-ideVersion5', 'com.example.ConcreteTest,method1,method2'],
          runtimeClasspath: [],
        },
      ];
    }
    if (cmd.command === 'intellij.java.resolveLaunch') {
      return { javaExec: '/bin/java' } satisfies LaunchPaths;
    }
    throw new Error(`Unexpected command: ${cmd.command}`);
  });

  const target = await resolveTestTarget(session, 'file:///test.java', []);
  assert.deepEqual(resolvedTestIds, [
    'com.example.ConcreteTest#method1',
    'com.example.ConcreteTest#method2',
  ]);
  assert.equal(target.mainClass, 'com.intellij.rt.junit.JUnitStarter');
});

test('resolveTestTarget with explicit testIds bypasses file discovery', async () => {
  let discoveryCalled = false;
  let resolvedTestIds: string[] | undefined;

  const session = createMockLspSession(async (_method, params) => {
    const cmd = params as { command: string; arguments: unknown[] };
    if (cmd.command === 'intellij.jvm.discoverTestsInFile') {
      discoveryCalled = true;
      return [];
    }
    if (cmd.command === 'intellij.jvm.resolveTestLaunch') {
      const args = cmd.arguments[0] as { testIds: string[] };
      resolvedTestIds = args.testIds;
      return [
        {
          mainClass: 'com.intellij.rt.junit.JUnitStarter',
          args: ['-ideVersion5', 'com.example.KotlinAppTest,testKotlinCompute'],
          runtimeClasspath: ['/path/to/runner.jar'],
        },
      ];
    }
    if (cmd.command === 'intellij.java.resolveLaunch') {
      return { javaExec: '/bin/java' } satisfies LaunchPaths;
    }
    throw new Error(`Unexpected command: ${cmd.command}`);
  });

  const target = await resolveTestTarget(session, 'file:///app/src/test/kotlin/KotlinAppTest.kt', [
    'com.example.KotlinAppTest#testKotlinCompute',
  ]);

  assert.equal(discoveryCalled, false);
  assert.deepEqual(resolvedTestIds, ['com.example.KotlinAppTest#testKotlinCompute']);
  assert.equal(target.mainClass, 'com.intellij.rt.junit.JUnitStarter');
});

test('resolveTestTarget throws explicit error when file discovery yields no runnable tests', async () => {
  const session = createMockLspSession(async (_method, params) => {
    const cmd = params as { command: string };
    if (cmd.command === 'intellij.jvm.discoverTestsInFile') {
      return [
        { id: 'com.example.EmptyTest', kind: 'CLASS', runnable: false },
        { id: 'com.example.EmptyTest#helper', kind: 'METHOD', runnable: false },
      ];
    }
    throw new Error(`Unexpected command: ${cmd.command}`);
  });

  await assert.rejects(
    () => resolveTestTarget(session, 'file:///EmptyTest.java', []),
    (err: Error) => {
      assert.equal(
        err.message,
        'No runnable tests discovered; provide explicit test IDs if discovery is unavailable',
      );
      return true;
    },
  );
});

test('resolveTestTarget throws exact error when zero test launch specifications are returned', async () => {
  const session = createMockLspSession(async (_method, params) => {
    const cmd = params as { command: string };
    if (cmd.command === 'intellij.jvm.resolveTestLaunch') {
      return [];
    }
    if (cmd.command === 'intellij.java.resolveLaunch') {
      return { javaExec: '/bin/java' } satisfies LaunchPaths;
    }
    throw new Error(`Unexpected command: ${cmd.command}`);
  });

  await assert.rejects(
    () => resolveTestTarget(session, 'file:///Test.java', ['com.example.Test']),
    (err: Error) => {
      assert.equal(err.message, 'No test launch specification returned');
      return true;
    },
  );
});

test('resolveTestTarget throws exact error when multiple launch specifications are returned', async () => {
  const session = createMockLspSession(async (_method, params) => {
    const cmd = params as { command: string };
    if (cmd.command === 'intellij.jvm.resolveTestLaunch') {
      return [
        { mainClass: 'RunnerA', args: [], runtimeClasspath: [] },
        { mainClass: 'RunnerB', args: [], runtimeClasspath: [] },
      ];
    }
    if (cmd.command === 'intellij.java.resolveLaunch') {
      return { javaExec: '/bin/java' } satisfies LaunchPaths;
    }
    throw new Error(`Unexpected command: ${cmd.command}`);
  });

  await assert.rejects(
    () => resolveTestTarget(session, 'file:///Test.java', ['com.example.Test']),
    (err: Error) => {
      assert.equal(
        err.message,
        'Selected tests require multiple launch specifications; launch each group separately',
      );
      return true;
    },
  );
});

test('resolveTestTarget merges classpath in order keeping first occurrence and preserving empty string cwd', async () => {
  const session = createMockLspSession(async (_method, params) => {
    const cmd = params as { command: string };
    if (cmd.command === 'intellij.jvm.resolveTestLaunch') {
      return [
        {
          mainClass: 'com.example.Runner',
          args: ['run'],
          runtimeClasspath: ['/shared/common.jar', '', '/unique/runner.jar', '/shared/common.jar'],
        },
      ];
    }
    if (cmd.command === 'intellij.java.resolveLaunch') {
      return {
        javaExec: '/bin/java',
        classpath: ['', '/app/classes', '/shared/common.jar', '/app/classes'],
      } satisfies LaunchPaths;
    }
    throw new Error(`Unexpected command: ${cmd.command}`);
  });

  const target = await resolveTestTarget(session, 'file:///Test.java', ['com.example.Test']);
  assert.deepEqual(target.paths.classpath, [
    '',
    '/app/classes',
    '/shared/common.jar',
    '/unique/runner.jar',
  ]);
});

test('resolveTestTarget throws when project classpath contains non-string entry', async () => {
  const session = createMockLspSession(async (_method, params) => {
    const cmd = params as { command: string };
    if (cmd.command === 'intellij.jvm.resolveTestLaunch') {
      return [{ mainClass: 'com.example.Runner', args: [], runtimeClasspath: [] }];
    }
    if (cmd.command === 'intellij.java.resolveLaunch') {
      return {
        javaExec: '/bin/java',
        classpath: ['/valid', 123 as unknown as string],
      } satisfies LaunchPaths;
    }
    throw new Error(`Unexpected command: ${cmd.command}`);
  });

  await assert.rejects(
    () => resolveTestTarget(session, 'file:///Test.java', ['com.example.Test']),
    /Project launch paths classpath at index 1 must be a string/,
  );
});

test('resolveTestTarget throws when project launch paths do not contain a valid javaExec', async () => {
  const session = createMockLspSession(async (_method, params) => {
    const cmd = params as { command: string };
    if (cmd.command === 'intellij.jvm.resolveTestLaunch') {
      return [{ mainClass: 'com.example.Runner', args: [], runtimeClasspath: [] }];
    }
    if (cmd.command === 'intellij.java.resolveLaunch') {
      return { javaExec: '   ' } as unknown as LaunchPaths;
    }
    throw new Error(`Unexpected command: ${cmd.command}`);
  });

  await assert.rejects(
    () => resolveTestTarget(session, 'file:///Test.java', ['com.example.Test']),
    /Project launch paths do not contain a valid javaExec/,
  );
});
