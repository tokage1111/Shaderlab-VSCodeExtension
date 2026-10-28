/**
 * Language Serverの解析エンジンの回帰テスト。VS Codeを起動せずに実行できる。
 *   npm test
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver';
import { Workspace } from '../server/analysis/workspace';
import { SourceFile } from '../server/analysis/sourceFile';
import { lex } from '../server/parser/lexer';
import { parseHlslUnit } from '../server/parser/hlslParser';
import { computeDiagnostics } from '../server/features/diagnostics';
import { provideDefinition } from '../server/features/definition';
import { provideHover } from '../server/features/hover';
import { provideReferences } from '../server/features/references';
import { prepareRename, provideRename } from '../server/features/rename';
import { provideCodeActions } from '../server/features/quickFixes';
import { provideCompletion } from '../server/features/completion';
import { provideSignatureHelp } from '../server/features/signatureHelp';
import { provideInlayHints } from '../server/features/inlayHints';
import { provideDocumentSymbols } from '../server/features/documentSymbols';
import { provideSemanticTokens } from '../server/features/semanticTokens';
import { includeTreeChildren, includeTreeRoots } from '../server/features/includeTree';
import { pathToUri, uriToPath } from '../server/project/pathUtils';

const projectRoot = path.resolve(__dirname, '../../test/fixtures/UnityProject');
const shaders = path.join(projectRoot, 'Assets', 'Shaders');

type Test = { name: string; run: () => Promise<void> | void };
const tests: Test[] = [];
const test = (name: string, run: Test['run']): void => {
  tests.push({ name, run });
};

function parseHlsl(text: string) {
  const result = lex(text);
  return { lex: result, unit: parseHlslUnit(text, result.tokens, 0, result.tokens.length, result.directives, 0, text.length) };
}

/** text内で `needle` が n 番目(0始まり)に現れる位置 + delta。 */
function offsetOf(file: SourceFile, needle: string, occurrence = 0, delta = 0): number {
  let index = -1;
  for (let i = 0; i <= occurrence; i++) {
    index = file.text.indexOf(needle, index + 1);
    if (index < 0) throw new Error(`'${needle}' (#${occurrence}) が見つかりません`);
  }
  return index + delta;
}

async function openWorkspace(): Promise<Workspace> {
  const workspace = new Workspace([projectRoot]);
  await workspace.graph.scanWorkspace();
  return workspace;
}

async function load(workspace: Workspace, relative: string): Promise<SourceFile> {
  const filePath = path.join(projectRoot, relative);
  const text = fs.readFileSync(filePath, 'utf8');
  const uri = pathToUri(filePath);
  workspace.openDocument(uri, text, 1);
  return workspace.getOpenFile(uri)!;
}

function lineOf(file: SourceFile, offset: number): number {
  return file.lineIndex.positionAt(offset).line;
}

/* ---------------------------------------------------------------------------
 * 字句・構文
 * ------------------------------------------------------------------------- */

test('行継続を含む #define は1つのディレクティブになり、本体はコードとして解析されない', () => {
  const { lex: result, unit } = parseHlsl('#define FOO(a) \\\n  float bar = a; \\\n  bar\nfloat baz;\n');
  assert.strictEqual(result.directives.length, 1);
  assert.deepStrictEqual(unit.globals.map((g) => g.name), ['baz']);
  assert.strictEqual(unit.macros[0].name, 'FOO');
  assert.deepStrictEqual(unit.macros[0].params, ['a']);
});

test('#if 0 のブロックは除外される', () => {
  const { unit } = parseHlsl('#if 0\nfloat hidden;\n#else\nfloat visible;\n#endif\n');
  assert.deepStrictEqual(unit.globals.map((g) => g.name), ['visible']);
});

