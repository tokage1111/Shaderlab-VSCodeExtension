import { Diagnostic, DiagnosticSeverity, DiagnosticTag } from 'vscode-languageserver';
import { HlslUnit, ParseIssue } from '../parser/ast';
import { lowerBoundToken, spansContain, Token } from '../parser/lexer';
import { FUNCTION_PRAGMAS, HLSL_KEYWORDS, isCompilerPredefinedMacro, parseNumericType } from '../analysis/builtins';
import { AnalysisContext } from '../analysis/context';
import { resolveToken } from '../analysis/resolver';
import { SourceFile } from '../analysis/sourceFile';
import { TypeEvaluator, TypeRef } from '../analysis/typeEvaluator';
import { Workspace } from '../analysis/workspace';

const SOURCE = 'URP ShaderLab';
const MAX_DIAGNOSTICS = 500;

export type DiagnosticCode =
  | 'syntax'
  | 'include-not-found'
  | 'builtin-include'
  | 'undefined-identifier'
  | 'undefined-function'
  | 'undefined-type'
  | 'property-not-declared'
  | 'unknown-member'
  | 'argument-count'
  | 'pragma-function'
  | 'implicit-conversion'
  | 'implicit-truncation'
  | 'srp-batcher'
  | 'inactive-code';

export async function computeDiagnostics(workspace: Workspace, file: SourceFile): Promise<Diagnostic[]> {
  const settings = workspace.settings.diagnostics;
  const diagnostics: Diagnostic[] = inactiveCodeDiagnostics(file);
  if (!settings.enable) return diagnostics;
  const seen = new Set<string>();
  const add = (start: number, end: number, message: string, severity: DiagnosticSeverity, code: DiagnosticCode): void => {
    const key = `${start}:${end}:${message}`;
    if (seen.has(key) || diagnostics.length >= MAX_DIAGNOSTICS) return;
    seen.add(key);
    diagnostics.push({ range: file.lineIndex.range(start, Math.max(end, start + 1)), message, severity, source: SOURCE, code });
  };
  const addIssue = (issue: ParseIssue): void =>
    add(issue.start, issue.end, issue.message, issue.severity === 'error' ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning, 'syntax');

  for (const error of file.lexResult.errors) add(error.start, error.end, error.message, DiagnosticSeverity.Error, 'syntax');
  file.shader?.issues.forEach(addIssue);

  for (let unitIndex = 0; unitIndex < file.units.length; unitIndex++) {
    const unit = file.units[unitIndex];
    unit.issues.forEach(addIssue);
    const block = file.blockOf(unitIndex);
    if (block?.kind === 'GLSLPROGRAM') continue;
    const context = await workspace.contextForUnit(file, unitIndex);
    if (settings.undefinedIdentifiers && isStandaloneInclude(file, context) && file.tokens.length > 0) {
      add(
        0,
        0,
        'このファイルをincludeしているシェーダーが見つからないため、未定義シンボルの検査を省略しています。Include Treeでrootを固定すると検査できます。',
        DiagnosticSeverity.Hint,
        'undefined-identifier',
      );
    }
    checkIncludes(workspace, file, unit, add);
    // HLSLINCLUDE内の #pragma vertex 等は各パスで定義される関数を指すため検査しない。
    if (block?.kind !== 'HLSLINCLUDE' && block?.kind !== 'CGINCLUDE') checkPragmas(context, unit, add);
    new UnitChecker(workspace, file, unitIndex, context, add).run();
  }

  if (file.isShaderLab && settings.srpBatcher) {
    await checkSrpBatcher(workspace, file, add);
  }
  return diagnostics;
}

/**
 * シェーダー(.shader / .compute)をrootとしない解析単位。
 * include元で先に定義されるシンボルが分からないため、未定義の判定を行わない。
 */
export function isStandaloneInclude(_file: SourceFile, context: AnalysisContext): boolean {
  const root = context.entries[0]?.file;
  if (!root) return true;
  return !root.isShaderLab && !/\.compute$/i.test(root.path);
}

/** 条件が確定して無効になるコード(#if 0 等)。エディタ上でグレーアウト表示される。 */
function inactiveCodeDiagnostics(file: SourceFile): Diagnostic[] {
  return file.lexResult.disabledRanges.map((range) => ({
    range: file.lineIndex.range(range.start, range.end),
    message: `条件 '${range.condition}' により無効なコードです。`,
    severity: DiagnosticSeverity.Hint,
    tags: [DiagnosticTag.Unnecessary],
    source: SOURCE,
    code: 'inactive-code',
  }));
}

