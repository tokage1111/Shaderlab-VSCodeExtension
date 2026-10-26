/**
 * ShaderLab / HLSL 共通の字句解析器。
 *
 * - 位置はすべてファイル先頭からのoffset(UTF-16)で保持する。行/列はLineIndexで必要時に求める。
 * - 行頭の `#` から始まるプリプロセッサ行は、`\` による行継続を含めて1つのDirectiveとして切り出し、
 *   コードのトークン列には含めない。これにより複数行の #define 本体がHLSL宣言として誤解析されない。
 * - `#if 0` などの無効ブロックや、片方の分岐だけで括弧が開閉する `#if/#else` の後続分岐は
 *   トークン列から除外する(括弧の対応が崩れてパース全体が壊れるのを防ぐ)。
 */

export type TokenKind = 'ident' | 'number' | 'string' | 'punct';

export interface Token {
  kind: TokenKind;
  value: string;
  start: number;
  end: number;
}

export interface Span {
  start: number;
  end: number;
}

export interface Directive {
  /** ディレクティブ名(include, define, pragma, if ...)。`#` 単独の場合は空文字列。 */
  name: string;
  start: number;
  end: number;
  nameStart: number;
  nameEnd: number;
  /** ディレクティブ名の直後のoffset。 */
  bodyStart: number;
  /** このディレクティブより前にあるコードトークン数(条件分岐処理前の値)。 */
  tokenIndex: number;
  /** `#if 0` などの無効ブロック内にある。 */
  inactive: boolean;
  /** includeガード以外の条件付きコンパイル(#if 等)の内側にある。 */
  conditional: boolean;
}

export interface DisabledRange extends Span {
  /** 無効と判断した条件(`#if 0` / `#else` など、該当分岐の先頭ディレクティブ)。 */
  condition: string;
}

export interface LexError extends Span {
  message: string;
}

export interface LexResult {
  tokens: Token[];
  directives: Directive[];
  comments: Span[];
  strings: Span[];
  /** 条件コンパイルで除外したコード範囲。 */
  inactiveRanges: Span[];
  /** includeガード以外の #if ... #endif の範囲(定義の有無が条件次第になる領域)。 */
  conditionalRanges: Span[];
  /** 条件が確定して無効になる範囲(#if 0 等)。エディタでグレーアウト表示する。 */
  disabledRanges: DisabledRange[];
  errors: LexError[];
}

const MULTI_CHAR_PUNCT = [
  '<<=',
  '>>=',
  '==',
  '!=',
  '<=',
  '>=',
  '&&',
  '||',
  '++',
  '--',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '&=',
  '|=',
  '^=',
  '<<',
  '>>',
  '->',
  '::',
  '##',
];

function isIdentStart(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
}