test('条件が確定する #if は無効範囲として扱い、外部で決まる条件は対象外にする', () => {
  const source = [
    '#define USE_FAST 0', // 0
    '#if 0', // 1
    'float a;', // 2
    '#endif',
    '#if USE_FAST && defined(SOMETHING)', // 4
    'float b;', // 5
    '#elif 1 + 1 == 2', // 6
    'float c;',
    '#else', // 8
    'float d;', // 9
    '#endif',
    '#if UNITY_VERSION >= 202120', // 11 Unityのバージョンは判定しない
    'float e;',
    '#endif',
    '#ifdef _NORMALMAP', // 14 キーワードは判定しない
    'float f;',
    '#else',
    'float g;',
    '#endif',
    '#if 1 || SHADER_API_MOBILE', // 19
    'float h;',
    '#else',
    'float i;', // 22
    '#endif',
    '#ifndef USE_FAST', // 24
    'float j;', // 25
    '#endif',
  ].join('\n');
  const { lex: result, unit } = parseHlsl(source);
  const lines = (offset: number) => source.substring(0, offset).split('\n').length - 1;
  assert.deepStrictEqual(
    result.disabledRanges.map((range) => [lines(range.start), range.condition]),
    [
      [2, '#if 0'],
      [5, '#if USE_FAST && defined(SOMETHING)'],
      [9, '#else'],
      [22, '#else'],
      [25, '#ifndef USE_FAST'],
    ],
  );
  assert.deepStrictEqual(unit.globals.map((g) => g.name), ['c', 'e', 'f', 'g', 'h']);
});

test('ShaderLabでは別パスの #define で #if を確定させない', () => {
  const source = [
    'Shader "X" { SubShader {',
    'HLSLINCLUDE',
    '#define SHARED 0',
    'ENDHLSL',
    'Pass { HLSLPROGRAM',
    '#define KERNEL 0',
    '#if KERNEL',
    'float a;', // 7: 同じパスの定義 → 無効
    '#endif',
    'ENDHLSL }',
    'Pass { HLSLPROGRAM',
    '#if KERNEL',
    'float b;', // 12: 別パスの定義 → 判定しない
    '#endif',
    '#if SHARED',
    'float c;', // 15: HLSLINCLUDE の定義 → 無効
    '#endif',
    'ENDHLSL }',
    '} }',
  ].join('\n');
  const result = lex(source);
  const lines = result.disabledRanges.map((range) => source.substring(0, range.start).split('\n').length - 1);
  assert.deepStrictEqual(lines, [7, 15]);
});

test('無効範囲はグレーアウト用の診断(Unnecessary)として報告する', async () => {
  const workspace = new Workspace([projectRoot]);
  const filePath = path.join(shaders, 'Inactive.hlsl');
  const uri = pathToUri(filePath);
  workspace.openDocument(uri, '#if 0\nfloat hidden;\n#endif\nfloat visible;\n', 1);
  const diagnostics = await computeDiagnostics(workspace, workspace.getOpenFile(uri)!);
  const inactive = diagnostics.filter((d) => d.code === 'inactive-code');
  assert.strictEqual(inactive.length, 1);
  assert.deepStrictEqual(inactive[0].tags, [1]);
  assert.deepStrictEqual([inactive[0].range.start.line, inactive[0].range.end.line], [1, 2]);
});

test('#if/#else で関数ヘッダだけを切り替える書き方を正しく解析する', () => {
  const source = [
    '#if defined(_OUTPUT_DEPTH)',
    'float frag(float4 pos : SV_POSITION) : SV_Depth',
    '#else',
    'float frag(float4 pos : SV_POSITION) : SV_Target',
    '#endif',
    '{',
    '    float local = pos.x;',
    '    return local;',
    '}',
  ].join('\n');
  const { unit } = parseHlsl(source);
  assert.strictEqual(unit.functions.length, 1);
  assert.deepStrictEqual(unit.functions[0].locals.map((l) => l.name), ['local']);
  assert.strictEqual(unit.issues.length, 0);
});

test('URPのマクロ宣言(TEXTURE2D / CBUFFER / UNITY_VERTEX_INPUT_INSTANCE_ID)を解析する', () => {
  const source = [
    'TEXTURE2D(_BaseMap); SAMPLER(sampler_BaseMap);',
    'CBUFFER_START(UnityPerMaterial) float4 _BaseColor; CBUFFER_END',
    'struct Attributes { float4 positionOS : POSITION; UNITY_VERTEX_INPUT_INSTANCE_ID };',
    'half4 Sample(float2 uv, TEXTURE2D_PARAM(tex, samp)) { return 0; }',
  ].join('\n');
  const { unit } = parseHlsl(source);
  assert.deepStrictEqual(unit.globals.map((g) => `${g.type} ${g.name}`), ['Texture2D _BaseMap', 'SamplerState sampler_BaseMap']);
  assert.deepStrictEqual(unit.cbuffers[0].fields.map((f) => f.name), ['_BaseColor']);
  assert.deepStrictEqual(unit.structs[0].fields.map((f) => f.name), ['positionOS', 'instanceID']);
  assert.deepStrictEqual(unit.functions[0].params.map((p) => p.name), ['uv', 'tex', 'samp']);
});

