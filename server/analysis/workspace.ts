import * as fs from 'fs';
import { defaultServerSettings, ServerSettings } from '../../shared/protocol';
import { IncludeGraph } from '../project/includeGraph';
import { isShaderSourcePath, pathKey, pathToUri, uriToPath } from '../project/pathUtils';
import { UnityProjectResolver } from '../project/unityProject';
import { AnalysisContext, ContextEntry, UnresolvedInclude } from './context';
import { SourceFile } from './sourceFile';

interface OpenDocument {
  uri: string;
  path: string;
  text: string;
  version: number;
  file?: SourceFile;
}

const MAX_EXTERNAL_FILES = 800;
const MAX_CONTEXTS = 96;
const MAX_CONTEXT_FILES = 2000;
const INCLUDE_BLOCK_KINDS = new Set(['HLSLINCLUDE', 'CGINCLUDE']);

export type FileChangeType = 'created' | 'changed' | 'deleted';

/**
 * 開いているドキュメント・外部ファイルのキャッシュ・解析コンテキストを管理する。
 * LSPには依存しないため、テストからも直接利用できる。
 */
export class Workspace {
  public readonly project: UnityProjectResolver;
  public readonly graph: IncludeGraph;
  public settings: ServerSettings = defaultServerSettings;
  private readonly openDocuments = new Map<string, OpenDocument>();
  private readonly externalFiles = new Map<string, SourceFile>();
  private readonly loadingFiles = new Map<string, Promise<SourceFile | undefined>>();
  private readonly contexts = new Map<string, AnalysisContext>();
  private readonly buildingContexts = new Map<string, Promise<AnalysisContext>>();
  private readonly rootContextCache = new Map<
    string,
    { graphGeneration: number; pinned: string | undefined; context: AnalysisContext }
  >();
  private pinnedRoot: string | undefined;

  public constructor(workspaceFolders: string[]) {
    this.project = new UnityProjectResolver(workspaceFolders);
    this.graph = new IncludeGraph(this.project);
  }

  /* -------------------------------------------------------------------------
   * ドキュメント
   * ----------------------------------------------------------------------- */

  public openDocument(uri: string, text: string, version: number): void {
    const filePath = uriToPath(uri);
    if (!filePath) return;
    const key = pathKey(filePath);
    this.openDocuments.set(key, { uri, path: filePath, text, version });
    this.externalFiles.delete(key);
  }

  public changeDocument(uri: string, text: string, version: number): void {
    const filePath = uriToPath(uri);
    if (!filePath) return;
    const key = pathKey(filePath);
    const existing = this.openDocuments.get(key);
    if (existing && existing.version === version && existing.text === text) return;
    this.openDocuments.set(key, { uri, path: filePath, text, version });
  }

  public closeDocument(uri: string): void {
    const filePath = uriToPath(uri);
    if (!filePath) return;
    const key = pathKey(filePath);
    this.openDocuments.delete(key);
    this.rootContextCache.delete(key);
    // 保存されていない編集内容を破棄するため、ディスクの内容で再登録させる。
    void this.refreshGraphFromDisk(filePath);
  }

  public isOpen(filePath: string): boolean {
    return this.openDocuments.has(pathKey(filePath));
  }

  public openUris(): string[] {
    return Array.from(this.openDocuments.values(), (document) => document.uri);
  }

  /** 開いているドキュメントの最新の解析結果(必要なら再解析する)。 */
  public getOpenFile(uri: string): SourceFile | undefined {
    const filePath = uriToPath(uri);
    return filePath ? this.getOpenFileByKey(pathKey(filePath)) : undefined;
  }

  private getOpenFileByKey(key: string): SourceFile | undefined {
    const document = this.openDocuments.get(key);
    if (!document) return undefined;
    if (!document.file || document.file.version !== document.version || document.file.text !== document.text) {
      document.file = new SourceFile(document.uri, document.path, document.text, document.version);
    }
    return document.file;
  }

  /** 現在有効な解析結果(開いていればエディタの内容、そうでなければキャッシュ)。 */
  public currentFile(key: string): SourceFile | undefined {
    return this.getOpenFileByKey(key) ?? this.externalFiles.get(key);
  }

