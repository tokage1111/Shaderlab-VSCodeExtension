/**
 * 解析結果の構造。位置はすべてファイル先頭からのoffset。
 * ShaderLab内のHLSLブロックも同じoffset基準で保持するため、座標変換は不要。
 */

export interface Spanned {
  start: number;
  end: number;
}

export interface NameSpan {
  name: string;
  nameStart: number;
  nameEnd: number;
}

export type ParameterQualifier = 'in' | 'out' | 'inout' | 'uniform';

export interface HlslVariable extends Spanned, NameSpan {
  /** 修飾子を除いた型名(テンプレート引数を含む)。例: `Texture2D<float4>`。 */
  type: string;
  typeStart: number;
  typeEnd: number;
  /** 配列の次元数。 */
  arrayDims: number;
  semantic?: string;
  semanticStart?: number;
  qualifiers: string[];
  /** マクロ(TEXTURE2D(...)等)から推定した宣言。 */
  fromMacro?: string;
  /** 初期化式の範囲(`= ...` の右辺)。 */
  initStart?: number;
  initEnd?: number;
}

export interface HlslParameter extends HlslVariable {
  qualifier?: ParameterQualifier;
  hasDefault: boolean;
}

export interface HlslLocal extends HlslVariable {
  /** 宣言が有効な範囲。 */
  scopeStart: number;
  scopeEnd: number;
}

export interface HlslFunction extends Spanned, NameSpan {
  kind: 'function';
  returnType: string;
  returnTypeStart: number;
  params: HlslParameter[];
  /** 解析できない引数宣言(未知のマクロ等)を含む。 */
  paramsIncomplete: boolean;
  semantic?: string;
  bodyStart?: number;
  bodyEnd?: number;
  locals: HlslLocal[];
}

export interface HlslStruct extends Spanned, NameSpan {
  kind: 'struct';
  fields: HlslVariable[];
  /** 展開できないマクロがメンバーとして含まれる(存在しないメンバーの判定を控える)。 */
  hasUnknownMembers: boolean;
  /** メンバー関数。 */
  methods: HlslFunction[];
}

export interface HlslCBuffer extends Spanned, NameSpan {
  kind: 'cbuffer';
  fields: HlslVariable[];
  style: 'cbuffer' | 'tbuffer' | 'macro';
}

export interface HlslTypedef extends Spanned, NameSpan {
  kind: 'typedef';
  type: string;
}

export interface HlslMacro extends Spanned, NameSpan {
  kind: 'macro';
  /** 関数形式マクロのパラメータ。オブジェクト形式ならundefined。 */
  params?: string[];
  body: string;
}

export interface HlslInclude extends Spanned {
  path: string;
  pathStart: number;
  pathEnd: number;
  withPragmas: boolean;
  /** #if 等の条件付きコンパイルの内側にある。 */
  conditional: boolean;
  angle: boolean;
  /** cbuffer の内側に書かれた include。include先の変数はこの cbuffer のメンバーになる。 */
  cbuffer?: HlslCBuffer;
}

export interface HlslPragmaArg {
  value: string;
  start: number;
  end: number;
}

export interface HlslPragma extends Spanned {
  /** `vertex`, `fragment`, `multi_compile` など。 */
  name: string;
  nameStart: number;
  nameEnd: number;
  args: HlslPragmaArg[];
}

export interface TextFixEdit extends Spanned {
  newText: string;
}

/** 診断をテキストの書き換えだけで解決できる場合の修正(クイックフィックス)。 */
export interface TextFix {
  title: string;
  edits: TextFixEdit[];
  /** 最も確からしい修正(VS Codeの「優先される修正」)。 */
  preferred?: boolean;
}

export interface ParseIssue extends Spanned {
  message: string;
  severity: 'error' | 'warning';
  fixes?: TextFix[];
}

/** HLSLの翻訳単位の断片(HLSLファイル全体、またはShaderLab内の1ブロック)。 */
export interface HlslUnit extends Spanned {
  /** ファイルのトークン配列上の範囲 [tokenStart, tokenEnd)。 */
  tokenStart: number;
  tokenEnd: number;
  functions: HlslFunction[];
  structs: HlslStruct[];
  cbuffers: HlslCBuffer[];
  globals: HlslVariable[];
  typedefs: HlslTypedef[];
  macros: HlslMacro[];
  includes: HlslInclude[];
  pragmas: HlslPragma[];
  /** 宣言名・型名・セマンティクスなど、識別子参照として扱わないトークンの開始offset。 */
  declarationOffsets: Set<number>;
  /** セマンティクス/register等のトークン開始offset。 */
  semanticOffsets: Set<number>;
  issues: ParseIssue[];
}

/* ---------------------------------------------------------------------------
 * ShaderLab
 * ------------------------------------------------------------------------- */

export interface ShaderProperty extends Spanned, NameSpan {
  displayName: string;
  /** Range(0,1) / Color / 2D など、書かれたままの型。 */
  type: string;
  /** Range / Float / Int / Color / Vector / 2D / 3D / Cube / 2DArray / CubeArray など正規化した型。 */
  typeKind: string;
  typeStart: number;
  typeEnd: number;
  defaultValue: string;
  attributes: string[];
}

export interface ShaderTag {
  key: string;
  value: string;
  keyStart: number;
  keyEnd: number;
  valueStart: number;
  valueEnd: number;
}

export type ShaderBlockKind = 'HLSLPROGRAM' | 'HLSLINCLUDE' | 'CGPROGRAM' | 'CGINCLUDE' | 'GLSLPROGRAM';

export interface ShaderHlslBlock extends Spanned {
  kind: ShaderBlockKind;
  /** コード部分(開始マーカーの直後から終了マーカーの直前まで)。 */
  codeStart: number;
  codeEnd: number;
  terminated: boolean;
  unit: HlslUnit;
  /** 所属するSubShader/Passのindex。Shader直下ならundefined。 */
  subShaderIndex?: number;
  passIndex?: number;
}

export type ShaderSectionKind =
  | 'Shader'
  | 'Properties'
  | 'SubShader'
  | 'Pass'
  | 'Tags'
  | 'Stencil'
  | 'Category'
  | 'PackageRequirements'
  | 'Other';

export interface ShaderSection extends Spanned {
  kind: ShaderSectionKind;
}

export interface ShaderPass extends Spanned {
  name?: string;
  nameStart?: number;
  nameEnd?: number;
  tags: ShaderTag[];
}

export interface ShaderSubShader extends Spanned {
  tags: ShaderTag[];
  passes: ShaderPass[];
}

export interface ShaderDocument {
  name?: string;
  nameStart?: number;
  nameEnd?: number;
  properties: ShaderProperty[];
  propertiesSpan?: Spanned;
  subShaders: ShaderSubShader[];
  blocks: ShaderHlslBlock[];
  sections: ShaderSection[];
  issues: ParseIssue[];
}
