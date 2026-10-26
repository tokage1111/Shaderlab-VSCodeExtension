import { HlslInclude, HlslVariable, ShaderProperty } from '../parser/ast';
import { Directive, Token, tokenIndexAt, tokenizeRange } from '../parser/lexer';
import { IncludeResolution } from '../project/unityProject';
import {
  FUNCTION_PRAGMAS,
  getSemanticInfo,
  HLSL_KEYWORDS,
  INTRINSICS,
  IntrinsicInfo,
  isBuiltinType,
  MethodInfo,
} from './builtins';
import { AnalysisContext } from './context';
import { findLocal, LocalLookup } from './scope';
import { GlobalSymbol, SourceFile, SymbolOfKind } from './sourceFile';
import { ResolvedType, TypeEvaluator } from './typeEvaluator';
import { Workspace } from './workspace';

export type Resolution =
  | ({ kind: 'local' } & LocalLookup & { file: SourceFile })
  | { kind: 'symbol'; symbols: GlobalSymbol[] }
  | { kind: 'field'; struct: SymbolOfKind<'struct'>; field: HlslVariable }
  | { kind: 'swizzle'; text: string; type: string }
  | { kind: 'method'; name: string; method: MethodInfo; objectType: ResolvedType }
  | { kind: 'intrinsic'; name: string; info: IntrinsicInfo }
  | { kind: 'builtinType'; name: string }
  | { kind: 'keyword'; name: string }
  | { kind: 'semantic'; name: string }
  | { kind: 'include'; include: HlslInclude; resolution: IncludeResolution; fromFile: SourceFile }
  | { kind: 'property'; property: ShaderProperty; file: SourceFile }
  /** メンバーが見つからない/型が不明。 */
  | { kind: 'unresolvedMember'; name: string; message?: string }
  | { kind: 'unresolved'; name: string };

export interface ResolveResult {
  resolution: Resolution;
  context: AnalysisContext;
  unitIndex: number;
  start: number;
  end: number;
  name: string;
}

export function findDirectiveAt(file: SourceFile, offset: number): Directive | undefined {
  const directives = file.lexResult.directives;
  let low = 0;
  let high = directives.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const directive = directives[middle];
    if (offset < directive.start) high = middle - 1;
    else if (offset > directive.end) low = middle + 1;
    else return directive;
  }
  return undefined;
}

/**
 * offset位置の識別子が何を指すかを解決する。
 */
export async function resolveAt(
  workspace: Workspace,
  file: SourceFile,
  offset: number,
  contextOverride?: AnalysisContext,
): Promise<ResolveResult | undefined> {
  const directive = findDirectiveAt(file, offset);
  if (directive) {
    const unitIndex = file.unitIndexAt(directive.start);
    const context =
      contextOverride ??
      (unitIndex >= 0 ? await workspace.contextForUnit(file, unitIndex) : AnalysisContext.empty(file.key));
    return resolveInDirective(workspace, file, unitIndex, context, directive, offset);
  }
  if (file.isInComment(offset)) return undefined;

  const unitIndex = file.unitIndexAt(offset);
  if (unitIndex < 0) {
    const property = file.shader?.properties.find((p) => offset >= p.nameStart && offset <= p.nameEnd);
    if (property) {
      return {
        resolution: { kind: 'property', property, file },
        context: AnalysisContext.empty(file.key),
        unitIndex,
        start: property.nameStart,
        end: property.nameEnd,
        name: property.name,
      };
    }
    return undefined;
  }
  const tokens = file.tokens;
  const index = tokenIndexAt(tokens, offset);
  const token = tokens[index];
  if (!token || token.kind !== 'ident') return undefined;
  const unit = file.units[unitIndex];
  if (index < unit.tokenStart || index >= unit.tokenEnd) return undefined;
  const context = contextOverride ?? (await workspace.contextForUnit(file, unitIndex));
  const resolution = resolveToken(context, file, unitIndex, index);
  return { resolution, context, unitIndex, start: token.start, end: token.end, name: token.value };
}

/**
 * トークンindexの識別子を解決する(同期)。参照検索や診断から大量に呼ばれる。
 */
