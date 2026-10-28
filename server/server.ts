import {
  CodeActionKind,
  CompletionList,
  createConnection,
  DidChangeWatchedFilesNotification,
  FileChangeType,
  InitializeParams,
  InitializeResult,
  ProposedFeatures,
  ResponseError,
  TextDocuments,
  TextDocumentSyncKind,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  defaultServerSettings,
  IncludeTreeChildrenParams,
  IncludeTreeRootsParams,
  Notifications,
  Requests,
  ServerSettings,
  SetPinnedRootParams,
} from '../shared/protocol';
import { SourceFile } from './analysis/sourceFile';
import { FileChangeType as WorkspaceChangeType, Workspace } from './analysis/workspace';
import { provideCompletion } from './features/completion';
import { provideDefinition } from './features/definition';
import { computeDiagnostics } from './features/diagnostics';
import { provideDocumentSymbols } from './features/documentSymbols';
import { provideHover } from './features/hover';
import { includeTreeChildren, includeTreeRoots } from './features/includeTree';
import { provideInlayHints } from './features/inlayHints';
import { provideCodeActions } from './features/quickFixes';
import { prepareRename, provideRename } from './features/rename';
import { provideReferences } from './features/references';
import { provideSemanticTokens, semanticTokensLegend } from './features/semanticTokens';
import { provideSignatureHelp } from './features/signatureHelp';
import { uriToPath } from './project/pathUtils';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
let workspace = new Workspace([]);
let supportsSemanticRefresh = false;
let supportsInlayRefresh = false;
let supportsWatchedFilesRegistration = false;

const DIAGNOSTIC_DELAY_MS = 250;
const DEPENDENT_DIAGNOSTIC_DELAY_MS = 900;
const GRAPH_REFRESH_DELAY_MS = 600;

/* ---------------------------------------------------------------------------
 * 初期化
 * ------------------------------------------------------------------------- */

connection.onInitialize((params: InitializeParams): InitializeResult => {
  const folders = (params.workspaceFolders ?? [])
    .map((folder) => uriToPath(folder.uri))
    .filter((value): value is string => !!value);
  if (folders.length === 0 && params.rootUri) {
    const root = uriToPath(params.rootUri);
    if (root) folders.push(root);
  }
  workspace = new Workspace(folders);
  workspace.settings = mergeSettings((params.initializationOptions as { settings?: unknown } | undefined)?.settings);
  const pinned = (params.initializationOptions as { pinnedRoot?: string } | undefined)?.pinnedRoot;
  if (pinned) workspace.setPinnedRoot(uriToPath(pinned));

  const capabilities = params.capabilities;
  supportsSemanticRefresh = !!capabilities.workspace?.semanticTokens?.refreshSupport;
  supportsInlayRefresh = !!capabilities.workspace?.inlayHint?.refreshSupport;
  supportsWatchedFilesRegistration = !!capabilities.workspace?.didChangeWatchedFiles?.dynamicRegistration;

  return {
    capabilities: {
      textDocumentSync: { openClose: true, change: TextDocumentSyncKind.Incremental },
      completionProvider: {
        triggerCharacters: ['.', '#', '"', '<', '/', ':', ' ', '['],
        resolveProvider: false,
      },
      hoverProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      renameProvider: { prepareProvider: true },
      codeActionProvider: { codeActionKinds: [CodeActionKind.QuickFix] },
      documentSymbolProvider: true,
      signatureHelpProvider: { triggerCharacters: ['(', ','], retriggerCharacters: [','] },
      semanticTokensProvider: { legend: semanticTokensLegend, full: true },
      inlayHintProvider: true,
    },
    serverInfo: { name: 'URP ShaderLab Language Server' },
  };
});

connection.onInitialized(() => {
  if (supportsWatchedFilesRegistration) {
    void connection.client.register(DidChangeWatchedFilesNotification.type, {
      watchers: [
        { globPattern: '**/*.{shader,hlsl,hlsli,cginc,compute,glslinc,cg}' },
        { globPattern: '**/Packages/manifest.json' },
        { globPattern: '**/package.json' },
      ],
    });
  }
  void workspace.graph.scanWorkspace().then(() => {
    notifyGraphChanged();
    scheduleAllDiagnostics(0);
    refreshViews();
  });
});

function mergeSettings(raw: unknown): ServerSettings {
  const value = (raw ?? {}) as Partial<ServerSettings>;
  return {
    diagnostics: { ...defaultServerSettings.diagnostics, ...(value.diagnostics ?? {}) },
    inlayHints: { ...defaultServerSettings.inlayHints, ...(value.inlayHints ?? {}) },
  };
}

connection.onDidChangeConfiguration((change) => {
  const settings = (change.settings as { urpShaderLab?: unknown } | undefined)?.urpShaderLab;
  workspace.settings = mergeSettings(settings);
  scheduleAllDiagnostics(0);
  refreshViews();
});

/* ---------------------------------------------------------------------------
 * ドキュメント
 * ------------------------------------------------------------------------- */

