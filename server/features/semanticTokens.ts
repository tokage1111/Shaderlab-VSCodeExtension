import { SemanticTokens, SemanticTokensBuilder, SemanticTokensLegend } from 'vscode-languageserver';
import { FUNCTION_PRAGMAS, HLSL_KEYWORDS } from '../analysis/builtins';
import { Resolution, resolveToken } from '../analysis/resolver';
import { SourceFile } from '../analysis/sourceFile';
import { TypeEvaluator } from '../analysis/typeEvaluator';
import { Workspace } from '../analysis/workspace';
import { tokenizeRange } from '../parser/lexer';

export const SEMANTIC_TOKEN_TYPES = [
  'namespace',
  'type',
  'struct',
  'parameter',
  'variable',
  'property',
  'function',
  'method',
  'macro',
  'keyword',
  'enumMember',
] as const;

export const SEMANTIC_TOKEN_MODIFIERS = ['declaration', 'readonly', 'defaultLibrary', 'static'] as const;

export const semanticTokensLegend: SemanticTokensLegend = {
  tokenTypes: [...SEMANTIC_TOKEN_TYPES],
  tokenModifiers: [...SEMANTIC_TOKEN_MODIFIERS],
};

type TokenType = (typeof SEMANTIC_TOKEN_TYPES)[number];
type TokenModifier = (typeof SEMANTIC_TOKEN_MODIFIERS)[number];

interface Entry {
  start: number;
  length: number;
  type: number;
  modifiers: number;
}

function encode(type: TokenType, modifiers: TokenModifier[]): { type: number; modifiers: number } {
  let bits = 0;
  for (const modifier of modifiers) bits |= 1 << SEMANTIC_TOKEN_MODIFIERS.indexOf(modifier);
  return { type: SEMANTIC_TOKEN_TYPES.indexOf(type), modifiers: bits };
}

/** 解決結果に応じて識別子を色分けする(キーワード等の基本的な色はTextMate文法が担当する)。 */
function classify(resolution: Resolution, declaration: boolean): { type: TokenType; modifiers: TokenModifier[] } | undefined {
  const declared: TokenModifier[] = declaration ? ['declaration'] : [];
  switch (resolution.kind) {
    case 'local':
      return { type: resolution.isParameter ? 'parameter' : 'variable', modifiers: declared };
    case 'symbol': {
      const symbol = resolution.symbols[0];
      switch (symbol?.kind) {
        case 'function':
          return { type: 'function', modifiers: declared };
        case 'struct':
          return { type: 'struct', modifiers: declared };
        case 'typedef':
          return { type: 'type', modifiers: declared };
        case 'macro':
          return { type: 'macro', modifiers: declared };
        case 'cbuffer':
          return { type: 'namespace', modifiers: declared };
        case 'variable':
          return { type: 'variable', modifiers: [...declared, 'readonly', 'static'] };
        default:
          return undefined;
      }
    }
    case 'field':
    case 'swizzle':
      return { type: 'property', modifiers: declared };
    case 'method':
      return { type: 'method', modifiers: ['defaultLibrary'] };
    case 'intrinsic':
      return { type: 'function', modifiers: ['defaultLibrary'] };
    case 'builtinType':
      return { type: 'type', modifiers: ['defaultLibrary'] };
    default:
      return undefined;
  }
}

export async function provideSemanticTokens(workspace: Workspace, file: SourceFile): Promise<SemanticTokens> {
  const entries: Entry[] = [];
  const push = (start: number, end: number, type: TokenType, modifiers: TokenModifier[]): void => {
    const encoded = encode(type, modifiers);
    entries.push({ start, length: end - start, ...encoded });
  };

  for (const property of file.shader?.properties ?? []) {
    push(property.nameStart, property.nameEnd, 'property', ['declaration']);
  }

  for (let unitIndex = 0; unitIndex < file.units.length; unitIndex++) {
    const unit = file.units[unitIndex];
    if (file.blockOf(unitIndex)?.kind === 'GLSLPROGRAM') continue;
    const context = await workspace.contextForUnit(file, unitIndex);
    const evaluator = new TypeEvaluator(context, file, unitIndex);
    const tokens = file.tokens;
    for (let index = unit.tokenStart; index < unit.tokenEnd; index++) {
      const token = tokens[index];
      if (token.kind !== 'ident' || HLSL_KEYWORDS.has(token.value)) continue;
      const resolution = resolveToken(context, file, unitIndex, index, evaluator);
      const declaration = unit.declarationOffsets.has(token.start) && isDeclarationName(resolution, token.start);
      const classified = classify(resolution, declaration);
      if (classified) push(token.start, token.end, classified.type, classified.modifiers);
    }

    for (const macro of unit.macros) push(macro.nameStart, macro.nameEnd, 'macro', ['declaration']);
    for (const pragma of unit.pragmas) {
      const target = pragma.args[0];
      if (FUNCTION_PRAGMAS.has(pragma.name) && target && context.lookupKind(target.value, 'function').length > 0) {
        push(target.start, target.end, 'function', []);
      }
    }
    // #if / #ifdef 内のマクロ参照
    for (const directive of file.lexResult.directives) {
      if (directive.start < unit.start || directive.start > unit.end) continue;
      if (!/^(if|elif|ifdef|ifndef|undef)$/.test(directive.name)) continue;
      for (const token of tokenizeRange(file.text, directive.bodyStart, directive.end)) {
        if (token.kind === 'ident' && token.value !== 'defined' && context.lookupKind(token.value, 'macro').length > 0) {
          push(token.start, token.end, 'macro', []);
        }
      }
    }
  }

  entries.sort((a, b) => a.start - b.start);
  const builder = new SemanticTokensBuilder();
  let lastStart = -1;
  for (const entry of entries) {
    if (entry.start === lastStart) continue;
    lastStart = entry.start;
    const position = file.lineIndex.positionAt(entry.start);
    builder.push(position.line, position.character, entry.length, entry.type, entry.modifiers);
  }
  return builder.build();
}

function isDeclarationName(resolution: Resolution, offset: number): boolean {
  switch (resolution.kind) {
    case 'local':
      return resolution.variable.nameStart === offset;
    case 'field':
      return resolution.field.nameStart === offset;
    case 'symbol':
      return resolution.symbols.some((symbol) => symbol.node.nameStart === offset);
    default:
      return false;
  }
}