export function resolveToken(
  context: AnalysisContext,
  file: SourceFile,
  unitIndex: number,
  index: number,
  evaluator = new TypeEvaluator(context, file, unitIndex),
): Resolution {
  const tokens = file.tokens;
  const token = tokens[index];
  const name = token.value;
  const unit = file.units[unitIndex];
  const previous = index - 1 >= unit.tokenStart ? tokens[index - 1] : undefined;
  const next = index + 1 < unit.tokenEnd ? tokens[index + 1] : undefined;

  if (unit.semanticOffsets.has(token.start)) {
    if (getSemanticInfo(name) || /^SV_/i.test(name)) return { kind: 'semantic', name };
    if (name === 'register' || name === 'packoffset') return { kind: 'keyword', name };
    return { kind: 'semantic', name };
  }

  // メンバーアクセス
  if (previous && (previous.value === '.' || previous.value === '->') && index - 2 >= unit.tokenStart) {
    return resolveMember(evaluator, name, index);
  }

  // 宣言名そのもの
  if (unit.declarationOffsets.has(token.start)) {
    const declared = resolveDeclaration(context, file, unitIndex, token);
    if (declared) return declared;
  }

  const local = findLocal(file, unitIndex, name, token.start);
  if (local && next?.value !== '(') {
    return { kind: 'local', ...local, file };
  }

  // structのメソッド内では、メンバーを名前だけで参照できる。
  const enclosing = local ? undefined : file.structAt(unitIndex, token.start);
  if (enclosing) {
    const field = enclosing.fields.find((candidate) => candidate.name === name);
    const method = enclosing.methods.find((candidate) => candidate.name === name);
    const struct = { kind: 'struct' as const, name: enclosing.name, file, unitIndex, node: enclosing };
    if (field && next?.value !== '(') return { kind: 'field', struct, field };
    if (method) return { kind: 'symbol', symbols: [{ kind: 'function', name, file, unitIndex, node: method }] };
  }

  const symbols = context.lookup(name);
  if (next?.value === '(') {
    const callable = symbols.filter((symbol) => symbol.kind === 'function' || symbol.kind === 'macro');
    if (callable.length > 0) {
      const close = evaluator.matchForward(index + 1);
      const count = close > 0 ? evaluator.countArguments(evaluator.splitArguments(index + 1, close)) : -1;
      return { kind: 'symbol', symbols: orderSymbols(callable, file, unitIndex, count) };
    }
    const intrinsic = INTRINSICS[name];
    if (intrinsic) return { kind: 'intrinsic', name, info: intrinsic };
    if (isBuiltinType(name)) return { kind: 'builtinType', name };
  }
  if (local) return { kind: 'local', ...local, file };
  if (symbols.length > 0) {
    return { kind: 'symbol', symbols: orderSymbols(symbols, file, unitIndex, -1) };
  }
  if (isBuiltinType(name)) return { kind: 'builtinType', name };
  if (HLSL_KEYWORDS.has(name)) return { kind: 'keyword', name };
  const intrinsic = INTRINSICS[name];
  if (intrinsic) return { kind: 'intrinsic', name, info: intrinsic };
  return { kind: 'unresolved', name };
}

function resolveMember(evaluator: TypeEvaluator, name: string, index: number): Resolution {
  const start = evaluator.chainStart(index - 2);
  if (start < 0) return { kind: 'unresolvedMember', name };
  const objectType = evaluator.evaluateChain(start, index - 2);
  if (!objectType) return { kind: 'unresolvedMember', name };
  const member = evaluator.memberOf(objectType, name);
  switch (member.kind) {
    case 'field':
      return { kind: 'field', struct: member.struct, field: member.field };
    case 'swizzle':
      return { kind: 'swizzle', text: name, type: member.type.name };
    case 'method':
      return { kind: 'method', name, method: member.method, objectType: member.objectType };
    case 'structMethod':
      return {
        kind: 'symbol',
        symbols: [{ kind: 'function', name, file: member.struct.file, unitIndex: member.struct.unitIndex, node: member.fn }],
      };
    case 'missing':
      return { kind: 'unresolvedMember', name, message: member.message };
    default:
      return { kind: 'unresolvedMember', name };
  }
}

function resolveDeclaration(
  context: AnalysisContext,
  file: SourceFile,
  unitIndex: number,
  token: Token,
): Resolution | undefined {
  const unit = file.units[unitIndex];
  const local = findLocal(file, unitIndex, token.value, token.start);
  if (local && local.variable.nameStart === token.start) return { kind: 'local', ...local, file };
  for (const struct of unit.structs) {
    if (token.start < struct.start || token.start > struct.end) continue;
    const field = struct.fields.find((candidate) => candidate.nameStart === token.start && candidate.name === token.value);
    if (field) {
      const symbol = context
        .lookupKind(struct.name, 'struct')
        .find((candidate) => candidate.node === struct) ?? {
        kind: 'struct' as const,
        name: struct.name,
        file,
        unitIndex,
        node: struct,
      };
      return { kind: 'field', struct: symbol, field };
    }
  }
  const own = file.symbolsOf(unitIndex).filter((symbol) => symbol.node.nameStart === token.start && symbol.name === token.value);
  if (own.length > 0) {
    // 同名の他の定義(オーバーロード等)も候補に含める。
    const others = context.lookup(token.value).filter((symbol) => !own.includes(symbol) && symbol.kind === own[0].kind);
    return { kind: 'symbol', symbols: [...own, ...others] };
  }
  return undefined;
}

