import { CodeAction, CodeActionKind, CodeActionParams, Diagnostic, TextEdit } from 'vscode-languageserver';
import { AnalysisContext } from '../analysis/context';
import { SourceFile, SymbolOfKind } from '../analysis/sourceFile';
import { TypeEvaluator } from '../analysis/typeEvaluator';
import { HlslCBuffer, ShaderProperty, TextFix, TextFixEdit } from '../parser/ast';

/**
 * 診断に添付するクイックフィックス。診断を計算した時点のテキストに対する編集として
 * Diagnostic.data に保持し、コードアクションの要求時にそのまま返す。
 */
interface DiagnosticFixData {
  fixes: Array<{ title: string; preferred?: boolean; edits: TextEdit[] }>;
}

export function toDiagnosticData(file: SourceFile, fixes: TextFix[]): DiagnosticFixData {
  return {
    fixes: fixes.map((fix) => ({
      title: fix.title,
      preferred: fix.preferred,
      edits: fix.edits.map((edit) => TextEdit.replace(file.lineIndex.range(edit.start, edit.end), edit.newText)),
    })),
  };
}

export function provideCodeActions(params: CodeActionParams): CodeAction[] {
  const only = params.context.only;
  if (only && !only.some((kind) => kind === CodeActionKind.QuickFix || CodeActionKind.QuickFix.startsWith(`${kind}.`))) return [];
  const actions: CodeAction[] = [];
  for (const diagnostic of params.context.diagnostics) {
    for (const fix of fixesOf(diagnostic)) {
      actions.push({
        title: fix.title,
        kind: CodeActionKind.QuickFix,
        diagnostics: [diagnostic],
        isPreferred: fix.preferred,
        edit: { changes: { [params.textDocument.uri]: fix.edits } },
      });
    }
  }
  return actions;
}

function fixesOf(diagnostic: Diagnostic): DiagnosticFixData['fixes'] {
  const data = diagnostic.data as Partial<DiagnosticFixData> | undefined;
  return Array.isArray(data?.fixes) ? data.fixes : [];
}

/* ---------------------------------------------------------------------------
 * 修正の生成
 * ------------------------------------------------------------------------- */

/** 打ち間違いと思われる名前を候補の名前に置き換える。 */
export function renameFixes(start: number, end: number, candidates: string[]): TextFix[] {
  return candidates.map((candidate) => ({
    title: `'${candidate}' に変更`,
    edits: [{ start, end, newText: candidate }],
    preferred: candidates.length === 1,
  }));
}

const SWIZZLE = /^([xyzw]{1,4}|[rgba]{1,4})$/;

/**
 * 暗黙の切り捨て(float3 → float2 等)を、スウィズルで成分を明示して解消する。
 * 右辺がすでにスウィズルで終わっていればそれを短くする。
 */
export function swizzleFix(file: SourceFile, evaluator: TypeEvaluator, from: number, to: number, rows: number): TextFix[] | undefined {
  const tokens = file.tokens;
  const last = to - 1;
  if (from > last || !tokens[from] || !tokens[last]) return undefined;
  const lastToken = tokens[last];
  const isChain = evaluator.chainStart(last) === from;
  if (isChain && last - 1 > from && tokens[last - 1].value === '.' && SWIZZLE.test(lastToken.value)) {
    const shorter = lastToken.value.substring(0, rows);
    return [
      {
        title: `スウィズルを '.${shorter}' に変更`,
        edits: [{ start: lastToken.start, end: lastToken.end, newText: shorter }],
        preferred: true,
      },
    ];
  }
  const swizzle = 'xyzw'.substring(0, rows);
  if (isChain && lastToken.kind !== 'number') {
    return [{ title: `'.${swizzle}' を付けて成分を明示`, edits: [{ start: lastToken.end, end: lastToken.end, newText: `.${swizzle}` }], preferred: true }];
  }
  return [
    {
      title: `'(...).${swizzle}' で成分を明示`,
      edits: [
        { start: tokens[from].start, end: tokens[from].start, newText: '(' },
        { start: lastToken.end, end: lastToken.end, newText: `).${swizzle}` },
      ],
      preferred: true,
    },
  ];
}

const TEXTURE_DECLARATIONS: Record<string, [macro: string, type: string]> = {
  '2D': ['TEXTURE2D', 'Texture2D'],
  Any: ['TEXTURE2D', 'Texture2D'],
  Rect: ['TEXTURE2D', 'Texture2D'],
  '3D': ['TEXTURE3D', 'Texture3D'],
  Cube: ['TEXTURECUBE', 'TextureCube'],
  '2DArray': ['TEXTURE2D_ARRAY', 'Texture2DArray'],
  CubeArray: ['TEXTURECUBE_ARRAY', 'TextureCubeArray'],
};

/** ShaderLab Property の型に対応するHLSLの変数の型。 */
function propertyValueType(typeKind: string): string {
  switch (typeKind) {
    case 'Color':
    case 'Vector':
      return 'float4';
    case 'Integer':
      return 'int';
    default:
      return 'float';
  }
}

