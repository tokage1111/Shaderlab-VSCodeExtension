import {
  HlslCBuffer,
  HlslFunction,
  HlslInclude,
  HlslLocal,
  HlslMacro,
  HlslParameter,
  HlslPragma,
  HlslStruct,
  HlslTypedef,
  HlslUnit,
  HlslVariable,
  ParameterQualifier,
} from './ast';
import { Directive, Token, tokenizeRange } from './lexer';

/**
 * 宣言として扱う修飾子。型名の前に置かれる。
 */
const DECLARATION_QUALIFIERS = new Set([
  'static',
  'const',
  'uniform',
  'extern',
  'volatile',
  'precise',
  'shared',
  'groupshared',
  'row_major',
  'column_major',
  'inline',
  'nointerpolation',
  'linear',
  'centroid',
  'noperspective',
  'sample',
  'snorm',
  'unorm',
  'globallycoherent',
  'export',
  'in',
  'out',
  'inout',
  'point',
  'line',
  'triangle',
  'lineadj',
  'triangleadj',
  'vertices',
  'primitives',
  'indices',
  'payload',
]);

/** 型名・宣言名として使えない語。 */
const STATEMENT_KEYWORDS = new Set([
  'if',
  'else',
  'for',
  'while',
  'do',
  'switch',
  'case',
  'default',
  'return',
  'break',
  'continue',
  'discard',
  'goto',
  'struct',
  'class',
  'cbuffer',
  'tbuffer',
  'typedef',
  'true',
  'false',
  'sizeof',
  'register',
  'packoffset',
  'namespace',
  'template',
  'interface',
  'enum',
]);

const CONTROL_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'do', 'else']);

/** `TEXTURE2D(_MainTex);` のように変数を宣言するマクロ。[型, 名前の引数位置(-1は最後)]。 */
const DECLARATION_MACROS: Record<string, { type: string; nameArg: number; typeArg?: number; extraSampler?: boolean }> =
  {
    TEXTURE2D: { type: 'Texture2D', nameArg: 0 },
    TEXTURE2D_X: { type: 'Texture2D', nameArg: 0 },
    TEXTURE2D_ARRAY: { type: 'Texture2DArray', nameArg: 0 },
    TEXTURECUBE: { type: 'TextureCube', nameArg: 0 },
    TEXTURECUBE_ARRAY: { type: 'TextureCubeArray', nameArg: 0 },
    TEXTURE3D: { type: 'Texture3D', nameArg: 0 },
    TEXTURE2D_SHADOW: { type: 'Texture2D', nameArg: 0 },
    TEXTURE2D_ARRAY_SHADOW: { type: 'Texture2DArray', nameArg: 0 },
    TEXTURECUBE_SHADOW: { type: 'TextureCube', nameArg: 0 },
    TEXTURECUBE_ARRAY_SHADOW: { type: 'TextureCubeArray', nameArg: 0 },
    TEXTURE2D_FLOAT: { type: 'Texture2D', nameArg: 0 },
    TEXTURE2D_HALF: { type: 'Texture2D', nameArg: 0 },
    TEXTURE3D_FLOAT: { type: 'Texture3D', nameArg: 0 },
    TEXTURE3D_HALF: { type: 'Texture3D', nameArg: 0 },
    TEXTURE2D_X_FLOAT: { type: 'Texture2D', nameArg: 0 },
    TEXTURE2D_X_HALF: { type: 'Texture2D', nameArg: 0 },
    TEXTURE2D_X_UINT: { type: 'Texture2D<uint>', nameArg: 0 },
    TEXTURE2D_X_UINT2: { type: 'Texture2D<uint2>', nameArg: 0 },
    TEXTURE2D_X_MSAA: { type: 'Texture2DMS', nameArg: -1 },
    TEXTURE2D_MSAA: { type: 'Texture2DMS', nameArg: -1 },
    SAMPLER: { type: 'SamplerState', nameArg: 0 },
    SAMPLER_CMP: { type: 'SamplerComparisonState', nameArg: 0 },
    RW_TEXTURE2D: { type: 'RWTexture2D', nameArg: 1, typeArg: 0 },
    RW_TEXTURE2D_ARRAY: { type: 'RWTexture2DArray', nameArg: 1, typeArg: 0 },
    RW_TEXTURE3D: { type: 'RWTexture3D', nameArg: 1, typeArg: 0 },
    RW_TEXTURE2D_X: { type: 'RWTexture2D', nameArg: 1, typeArg: 0 },
    UNITY_DECLARE_TEX2D: { type: 'Texture2D', nameArg: 0, extraSampler: true },
    UNITY_DECLARE_TEX2D_NOSAMPLER: { type: 'Texture2D', nameArg: 0 },
    UNITY_DECLARE_TEX2D_HALF: { type: 'Texture2D', nameArg: 0, extraSampler: true },
    UNITY_DECLARE_TEX2D_FLOAT: { type: 'Texture2D', nameArg: 0, extraSampler: true },
    UNITY_DECLARE_TEX2DARRAY: { type: 'Texture2DArray', nameArg: 0, extraSampler: true },
    UNITY_DECLARE_TEX2DARRAY_NOSAMPLER: { type: 'Texture2DArray', nameArg: 0 },
    UNITY_DECLARE_TEXCUBE: { type: 'TextureCube', nameArg: 0, extraSampler: true },
    UNITY_DECLARE_TEXCUBE_NOSAMPLER: { type: 'TextureCube', nameArg: 0 },
    UNITY_DECLARE_TEXCUBEARRAY: { type: 'TextureCubeArray', nameArg: 0, extraSampler: true },
    UNITY_DECLARE_TEX3D: { type: 'Texture3D', nameArg: 0, extraSampler: true },
    UNITY_DECLARE_TEX3D_NOSAMPLER: { type: 'Texture3D', nameArg: 0 },
    UNITY_DECLARE_SHADOWMAP: { type: 'Texture2D', nameArg: 0 },
    UNITY_DECLARE_DEPTH_TEXTURE: { type: 'Texture2D', nameArg: 0 },
    UNITY_DECLARE_DEPTH_TEXTURE_MS: { type: 'Texture2DMS', nameArg: 0 },
    UNITY_DECLARE_SCREENSPACE_TEXTURE: { type: 'Texture2D', nameArg: 0 },
    UNITY_DECLARE_SCREENSPACE_SHADOWMAP: { type: 'Texture2D', nameArg: 0 },
    UNITY_DEFINE_INSTANCED_PROP: { type: '', nameArg: 1, typeArg: 0 },
    UNITY_DOTS_INSTANCED_PROP: { type: '', nameArg: 1, typeArg: 0 },
    UNITY_DOTS_INSTANCED_PROP_OVERRIDE_SUPPORTED: { type: '', nameArg: 1, typeArg: 0 },
    UNITY_DOTS_INSTANCED_PROP_OVERRIDE_REQUIRED: { type: '', nameArg: 1, typeArg: 0 },
  };

