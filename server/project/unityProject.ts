import * as fs from 'fs';
import * as path from 'path';
import { pathKey } from './pathUtils';

export type IncludeResolution =
  | { status: 'resolved'; path: string; via: 'relative' | 'assets' | 'packages' | 'project' | 'absolute' }
  /** Unityエディタに同梱されるinclude(UnityCG.cginc等)。ディスク上には存在しない。 */
  | { status: 'builtin' }
  | { status: 'unresolved' };

/** child が parent と同じか、その内側にあるか(大文字小文字はOSに合わせる)。 */
export function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(pathKey(parent), pathKey(child));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export const INCLUDE_FILE_EXTENSIONS = new Set(['.hlsl', '.hlsli', '.cginc', '.glslinc', '.cg', '.compute']);

export interface IncludeCompletionEntry {
  name: string;
  isDirectory: boolean;
}

/**
 * Unityプロジェクトの構造(ルート・パッケージ配置)を把握し、#include のパスを解決する。
 * 1つのワークスペースに複数のUnityプロジェクトがあっても、ファイルごとに最も近いルートを使う。
 */
export class UnityProjectResolver {
  /** ディレクトリ -> Unityプロジェクトルート(なければnull)。 */
  private readonly rootCache = new Map<string, string | null>();
  /** プロジェクトルート -> (パッケージ名 -> 実ディレクトリ)。 */
  private readonly packageCache = new Map<string, Map<string, string>>();
  private readonly resolutionCache = new Map<string, IncludeResolution>();
  private readonly statCache = new Map<string, 'file' | 'directory' | 'missing'>();
  private workspacePackages: Map<string, string> | undefined;
  /** 解決結果が変わり得る変更があるたびに増える。 */
  public generation = 0;

  public constructor(private workspaceFolders: string[]) {}

  public setWorkspaceFolders(folders: string[]): void {
    this.workspaceFolders = folders;
    this.invalidate();
  }

  public getWorkspaceFolders(): string[] {
    return this.workspaceFolders;
  }

  /** ファイル作成/削除/パッケージ更新時にキャッシュを破棄する。 */
  public invalidate(): void {
    this.rootCache.clear();
    this.packageCache.clear();
    this.resolutionCache.clear();
    this.statCache.clear();
    this.workspacePackages = undefined;
    this.generation++;
  }

  /** ファイル内容の変更だけなら解決結果は変わらない。存在有無の変化だけを反映する。 */
  public notifyFileCreatedOrDeleted(filePath: string): void {
    this.statCache.delete(pathKey(filePath));
    this.resolutionCache.clear();
    if (/[\\/](Packages|PackageCache)[\\/]/i.test(filePath) || path.basename(filePath) === 'package.json') {
      this.packageCache.clear();
      this.workspacePackages = undefined;
    }
    this.generation++;
  }