type AddDiagnostic = (start: number, end: number, message: string, severity: DiagnosticSeverity, code: DiagnosticCode) => void;

function checkIncludes(workspace: Workspace, file: SourceFile, unit: HlslUnit, add: AddDiagnostic): void {
  for (const include of unit.includes) {
    if (!include.path) continue;
    const resolution = workspace.project.resolve(include.path, file.path);
    if (resolution.status === 'unresolved') {
      if (include.conditional) {
        add(
          include.pathStart,
          include.pathEnd,
          `include ファイル '${include.path}' が見つかりません(#if の条件が有効な場合にエラーになります)。`,
          DiagnosticSeverity.Information,
          'include-not-found',
        );
        continue;
      }
      add(include.pathStart, include.pathEnd, `include ファイル '${include.path}' が見つかりません。`, DiagnosticSeverity.Error, 'include-not-found');
    } else if (resolution.status === 'builtin') {
      add(
        include.pathStart,
        include.pathEnd,
        `'${include.path}' はUnity本体に同梱されるincludeのため解析されません。未定義シンボルの検査は行いません。`,
        DiagnosticSeverity.Hint,
        'builtin-include',
      );
    }
  }
}

function checkPragmas(context: AnalysisContext, unit: HlslUnit, add: AddDiagnostic): void {
  for (const pragma of unit.pragmas) {
    if (!FUNCTION_PRAGMAS.has(pragma.name)) continue;
    const target = pragma.args[0];
    if (!target) {
      add(pragma.nameStart, pragma.nameEnd, `#pragma ${pragma.name} に関数名を指定してください。`, DiagnosticSeverity.Error, 'pragma-function');
      continue;
    }
    if (context.lookupKind(target.value, 'function').length > 0) continue;
    // include先が解析できていない場合は誤検出を避ける。
    if (!context.complete || pragma.name === 'surface') continue;
    add(
      target.start,
      target.end,
      `#pragma ${pragma.name} で指定された関数 '${target.value}' が見つかりません。`,
      DiagnosticSeverity.Error,
      'pragma-function',
    );
  }
}

/** 1つのHLSL単位のトークンを走査して意味的な問題を検出する。 */
class UnitChecker {
  private readonly tokens: Token[];
  private readonly unit: HlslUnit;
  private readonly evaluator: TypeEvaluator;
  /** マクロ呼び出しの引数範囲 [開き括弧index, 閉じ括弧index]。トークン連結等があり得るので未定義判定をしない。 */
  private readonly macroArgumentRanges: Array<[number, number]> = [];
  private readonly checkUndefined: boolean;

  public constructor(
    private readonly workspace: Workspace,
    private readonly file: SourceFile,
    private readonly unitIndex: number,
    private readonly context: AnalysisContext,
    private readonly add: AddDiagnostic,
  ) {
    this.tokens = file.tokens;
    this.unit = file.units[unitIndex];
    this.evaluator = new TypeEvaluator(context, file, unitIndex);
    this.checkUndefined =
      workspace.settings.diagnostics.undefinedIdentifiers && context.complete && !isStandaloneInclude(file, context);
  }

  public run(): void {
    const { tokenStart, tokenEnd } = this.unit;
    for (let index = tokenStart; index < tokenEnd; index++) {
      const token = this.tokens[index];
      if (token.kind === 'punct') {
        if (token.value === '[' && this.isAttributeStart(index)) {
          index = this.evaluator.matchForward(index);
          if (index < 0) return;
          continue;
        }
        if (token.value === '=') this.checkAssignment(index);
        continue;
      }
      if (token.kind !== 'ident') continue;
      if (token.value === 'asm' && this.tokens[index + 1]?.value === '{') {
        // Xbox 360 向けのインラインアセンブリは解析しない。
        index = this.evaluator.matchForward(index + 1);
        if (index < 0) return;
        continue;
      }
      if (HLSL_KEYWORDS.has(token.value)) continue;
      this.checkIdentifier(index);
    }
    this.checkDeclarationInitializers();
  }

