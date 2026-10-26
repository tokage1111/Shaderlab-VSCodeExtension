import * as path from 'path';
import * as vscode from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from 'vscode-languageclient/node';
import { Notifications, Requests } from '../../shared/protocol';

let client: LanguageClient | undefined;

export function getClient(): LanguageClient | undefined {
  return client;
}

export async function startLanguageClient(context: vscode.ExtensionContext, pinnedRoot: string | undefined): Promise<LanguageClient> {
  if (client) return client;

  const serverModule = context.asAbsolutePath(path.join('out', 'server', 'server.js'));
  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: { execArgv: ['--nolazy', '--inspect=6009'] },
    },
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: 'file', language: 'shaderlab' },
      { scheme: 'file', language: 'hlsl' },
      { scheme: 'file', language: 'hlsli' },
      { scheme: 'file', language: 'compute' },
      // 他の拡張機能が別の言語IDを割り当てている場合でも動作させる。
      { scheme: 'file', pattern: '**/*.{shader,hlsl,hlsli,cginc,compute}' },
    ],
    synchronize: { configurationSection: 'urpShaderLab' },
    initializationOptions: {
      settings: JSON.parse(JSON.stringify(vscode.workspace.getConfiguration('urpShaderLab'))) as unknown,
      pinnedRoot,
    },
    outputChannelName: 'URP ShaderLab Tools',
  };
  // idを設定キーの接頭辞と一致させると `urpShaderLab.trace.server` が有効になる。
  client = new LanguageClient('urpShaderLab', 'URP ShaderLab Language Server', serverOptions, clientOptions);
  await client.start();
  return client;
}

export async function stopLanguageClient(): Promise<void> {
  if (!client) return;
  const current = client;
  client = undefined;
  await current.stop();
}

export function onIncludeGraphChanged(listener: () => void): vscode.Disposable {
  if (!client) return new vscode.Disposable(() => undefined);
  return client.onNotification(Notifications.includeGraphChanged, listener);
}

export async function setPinnedRoot(uri: string | undefined): Promise<void> {
  await client?.sendRequest(Requests.setPinnedRoot, { uri: uri ?? null });
}

export async function requestMemoryStats(): Promise<Record<string, unknown> | undefined> {
  return client?.sendRequest<Record<string, unknown>>(Requests.memoryStats);
}

export async function refreshProject(): Promise<void> {
  await client?.sendRequest(Requests.refreshProject);
}