  /** ファイルを含むUnityプロジェクトのルート(Assets と ProjectSettings を持つディレクトリ)。 */
  public findProjectRoot(filePath: string): string | undefined {
    const visited: string[] = [];
    let directory = path.dirname(path.resolve(filePath));
    let result: string | null = null;
    for (;;) {
      const key = pathKey(directory);
      const cached = this.rootCache.get(key);
      if (cached !== undefined) {
        result = cached;
        break;
      }
      visited.push(key);
      if (this.isDirectory(path.join(directory, 'Assets')) && this.isDirectory(path.join(directory, 'ProjectSettings'))) {
        result = directory;
        break;
      }
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    for (const key of visited) this.rootCache.set(key, result);
    return result ?? undefined;
  }

  public resolve(includePath: string, fromPath: string): IncludeResolution {
    const normalized = includePath.trim().replace(/\\/g, '/');
    const fromDirectory = path.dirname(fromPath);
    const cacheKey = `${pathKey(fromDirectory)}\0${normalized}`;
    const cached = this.resolutionCache.get(cacheKey);
    if (cached) return cached;
    const result = this.resolveUncached(normalized, fromPath);
    this.resolutionCache.set(cacheKey, result);
    if (this.resolutionCache.size > 20000) this.resolutionCache.clear();
    return result;
  }

  private resolveUncached(includePath: string, fromPath: string): IncludeResolution {
    if (!includePath) return { status: 'unresolved' };
    if (path.isAbsolute(includePath)) {
      return this.isFile(includePath) ? { status: 'resolved', path: path.normalize(includePath), via: 'absolute' } : { status: 'unresolved' };
    }
    const root = this.findProjectRoot(fromPath);
    // 相対パスは include 元が属するUnityプロジェクト(またはパッケージ/ワークスペース)の外へは出さない。
    const boundary = this.searchBoundary(fromPath);

    if (/^Packages\//i.test(includePath)) {
      const resolved = this.resolvePackagePath(includePath, root);
      if (resolved) return { status: 'resolved', path: resolved, via: 'packages' };
    }
    if (/^Assets\//i.test(includePath) && root) {
      const candidate = path.join(root, includePath);
      if (this.isFileWithin(path.join(root, 'Assets'), candidate)) {
        return { status: 'resolved', path: path.normalize(candidate), via: 'assets' };
      }
    }

    const relative = path.resolve(path.dirname(fromPath), includePath);
    if (this.isFileWithin(boundary, relative)) return { status: 'resolved', path: relative, via: 'relative' };

    if (root) {
      const projectRelative = path.resolve(root, includePath);
      if (this.isFileWithin(root, projectRelative)) return { status: 'resolved', path: projectRelative, via: 'project' };
    }
    // ワークスペース直下からの相対(Unityプロジェクト外でHLSLライブラリを開いている場合)
    if (!root) {
      for (const folder of this.workspaceFolders) {
        const candidate = path.resolve(folder, includePath);
        if (this.isFileWithin(folder, candidate)) return { status: 'resolved', path: candidate, via: 'project' };
      }
    }

    if (this.isBuiltinInclude(includePath)) return { status: 'builtin' };
    return { status: 'unresolved' };
  }

  /**
   * 相対パスで探索してよい範囲。
   * Unityプロジェクト内ならプロジェクトルート、プロジェクト外のローカルパッケージ(manifest の file: 参照)なら
   * そのパッケージ、それ以外はワークスペースフォルダ(どれにも属さなければファイルのフォルダ)。
   */
  public searchBoundary(fromPath: string): string {
    const root = this.findProjectRoot(fromPath);
    if (root) return root;
    let directory = path.dirname(path.resolve(fromPath));
    for (;;) {
      if (this.isFile(path.join(directory, 'package.json'))) return directory;
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    const folder = this.workspaceFolders.find((candidate) => isWithin(candidate, fromPath));
    return folder ?? path.dirname(path.resolve(fromPath));
  }

  /** boundary の内側にあるファイルか。シンボリックリンクで外へ出る場合も除外する。 */
  private isFileWithin(boundary: string, candidate: string): boolean {
    if (!isWithin(boundary, candidate) || !this.isFile(candidate)) return false;
    try {
      return isWithin(fs.realpathSync.native(boundary), fs.realpathSync.native(candidate));
    } catch {
      return false;
    }
  }

  /** Unityエディタ本体に同梱されるinclude(Built-in RP の CGIncludes)。 */
  public isBuiltinInclude(includePath: string): boolean {
    if (includePath.includes('/')) return false;
    const extension = path.extname(includePath).toLowerCase();
    return extension === '.cginc' || extension === '.glslinc' || /^(Unity|HLSLSupport|Lighting|AutoLight|TerrainEngine|Tessellation)/.test(includePath);
  }

  /** `Packages/<name>/...` を実パスへ変換する。 */
  public resolvePackagePath(includePath: string, root: string | undefined): string | undefined {
    const match = /^Packages\/([^/]+)\/?(.*)$/i.exec(includePath);
    if (!match) return undefined;
    const packageDirectory = this.findPackageDirectory(match[1], root);
    if (!packageDirectory) return undefined;
    const candidate = path.join(packageDirectory, match[2]);
    return this.isFile(candidate) ? path.normalize(candidate) : undefined;
  }

  public findPackageDirectory(packageName: string, root: string | undefined): string | undefined {
    if (root) {
      const found = this.getPackages(root).get(packageName.toLowerCase());
      if (found) return found;
    }
    return this.getWorkspacePackages().get(packageName.toLowerCase());
  }

  /** プロジェクトで利用できるパッケージ(名前 -> ディレクトリ)。 */
  public getPackages(root: string): Map<string, string> {
    const key = pathKey(root);
    const cached = this.packageCache.get(key);
    if (cached) return cached;
    const packages = new Map<string, string>();

    // Library/PackageCache/<name>@<version|hash>
    const cacheDirectory = path.join(root, 'Library', 'PackageCache');
    const cacheEntries = this.readDirectory(cacheDirectory);
    const candidates = new Map<string, Array<{ directory: string; mtime: number }>>();
    for (const entry of cacheEntries) {
      if (!entry.isDirectory()) continue;
      const at = entry.name.indexOf('@');
      const name = (at > 0 ? entry.name.substring(0, at) : entry.name).toLowerCase();
      const directory = path.join(cacheDirectory, entry.name);
      let mtime = 0;
      try {
        mtime = fs.statSync(directory).mtimeMs;
      } catch {
        // 削除中のディレクトリは無視する。
      }
      const list = candidates.get(name) ?? [];
      list.push({ directory, mtime });
      candidates.set(name, list);
    }
    for (const [name, list] of candidates) {
      // 複数バージョンが残っている場合は最も新しいものを使う。
      list.sort((a, b) => b.mtime - a.mtime);
      packages.set(name, list[0].directory);
    }

    // Packages/manifest.json の "file:" 参照(ローカルパッケージ)
    const manifestPath = path.join(root, 'Packages', 'manifest.json');
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { dependencies?: Record<string, string> };
      for (const [name, value] of Object.entries(manifest.dependencies ?? {})) {
        if (typeof value === 'string' && value.startsWith('file:')) {
          const target = path.resolve(path.join(root, 'Packages'), value.substring('file:'.length));
          if (this.isDirectory(target)) packages.set(name.toLowerCase(), target);
        }
      }
    } catch {
      // manifestがない/壊れている場合は無視する。
    }

    // Packages/<folder>/package.json (埋め込みパッケージ)。フォルダ名とパッケージ名が異なる場合もある。
    const embeddedRoot = path.join(root, 'Packages');
    for (const entry of this.readDirectory(embeddedRoot)) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(embeddedRoot, entry.name);
      const name = this.readPackageName(directory) ?? entry.name;
      packages.set(name.toLowerCase(), directory);
      if (name.toLowerCase() !== entry.name.toLowerCase() && !packages.has(entry.name.toLowerCase())) {
        packages.set(entry.name.toLowerCase(), directory);
      }
    }

    this.packageCache.set(key, packages);
    return packages;
  }