/** struct内で展開されるメンバー。 */
const FIELD_MACROS: Record<string, Array<{ type: string; name: string | number }>> = {
  UNITY_VERTEX_INPUT_INSTANCE_ID: [{ type: 'uint', name: 'instanceID' }],
  UNITY_VERTEX_OUTPUT_STEREO: [
    { type: 'uint', name: 'stereoTargetEyeIndexAsRTArrayIdx' },
    { type: 'uint', name: 'stereoTargetEyeIndexAsBlendIdx0' },
  ],
  DEFAULT_UNITY_VERTEX_INPUT_INSTANCE_ID: [{ type: 'uint', name: 'instanceID' }],
  DEFAULT_UNITY_VERTEX_OUTPUT_STEREO: [
    { type: 'uint', name: 'stereoTargetEyeIndexAsRTArrayIdx' },
    { type: 'uint', name: 'stereoTargetEyeIndexAsBlendIdx0' },
  ],
  UNITY_POSITION: [{ type: 'float4', name: 0 }],
  DECLARE_LIGHTMAP_OR_SH: [
    { type: 'float2', name: 0 },
    { type: 'half3', name: 1 },
  ],
  UNITY_FOG_COORDS: [{ type: 'float1', name: 'fogCoord' }],
  UNITY_SHADOW_COORDS: [{ type: 'unityShadowCoord4', name: '_ShadowCoord' }],
  V2F_SHADOW_CASTER: [{ type: 'float4', name: 'pos' }],
};

/** `CBUFFER_START(Name) ... CBUFFER_END` 形式のブロック。値は終了マクロ。 */
const MACRO_BUFFER_BLOCKS: Record<string, string> = {
  CBUFFER_START: 'CBUFFER_END',
  UNITY_INSTANCING_BUFFER_START: 'UNITY_INSTANCING_BUFFER_END',
  UNITY_INSTANCING_CBUFFER_START: 'UNITY_INSTANCING_CBUFFER_END',
  UNITY_DOTS_INSTANCING_START: 'UNITY_DOTS_INSTANCING_END',
  GLOBAL_CBUFFER_START: 'CBUFFER_END',
};

/** 関数引数リスト内で複数の引数を宣言するマクロ(TEXTURE2D_PARAM(tex, samp) 等)。 */
function paramMacroTypes(name: string): string[] | undefined {
  if (!/_PARAM$/.test(name)) return undefined;
  if (/^SAMPLER/.test(name)) return ['SamplerState'];
  let base = 'Texture2D';
  if (/TEXTURECUBE_ARRAY/.test(name)) base = 'TextureCubeArray';
  else if (/TEXTURECUBE/.test(name)) base = 'TextureCube';
  else if (/TEXTURE3D/.test(name)) base = 'Texture3D';
  else if (/TEXTURE2D_ARRAY/.test(name)) base = 'Texture2DArray';
  const sampler = /SHADOW/.test(name) ? 'SamplerComparisonState' : 'SamplerState';
  return [base, sampler];
}

/** 未知の宣言マクロ名から型を推測する。 */
function guessMacroDeclarationType(name: string): string {
  if (/SAMPLER/i.test(name)) return /CMP|SHADOW/.test(name) ? 'SamplerComparisonState' : 'SamplerState';
  if (/TEXTURE2D_ARRAY|Texture2DArray/i.test(name)) return 'Texture2DArray';
  if (/TEXTURECUBE/i.test(name)) return 'TextureCube';
  if (/TEXTURE3D/i.test(name)) return 'Texture3D';
  if (/TEXTURE|Texture2D/i.test(name)) return 'Texture2D';
  return name;
}

export function parseHlslUnit(
  text: string,
  tokens: Token[],
  tokenStart: number,
  tokenEnd: number,
  directives: Directive[],
  spanStart: number,
  spanEnd: number,
): HlslUnit {
  return new HlslParser(text, tokens, tokenStart, tokenEnd, directives, spanStart, spanEnd).parse();
}

interface TypeInfo {
  text: string;
  start: number;
  end: number;
  /** 型を構成するトークンの開始offset。 */
  tokenStarts: number[];
}

class HlslParser {
  private i: number;
  private readonly unit: HlslUnit;
  /** 開き括弧index -> 閉じ括弧index。 */
  private readonly matching = new Map<number, number>();
  private lastParamsIncomplete = false;

  public constructor(
    private readonly text: string,
    private readonly tokens: Token[],
    private readonly tokenStart: number,
    private readonly tokenEnd: number,
    private readonly directives: Directive[],
    spanStart: number,
    spanEnd: number,
  ) {
    this.i = tokenStart;
    this.unit = {
      start: spanStart,
      end: spanEnd,
      tokenStart,
      tokenEnd,
      functions: [],
      structs: [],
      cbuffers: [],
      globals: [],
      typedefs: [],
      macros: [],
      includes: [],
      pragmas: [],
      declarationOffsets: new Set(),
      semanticOffsets: new Set(),
      issues: [],
    };
  }

  public parse(): HlslUnit {
    this.computeBracketMatching();
    this.parseDirectives();
    let guard = 0;
    while (this.i < this.tokenEnd) {
      const before = this.i;
      this.parseTopLevel();
      if (this.i <= before) {
        this.i = before + 1;
      }
      if (++guard > 1_000_000) break;
    }
    return this.unit;
  }

  /* -------------------------------------------------------------------------
   * 括弧の対応
   * ----------------------------------------------------------------------- */

  private computeBracketMatching(): void {
    const stack: number[] = [];
    const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
    let reported = 0;
    for (let t = this.tokenStart; t < this.tokenEnd; t++) {
      const value = this.tokens[t].value;
      if (this.tokens[t].kind !== 'punct') continue;
      if (value === '(' || value === '[' || value === '{') {
        stack.push(t);
        continue;
      }
      const open = pairs[value];
      if (!open || this.tokens[t].kind !== 'punct') continue;
      // 対応する開き括弧まで遡る。途中の不一致は閉じ忘れとして報告する。
      let found = -1;
      for (let s = stack.length - 1; s >= 0; s--) {
        if (this.tokens[stack[s]].value === open) {
          found = s;
          break;
        }
        // `{` を越えて `(` を探さない(ブロックをまたぐ対応は誤り)。
        if (this.tokens[stack[s]].value === '{' && open !== '{') break;
      }
      if (found < 0) {
        if (reported++ < 5) {
          this.issue(this.tokens[t].start, this.tokens[t].end, `対応する '${open}' がない '${value}' です。`, 'error');
        }
        continue;
      }
      while (stack.length - 1 > found) {
        const unclosed = stack.pop()!;
        if (reported++ < 5) {
          const token = this.tokens[unclosed];
          this.issue(token.start, token.end, `'${token.value}' が閉じられていません。`, 'error');
        }
      }
      this.matching.set(stack.pop()!, t);
    }
    while (stack.length > 0) {
      const unclosed = stack.pop()!;
      if (reported++ < 5) {
        const token = this.tokens[unclosed];
        this.issue(token.start, token.end, `'${token.value}' が閉じられていません。`, 'error');
      }
    }
  }

  /** 対応する閉じ括弧のindex。見つからなければ単位の終端。 */
  private matchOf(index: number): number {
    return this.matching.get(index) ?? this.tokenEnd - 1;
  }