  public uriFor(filePath: string): string {
    return this.openDocuments.get(pathKey(filePath))?.uri ?? pathToUri(filePath);
  }

  /** ファイルを読み込んで解析する。開いていればエディタの内容を使う。 */
  public async loadFile(filePath: string): Promise<SourceFile | undefined> {
    const key = pathKey(filePath);
    const open = this.getOpenFileByKey(key);
    if (open) return open;
    const cached = this.externalFiles.get(key);
    if (cached) {
      this.externalFiles.delete(key);
      this.externalFiles.set(key, cached);
      return cached;
    }
    let loading = this.loadingFiles.get(key);
    if (!loading) {
      loading = (async () => {
        try {
          const text = await fs.promises.readFile(filePath, 'utf8');
          const opened = this.getOpenFileByKey(key);
          if (opened) return opened;
          const file = new SourceFile(pathToUri(filePath), filePath, text, -1);
          this.externalFiles.set(key, file);
          this.evictExternalFiles();
          return file;
        } catch {
          return undefined;
        } finally {
          this.loadingFiles.delete(key);
        }
      })();
      this.loadingFiles.set(key, loading);
    }
    return loading;
  }

  private evictExternalFiles(): void {
    if (this.externalFiles.size <= MAX_EXTERNAL_FILES) return;
    const referenced = new Set<string>();
    for (const context of this.contexts.values()) {
      for (const dependency of context.dependencies) referenced.add(dependency.key);
    }
    const target = Math.floor(MAX_EXTERNAL_FILES * 0.8);
    for (const key of Array.from(this.externalFiles.keys())) {
      if (this.externalFiles.size <= target) break;
      if (!referenced.has(key)) this.externalFiles.delete(key);
    }
  }

  /* -------------------------------------------------------------------------
   * 解析コンテキスト
   * ----------------------------------------------------------------------- */

  public setPinnedRoot(filePath: string | undefined): void {
    this.pinnedRoot = filePath;
    this.rootContextCache.clear();
  }

  public getPinnedRoot(): string | undefined {
    return this.pinnedRoot;
  }

  /**
   * ファイルの指定単位を解析するためのコンテキスト。
   * HLSLファイルは、そのファイルをincludeしているroot(固定root/自動選択)の翻訳単位を使う。
   */
  public async contextForUnit(file: SourceFile, unitIndex: number): Promise<AnalysisContext> {
    if (file.isShaderLab) {
      return this.buildContextCached(file, this.visibleUnits(file, unitIndex));
    }
    return this.rootContextFor(file);
  }

  /** ShaderLabの単位から見えるHLSLブロック(同じスコープのHLSLINCLUDEと自身)。 */
  private visibleUnits(file: SourceFile, unitIndex: number): number[] {
    const blocks = file.shader?.blocks ?? [];
    const target = blocks[unitIndex];
    if (!target) return [unitIndex];
    const result: number[] = [];
    blocks.forEach((block, index) => {
      if (index === unitIndex) {
        result.push(index);
        return;
      }
      if (!INCLUDE_BLOCK_KINDS.has(block.kind)) return;
      if (block.subShaderIndex === undefined) {
        result.push(index);
      } else if (block.subShaderIndex === target.subShaderIndex) {
        if (block.passIndex === undefined || block.passIndex === target.passIndex) result.push(index);
      }
    });
    return result;
  }