  private checkIdentifier(index: number): void {
    const token = this.tokens[index];
    const resolution = resolveToken(this.context, this.file, this.unitIndex, index, this.evaluator);
    const next = this.tokens[index + 1];
    const isCall = next?.value === '(' && index + 1 < this.unit.tokenEnd;

    // 宣言の名前(関数定義の名前等)は呼び出しではない。
    if (this.unit.declarationOffsets.has(token.start) && resolution.kind !== 'unresolved') return;

    switch (resolution.kind) {
      case 'unresolvedMember':
        // マクロ引数はマクロ側で使われない場合があるため判定しない。
        if (resolution.message && !this.isInsideMacroArguments(index)) {
          this.add(token.start, token.end, resolution.message, DiagnosticSeverity.Error, 'unknown-member');
        }
        return;
      case 'unresolved':
        this.reportUndefined(index, isCall);
        return;
      case 'symbol': {
        if (isCall) {
          const close = this.evaluator.matchForward(index + 1);
          const isMacro = resolution.symbols.some((symbol) => symbol.kind === 'macro');
          if (close > 0 && isMacro) this.macroArgumentRanges.push([index + 1, close]);
          if (close > 0 && !isMacro) this.checkFunctionArguments(index, close, resolution.symbols);
        }
        return;
      }
      case 'intrinsic':
      case 'method': {
        if (!isCall) return;
        const close = this.evaluator.matchForward(index + 1);
        if (close < 0) return;
        const info = resolution.kind === 'intrinsic' ? resolution.info : resolution.method;
        const count = this.evaluator.countArguments(this.evaluator.splitArguments(index + 1, close));
        if (count < info.minArgs || count > info.maxArgs) {
          const expected = info.minArgs === info.maxArgs ? `${info.minArgs}` : `${info.minArgs}〜${info.maxArgs}`;
          this.add(
            token.start,
            token.end,
            `'${token.value}' の引数の数が正しくありません(${count}個指定、${expected}個必要)。\n${info.signature}`,
            DiagnosticSeverity.Error,
            'argument-count',
          );
        }
        return;
      }
      default:
        return;
    }
  }

  private reportUndefined(index: number, isCall: boolean): void {
    if (!this.checkUndefined) return;
    const token = this.tokens[index];
    const name = token.value;
    if (isCompilerPredefinedMacro(name) || this.isInsideMacroArguments(index)) return;
    // 引数がマクロで宣言される関数(LIGHTMAP_EXTRA_ARGS 等)では引数名が分からない。
    if (this.file.functionAt(this.unitIndex, token.start)?.paramsIncomplete) return;
    // ラベル `label:` と goto の対象は無視する。
    if (this.tokens[index + 1]?.value === ':' && this.tokens[index - 1]?.value !== '?' && this.isStatementStart(index)) return;
    if (this.tokens[index - 1]?.value === 'goto') return;

    if (isCall) {
      if (/^[A-Z0-9_]+$/.test(name)) {
        // 大文字のみの呼び出しはマクロであることが多い。未定義なら引数の検査も行わない。
        const close = this.evaluator.matchForward(index + 1);
        if (close > 0) this.macroArgumentRanges.push([index + 1, close]);
      }
      this.add(token.start, token.end, `関数またはマクロ '${name}' が見つかりません。`, this.undefinedSeverity(token), 'undefined-function');
      return;
    }
    if (this.unit.declarationOffsets.has(token.start)) {
      this.add(token.start, token.end, `型 '${name}' が見つかりません。`, DiagnosticSeverity.Warning, 'undefined-type');
      return;
    }
    const property = this.file.shader?.properties.find((candidate) => candidate.name === name);
    if (property) {
      this.add(
        token.start,
        token.end,
        `'${name}' はPropertiesで宣言されていますが、HLSL側で変数として宣言されていません。CBUFFER(UnityPerMaterial)等に宣言を追加してください。`,
        DiagnosticSeverity.Warning,
        'property-not-declared',
      );
      return;
    }
    this.add(token.start, token.end, `識別子 '${name}' が見つかりません。`, this.undefinedSeverity(token), 'undefined-identifier');
  }

  /** #if の内側は定義も条件付きの場合が多いため、重要度を下げる。 */
  private undefinedSeverity(token: Token): DiagnosticSeverity {
    return spansContain(this.file.lexResult.conditionalRanges, token.start) ? DiagnosticSeverity.Information : DiagnosticSeverity.Warning;
  }

