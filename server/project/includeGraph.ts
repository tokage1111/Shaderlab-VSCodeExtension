import * as fs from 'fs';
import * as path from 'path';
import { isShaderSourcePath, pathKey } from './pathUtils';
import { IncludeResolution, UnityProjectResolver } from './unityProject';

export interface IncludeEdge {
  includePath: string;
  line: number;
  resolution: IncludeResolution;
}

interface GraphNode {
  path: string;
  edges: IncludeEdge[];
  /** ワークスペース走査で見つかったファイル(root候補になり得る)。 */
  inWorkspace: boolean;
}

const EXCLUDED_DIRECTORIES = new Set([
  'Library',
  'Temp',
  'Logs',
  'obj',
  'Obj',
  'Build',
  'Builds',
  'UserSettings',
  'MemoryCaptures',
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '.vs',
  '.vscode',
  '.idea',
]);

const MAX_SCANNED_FILES = 30000;

/** コメントを除去した上で #include 行を抜き出す(高速な事前走査用)。 */
export function scanIncludes(text: string): Array<{ includePath: string; line: number }> {
  const stripped = text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:[^"\\\n]|\\.)*"/g, (match) =>
    match.startsWith('"') ? match : match.replace(/[^\n]/g, ' '),
  );
  const result: Array<{ includePath: string; line: number }> = [];
  const pattern = /^[ \t]*#[ \t]*include(?:_with_pragmas)?[ \t]*(?:"([^"\r\n]*)"|<([^>\r\n]*)>)/gm;
  let match: RegExpExecArray | null;
  let line = 0;
  let counted = 0;
  while ((match = pattern.exec(stripped)) !== null) {
    for (; counted < match.index; counted++) if (stripped.charCodeAt(counted) === 10) line++;
    result.push({ includePath: (match[1] ?? match[2]).trim(), line });
  }
  return result;
}

/**
 * ワークスペース内のシェーダーソースの include 関係。
 * - 「このファイルをincludeしているroot」の探索(解析コンテキストの決定)
 * - Include Tree ビューの表示
 * に使う。完全な構文解析は行わず、include行だけを走査する。
 */
export class IncludeGraph {
  private readonly nodes = new Map<string, GraphNode>();
  private readonly includers = new Map<string, Set<string>>();
  private readonly pendingNodes = new Map<string, Promise<GraphNode | undefined>>();
  private scanPromise: Promise<void> | undefined;
  public generation = 0;
  public scanned = false;

  public constructor(private readonly project: UnityProjectResolver) {}

  /** ワークスペースを走査する。完了済みなら何もしない。 */
  public scanWorkspace(): Promise<void> {
    if (!this.scanPromise) {
      this.scanPromise = this.doScan().finally(() => {
        this.scanned = true;
        this.generation++;
      });
    }
    return this.scanPromise;
  }

  public rescan(): Promise<void> {
    this.nodes.clear();
    this.includers.clear();
    this.scanPromise = undefined;
    this.scanned = false;
    return this.scanWorkspace();
  }