  /* -------------------------------------------------------------------------
   * プリプロセッサ
   * ----------------------------------------------------------------------- */

  private parseDirectives(): void {
    for (const directive of this.directives) {
      if (directive.start < this.unit.start || directive.start >= this.unit.end || directive.inactive) continue;
      switch (directive.name) {
        case 'include':
        case 'include_with_pragmas':
          this.parseInclude(directive);
          break;
        case 'define':
          this.parseDefine(directive);
          break;
        case 'pragma':
          this.parsePragma(directive);
          break;
        default:
          break;
      }
    }
  }

  private parseInclude(directive: Directive): void {
    const text = this.text;
    let j = directive.bodyStart;
    while (j < directive.end && (text[j] === ' ' || text[j] === '\t')) j++;
    const open = text[j];
    const close = open === '"' ? '"' : open === '<' ? '>' : undefined;
    if (!close) {
      this.issue(directive.start, directive.end, '#include のパスが指定されていません。', 'error');
      return;
    }
    let k = j + 1;
    while (k < directive.end && text[k] !== close) k++;
    const include: HlslInclude = {
      path: text.substring(j + 1, k).trim(),
      pathStart: j + 1,
      pathEnd: k,
      start: directive.start,
      end: directive.end,
      withPragmas: directive.name === 'include_with_pragmas',
      angle: open === '<',
      conditional: directive.conditional,
    };
    if (text[k] !== close) {
      this.issue(j, k, '#include のパスが閉じられていません。', 'error');
    }
    this.unit.includes.push(include);
  }

  private parseDefine(directive: Directive): void {
    const text = this.text;
    const tokens = tokenizeRange(text, directive.bodyStart, directive.end);
    const nameToken = tokens[0];
    if (!nameToken || nameToken.kind !== 'ident') return;
    let bodyStart = nameToken.end;
    let params: string[] | undefined;
    if (text[nameToken.end] === '(') {
      params = [];
      let t = 1;
      for (; t < tokens.length && tokens[t].value !== ')'; t++) {
        if (tokens[t].kind === 'ident' || tokens[t].value === '...') params.push(tokens[t].value);
      }
      bodyStart = tokens[t]?.end ?? directive.end;
    }
    const body = text
      .substring(bodyStart, directive.end)
      .replace(/\\[ \t]*\r?\n/g, '\n')
      .replace(/\/\/[^\n]*$/gm, '')
      .trim();
    const macro: HlslMacro = {
      kind: 'macro',
      name: nameToken.value,
      nameStart: nameToken.start,
      nameEnd: nameToken.end,
      params,
      body,
      start: directive.start,
      end: directive.end,
    };
    this.unit.macros.push(macro);
  }

  private parsePragma(directive: Directive): void {
    const tokens = tokenizeRange(this.text, directive.bodyStart, directive.end);
    const nameToken = tokens[0];
    if (!nameToken) return;
    if (nameToken.value.startsWith('dynamic_branch')) {
      // `#pragma dynamic_branch _FOO` はシェーダー内で bool _FOO として参照できる。
      for (const keyword of tokens.slice(1)) {
        if (keyword.kind !== 'ident' || /^_+$/.test(keyword.value)) continue;
        this.unit.globals.push({
          name: keyword.value,
          nameStart: keyword.start,
          nameEnd: keyword.end,
          type: 'bool',
          typeStart: nameToken.start,
          typeEnd: nameToken.end,
          arrayDims: 0,
          qualifiers: ['uniform'],
          start: directive.start,
          end: directive.end,
          fromMacro: `#pragma ${nameToken.value}`,
        });
      }
    }
    const pragma: HlslPragma = {
      name: nameToken.value,
      nameStart: nameToken.start,
      nameEnd: nameToken.end,
      args: tokens.slice(1).map((token) => ({ value: token.value, start: token.start, end: token.end })),
      start: directive.start,
      end: directive.end,
    };
    this.unit.pragmas.push(pragma);
  }

  /* -------------------------------------------------------------------------
   * トップレベル
   * ----------------------------------------------------------------------- */

  private parseTopLevel(): void {
    const token = this.tok();
    if (!token) {
      this.i = this.tokenEnd;
      return;
    }
    if (token.kind === 'punct') {
      if (token.value === '[' || token.value === '{') {
        // 属性([numthreads(8,8,1)] 等)や孤立したブロック。
        this.i = this.matchOf(this.i) + 1;
        return;
      }
      this.i++;
      return;
    }
    if (token.kind !== 'ident') {
      this.i++;
      return;
    }

    switch (token.value) {
      case 'struct':
      case 'class':
        this.parseStructDeclaration();
        return;
      case 'cbuffer':
      case 'tbuffer':
        this.parseCBuffer();
        return;
      case 'typedef':
        this.parseTypedef();
        return;
      case 'namespace':
        // namespaceの中身はトップレベルとして解析を続ける。
        this.i++;
        if (this.tok()?.kind === 'ident') this.i++;
        if (this.isValue('{')) this.i++;
        return;
      case 'template':
        this.i++;
        if (this.isValue('<')) this.skipAngle();
        return;
      default:
        break;
    }

    const endMacro = MACRO_BUFFER_BLOCKS[token.value];
    if (endMacro && this.peekValue(1) === '(') {
      this.parseMacroBuffer(endMacro);
      return;
    }

    if (this.peekValue(1) === '(') {
      if (/^TEMPLATE_(\d|SWAP)/.test(token.value)) {
        this.parseTemplateFunction();
        return;
      }
      // `TEXTURE2D(_MainTex);` / `UNITY_INSTANCING_BUFFER_START(Props)` などのマクロ呼び出し。
      this.parseTopLevelMacroCall(this.unit.globals);
      return;
    }

    if (!this.parseDeclaration('global', this.unit.globals)) {
      // `NORMALS_LIGHTING_VARIABLES` のような引数なしマクロが ; なしで並ぶ場合は1語だけ読み飛ばす。
      if (/^[A-Z][A-Z0-9_]*$/.test(token.value) && this.peek(1)?.kind === 'ident') {
        this.i++;
        return;
      }
      this.skipStatement();
    }
  }

  /**
   * Core RP の `TEMPLATE_2_FLT(PositivePow, base, power, ...)` は型ごとの関数を生成する。
   * 第1引数を関数名、続く引数を仮引数として登録する。
   */
  private parseTemplateFunction(): void {
    const nameToken = this.tok()!;
    const open = this.i + 1;
    const close = this.matchOf(open);
    const args = this.splitArguments(open);
    this.i = close + 1;
    if (this.isValue(';')) this.i++;
    const functionName = args[0] ? this.singleIdentifier(args[0]) : undefined;
    if (!functionName) return;
    const swap = nameToken.value === 'TEMPLATE_SWAP';
    const count = swap ? 2 : Number(/^TEMPLATE_(\d)/.exec(nameToken.value)?.[1] ?? 0);
    const params: HlslParameter[] = [];
    for (let k = 0; k < count; k++) {
      const ident = swap ? undefined : args[k + 1] ? this.singleIdentifier(args[k + 1]) : undefined;
      params.push({
        name: ident?.value ?? (k === 0 ? 'a' : 'b'),
        nameStart: ident?.start ?? functionName.start,
        nameEnd: ident?.end ?? functionName.end,
        type: 'T',
        typeStart: nameToken.start,
        typeEnd: nameToken.end,
        arrayDims: 0,
        qualifiers: swap ? ['inout'] : [],
        qualifier: swap ? 'inout' : undefined,
        hasDefault: false,
        start: nameToken.start,
        end: this.tokens[close]?.end ?? nameToken.end,
        fromMacro: nameToken.value,
      });
    }
    this.unit.declarationOffsets.add(functionName.start);
    this.unit.functions.push({
      kind: 'function',
      name: functionName.value,
      nameStart: functionName.start,
      nameEnd: functionName.end,
      returnType: swap ? 'void' : 'T',
      returnTypeStart: nameToken.start,
      params,
      paramsIncomplete: false,
      locals: [],
      start: nameToken.start,
      end: this.tokens[close]?.end ?? nameToken.end,
    });
  }

