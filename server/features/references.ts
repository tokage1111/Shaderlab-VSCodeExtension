import { Location } from 'vscode-languageserver';
import { FUNCTION_PRAGMAS } from '../analysis/builtins';
import { AnalysisContext } from '../analysis/context';
import { resolutionKey, resolveAt, resolveToken } from '../analysis/resolver';
import { SourceFile } from '../analysis/sourceFile';
import { TypeEvaluator } from '../analysis/typeEvaluator';
import { Workspace } from '../analysis/workspace';
import { tokenizeRange } from '../parser/lexer';
import { location } from './definition';

interface Scope {
  file: SourceFile;
  unitIndex: number;
  context: AnalysisContext;
}

/**
 * 参照検索。対象と同じ翻訳単位(rootからのinclude構成)に含まれるファイルを走査し、
 * 名前が一致する識別子を1つずつ解決して同じ対象を指すものだけを返す。
 */
export async function provideReferences(
  workspace: Workspace,
  file: SourceFile,
  offset: number,
  includeDeclaration: boolean,
): Promise<Location[]> {
  const result = await resolveAt(workspace, file, offset);
  if (!result) return [];
  const resolution = result.resolution;
  const key = resolutionKey(resolution);
  if (!key) return [];
  const name = resolution.kind === 'property' ? resolution.property.name : result.name;

  const declarations = new Set<string>();
  switch (resolution.kind) {
    case 'local':
      declarations.add(`${resolution.file.key}:${resolution.variable.nameStart}`);
      break;
    case 'symbol':
      for (const symbol of resolution.symbols) declarations.add(`${symbol.file.key}:${symbol.node.nameStart}`);
      break;
    case 'field':
      declarations.add(`${resolution.struct.file.key}:${resolution.field.nameStart}`);
      break;
    default:
      break;
  }

  const results: Location[] = [];
  const seen = new Set<string>();
  const add = (target: SourceFile, start: number, end: number): void => {
    const id = `${target.key}:${start}`;
    if (seen.has(id)) return;
    if (!includeDeclaration && declarations.has(id)) return;
    seen.add(id);
    results.push(location(workspace, target, start, end));
  };

  // ローカル変数は関数内だけを探す。
  if (resolution.kind === 'local') {
    const fn = resolution.fn;
    scanUnit({ file: resolution.file, unitIndex: result.unitIndex, context: result.context }, name, key, add, fn.start, fn.end);
    return results;
  }

  if (resolution.kind === 'property' || file.shader) {
    for (const property of file.shader?.properties ?? []) {
      if (property.name === name && key === `variable:${name}`) add(file, property.nameStart, property.nameEnd);
    }
  }

  for (const scope of await collectScopes(workspace, file, result.context)) {
    scanUnit(scope, name, key, add);
    scanDirectives(scope, name, key, add);
  }
  return results;
}

async function collectScopes(workspace: Workspace, file: SourceFile, context: AnalysisContext): Promise<Scope[]> {
  const scopes: Scope[] = [];
  const covered = new Set<string>();
  // 現在のファイルのすべての単位(ShaderLabなら全パス)
  for (let unitIndex = 0; unitIndex < file.units.length; unitIndex++) {
    const unitContext = file.isShaderLab ? await workspace.contextForUnit(file, unitIndex) : context;
    scopes.push({ file, unitIndex, context: unitContext });
    for (const entry of unitContext.entries) {
      if (entry.file === file || covered.has(`${entry.file.key}#${entry.unitIndex}`)) continue;
      covered.add(`${entry.file.key}#${entry.unitIndex}`);
      scopes.push({ file: entry.file, unitIndex: entry.unitIndex, context: unitContext });
    }
  }
  // HLSLファイルの場合、root(シェーダー)側のブロックも含める。
  for (const entry of context.entries) {
    const id = `${entry.file.key}#${entry.unitIndex}`;
    if (entry.file === file || covered.has(id)) continue;
    covered.add(id);
    scopes.push({ file: entry.file, unitIndex: entry.unitIndex, context });
  }
  return scopes;
}

function scanUnit(
  scope: Scope,
  name: string,
  key: string,
  add: (file: SourceFile, start: number, end: number) => void,
  from = -Infinity,
  to = Infinity,
): void {
  const { file, unitIndex, context } = scope;
  const unit = file.units[unitIndex];
  if (!unit) return;
  // 名前を含まないファイルは字句を走査しない。
  if (!file.text.includes(name)) return;
  const tokens = file.tokens;
  let evaluator: TypeEvaluator | undefined;
  for (let index = unit.tokenStart; index < unit.tokenEnd; index++) {
    const token = tokens[index];
    if (token.kind !== 'ident' || token.value !== name || token.start < from || token.start > to) continue;
    evaluator ??= new TypeEvaluator(context, file, unitIndex);
    const resolution = resolveToken(context, file, unitIndex, index, evaluator);
    if (resolutionKey(resolution) === key) add(file, token.start, token.end);
  }
}

/** #define の本体や #pragma vertex 等に書かれた参照。 */
function scanDirectives(scope: Scope, name: string, key: string, add: (file: SourceFile, start: number, end: number) => void): void {
  const { file, unitIndex } = scope;
  const unit = file.units[unitIndex];
  if (!unit) return;
  const kind = key.substring(0, key.indexOf(':'));
  if (kind !== 'function' && kind !== 'macro' && kind !== 'variable') return;
  for (const directive of file.lexResult.directives) {
    if (directive.start < unit.start || directive.start > unit.end || directive.inactive) continue;
    if (!file.text.substring(directive.bodyStart, directive.end).includes(name)) continue;
    const tokens = tokenizeRange(file.text, directive.bodyStart, directive.end);
    if (directive.name === 'pragma') {
      if (kind === 'function' && FUNCTION_PRAGMAS.has(tokens[0]?.value ?? '') && tokens[1]?.value === name) {
        add(file, tokens[1].start, tokens[1].end);
      }
      continue;
    }
    if (directive.name === 'define' || directive.name === 'if' || directive.name === 'elif' || directive.name === 'ifdef' || directive.name === 'ifndef') {
      const macroParams = directive.name === 'define' ? unit.macros.find((macro) => macro.start === directive.start)?.params : undefined;
      for (const token of tokens) {
        if (token.kind !== 'ident' || token.value !== name || macroParams?.includes(name)) continue;
        if (directive.name === 'define' && token === tokens[0] && kind !== 'macro') continue;
        add(file, token.start, token.end);
      }
    }
  }
}
