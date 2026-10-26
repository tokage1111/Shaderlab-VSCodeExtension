import { HlslFunction, HlslVariable } from '../parser/ast';
import { isIdentifierText } from '../parser/lexer';
import { Token } from '../parser/lexer';
import {
  formatNumericType,
  getObjectMethods,
  INTRINSICS,
  isBuiltinType,
  MethodInfo,
  NumericType,
  parseNumericType,
} from './builtins';
import { AnalysisContext } from './context';
import { findLocal } from './scope';
import { SourceFile, SymbolOfKind } from './sourceFile';

export interface TypeRef {
  /** 型名(テンプレート引数を含む)。 */
  name: string;
  arrayDims: number;
  /** 条件コンパイル等で複数の型があり得る(代表として成分数の多いものを保持する)。 */
  ambiguous?: boolean;
}

export interface ResolvedType {
  /** エイリアス解決後の型名。 */
  text: string;
  /** テンプレート引数を除いた型名。 */
  base: string;
  template?: string;
  numeric?: NumericType;
  arrayDims: number;
}

export type MemberResult =
  | { kind: 'field'; struct: SymbolOfKind<'struct'>; field: HlslVariable; type: TypeRef }
  | { kind: 'swizzle'; type: TypeRef }
  | { kind: 'method'; method: MethodInfo; objectType: ResolvedType }
  | { kind: 'structMethod'; struct: SymbolOfKind<'struct'>; fn: HlslFunction }
  /** メンバーが存在しない(確定)。 */
  | { kind: 'missing'; message: string; severity: 'error' | 'warning' }
  /** 型が不明などで判定できない。 */
  | { kind: 'unknown' };

const SWIZZLE_SETS = ['xyzw', 'rgba'];

/**
 * 式の型を推論する。完全な型検査ではなく、メンバーアクセスや補完に必要な範囲に限る。
 */
export class TypeEvaluator {
  private readonly tokens: Token[];
  private readonly minIndex: number;
  private readonly maxIndex: number;

  public constructor(
    private readonly context: AnalysisContext,
    private readonly file: SourceFile,
    private readonly unitIndex: number,
  ) {
    this.tokens = file.tokens;
    const unit = file.units[unitIndex];
    this.minIndex = unit?.tokenStart ?? 0;
    this.maxIndex = (unit?.tokenEnd ?? this.tokens.length) - 1;
  }

  /* -------------------------------------------------------------------------
   * 型名の正規化
   * ----------------------------------------------------------------------- */

  public resolve(type: TypeRef): ResolvedType {
    let text = this.context.resolveTypeAlias(stripQualifiers(type.name));
    // vector<float, 3> / matrix<float, 4, 4>
    const generic = /^(vector|matrix)<(\w+),(\d)(?:,(\d))?>$/.exec(text);
    if (generic) {
      text = generic[1] === 'vector' ? `${generic[2]}${generic[3]}` : `${generic[2]}${generic[3]}x${generic[4] ?? generic[3]}`;
    }
    const angle = text.indexOf('<');
    const base = angle >= 0 ? text.substring(0, angle) : text;
    const template = angle >= 0 ? text.substring(angle + 1, text.lastIndexOf('>')) : undefined;
    let numeric = parseNumericType(base);
    if (!numeric && /^real([1-4](x[1-4])?)?$/.test(base)) {
      // URPの real 型(マクロ定義が見つからない場合)
      numeric = parseNumericType(base.replace(/^real/, 'float'));
    }
    if (numeric?.scalar === 'fixed') numeric = { ...numeric, scalar: 'half' };
    return { text, base, template, numeric, arrayDims: type.arrayDims };
  }

  public findStructs(typeName: string): SymbolOfKind<'struct'>[] {
    const resolved = this.resolve({ name: typeName, arrayDims: 0 });
    const structs = this.context.lookupKind(resolved.base, 'struct');
    // 同じファイルの定義を優先する。
    return structs.sort((a, b) => Number(b.file === this.file) - Number(a.file === this.file));
  }

