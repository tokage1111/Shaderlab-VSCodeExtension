import {
  CompletionItem,
  CompletionItemKind,
  CompletionList,
  InsertTextFormat,
  MarkupKind,
  Range,
} from 'vscode-languageserver';
import {
  COMPLETION_SEMANTICS,
  COMPLETION_TYPES,
  CONTROL_KEYWORDS,
  DIRECTIVES,
  FUNCTION_PRAGMAS,
  getObjectMethods,
  getSemanticInfo,
  HLSL_ATTRIBUTES,
  INTRINSICS,
  KeywordInfo,
  PRAGMAS,
  PROPERTY_ATTRIBUTES,
  PROPERTY_TYPE_COMPLETIONS,
  SHADERLAB_KEYWORDS,
  SHADERLAB_VALUES,
  STORAGE_KEYWORDS,
  TAG_VALUES,
  URP_KEYWORDS,
} from '../analysis/builtins';
import { AnalysisContext } from '../analysis/context';
import { findDirectiveAt } from '../analysis/resolver';
import { visibleLocals } from '../analysis/scope';
import { GlobalSymbol, SourceFile } from '../analysis/sourceFile';
import { TypeEvaluator, TypeRef } from '../analysis/typeEvaluator';
import { Workspace } from '../analysis/workspace';
import { ShaderSectionKind } from '../parser/ast';
import { lowerBoundToken } from '../parser/lexer';
import { codeBlock, displayPath, formatSymbol, formatVariable, symbolKindLabel } from './format';

const SORT_LOCAL = '0';
const SORT_SAME_FILE = '1';
const SORT_CONTEXT = '2';
const SORT_BUILTIN = '3';
const SORT_KEYWORD = '4';

/** コンテキストごとのシンボル補完候補(コンテキストは不変なので使い回せる)。 */
const symbolItemCache = new WeakMap<AnalysisContext, Map<string, CompletionItem[]>>();

export async function provideCompletion(workspace: Workspace, file: SourceFile, offset: number): Promise<CompletionList> {
  const empty: CompletionList = { isIncomplete: false, items: [] };
  const text = file.text;
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  const linePrefix = text.substring(lineStart, offset);

  // プリプロセッサ行
  if (findDirectiveAt(file, offset) || /^\s*#/.test(linePrefix)) {
    return provideDirectiveCompletion(workspace, file, offset, linePrefix);
  }
  if (file.isInComment(offset)) return empty;

  const unitIndex = file.unitIndexAt(offset);
  if (unitIndex < 0) {
    return { isIncomplete: false, items: provideShaderLabCompletion(file, offset, linePrefix) };
  }
  if (file.isInString(offset)) return empty;

  const context = await workspace.contextForUnit(file, unitIndex);
  const evaluator = new TypeEvaluator(context, file, unitIndex);

  // メンバーアクセス `obj.`
  const member = /([.]|->)\s*([A-Za-z_][A-Za-z0-9_]*)?$/.exec(linePrefix);
  if (member) {
    const dotOffset = lineStart + member.index;
    const dotIndex = lowerBoundToken(file.tokens, dotOffset);
    if (file.tokens[dotIndex]?.start === dotOffset) {
      const start = evaluator.chainStart(dotIndex - 1);
      // `1.` のような数値は小数点なので候補を出さない。
      if (start >= 0 && !(start === dotIndex - 1 && file.tokens[start].kind === 'number')) {
        const type = evaluator.evaluateChain(start, dotIndex - 1);
        return { isIncomplete: false, items: type ? memberCompletions(evaluator, type) : [] };
      }
    }
  }

  // セマンティクス `float4 pos : SV_|`
  if (/(?:\w|\])\s*:\s*[A-Za-z_0-9]*$/.test(linePrefix) && !/\?[^:]*$/.test(linePrefix) && !/\bcase\b/.test(linePrefix)) {
    return { isIncomplete: false, items: semanticCompletions() };
  }

  // 属性 `[unroll]`
  if (/(^|[;{}])\s*\[\s*[A-Za-z_]*$/.test(linePrefix)) {
    return {
      isIncomplete: false,
      items: HLSL_ATTRIBUTES.map((label) => ({ label, kind: CompletionItemKind.Keyword, detail: 'HLSL属性' })),
    };
  }

  const items: CompletionItem[] = [];
  const seen = new Set<string>();
  for (const local of visibleLocals(file, unitIndex, offset)) {
    seen.add(local.variable.name);
    items.push({
      label: local.variable.name,
      kind: CompletionItemKind.Variable,
      detail: `${local.variable.type} ${local.variable.name}`,
      labelDetails: { description: local.isParameter ? '引数' : 'ローカル' },
      sortText: `${SORT_LOCAL}${local.variable.name}`,
    });
  }
  // structのメソッド内ではメンバーを直接参照できる。
  const enclosing = file.structAt(unitIndex, offset);
  if (enclosing) {
    for (const field of enclosing.fields) {
      if (seen.has(field.name)) continue;
      seen.add(field.name);
      items.push({ label: field.name, kind: CompletionItemKind.Field, detail: formatVariable(field), sortText: `${SORT_LOCAL}${field.name}` });
    }
  }
  for (const item of symbolCompletions(context, file)) {
    if (seen.has(item.label)) continue;
    seen.add(item.label);
    items.push(item);
  }
  for (const item of builtinCompletions()) {
    if (seen.has(item.label)) continue;
    items.push(item);
  }
  return { isIncomplete: false, items };
}

