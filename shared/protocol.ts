/**
 * クライアント(拡張機能本体)とLanguage Serverで共有するカスタムリクエスト定義。
 * 型だけを共有し、実行時の依存は持たない。
 */

export const Requests = {
  includeTreeRoots: 'urpShaderLab/includeTree/roots',
  includeTreeChildren: 'urpShaderLab/includeTree/children',
  setPinnedRoot: 'urpShaderLab/setPinnedRoot',
  memoryStats: 'urpShaderLab/memoryStats',
  refreshProject: 'urpShaderLab/refreshProject',
} as const;

export const Notifications = {
  includeGraphChanged: 'urpShaderLab/includeGraphChanged',
} as const;

export interface IncludeTreeRootsParams {
  /** 現在アクティブなエディタのURI。 */
  activeUri?: string;
}

export interface IncludeTreeRoot {
  uri: string;
  /** 解析コンテキストとして実際に使用されているroot。 */
  active: boolean;
  /** ユーザーが固定したroot。 */
  pinned: boolean;
}

export interface IncludeTreeRootsResult {
  roots: IncludeTreeRoot[];
  pinnedUri: string | null;
}

export interface IncludeTreeChildrenParams {
  uri: string;
}

export interface IncludeTreeChild {
  /** 解決できたincludeのURI。未解決ならundefined。 */
  uri?: string;
  /** ソースに書かれているincludeパス。 */
  includePath: string;
  /** 'unresolved' は見つからないinclude、'builtin' はUnity本体に同梱されるinclude。 */
  status: 'resolved' | 'unresolved' | 'builtin';
  line: number;
}

export interface SetPinnedRootParams {
  uri: string | null;
}

export interface ServerSettings {
  diagnostics: {
    enable: boolean;
    undefinedIdentifiers: boolean;
    srpBatcher: boolean;
  };
  inlayHints: {
    parameterQualifiers: boolean;
  };
}

export const defaultServerSettings: ServerSettings = {
  diagnostics: {
    enable: true,
    undefinedIdentifiers: true,
    srpBatcher: true,
  },
  inlayHints: {
    parameterQualifiers: true,
  },
};