test('文字リテラル中の括弧を括弧として数えない', () => {
  const { unit } = parseHlsl("static const uint table[] = { '(', ')' , '(' };\nfloat after;\n");
  assert.strictEqual(unit.issues.length, 0);
  assert.ok(unit.globals.some((g) => g.name === 'after'));
});

/* ---------------------------------------------------------------------------
 * プロジェクト・include解決
 * ------------------------------------------------------------------------- */

test('Packages/ を PackageCache・埋め込み・manifest の file: 参照から解決する', async () => {
  const workspace = await openWorkspace();
  const from = path.join(shaders, 'Lit.shader');
  const cached = workspace.project.resolve('Packages/com.example.cached/ShaderLibrary/Core.hlsl', from);
  const embedded = workspace.project.resolve('Packages/com.example.embedded/ShaderLibrary/Embedded.hlsl', from);
  const local = workspace.project.resolve('Packages/com.example.local/ShaderLibrary/Local.hlsl', from);
  assert.strictEqual(cached.status, 'resolved');
  assert.strictEqual(embedded.status, 'resolved');
  assert.strictEqual(local.status, 'resolved');
  assert.strictEqual(workspace.project.resolve('UnityCG.cginc', from).status, 'builtin');
  assert.strictEqual(workspace.project.resolve('Missing.hlsl', from).status, 'unresolved');
});

test('相対パス(../)のincludeはUnityプロジェクトの外を解決・補完しない', () => {
  const workspace = new Workspace([projectRoot]);
  const from = path.join(shaders, 'Lit.shader');
  // test/fixtures/OutsideProject.hlsl はプロジェクトの外にある。
  assert.ok(fs.existsSync(path.join(projectRoot, '..', 'OutsideProject.hlsl')));
  for (const include of ['../../../OutsideProject.hlsl', 'Assets/../../OutsideProject.hlsl', '../../../UnityProject/../OutsideProject.hlsl']) {
    assert.strictEqual(workspace.project.resolve(include, from).status, 'unresolved', include);
  }
  // プロジェクト内に留まる ../ は解決する。
  assert.strictEqual(workspace.project.resolve('../Shaders/Lib/Input.hlsl', from).status, 'resolved');
  assert.deepStrictEqual(workspace.project.listIncludeCompletions('../../../', from), []);
  assert.ok(workspace.project.listIncludeCompletions('../../', from).some((entry) => entry.name === 'Assets'));
});

test('Assetsのサブフォルダをワークスペースとして開いてもUnityプロジェクトのルートを見つける', () => {
  const workspace = new Workspace([shaders]);
  const resolved = workspace.project.resolve('Packages/com.example.cached/ShaderLibrary/Core.hlsl', path.join(shaders, 'Lit.shader'));
  assert.strictEqual(resolved.status, 'resolved');
});

test('Include Tree: include先のファイルからrootのシェーダーを求める', async () => {
  const workspace = await openWorkspace();
  const common = path.join(shaders, 'Lib', 'Common.hlsl');
  const result = await includeTreeRoots(workspace, pathToUri(common));
  const roots = result.roots.map((root) => path.basename(uriToPath(root.uri)!));
  assert.deepStrictEqual(roots, ['Lit.shader']);
  assert.ok(result.roots[0].active);
  const children = await includeTreeChildren(workspace, pathToUri(path.join(shaders, 'Errors.shader')));
  assert.ok(children.some((child) => child.includePath === 'DoesNotExist.hlsl' && child.status === 'unresolved'));
});

/* ---------------------------------------------------------------------------
 * 解析コンテキスト
 * ------------------------------------------------------------------------- */

test('Lit.shader には警告以上の診断が出ない(誤検出がない)', async () => {
  const workspace = await openWorkspace();
  const file = await load(workspace, 'Assets/Shaders/Lit.shader');
  const diagnostics = (await computeDiagnostics(workspace, file)).filter((d) => d.severity! <= DiagnosticSeverity.Warning);
  assert.deepStrictEqual(
    diagnostics.map((d) => `${d.range.start.line + 1}: ${d.message}`),
    [],
  );
});