/* ---------------------------------------------------------------------------
 * HLSL
 * ------------------------------------------------------------------------- */

function symbolCompletions(context: AnalysisContext, file: SourceFile): CompletionItem[] {
  let perFile = symbolItemCache.get(context);
  if (!perFile) {
    perFile = new Map();
    symbolItemCache.set(context, perFile);
  }
  const cached = perFile.get(file.key);
  if (cached) return cached;

  const byName = new Map<string, GlobalSymbol[]>();
  for (const symbol of context.allSymbols()) {
    if (!symbol.name) continue;
    const list = byName.get(symbol.name);
    if (list) list.push(symbol);
    else byName.set(symbol.name, [symbol]);
  }
  const items: CompletionItem[] = [];
  for (const [name, symbols] of byName) {
    const symbol = symbols.find((candidate) => candidate.file === file) ?? symbols[0];
    const overloads = symbol.kind === 'function' ? symbols.filter((candidate) => candidate.kind === 'function').length : 1;
    items.push({
      label: name,
      kind: completionKind(symbol),
      detail: symbol.kind === 'function' ? formatSymbol(symbol) + (overloads > 1 ? ` (+${overloads - 1} オーバーロード)` : '') : symbolKindLabel(symbol),
      labelDetails: { description: symbol.file === file ? undefined : displayPath(symbol.file.path) },
      documentation:
        symbol.kind === 'function'
          ? undefined
          : { kind: MarkupKind.Markdown, value: codeBlock(formatSymbol(symbol)) },
      sortText: `${symbol.file === file ? SORT_SAME_FILE : SORT_CONTEXT}${name}`,
    });
  }
  perFile.set(file.key, items);
  return items;
}

function completionKind(symbol: GlobalSymbol): CompletionItemKind {
  switch (symbol.kind) {
    case 'function':
      return CompletionItemKind.Function;
    case 'struct':
      return CompletionItemKind.Struct;
    case 'variable':
      return symbol.container ? CompletionItemKind.Field : CompletionItemKind.Variable;
    case 'cbuffer':
      return CompletionItemKind.Module;
    case 'typedef':
      return CompletionItemKind.Class;
    case 'macro':
      return symbol.node.params ? CompletionItemKind.Function : CompletionItemKind.Constant;
  }
}

let builtinItems: CompletionItem[] | undefined;

function builtinCompletions(): CompletionItem[] {
  if (builtinItems) return builtinItems;
  const items: CompletionItem[] = [];
  for (const type of COMPLETION_TYPES) {
    items.push({ label: type, kind: CompletionItemKind.TypeParameter, detail: 'HLSL組み込み型', sortText: `${SORT_BUILTIN}${type}` });
  }
  for (const [name, info] of Object.entries(INTRINSICS)) {
    items.push({
      label: name,
      kind: CompletionItemKind.Function,
      detail: info.signature,
      documentation: info.doc,
      sortText: `${SORT_BUILTIN}${name}`,
    });
  }
  for (const keyword of [...CONTROL_KEYWORDS, ...STORAGE_KEYWORDS, 'true', 'false']) {
    items.push({ label: keyword, kind: CompletionItemKind.Keyword, sortText: `${SORT_KEYWORD}${keyword}` });
  }
  builtinItems = items;
  return items;
}