  /**
   * 型 + 名前 で始まる宣言(関数/変数)。
   * @returns 宣言として解釈できた場合true。
   */
  private parseDeclaration(context: 'global' | 'struct' | 'cbuffer', sink: HlslVariable[]): boolean {
    const start = this.i;
    const qualifiers = this.parseQualifiers();
    const type = this.parseType();
    if (!type) {
      this.i = start;
      return false;
    }
    const nameToken = this.tok();
    if (!nameToken || nameToken.kind !== 'ident' || STATEMENT_KEYWORDS.has(nameToken.value)) {
      this.i = start;
      return false;
    }
    if (this.peekValue(1) === '(') {
      if (context === 'cbuffer') {
        this.i = start;
        return false;
      }
      this.i++;
      // `real4 ADD_FUNC_SUFFIX(SampleUVMapping)(...)` のようにマクロで関数名を生成する場合、
      // 括弧内の最後の識別子を関数名として扱う。
      const firstClose = this.matchOf(this.i);
      if (this.tokens[firstClose + 1]?.value === '(' && firstClose + 1 < this.tokenEnd) {
        let generated: Token | undefined;
        for (let t = this.i + 1; t < firstClose; t++) {
          if (this.tokens[t].kind === 'ident') generated = this.tokens[t];
        }
        this.i = firstClose + 1;
        this.parseFunction(type, generated ?? nameToken, qualifiers, this.tokens[start].start, context === 'global');
        return true;
      }
      this.parseFunction(type, nameToken, qualifiers, this.tokens[start].start, context === 'global');
      return true;
    }

    const declarationStart = this.tokens[start].start;
    const variables = this.parseDeclarators(type, qualifiers, declarationStart, true);
    if (!variables) {
      this.i = start;
      return false;
    }
    sink.push(...variables);
    return true;
  }

  private parseQualifiers(): string[] {
    const qualifiers: string[] = [];
    while (this.tok()?.kind === 'ident' && DECLARATION_QUALIFIERS.has(this.tok()!.value)) {
      // `in` などが変数名として使われるケース(`float in;`)は型が続かないので除外する。
      if (this.peek(1)?.kind !== 'ident') break;
      qualifiers.push(this.tok()!.value);
      this.i++;
    }
    return qualifiers;
  }

  /** 型名を読む。`Texture2D<float4>` / `unsigned int` / `vector<float, 3>` などに対応。 */
  private parseType(): TypeInfo | undefined {
    const token = this.tok();
    if (!token || token.kind !== 'ident' || STATEMENT_KEYWORDS.has(token.value)) {
      if (token?.value === 'struct' && this.peek(1)?.kind === 'ident') {
        // C形式の `struct Foo x;`
        this.i++;
        return this.parseType();
      }
      return undefined;
    }
    const tokenStarts = [token.start];
    let text = token.value;
    let end = token.end;
    this.i++;
    if (token.value === 'unsigned' && this.tok()?.kind === 'ident') {
      const next = this.tok()!;
      text = next.value === 'int' ? 'uint' : `unsigned ${next.value}`;
      tokenStarts.push(next.start);
      end = next.end;
      this.i++;
    }
    while (this.isValue('::') && this.peek(1)?.kind === 'ident') {
      const next = this.peek(1)!;
      text += `::${next.value}`;
      tokenStarts.push(next.start);
      end = next.end;
      this.i += 2;
    }
    if (this.isValue('<')) {
      const save = this.i;
      const templateEnd = this.skipAngle();
      if (templateEnd !== undefined) {
        for (let t = save; t < this.i; t++) {
          if (this.tokens[t].kind === 'ident') tokenStarts.push(this.tokens[t].start);
        }
        text += this.text.substring(this.tokens[save].start, templateEnd).replace(/\s+/g, '');
        end = templateEnd;
      } else {
        this.i = save;
      }
    }
    return { text, start: token.start, end, tokenStarts };
  }

  /**
   * `<...>` を読み飛ばす。テンプレート引数として不正な内容なら undefined を返し位置を戻さない。
   * @returns 閉じ `>` の終端offset
   */
  private skipAngle(): number | undefined {
    let depth = 0;
    while (this.i < this.tokenEnd) {
      const token = this.tokens[this.i];
      if (token.value === '<') depth++;
      else if (token.value === '>') depth--;
      else if (token.value === '>>') depth -= 2;
      else if (
        token.kind !== 'ident' &&
        token.kind !== 'number' &&
        token.kind !== 'string' &&
        token.value !== ',' &&
        token.value !== '::'
      ) {
        return undefined;
      }
      this.i++;
      if (depth <= 0) {
        return token.end;
      }
    }
    return undefined;
  }

  /**
   * 変数宣言子のリスト `a, b[2] : TEXCOORD0 = 1;` を読む。現在位置は最初の名前。
   */
  private parseDeclarators(
    type: TypeInfo,
    qualifiers: string[],
    declarationStart: number,
    allowSemantic: boolean,
  ): HlslVariable[] | undefined {
    const variables: HlslVariable[] = [];
    while (this.i < this.tokenEnd) {
      const nameToken = this.tok();
      if (!nameToken || nameToken.kind !== 'ident' || STATEMENT_KEYWORDS.has(nameToken.value)) {
        return undefined;
      }
      this.i++;
      const variable: HlslVariable = {
        name: nameToken.value,
        nameStart: nameToken.start,
        nameEnd: nameToken.end,
        type: type.text,
        typeStart: type.start,
        typeEnd: type.end,
        arrayDims: 0,
        qualifiers,
        start: declarationStart,
        end: nameToken.end,
      };
      while (this.isValue('[')) {
        variable.arrayDims++;
        this.i = this.matchOf(this.i) + 1;
      }
      if (allowSemantic) {
        this.parseSemanticSuffix(variable);
      }
      if (this.isValue('<')) {
        // FX形式のアノテーション `<string UIName = "x";>`
        const close = this.findAnnotationEnd();
        if (close >= 0) this.i = close + 1;
      }
      if (this.isValue('=')) {
        this.i++;
        const initIndex = this.i;
        this.skipExpression();
        if (this.i > initIndex) {
          variable.initStart = this.tokens[initIndex].start;
          variable.initEnd = this.tokens[this.i - 1].end;
        }
      }
      const terminator = this.tok();
      variable.end = this.tokens[Math.max(this.i - 1, 0)].end;
      variables.push(variable);
      if (terminator?.value === ',') {
        this.i++;
        continue;
      }
      if (terminator?.value === ';') {
        this.i++;
        this.recordDeclaration(type, variables);
        return variables;
      }
      return undefined;
    }
    return undefined;
  }