/** 同じファイル/単位の定義と、引数の数が合うオーバーロードを優先する。 */
export function orderSymbols(symbols: GlobalSymbol[], file: SourceFile, unitIndex: number, argumentCount: number): GlobalSymbol[] {
  const score = (symbol: GlobalSymbol): number => {
    let value = 0;
    if (symbol.file === file) value += symbol.unitIndex === unitIndex ? 4 : 2;
    if (argumentCount >= 0 && symbol.kind === 'function') {
      const min = symbol.node.params.filter((param) => !param.hasDefault).length;
      if (argumentCount >= min && argumentCount <= symbol.node.params.length) value += 8;
    }
    // 関数の宣言(プロトタイプ)より定義を優先する。
    if (symbol.kind === 'function' && symbol.node.bodyStart !== undefined) value += 1;
    return value;
  };
  return symbols
    .map((symbol, order) => ({ symbol, order, score: score(symbol) }))
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map((entry) => entry.symbol);
}

function resolveInDirective(
  workspace: Workspace,
  file: SourceFile,
  unitIndex: number,
  context: AnalysisContext,
  directive: Directive,
  offset: number,
): ResolveResult | undefined {
  const unit = unitIndex >= 0 ? file.units[unitIndex] : undefined;
  const make = (resolution: Resolution, start: number, end: number, name: string): ResolveResult => ({
    resolution,
    context,
    unitIndex,
    start,
    end,
    name,
  });

  if (directive.name === 'include' || directive.name === 'include_with_pragmas') {
    const include = unit?.includes.find((candidate) => candidate.start === directive.start);
    if (include && offset >= include.pathStart - 1 && offset <= include.pathEnd + 1) {
      const resolution = workspace.project.resolve(include.path, file.path);
      return make({ kind: 'include', include, resolution, fromFile: file }, include.pathStart, include.pathEnd, include.path);
    }
    return undefined;
  }

  const tokens = tokenizeRange(file.text, directive.bodyStart, directive.end);
  const token = tokens.find((candidate) => candidate.start <= offset && offset <= candidate.end && candidate.kind === 'ident');
  if (!token) {
    if (offset >= directive.nameStart && offset <= directive.nameEnd) {
      return make({ kind: 'keyword', name: directive.name }, directive.nameStart, directive.nameEnd, directive.name);
    }
    return undefined;
  }

  if (directive.name === 'pragma') {
    const pragmaName = tokens[0]?.value;
    if (token === tokens[0]) return make({ kind: 'keyword', name: token.value }, token.start, token.end, token.value);
    if (pragmaName && FUNCTION_PRAGMAS.has(pragmaName) && token === tokens[1]) {
      const functions = context.lookupKind(token.value, 'function');
      if (functions.length > 0) {
        return make({ kind: 'symbol', symbols: orderSymbols(functions, file, unitIndex, -1) }, token.start, token.end, token.value);
      }
      return make({ kind: 'unresolved', name: token.value }, token.start, token.end, token.value);
    }
    return undefined;
  }

  if (directive.name === 'define' && token === tokens[0]) {
    const own = unit?.macros.find((macro) => macro.nameStart === token.start);
    if (own) {
      const symbols = context.lookupKind(token.value, 'macro');
      const self = symbols.find((symbol) => symbol.node === own);
      const ordered = self ? [self, ...symbols.filter((symbol) => symbol !== self)] : symbols;
      if (ordered.length > 0) return make({ kind: 'symbol', symbols: ordered }, token.start, token.end, token.value);
    }
  }

  if (directive.name === 'define') {
    // マクロ引数
    const macro = unit?.macros.find((candidate) => candidate.start === directive.start);
    if (macro?.params?.includes(token.value)) {
      return make({ kind: 'keyword', name: token.value }, token.start, token.end, token.value);
    }
  }

  const symbols = context.lookup(token.value);
  if (symbols.length > 0) {
    return make({ kind: 'symbol', symbols: orderSymbols(symbols, file, unitIndex, -1) }, token.start, token.end, token.value);
  }
  if (isBuiltinType(token.value)) return make({ kind: 'builtinType', name: token.value }, token.start, token.end, token.value);
  const intrinsic = INTRINSICS[token.value];
  if (intrinsic) return make({ kind: 'intrinsic', name: token.value, info: intrinsic }, token.start, token.end, token.value);
  return make({ kind: 'unresolved', name: token.value }, token.start, token.end, token.value);
}

/** 参照検索で同一の対象かを判定するためのキー。 */
export function resolutionKey(resolution: Resolution): string | undefined {
  switch (resolution.kind) {
    case 'local':
      return `local:${resolution.file.key}:${resolution.variable.nameStart}`;
    case 'symbol': {
      const symbol = resolution.symbols[0];
      if (!symbol) return undefined;
      // 条件コンパイルで複数定義される場合もあるため、種類と名前で同一視する。
      const kind = symbol.kind === 'variable' ? 'variable' : symbol.kind;
      return `${kind}:${symbol.name}`;
    }
    case 'field':
      return `field:${resolution.struct.name}.${resolution.field.name}`;
    case 'property':
      return `variable:${resolution.property.name}`;
    default:
      return undefined;
  }
}
