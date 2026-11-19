import { resolve } from 'node:path';

function hasInvalidOptionChars(value: string, allowComma = false): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127 || code === 34 || (!allowComma && code === 44)) {
      return true;
    }
  }
  return false;
}

export function formatPluginOption(pluginPath: string): string {
  if (hasInvalidOptionChars(pluginPath, true)) {
    throw new Error(`Invalid characters in plugin.path option: "${pluginPath}"`);
  }
  const normalized = pluginPath.replace(/\\/g, '/');
  return `-Dplugin.path="${normalized}"`;
}

function parseJvmOptionTokens(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
    } else if (/\s/.test(char) && !inQuotes) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

interface ParsedIjPluginOptions {
  paths: string[];
  remainingTokens: string[];
}

function parseIjPluginOptions(
  existing: string | undefined,
  additionalPluginPath?: string,
): ParsedIjPluginOptions {
  if (additionalPluginPath !== undefined && hasInvalidOptionChars(additionalPluginPath, false)) {
    throw new Error(`Invalid characters in plugin.path option: "${additionalPluginPath}"`);
  }
  const tokens = parseJvmOptionTokens(existing ?? '');
  const remainingTokens: string[] = [];
  const paths: string[] = [];
  const pathKeys = new Set<string>();
  const windows = process.platform === 'win32';

  for (const token of tokens) {
    let isPluginOption = false;
    let rawValue = '';

    if (token.startsWith('-Dplugin.path=')) {
      isPluginOption = true;
      rawValue = token.slice('-Dplugin.path='.length);
    } else if (token.startsWith('"-Dplugin.path=') && token.endsWith('"')) {
      isPluginOption = true;
      rawValue = token.slice('"-Dplugin.path='.length, -1);
    }

    if (isPluginOption) {
      if (rawValue.startsWith('"') && rawValue.endsWith('"')) {
        rawValue = rawValue.slice(1, -1);
      }
      for (let segment of rawValue.split(windows ? /[;,]/ : /[:,]/)) {
        segment = segment.trim();
        if (segment.startsWith('"') && segment.endsWith('"')) {
          segment = segment.slice(1, -1).trim();
        }
        if (segment.length > 0) {
          const normSegment = segment.replace(/\\/g, '/');
          const key = windows ? normSegment.toLowerCase() : normSegment;
          if (!pathKeys.has(key)) {
            pathKeys.add(key);
            paths.push(normSegment);
          }
        }
      }
    } else {
      remainingTokens.push(token);
    }
  }

  if (additionalPluginPath !== undefined && additionalPluginPath.length > 0) {
    const normNewPath = additionalPluginPath.replace(/\\/g, '/');
    const key = windows ? normNewPath.toLowerCase() : normNewPath;
    if (!pathKeys.has(key)) {
      paths.push(normNewPath);
    }
  }

  return { paths, remainingTokens };
}

export function getIjPluginPaths(
  existing: string | undefined,
  additionalPluginPath?: string,
  baseDir?: string,
): string[] {
  const { paths } = parseIjPluginOptions(existing, additionalPluginPath);
  if (baseDir === undefined) {
    return paths;
  }
  const resolvedPaths: string[] = [];
  const seen = new Set<string>();
  const windows = process.platform === 'win32';
  for (const p of paths) {
    const resolved = resolve(baseDir, p).replace(/\\/g, '/');
    const key = windows ? resolved.toLowerCase() : resolved;
    if (!seen.has(key)) {
      seen.add(key);
      resolvedPaths.push(resolved);
    }
  }
  return resolvedPaths;
}

export function mergeIjJavaOptions(existing: string | undefined, pluginPath: string): string {
  const { paths, remainingTokens } = parseIjPluginOptions(existing, pluginPath);
  const property = formatPluginOption(paths.join(','));
  return remainingTokens.length > 0 ? `${remainingTokens.join(' ')} ${property}` : property;
}