  private findAnnotationEnd(): number {
    for (let t = this.i + 1; t < this.tokenEnd; t++) {
      const value = this.tokens[t].value;
      if (value === '>') return t;
      if (value === '{' || value === '}' || value === '(') return -1;
    }
    return -1;
  }

  /** `: SEMANTIC` / `: register(t0)` / `: packoffset(c0)` を読む。 */
  private parseSemanticSuffix(target: { semantic?: string; semanticStart?: number }): void {
    while (this.isValue(':')) {
      const next = this.peek(1);
      if (!next || next.kind !== 'ident') return;
      this.i += 2;
      this.unit.semanticOffsets.add(next.start);
      if (next.value === 'register' || next.value === 'packoffset') {
        if (this.isValue('(')) {
          const close = this.matchOf(this.i);
          for (let t = this.i; t <= close; t++) this.unit.semanticOffsets.add(this.tokens[t].start);
          this.i = close + 1;
        }
        continue;
      }
      target.semantic = next.value;
      target.semanticStart = next.start;
    }
  }

  /** 初期化式を `,` / `;` の手前まで読み飛ばす。 */
  private skipExpression(): void {
    while (this.i < this.tokenEnd) {
      const value = this.tokens[this.i].value;
      if (value === '(' || value === '[' || value === '{') {
        this.i = this.matchOf(this.i) + 1;
        continue;
      }
      if (value === ',' || value === ';' || value === '}' || value === ')') return;
      this.i++;
    }
  }

  /** 次の `;` (同じ階層) まで読み飛ばす。`{` があればブロックごと飛ばして終了する。 */
  private skipStatement(): void {
    while (this.i < this.tokenEnd) {
      const value = this.tokens[this.i].value;
      if (value === ';') {
        this.i++;
        return;
      }
      if (value === '{') {
        this.i = this.matchOf(this.i) + 1;
        if (this.isValue(';')) this.i++;
        return;
      }
      if (value === '}') {
        return;
      }
      if (value === '(' || value === '[') {
        this.i = this.matchOf(this.i) + 1;
        continue;
      }
      this.i++;
    }
  }

  private recordDeclaration(type: TypeInfo, variables: HlslVariable[]): void {
    for (const start of type.tokenStarts) this.unit.declarationOffsets.add(start);
    for (const variable of variables) this.unit.declarationOffsets.add(variable.nameStart);
  }

  /* -------------------------------------------------------------------------
   * マクロ呼び出し
   * ----------------------------------------------------------------------- */

  /** 引数リスト `(a, b, c)` を引数ごとのトークン範囲に分割する。現在位置は `(`。 */
  private splitArguments(openIndex: number): Array<{ from: number; to: number }> {
    const close = this.matchOf(openIndex);
    const args: Array<{ from: number; to: number }> = [];
    let from = openIndex + 1;
    for (let t = openIndex + 1; t < close; t++) {
      const value = this.tokens[t].value;
      if (value === '(' || value === '[' || value === '{') {
        t = this.matchOf(t);
        continue;
      }
      if (value === ',') {
        args.push({ from, to: t });
        from = t + 1;
      }
    }
    if (from < close || args.length > 0) args.push({ from, to: close });
    return args;
  }

  private argumentText(arg: { from: number; to: number }): string {
    if (arg.from >= arg.to) return '';
    return this.text.substring(this.tokens[arg.from].start, this.tokens[arg.to - 1].end).replace(/\s+/g, '');
  }

  private singleIdentifier(arg: { from: number; to: number }): Token | undefined {
    if (arg.to - arg.from !== 1) return undefined;
    const token = this.tokens[arg.from];
    return token.kind === 'ident' ? token : undefined;
  }

  /**
   * トップレベル/struct/cbuffer内の `NAME(args) [;]` を読む。宣言マクロなら変数を登録する。
   * @returns 何らかの変数を宣言した場合true
   */
  private parseTopLevelMacroCall(sink: HlslVariable[]): boolean {
    const nameToken = this.tok()!;
    const openIndex = this.i + 1;
    const close = this.matchOf(openIndex);
    const args = this.splitArguments(openIndex);
    this.i = close + 1;
    if (this.isValue(';')) this.i++;

    const known = DECLARATION_MACROS[nameToken.value];
    let declared = false;
    const declare = (name: Token, type: string): void => {
      const variable: HlslVariable = {
        name: name.value,
        nameStart: name.start,
        nameEnd: name.end,
        type,
        typeStart: nameToken.start,
        typeEnd: nameToken.end,
        arrayDims: 0,
        qualifiers: [],
        start: nameToken.start,
        end: this.tokens[close]?.end ?? name.end,
        fromMacro: nameToken.value,
      };
      sink.push(variable);
      this.unit.declarationOffsets.add(name.start);
      declared = true;
    };

    if (known) {
      const nameArg = args[known.nameArg >= 0 ? known.nameArg : args.length - 1];
      const name = nameArg ? this.singleIdentifier(nameArg) : undefined;
      if (name) {
        let type = known.type;
        if (known.typeArg !== undefined && args[known.typeArg]) {
          const typeArg = this.argumentText(args[known.typeArg]);
          type = type ? `${type}<${typeArg}>` : typeArg;
          for (let t = args[known.typeArg].from; t < args[known.typeArg].to; t++) {
            this.unit.declarationOffsets.add(this.tokens[t].start);
          }
        }
        declare(name, type);
        if (known.extraSampler) {
          sink.push({
            name: `sampler${name.value}`,
            nameStart: name.start,
            nameEnd: name.end,
            type: 'SamplerState',
            typeStart: nameToken.start,
            typeEnd: nameToken.end,
            arrayDims: 0,
            qualifiers: [],
            start: nameToken.start,
            end: name.end,
            fromMacro: nameToken.value,
          });
        }
      }
      return declared;
    }

    // 未知のテクスチャ宣言マクロ(TEXTURE2D_XXX(name) 等)は最後の識別子引数を宣言名とみなす。
    if (/^(RW_)?TEXTURE(2D|3D|CUBE)/.test(nameToken.value) || /^SAMPLER(_CMP)?$/.test(nameToken.value)) {
      const lastArg = args[args.length - 1];
      const name = lastArg ? this.singleIdentifier(lastArg) : undefined;
      if (name) declare(name, nameToken.value.startsWith('SAMPLER') ? 'SamplerState' : 'Texture2D');
    }
    return declared;
  }

  /* -------------------------------------------------------------------------
   * struct / cbuffer / typedef
   * ----------------------------------------------------------------------- */