function memberCompletions(evaluator: TypeEvaluator, type: TypeRef): CompletionItem[] {
  const resolved = evaluator.resolve(type);
  if (resolved.arrayDims > 0) return [];
  if (resolved.numeric) {
    const numeric = resolved.numeric;
    if (numeric.columns > 0) {
      const items: CompletionItem[] = [];
      for (let r = 0; r < numeric.rows; r++) {
        for (let c = 0; c < numeric.columns; c++) {
          items.push({ label: `_m${r}${c}`, kind: CompletionItemKind.Field, detail: numeric.scalar });
        }
      }
      return items;
    }
    return swizzleCompletions(Math.max(1, numeric.rows), numeric.scalar);
  }
  const methods = getObjectMethods(resolved.base);
  if (methods) {
    return Object.entries(methods).map(([name, method]) => ({
      label: name,
      kind: CompletionItemKind.Method,
      detail: method.signature,
      documentation: method.doc,
      insertText: method.maxArgs === 0 ? `${name}()` : `${name}($0)`,
      insertTextFormat: InsertTextFormat.Snippet,
      command: method.maxArgs === 0 ? undefined : { title: '', command: 'editor.action.triggerParameterHints' },
    }));
  }
  const structName = (resolved.base === 'ConstantBuffer' || resolved.base === 'TextureBuffer') && resolved.template ? resolved.template : resolved.base;
  const items: CompletionItem[] = [];
  const seen = new Set<string>();
  for (const struct of evaluator.findStructs(structName)) {
    struct.node.fields.forEach((field, index) => {
      if (seen.has(field.name)) return;
      seen.add(field.name);
      items.push({
        label: field.name,
        kind: CompletionItemKind.Field,
        detail: formatVariable(field),
        labelDetails: field.semantic ? { description: field.semantic } : undefined,
        // 宣言順に並べる。
        sortText: String(index).padStart(4, '0'),
      });
    });
    for (const method of struct.node.methods) {
      if (seen.has(method.name)) continue;
      seen.add(method.name);
      items.push({ label: method.name, kind: CompletionItemKind.Method, detail: `${method.returnType} ${method.name}(...)` });
    }
  }
  return items;
}

function swizzleCompletions(size: number, scalar: string): CompletionItem[] {
  const xyzw = 'xyzw'.substring(0, size);
  const rgba = 'rgba'.substring(0, size);
  const labels: string[] = [...xyzw, ...rgba];
  if (size >= 2) labels.push(xyzw.substring(0, 2), rgba.substring(0, 2));
  if (size >= 3) labels.push(xyzw.substring(0, 3), rgba.substring(0, 3), 'xz', 'yz');
  if (size >= 4) labels.push(xyzw, rgba, 'zw');
  const unique = Array.from(new Set(labels));
  return unique.map((label, index) => ({
    label,
    kind: CompletionItemKind.Field,
    detail: label.length === 1 ? scalar : `${scalar}${label.length}`,
    sortText: String(index).padStart(3, '0'),
  }));
}

function semanticCompletions(): CompletionItem[] {
  return COMPLETION_SEMANTICS.map((semantic, index) => ({
    label: semantic,
    kind: CompletionItemKind.EnumMember,
    detail: getSemanticInfo(semantic),
    sortText: String(index).padStart(3, '0'),
  }));
}

/* ---------------------------------------------------------------------------
 * プリプロセッサ
 * ------------------------------------------------------------------------- */