  /** ワークスペース直下(またはその1階層下)にあるpackage.jsonを持つフォルダ。 */
  private getWorkspacePackages(): Map<string, string> {
    if (this.workspacePackages) return this.workspacePackages;
    const packages = new Map<string, string>();
    for (const folder of this.workspaceFolders) {
      const candidates = [folder, ...this.readDirectory(folder).filter((e) => e.isDirectory()).map((e) => path.join(folder, e.name))];
      for (const directory of candidates) {
        const name = this.readPackageName(directory);
        if (name) packages.set(name.toLowerCase(), directory);
      }
    }
    this.workspacePackages = packages;
    return packages;
  }

  private readPackageName(directory: string): string | undefined {
    try {
      const json = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')) as { name?: unknown };
      return typeof json.name === 'string' ? json.name : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * include補完の候補。`typed` は入力中のパス(最後の `/` まで)。
   */
  public listIncludeCompletions(typedDirectory: string, fromPath: string): IncludeCompletionEntry[] {
    const root = this.findProjectRoot(fromPath);
    const normalized = typedDirectory.replace(/\\/g, '/');
    const entries: IncludeCompletionEntry[] = [];

    if (normalized === '') {
      entries.push({ name: 'Packages', isDirectory: true });
      if (root) entries.push({ name: 'Assets', isDirectory: true });
    }

    let directory: string | undefined;
    if (/^Packages\/$/i.test(normalized)) {
      const names = new Set<string>();
      if (root) for (const name of this.getPackages(root).keys()) names.add(name);
      for (const name of this.getWorkspacePackages().keys()) names.add(name);
      for (const name of names) {
        if (name.startsWith('com.unity.modules.')) continue;
        entries.push({ name, isDirectory: true });
      }
      return entries;
    }
    let boundary: string | undefined;
    const packageMatch = /^Packages\/([^/]+)\/(.*)$/i.exec(normalized);
    if (packageMatch) {
      const packageDirectory = this.findPackageDirectory(packageMatch[1], root);
      if (packageDirectory) {
        directory = path.join(packageDirectory, packageMatch[2]);
        boundary = packageDirectory;
      }
    } else if (/^Assets\//i.test(normalized) && root) {
      directory = path.join(root, normalized);
      boundary = path.join(root, 'Assets');
    } else {
      directory = path.resolve(path.dirname(fromPath), normalized || '.');
      boundary = this.searchBoundary(fromPath);
    }
    // `../` を重ねてもプロジェクトの外のフォルダは列挙しない。
    if (!directory || !boundary || !isWithin(boundary, directory)) return entries;

    for (const entry of this.readDirectory(directory)) {
      if (entry.name.startsWith('.') && entry.isDirectory()) continue;
      if (entry.isDirectory()) {
        if (/^(Library|Temp|Logs|obj|Build|Builds|UserSettings|node_modules)$/.test(entry.name)) continue;
        entries.push({ name: entry.name, isDirectory: true });
      } else if (INCLUDE_FILE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        entries.push({ name: entry.name, isDirectory: false });
      }
    }
    return entries;
  }

  public isFile(filePath: string): boolean {
    return this.stat(filePath) === 'file';
  }

  public isDirectory(filePath: string): boolean {
    return this.stat(filePath) === 'directory';
  }

  private stat(filePath: string): 'file' | 'directory' | 'missing' {
    const key = pathKey(filePath);
    const cached = this.statCache.get(key);
    if (cached) return cached;
    let result: 'file' | 'directory' | 'missing' = 'missing';
    try {
      const stat = fs.statSync(filePath);
      result = stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'missing';
    } catch {
      result = 'missing';
    }
    if (this.statCache.size > 50000) this.statCache.clear();
    this.statCache.set(key, result);
    return result;
  }

  private readDirectory(directory: string): fs.Dirent[] {
    try {
      return fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return [];
    }
  }
}
