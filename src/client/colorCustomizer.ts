import * as vscode from 'vscode';

/**
 * シェーダーの色設定を VS Code のユーザー設定へ反映する。
 *
 * 色は `editor.semanticTokenColorCustomizations`(解析結果による色)と
 * `editor.tokenColorCustomizations`(TextMate文法による色)でしか変更できないため、
 * この拡張機能が管理するルールだけを書き換える。ルールはシェーダーの言語/スコープに限定し、
 * 他の言語の色には影響しない。
 */

const LANGUAGES = ['shaderlab', 'hlsl', 'hlsli', 'compute'];
const RULE_NAME_PREFIX = 'urpShaderLab.';
const MANAGED_SEMANTIC_RULE = new RegExp(`:(${LANGUAGES.join('|')})$`);

export type ColorPreset = 'csharp' | 'theme';

interface ColorCategory {
  /** 設定キー `urpShaderLab.colors.<key>`。 */
  key: string;
  /** セマンティックトークンのセレクタ(言語指定なし)。 */
  semantic: string[];
  /** TextMateスコープ。 */
  scopes: string[];
}

export const COLOR_CATEGORIES: ColorCategory[] = [
  {
    key: 'keyword',
    semantic: ['keyword'],
    scopes: [
      'keyword.control.hlsl',
      'storage.type.struct.hlsl',
      'storage.modifier.hlsl',
      'storage.modifier.attribute.hlsl',
      'keyword.other.hlsl',
      'constant.language.hlsl',
      'storage.type.structure.shaderlab',
      'keyword.other.shaderlab',
      'keyword.control.program.shaderlab',
    ],
  },
  { key: 'builtinType', semantic: ['type.defaultLibrary'], scopes: ['storage.type.builtin.hlsl', 'storage.type.object.hlsl', 'storage.type.property.shaderlab'] },
  { key: 'type', semantic: ['struct', 'type', 'namespace'], scopes: [] },
  { key: 'function', semantic: ['function', 'method'], scopes: ['entity.name.function.hlsl'] },
  { key: 'builtinFunction', semantic: ['function.defaultLibrary', 'method.defaultLibrary'], scopes: ['support.function.hlsl'] },
  {
    key: 'macro',
    semantic: ['macro'],
    scopes: ['entity.name.function.preprocessor.hlsl', 'support.function.macro.unity.hlsl', 'constant.other.keyword.hlsl'],
  },
  { key: 'localVariable', semantic: ['variable'], scopes: [] },
  { key: 'globalVariable', semantic: ['variable.readonly'], scopes: [] },
  { key: 'parameter', semantic: ['parameter'], scopes: [] },
  { key: 'field', semantic: ['property'], scopes: ['variable.other.property.shaderlab'] },
  { key: 'semantic', semantic: [], scopes: ['support.variable.semantic.hlsl'] },
  {
    key: 'preprocessor',
    semantic: [],
    scopes: ['keyword.control.directive', 'punctuation.definition.directive.hlsl', 'keyword.other.pragma.hlsl'],
  },
  { key: 'renderState', semantic: [], scopes: ['support.type.property-name.render-state.shaderlab', 'constant.language.shaderlab'] },
  { key: 'comment', semantic: [], scopes: ['comment.line.double-slash.hlsl', 'comment.block.hlsl', 'comment.line.double-slash.shaderlab', 'comment.block.shaderlab'] },
  { key: 'string', semantic: [], scopes: ['string.quoted.double.hlsl', 'string.quoted.double.include.hlsl', 'string.quoted.other.lt-gt.include.hlsl', 'string.quoted.double.shaderlab'] },
  { key: 'number', semantic: [], scopes: ['constant.numeric.hlsl', 'constant.numeric.shaderlab'] },
];

/** これまで configurationDefaults で指定していた色(C#に近い配色)。 */
const CSHARP_PRESET: Record<string, string> = {
  keyword: '#C586C0',
  builtinType: '#4EC9B0',
  type: '#4EC9B0',
  function: '#DCDCAA',
  builtinFunction: '#DCDCAA',
  macro: '#569CD6',
  localVariable: '#9CDCFE',
  globalVariable: '#9CDCFE',
  parameter: '#9CDCFE',
  field: '#4FC1FF',
  semantic: '#4FC1FF',
  preprocessor: '#C586C0',
  renderState: '#4FC1FF',
  comment: '#6A9955',
  string: '#CE9178',
  number: '#B5CEA8',
};

export const COLOR_PRESETS: Record<ColorPreset, Record<string, string>> = {
  csharp: CSHARP_PRESET,
  // テーマ標準: 色を指定せず、使用中のテーマの色をそのまま使う。
  theme: {},
};

/** プリセットと個別設定から、カテゴリごとの色を求める。 */
export function resolveColors(configuration: vscode.WorkspaceConfiguration): Record<string, string> {
  const preset = configuration.get<ColorPreset>('colors.preset', 'csharp');
  const colors: Record<string, string> = { ...(COLOR_PRESETS[preset] ?? CSHARP_PRESET) };
  for (const category of COLOR_CATEGORIES) {
    const value = configuration.get<string>(`colors.${category.key}`, '').trim();
    if (/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value)) colors[category.key] = value;
  }
  return colors;
}