async function provideDirectiveCompletion(
  workspace: Workspace,
  file: SourceFile,
  offset: number,
  linePrefix: string,
): Promise<CompletionList> {
  const list = (items: CompletionItem[], isIncomplete = false): CompletionList => ({ isIncomplete, items });

  const include = /^\s*#\s*include(?:_with_pragmas)?\s*(["<])([^"<>]*)$/.exec(linePrefix);
  if (include) {
    return list(includeCompletions(workspace, file, offset, include[2]));
  }
  const directiveName = /^\s*#\s*([A-Za-z_]*)$/.exec(linePrefix);
  if (directiveName) {
    return list(
      Object.entries(DIRECTIVES).map(([name, doc]) => ({
        label: name,
        kind: CompletionItemKind.Keyword,
        documentation: doc,
        insertText: name === 'include' || name === 'include_with_pragmas' ? `${name} "$0"` : name,
        insertTextFormat: InsertTextFormat.Snippet,
        command: name.startsWith('include') ? { title: '', command: 'editor.action.triggerSuggest' } : undefined,
      })),
    );
  }
  const pragmaName = /^\s*#\s*pragma\s+([A-Za-z_]*)$/.exec(linePrefix);
  if (pragmaName) {
    return list(Object.entries(PRAGMAS).map(([name, doc]) => ({ label: name, kind: CompletionItemKind.Keyword, documentation: doc })));
  }
  const pragmaArgs = /^\s*#\s*pragma\s+([A-Za-z_]+)\s+(.*)$/.exec(linePrefix);
  if (pragmaArgs) {
    const name = pragmaArgs[1];
    if (FUNCTION_PRAGMAS.has(name)) {
      const unitIndex = file.unitIndexAt(offset);
      if (unitIndex < 0) return list([]);
      const context = await workspace.contextForUnit(file, unitIndex);
      const items: CompletionItem[] = [];
      const seen = new Set<string>();
      for (const symbol of context.allSymbols()) {
        if (symbol.kind !== 'function' || seen.has(symbol.name)) continue;
        seen.add(symbol.name);
        items.push({
          label: symbol.name,
          kind: CompletionItemKind.Function,
          detail: formatSymbol(symbol),
          sortText: `${symbol.file === file ? SORT_SAME_FILE : SORT_CONTEXT}${symbol.name}`,
        });
      }
      return list(items);
    }
    if (/^(multi_compile|shader_feature|dynamic_branch)/.test(name)) {
      return list(['_', ...URP_KEYWORDS].map((keyword) => ({ label: keyword, kind: CompletionItemKind.Constant })));
    }
    if (name === 'target') {
      return list(['2.0', '2.5', '3.0', '3.5', '4.0', '4.5', '4.6', '5.0', '6.0'].map((label) => ({ label, kind: CompletionItemKind.Value })));
    }
    if (name === 'only_renderers' || name === 'exclude_renderers') {
      return list(
        ['d3d11', 'glcore', 'gles', 'gles3', 'metal', 'vulkan', 'xboxone', 'ps4', 'ps5', 'switch', 'webgpu'].map((label) => ({
          label,
          kind: CompletionItemKind.Value,
        })),
      );
    }
    return list([]);
  }
  // #if defined(...) などではマクロ名を補完する。
  if (/^\s*#\s*(if|elif|ifdef|ifndef|undef|define)\b/.test(linePrefix)) {
    const unitIndex = file.unitIndexAt(offset);
    if (unitIndex < 0) return list([]);
    const context = await workspace.contextForUnit(file, unitIndex);
    const items: CompletionItem[] = [{ label: 'defined', kind: CompletionItemKind.Keyword }];
    const seen = new Set<string>();
    for (const symbol of context.allSymbols()) {
      if (symbol.kind !== 'macro' || seen.has(symbol.name)) continue;
      seen.add(symbol.name);
      items.push({ label: symbol.name, kind: CompletionItemKind.Constant, sortText: `${SORT_CONTEXT}${symbol.name}` });
    }
    // 同じ単位の #pragma で宣言されたキーワード
    for (const pragma of file.units[unitIndex]?.pragmas ?? []) {
      if (!/^(multi_compile|shader_feature|dynamic_branch)/.test(pragma.name)) continue;
      for (const arg of pragma.args) {
        if (/^_+$/.test(arg.value) || seen.has(arg.value)) continue;
        seen.add(arg.value);
        items.push({ label: arg.value, kind: CompletionItemKind.Constant, detail: `#pragma ${pragma.name}`, sortText: `${SORT_LOCAL}${arg.value}` });
      }
    }
    return list(items);
  }
  return list([]);
}

