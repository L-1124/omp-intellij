import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveResourceDefinition } from './resource-resolver.js';
import { type LspLocation, type LspRange, offsetAt, parseXml, type XmlElement } from './xml.js';

/**
 * Temporary Android source navigation adapter bridging IntelliJ LSP limitations
 * for Android R references and Manifest component declarations.
 * Remove this adapter and the bridge definition hook once upstream IntelliJ LSP
 * natively resolves R symbols and AndroidManifest component classes to source locations
 * across module and variant scopes.
 */

export interface LaunchPaths {
  javaExec?: string;
  classpath?: string[];
  modulePath?: string[];
  moduleName?: string;
  moduleContentPaths?: string[];
  workingDirectory?: string;
}

export interface WorkspaceModule {
  name: string;
  externalProjectPath?: string;
  externalProjectId?: string;
  contentRoots: string[];
  sourceRoots: string[];
  dependencies: string[];
}

export function toLocalFsPath(uriOrPath: string): string {
  let s = uriOrPath;
  if (s.startsWith('jar:')) {
    s = s.slice(4);
  }
  if (s.includes('!')) {
    s = s.slice(0, s.indexOf('!'));
  }
  if (s.startsWith('file://')) {
    s = s.slice(7);
  } else if (s.startsWith('file:')) {
    s = s.slice(5);
  }
  try {
    s = decodeURIComponent(s);
  } catch {}
  if (/^\/[a-zA-Z]:[/|\\]/.test(s)) {
    s = s.slice(1);
  }
  return normalize(s);
}

export function normalizeLocations(upstream: unknown): LspLocation[] {
  if (!upstream) return [];
  if (Array.isArray(upstream)) {
    const list: LspLocation[] = [];
    for (const item of upstream) {
      const loc = normalizeSingleLocation(item);
      if (loc) list.push(loc);
    }
    return list;
  }
  const single = normalizeSingleLocation(upstream);
  return single ? [single] : [];
}

function normalizeSingleLocation(item: unknown): LspLocation | null {
  if (!item || typeof item !== 'object') return null;
  const obj = item as Record<string, unknown>;
  if (typeof obj.targetUri === 'string' && obj.targetRange && typeof obj.targetRange === 'object') {
    return {
      uri: obj.targetUri,
      range: (obj.targetSelectionRange ?? obj.targetRange) as LspRange,
    };
  }
  if (typeof obj.uri === 'string' && obj.range && typeof obj.range === 'object') {
    return {
      uri: obj.uri,
      range: obj.range as LspRange,
    };
  }
  return null;
}

export function isRClassTarget(uri: string): boolean {
  const lower = uri.toLowerCase();
  return (
    (lower.includes('.jar!') || lower.includes('.jar/')) &&
    (/\br(\$[a-z_0-9]+)?\.class$/i.test(lower) ||
      lower.includes('/r.class') ||
      lower.includes('/r$') ||
      lower.includes('compile_and_runtime_not_namespaced_r_class_jar') ||
      lower.includes('compile_and_runtime_r_class_jar'))
  );
}

export function isAndroidFrameworkTarget(uri: string): boolean {
  const lower = uri.toLowerCase();
  return (
    lower.includes('platforms/android-') ||
    lower.includes('android.jar!/android/r') ||
    lower.includes('/android/r.class') ||
    lower.includes('/android/r$') ||
    (lower.startsWith('jar:') && lower.includes('/android/r'))
  );
}

export function isReliableSourceTarget(uri: string): boolean {
  if (isRClassTarget(uri) || isAndroidFrameworkTarget(uri)) {
    return false;
  }
  const lower = uri.toLowerCase();
  if (lower.includes('.jar!') || lower.includes('.jar/') || lower.endsWith('.class')) {
    return false;
  }
  return (
    lower.endsWith('.kt') ||
    lower.endsWith('.java') ||
    lower.endsWith('.xml') ||
    lower.endsWith('.groovy')
  );
}

export function parseResourceValue(
  val: string,
): { type: string; name: string; ns?: string } | null {
  const trimmed = val.trim();
  const resMatch = trimmed.match(
    /^@(?:\+)?(?:([a-zA-Z0-9_.]+):)?([a-zA-Z0-9_]+)\/([a-zA-Z0-9_]+)$/,
  );
  if (resMatch) {
    const ns = resMatch[1];
    const type = resMatch[2] === '+id' ? 'id' : resMatch[2];
    const name = resMatch[3];
    return { type, name, ns };
  }
  const attrMatch = trimmed.match(/^\?(?:([a-zA-Z0-9_.]+):)?(?:attr\/)?([a-zA-Z0-9_]+)$/);
  if (attrMatch) {
    const ns = attrMatch[1];
    const type = 'attr';
    const name = attrMatch[2];
    return { type, name, ns };
  }
  return null;
}