type SemanticCustomizations = { rules?: Record<string, unknown>; [key: string]: unknown };
type TextMateRule = { name?: string; scope?: string | string[]; settings?: Record<string, unknown> };
type TokenCustomizations = { textMateRules?: TextMateRule[]; [key: string]: unknown };

/** 計算した色をユーザー設定に書き込む。変化がなければ書き込まない。 */
export async function applyColors(colors: Record<string, string>): Promise<void> {
  const editor = vscode.workspace.getConfiguration('editor');

  // セマンティックトークン(言語指定付きのルールだけを管理する)
  const semanticCurrent = (editor.inspect<SemanticCustomizations>('semanticTokenColorCustomizations')?.globalValue ?? {}) as SemanticCustomizations;
  const rules: Record<string, unknown> = {};
  for (const [selector, value] of Object.entries(semanticCurrent.rules ?? {})) {
    if (!MANAGED_SEMANTIC_RULE.test(selector)) rules[selector] = value;
  }
  for (const category of COLOR_CATEGORIES) {
    const color = colors[category.key];
    if (!color) continue;
    for (const selector of category.semantic) {
      for (const language of LANGUAGES) rules[`${selector}:${language}`] = color;
    }
  }
  const semanticNext: SemanticCustomizations = { ...semanticCurrent, rules };
  if (Object.keys(rules).length === 0) delete semanticNext.rules;
  await updateIfChanged(editor, 'semanticTokenColorCustomizations', semanticCurrent, semanticNext);

  // TextMate(キーワード・コメント・文字列・数値など)
  const tokenCurrent = (editor.inspect<TokenCustomizations>('tokenColorCustomizations')?.globalValue ?? {}) as TokenCustomizations;
  const textMateRules = (tokenCurrent.textMateRules ?? []).filter((rule) => !rule.name?.startsWith(RULE_NAME_PREFIX));
  for (const category of COLOR_CATEGORIES) {
    const color = colors[category.key];
    if (!color || category.scopes.length === 0) continue;
    textMateRules.push({ name: `${RULE_NAME_PREFIX}${category.key}`, scope: category.scopes, settings: { foreground: color } });
  }
  const tokenNext: TokenCustomizations = { ...tokenCurrent, textMateRules };
  if (textMateRules.length === 0) delete tokenNext.textMateRules;
  await updateIfChanged(editor, 'tokenColorCustomizations', tokenCurrent, tokenNext);
}

async function updateIfChanged(
  configuration: vscode.WorkspaceConfiguration,
  section: string,
  current: object,
  next: object,
): Promise<void> {
  if (JSON.stringify(current) === JSON.stringify(next)) return;
  const value = Object.keys(next).length === 0 ? undefined : next;
  await configuration.update(section, value, vscode.ConfigurationTarget.Global);
}

/** 拡張機能が書き込んだ色設定をユーザー設定から取り除く。 */
export async function removeColors(): Promise<void> {
  await applyColors({});
}

export function registerColorCustomizer(context: vscode.ExtensionContext): void {
  const apply = async (): Promise<void> => {
    try {
      await applyColors(resolveColors(vscode.workspace.getConfiguration('urpShaderLab')));
    } catch (error) {
      void vscode.window.showWarningMessage(`シェーダーの色設定を反映できませんでした: ${String(error)}`);
    }
  };

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('urpShaderLab.colors')) void apply();
    }),
    vscode.commands.registerCommand('urpShaderLab.selectColorPreset', async () => {
      const configuration = vscode.workspace.getConfiguration('urpShaderLab');
      const current = configuration.get<ColorPreset>('colors.preset', 'csharp');
      const items: Array<vscode.QuickPickItem & { preset: ColorPreset }> = [
        { preset: 'csharp', label: 'C#風', description: 'C#の配色に近い色(これまでの既定)' },
        { preset: 'theme', label: 'テーマ標準', description: '色を指定せず、拡張機能がない場合と同じテーマの色を使う' },
      ];
      for (const item of items) if (item.preset === current) item.label = `$(check) ${item.label}`;
      const picked = await vscode.window.showQuickPick(items, { placeHolder: '色のプリセットを選択(個別の色設定はプリセットより優先されます)' });
      if (picked) await configuration.update('colors.preset', picked.preset, vscode.ConfigurationTarget.Global);
    }),
    vscode.commands.registerCommand('urpShaderLab.openColorSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', 'urpShaderLab.colors'),
    ),
    vscode.commands.registerCommand('urpShaderLab.removeColorSettings', async () => {
      const configuration = vscode.workspace.getConfiguration('urpShaderLab');
      for (const category of COLOR_CATEGORIES) {
        await configuration.update(`colors.${category.key}`, undefined, vscode.ConfigurationTarget.Global);
      }
      await configuration.update('colors.preset', 'theme', vscode.ConfigurationTarget.Global);
      await removeColors();
      void vscode.window.showInformationMessage('シェーダーの色設定をすべて削除し、テーマ標準の色に戻しました。');
    }),
  );
  void apply();
}
