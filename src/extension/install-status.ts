import { formatBytes } from '../project/cache-manager.js';
import type { InstallPhase, InstallState } from '../server/install.js';

export function sanitizeDetail(detail: unknown, maxLength: number = 60): string {
  if (!detail || typeof detail !== 'string') return '';
  const single = detail
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (single.length > maxLength) {
    return `${single.slice(0, maxLength - 1)}…`;
  }
  return single;
}

export function formatStatusText(
  phase: string,
  detail?: string,
  progress?: { percentage?: number; message?: string; title?: string } | null,
): string {
  const parts: string[] = [];
  const percentage = progress?.percentage;
  const hasPercentage = percentage !== undefined && percentage >= 0;
  const rounded = hasPercentage ? Math.round(percentage) : 0;
  const detailStr = sanitizeDetail(progress?.message || detail || progress?.title || '');
  const duplicatePercentage = hasPercentage && detailStr.startsWith(`${rounded}%`);
  if (hasPercentage && !duplicatePercentage) parts.push(`${rounded}%`);
  if (detailStr) parts.push(detailStr);
  const extra = parts.length > 0 ? ` (${parts.join(' - ')})` : '';
  return `IntelliJ ${phase}${extra}`;
}

export interface ParsedInstallArgs {
  dir?: string;
  error?: string;
}

const INSTALL_USAGE = 'Usage: /intellij install [--dir <path>]';

function stripQuotes(value: string): string {
  let s = value.trim();
  if (
    (s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
    (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
  ) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

export function parseInstallArgs(rawRemainder: string): ParsedInstallArgs {
  const trimmed = rawRemainder.trim();
  if (!trimmed) {
    return {};
  }

  const rawTokens: string[] = [];
  let current = '';
  let inQuote: '"' | "'" | null = null;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (inQuote) {
      current += ch;
      if (ch === inQuote) {
        inQuote = null;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
      current += ch;
    } else if (/\s/.test(ch)) {
      if (current.length > 0) {
        rawTokens.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (inQuote) {
    return { error: `Unterminated quoted argument. ${INSTALL_USAGE}` };
  }
  if (current.length > 0) {
    rawTokens.push(current);
  }

  let dir: string | undefined;
  let seenDir = false;
  let i = 0;
  while (i < rawTokens.length) {
    const token = rawTokens[i];

    if (token === '--dir' || token.startsWith('--dir=')) {
      if (seenDir) {
        return { error: `Duplicate --dir flag. ${INSTALL_USAGE}` };
      }
      seenDir = true;

      let rawVal = '';
      if (token.startsWith('--dir=')) {
        rawVal = token.slice(6);
        i++;
        if (
          !(rawVal.startsWith('"') && rawVal.endsWith('"')) &&
          !(rawVal.startsWith("'") && rawVal.endsWith("'"))
        ) {
          const extraTokens: string[] = [];
          while (i < rawTokens.length && !rawTokens[i].startsWith('-')) {
            extraTokens.push(rawTokens[i]);
            i++;
          }
          if (extraTokens.length > 0) {
            rawVal = rawVal ? `${rawVal} ${extraTokens.join(' ')}` : extraTokens.join(' ');
          }
        }
      } else {
        i++;
        if (i >= rawTokens.length || rawTokens[i].startsWith('-')) {
          return { error: 'IntelliJ installation directory must not be empty' };
        }
        const firstValToken = rawTokens[i];
        i++;
        const isQuoted =
          (firstValToken.startsWith('"') &&
            firstValToken.endsWith('"') &&
            firstValToken.length >= 2) ||
          (firstValToken.startsWith("'") &&
            firstValToken.endsWith("'") &&
            firstValToken.length >= 2);

        if (isQuoted) {
          rawVal = firstValToken;
        } else {
          const dirTokens = [firstValToken];
          while (i < rawTokens.length && !rawTokens[i].startsWith('-')) {
            dirTokens.push(rawTokens[i]);
            i++;
          }
          rawVal = dirTokens.join(' ');
        }
      }

      const stripped = stripQuotes(rawVal);
      if (!stripped) {
        return { error: 'IntelliJ installation directory must not be empty' };
      }
      dir = stripped;
    } else {
      if (token.startsWith('-')) {
        return { error: `Unknown flag: ${token}. ${INSTALL_USAGE}` };
      }
      return { error: `Unexpected argument: ${token}. ${INSTALL_USAGE}` };
    }
  }

  return {
    ...(dir !== undefined ? { dir } : {}),
  };
}

export function isInstallActive(state: InstallState | null | undefined): boolean {
  if (!state) return false;
  return (
    state.phase === 'downloading' || state.phase === 'verifying' || state.phase === 'extracting'
  );
}

export function formatInstallStatusText(state: InstallState): string {
  const phase: InstallPhase = state.phase;
  const parts: string[] = [];
  if (phase === 'downloading') {
    const downloaded = state.downloadedBytes ?? 0;
    const total = state.totalBytes;
    if (typeof total === 'number' && total > 0) {
      const pct = Math.min(100, Math.max(0, Math.round((downloaded / total) * 100)));
      parts.push(`${pct}%`);
      parts.push(`${formatBytes(downloaded)} / ${formatBytes(total)}`);
    } else if (downloaded > 0) {
      parts.push(formatBytes(downloaded));
    }
  } else if (phase === 'verifying') {
    parts.push('verifying checksum');
  } else if (phase === 'failed') {
    if (state.error) {
      parts.push(sanitizeDetail(state.error));
    }
  }
  const extra = parts.length > 0 ? ` (${parts.join(' - ')})` : '';
  return `IntelliJ ${phase}${extra}`;
}

export function formatInstallDescription(state: InstallState): string {
  const phase = state.phase;
  if (phase === 'downloading') {
    const downloaded = state.downloadedBytes ?? 0;
    const total = state.totalBytes;
    if (typeof total === 'number' && total > 0) {
      const pct = Math.min(100, Math.max(0, Math.round((downloaded / total) * 100)));
      return `install: downloading (${pct}% - ${formatBytes(downloaded)} / ${formatBytes(total)})`;
    }
    return `install: downloading (${formatBytes(downloaded)})`;
  }
  if (phase === 'verifying') {
    return 'install: verifying';
  }
  if (phase === 'extracting') {
    return 'install: extracting';
  }
  if (phase === 'failed') {
    const err = state.error ? ` (${sanitizeDetail(state.error)})` : '';
    return `install: failed${err}`;
  }
  if (phase === 'ready') {
    const ver = state.version ? ` (${state.version})` : '';
    return `install: ready${ver}`;
  }
  return `install: ${phase}`;
}
