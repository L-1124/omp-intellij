import { formatBytes } from './cache-manager.js';
import type { InstallPhase, InstallState } from './server-install.js';

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

export function parseInstallArgs(rawRemainder: string): { dir?: string; error?: string } {
  const trimmed = rawRemainder.trim();
  if (!trimmed) {
    return {};
  }
  let target = '';
  if (trimmed === '--dir' || trimmed.startsWith('--dir ') || trimmed.startsWith('--dir\t')) {
    target = trimmed.slice(5).trim();
  } else if (trimmed === '--dir=' || trimmed.startsWith('--dir=')) {
    target = trimmed.slice(6).trim();
  } else {
    return { error: 'Usage: /intellij install [--dir <path>]' };
  }
  if (!target) {
    return { error: 'IntelliJ installation directory must not be empty' };
  }
  if (
    (target.startsWith('"') && target.endsWith('"') && target.length >= 2) ||
    (target.startsWith("'") && target.endsWith("'") && target.length >= 2)
  ) {
    target = target.slice(1, -1).trim();
  }
  if (!target) {
    return { error: 'IntelliJ installation directory must not be empty' };
  }
  return { dir: target };
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