test('include先のHLSLファイルはrootの翻訳単位で解析され、兄弟includeのシンボルが見える', async () => {
  const workspace = await openWorkspace();
  const file = await load(workspace, 'Assets/Shaders/Lib/Common.hlsl');
  const diagnostics = (await computeDiagnostics(workspace, file)).filter((d) => d.severity! <= DiagnosticSeverity.Warning);
  assert.deepStrictEqual(diagnostics, []);
  const definition = await provideDefinition(workspace, file, offsetOf(file, '_BaseColor', 1));
  assert.ok(definition && definition.length > 0);
  assert.ok(uriToPath(definition[0].uri)!.endsWith('Input.hlsl'));
});

test('パスごとに別の翻訳単位として扱う(同名のVaryingsを混同しない)', async () => {
  const workspace = await openWorkspace();
  const file = await load(workspace, 'Assets/Shaders/Lit.shader');
  // ShadowCasterパスの output.depth → ShadowCasterパスのVaryings.depth
  const depthUse = offsetOf(file, 'output.depth', 0, 'output.'.length + 1);
  const definition = await provideDefinition(workspace, file, depthUse);
  assert.ok(definition);
  const declaration = file.lineIndex.offsetAt(definition[0].range.start);
  assert.strictEqual(lineOf(file, declaration), lineOf(file, offsetOf(file, 'float depth : TEXCOORD0')));
  // Forwardパスの output.normalWS → ForwardパスのVaryings
  const normalUse = offsetOf(file, 'output.normalWS', 0, 'output.'.length + 1);
  const normalDefinition = await provideDefinition(workspace, file, normalUse);
  assert.ok(normalDefinition);
  assert.strictEqual(lineOf(file, file.lineIndex.offsetAt(normalDefinition[0].range.start)), lineOf(file, offsetOf(file, 'float3 normalWS : TEXCOORD1')));
});

test('ブロック内でシャドーイングされたローカル変数を正しく解決する', async () => {
  const workspace = await openWorkspace();
  const file = await load(workspace, 'Assets/Shaders/Lit.shader');
  const inner = await provideDefinition(workspace, file, offsetOf(file, 'albedo.rgb *= scale', 0, 'albedo.rgb *= '.length + 1));
  assert.strictEqual(lineOf(file, file.lineIndex.offsetAt(inner![0].range.start)), lineOf(file, offsetOf(file, 'float scale = 2.0')));
  const outer = await provideDefinition(workspace, file, offsetOf(file, 'GetTint() * scale', 0, 'GetTint() * '.length + 1));
  assert.strictEqual(lineOf(file, file.lineIndex.offsetAt(outer![0].range.start)), lineOf(file, offsetOf(file, 'float scale = LocalFunction')));
});

test('メソッドチェーン・関数戻り値のメンバーを解決する', async () => {
  const workspace = await openWorkspace();
  const file = await load(workspace, 'Assets/Shaders/Lit.shader');
  const hover = await provideHover(workspace, file, offsetOf(file, 'positionInputs.positionCS', 0, 'positionInputs.'.length + 2));
  assert.ok(hover);
  assert.match(JSON.stringify(hover.contents), /VertexPositionInputs/);
});

test('ShaderLab Property からHLSL側の宣言(CBUFFER)へ移動する', async () => {
  const workspace = await openWorkspace();
  const file = await load(workspace, 'Assets/Shaders/Lit.shader');
  const definition = await provideDefinition(workspace, file, offsetOf(file, '_BaseColor ("Base Color"', 0, 2));
  assert.ok(definition && definition.length > 0);
  assert.ok(uriToPath(definition[0].uri)!.endsWith('Input.hlsl'));
});

test('参照検索: include先の関数の呼び出し箇所を返す', async () => {
  const workspace = await openWorkspace();
  const file = await load(workspace, 'Assets/Shaders/Lit.shader');
  const references = await provideReferences(workspace, file, offsetOf(file, 'TransformObjectToHClip', 0, 2), true);
  const files = references.map((reference) => path.basename(uriToPath(reference.uri)!));
  // 宣言(Core.hlsl)・Core.hlsl内の呼び出し・ShadowCasterパスの呼び出し
  assert.ok(files.filter((name) => name === 'Core.hlsl').length >= 2, JSON.stringify(files));
  assert.ok(files.includes('Lit.shader'));
});