  private parseStructDeclaration(): void {
    const start = this.tokens[this.i].start;
    this.i++;
    const nameToken = this.tok()?.kind === 'ident' ? this.tok()! : undefined;
    if (nameToken) this.i++;
    if (this.isValue(':')) {
      // 継承 `struct A : B`
      while (this.i < this.tokenEnd && !this.isValue('{') && !this.isValue(';')) this.i++;
    }
    if (!this.isValue('{')) {
      // 前方宣言 `struct Foo;` または `struct Foo x;`
      if (nameToken && this.tok()?.kind === 'ident') {
        const type: TypeInfo = {
          text: nameToken.value,
          start: nameToken.start,
          end: nameToken.end,
          tokenStarts: [nameToken.start],
        };
        const variables = this.parseDeclarators(type, [], start, true);
        if (variables) {
          this.unit.globals.push(...variables);
          return;
        }
      }
      this.skipStatement();
      return;
    }
    const struct = this.parseStructBody(nameToken, start);
    if (struct.name) {
      this.unit.structs.push(struct);
    }
    // `struct Foo { ... } a, b;`
    if (this.tok()?.kind === 'ident' && nameToken) {
      const type: TypeInfo = {
        text: nameToken.value,
        start: nameToken.start,
        end: nameToken.end,
        tokenStarts: [],
      };
      const variables = this.parseDeclarators(type, [], start, true);
      if (variables) {
        this.unit.globals.push(...variables);
        return;
      }
    }
    if (this.isValue(';')) this.i++;
  }

  /** 現在位置は `{`。 */
  private parseStructBody(nameToken: Token | undefined, start: number): HlslStruct {
    const open = this.i;
    const close = this.matchOf(open);
    const struct: HlslStruct = {
      kind: 'struct',
      name: nameToken?.value ?? '',
      nameStart: nameToken?.start ?? start,
      nameEnd: nameToken?.end ?? start,
      fields: [],
      hasUnknownMembers: false,
      methods: [],
      start,
      end: this.tokens[close]?.end ?? this.unit.end,
    };
    if (nameToken) this.unit.declarationOffsets.add(nameToken.start);
    this.i = open + 1;
    while (this.i < close) {
      const token = this.tokens[this.i];
      if (token.value === ';') {
        this.i++;
        continue;
      }
      if (token.value === '[') {
        this.i = this.matchOf(this.i) + 1;
        continue;
      }
      if (token.kind === 'ident' && FIELD_MACROS[token.value]) {
        this.addFieldMacro(struct, token);
        continue;
      }
      if (token.kind === 'ident' && token.value === 'struct' && this.peekValue(2) === '{') {
        // ネストした構造体
        const nestedName = this.peek(1)!;
        this.i += 2;
        const nested = this.parseStructBody(nestedName, token.start);
        this.unit.structs.push(nested);
        if (this.tok()?.kind === 'ident') {
          const type: TypeInfo = { text: nestedName.value, start: nestedName.start, end: nestedName.end, tokenStarts: [] };
          const fields = this.parseDeclarators(type, [], token.start, true);
          if (fields) struct.fields.push(...fields);
        }
        continue;
      }
      if (token.kind === 'ident' && this.peekValue(1) === '(') {
        const before = struct.fields.length;
        this.parseTopLevelMacroCall(struct.fields);
        if (struct.fields.length === before) struct.hasUnknownMembers = true;
        continue;
      }
      const before = this.i;
      if (this.parseStructMember(struct)) {
        continue;
      }
      this.i = before;
      if (token.kind === 'ident' && /^[A-Z0-9_]+$/.test(token.value)) {
        // 引数なしマクロ(UNITY_VERTEX_INPUT_INSTANCE_ID のような未知のもの)
        struct.hasUnknownMembers = true;
        this.i++;
        continue;
      }
      this.skipStatement();
      if (this.i <= before) this.i = before + 1;
    }
    this.i = close + 1;
    return struct;
  }

  private addFieldMacro(struct: HlslStruct, token: Token): void {
    const definitions = FIELD_MACROS[token.value];
    let args: Array<{ from: number; to: number }> = [];
    let end = token.end;
    this.i++;
    if (this.isValue('(')) {
      args = this.splitArguments(this.i);
      const close = this.matchOf(this.i);
      end = this.tokens[close].end;
      this.i = close + 1;
    }
    if (this.isValue(';')) this.i++;
    for (const definition of definitions) {
      let name: string;
      let nameStart = token.start;
      let nameEnd = token.end;
      if (typeof definition.name === 'number') {
        const arg = args[definition.name];
        const ident = arg ? this.singleIdentifier(arg) : undefined;
        if (!ident) continue;
        name = ident.value;
        nameStart = ident.start;
        nameEnd = ident.end;
        this.unit.declarationOffsets.add(ident.start);
      } else {
        name = definition.name;
      }
      struct.fields.push({
        name,
        nameStart,
        nameEnd,
        type: definition.type,
        typeStart: token.start,
        typeEnd: token.end,
        arrayDims: 0,
        qualifiers: [],
        start: token.start,
        end,
        fromMacro: token.value,
      });
    }
  }

  private parseStructMember(struct: HlslStruct): boolean {
    const start = this.i;
    const qualifiers = this.parseQualifiers();
    const type = this.parseType();
    if (!type) {
      this.i = start;
      return false;
    }
    const nameToken = this.tok();
    if (!nameToken || nameToken.kind !== 'ident') {
      this.i = start;
      return false;
    }
    if (this.peekValue(1) === '(') {
      // メソッド
      this.i++;
      struct.methods.push(this.parseFunction(type, nameToken, qualifiers, this.tokens[start].start, false));
      return true;
    }
    const fields = this.parseDeclarators(type, qualifiers, this.tokens[start].start, true);
    if (!fields) {
      this.i = start;
      return false;
    }
    struct.fields.push(...fields);
    return true;
  }

  private parseCBuffer(): void {
    const keyword = this.tokens[this.i];
    this.i++;
    const nameToken = this.tok()?.kind === 'ident' ? this.tok()! : undefined;
    if (!nameToken) {
      this.skipStatement();
      return;
    }
    this.i++;
    this.unit.declarationOffsets.add(nameToken.start);
    const holder: { semantic?: string } = {};
    this.parseSemanticSuffix(holder);
    if (!this.isValue('{')) {
      this.skipStatement();
      return;
    }
    const close = this.matchOf(this.i);
    const cbuffer: HlslCBuffer = {
      kind: 'cbuffer',
      name: nameToken.value,
      nameStart: nameToken.start,
      nameEnd: nameToken.end,
      fields: [],
      style: keyword.value === 'tbuffer' ? 'tbuffer' : 'cbuffer',
      start: keyword.start,
      end: this.tokens[close]?.end ?? this.unit.end,
    };
    this.i++;
    this.parseBufferMembers(cbuffer, close);
    this.i = close + 1;
    if (this.isValue(';')) this.i++;
    this.unit.cbuffers.push(cbuffer);
  }