function includeCompletions(workspace: Workspace, file: SourceFile, offset: number, typed: string): CompletionItem[] {
  const slash = Math.max(typed.lastIndexOf('/'), typed.lastIndexOf('\\'));
  const directory = slash >= 0 ? typed.substring(0, slash + 1) : '';
  const replaceStart = offset - (typed.length - directory.length);
  const lineEnd = file.text.indexOf('\n', offset);
  const rest = file.text.substring(offset, lineEnd < 0 ? file.text.length : lineEnd);
  // 入力位置以降のパス文字も置き換える。
  const restLength = /^[^"<>\r\n]*/.exec(rest)?.[0].length ?? 0;
  const range: Range = file.lineIndex.range(replaceStart, offset + restLength);
  return workspace.project.listIncludeCompletions(directory, file.path).map((entry) => ({
    label: entry.isDirectory ? `${entry.name}/` : entry.name,
    kind: entry.isDirectory ? CompletionItemKind.Folder : CompletionItemKind.File,
    textEdit: { range, newText: entry.isDirectory ? `${entry.name}/` : entry.name },
    sortText: `${entry.isDirectory ? '1' : '0'}${entry.name}`,
    command: entry.isDirectory ? { title: '', command: 'editor.action.triggerSuggest' } : undefined,
  }));
}

/* ---------------------------------------------------------------------------
 * ShaderLab
 * ------------------------------------------------------------------------- */

function sectionAt(file: SourceFile, offset: number): ShaderSectionKind | undefined {
  let best: { kind: ShaderSectionKind; size: number } | undefined;
  for (const section of file.shader?.sections ?? []) {
    if (offset <= section.start || offset >= section.end) continue;
    const size = section.end - section.start;
    if (!best || size < best.size) best = { kind: section.kind, size };
  }
  return best?.kind;
}

function keywordItems(keywords: KeywordInfo[]): CompletionItem[] {
  return keywords.map((keyword) => ({
    label: keyword.label,
    kind: CompletionItemKind.Keyword,
    documentation: keyword.doc,
    insertText: keyword.snippet ?? keyword.label,
    insertTextFormat: keyword.snippet ? InsertTextFormat.Snippet : InsertTextFormat.PlainText,
  }));
}

function provideShaderLabCompletion(file: SourceFile, offset: number, linePrefix: string): CompletionItem[] {
  const section = sectionAt(file, offset);
  const inString = file.isInString(offset);

  if (section === 'Tags') {
    const tagValue = /"([A-Za-z]+)"\s*=\s*"([^"]*)$/.exec(linePrefix);
    if (inString && tagValue) {
      return (TAG_VALUES[tagValue[1]] ?? []).map((value) => ({ label: value, kind: CompletionItemKind.EnumMember }));
    }
    if (inString) {
      return Object.keys(TAG_VALUES).map((key) => ({ label: key, kind: CompletionItemKind.Property }));
    }
    return Object.keys(TAG_VALUES).map((key) => ({
      label: key,
      kind: CompletionItemKind.Property,
      insertText: `"${key}" = "\${1|${TAG_VALUES[key].join(',')}|}"`,
      insertTextFormat: InsertTextFormat.Snippet,
    }));
  }
  if (inString) return [];

  if (section === 'Properties') {
    if (/\[\s*[A-Za-z]*$/.test(linePrefix)) return keywordItems(PROPERTY_ATTRIBUTES);
    if (/\(\s*"[^"]*"\s*,\s*[A-Za-z0-9]*$/.test(linePrefix)) return keywordItems(PROPERTY_TYPE_COMPLETIONS);
    if (/^\s*[A-Za-z_]*$/.test(linePrefix)) {
      return [
        {
          label: 'Property',
          kind: CompletionItemKind.Snippet,
          detail: '_Name ("表示名", 型) = 既定値',
          insertText: '${1:_Name} ("${2:Display Name}", ${3|Float,Range(0\\, 1),Int,Color,Vector,2D,3D,Cube|}) = ${4:0}',
          insertTextFormat: InsertTextFormat.Snippet,
        },
      ];
    }
    return [];
  }

  // 描画ステートの値 `Cull |`
  if (/\b(Cull|ZWrite|ZTest|Blend|BlendOp|AlphaToMask|ZClip|Conservative|Comp|Pass|Fail|ZFail)\s+[A-Za-z]*$/.test(linePrefix) && section !== 'Shader') {
    return SHADERLAB_VALUES.map((value) => ({ label: value, kind: CompletionItemKind.EnumMember }));
  }
  if (!/^\s*[A-Za-z_]*$/.test(linePrefix)) return [];
  switch (section) {
    case 'Pass':
      return keywordItems(SHADERLAB_KEYWORDS.Pass);
    case 'SubShader':
      return keywordItems(SHADERLAB_KEYWORDS.SubShader);
    case 'Category':
      return keywordItems(SHADERLAB_KEYWORDS.Category);
    case 'Stencil':
      return keywordItems(SHADERLAB_KEYWORDS.Stencil);
    case 'Shader':
      return keywordItems(SHADERLAB_KEYWORDS.Shader);
    default:
      if (!file.shader?.name) {
        return [
          {
            label: 'Shader',
            kind: CompletionItemKind.Snippet,
            detail: 'URPシェーダーのひな形',
            insertText: URP_SHADER_TEMPLATE,
            insertTextFormat: InsertTextFormat.Snippet,
          },
        ];
      }
      return [];
  }
}

const URP_SHADER_TEMPLATE = [
  'Shader "${1:Custom/NewShader}"',
  '{',
  '\tProperties',
  '\t{',
  '\t\t[MainTexture] _BaseMap ("Base Map", 2D) = "white" {}',
  '\t\t[MainColor] _BaseColor ("Base Color", Color) = (1, 1, 1, 1)',
  '\t}',
  '',
  '\tSubShader',
  '\t{',
  '\t\tTags { "RenderType" = "Opaque" "RenderPipeline" = "UniversalPipeline" }',
  '',
  '\t\tPass',
  '\t\t{',
  '\t\t\tName "ForwardLit"',
  '\t\t\tTags { "LightMode" = "UniversalForward" }',
  '',
  '\t\t\tHLSLPROGRAM',
  '\t\t\t#pragma vertex vert',
  '\t\t\t#pragma fragment frag',
  '',
  '\t\t\t#include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"',
  '',
  '\t\t\tstruct Attributes',
  '\t\t\t{',
  '\t\t\t\tfloat4 positionOS : POSITION;',
  '\t\t\t\tfloat2 uv : TEXCOORD0;',
  '\t\t\t};',
  '',
  '\t\t\tstruct Varyings',
  '\t\t\t{',
  '\t\t\t\tfloat4 positionHCS : SV_POSITION;',
  '\t\t\t\tfloat2 uv : TEXCOORD0;',
  '\t\t\t};',
  '',
  '\t\t\tTEXTURE2D(_BaseMap);',
  '\t\t\tSAMPLER(sampler_BaseMap);',
  '',
  '\t\t\tCBUFFER_START(UnityPerMaterial)',
  '\t\t\t\tfloat4 _BaseMap_ST;',
  '\t\t\t\thalf4 _BaseColor;',
  '\t\t\tCBUFFER_END',
  '',
  '\t\t\tVaryings vert(Attributes input)',
  '\t\t\t{',
  '\t\t\t\tVaryings output;',
  '\t\t\t\toutput.positionHCS = TransformObjectToHClip(input.positionOS.xyz);',
  '\t\t\t\toutput.uv = TRANSFORM_TEX(input.uv, _BaseMap);',
  '\t\t\t\treturn output;',
  '\t\t\t}',
  '',
  '\t\t\thalf4 frag(Varyings input) : SV_Target',
  '\t\t\t{',
  '\t\t\t\treturn SAMPLE_TEXTURE2D(_BaseMap, sampler_BaseMap, input.uv) * _BaseColor;$0',
  '\t\t\t}',
  '\t\t\tENDHLSL',
  '\t\t}',
  '\t}',
  '}',
].join('\n');