test('参照検索: 構造体メンバーは型が一致するものだけを返す', async () => {
  const workspace = await openWorkspace();
  const file = await load(workspace, 'Assets/Shaders/Lit.shader');
  const references = await provideReferences(workspace, file, offsetOf(file, 'float depth', 0, 7), true);
  // ShadowCasterパスの宣言 + output.depth(代入) + input.depth
  assert.strictEqual(references.length, 3, JSON.stringify(references.map((r) => r.range.start.line)));
});

/* ---------------------------------------------------------------------------
 * 診断
 * ------------------------------------------------------------------------- */

test('Errors.shader の誤りを検出する', async () => {
  const workspace = await openWorkspace();
  const file = await load(workspace, 'Assets/Shaders/Errors.shader');
  const diagnostics = await computeDiagnostics(workspace, file);
  const codes = diagnostics.map((d) => `${d.code}:${file.text.substring(file.lineIndex.offsetAt(d.range.start), file.lineIndex.offsetAt(d.range.end))}`);
  const expect = (code: string, text: string): void => {
    assert.ok(codes.includes(`${code}:${text}`), `${code}:${text} がありません\n${codes.join('\n')}`);
  };
  expect('include-not-found', 'DoesNotExist.hlsl');
  expect('argument-count', 'TransformObjectToHClip');
  expect('implicit-truncation', 'output.uv');
  expect('unknown-member', 'missingMember');
  expect('unknown-member', 'xyb');
  expect('undefined-identifier', 'undefinedVariable');
  expect('property-not-declared', '_Color');
  expect('argument-count', 'lerp');
  expect('undefined-function', 'UndefinedFunction');
  expect('unknown-member', 'z');
  // include が見つからないパスでは未定義シンボルの検査を行わない。
  assert.ok(!codes.some((code) => code.startsWith('pragma-function')), codes.join('\n'));
});

/* ---------------------------------------------------------------------------
 * 補完・その他の機能
 * ------------------------------------------------------------------------- */

test('補完: 構造体のメンバー・スウィズル・include先のシンボル', async () => {
  const workspace = await openWorkspace();
  const file = await load(workspace, 'Assets/Shaders/Lit.shader');
  const members = await provideCompletion(workspace, file, offsetOf(file, 'input.positionOS.xyz', 0, 'input.'.length));
  assert.deepStrictEqual(members.items.slice(0, 4).map((item) => item.label), ['positionOS', 'normalOS', 'uv', 'instanceID']);
  const swizzle = await provideCompletion(workspace, file, offsetOf(file, 'input.positionOS.xyz', 0, 'input.positionOS.'.length));
  assert.ok(swizzle.items.some((item) => item.label === 'xyz'));
  const globals = await provideCompletion(workspace, file, offsetOf(file, 'clip(albedo.a'));
  const labels = new Set(globals.items.map((item) => item.label));
  for (const name of ['TransformObjectToHClip', 'albedo', 'scale', '_BaseColor', 'EmbeddedFunction', 'LOCAL_SCALE', 'lerp', 'float4']) {
    assert.ok(labels.has(name), `${name} が補完候補にありません`);
  }
  // 別パスの関数は含まれない。
  assert.ok(!labels.has('ShadowVert'));
});

test('補完: include パス', async () => {
  const workspace = await openWorkspace();
  const file = await load(workspace, 'Assets/Shaders/Lit.shader');
  const offset = offsetOf(file, 'Packages/com.example.embedded', 0, 'Packages/'.length);
  const items = await provideCompletion(workspace, file, offset);
  const labels = items.items.map((item) => item.label);
  assert.ok(labels.includes('com.example.cached/') && labels.includes('com.example.local/'), labels.join(','));
});

test('シグネチャヘルプ・インレイヒント・アウトライン・セマンティックトークン', async () => {
  const workspace = await openWorkspace();
  const file = await load(workspace, 'Assets/Shaders/Lit.shader');
  const help = await provideSignatureHelp(workspace, file, offsetOf(file, 'GetLighting(input.normalWS, lighting', 0, 'GetLighting(input.normalWS, '.length));
  assert.ok(help);
  assert.strictEqual(help.activeParameter, 1);
  const hints = await provideInlayHints(workspace, file, 0, file.text.length);
  assert.deepStrictEqual(hints.map((hint) => hint.label), ['out:', 'inout:']);
  const symbols = provideDocumentSymbols(file);
  assert.strictEqual(symbols[0].name, 'Test/Lit');
  const tokens = await provideSemanticTokens(workspace, file);
  assert.ok(tokens.data.length > 50);
});