  /* -------------------------------------------------------------------------
   * 式
   * ----------------------------------------------------------------------- */

  /** endIndexで終わる後置式(`a.b[1].c` / `Foo().x`)の先頭トークンindex。式でなければ-1。 */
  public chainStart(endIndex: number): number {
    let i = endIndex;
    for (let guard = 0; guard < 256 && i >= this.minIndex; guard++) {
      const token = this.tokens[i];
      if (token.kind === 'ident' || token.kind === 'number') {
        if (i - 1 >= this.minIndex && this.tokens[i - 1].value === '.') {
          i -= 2;
          continue;
        }
        return i;
      }
      if (token.value === ']') {
        const open = this.matchBackward(i);
        if (open < 0) return -1;
        i = open - 1;
        continue;
      }
      if (token.value === ')') {
        const open = this.matchBackward(i);
        if (open < 0) return -1;
        const callee = this.tokens[open - 1];
        if (open - 1 >= this.minIndex && callee?.kind === 'ident' && !CONTROL_WORDS.has(callee.value)) {
          i = open - 1;
          // 呼び出し名の前に `.` があればメソッド呼び出しとして連鎖を続ける。
          if (i - 1 >= this.minIndex && this.tokens[i - 1].value === '.') {
            i -= 2;
            continue;
          }
          return i;
        }
        return open;
      }
      return -1;
    }
    return -1;
  }

  /** [start, end] の後置式の型。 */
  public evaluateChain(start: number, end: number): TypeRef | undefined {
    let i = start;
    const first = this.tokens[i];
    let type: TypeRef | undefined;
    if (!first) return undefined;
    if (first.kind === 'ident') {
      if (i + 1 <= end && this.tokens[i + 1].value === '(') {
        const close = this.matchForward(i + 1);
        if (close < 0) return undefined;
        type = this.callType(first.value, i + 1, close);
        i = close + 1;
      } else {
        type = this.identifierType(first.value, first.start);
        i++;
      }
    } else if (first.kind === 'number') {
      type = literalType(first.value);
      i++;
    } else if (first.value === '(') {
      const close = this.matchForward(i);
      if (close < 0) return undefined;
      type = this.evaluateExpression(i + 1, close);
      i = close + 1;
    } else {
      return undefined;
    }

    let ambiguous = type?.ambiguous ?? false;
    while (type && i <= end) {
      if (type.ambiguous) ambiguous = true;
      const token = this.tokens[i];
      if (token.value === '[') {
        const close = this.matchForward(i);
        if (close < 0) return undefined;
        type = this.indexType(type);
        i = close + 1;
        continue;
      }
      if (token.value === '.') {
        const member = this.tokens[i + 1];
        if (!member || member.kind !== 'ident') return undefined;
        if (i + 2 <= end && this.tokens[i + 2].value === '(') {
          const close = this.matchForward(i + 2);
          const method = this.memberOf(type, member.value);
          type =
            method.kind === 'method'
              ? this.methodReturnType(method)
              : method.kind === 'structMethod'
                ? { name: method.fn.returnType, arrayDims: 0 }
                : undefined;
          i = close + 1;
          continue;
        }
        const result = this.memberOf(type, member.value);
        // スウィズルの結果は元の型が曖昧でも成分数が確定する。
        if (result.kind === 'swizzle') ambiguous = false;
        type = result.kind === 'field' || result.kind === 'swizzle' ? result.type : undefined;
        i += 2;
        continue;
      }
      break;
    }
    if (type && (ambiguous || type.ambiguous)) return { ...type, ambiguous: true };
    return type;
  }

