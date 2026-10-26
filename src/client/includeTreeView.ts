import * as path from 'path';
import * as vscode from 'vscode';
import {
  IncludeTreeChild,
  IncludeTreeRootsResult,
  Requests,
} from '../../shared/protocol';
import { getClient } from './languageClient';

const SHADER_EXTENSIONS = new Set(['.shader', '.hlsl', '.hlsli', '.cginc', '.compute', '.glslinc', '.cg']);

export type IncludeTreeNode =
  | { kind: 'root'; uri: vscode.Uri; active: boolean; pinned: boolean }
  | { kind: 'include'; uri?: vscode.Uri; parent: vscode.Uri; child: IncludeTreeChild; ancestors: string[]; depth: number }
  | { kind: 'message'; text: string };

function key(uri: vscode.Uri): string {
  return process.platform === 'win32' ? uri.fsPath.toLowerCase() : uri.fsPath;
}

function isPackageCache(uri: vscode.Uri): boolean {
  return /[\\/]Library[\\/]PackageCache[\\/]/i.test(uri.fsPath);
}

/**
 * アクティブなシェーダーファイルを含むroot(Shader/compute等)と、そこからのinclude階層を表示する。
 * include解決はLanguage Serverと共通の結果を使う。
 */
export class IncludeTreeProvider implements vscode.TreeDataProvider<IncludeTreeNode> {
  private readonly changed = new vscode.EventEmitter<IncludeTreeNode | undefined>();
  public readonly onDidChangeTreeData = this.changed.event;
  /** 最後に開いていたシェーダーファイル(ツリーをクリックしてもフォーカスが外れないように保持)。 */
  private activeUri: vscode.Uri | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  public constructor() {
    this.updateActiveEditor(vscode.window.activeTextEditor);
  }

  public updateActiveEditor(editor: vscode.TextEditor | undefined): boolean {
    const uri = editor?.document.uri;
    if (!uri || uri.scheme !== 'file' || !SHADER_EXTENSIONS.has(path.extname(uri.fsPath).toLowerCase())) return false;
    if (this.activeUri && key(this.activeUri) === key(uri)) return false;
    this.activeUri = uri;
    return true;
  }

  public getActiveUri(): vscode.Uri | undefined {
    return this.activeUri;
  }

  /** 連続したイベントをまとめて再描画する。 */
  public refresh(delay = 150): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.changed.fire(undefined);
    }, delay);
  }

  public async getChildren(node?: IncludeTreeNode): Promise<IncludeTreeNode[]> {
    const client = getClient();
    if (!client) return [{ kind: 'message', text: 'Language Serverを起動しています…' }];
    if (!node) {
      if (!this.activeUri) return [{ kind: 'message', text: 'シェーダーファイル(.shader / .hlsl)を開くとinclude構成を表示します。' }];
      const result = await client.sendRequest<IncludeTreeRootsResult>(Requests.includeTreeRoots, {
        activeUri: this.activeUri.toString(),
      });
      if (result.roots.length === 0) return [{ kind: 'message', text: 'include構成が見つかりません。' }];
      return result.roots.map((root) => ({
        kind: 'root',
        uri: vscode.Uri.parse(root.uri),
        active: root.active,
        pinned: root.pinned,
      }));
    }
    if (node.kind === 'message') return [];
    const uri = node.uri;
    if (!uri) return [];
    const children = await client.sendRequest<IncludeTreeChild[]>(Requests.includeTreeChildren, { uri: uri.toString() });
    const ancestors = node.kind === 'root' ? [key(node.uri)] : node.ancestors;
    const depth = node.kind === 'root' ? 1 : node.depth + 1;
    return children.map((child) => {
      const childUri = child.uri ? vscode.Uri.parse(child.uri) : undefined;
      return {
        kind: 'include',
        uri: childUri,
        parent: uri,
        child,
        ancestors: childUri ? [...ancestors, key(childUri)] : ancestors,
        depth,
      };
    });
  }

  public getTreeItem(node: IncludeTreeNode): vscode.TreeItem {
    if (node.kind === 'message') {
      const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon('info');
      return item;
    }
    const active = this.activeUri;
    if (node.kind === 'root') {
      const item = new vscode.TreeItem(path.basename(node.uri.fsPath), vscode.TreeItemCollapsibleState.Collapsed);
      item.resourceUri = node.uri;
      item.tooltip = node.uri.fsPath;
      const tags: string[] = [];
      if (node.active) tags.push('解析中');
      if (node.pinned) tags.push('固定');
      if (active && key(active) === key(node.uri)) tags.push('編集中');
      item.description = tags.join(' · ');
      item.iconPath = node.pinned
        ? new vscode.ThemeIcon('pinned', new vscode.ThemeColor('charts.yellow'))
        : node.active
          ? new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed'))
          : new vscode.ThemeIcon('file-code');
      item.collapsibleState = node.active ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
      item.contextValue = node.pinned ? 'urpShaderLab.root.pinned' : 'urpShaderLab.root';
      item.command = { command: 'vscode.open', title: '開く', arguments: [node.uri] };
      return item;
    }

    const child = node.child;
    if (!node.uri) {
      const item = new vscode.TreeItem(child.includePath, vscode.TreeItemCollapsibleState.None);
      item.description = child.status === 'builtin' ? 'Unity組み込み(解析対象外)' : '見つかりません';
      item.iconPath =
        child.status === 'builtin'
          ? new vscode.ThemeIcon('library')
          : new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
      item.contextValue = 'urpShaderLab.include.unresolved';
      item.command = revealLineCommand(node.parent, child.line);
      return item;
    }
    const cycle = node.ancestors.slice(0, -1).includes(key(node.uri));
    const item = new vscode.TreeItem(path.basename(node.uri.fsPath));
    item.resourceUri = node.uri;
    item.tooltip = `${child.includePath}\n${node.uri.fsPath}`;
    const isActive = !!active && key(active) === key(node.uri);
    item.description = [cycle ? '循環include' : '', isActive ? '編集中' : '', path.dirname(child.includePath) === '.' ? '' : child.includePath]
      .filter(Boolean)
      .join(' · ');
    item.iconPath = cycle
      ? new vscode.ThemeIcon('sync', new vscode.ThemeColor('editorWarning.foreground'))
      : isActive
        ? new vscode.ThemeIcon('arrow-right', new vscode.ThemeColor('editorWarning.foreground'))
        : isPackageCache(node.uri)
          ? new vscode.ThemeIcon('package')
          : new vscode.ThemeIcon('file');
    item.collapsibleState = cycle
      ? vscode.TreeItemCollapsibleState.None
      : !isPackageCache(node.uri) && node.depth <= 2
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed;
    item.contextValue = 'urpShaderLab.include';
    item.command = { command: 'vscode.open', title: '開く', arguments: [node.uri] };
    return item;
  }
}

function revealLineCommand(uri: vscode.Uri, line: number): vscode.Command {
  return {
    command: 'vscode.open',
    title: 'includeの位置へ移動',
    arguments: [uri, { selection: new vscode.Range(line, 0, line, 0) } satisfies vscode.TextDocumentShowOptions],
  };
}

export function revealIncludeLine(node: IncludeTreeNode | undefined): void {
  if (!node || node.kind !== 'include') return;
  const command = revealLineCommand(node.parent, node.child.line);
  void vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
}
