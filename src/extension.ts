import * as path from 'path';
import * as vscode from 'vscode';
import { registerColorCustomizer } from './client/colorCustomizer';
import { IncludeTreeNode, IncludeTreeProvider, revealIncludeLine } from './client/includeTreeView';
import {
  onIncludeGraphChanged,
  refreshProject,
  requestMemoryStats,
  setPinnedRoot,
  startLanguageClient,
  stopLanguageClient,
} from './client/languageClient';

const PINNED_ROOT_KEY = 'urpShaderLab.pinnedRoot';
const HAS_PINNED_ROOT_CONTEXT = 'urpShaderLab.hasPinnedRoot';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  if (!vscode.workspace.getConfiguration('urpShaderLab').get<boolean>('enable', true)) {
    return;
  }

  registerColorCustomizer(context);

  // 解析rootの固定はワークスペースごとに保持する。
  const pinnedRoot = context.workspaceState.get<string>(PINNED_ROOT_KEY);
  void vscode.commands.executeCommand('setContext', HAS_PINNED_ROOT_CONTEXT, !!pinnedRoot);

  const tree = new IncludeTreeProvider();
  const view = vscode.window.createTreeView('urpShaderLab.includeTree', { treeDataProvider: tree, showCollapseAll: true });
  context.subscriptions.push(view);

  const output = vscode.window.createOutputChannel('URP ShaderLab Tools (Stats)');
  context.subscriptions.push(output);

  const pin = async (uri: vscode.Uri | undefined): Promise<void> => {
    if (!uri) {
      void vscode.window.showWarningMessage('Include Treeから固定するファイルを選択してください。');
      return;
    }
    await context.workspaceState.update(PINNED_ROOT_KEY, uri.toString());
    await vscode.commands.executeCommand('setContext', HAS_PINNED_ROOT_CONTEXT, true);
    await setPinnedRoot(uri.toString());
    tree.refresh(0);
    void vscode.window.setStatusBarMessage(`解析rootを固定しました: ${path.basename(uri.fsPath)}`, 4000);
  };
  const unpin = async (): Promise<void> => {
    await context.workspaceState.update(PINNED_ROOT_KEY, undefined);
    await vscode.commands.executeCommand('setContext', HAS_PINNED_ROOT_CONTEXT, false);
    await setPinnedRoot(undefined);
    tree.refresh(0);
    void vscode.window.setStatusBarMessage('解析rootの固定を解除しました', 4000);
  };
  const nodeUri = (node?: IncludeTreeNode): vscode.Uri | undefined => {
    if (!node || node.kind === 'message') return undefined;
    return node.uri;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('urpShaderLab.selectAnalysisRoot', (node?: IncludeTreeNode) =>
      pin(nodeUri(node) ?? tree.getActiveUri()),
    ),
    vscode.commands.registerCommand('urpShaderLab.clearAnalysisRoot', unpin),
    vscode.commands.registerCommand('urpShaderLab.refreshIncludeTree', async () => {
      await vscode.window.withProgress(
        { location: { viewId: 'urpShaderLab.includeTree' }, title: 'シェーダーを再解析しています' },
        () => refreshProject(),
      );
      tree.refresh(0);
    }),
    vscode.commands.registerCommand('urpShaderLab.revealIncludeLine', (node?: IncludeTreeNode) => revealIncludeLine(node)),
    vscode.commands.registerCommand('urpShaderLab.showMemoryStats', async () => {
      const stats = await requestMemoryStats();
      if (!stats) return;
      output.appendLine(`[${new Date().toLocaleTimeString()}] ${JSON.stringify(stats, null, 2)}`);
      output.show(true);
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (tree.updateActiveEditor(editor)) tree.refresh();
    }),
  );

  try {
    await startLanguageClient(context, pinnedRoot);
  } catch (error) {
    void vscode.window.showErrorMessage(`URP ShaderLab Language Serverの起動に失敗しました: ${String(error)}`);
    return;
  }
  context.subscriptions.push(onIncludeGraphChanged(() => tree.refresh()));
  tree.refresh(0);
}

export async function deactivate(): Promise<void> {
  await stopLanguageClient();
}