/* ---------------------------------------------------------------------------
 * cbuffer内の #include
 * ------------------------------------------------------------------------- */

test('cbuffer内でincludeしたファイルの変数はcbufferのメンバーとして扱う', async () => {
  const workspace = await openWorkspace();
  const file = await load(workspace, 'Assets/Shaders/CBufferInclude.shader');
  const diagnostics = await computeDiagnostics(workspace, file);
  const problems = diagnostics.filter((d) => d.severity !== DiagnosticSeverity.Hint);
  assert.deepStrictEqual(problems.map((d) => d.message), []);
  const hover = await provideHover(workspace, file, offsetOf(file, '_TintColor *', 0, 2));
  assert.ok(JSON.stringify(hover).includes('UnityPerMaterial'), JSON.stringify(hover));
});

/* ---------------------------------------------------------------------------
 * 名前の変更
 * ------------------------------------------------------------------------- */

test('名前の変更: include先の関数を宣言・呼び出し・#pragma ごと変更する', async () => {
  const workspace = await openWorkspace();
  const file = await load(workspace, 'Assets/Shaders/Lit.shader');
  const edit = await provideRename(workspace, file, offsetOf(file, 'GetTint()', 0, 2), 'GetBaseTint');
  const files = Object.entries(edit!.changes!).map(([uri, edits]) => `${path.basename(uriToPath(uri)!)}:${edits.length}`);
  assert.deepStrictEqual(files.sort(), ['Common.hlsl:1', 'Lit.shader:1']);
  const vertex = await provideRename(workspace, file, offsetOf(file, 'Varyings vert(', 0, 'Varyings '.length), 'Vert');
  const edits = vertex!.changes![file.uri];
  assert.strictEqual(edits?.length, 2, '#pragma vertex と宣言');
});

test('名前の変更: 別パスの同名の構造体・メンバーは変更しない', async () => {
  const workspace = await openWorkspace();
  const file = await load(workspace, 'Assets/Shaders/Lit.shader');
  const lines = async (offset: number): Promise<number[]> => {
    const edit = await provideRename(workspace, file, offset, 'Renamed');
    return edit!.changes![file.uri].map((e) => e.range.start.line + 1).sort((a, b) => a - b);
  };
  assert.deepStrictEqual(await lines(offsetOf(file, 'struct Varyings', 0, 8)), [41, 48, 50, 59]);
  assert.deepStrictEqual(await lines(offsetOf(file, 'output.positionCS', 0, 8)), [43, 53]);
});

test('名前の変更: Propertyと変数を同時に変更し、PackageCacheのシンボルは変更しない', async () => {
  const workspace = await openWorkspace();
  const file = await load(workspace, 'Assets/Shaders/Lit.shader');
  const edit = await provideRename(workspace, file, offsetOf(file, '_Cutoff ("Cutoff"', 0, 2), '_Threshold');
  const files = Object.entries(edit!.changes!).map(([uri, edits]) => `${path.basename(uriToPath(uri)!)}:${edits.length}`);
  // Property名 + clip(... - _Cutoff) / Input.hlsl の宣言
  assert.deepStrictEqual(files.sort(), ['Input.hlsl:1', 'Lit.shader:2']);
  await assert.rejects(prepareRename(workspace, file, offsetOf(file, 'TransformObjectToHClip', 0, 2)));
  await assert.rejects(provideRename(workspace, file, offsetOf(file, '_Cutoff ("Cutoff"', 0, 2), 'float4'));
});

/* ---------------------------------------------------------------------------
 * クイックフィックス
 * ------------------------------------------------------------------------- */

/** 診断に添付された修正をテキストに適用する。 */
function applyFix(file: SourceFile, diagnostic: Diagnostic, index = 0): string {
  const actions = provideCodeActions({ textDocument: { uri: file.uri }, range: diagnostic.range, context: { diagnostics: [diagnostic] } });
  const edits = actions[index]?.edit?.changes?.[file.uri];
  assert.ok(edits, `修正がありません: ${diagnostic.message}`);
  let text = file.text;
  const sorted = edits
    .map((edit) => ({ start: file.lineIndex.offsetAt(edit.range.start), end: file.lineIndex.offsetAt(edit.range.end), newText: edit.newText }))
    .sort((a, b) => b.start - a.start);
  for (const edit of sorted) text = text.substring(0, edit.start) + edit.newText + text.substring(edit.end);
  return text;
}