  /** HLSLファイルの解析に使うrootの翻訳単位を求める。 */
  public async rootContextFor(file: SourceFile): Promise<AnalysisContext> {
    const cached = this.rootContextCache.get(file.key);
    if (
      cached &&
      cached.graphGeneration === this.graph.generation &&
      cached.pinned === this.pinnedRoot &&
      cached.context.isFresh(this.project.generation, (key) => this.currentFile(key)) &&
      cached.context.containsFile(file.key)
    ) {
      return cached.context;
    }
    await this.waitForScan();
    const graphGeneration = this.graph.generation;
    const candidates: string[] = [];
    if (this.pinnedRoot) candidates.push(this.pinnedRoot);
    for (const root of this.graph.findRoots(file.path)) {
      if (!candidates.some((candidate) => pathKey(candidate) === pathKey(root))) candidates.push(root);
    }

    let context: AnalysisContext | undefined;
    for (const rootPath of candidates) {
      if (pathKey(rootPath) === file.key) continue;
      const rootFile = await this.loadFile(rootPath);
      if (!rootFile) continue;
      context = await this.findContextContaining(rootFile, file.key);
      if (context) break;
    }
    if (!context) {
      // ワークスペース外(PackageCache等)のファイルは、構築済みのコンテキスト
      // (開いているシェーダーからF12で移動した場合など)から逆引きする。
      context = this.findCachedContextContaining(file);
    }
    // 現在のファイルの内容が変わっている可能性があるため、自身を含むことを確認する。
    if (!context || !context.containsFile(file.key)) {
      context = await this.buildContextCached(file, file.units.map((_, index) => index));
    }
    this.rootContextCache.set(file.key, { graphGeneration, pinned: this.pinnedRoot, context });
    return context;
  }

  private findCachedContextContaining(file: SourceFile): AnalysisContext | undefined {
    let best: AnalysisContext | undefined;
    for (const context of this.contexts.values()) {
      const root = context.entries[0]?.file;
      if (!root || root.key === file.key || !context.containsFile(file.key)) continue;
      if (!context.isFresh(this.project.generation, (key) => this.currentFile(key))) continue;
      // シェーダーをrootとするものを優先する。
      if (!best || (root.isShaderLab && !best.entries[0].file.isShaderLab)) best = context;
    }
    return best;
  }

  /** root内で target を含む翻訳単位のコンテキスト。 */
  private async findContextContaining(rootFile: SourceFile, targetKey: string): Promise<AnalysisContext | undefined> {
    if (!rootFile.isShaderLab) {
      const context = await this.buildContextCached(rootFile, rootFile.units.map((_, index) => index));
      return context.containsFile(targetKey) ? context : undefined;
    }
    const blocks = rootFile.shader?.blocks ?? [];
    // プログラムブロックを優先し、なければHLSLINCLUDEも対象にする。
    const order = blocks
      .map((block, index) => ({ block, index }))
      .sort((a, b) => Number(INCLUDE_BLOCK_KINDS.has(a.block.kind)) - Number(INCLUDE_BLOCK_KINDS.has(b.block.kind)));
    for (const { index } of order) {
      const context = await this.buildContextCached(rootFile, this.visibleUnits(rootFile, index));
      if (context.containsFile(targetKey)) return context;
    }
    return undefined;
  }

  /** 解析root(Include Treeで「解析中」と表示するもの)のパス。 */
  public async analysisRootFor(file: SourceFile): Promise<string> {
    if (file.isShaderLab) return file.path;
    const context = await this.rootContextFor(file);
    const first = context.entries[0];
    return first ? first.file.path : file.path;
  }

  private async waitForScan(): Promise<void> {
    if (this.graph.scanned) return;
    // 走査中でも長くは待たない(大規模プロジェクトで最初の応答が遅れすぎないように)。
    await Promise.race([this.graph.scanWorkspace(), new Promise((resolve) => setTimeout(resolve, 3000))]);
  }

  private async buildContextCached(rootFile: SourceFile, unitIndices: number[]): Promise<AnalysisContext> {
    const key = `${rootFile.key}#${unitIndices.join(',')}`;
    const cached = this.contexts.get(key);
    if (cached && cached.dependencies[0] === rootFile && cached.isFresh(this.project.generation, (k) => this.currentFile(k))) {
      this.contexts.delete(key);
      this.contexts.set(key, cached);
      return cached;
    }
    const pending = this.buildingContexts.get(key);
    if (pending) {
      const result = await pending;
      if (result.dependencies[0] === rootFile) return result;
    }
    const build = this.buildContext(key, rootFile, unitIndices);
    this.buildingContexts.set(key, build);
    try {
      const context = await build;
      this.contexts.set(key, context);
      while (this.contexts.size > MAX_CONTEXTS) {
        const oldest = this.contexts.keys().next().value;
        if (oldest === undefined) break;
        this.contexts.delete(oldest);
      }
      return context;
    } finally {
      if (this.buildingContexts.get(key) === build) this.buildingContexts.delete(key);
    }
  }