  /** [from, to) の式の型。二項演算・キャスト・三項演算子をおおまかに扱う。 */
  public evaluateExpression(from: number, to: number): TypeRef | undefined {
    if (from >= to) return undefined;
    // 三項演算子: 結果は ? の後ろの式
    const question = this.findTopLevel(from, to, (value) => value === '?');
    if (question >= 0) {
      const colon = this.findTopLevel(question + 1, to, (value) => value === ':');
      return this.evaluateExpression(question + 1, colon >= 0 ? colon : to);
    }
    const operands: Array<[number, number]> = [];
    let comparison = false;
    let operandStart = from;
    let depth = 0;
    for (let i = from; i < to; i++) {
      const value = this.tokens[i].value;
      if (value === '(' || value === '[' || value === '{') depth++;
      else if (value === ')' || value === ']' || value === '}') depth--;
      else if (depth === 0 && BINARY_OPERATORS.has(value) && i > operandStart && !this.isUnaryPosition(i)) {
        if (COMPARISON_OPERATORS.has(value)) comparison = true;
        operands.push([operandStart, i]);
        operandStart = i + 1;
      } else if (depth === 0 && ASSIGNMENT_OPERATORS.has(value)) {
        return undefined;
      }
    }
    operands.push([operandStart, to]);
    let result: TypeRef | undefined;
    let resultSize = -1;
    let ambiguous = false;
    for (const [a, b] of operands) {
      const type = this.evaluateOperand(a, b);
      if (!type) return undefined;
      if (type.ambiguous) ambiguous = true;
      const resolved = this.resolve(type);
      const size = resolved.numeric ? resolved.numeric.rows * Math.max(1, resolved.numeric.columns) : 100;
      if (size > resultSize) {
        result = type;
        resultSize = size;
      }
    }
    if (comparison && result) {
      const numeric = this.resolve(result).numeric;
      return { name: numeric ? formatNumericType({ ...numeric, scalar: 'bool' }) : 'bool', arrayDims: 0, ambiguous };
    }
    return result && ambiguous ? { ...result, ambiguous } : result;
  }

  private evaluateOperand(from: number, to: number): TypeRef | undefined {
    // 単項演算子
    while (from < to && ['-', '+', '!', '~', '++', '--'].includes(this.tokens[from].value)) from++;
    if (from >= to) return undefined;
    const first = this.tokens[from];
    // キャスト `(float3)x`
    if (first.value === '(') {
      const close = this.matchForward(from);
      if (close < 0 || close >= to) return undefined;
      if (close + 1 < to && this.isTypeExpression(from + 1, close)) {
        return { name: this.tokenText(from + 1, close), arrayDims: 0 };
      }
    }
    if (first.kind === 'ident' && (first.value === 'true' || first.value === 'false') && to - from === 1) {
      return { name: 'bool', arrayDims: 0 };
    }
    if (this.chainStart(to - 1) === from) {
      return this.evaluateChain(from, to - 1);
    }
    return undefined;
  }

  private isTypeExpression(from: number, to: number): boolean {
    if (to - from !== 1) return false;
    const token = this.tokens[from];
    if (token.kind !== 'ident') return false;
    if (isBuiltinType(token.value)) return true;
    const symbols = this.context.lookup(token.value);
    return symbols.some((symbol) => symbol.kind === 'struct' || symbol.kind === 'typedef' || symbol.kind === 'macro');
  }

  private isUnaryPosition(index: number): boolean {
    const previous = this.tokens[index - 1];
    if (!previous) return true;
    return previous.kind === 'punct' && previous.value !== ')' && previous.value !== ']';
  }

  private findTopLevel(from: number, to: number, predicate: (value: string) => boolean): number {
    let depth = 0;
    for (let i = from; i < to; i++) {
      const value = this.tokens[i].value;
      if (value === '(' || value === '[' || value === '{') depth++;
      else if (value === ')' || value === ']' || value === '}') depth--;
      else if (depth === 0 && predicate(value)) return i;
    }
    return -1;
  }

  /* -------------------------------------------------------------------------
   * 識別子・呼び出し
   * ----------------------------------------------------------------------- */