documents.onDidOpen((event) => {
  const document = event.document;
  workspace.openDocument(document.uri, document.getText(), document.version);
  if (workspace.refreshGraphFor(document.uri)) notifyGraphChanged();
  scheduleDiagnostics(document.uri, 0);
});

const graphRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

documents.onDidChangeContent((event) => {
  const document = event.document;
  workspace.changeDocument(document.uri, document.getText(), document.version);
  scheduleDiagnostics(document.uri, DIAGNOSTIC_DELAY_MS);
  // このファイルをincludeしている他のドキュメントも再検査する。
  for (const uri of workspace.openUris()) {
    if (uri !== document.uri) scheduleDiagnostics(uri, DEPENDENT_DIAGNOSTIC_DELAY_MS);
  }
  const pending = graphRefreshTimers.get(document.uri);
  if (pending) clearTimeout(pending);
  graphRefreshTimers.set(
    document.uri,
    setTimeout(() => {
      graphRefreshTimers.delete(document.uri);
      if (workspace.refreshGraphFor(document.uri)) {
        notifyGraphChanged();
        scheduleAllDiagnostics(DIAGNOSTIC_DELAY_MS);
      }
    }, GRAPH_REFRESH_DELAY_MS),
  );
});

documents.onDidClose((event) => {
  const uri = event.document.uri;
  const timer = diagnosticTimers.get(uri);
  if (timer) clearTimeout(timer);
  diagnosticTimers.delete(uri);
  workspace.closeDocument(uri);
  connection.sendDiagnostics({ uri, diagnostics: [] });
});

connection.onDidChangeWatchedFiles(async (params) => {
  const changes: Array<{ path: string; type: WorkspaceChangeType }> = [];
  for (const change of params.changes) {
    const filePath = uriToPath(change.uri);
    if (!filePath) continue;
    const type: WorkspaceChangeType =
      change.type === FileChangeType.Created ? 'created' : change.type === FileChangeType.Deleted ? 'deleted' : 'changed';
    changes.push({ path: filePath, type });
  }
  if (changes.length === 0) return;
  try {
    await workspace.onFilesChanged(changes);
  } catch (error) {
    logError('ファイル変更の反映に失敗しました', error);
  }
  notifyGraphChanged();
  scheduleAllDiagnostics(DEPENDENT_DIAGNOSTIC_DELAY_MS);
  refreshViews();
});

/* ---------------------------------------------------------------------------
 * 診断
 * ------------------------------------------------------------------------- */

const diagnosticTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleDiagnostics(uri: string, delay: number): void {
  const existing = diagnosticTimers.get(uri);
  if (existing) clearTimeout(existing);
  diagnosticTimers.set(
    uri,
    setTimeout(() => {
      diagnosticTimers.delete(uri);
      void publishDiagnostics(uri);
    }, delay),
  );
}

function scheduleAllDiagnostics(delay: number): void {
  for (const document of documents.all()) scheduleDiagnostics(document.uri, delay);
}

async function publishDiagnostics(uri: string): Promise<void> {
  const document = documents.get(uri);
  if (!document) return;
  const version = document.version;
  try {
    const file = workspace.getOpenFile(uri);
    if (!file) return;
    const diagnostics = await computeDiagnostics(workspace, file);
    // 計算中に編集された場合は古い結果を送らない(次の予約で送られる)。
    if (documents.get(uri)?.version !== version) return;
    void connection.sendDiagnostics({ uri, version, diagnostics });
  } catch (error) {
    logError(`診断に失敗しました: ${uri}`, error);
  }
}

/* ---------------------------------------------------------------------------
 * 言語機能
 * ------------------------------------------------------------------------- */

/** rethrowUserErrors: ResponseError(名前を変更できない理由など)はクライアントへそのまま返す。 */
async function withFile<T>(
  uri: string,
  fallback: T,
  action: (file: SourceFile) => Promise<T> | T,
  rethrowUserErrors = false,
): Promise<T> {
  try {
    let file = workspace.getOpenFile(uri);
    if (!file) {
      const filePath = uriToPath(uri);
      file = filePath ? await workspace.loadFile(filePath) : undefined;
    }
    if (!file) return fallback;
    return await action(file);
  } catch (error) {
    if (rethrowUserErrors && error instanceof ResponseError) throw error;
    logError(`リクエストの処理に失敗しました: ${uri}`, error);
    return fallback;
  }
}

connection.onCompletion((params) =>
  withFile<CompletionList | null>(params.textDocument.uri, null, async (file) => {
    const offset = file.lineIndex.offsetAt(params.position);
    const trigger = params.context?.triggerCharacter;
    if (trigger && !acceptTrigger(file, offset, trigger)) return { isIncomplete: false, items: [] };
    return provideCompletion(workspace, file, offset);
  }),
);