  private checkFunctionArguments(nameIndex: number, close: number, symbols: ReturnType<AnalysisContext['lookup']>): void {
    const functions = symbols.filter((symbol) => symbol.kind === 'function');
    if (functions.length === 0 || functions.length !== symbols.length) return;
    if (functions.some((symbol) => symbol.kind === 'function' && symbol.node.paramsIncomplete)) return;
    // オーバーロード候補がinclude先に隠れている可能性がある場合は検査しない。
    if (!this.context.complete) return;
    const count = this.evaluator.countArguments(this.evaluator.splitArguments(nameIndex + 1, close));
    const ranges = functions.map((symbol) => {
      if (symbol.kind !== 'function') return [0, 0];
      const max = symbol.node.params.length;
      const min = symbol.node.params.filter((param) => !param.hasDefault).length;
      return [min, max];
    });
    if (ranges.some(([min, max]) => count >= min && count <= max)) return;
    const token = this.tokens[nameIndex];
    const expected = Array.from(new Set(ranges.map(([min, max]) => (min === max ? `${min}` : `${min}〜${max}`)))).join(' / ');
    this.add(
      token.start,
      token.end,
      `関数 '${token.value}' の引数の数が一致しません(${count}個指定、${expected}個必要)。`,
      DiagnosticSeverity.Error,
      'argument-count',
    );
  }

  /* -------------------------------------------------------------------------
   * 暗黙の型変換
   * ----------------------------------------------------------------------- */

  private checkDeclarationInitializers(): void {
    const check = (type: string, arrayDims: number, initStart: number | undefined, initEnd: number | undefined, nameStart: number, nameEnd: number): void => {
      if (initStart === undefined || initEnd === undefined || arrayDims > 0) return;
      const from = lowerBoundToken(this.tokens, initStart);
      const to = lowerBoundToken(this.tokens, initEnd);
      if (this.tokens[from]?.value === '{') return;
      const valueType = this.evaluator.evaluateExpression(from, to);
      if (valueType) this.compareVectorSizes({ name: type, arrayDims }, valueType, nameStart, nameEnd);
    };
    for (const fn of this.unit.functions) {
      for (const local of fn.locals) check(local.type, local.arrayDims, local.initStart, local.initEnd, local.nameStart, local.nameEnd);
    }
    for (const global of this.unit.globals) {
      check(global.type, global.arrayDims, global.initStart, global.initEnd, global.nameStart, global.nameEnd);
    }
  }

  /** `a = b;` 形式の代入文。 */
  private checkAssignment(index: number): void {
    const lhsStart = this.evaluator.chainStart(index - 1);
    if (lhsStart < 0) return;
    const before = this.tokens[lhsStart - 1]?.value;
    if (before !== ';' && before !== '{' && before !== '}' && before !== ')') return;
    // 宣言の初期化子は別途検査する。
    if (this.unit.declarationOffsets.has(this.tokens[index - 1].start)) return;
    let end = index + 1;
    let depth = 0;
    for (; end < this.unit.tokenEnd; end++) {
      const value = this.tokens[end].value;
      if (value === '(' || value === '[' || value === '{') depth++;
      else if (value === ')' || value === ']' || value === '}') {
        if (depth === 0) return;
        depth--;
      } else if (depth === 0 && (value === ';' || value === ',')) break;
    }
    const target = this.evaluator.evaluateChain(lhsStart, index - 1);
    if (!target) return;
    const valueType = this.evaluator.evaluateExpression(index + 1, end);
    if (!valueType) return;
    this.compareVectorSizes(target, valueType, this.tokens[lhsStart].start, this.tokens[index - 1].end);
  }

  private compareVectorSizes(target: TypeRef, value: TypeRef, start: number, end: number): void {
    if (target.arrayDims > 0 || value.arrayDims > 0 || target.ambiguous || value.ambiguous) return;
    const targetType = this.evaluator.resolve(target);
    const valueType = this.evaluator.resolve(value);
    const t = targetType.numeric ?? parseNumericType(targetType.base);
    const v = valueType.numeric ?? parseNumericType(valueType.base);
    if (!t || !v || t.columns > 0 || v.columns > 0) return;
    if (v.rows === 1 || t.rows === v.rows) return;
    if (t.rows > v.rows) {
      this.add(
        start,
        end,
        `'${valueType.text}' から '${targetType.text}' へは暗黙に変換できません(成分数が不足しています)。`,
        DiagnosticSeverity.Error,
        'implicit-conversion',
      );
    } else {
      this.add(
        start,
        end,
        `'${valueType.text}' から '${targetType.text}' への暗黙の切り捨てが発生します。必要な成分をスウィズルで明示してください。`,
        DiagnosticSeverity.Warning,
        'implicit-truncation',
      );
    }
  }