/**
 * Propertiesで宣言されているがHLSL側に宣言がない変数の宣言を追加する。
 * 数値は CBUFFER(UnityPerMaterial) 内へ、テクスチャは使用箇所を含む関数の前へ追加する。
 */
export function declarePropertyFix(
  file: SourceFile,
  unitIndex: number,
  context: AnalysisContext,
  property: ShaderProperty,
  useOffset: number,
): TextFix[] | undefined {
  const eol = lineEnding(file.text);
  const anchor = file.structAt(unitIndex, useOffset)?.start ?? file.functionAt(unitIndex, useOffset)?.start;
  const anchorLine = anchor === undefined ? undefined : lineStartOf(file.text, anchor);
  const indent = anchorLine === undefined ? '' : indentationAt(file.text, anchorLine);

  const texture = TEXTURE_DECLARATIONS[property.typeKind];
  if (texture) {
    if (anchorLine === undefined) return undefined;
    const name = property.name;
    const lines = context.has(texture[0])
      ? [`${texture[0]}(${name});`, `SAMPLER(sampler${name});`]
      : [`${texture[1]} ${name};`, `SamplerState sampler${name};`];
    const newText = lines.map((line) => `${indent}${line}${eol}`).join('') + eol;
    return [{ title: `テクスチャ '${name}' の宣言を追加`, edits: [{ start: anchorLine, end: anchorLine, newText }], preferred: true }];
  }

  const declaration = `${propertyValueType(property.typeKind)} ${property.name};`;
  const buffer = context.lookupKind('UnityPerMaterial', 'cbuffer').find((symbol) => symbol.file === file);
  if (buffer) {
    return [
      { title: `'${declaration}' を CBUFFER(UnityPerMaterial) に追加`, edits: [insertIntoBuffer(file, buffer.node, declaration)], preferred: true },
    ];
  }
  if (anchorLine === undefined) return undefined;
  const block = context.has('CBUFFER_START')
    ? [`CBUFFER_START(UnityPerMaterial)`, `    ${declaration}`, 'CBUFFER_END']
    : ['cbuffer UnityPerMaterial', '{', `    ${declaration}`, '};'];
  const newText = block.map((line) => `${indent}${line}${eol}`).join('') + eol;
  return [
    { title: `CBUFFER(UnityPerMaterial) を作成して '${declaration}' を追加`, edits: [{ start: anchorLine, end: anchorLine, newText }], preferred: true },
  ];
}

/**
 * CBUFFER(UnityPerMaterial) の外で宣言された Property の変数を、CBUFFER内へ移動する。
 * 1行に1つだけ宣言されている場合に限る。
 */
export function moveIntoBufferFix(
  file: SourceFile,
  buffers: SymbolOfKind<'cbuffer'>[],
  outside: SymbolOfKind<'variable'>[],
): TextFix[] | undefined {
  const buffer = buffers.find((symbol) => symbol.file === file);
  const declaration = outside.find((symbol) => symbol.file === file && !symbol.container && !symbol.node.fromMacro);
  if (!buffer || !declaration) return undefined;
  const text = file.text;
  const lineStart = lineStartOf(text, declaration.node.start);
  const newline = text.indexOf('\n', declaration.node.end);
  const lineEnd = newline < 0 ? text.length : newline + 1;
  const statement = text.substring(lineStart, lineEnd).trim();
  // `float a, b;` やコメント付きの行など、1文1変数でない行は移動しない。
  if (!/^[^,;{}()]*;$/.test(statement) || file.isInComment(lineStart)) return undefined;
  return [
    {
      title: `'${declaration.name}' の宣言を CBUFFER(UnityPerMaterial) 内へ移動`,
      edits: [{ start: lineStart, end: lineEnd, newText: '' }, insertIntoBuffer(file, buffer.node, statement)],
      preferred: true,
    },
  ];
}

/** cbufferの終端(`}` / CBUFFER_END)の直前に宣言を追加する編集。 */
function insertIntoBuffer(file: SourceFile, cbuffer: HlslCBuffer, declaration: string): TextFixEdit {
  const text = file.text;
  let close = cbuffer.end;
  if (text[close - 1] === '}') close--;
  else while (close > cbuffer.start && /\w/.test(text[close - 1])) close--;
  const lineStart = lineStartOf(text, close);
  if (!/^[ \t]*$/.test(text.substring(lineStart, close))) {
    // `{ float a; }` のように1行で書かれている。
    return { start: close, end: close, newText: `${declaration} ` };
  }
  const lastField = cbuffer.fields[cbuffer.fields.length - 1];
  const indent = lastField ? indentationAt(text, lineStartOf(text, lastField.start)) : `${indentationAt(text, lineStart)}    `;
  return { start: lineStart, end: lineStart, newText: `${indent}${declaration}${lineEnding(text)}` };
}

function lineStartOf(text: string, offset: number): number {
  return text.lastIndexOf('\n', offset - 1) + 1;
}

function indentationAt(text: string, lineStart: number): string {
  return /^[ \t]*/.exec(text.substring(lineStart, lineStart + 200))?.[0] ?? '';
}

function lineEnding(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}