  public identifierType(name: string, offset: number): TypeRef | undefined {
    const local = findLocal(this.file, this.unitIndex, name, offset);
    if (local) return { name: local.variable.type, arrayDims: local.variable.arrayDims };
    const variables = this.context.lookupKind(name, 'variable');
    if (variables.length > 0) {
      return this.pickWidest(variables.map((symbol) => ({ name: symbol.node.type, arrayDims: symbol.node.arrayDims })));
    }
    return undefined;
  }

  /** 関数呼び出し/コンストラクタ/組み込み関数の戻り値型。 */
  public callType(name: string, open: number, close: number): TypeRef | undefined {
    const args = this.splitArguments(open, close);
    const functions = this.context.lookupKind(name, 'function');
    if (functions.length > 0) {
      const count = this.countArguments(args);
      const matching = functions.filter((symbol) => {
        const min = symbol.node.params.filter((param) => !param.hasDefault).length;
        return count >= min && count <= symbol.node.params.length;
      });
      const candidates = matching.length > 0 ? matching : functions;
      return this.pickWidest(candidates.map((symbol) => ({ name: symbol.node.returnType, arrayDims: 0 })));
    }
    if (isBuiltinType(name)) return { name, arrayDims: 0 };
    const alias = this.context.resolveTypeAlias(name);
    if (alias !== name && isBuiltinType(alias.replace(/<.*$/, ''))) return { name: alias, arrayDims: 0 };
    const intrinsic = INTRINSICS[name];
    if (intrinsic) return this.intrinsicReturnType(intrinsic.returns, args);
    return undefined;
  }

  private intrinsicReturnType(rule: string, args: Array<[number, number]>): TypeRef | undefined {
    let ambiguous = false;
    const result = this.intrinsicReturnTypeOf(rule, args, () => (ambiguous = true));
    return result && ambiguous ? { ...result, ambiguous } : result;
  }

  private intrinsicReturnTypeOf(rule: string, args: Array<[number, number]>, markAmbiguous: () => void): TypeRef | undefined {
    const argType = (index: number): ResolvedType | undefined => {
      const arg = args[index];
      if (!arg) return undefined;
      const type = this.evaluateExpression(arg[0], arg[1]);
      if (type?.ambiguous) markAmbiguous();
      return type ? this.resolve(type) : undefined;
    };
    const widest = (): ResolvedType | undefined => {
      let best: ResolvedType | undefined;
      for (let i = 0; i < args.length; i++) {
        const type = argType(i);
        if (!type?.numeric) continue;
        const size = type.numeric.rows * Math.max(1, type.numeric.columns);
        const bestSize = best?.numeric ? best.numeric.rows * Math.max(1, best.numeric.columns) : -1;
        // 整数リテラルより浮動小数点を優先する。
        if (size > bestSize || (size === bestSize && best?.numeric?.scalar === 'int' && type.numeric.scalar !== 'int')) {
          best = type;
        }
      }
      return best;
    };
    let match: RegExpExecArray | null;
    if ((match = /^arg(\d)$/.exec(rule))) {
      const type = widest() ?? argType(Number(match[1]));
      return type ? { name: type.text, arrayDims: 0 } : undefined;
    }
    if ((match = /^scalar(\d)$/.exec(rule))) {
      const type = argType(Number(match[1]));
      return { name: type?.numeric?.scalar ?? 'float', arrayDims: 0 };
    }
    if ((match = /^bool(\d)$/.exec(rule))) {
      const type = argType(Number(match[1]));
      return { name: type?.numeric ? formatNumericType({ ...type.numeric, scalar: 'bool' }) : 'bool', arrayDims: 0 };
    }
    if (rule === 'mul') {
      const a = argType(0)?.numeric;
      const b = argType(1)?.numeric;
      if (!a || !b) return undefined;
      const scalar = a.scalar === 'half' && b.scalar === 'half' ? 'half' : a.columns > 0 ? a.scalar : b.scalar;
      if (a.columns > 0 && b.columns > 0) return { name: `${scalar}${a.rows}x${b.columns}`, arrayDims: 0 };
      if (a.columns > 0) return { name: formatNumericType({ scalar, rows: a.rows, columns: 0 }), arrayDims: 0 };
      if (b.columns > 0) return { name: formatNumericType({ scalar, rows: b.columns, columns: 0 }), arrayDims: 0 };
      return { name: a.rows >= b.rows ? formatNumericType(a) : formatNumericType(b), arrayDims: 0 };
    }
    if (rule === 'transpose') {
      const a = argType(0)?.numeric;
      if (!a || a.columns === 0) return undefined;
      return { name: `${a.scalar}${a.columns}x${a.rows}`, arrayDims: 0 };
    }
    return { name: rule, arrayDims: 0 };
  }