test('クイックフィックス: Errors.shader の警告・エラーを修正する', async () => {
  const workspace = await openWorkspace();
  const file = await load(workspace, 'Assets/Shaders/Errors.shader');
  const diagnostics = await computeDiagnostics(workspace, file);
  const find = (code: string, text: string): Diagnostic => {
    const found = diagnostics.find(
      (d) => d.code === code && file.text.substring(file.lineIndex.offsetAt(d.range.start), file.lineIndex.offsetAt(d.range.end)) === text,
    );
    assert.ok(found, `${code}:${text}`);
    return found;
  };
  assert.ok(applyFix(file, find('implicit-truncation', 'output.uv')).includes('output.uv = positionOS.xy;'));
  const declared = applyFix(file, find('property-not-declared', '_Color'));
  assert.ok(/CBUFFER_START\(UnityPerMaterial\)\s+float4 _Color;\s+CBUFFER_END\s+half4 frag2/.test(declared), declared);
});

test('クイックフィックス: 打ち間違い・構文の修正', async () => {
  const workspace = await openWorkspace();
  const filePath = path.join(shaders, 'QuickFix.shader');
  const text = [
    'Shader "Test/QuickFix"',
    '{',
    '    Properties',
    '    {',
    '        _Color ("Color", Colr) = (1, 1, 1, 1)',
    '        _Scale ("Scale", Float)',
    '    }',
    '    SubShader',
    '    {',
    '        Tags { "RenderType" = Opaque }',
    '        Pass',
    '        {',
    '            HLSLPROGRAM',
    '            #pragma vertex vert',
    '            #pragma fragment fragg',
    '            #include "Packages/com.example.cached/ShaderLibrary/Core.hlsl"',
    '            CBUFFER_START(UnityPerMaterial)',
    '            float4 _Color;',
    '            CBUFFER_END',
    '            float _Scale;',
    '            float4 vert(float4 positionOS : POSITION) : SV_POSITION { return positionOS * _Scale; }',
    '            half4 frag() : SV_Target { return _Colr + saturat(1.0); }',
    '            ENDHLSL',
    '        }',
    '    }',
    '}',
    '',
  ].join('\n');
  const uri = pathToUri(filePath);
  workspace.openDocument(uri, text, 1);
  const file = workspace.getOpenFile(uri)!;
  const diagnostics = await computeDiagnostics(workspace, file);
  const fixed = (needle: string): string => {
    const diagnostic = diagnostics.find((d) => d.message.includes(needle));
    assert.ok(diagnostic, `${needle}\n${diagnostics.map((d) => d.message).join('\n')}`);
    return applyFix(file, diagnostic);
  };
  assert.ok(fixed("不明なProperty型 'Colr'").includes('("Color", Color)'));
  assert.ok(fixed("'_Scale' に既定値").includes('_Scale ("Scale", Float) = 0'));
  assert.ok(fixed('Tagの値は文字列').includes('"RenderType" = "Opaque"'));
  assert.ok(fixed("'fragg' が見つかりません").includes('#pragma fragment frag\n'));
  assert.ok(fixed("'_Colr' が見つかりません").includes('return _Color + saturat'));
  assert.ok(fixed("'saturat' が見つかりません").includes('saturate(1.0)'));
  const moved = fixed("SRP Batcher: プロパティ '_Scale'");
  assert.ok(/float4 _Color;\n\s+float _Scale;\n\s+CBUFFER_END\n\s+float4 vert/.test(moved), moved);
});

/* ---------------------------------------------------------------------------
 * 実行
 * ------------------------------------------------------------------------- */

async function main(): Promise<void> {
  let failed = 0;
  for (const { name, run } of tests) {
    try {
      await run();
      console.log(`  ✓ ${name}`);
    } catch (error) {
      failed++;
      console.log(`  ✗ ${name}`);
      console.log(`    ${error instanceof Error ? error.message.replace(/\n/g, '\n    ') : String(error)}`);
    }
  }
  console.log(`\n${tests.length - failed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

void main();