export function extractRReferenceAtPosition(
  lineText: string,
  character: number,
): { package?: string; type: string; name: string } | null {
  if (!lineText) return null;
  const regex = /\b(?:([a-zA-Z0-9_.]+)\.)?R\s*\.\s*([a-zA-Z0-9_]+)\s*\.\s*([a-zA-Z0-9_]+)\b/g;
  for (const match of lineText.matchAll(regex)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (character >= start && character <= end) {
      return {
        package: match[1],
        type: match[2],
        name: match[3],
      };
    }
  }
  return null;
}

export function parseRTargetUri(uri: string): { package?: string; type?: string } | null {
  const m = uri.match(/!\/([^!]+)\/R(?:\$([a-zA-Z0-9_]+))?\.class$/i);
  if (m) {
    const pkg = m[1].replace(/\//g, '.');
    const type = m[2];
    return { package: pkg, type };
  }
  return null;
}

export function getWordAtPosition(lineText: string, character: number): string | null {
  if (!lineText) return null;
  const regex = /[a-zA-Z0-9_]+/g;
  for (const match of lineText.matchAll(regex)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (character >= start && character <= end) {
      return match[0];
    }
  }
  return null;
}

export function findInnermostElementAt(elements: XmlElement[], offset: number): XmlElement | null {
  let innermost: XmlElement | null = null;
  for (const el of elements) {
    if (offset >= el.start && offset <= el.end) {
      if (!innermost || el.start >= innermost.start) {
        innermost = el;
      }
    }
  }
  return innermost;
}

function hasAndroidPrefix(element: XmlElement, prefix: string): boolean {
  if (!prefix) return false;
  for (let current: XmlElement | undefined = element; current; current = current.parent) {
    const binding = current.attributes[`xmlns:${prefix}`];
    if (binding) return binding.value === 'http://schemas.android.com/apk/res/android';
  }
  return false;
}

export function isValidManifestComponentStructure(element: XmlElement): boolean {
  if (element.name === 'application') {
    return element.parent?.name === 'manifest';
  }
  const COMPONENT_TAGS: Record<string, true> = {
    activity: true,
    'activity-alias': true,
    service: true,
    receiver: true,
    provider: true,
  };
  if (!COMPONENT_TAGS[element.name]) {
    return false;
  }
  return element.parent?.name === 'application' && element.parent.parent?.name === 'manifest';
}

function isPathInside(child: string, parent: string): boolean {
  const normChild = normalize(child).toLowerCase();
  const normParent = normalize(parent).toLowerCase();
  return (
    normChild === normParent ||
    normChild.startsWith(normParent.endsWith(sep) ? normParent : normParent + sep)
  );
}

export class AndroidNavigation {
  private workspaceModules: WorkspaceModule[] | null = null;
  private readonly launchCache = new Map<string, LaunchPaths>();
  private readonly namespaceCache = new Map<string, string>();

  constructor(
    private readonly request: (method: string, params: unknown) => Promise<unknown>,
    private readonly readDocument: (uri: string) => Promise<string>,
    private readonly documentPaths: () => readonly string[] = () => [],
  ) {}

  public invalidate(): void {
    this.workspaceModules = null;
    this.launchCache.clear();
    this.namespaceCache.clear();
  }

  public async resolve(options: {
    projectRoot: string;
    fileUri: string;
    text: string;
    position: { line: number; character: number };
    upstreamResult: unknown;
  }): Promise<LspLocation[] | null> {
    const { projectRoot, fileUri, text, position, upstreamResult } = options;

    const upstreamLocations = normalizeLocations(upstreamResult);
    if (upstreamLocations.length > 0) {
      if (upstreamLocations.some((loc) => isAndroidFrameworkTarget(loc.uri))) {
        return null;
      }
      if (upstreamLocations.some((loc) => isReliableSourceTarget(loc.uri))) {
        return null;
      }
    }

    const filePath = toLocalFsPath(fileUri);
    const lowerPath = filePath.toLowerCase();
    const isManifest = lowerPath.endsWith('androidmanifest.xml');
    const isXml = lowerPath.endsWith('.xml');
    const isKotlinOrJava = lowerPath.endsWith('.kt') || lowerPath.endsWith('.java');

    if (isManifest) {
      return this.resolveManifestComponent({
        projectRoot,
        fileUri,
        filePath,
        text,
        position,
      });
    }

    if (isXml) {
      return this.resolveXmlResource({
        projectRoot,
        fileUri,
        filePath,
        text,
        position,
      });
    }

    if (isKotlinOrJava) {
      return this.resolveKotlinJavaRReference({
        projectRoot,
        fileUri,
        filePath,
        text,
        position,
        upstreamLocations,
      });
    }

    return null;
  }

  private async getWorkspaceModules(): Promise<WorkspaceModule[] | null> {
    if (this.workspaceModules) {
      return this.workspaceModules;
    }

    const exportDir = await mkdtemp(join(tmpdir(), 'omp-ws-nav-'));
    try {
      await this.request('workspace/executeCommand', {
        command: 'exportWorkspace',
        arguments: [exportDir],
      });
      const wsFile = join(exportDir, 'workspace.json');
      if (existsSync(wsFile)) {
        const content = await readFile(wsFile, 'utf8');
        const doc = JSON.parse(content) as Record<string, unknown>;
        this.workspaceModules = this.parseModules(doc);
        return this.workspaceModules;
      }
    } catch {
    } finally {
      await rm(exportDir, { recursive: true, force: true }).catch(() => {});
    }

    return null;
  }

  private parseModules(raw: Record<string, unknown>): WorkspaceModule[] {
    const result: WorkspaceModule[] = [];
    const rawModules = Array.isArray(raw.modules) ? raw.modules : [];

    for (const m of rawModules) {
      if (!m || typeof m !== 'object') continue;
      const modObj = m as Record<string, unknown>;
      const name = typeof modObj.name === 'string' ? modObj.name.trim() : '';
      if (!name) continue;

      const externalProjectPath =
        typeof modObj.externalProjectPath === 'string'
          ? modObj.externalProjectPath.trim()
          : undefined;
      const externalProjectId =
        typeof modObj.externalProjectId === 'string' ? modObj.externalProjectId.trim() : undefined;

      const contentRoots: string[] = [];
      const sourceRoots: string[] = [];

      if (Array.isArray(modObj.contentRoots)) {
        for (const cr of modObj.contentRoots) {
          if (typeof cr === 'string') {
            contentRoots.push(normalize(cr));
          } else if (cr && typeof cr === 'object') {
            const crObj = cr as Record<string, unknown>;
            if (typeof crObj.path === 'string') {
              contentRoots.push(normalize(crObj.path));
            }
            if (Array.isArray(crObj.sourceRoots)) {
              for (const sr of crObj.sourceRoots) {
                if (typeof sr === 'string') {
                  sourceRoots.push(normalize(sr));
                } else if (
                  sr &&
                  typeof sr === 'object' &&
                  'path' in sr &&
                  typeof sr.path === 'string'
                ) {
                  sourceRoots.push(normalize(sr.path));
                }
              }
            }
          }
        }
      }

      const dependencies: string[] = [];
      if (Array.isArray(modObj.dependencies)) {
        for (const d of modObj.dependencies) {
          if (typeof d === 'string') {
            dependencies.push(d);
          } else if (
            d &&
            typeof d === 'object' &&
            'type' in d &&
            d.type === 'module' &&
            'name' in d &&
            typeof d.name === 'string'
          ) {
            dependencies.push(d.name);
          }
        }
      }

      result.push({
        name,
        externalProjectPath,
        externalProjectId,
        contentRoots,
        sourceRoots,
        dependencies,
      });
    }

    return result;
  }

  private findModuleForFile(filePath: string, modules: WorkspaceModule[]): WorkspaceModule | null {
    const normFile = normalize(filePath).toLowerCase();
    let bestMatch: WorkspaceModule | null = null;
    let bestMatchLen = -1;

    for (const mod of modules) {
      const allRoots = [...mod.contentRoots, ...mod.sourceRoots];
      if (mod.externalProjectPath) {
        allRoots.push(mod.externalProjectPath);
      }
      for (const root of allRoots) {
        const normRoot = normalize(root).toLowerCase();
        if (
          normFile === normRoot ||
          normFile.startsWith(normRoot.endsWith(sep) ? normRoot : normRoot + sep)
        ) {
          if (normRoot.length > bestMatchLen) {
            bestMatchLen = normRoot.length;
            bestMatch = mod;
          }
        }
      }
    }
    return bestMatch;
  }

  private resolveModuleRoot(module: WorkspaceModule, projectRoot: string): string {
    const peers = module.externalProjectId
      ? (this.workspaceModules ?? []).filter(
          (peer) => peer.externalProjectId === module.externalProjectId,
        )
      : [module];
    const explicit = peers.find((peer) => peer.externalProjectPath)?.externalProjectPath;
    if (explicit)
      return isAbsolute(explicit) ? normalize(explicit) : resolve(projectRoot, explicit);
    const roots = peers
      .flatMap((peer) => peer.contentRoots)
      .filter((root) => module.contentRoots.every((content) => isPathInside(content, root)))
      .sort((a, b) => b.length - a.length);
    return roots[0] ?? projectRoot;
  }

  private async getLaunchPaths(fileUri: string): Promise<LaunchPaths | null> {
    const cached = this.launchCache.get(fileUri);
    if (cached) return cached;
    try {
      const launch = (await this.request('workspace/executeCommand', {
        command: 'intellij.java.resolveLaunch',
        arguments: [{ uri: fileUri }],
      })) as LaunchPaths;
      if (launch && typeof launch === 'object') {
        this.launchCache.set(fileUri, launch);
        return launch;
      }
    } catch {}
    return null;
  }

  private async getConfirmedVariant(
    targetModule: WorkspaceModule,
    fileUri: string,
    moduleRoot: string,
  ): Promise<string | null> {
    const nameParts = targetModule.name.split('.');
    const lastPart = nameParts[nameParts.length - 1]?.toLowerCase();
    const KNOWN_VARIANTS: Record<string, true> = { debug: true, release: true };
    if (lastPart && KNOWN_VARIANTS[lastPart]) {
      return lastPart;
    }

    const launch = await this.getLaunchPaths(fileUri);
    const variants = new Set<string>();
    for (const entry of launch?.classpath ?? []) {
      const path = toLocalFsPath(entry);
      if (!isPathInside(path, moduleRoot)) continue;
      const match = path.match(
        /[\\/]intermediates[\\/](?:compile_and_runtime_not_namespaced_r_class_jar|compile_and_runtime_r_class_jar)[\\/]([A-Za-z0-9_]+)[\\/].*[\\/]R\.jar$/,
      );
      if (match) variants.add(match[1]);
    }
    return variants.size === 1 ? [...variants][0] : null;
  }

  private async getModuleNamespace(moduleRoot: string, variant: string): Promise<string | null> {
    const cacheKey = `${moduleRoot}:${variant}`;
    const cached = this.namespaceCache.get(cacheKey);
    if (cached) return cached;

    const cap = variant[0].toUpperCase() + variant.slice(1);
    const packageFile = join(
      moduleRoot,
      'build',
      'intermediates',
      'symbol_list_with_package_name',
      variant,
      `generate${cap}RFile`,
      'package-aware-r.txt',
    );
    try {
      const pkg = (await readFile(packageFile, 'utf8')).split(/\r?\n/, 1)[0].trim();
      if (/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/.test(pkg)) {
        this.namespaceCache.set(cacheKey, pkg);
        return pkg;
      }
    } catch {}
    const symbols = await this.request('workspace/symbol', { query: 'R' });
    if (!Array.isArray(symbols)) return null;
    const candidates = new Set<string>();
    for (const symbol of symbols) {
      if (symbol?.name !== 'R' || typeof symbol.containerName !== 'string' || !symbol.location?.uri)
        continue;
      const path = toLocalFsPath(symbol.location.uri);
      if (isPathInside(path, moduleRoot) && path.replaceAll('\\', '/').includes(`/${variant}/`))
        candidates.add(symbol.containerName);
    }
    if (candidates.size !== 1) return null;
    const namespace = [...candidates][0];
    this.namespaceCache.set(cacheKey, namespace);
    return namespace;
  }

  private isPathInAllowedRoots(targetPath: string, allowedRoots: string[]): boolean {
    const normTarget = normalize(targetPath).toLowerCase();
    for (const root of allowedRoots) {
      const normRoot = normalize(root).toLowerCase();
      if (
        normTarget === normRoot ||
        normTarget.startsWith(normRoot.endsWith(sep) ? normRoot : normRoot + sep)
      ) {
        return true;
      }
    }
    return false;
  }

  private getAllowedModuleRoots(
    targetModule: WorkspaceModule,
    allModules: WorkspaceModule[],
    projectRoot: string,
  ): string[] {
    const roots: string[] = [];
    const visitedModules = new Set<string>();

    const collectRoots = (mod: WorkspaceModule) => {
      if (visitedModules.has(mod.name)) return;
      visitedModules.add(mod.name);

      if (!mod.contentRoots.length && !mod.sourceRoots.length && mod.externalProjectPath) {
        const p = isAbsolute(mod.externalProjectPath)
          ? mod.externalProjectPath
          : resolve(projectRoot, mod.externalProjectPath);
        roots.push(p);
      }
      roots.push(...mod.contentRoots);
      roots.push(...mod.sourceRoots);

      if (Array.isArray(mod.dependencies)) {
        for (const depName of mod.dependencies) {
          const depMod = allModules.find(
            (m) => m.name === depName || m.externalProjectId === depName,
          );
          if (depMod) {
            collectRoots(depMod);
          }
        }
      }
    };

    collectRoots(targetModule);
    return roots;
  }

  private async resolveManifestComponent(options: {
    projectRoot: string;
    fileUri: string;
    filePath: string;
    text: string;
    position: { line: number; character: number };
  }): Promise<LspLocation[] | null> {
    const { projectRoot, fileUri, filePath, text, position } = options;

    let elements: XmlElement[];
    try {
      elements = parseXml(text);
    } catch {
      return null;
    }

    const offset = offsetAt(text, position);
    const element = findInnermostElementAt(elements, offset);
    if (!element) return null;

    for (const [, attrData] of Object.entries(element.attributes)) {
      if (offset >= attrData.start && offset <= attrData.end) {
        const resRef = parseResourceValue(attrData.value);
        if (resRef) {
          if (resRef.ns === 'android') return null;
          return this.resolveXmlResource(options);
        }
      }
    }

    if (!isValidManifestComponentStructure(element)) {
      return null;
    }

    let targetAttr: { name: string; value: string; start: number; end: number } | null = null;
    for (const [attrName, attrData] of Object.entries(element.attributes)) {
      if (offset >= attrData.start && offset <= attrData.end) {
        targetAttr = { name: attrName, ...attrData };
        break;
      }
    }

    if (!targetAttr) return null;
    const androidPrefix = targetAttr.name.split(':');
    if (androidPrefix.length !== 2 || !hasAndroidPrefix(element, androidPrefix[0])) return null;

    const isTargetActivity =
      element.name === 'activity-alias' && androidPrefix[1] === 'targetActivity';
    const isName = element.name !== 'activity-alias' && androidPrefix[1] === 'name';

    if (!isName && !isTargetActivity) {
      return null;
    }

    const rawValue = targetAttr.value.trim();
    if (!rawValue || rawValue.includes('${')) {
      return null;
    }

    const modules = await this.getWorkspaceModules();
    if (!modules || modules.length === 0) return null;

    const targetModule = this.findModuleForFile(filePath, modules);
    if (!targetModule) return null;

    const moduleRoot = this.resolveModuleRoot(targetModule, projectRoot);
    const variant = await this.getConfirmedVariant(targetModule, fileUri, moduleRoot);
    if (!variant) return null;

    const namespace = await this.getModuleNamespace(moduleRoot, variant);
    if (!namespace) return null;

    let targetFqcn: string;
    if (rawValue.startsWith('.')) {
      targetFqcn = namespace + rawValue;
    } else if (!rawValue.includes('.')) {
      targetFqcn = `${namespace}.${rawValue}`;
    } else {
      targetFqcn = rawValue;
    }

    const dotFqcn = targetFqcn.replace(/\$/g, '.');
    const simpleName = dotFqcn.split('.').pop();
    if (!simpleName) return null;

    const symbolsRaw = await this.request('workspace/symbol', { query: simpleName });
    if (!Array.isArray(symbolsRaw)) return null;

    const allowedRoots = this.getAllowedModuleRoots(targetModule, modules, projectRoot);
    const candidates: LspLocation[] = [];

    for (const sym of symbolsRaw) {
      if (!sym || typeof sym !== 'object') continue;
      const s = sym as {
        name: string;
        containerName?: string;
        location?: { uri: string; range: LspRange };
      };
      if (!s.name || !s.location?.uri) continue;

      const locUri = s.location.uri;
      if (!isReliableSourceTarget(locUri)) continue;

      const symFilePath = toLocalFsPath(locUri);
      if (!this.isPathInAllowedRoots(symFilePath, allowedRoots)) continue;

      const symContainer = s.containerName ? s.containerName.trim() : '';
      const fullSymName = symContainer ? `${symContainer}.${s.name}` : s.name;

      if (s.name === simpleName && (fullSymName === dotFqcn || fullSymName === targetFqcn)) {
        candidates.push(s.location);
      }
    }

    if (candidates.length === 1) {
      return candidates;
    }

    return null;
  }

  private async resolveXmlResource(options: {
    projectRoot: string;
    fileUri: string;
    filePath: string;
    text: string;
    position: { line: number; character: number };
  }): Promise<LspLocation[] | null> {
    const { projectRoot, fileUri, filePath, text, position } = options;

    let elements: XmlElement[];
    try {
      elements = parseXml(text);
    } catch {
      return null;
    }

    const offset = offsetAt(text, position);
    const element = findInnermostElementAt(elements, offset);
    if (!element) return null;

    let resRef: { type: string; name: string; ns?: string } | null = null;

    for (const [, attrData] of Object.entries(element.attributes)) {
      if (offset >= attrData.start && offset <= attrData.end) {
        resRef = parseResourceValue(attrData.value);
        break;
      }
    }

    if (!resRef) return null;

    if (resRef.ns === 'android') {
      return null;
    }

    const modules = await this.getWorkspaceModules();
    if (!modules || modules.length === 0) return null;

    const targetModule = this.findModuleForFile(filePath, modules);
    if (!targetModule) return null;

    const moduleRoot = this.resolveModuleRoot(targetModule, projectRoot);
    const variant = await this.getConfirmedVariant(targetModule, fileUri, moduleRoot);
    if (!variant) return null;

    const namespace = await this.getModuleNamespace(moduleRoot, variant);
    if (!namespace) return null;

    if (resRef.ns && resRef.ns !== namespace) return null;

    const locations = await resolveResourceDefinition({
      moduleRoot,
      variant,
      namespace,
      type: resRef.type,
      name: resRef.name,
      readDocument: (path: string) => this.readDocument(pathToFileURL(path).href),
      documentPaths: this.documentPaths(),
    });

    return locations && locations.length > 0 ? locations : null;
  }

  private async resolveKotlinJavaRReference(options: {
    projectRoot: string;
    fileUri: string;
    filePath: string;
    text: string;
    position: { line: number; character: number };
    upstreamLocations: LspLocation[];
  }): Promise<LspLocation[] | null> {
    const { projectRoot, fileUri, filePath, text, position, upstreamLocations } = options;

    if (upstreamLocations.length === 0) {
      return null;
    }

    let upstreamRTarget: { package: string; type?: string } | null = null;
    for (const loc of upstreamLocations) {
      if (isRClassTarget(loc.uri)) {
        const parsed = parseRTargetUri(loc.uri);
        if (parsed?.package) {
          upstreamRTarget = { package: parsed.package, type: parsed.type };
          break;
        }
      }
    }

    if (!upstreamRTarget) {
      return null;
    }

    const lines = text.split(/\r?\n/);
    const lineText = lines[position.line] ?? '';
    const refFromLine = extractRReferenceAtPosition(lineText, position.character);

    const resType = upstreamRTarget.type ?? refFromLine?.type;
    const resName = refFromLine?.name ?? getWordAtPosition(lineText, position.character);
    const resPkg = refFromLine?.package ?? upstreamRTarget.package;

    if (!resType || !resName || !resPkg) {
      return null;
    }

    if (resPkg === 'android' || resPkg.startsWith('android.')) {
      return null;
    }

    if (
      resPkg !== upstreamRTarget.package ||
      (refFromLine?.type && upstreamRTarget.type && refFromLine.type !== upstreamRTarget.type)
    )
      return null;
    if (getWordAtPosition(lineText, position.character) !== resName) return null;

    const modules = await this.getWorkspaceModules();
    if (!modules || modules.length === 0) return null;

    const targetModule = this.findModuleForFile(filePath, modules);
    if (!targetModule) return null;

    const moduleRoot = this.resolveModuleRoot(targetModule, projectRoot);
    const variant = await this.getConfirmedVariant(targetModule, fileUri, moduleRoot);
    if (!variant) return null;

    const namespace = resPkg;
    const locations = await resolveResourceDefinition({
      moduleRoot,
      variant,
      namespace,
      type: resType,
      name: resName,
      readDocument: (path: string) => this.readDocument(pathToFileURL(path).href),
      documentPaths: this.documentPaths(),
    });

    return locations && locations.length > 0 ? locations : null;
  }
}