  public splitArguments(open: number, close: number): Array<[number, number]> {
    const args: Array<[number, number]> = [];
    if (close <= open + 1) return args;
    let start = open + 1;
    let depth = 0;
    for (let i = open + 1; i < close; i++) {
      const value = this.tokens[i].value;
      if (value === '(' || value === '[' || value === '{') depth++;
      else if (value === ')' || value === ']' || value === '}') depth--;
      else if (value === ',' && depth === 0) {
        args.push([start, i]);
        start = i + 1;
      }
    }
    args.push([start, close]);
    return args;
  }

  /**
   * 引数の数。`TEXTURE2D_ARGS(tex, samp)` のように複数の引数へ展開されるマクロを考慮する。
   */
  public countArguments(args: Array<[number, number]>): number {
    let count = 0;
    for (const [from, to] of args) {
      const first = this.tokens[from];
      if (first?.kind === 'ident' && /_ARGS$/.test(first.value) && this.tokens[from + 1]?.value === '(') {
        const close = this.matchForward(from + 1);
        if (close === to - 1) {
          count += Math.max(1, this.splitArguments(from + 1, close).length);
          continue;
        }
      }
      count++;
    }
    return count;
  }

  /* -------------------------------------------------------------------------
   * メンバー
   * ----------------------------------------------------------------------- */

  public indexType(type: TypeRef): TypeRef | undefined {
    if (type.arrayDims > 0) return { name: type.name, arrayDims: type.arrayDims - 1 };
    const resolved = this.resolve(type);
    if (resolved.numeric) {
      const numeric = resolved.numeric;
      if (numeric.columns > 0) {
        return { name: formatNumericType({ scalar: numeric.scalar, rows: numeric.columns, columns: 0 }), arrayDims: 0 };
      }
      return { name: numeric.scalar, arrayDims: 0 };
    }
    if (resolved.template !== undefined) {
      const element = resolved.template.split(',')[0];
      return { name: element, arrayDims: 0 };
    }
    if (/Texture|Buffer$/.test(resolved.base)) return { name: 'float4', arrayDims: 0 };
    return undefined;
  }