/** トリガー文字による自動補完を出してよい文脈か(空白や ':' で毎回候補が出ないようにする)。 */
function acceptTrigger(file: SourceFile, offset: number, trigger: string): boolean {
  const lineStart = file.text.lastIndexOf('\n', offset - 1) + 1;
  const linePrefix = file.text.substring(lineStart, offset);
  const directive = /^\s*#/.test(linePrefix);
  switch (trigger) {
    case '.':
      return !directive;
    case '#':
      return /^\s*#$/.test(linePrefix);
    case '"':
    case '<':
    case '/':
      return /^\s*#\s*include/.test(linePrefix) || (trigger === '"' && file.unitIndexAt(offset) < 0);
    case ' ':
      return directive
        ? /^\s*#\s*pragma\s+\w+\s+$/.test(linePrefix) || /^\s*#\s*pragma\s+$/.test(linePrefix)
        : file.unitIndexAt(offset) < 0 && /\b(Cull|ZWrite|ZTest|Blend|BlendOp|AlphaToMask|ZClip|Comp|Pass|Fail|ZFail)\s$/.test(linePrefix);
    case ':':
      return !directive && file.unitIndexAt(offset) >= 0 && /(\w|\])\s*:$/.test(linePrefix);
    case '[':
      return !directive;
    default:
      return true;
  }
}

connection.onHover((params) =>
  withFile(params.textDocument.uri, null, (file) => provideHover(workspace, file, file.lineIndex.offsetAt(params.position))),
);

connection.onDefinition((params) =>
  withFile(params.textDocument.uri, null, (file) => provideDefinition(workspace, file, file.lineIndex.offsetAt(params.position))),
);

connection.onReferences((params) =>
  withFile(params.textDocument.uri, [], (file) =>
    provideReferences(workspace, file, file.lineIndex.offsetAt(params.position), params.context.includeDeclaration),
  ),
);

connection.onPrepareRename((params) =>
  withFile(params.textDocument.uri, null, (file) => prepareRename(workspace, file, file.lineIndex.offsetAt(params.position)), true),
);

connection.onRenameRequest((params) =>
  withFile(
    params.textDocument.uri,
    null,
    (file) => provideRename(workspace, file, file.lineIndex.offsetAt(params.position), params.newName),
    true,
  ),
);

connection.onCodeAction((params) => provideCodeActions(params));

connection.onDocumentSymbol((params) => withFile(params.textDocument.uri, [], (file) => provideDocumentSymbols(file)));

connection.onSignatureHelp((params) =>
  withFile(params.textDocument.uri, null, (file) => provideSignatureHelp(workspace, file, file.lineIndex.offsetAt(params.position))),
);

connection.languages.semanticTokens.on((params) =>
  withFile(params.textDocument.uri, { data: [] }, (file) => provideSemanticTokens(workspace, file)),
);

connection.languages.inlayHint.on((params) =>
  withFile(params.textDocument.uri, [], (file) =>
    provideInlayHints(workspace, file, file.lineIndex.offsetAt(params.range.start), file.lineIndex.offsetAt(params.range.end)),
  ),
);

/* ---------------------------------------------------------------------------
 * カスタムリクエスト(Include Tree)
 * ------------------------------------------------------------------------- */

connection.onRequest(Requests.includeTreeRoots, async (params: IncludeTreeRootsParams) => {
  try {
    return await includeTreeRoots(workspace, params.activeUri);
  } catch (error) {
    logError('Include Treeの取得に失敗しました', error);
    return { roots: [], pinnedUri: null };
  }
});

connection.onRequest(Requests.includeTreeChildren, async (params: IncludeTreeChildrenParams) => {
  try {
    return await includeTreeChildren(workspace, params.uri);
  } catch (error) {
    logError('Include Treeの取得に失敗しました', error);
    return [];
  }
});

connection.onRequest(Requests.setPinnedRoot, (params: SetPinnedRootParams) => {
  workspace.setPinnedRoot(params.uri ? uriToPath(params.uri) : undefined);
  notifyGraphChanged();
  scheduleAllDiagnostics(0);
  refreshViews();
  return { uri: params.uri };
});

connection.onRequest(Requests.refreshProject, async () => {
  await workspace.reset();
  notifyGraphChanged();
  scheduleAllDiagnostics(0);
  refreshViews();
  return workspace.getMemoryStats();
});

connection.onRequest(Requests.memoryStats, () => workspace.getMemoryStats());

/* ---------------------------------------------------------------------------
 * 補助
 * ------------------------------------------------------------------------- */

let graphNotifyTimer: ReturnType<typeof setTimeout> | undefined;

function notifyGraphChanged(): void {
  if (graphNotifyTimer) clearTimeout(graphNotifyTimer);
  graphNotifyTimer = setTimeout(() => {
    graphNotifyTimer = undefined;
    void connection.sendNotification(Notifications.includeGraphChanged);
  }, 100);
}

/** 解析コンテキストが変わったときに、セマンティックトークンとインレイヒントを再取得させる。 */
function refreshViews(): void {
  if (supportsSemanticRefresh) void connection.languages.semanticTokens.refresh();
  if (supportsInlayRefresh) void connection.languages.inlayHint.refresh();
}

function logError(message: string, error: unknown): void {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  connection.console.error(`${message}\n${detail}`);
}

documents.listen(connection);
connection.listen();