function isIdentPart(code: number): boolean {
  return isIdentStart(code) || (code >= 48 && code <= 57);
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

/** 文字列トークンの引用符を除いた内容。 */
export function stringValue(token: Token): string {
  const value = token.value;
  if (value.length === 0) return value;
  const quote = value[0];
  const end = value.length > 1 && value[value.length - 1] === quote ? value.length - 1 : value.length;
  return value.substring(1, end);
}

export function isIdentifierText(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

class Scanner {
  public readonly tokens: Token[] = [];
  public readonly comments: Span[] = [];
  public readonly strings: Span[] = [];
  public readonly errors: LexError[] = [];

  public constructor(
    private readonly text: string,
    private readonly recordTrivia: boolean,
  ) {}

  /** offsetのコメントを読み飛ばす。コメントでなければそのまま返す。 */
  public skipComment(i: number, end: number): number {
    const text = this.text;
    if (text.charCodeAt(i) !== 47 /* / */ || i + 1 >= end) {
      return i;
    }
    const next = text.charCodeAt(i + 1);
    if (next === 47) {
      let j = i + 2;
      while (j < end && text.charCodeAt(j) !== 10) j++;
      if (this.recordTrivia) this.comments.push({ start: i, end: j });
      return j;
    }
    if (next === 42 /* * */) {
      const close = text.indexOf('*/', i + 2);
      if (close < 0 || close + 2 > end) {
        if (this.recordTrivia) {
          this.comments.push({ start: i, end });
          this.errors.push({ start: i, end: i + 2, message: 'ブロックコメントが閉じられていません。' });
        }
        return end;
      }
      if (this.recordTrivia) this.comments.push({ start: i, end: close + 2 });
      return close + 2;
    }
    return i;
  }

  /** 1トークンを読み取り、次のoffsetを返す。 */
  public readToken(i: number, end: number): number {
    const text = this.text;
    const code = text.charCodeAt(i);
    if (isIdentStart(code)) {
      let j = i + 1;
      while (j < end && isIdentPart(text.charCodeAt(j))) j++;
      this.tokens.push({ kind: 'ident', value: text.substring(i, j), start: i, end: j });
      return j;
    }
    if (isDigit(code) || (code === 46 /* . */ && i + 1 < end && isDigit(text.charCodeAt(i + 1)))) {
      const j = this.readNumber(i, end);
      this.tokens.push({ kind: 'number', value: text.substring(i, j), start: i, end: j });
      return j;
    }
    if (code === 34 /* " */ || code === 39 /* ' */) {
      let j = i + 1;
      let terminated = false;
      while (j < end) {
        const c = text.charCodeAt(j);
        if (c === 92 /* \ */) {
          j += 2;
          continue;
        }
        if (c === 10) break;
        if (c === code) {
          j++;
          terminated = true;
          break;
        }
        j++;
      }
      j = Math.min(j, end);
      if (!terminated && this.recordTrivia) {
        this.errors.push({ start: i, end: j, message: '文字列リテラルが閉じられていません。' });
      }
      if (this.recordTrivia) this.strings.push({ start: i, end: j });
      // 値は引用符を含めて保持する(文字リテラル '(' を括弧と区別するため)。内容は stringValue() で取得する。
      this.tokens.push({ kind: 'string', value: text.substring(i, j), start: i, end: j });
      return j;
    }
    for (const punct of MULTI_CHAR_PUNCT) {
      if (text.startsWith(punct, i) && i + punct.length <= end) {
        this.tokens.push({ kind: 'punct', value: punct, start: i, end: i + punct.length });
        return i + punct.length;
      }
    }
    // サロゲートペアを分断しない。
    const width = code >= 0xd800 && code <= 0xdbff ? 2 : 1;
    this.tokens.push({ kind: 'punct', value: text.substr(i, width), start: i, end: i + width });
    return i + width;
  }

  private readNumber(i: number, end: number): number {
    const text = this.text;
    let j = i;
    if (text.charCodeAt(j) === 48 && (text[j + 1] === 'x' || text[j + 1] === 'X')) {
      j += 2;
      while (j < end && /[0-9a-fA-F]/.test(text[j])) j++;
    } else {
      while (j < end && isDigit(text.charCodeAt(j))) j++;
      if (text[j] === '.') {
        j++;
        while (j < end && isDigit(text.charCodeAt(j))) j++;
      }
      if ((text[j] === 'e' || text[j] === 'E') && /[0-9+-]/.test(text[j + 1] ?? '')) {
        j += 2;
        while (j < end && isDigit(text.charCodeAt(j))) j++;
      }
    }
    while (j < end && /[fFhHuUlL]/.test(text[j])) j++;
    return j;
  }
}

/**
 * 指定範囲だけをトークン化する。ディレクティブ本体の解析に使う。
 * 行継続(`\` + 改行)は空白として扱う。
 */
export function tokenizeRange(text: string, start: number, end: number): Token[] {
  const scanner = new Scanner(text, false);
  let i = start;
  while (i < end) {
    const code = text.charCodeAt(i);
    if (code === 32 || code === 9 || code === 10 || code === 13 || code === 92 /* \ */) {
      i++;
      continue;
    }
    const skipped = scanner.skipComment(i, end);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    i = scanner.readToken(i, end);
  }
  return scanner.tokens;
}

export function lex(text: string): LexResult {
  const scanner = new Scanner(text, true);
  const directives: Directive[] = [];
  const length = text.length;
  let i = 0;
  let atLineStart = true;

  while (i < length) {
    const code = text.charCodeAt(i);
    if (code === 10) {
      atLineStart = true;
      i++;
      continue;
    }
    if (code === 32 || code === 9 || code === 13 || code === 12 || code === 11 || code === 0xfeff) {
      i++;
      continue;
    }
    const skipped = scanner.skipComment(i, length);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    if (code === 35 /* # */ && atLineStart) {
      const directive = readDirective(text, i, scanner);
      directive.tokenIndex = scanner.tokens.length;
      directives.push(directive);
      i = directive.end;
      continue;
    }
    atLineStart = false;
    i = scanner.readToken(i, length);
  }

  const { tokens, inactiveRanges, conditionalRanges, disabledRanges } = applyConditionals(text, scanner.tokens, directives);
  return {
    tokens,
    directives,
    comments: scanner.comments,
    strings: scanner.strings,
    inactiveRanges,
    conditionalRanges,
    disabledRanges,
    errors: scanner.errors,
  };
}

function readDirective(text: string, start: number, scanner: Scanner): Directive {
  const length = text.length;
  let i = start + 1;
  while (i < length && (text[i] === ' ' || text[i] === '\t')) i++;
  const nameStart = i;
  while (i < length && isIdentPart(text.charCodeAt(i))) i++;
  const nameEnd = i;

  // 行継続を含む論理行の終端を探す。コメント・文字列内の改行判定に注意する。
  let end = i;
  while (end < length) {
    const code = text.charCodeAt(end);
    if (code === 10) break;
    if (code === 92 /* \ */) {
      // `\` の後ろが(空白+)改行なら次の行へ継続する。
      let j = end + 1;
      while (j < length && (text[j] === ' ' || text[j] === '\t' || text[j] === '\r')) j++;
      if (text[j] === '\n') {
        end = j + 1;
        continue;
      }
      end++;
      continue;
    }
    if (code === 47 /* / */) {
      const skipped = scanner.skipComment(end, length);
      if (skipped !== end) {
        if (text[end + 1] === '/') {
          end = skipped;
          break;
        }
        end = skipped;
        continue;
      }
    }
    if (code === 34 /* " */) {
      let j = end + 1;
      while (j < length && text[j] !== '"' && text[j] !== '\n') j++;
      end = text[j] === '"' ? j + 1 : j;
      continue;
    }
    end++;
  }
  // 末尾の\rは含めない。
  let trimmedEnd = end;
  while (trimmedEnd > start && (text[trimmedEnd - 1] === '\r' || text[trimmedEnd - 1] === ' ')) trimmedEnd--;

  return {
    name: text.substring(nameStart, nameEnd),
    start,
    end: Math.max(trimmedEnd, nameEnd),
    nameStart,
    nameEnd,
    bodyStart: nameEnd,
    tokenIndex: 0,
    inactive: false,
    conditional: false,
  };
}

interface Branch {
  directiveIndex: number;
  tokenStart: number;
  tokenEnd: number;
  /** 条件が常に偽(#if 0 など)。 */
  alwaysFalse: boolean;
  /** 条件が常に真(#if 1 など)。 */
  alwaysTrue: boolean;
  endDirectiveIndex: number;
}

/** `#ifndef FOO_INCLUDED` + `#define FOO_INCLUDED` 形式のincludeガード。 */
function isIncludeGuard(text: string, directives: Directive[], index: number, totalTokens: number): boolean {
  const directive = directives[index];
  const next = directives[index + 1];
  if (!next || next.name !== 'define') return false;
  const body = text.substring(directive.bodyStart, directive.end).trim();
  let name: string | undefined;
  if (directive.name === 'ifndef') name = /^([A-Za-z_]\w*)/.exec(body)?.[1];
  else if (directive.name === 'if') name = /^!\s*defined\s*\(?\s*([A-Za-z_]\w*)\s*\)?$/.exec(body)?.[1];
  if (!name) return false;
  const defined = /^\s*([A-Za-z_]\w*)/.exec(text.substring(next.bodyStart, next.end))?.[1];
  if (defined !== name) return false;
  // ファイル全体を囲む場合だけincludeガードとみなす。`#ifndef X / #define X 0 / #endif`
  // (include元で上書きできる既定値)はガードではなく条件付きの定義として扱う。
  let depth = 0;
  for (let d = index; d < directives.length; d++) {
    const current = directives[d].name;
    if (current === 'if' || current === 'ifdef' || current === 'ifndef') depth++;
    else if (current === 'endif' && --depth === 0) {
      return directives[d].tokenIndex >= totalTokens && directives[d].tokenIndex > directive.tokenIndex;
    }
  }
  return true;
}

type ConditionResult = 'true' | 'false' | 'unknown';

/**
 * 条件をファイル内だけで確定できる場合に評価する。
 * - 数値・true/false・算術/比較/論理演算(`0 && FOO` のような短絡評価を含む)
 * - 同じファイルで条件の外側に `#define` されたマクロと `defined()`
 * Unityのバージョンやキーワード(multi_compile 等)のように外部で決まるものは unknown になる。
 */
function evaluateCondition(text: string, directive: Directive, defines: Map<string, string>): ConditionResult {
  let value: number | undefined;
  if (directive.name === 'if' || directive.name === 'elif') {
    value = evaluateExpression(tokenizeRange(text, directive.bodyStart, directive.end), defines, 0);
  } else if (directive.name === 'ifdef' || directive.name === 'ifndef') {
    const name = /^\s*([A-Za-z_]\w*)/.exec(text.substring(directive.bodyStart, directive.end))?.[1];
    // ファイル内で定義済みの場合だけ確定できる(未定義でもinclude元で定義される可能性がある)。
    if (name && defines.has(name)) value = directive.name === 'ifdef' ? 1 : 0;
  }
  if (value === undefined || Number.isNaN(value)) return 'unknown';
  return value !== 0 ? 'true' : 'false';
}

const BINARY_LEVELS: string[][] = [
  ['||'],
  ['&&'],
  ['|'],
  ['^'],
  ['&'],
  ['==', '!='],
  ['<', '>', '<=', '>='],
  ['<<', '>>'],
  ['+', '-'],
  ['*', '/', '%'],
];

/** プリプロセッサの定数式を評価する。値が決まらなければ undefined。 */
function evaluateExpression(tokens: Token[], defines: Map<string, string>, depth: number): number | undefined {
  if (depth > 8 || tokens.length === 0) return undefined;
  let position = 0;
  let failed = false;
  const peek = (): string | undefined => tokens[position]?.value;

  const parseBinary = (level: number): number | undefined => {
    if (level >= BINARY_LEVELS.length) return parseUnary();
    let left = parseBinary(level + 1);
    while (!failed && BINARY_LEVELS[level].includes(peek() ?? '')) {
      const operator = tokens[position++].value;
      const right = parseBinary(level + 1);
      left = applyBinary(operator, left, right);
    }
    return left;
  };

  const parseUnary = (): number | undefined => {
    const value = peek();
    if (value === '!' || value === '-' || value === '+' || value === '~') {
      position++;
      const operand = parseUnary();
      if (operand === undefined) return undefined;
      if (value === '!') return operand === 0 ? 1 : 0;
      if (value === '-') return -operand;
      if (value === '~') return ~operand;
      return operand;
    }
    return parsePrimary();
  };

  const parsePrimary = (): number | undefined => {
    const token = tokens[position++];
    if (!token) {
      failed = true;
      return undefined;
    }
    if (token.value === '(') {
      const inner = parseBinary(0);
      if (peek() === ')') position++;
      else failed = true;
      return inner;
    }
    if (token.kind === 'number') {
      const literal = token.value.replace(/[uUlLfFhH]+$/, '');
      const parsed = /^0[xX]/.test(literal) ? parseInt(literal, 16) : Number(literal);
      return Number.isNaN(parsed) ? undefined : parsed;
    }
    if (token.kind !== 'ident') {
      failed = true;
      return undefined;
    }
    if (token.value === 'true') return 1;
    if (token.value === 'false') return 0;
    if (token.value === 'defined') {
      const parenthesized = peek() === '(';
      if (parenthesized) position++;
      const name = tokens[position++];
      if (parenthesized && peek() === ')') position++;
      if (!name || name.kind !== 'ident') {
        failed = true;
        return undefined;
      }
      return defines.has(name.value) ? 1 : undefined;
    }
    if (peek() === '(') {
      // 関数形式マクロの呼び出しは評価しない。
      let nesting = 0;
      for (; position < tokens.length; position++) {
        if (tokens[position].value === '(') nesting++;
        else if (tokens[position].value === ')' && --nesting === 0) {
          position++;
          break;
        }
      }
      return undefined;
    }
    const body = defines.get(token.value);
    if (body === undefined) return undefined;
    return evaluateExpression(tokenizeRange(body, 0, body.length), defines, depth + 1);
  };

  const result = parseBinary(0);
  if (failed || position < tokens.length) return undefined;
  return result;
}

function applyBinary(operator: string, left: number | undefined, right: number | undefined): number | undefined {
  // 片方だけで決まる論理演算(短絡評価)
  if (operator === '&&') {
    if (left === 0 || right === 0) return 0;
    if (left === undefined || right === undefined) return undefined;
    return 1;
  }
  if (operator === '||') {
    if ((left !== undefined && left !== 0) || (right !== undefined && right !== 0)) return 1;
    if (left === undefined || right === undefined) return undefined;
    return 0;
  }
  if (left === undefined || right === undefined) return undefined;
  switch (operator) {
    case '|':
      return left | right;
    case '^':
      return left ^ right;
    case '&':
      return left & right;
    case '==':
      return left === right ? 1 : 0;
    case '!=':
      return left !== right ? 1 : 0;
    case '<':
      return left < right ? 1 : 0;
    case '>':
      return left > right ? 1 : 0;
    case '<=':
      return left <= right ? 1 : 0;
    case '>=':
      return left >= right ? 1 : 0;
    case '<<':
      return left << right;
    case '>>':
      return left >> right;
    case '+':
      return left + right;
    case '-':
      return left - right;
    case '*':
      return left * right;
    case '/':
      return right === 0 ? undefined : Math.trunc(left / right);
    case '%':
      return right === 0 ? undefined : left % right;
    default:
      return undefined;
  }
}

function applyConditionals(
  text: string,
  rawTokens: Token[],
  directives: Directive[],
): { tokens: Token[]; inactiveRanges: Span[]; conditionalRanges: Span[]; disabledRanges: DisabledRange[] } {
  const conditionalRanges: Span[] = [];
  const disabledRanges: DisabledRange[] = [];
  /** 条件の外側で定義されたマクロ(名前 -> 本体)。条件の評価に使う。 */
  const sharedDefines = new Map<string, string>();
  let defines = sharedDefines;
  // ShaderLabでは HLSLPROGRAM ごとに別々にコンパイルされるため、ブロック内の定義はそのブロックだけで使う。
  // HLSLINCLUDE / CGINCLUDE とHLSLファイルの定義は共有する。
  let scannedTokens = 0;
  const trackBlocks = (untilToken: number): void => {
    for (; scannedTokens < untilToken && scannedTokens < rawTokens.length; scannedTokens++) {
      const token = rawTokens[scannedTokens];
      if (token.kind !== 'ident') continue;
      if (token.value === 'HLSLPROGRAM' || token.value === 'CGPROGRAM') defines = new Map(sharedDefines);
      else if (token.value === 'HLSLINCLUDE' || token.value === 'CGINCLUDE' || token.value === 'ENDHLSL' || token.value === 'ENDCG') {
        defines = sharedDefines;
      }
    }
  };
  const inactive = new Uint8Array(rawTokens.length);
  const inactiveRanges: Span[] = [];
  const stack: Branch[][] = [];
  let anyInactive = false;

  const markBranch = (branch: Branch, zero: boolean): void => {
    for (let t = branch.tokenStart; t < branch.tokenEnd; t++) {
      inactive[t] = 1;
    }
    anyInactive = true;
    const startDirective = directives[branch.directiveIndex];
    const endDirective = directives[branch.endDirectiveIndex];
    if (startDirective && endDirective) {
      inactiveRanges.push({ start: startDirective.end, end: endDirective.start });
    }
    if (zero) {
      for (let d = branch.directiveIndex + 1; d < branch.endDirectiveIndex; d++) {
        directives[d].inactive = true;
      }
      if (startDirective && endDirective) {
        // ディレクティブ行の次の行から、次の分岐ディレクティブの直前まで。
        const lineEnd = text.indexOf('\n', startDirective.end);
        const start = lineEnd < 0 ? startDirective.end : lineEnd + 1;
        let end = endDirective.start;
        while (end > start && (text[end - 1] === ' ' || text[end - 1] === '\t')) end--;
        if (end > start && text.substring(start, end).trim().length > 0) {
          const condition = text.substring(startDirective.start, startDirective.end).replace(/\s+/g, ' ').trim();
          disabledRanges.push({ start, end, condition });
        }
      }
    }
  };

  const braceDelta = (branch: Branch): number => {
    let delta = 0;
    for (let t = branch.tokenStart; t < branch.tokenEnd; t++) {
      if (inactive[t]) continue;
      const value = rawTokens[t].value;
      if (value === '{' || value === '(') delta++;
      else if (value === '}' || value === ')') delta--;
    }
    return delta;
  };

  const finalize = (branches: Branch[]): void => {
    let decided = false;
    for (const branch of branches) {
      if (decided || branch.alwaysFalse) {
        markBranch(branch, true);
        continue;
      }
      if (branch.alwaysTrue) {
        decided = true;
      }
    }
    if (decided) return;
    // 最初の有効な分岐だけで括弧が開閉する場合(関数ヘッダの切り替え等)、後続の分岐は代替記述とみなす。
    const firstActive = branches.findIndex((branch) => !branch.alwaysFalse);
    if (firstActive < 0 || firstActive === branches.length - 1) return;
    if (braceDelta(branches[firstActive]) !== 0 || endsWithFunctionHeader(branches[firstActive])) {
      for (let b = firstActive + 1; b < branches.length; b++) {
        if (!branches[b].alwaysFalse) markBranch(branches[b], false);
      }
    }
  };

  /**
   * `float frag(V i) : SV_Depth` のように関数ヘッダだけで終わる分岐。
   * `#else` 側は同じ関数の別ヘッダなので両方を残すと構文が壊れる。
   */
  const endsWithFunctionHeader = (branch: Branch): boolean => {
    let last = branch.tokenEnd - 1;
    while (last >= branch.tokenStart && inactive[last]) last--;
    if (last < branch.tokenStart) return false;
    const token = rawTokens[last];
    if (token.value === ')') return true;
    return token.kind === 'ident' && last - 1 >= branch.tokenStart && rawTokens[last - 1].value === ':' && rawTokens[last - 2]?.value === ')';
  };

  const guardStack: boolean[] = [];
  let conditionalDepth = 0;
  directives.forEach((directive, index) => {
    directive.conditional = conditionalDepth > 0;
    trackBlocks(directive.tokenIndex);
    switch (directive.name) {
      case 'define':
      case 'undef': {
        // 条件の内側の定義は有効かどうか分からないので使わない。
        if (directive.conditional) break;
        const nameMatch = /^\s*([A-Za-z_]\w*)(\()?/.exec(text.substring(directive.bodyStart, directive.end));
        if (!nameMatch) break;
        if (directive.name === 'undef') {
          defines.delete(nameMatch[1]);
        } else if (!nameMatch[2]) {
          const body = text.substring(directive.bodyStart + nameMatch[0].length, directive.end);
          defines.set(nameMatch[1], body.replace(/\\\r?\n/g, ' ').trim());
        }
        break;
      }
      case 'if':
      case 'ifdef':
      case 'ifndef': {
        const literal = evaluateCondition(text, directive, defines);
        const guard = isIncludeGuard(text, directives, index, rawTokens.length);
        guardStack.push(guard);
        if (!guard) conditionalDepth++;
        stack.push([
          {
            directiveIndex: index,
            tokenStart: directive.tokenIndex,
            tokenEnd: rawTokens.length,
            alwaysFalse: literal === 'false',
            alwaysTrue: literal === 'true',
            endDirectiveIndex: directives.length,
          },
        ]);
        break;
      }
      case 'elif':
      case 'else': {
        const group = stack[stack.length - 1];
        if (!group) break;
        const last = group[group.length - 1];
        last.tokenEnd = directive.tokenIndex;
        last.endDirectiveIndex = index;
        const literal = directive.name === 'else' ? 'unknown' : evaluateCondition(text, directive, defines);
        group.push({
          directiveIndex: index,
          tokenStart: directive.tokenIndex,
          tokenEnd: rawTokens.length,
          alwaysFalse: literal === 'false',
          alwaysTrue: literal === 'true' || (directive.name === 'else' && group.every((b) => b.alwaysFalse)),
          endDirectiveIndex: directives.length,
        });
        break;
      }
      case 'endif': {
        const group = stack.pop();
        if (!group) break;
        if (!guardStack.pop()) {
          conditionalDepth--;
          conditionalRanges.push({ start: directives[group[0].directiveIndex].start, end: directive.end });
        }
        const last = group[group.length - 1];
        last.tokenEnd = directive.tokenIndex;
        last.endDirectiveIndex = index;
        finalize(group);
        break;
      }
      default:
        break;
    }
  });
  while (stack.length > 0) {
    finalize(stack.pop()!);
  }

  // ネストした範囲を結合して、二分探索できる重なりのない列にする。
  conditionalRanges.sort((a, b) => a.start - b.start);
  const merged: Span[] = [];
  for (const range of conditionalRanges) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  conditionalRanges.length = 0;
  conditionalRanges.push(...merged);
  // ネストした無効範囲は外側に含まれるので除く。
  disabledRanges.sort((a, b) => a.start - b.start || b.end - a.end);
  const disabled: DisabledRange[] = [];
  for (const range of disabledRanges) {
    const last = disabled[disabled.length - 1];
    if (last && range.start >= last.start && range.end <= last.end) continue;
    disabled.push(range);
  }
  if (!anyInactive) {
    return { tokens: rawTokens, inactiveRanges, conditionalRanges, disabledRanges: disabled };
  }
  const tokens: Token[] = [];
  for (let t = 0; t < rawTokens.length; t++) {
    if (!inactive[t]) tokens.push(rawTokens[t]);
  }
  inactiveRanges.sort((a, b) => a.start - b.start);
  return { tokens, inactiveRanges, conditionalRanges, disabledRanges: disabled };
}

/** 昇順に並んだ範囲配列にoffsetが含まれるかを二分探索で判定する。 */
export function spansContain(spans: Span[], offset: number): boolean {
  let low = 0;
  let high = spans.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const span = spans[middle];
    if (offset < span.start) high = middle - 1;
    else if (offset >= span.end) low = middle + 1;
    else return true;
  }
  return false;
}

/** offset以上で始まる最初のトークンindex。 */
export function lowerBoundToken(tokens: Token[], offset: number): number {
  let low = 0;
  let high = tokens.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (tokens[middle].start < offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * offset位置のトークンindex。カーソルが2トークンの境界にある場合は識別子側を優先する
 * (`foo|.bar` ではfoo、`.|bar` ではbar)。
 */
export function tokenIndexAt(tokens: Token[], offset: number): number {
  const next = lowerBoundToken(tokens, offset);
  const atStart = next < tokens.length && tokens[next].start === offset ? next : -1;
  const containing = next > 0 && tokens[next - 1].end >= offset ? next - 1 : -1;
  if (containing >= 0 && tokens[containing].end > offset) return containing;
  if (containing >= 0 && tokens[containing].kind === 'ident') return containing;
  if (atStart >= 0) return atStart;
  return containing;
}