  private parseMacroBuffer(endMacro: string): void {
    const keyword = this.tokens[this.i];
    const args = this.splitArguments(this.i + 1);
    const nameToken = args[0] ? this.singleIdentifier(args[0]) : undefined;
    this.i = this.matchOf(this.i + 1) + 1;
    // CBUFFER_END までを探す(同じ単位内)。
    let endIndex = this.tokenEnd;
    for (let t = this.i; t < this.tokenEnd; t++) {
      if (this.tokens[t].kind === 'ident' && this.tokens[t].value === endMacro) {
        endIndex = t;
        break;
      }
      if (this.tokens[t].value === '{') t = this.matchOf(t);
    }
    if (endIndex === this.tokenEnd) {
      this.issue(keyword.start, keyword.end, `${keyword.value} に対応する ${endMacro} がありません。`, 'error');
    }
    const cbuffer: HlslCBuffer = {
      kind: 'cbuffer',
      name: nameToken?.value ?? '',
      nameStart: nameToken?.start ?? keyword.start,
      nameEnd: nameToken?.end ?? keyword.end,
      fields: [],
      style: 'macro',
      start: keyword.start,
      end: this.tokens[Math.min(endIndex, this.tokenEnd - 1)]?.end ?? this.unit.end,
    };
    if (nameToken) this.unit.declarationOffsets.add(nameToken.start);
    this.parseBufferMembers(cbuffer, endIndex);
    this.i = endIndex;
    if (this.i < this.tokenEnd) {
      this.i++;
      if (this.isValue('(')) this.i = this.matchOf(this.i) + 1;
      if (this.isValue(';')) this.i++;
    }
    this.unit.cbuffers.push(cbuffer);
  }

  private parseBufferMembers(cbuffer: HlslCBuffer, endIndex: number): void {
    while (this.i < endIndex) {
      const token = this.tokens[this.i];
      if (token.value === ';') {
        this.i++;
        continue;
      }
      if (token.kind === 'ident' && this.peekValue(1) === '(') {
        this.parseTopLevelMacroCall(cbuffer.fields);
        continue;
      }
      const before = this.i;
      if (!this.parseDeclaration('cbuffer', cbuffer.fields)) {
        this.i = before;
        this.skipStatement();
        if (this.i <= before) this.i = before + 1;
      }
    }
  }

  private parseTypedef(): void {
    const start = this.tokens[this.i].start;
    this.i++;
    if (this.isValue('struct') && (this.peekValue(1) === '{' || this.peekValue(2) === '{')) {
      const structStart = this.tokens[this.i].start;
      this.i++;
      const tagName = this.tok()?.kind === 'ident' ? this.tok()! : undefined;
      if (tagName) this.i++;
      const struct = this.parseStructBody(tagName, structStart);
      const alias = this.tok();
      if (alias?.kind === 'ident') {
        struct.name = alias.value;
        struct.nameStart = alias.start;
        struct.nameEnd = alias.end;
        this.unit.declarationOffsets.add(alias.start);
        this.i++;
      }
      if (struct.name) this.unit.structs.push(struct);
      if (this.isValue(';')) this.i++;
      return;
    }
    this.parseQualifiers();
    const type = this.parseType();
    const nameToken = this.tok();
    if (!type || !nameToken || nameToken.kind !== 'ident') {
      this.skipStatement();
      return;
    }
    this.i++;
    while (this.isValue('[')) this.i = this.matchOf(this.i) + 1;
    const typedef: HlslTypedef = {
      kind: 'typedef',
      name: nameToken.value,
      nameStart: nameToken.start,
      nameEnd: nameToken.end,
      type: type.text,
      start,
      end: nameToken.end,
    };
    for (const typeStart of type.tokenStarts) this.unit.declarationOffsets.add(typeStart);
    this.unit.declarationOffsets.add(nameToken.start);
    if (this.isValue(';')) {
      typedef.end = this.tokens[this.i].end;
      this.i++;
    }
    this.unit.typedefs.push(typedef);
  }

  /* -------------------------------------------------------------------------
   * 関数
   * ----------------------------------------------------------------------- */

  /** 現在位置は `(`。 */
  private parseFunction(
    returnType: TypeInfo,
    nameToken: Token,
    _qualifiers: string[],
    start: number,
    register: boolean,
  ): HlslFunction {
    const open = this.i;
    const close = this.matchOf(open);
    const fn: HlslFunction = {
      kind: 'function',
      name: nameToken.value,
      nameStart: nameToken.start,
      nameEnd: nameToken.end,
      returnType: returnType.text,
      returnTypeStart: returnType.start,
      params: this.parseParameters(open),
      // 引数リスト内に #if がある場合は引数の数が条件次第で変わる。
      paramsIncomplete: this.lastParamsIncomplete || this.hasDirectiveBetween(this.tokens[open].start, this.tokens[close]?.end ?? this.unit.end),
      locals: [],
      start,
      end: this.tokens[close]?.end ?? nameToken.end,
    };
    for (const typeStart of returnType.tokenStarts) this.unit.declarationOffsets.add(typeStart);
    this.unit.declarationOffsets.add(nameToken.start);
    this.i = close + 1;
    this.parseSemanticSuffix(fn);
    if (this.isValue('{')) {
      const bodyClose = this.matchOf(this.i);
      fn.bodyStart = this.tokens[this.i].start;
      fn.bodyEnd = this.tokens[bodyClose]?.end ?? this.unit.end;
      fn.end = fn.bodyEnd;
      this.parseLocals(fn, this.i, bodyClose);
      this.i = bodyClose + 1;
    } else if (this.isValue(';')) {
      fn.end = this.tokens[this.i].end;
      this.i++;
    } else if (this.tok()?.kind === 'ident' && this.peekValue(1) === '(') {
      // 本体がマクロ `void F(int v) PRINT1(...)` の場合
      const macroClose = this.matchOf(this.i + 1);
      fn.end = this.tokens[macroClose]?.end ?? fn.end;
      this.i = macroClose + 1;
      if (this.isValue(';')) this.i++;
    } else {
      this.skipStatement();
    }
    if (register) {
      this.unit.functions.push(fn);
    }
    return fn;
  }