  private async buildContext(key: string, rootFile: SourceFile, unitIndices: number[]): Promise<AnalysisContext> {
    const projectGeneration = this.project.generation;
    const entries: ContextEntry[] = unitIndices.map((unitIndex) => ({ file: rootFile, unitIndex }));
    const dependencies: SourceFile[] = [rootFile];
    const unresolved: UnresolvedInclude[] = [];
    const visited = new Set<string>([rootFile.key]);
    let level: ContextEntry[] = entries.slice();

    while (level.length > 0 && visited.size < MAX_CONTEXT_FILES) {
      const toLoad: string[] = [];
      for (const entry of level) {
        const unit = entry.file.units[entry.unitIndex];
        if (!unit) continue;
        for (const include of unit.includes) {
          const resolution = this.project.resolve(include.path, entry.file.path);
          if (resolution.status !== 'resolved') {
            unresolved.push({ file: entry.file, include, builtin: resolution.status === 'builtin' });
            continue;
          }
          const includeKey = pathKey(resolution.path);
          if (visited.has(includeKey)) continue;
          visited.add(includeKey);
          toLoad.push(resolution.path);
        }
      }
      const loaded = await Promise.all(toLoad.map((filePath) => this.loadFile(filePath)));
      level = [];
      loaded.forEach((file) => {
        // 解決できたが読み込めないファイルは無視する。
        if (!file) return;
        dependencies.push(file);
        file.units.forEach((_, unitIndex) => {
          const entry = { file, unitIndex };
          entries.push(entry);
          level.push(entry);
        });
      });
    }
    return new AnalysisContext(key, entries, unresolved, dependencies, projectGeneration);
  }

  /* -------------------------------------------------------------------------
   * ファイル変更
   * ----------------------------------------------------------------------- */

  /** 開いているドキュメントのinclude一覧をグラフへ反映する。変化があればtrue。 */
  public refreshGraphFor(uri: string): boolean {
    const filePath = uriToPath(uri);
    if (!filePath) return false;
    const document = this.openDocuments.get(pathKey(filePath));
    if (!document) return false;
    return this.graph.updateFromText(filePath, document.text);
  }

  private async refreshGraphFromDisk(filePath: string): Promise<void> {
    try {
      const text = await fs.promises.readFile(filePath, 'utf8');
      if (!this.isOpen(filePath)) this.graph.updateFromText(filePath, text);
    } catch {
      this.graph.removeFile(filePath);
    }
  }

  /**
   * ファイル監視からの通知を反映する。
   * @returns include構成が変わった可能性がある場合true
   */
  public async onFilesChanged(changes: Array<{ path: string; type: FileChangeType }>): Promise<boolean> {
    let structural = false;
    const refreshes: Promise<void>[] = [];
    for (const change of changes) {
      const key = pathKey(change.path);
      this.externalFiles.delete(key);
      if (change.type !== 'changed') {
        this.project.notifyFileCreatedOrDeleted(change.path);
        structural = true;
      }
      if (change.type === 'deleted') {
        this.graph.removeFile(change.path);
        continue;
      }
      if (isShaderSourcePath(change.path) && !this.isOpen(change.path)) {
        refreshes.push(this.refreshGraphFromDisk(change.path));
      }
    }
    await Promise.all(refreshes);
    if (structural) {
      this.graph.reresolveAll();
    }
    this.rootContextCache.clear();
    return true;
  }

  /** キャッシュをすべて破棄して再走査する。 */
  public async reset(): Promise<void> {
    this.project.invalidate();
    this.externalFiles.clear();
    this.contexts.clear();
    this.rootContextCache.clear();
    await this.graph.rescan();
  }

  public getMemoryStats(): Record<string, unknown> {
    let tokens = 0;
    for (const file of this.externalFiles.values()) tokens += file.tokens.length;
    return {
      process: process.memoryUsage(),
      openDocuments: this.openDocuments.size,
      externalFiles: this.externalFiles.size,
      externalTokens: tokens,
      contexts: this.contexts.size,
      rootContextCache: this.rootContextCache.size,
      includeGraph: this.graph.getStats(),
      pinnedRoot: this.pinnedRoot ?? null,
    };
  }
}