  private async doScan(): Promise<void> {
    const files: string[] = [];
    const pending = [...this.project.getWorkspaceFolders()];
    while (pending.length > 0 && files.length < MAX_SCANNED_FILES) {
      const directory = pending.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(directory, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          pending.push(fullPath);
        } else if (entry.isFile() && isShaderSourcePath(entry.name)) {
          files.push(fullPath);
        }
      }
    }
    // 読み込みは並列数を制限して行う。
    let index = 0;
    const worker = async (): Promise<void> => {
      while (index < files.length) {
        const filePath = files[index++];
        try {
          const text = await fs.promises.readFile(filePath, 'utf8');
          this.setNode(filePath, scanIncludes(text), true);
        } catch {
          // 読めないファイルは無視する。
        }
      }
    };
    await Promise.all(Array.from({ length: 16 }, () => worker()));
  }

  /** 開いているドキュメントなど、最新の内容でinclude一覧を更新する。変化があればtrue。 */
  public updateFromText(filePath: string, text: string): boolean {
    return this.setNode(filePath, scanIncludes(text), this.isInWorkspace(filePath));
  }

  public removeFile(filePath: string): void {
    const key = pathKey(filePath);
    const node = this.nodes.get(key);
    if (!node) return;
    this.detachEdges(key, node);
    this.nodes.delete(key);
    this.generation++;
  }

  /** パッケージ追加などで解決結果が変わった場合に全エッジを再解決する。 */
  public reresolveAll(): void {
    for (const [key, node] of this.nodes) {
      this.detachEdges(key, node);
      node.edges = node.edges.map((edge) => ({
        ...edge,
        resolution: this.project.resolve(edge.includePath, node.path),
      }));
      this.attachEdges(key, node);
    }
    this.generation++;
  }

  private setNode(filePath: string, includes: Array<{ includePath: string; line: number }>, inWorkspace: boolean): boolean {
    const key = pathKey(filePath);
    const edges: IncludeEdge[] = includes.map((include) => ({
      ...include,
      resolution: this.project.resolve(include.includePath, filePath),
    }));
    const existing = this.nodes.get(key);
    if (existing && this.sameEdges(existing.edges, edges)) {
      existing.edges = edges;
      existing.inWorkspace ||= inWorkspace;
      return false;
    }
    if (existing) this.detachEdges(key, existing);
    const node: GraphNode = { path: filePath, edges, inWorkspace: inWorkspace || !!existing?.inWorkspace };
    this.nodes.set(key, node);
    this.attachEdges(key, node);
    this.generation++;
    return true;
  }

  private sameEdges(a: IncludeEdge[], b: IncludeEdge[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      const left = a[i].resolution;
      const right = b[i].resolution;
      if (a[i].includePath !== b[i].includePath || left.status !== right.status) return false;
      if (left.status === 'resolved' && right.status === 'resolved' && pathKey(left.path) !== pathKey(right.path)) return false;
    }
    return true;
  }

  private attachEdges(key: string, node: GraphNode): void {
    for (const edge of node.edges) {
      if (edge.resolution.status !== 'resolved') continue;
      const target = pathKey(edge.resolution.path);
      let set = this.includers.get(target);
      if (!set) {
        set = new Set();
        this.includers.set(target, set);
      }
      set.add(key);
    }
  }

  private detachEdges(key: string, node: GraphNode): void {
    for (const edge of node.edges) {
      if (edge.resolution.status !== 'resolved') continue;
      const target = pathKey(edge.resolution.path);
      const set = this.includers.get(target);
      set?.delete(key);
      if (set && set.size === 0) this.includers.delete(target);
    }
  }

  private isInWorkspace(filePath: string): boolean {
    return this.project.getWorkspaceFolders().some((folder) => {
      const relative = path.relative(folder, filePath);
      return !relative.startsWith('..') && !path.isAbsolute(relative);
    });
  }

  /** ノードを取得する。未登録ならファイルを読み込んで登録する(パッケージ内のinclude等)。 */
  public async getNode(filePath: string): Promise<GraphNode | undefined> {
    const key = pathKey(filePath);
    const existing = this.nodes.get(key);
    if (existing) return existing;
    let pending = this.pendingNodes.get(key);
    if (!pending) {
      pending = (async () => {
        try {
          const text = await fs.promises.readFile(filePath, 'utf8');
          if (!this.nodes.has(key)) this.setNode(filePath, scanIncludes(text), false);
          return this.nodes.get(key);
        } catch {
          return undefined;
        } finally {
          this.pendingNodes.delete(key);
        }
      })();
      this.pendingNodes.set(key, pending);
    }
    return pending;
  }

  public async getEdges(filePath: string): Promise<IncludeEdge[]> {
    return (await this.getNode(filePath))?.edges ?? [];
  }

  /**
   * ファイルを(間接的に)includeしている最上位のファイル群。
   * 自身を誰もincludeしていなければ自身を返す。
   */
  public findRoots(filePath: string): string[] {
    const startKey = pathKey(filePath);
    const visited = new Set<string>([startKey]);
    const queue = [startKey];
    const roots: string[] = [];
    while (queue.length > 0) {
      const key = queue.shift()!;
      const parents = this.includers.get(key);
      const activeParents = parents ? Array.from(parents) : [];
      if (activeParents.length === 0) {
        const node = this.nodes.get(key);
        roots.push(node?.path ?? filePath);
        continue;
      }
      for (const parent of activeParents) {
        if (visited.has(parent)) continue;
        visited.add(parent);
        queue.push(parent);
      }
    }
    // 循環のみで最上位がない場合は自身をrootとする。
    if (roots.length === 0) roots.push(filePath);
    return roots.sort((a, b) => rootOrder(a) - rootOrder(b) || a.localeCompare(b));
  }

  public getStats(): { nodes: number; edges: number } {
    let edges = 0;
    for (const node of this.nodes.values()) edges += node.edges.length;
    return { nodes: this.nodes.size, edges };
  }
}

/** root候補の優先順位: .shader > .compute > その他。 */
function rootOrder(filePath: string): number {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.shader') return 0;
  if (extension === '.compute') return 1;
  return 2;
}