  private parseParameters(open: number): HlslParameter[] {
    this.lastParamsIncomplete = false;
    const params: HlslParameter[] = [];
    for (const arg of this.splitArguments(open)) {
      if (arg.from >= arg.to) continue;
      const first = this.tokens[arg.from];
      if (arg.to - arg.from === 1 && first.value === 'void') continue;

      // TEXTURE2D_PARAM(tex, sampler) / TEXTURE2D(tex) のように、マクロで引数を宣言する。
      if (
        first.kind === 'ident' &&
        this.tokens[arg.from + 1]?.value === '(' &&
        this.matchOf(arg.from + 1) === arg.to - 1
      ) {
        const macroTypes = paramMacroTypes(first.value) ?? [guessMacroDeclarationType(first.value)];
        const inner = this.splitArguments(arg.from + 1);
        inner.forEach((innerArg, index) => {
          const ident = this.singleIdentifier(innerArg);
          if (!ident) return;
          this.unit.declarationOffsets.add(ident.start);
          params.push({
            name: ident.value,
            nameStart: ident.start,
            nameEnd: ident.end,
            type: macroTypes[Math.min(index, macroTypes.length - 1)],
            typeStart: first.start,
            typeEnd: first.end,
            arrayDims: 0,
            qualifiers: [],
            hasDefault: false,
            start: first.start,
            end: this.tokens[arg.to - 1].end,
            fromMacro: first.value,
          });
        });
        continue;
      }

      const saveI = this.i;
      this.i = arg.from;
      let qualifier: ParameterQualifier | undefined;
      const qualifiers: string[] = [];
      while (this.i < arg.to && this.tok()?.kind === 'ident' && DECLARATION_QUALIFIERS.has(this.tok()!.value)) {
        if (this.peek(1)?.kind !== 'ident' || this.i + 1 >= arg.to) break;
        const value = this.tok()!.value;
        qualifiers.push(value);
        if (value === 'in' || value === 'out' || value === 'inout' || value === 'uniform') qualifier = value;
        this.i++;
      }
      const type = this.parseType();
      const nameToken = this.tok();
      if (type && nameToken && nameToken.kind === 'ident' && this.i < arg.to) {
        this.i++;
        const param: HlslParameter = {
          name: nameToken.value,
          nameStart: nameToken.start,
          nameEnd: nameToken.end,
          type: type.text,
          typeStart: type.start,
          typeEnd: type.end,
          arrayDims: 0,
          qualifiers,
          qualifier,
          hasDefault: false,
          start: first.start,
          end: this.tokens[arg.to - 1].end,
        };
        while (this.i < arg.to && this.isValue('[')) {
          param.arrayDims++;
          this.i = this.matchOf(this.i) + 1;
        }
        this.parseSemanticSuffix(param);
        for (let t = this.i; t < arg.to; t++) {
          if (this.tokens[t].value === '=') {
            param.hasDefault = true;
            break;
          }
        }
        for (const typeStart of type.tokenStarts) this.unit.declarationOffsets.add(typeStart);
        this.unit.declarationOffsets.add(nameToken.start);
        params.push(param);
      } else {
        // 解析できない引数(未知のマクロ等)がある関数は引数の数を検査しない。
        this.lastParamsIncomplete = true;
      }
      this.i = saveI;
    }
    return params;
  }

  /**
   * 関数本体からローカル変数を抽出する。完全な文解析は行わず、文の先頭で
   * `型 名前` の並びを宣言として扱う。
   */
  private parseLocals(fn: HlslFunction, open: number, close: number): void {
    const scopeEnds: number[] = [this.tokens[close]?.end ?? this.unit.end];
    /** この位置のトークンから新しい文が始まる。 */
    const statementStarts = new Set<number>();
    let statementStart = true;
    for (let t = open + 1; t < close; t++) {
      const token = this.tokens[t];
      if (statementStarts.has(t)) statementStart = true;
      if (token.kind === 'punct') {
        if (token.value === '{') {
          scopeEnds.push(this.tokens[this.matchOf(t)]?.end ?? this.unit.end);
          statementStart = true;
        } else if (token.value === '}') {
          if (scopeEnds.length > 1) scopeEnds.pop();
          statementStart = true;
        } else if (token.value === ';') {
          statementStart = true;
        } else if (token.value === '[' && statementStart) {
          t = this.matchOf(t);
        } else if (token.value === ':' && statementStart) {
          // case ラベル後
        } else {
          statementStart = false;
        }
        continue;
      }
      if (!statementStart || token.kind !== 'ident') {
        statementStart = false;
        continue;
      }

      if (token.value === 'for' && this.tokens[t + 1]?.value === '(') {
        const parenClose = this.matchOf(t + 1);
        const loopEnd = this.statementEnd(parenClose + 1, close);
        this.tryParseLocal(fn, t + 2, parenClose, loopEnd);
        t = parenClose;
        statementStart = true;
        continue;
      }
      if ((token.value === 'if' || token.value === 'while' || token.value === 'switch') && this.tokens[t + 1]?.value === '(') {
        t = this.matchOf(t + 1);
        statementStart = true;
        continue;
      }
      if (token.value === 'else' || token.value === 'do') {
        statementStart = true;
        continue;
      }
      if (token.value === 'case' || token.value === 'default') {
        while (t < close && this.tokens[t].value !== ':') t++;
        statementStart = true;
        continue;
      }
      const declarationEnd = this.tryParseLocal(fn, t, close, scopeEnds[scopeEnds.length - 1]);
      if (declarationEnd >= 0) {
        t = declarationEnd;
        statementStart = true;
        continue;
      }
      // `UNITY_UNROLL for (...)` のような制御文の前置マクロ
      const next = this.tokens[t + 1];
      statementStart = !!next && next.kind === 'ident' && CONTROL_KEYWORDS.has(next.value);
    }
  }

  /** 文の終端(ブロックなら閉じ括弧、それ以外は `;`)のoffset。 */
  private statementEnd(index: number, limit: number): number {
    if (this.tokens[index]?.value === '{') {
      return this.tokens[this.matchOf(index)]?.end ?? this.unit.end;
    }
    for (let t = index; t < limit; t++) {
      const value = this.tokens[t].value;
      if (value === '(' || value === '[' || value === '{') {
        t = this.matchOf(t);
        continue;
      }
      if (value === ';') return this.tokens[t].end;
    }
    return this.tokens[limit]?.end ?? this.unit.end;
  }

  /**
   * index位置からローカル変数宣言を試す。
   * @returns 宣言の終端 `;` のindex。宣言でなければ -1。
   */
  private tryParseLocal(fn: HlslFunction, index: number, limit: number, scopeEnd: number): number {
    const saveI = this.i;
    this.i = index;
    try {
      const qualifiers = this.parseQualifiers();
      const type = this.parseType();
      if (!type || this.i >= limit) return -1;
      const nameToken = this.tok();
      if (!nameToken || nameToken.kind !== 'ident' || STATEMENT_KEYWORDS.has(nameToken.value)) return -1;
      const after = this.peek(1)?.value;
      if (after !== ';' && after !== '=' && after !== ',' && after !== '[' && after !== ':') return -1;
      const variables = this.parseDeclarators(type, qualifiers, type.start, false);
      if (!variables) return -1;
      for (const variable of variables) {
        const local: HlslLocal = { ...variable, scopeStart: variable.nameStart, scopeEnd };
        fn.locals.push(local);
      }
      return this.i - 1;
    } finally {
      this.i = saveI;
    }
  }

  /* -------------------------------------------------------------------------
   * 補助
   * ----------------------------------------------------------------------- */

  private hasDirectiveBetween(start: number, end: number): boolean {
    for (const directive of this.directives) {
      if (directive.start > end) return false;
      if (directive.start >= start) return true;
    }
    return false;
  }

  private tok(): Token | undefined {
    return this.i < this.tokenEnd ? this.tokens[this.i] : undefined;
  }

  private peek(offset: number): Token | undefined {
    const index = this.i + offset;
    return index < this.tokenEnd ? this.tokens[index] : undefined;
  }

  private peekValue(offset: number): string | undefined {
    return this.peek(offset)?.value;
  }

  private isValue(value: string): boolean {
    return this.tok()?.value === value;
  }

  private issue(start: number, end: number, message: string, severity: 'error' | 'warning'): void {
    this.unit.issues.push({ start, end, message, severity });
  }
}
