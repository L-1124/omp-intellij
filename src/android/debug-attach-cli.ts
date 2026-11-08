import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLspSession, detectProjectRoot, type LspSession } from '../debug/run-core.js';
import { settings } from '../server/service.js';
import { prepareAndroidDebug, releaseAndroidDebug } from './debug-attach.js';

const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export class CliValidationError extends Error {
  readonly code = 'INVALID_ARGUMENTS';

  constructor(message: string) {
    super(message);
    this.name = 'CliValidationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export type ParsedCliCommand =
  | {
      command: 'prepare';
      packageName?: string;
      pid?: number;
      deviceId?: string;
      adbPath?: string;
      timeoutMs?: number;
    }
  | {
      command: 'cleanup';
      key: string;
    };

export interface RunCliOptions {
  cwd?: string;
  systemPath?: string;
  createLspSession?: typeof createLspSession;
  detectProjectRoot?: typeof detectProjectRoot;
  stdout?: { write: (str: string) => unknown };
  stderr?: { write: (str: string) => unknown };
  signal?: AbortSignal;
}

function extractErrorCode(err: unknown): string | number {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = err.code;
    if (typeof code === 'string' || typeof code === 'number') {
      return code;
    }
  }
  return 'COMMAND_FAILED';
}

function extractErrorDetails(err: unknown): unknown {
  if (err && typeof err === 'object' && 'data' in err) {
    return err.data;
  }
  return undefined;
}

export function parseCliArgs(argv: string[]): ParsedCliCommand {
  if (argv.length === 0) {
    throw new CliValidationError('Missing subcommand. Expected "prepare" or "cleanup".');
  }

  const subcommand = argv[0];
  const args = argv.slice(1);

  if (subcommand === 'prepare') {
    const seen = new Set<string>();
    let packageName: string | undefined;
    let pid: number | undefined;
    let deviceId: string | undefined;
    let adbPath: string | undefined;
    let timeoutMs: number | undefined;

    let i = 0;
    while (i < args.length) {
      const arg = args[i];
      if (!arg.startsWith('-')) {
        throw new CliValidationError(`Unexpected positional argument: "${arg}"`);
      }

      if (arg === '--package') {
        if (seen.has('--package')) throw new CliValidationError('Duplicate flag: --package');
        seen.add('--package');
        i++;
        if (i >= args.length || args[i].startsWith('-')) {
          throw new CliValidationError('Missing value for flag: --package');
        }
        const val = args[i].trim();
        if (val.length === 0) throw new CliValidationError('Package name must not be empty');
        packageName = val;
      } else if (arg === '--pid') {
        if (seen.has('--pid')) throw new CliValidationError('Duplicate flag: --pid');
        seen.add('--pid');
        i++;
        if (i >= args.length || args[i].startsWith('-')) {
          throw new CliValidationError('Missing value for flag: --pid');
        }
        const val = args[i].trim();
        if (!/^\d+$/.test(val)) {
          throw new CliValidationError(`Invalid PID: "${val}". PID must be a positive integer`);
        }
        const num = Number(val);
        if (!Number.isInteger(num) || num <= 0) {
          throw new CliValidationError(`Invalid PID: "${val}". PID must be a positive integer`);
        }
        pid = num;
      } else if (arg === '--device') {
        if (seen.has('--device')) throw new CliValidationError('Duplicate flag: --device');
        seen.add('--device');
        i++;
        if (i >= args.length || args[i].startsWith('-')) {
          throw new CliValidationError('Missing value for flag: --device');
        }
        const val = args[i].trim();
        if (val.length === 0) throw new CliValidationError('Device serial must not be empty');
        deviceId = val;
      } else if (arg === '--adb') {
        if (seen.has('--adb')) throw new CliValidationError('Duplicate flag: --adb');
        seen.add('--adb');
        i++;
        if (i >= args.length || args[i].startsWith('-')) {
          throw new CliValidationError('Missing value for flag: --adb');
        }
        const val = args[i].trim();
        if (val.length === 0) throw new CliValidationError('ADB path must not be empty');
        adbPath = val;
      } else if (arg === '--timeout-ms') {
        if (seen.has('--timeout-ms')) throw new CliValidationError('Duplicate flag: --timeout-ms');
        seen.add('--timeout-ms');
        i++;
        if (i >= args.length || args[i].startsWith('-')) {
          throw new CliValidationError('Missing value for flag: --timeout-ms');
        }
        const val = args[i].trim();
        if (!/^\d+$/.test(val)) {
          throw new CliValidationError(
            `Invalid timeout-ms: "${val}". Must be an integer between 1 and 300000`,
          );
        }
        const num = Number(val);
        if (!Number.isInteger(num) || num < 1 || num > 300000) {
          throw new CliValidationError(
            `Invalid timeout-ms: "${val}". Must be an integer between 1 and 300000`,
          );
        }
        timeoutMs = num;
      } else if (arg === '--timeout') {
        if (seen.has('--timeout')) throw new CliValidationError('Duplicate flag: --timeout');
        seen.add('--timeout');
        i++;
        if (i >= args.length || args[i].startsWith('-')) {
          throw new CliValidationError('Missing value for flag: --timeout');
        }
        const val = args[i].trim();
        if (!/^\d+(?:\.\d+)?$/.test(val)) {
          throw new CliValidationError(`Invalid timeout: "${val}". Expected seconds`);
        }
        const milliseconds = Number(val) * 1000;
        if (!Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > 300000) {
          throw new CliValidationError(
            `Invalid timeout: "${val}". Expected 0.001 to 300 seconds in whole milliseconds`,
          );
        }
        timeoutMs = milliseconds;
      } else {
        throw new CliValidationError(`Unknown flag: "${arg}"`);
      }

      i++;
    }

    if (seen.has('--package') && seen.has('--pid')) {
      throw new CliValidationError('Cannot specify both --package and --pid (selector not unique)');
    }
    if (!seen.has('--package') && !seen.has('--pid')) {
      throw new CliValidationError('Must specify either --package or --pid');
    }
    if (seen.has('--timeout') && seen.has('--timeout-ms')) {
      throw new CliValidationError('Cannot specify both --timeout and --timeout-ms');
    }

    return {
      command: 'prepare',
      packageName,
      pid,
      deviceId,
      adbPath,
      timeoutMs,
    };
  }

  if (subcommand === 'cleanup') {
    const seen = new Set<string>();
    let key: string | undefined;

    let i = 0;
    while (i < args.length) {
      const arg = args[i];
      if (!arg.startsWith('-')) {
        throw new CliValidationError(`Unexpected positional argument: "${arg}"`);
      }

      if (arg === '--key') {
        if (seen.has('--key')) throw new CliValidationError('Duplicate flag: --key');
        seen.add('--key');
        i++;
        if (i >= args.length || args[i].startsWith('-')) {
          throw new CliValidationError('Missing value for flag: --key');
        }
        const val = args[i].trim();
        if (!UUID_REGEX.test(val)) {
          throw new CliValidationError(`Invalid cleanup key: "${val}". Must be a valid UUID`);
        }
        key = val;
      } else {
        throw new CliValidationError(`Unknown flag for cleanup: "${arg}"`);
      }

      i++;
    }

    if (!seen.has('--key') || !key) {
      throw new CliValidationError('Missing required flag: --key');
    }

    return {
      command: 'cleanup',
      key,
    };
  }

  throw new CliValidationError(
    `Unknown subcommand: "${subcommand}". Expected "prepare" or "cleanup".`,
  );
}

export async function runCli(argv: string[], options: RunCliOptions = {}): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  let parsed: ParsedCliCommand;
  try {
    parsed = parseCliArgs(argv);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`${message}\n`);
    stdout.write(
      `${JSON.stringify({ success: false, error: { code: 'INVALID_ARGUMENTS', message } })}\n`,
    );
    return 2;
  }

  const controller = new AbortController();
  let signalCaught: 'SIGINT' | 'SIGTERM' | null = null;
  let session: LspSession | null = null;
  let closing: Promise<void> | undefined;
  let result: unknown;
  let failure: unknown;
  let failed = false;
  const close = () => {
    if (session) closing ??= session.close();
    return closing;
  };
  const abort = () => {
    controller.abort();
    // The finalizer observes this same promise and reports cleanup failure.
    void close()?.catch(() => {});
  };
  const onSigint = () => {
    signalCaught = 'SIGINT';
    abort();
  };
  const onSigterm = () => {
    signalCaught = 'SIGTERM';
    abort();
  };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();

  try {
    const root = (options.detectProjectRoot ?? detectProjectRoot)(options.cwd ?? process.cwd());
    session = await (options.createLspSession ?? createLspSession)(root, {
      signal: controller.signal,
      systemPath: options.systemPath ?? settings.systemPath,
    });
    controller.signal.throwIfAborted();
    result =
      parsed.command === 'prepare'
        ? await prepareAndroidDebug(session, {
            packageName: parsed.packageName,
            pid: parsed.pid,
            deviceId: parsed.deviceId,
            adbPath: parsed.adbPath,
            timeoutMs: parsed.timeoutMs,
          })
        : await releaseAndroidDebug(session, parsed.key);
  } catch (error: unknown) {
    failed = true;
    failure = error;
  } finally {
    try {
      await close();
    } catch (error: unknown) {
      if (!failed) {
        failed = true;
        failure = error;
      } else stderr.write(`LSP cleanup failed: ${String(error)}\n`);
    }
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    options.signal?.removeEventListener('abort', abort);
  }

  let exitCode = 0;
  if (controller.signal.aborted) {
    exitCode = signalCaught === 'SIGINT' ? 130 : 143;
    const message = `Operation cancelled by ${signalCaught ?? 'signal'}`;
    result = { success: false, error: { code: 'CANCELLED', message } };
    stderr.write(`${message}\n`);
  } else if (failed) {
    exitCode = 1;
    const message = failure instanceof Error ? failure.message : String(failure);
    const details = extractErrorDetails(failure);
    result = {
      success: false,
      error: {
        code: extractErrorCode(failure),
        message,
        ...(details === undefined ? {} : { details }),
      },
    };
    stderr.write(`${message}\n`);
  }
  stdout.write(`${JSON.stringify(result)}\n`);
  return exitCode;
}

export function isDirectExecution(
  entryScript: string | undefined = process.argv[1],
  importMetaUrl = import.meta.url,
): boolean {
  if (!entryScript) return false;
  try {
    const scriptPath = resolve(entryScript);
    const modulePath = fileURLToPath(importMetaUrl);
    if (scriptPath === modulePath) return true;

    if (process.platform === 'win32') {
      const lowerScript = scriptPath.toLowerCase();
      const lowerModule = modulePath.toLowerCase();
      if (lowerScript === lowerModule) return true;
      if (`${lowerScript}.js` === lowerModule || `${lowerScript}.ts` === lowerModule) return true;
    } else {
      if (`${scriptPath}.js` === modulePath || `${scriptPath}.ts` === modulePath) return true;
    }

    try {
      if (existsSync(scriptPath) && existsSync(modulePath)) {
        const realScript = realpathSync(scriptPath);
        const realModule = realpathSync(modulePath);
        if (process.platform === 'win32') {
          if (realScript.toLowerCase() === realModule.toLowerCase()) return true;
        } else {
          if (realScript === realModule) return true;
        }
      }
    } catch {
      // ignore
    }

    return false;
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  void runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