  public memberOf(type: TypeRef, member: string): MemberResult {
    const resolved = this.resolve(type);
    if (resolved.arrayDims > 0) {
      return { kind: 'missing', message: `配列 '${type.name}[]' にメンバー '${member}' はありません。`, severity: 'error' };
    }
    if (resolved.numeric) {
      return this.swizzle(resolved.numeric, member, resolved.text);
    }
    const methods = getObjectMethods(resolved.base);
    if (methods) {
      const method = methods[member];
      if (method) return { kind: 'method', method, objectType: resolved };
      return { kind: 'missing', message: `型 '${resolved.text}' にメソッド '${member}' はありません。`, severity: 'error' };
    }
    let structName = resolved.base;
    if ((resolved.base === 'ConstantBuffer' || resolved.base === 'TextureBuffer') && resolved.template) {
      structName = resolved.template;
    }
    const structs = this.findStructs(structName);
    if (structs.length === 0) return { kind: 'unknown' };
    for (const struct of structs) {
      const fields = struct.node.fields.filter((candidate) => candidate.name === member);
      if (fields.length > 0) {
        // #if の分岐ごとに型が異なるメンバー(half3/half4 等)は曖昧な型として扱う。
        const others = structs
          .filter((candidate) => candidate !== struct && candidate.name === struct.name)
          .flatMap((candidate) => candidate.node.fields.filter((f) => f.name === member));
        const type = this.pickWidest([...fields, ...others].map((f) => ({ name: f.type, arrayDims: f.arrayDims })));
        return { kind: 'field', struct, field: fields[0], type };
      }
      const fn = struct.node.methods.find((candidate) => candidate.name === member);
      if (fn) return { kind: 'structMethod', struct, fn };
    }
    // `output.GBUFFER_SHADOWMASK` のようにメンバー名がマクロの場合は展開して再検索する。
    const macro = this.context.lookupKind(member, 'macro').find((symbol) => !symbol.node.params);
    if (macro) {
      const body = macro.node.body.trim();
      if (isIdentifierText(body) && body !== member) return this.memberOf(type, body);
      return { kind: 'unknown' };
    }
    if (structs.some((struct) => struct.node.hasUnknownMembers)) return { kind: 'unknown' };
    const caseInsensitive = structs[0].node.fields.find((field) => field.name.toLowerCase() === member.toLowerCase());
    const hint = caseInsensitive ? ` ('${caseInsensitive.name}' のことですか?)` : '';
    return {
      kind: 'missing',
      message: `構造体 '${structs[0].name}' にメンバー '${member}' はありません。${hint}`,
      severity: 'error',
    };
  }

  /** 候補の型が複数ある場合、成分数が最も多いものを代表とし曖昧として印を付ける。 */
  private pickWidest(types: TypeRef[]): TypeRef {
    if (types.length === 1) return types[0];
    const distinct = new Map<string, TypeRef>();
    for (const type of types) distinct.set(`${this.resolve(type).text}[${type.arrayDims}]`, type);
    if (distinct.size === 1) return types[0];
    let best = types[0];
    let bestSize = -1;
    for (const type of distinct.values()) {
      const numeric = this.resolve(type).numeric;
      const size = numeric ? numeric.rows * Math.max(1, numeric.columns) : 0;
      if (size > bestSize) {
        best = type;
        bestSize = size;
      }
    }
    return { ...best, ambiguous: true };
  }

  private swizzle(numeric: NumericType, member: string, typeText: string): MemberResult {
    if (numeric.columns > 0) {
      const zeroBased = /^(_m[0-3][0-3])+$/.test(member);
      const oneBased = /^(_[1-4][1-4])+$/.test(member);
      if (!zeroBased && !oneBased) {
        return { kind: 'missing', message: `行列 '${typeText}' に成分 '${member}' はありません。(_m00 / _11 形式で指定します)`, severity: 'error' };
      }
      const parts = member.match(zeroBased ? /_m(\d)(\d)/g : /_(\d)(\d)/g) ?? [];
      for (const part of parts) {
        const digits = part.replace(/\D/g, '');
        const row = Number(digits[0]) - (zeroBased ? 0 : 1);
        const column = Number(digits[1]) - (zeroBased ? 0 : 1);
        if (row >= numeric.rows || column >= numeric.columns) {
          return { kind: 'missing', message: `行列 '${typeText}' の範囲外の成分 '${part}' です。`, severity: 'error' };
        }
      }
      if (parts.length > 4) return { kind: 'missing', message: '成分は4つまでしか指定できません。', severity: 'error' };
      return { kind: 'swizzle', type: { name: formatNumericType({ scalar: numeric.scalar, rows: parts.length, columns: 0 }), arrayDims: 0 } };
    }
    if (member.length > 4) {
      return { kind: 'missing', message: `型 '${typeText}' にメンバー '${member}' はありません。`, severity: 'error' };
    }
    const set = SWIZZLE_SETS.find((candidate) => candidate.includes(member[0]));
    if (!set || ![...member].every((character) => SWIZZLE_SETS.some((candidate) => candidate.includes(character)))) {
      return { kind: 'missing', message: `型 '${typeText}' にメンバー '${member}' はありません。`, severity: 'error' };
    }
    if (![...member].every((character) => set.includes(character))) {
      return { kind: 'missing', message: `スウィズル '${member}' で xyzw と rgba の成分を混在させることはできません。`, severity: 'error' };
    }
    const size = Math.max(1, numeric.rows);
    for (const character of member) {
      if (set.indexOf(character) >= size) {
        return { kind: 'missing', message: `型 '${typeText}' に成分 '${character}' はありません(${size}成分)。`, severity: 'error' };
      }
    }
    return { kind: 'swizzle', type: { name: formatNumericType({ scalar: numeric.scalar, rows: member.length, columns: 0 }), arrayDims: 0 } };
  }