  /* -------------------------------------------------------------------------
   * 補助
   * ----------------------------------------------------------------------- */

  private isAttributeStart(index: number): boolean {
    const previous = index > this.unit.tokenStart ? this.tokens[index - 1].value : ';';
    if (previous !== ';' && previous !== '{' && previous !== '}' && previous !== ')' && previous !== ']') return false;
    const first = this.tokens[index + 1];
    return first?.kind === 'ident' && (this.tokens[index + 2]?.value === ']' || this.tokens[index + 2]?.value === '(');
  }

  private isStatementStart(index: number): boolean {
    const previous = index > this.unit.tokenStart ? this.tokens[index - 1].value : ';';
    return previous === ';' || previous === '{' || previous === '}';
  }

  private isInsideMacroArguments(index: number): boolean {
    for (const [open, close] of this.macroArgumentRanges) {
      if (index > open && index < close) return true;
    }
    return false;
  }
}

/* ---------------------------------------------------------------------------
 * SRP Batcher
 * ------------------------------------------------------------------------- */

const TEXTURE_PROPERTY_TYPES = new Set(['2D', '3D', 'Cube', '2DArray', 'CubeArray', 'Any', 'Rect']);

async function checkSrpBatcher(workspace: Workspace, file: SourceFile, add: AddDiagnostic): Promise<void> {
  const shader = file.shader;
  if (!shader || shader.properties.length === 0) return;
  const programs = shader.blocks
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => block.kind === 'HLSLPROGRAM' || block.kind === 'CGPROGRAM');
  if (programs.length === 0) return;

  const layouts: Array<{ signature: string; start: number; end: number }> = [];
  const notInBuffer = new Map<string, number>();
  let anyBuffer = false;
  for (const { index } of programs) {
    const context = await workspace.contextForUnit(file, index);
    const buffers = context.lookupKind('UnityPerMaterial', 'cbuffer');
    if (buffers.length === 0) continue;
    anyBuffer = true;
    const buffer = buffers[0];
    const fields = new Set(buffers.flatMap((candidate) => candidate.node.fields.map((field) => field.name)));
    layouts.push({
      signature: buffer.node.fields.map((field) => `${field.type} ${field.name}`).join(';'),
      start: buffer.file === file ? buffer.node.nameStart : file.blockOf(index)!.start,
      end: buffer.file === file ? buffer.node.nameEnd : file.blockOf(index)!.start + file.blockOf(index)!.kind.length,
    });
    for (const property of shader.properties) {
      if (TEXTURE_PROPERTY_TYPES.has(property.typeKind) || fields.has(property.name)) continue;
      // HLSL側で(cbuffer外に)宣言されているプロパティだけが対象。
      const declared = context.lookupKind(property.name, 'variable').some((symbol) => !symbol.container || symbol.container.name !== 'UnityPerMaterial');
      if (declared) notInBuffer.set(property.name, (notInBuffer.get(property.name) ?? 0) + 1);
    }
  }
  if (!anyBuffer) return;

  for (const property of shader.properties) {
    if (!notInBuffer.has(property.name)) continue;
    add(
      property.nameStart,
      property.nameEnd,
      `SRP Batcher: プロパティ '${property.name}' が CBUFFER_START(UnityPerMaterial) の外で宣言されているため、SRP Batcherと互換性がありません。`,
      DiagnosticSeverity.Information,
      'srp-batcher',
    );
  }
  const first = layouts[0];
  for (const layout of layouts.slice(1)) {
    if (layout.signature !== first.signature) {
      add(
        layout.start,
        layout.end,
        'SRP Batcher: UnityPerMaterial の内容がパスごとに異なります。すべてのパスで同じ内容にしてください。',
        DiagnosticSeverity.Warning,
        'srp-batcher',
      );
    }
  }
}