  private methodReturnType(result: Extract<MemberResult, { kind: 'method' }>): TypeRef | undefined {
    const returns = result.method.returns;
    if (returns === 'void') return { name: 'void', arrayDims: 0 };
    if (returns === 'element') {
      const template = result.objectType.template?.split(',')[0];
      return { name: template ?? 'float4', arrayDims: 0 };
    }
    return { name: returns, arrayDims: 0 };
  }

  /* -------------------------------------------------------------------------
   * 括弧
   * ----------------------------------------------------------------------- */

  public matchForward(open: number): number {
    const openValue = this.tokens[open]?.value;
    const closeValue = openValue === '(' ? ')' : openValue === '[' ? ']' : '}';
    let depth = 0;
    for (let i = open; i <= this.maxIndex; i++) {
      const value = this.tokens[i].value;
      if (value === openValue) depth++;
      else if (value === closeValue) {
        depth--;
        if (depth === 0) return i;
      } else if (value === ';' && openValue !== '{') {
        return -1;
      }
    }
    return -1;
  }

  public matchBackward(close: number): number {
    const closeValue = this.tokens[close]?.value;
    const openValue = closeValue === ')' ? '(' : closeValue === ']' ? '[' : '{';
    let depth = 0;
    for (let i = close; i >= this.minIndex; i--) {
      const value = this.tokens[i].value;
      if (value === closeValue) depth++;
      else if (value === openValue) {
        depth--;
        if (depth === 0) return i;
      } else if (value === ';' || value === '{' || value === '}') {
        return -1;
      }
    }
    return -1;
  }

  private tokenText(from: number, to: number): string {
    return this.file.text.substring(this.tokens[from].start, this.tokens[to - 1].end).replace(/\s+/g, '');
  }
}

const CONTROL_WORDS = new Set(['if', 'for', 'while', 'switch', 'return', 'else', 'do', 'case']);
const BINARY_OPERATORS = new Set(['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>', '==', '!=', '<', '>', '<=', '>=', '&&', '||']);
const COMPARISON_OPERATORS = new Set(['==', '!=', '<', '>', '<=', '>=', '&&', '||']);
const ASSIGNMENT_OPERATORS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=']);

const QUALIFIER_PATTERN = /\b(const|static|uniform|in|out|inout|volatile|precise|row_major|column_major|nointerpolation|linear|centroid|noperspective|snorm|unorm)\s+/g;

export function stripQualifiers(typeName: string): string {
  return typeName.replace(QUALIFIER_PATTERN, '').replace(/\s+/g, '');
}

export function literalType(value: string): TypeRef {
  if (/^0[xX]/.test(value)) return { name: /[uU]$/.test(value) ? 'uint' : 'int', arrayDims: 0 };
  if (/[hH]$/.test(value)) return { name: 'half', arrayDims: 0 };
  if (/[.eEfF]/.test(value)) return { name: 'float', arrayDims: 0 };
  if (/[uU]/.test(value)) return { name: 'uint', arrayDims: 0 };
  return { name: 'int', arrayDims: 0 };
}
