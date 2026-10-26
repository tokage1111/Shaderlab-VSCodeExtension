/**
 * HLSL / ShaderLab / URP の組み込み定義。
 * 補完・Hover・診断・セマンティックトークンで共通に使う。
 */

/* ---------------------------------------------------------------------------
 * 型
 * ------------------------------------------------------------------------- */

export const SCALAR_TYPES = [
  'bool',
  'int',
  'uint',
  'dword',
  'half',
  'float',
  'double',
  'min16float',
  'min10float',
  'min16int',
  'min12int',
  'min16uint',
  'int16_t',
  'uint16_t',
  'int64_t',
  'uint64_t',
  'float16_t',
  'float32_t',
  'float64_t',
  // Unity Built-in RP (CG) の型
  'fixed',
] as const;

const SCALAR_SET = new Set<string>(SCALAR_TYPES);

export interface NumericType {
  scalar: string;
  /** スカラーなら1、ベクトルなら次元数。 */
  rows: number;
  /** 行列の列数。行列でなければ0。 */
  columns: number;
}

const NUMERIC_PATTERN = new RegExp(`^(${SCALAR_TYPES.join('|')})([1-4])?(?:x([1-4]))?$`);

/** float3 / half4x4 / int などを分解する。 */
export function parseNumericType(name: string): NumericType | undefined {
  const match = NUMERIC_PATTERN.exec(name);
  if (!match) return undefined;
  if (match[3] !== undefined) {
    if (match[2] === undefined) return undefined;
    return { scalar: match[1], rows: Number(match[2]), columns: Number(match[3]) };
  }
  return { scalar: match[1], rows: match[2] === undefined ? 1 : Number(match[2]), columns: 0 };
}

export function formatNumericType(type: NumericType): string {
  if (type.columns > 0) return `${type.scalar}${type.rows}x${type.columns}`;
  if (type.rows <= 1) return type.scalar;
  return `${type.scalar}${type.rows}`;
}

export const OBJECT_TYPES = new Set([
  'void',
  'vector',
  'matrix',
  'string',
  'sampler',
  'sampler1D',
  'sampler2D',
  'sampler3D',
  'samplerCUBE',
  'sampler2D_half',
  'sampler2D_float',
  'samplerCUBE_half',
  'samplerCUBE_float',
  'sampler_state',
  'SamplerState',
  'SamplerComparisonState',
  'Texture',
  'Texture1D',
  'Texture1DArray',
  'Texture2D',
  'Texture2DArray',
  'Texture2DMS',
  'Texture2DMSArray',
  'Texture3D',
  'TextureCube',
  'TextureCubeArray',
  'RWTexture1D',
  'RWTexture1DArray',
  'RWTexture2D',
  'RWTexture2DArray',
  'RWTexture3D',
  'RasterizerOrderedTexture1D',
  'RasterizerOrderedTexture1DArray',
  'RasterizerOrderedTexture2D',
  'RasterizerOrderedTexture2DArray',
  'RasterizerOrderedTexture3D',
  'Buffer',
  'RWBuffer',
  'RasterizerOrderedBuffer',
  'ByteAddressBuffer',
  'RWByteAddressBuffer',
  'RasterizerOrderedByteAddressBuffer',
  'StructuredBuffer',
  'RWStructuredBuffer',
  'RasterizerOrderedStructuredBuffer',
  'AppendStructuredBuffer',
  'ConsumeStructuredBuffer',
  'ConstantBuffer',
  'TextureBuffer',
  'InputPatch',
  'OutputPatch',
  'PointStream',
  'LineStream',
  'TriangleStream',
  'RaytracingAccelerationStructure',
  'RayDesc',
  'RayQuery',
  'BuiltInTriangleIntersectionAttributes',
  'FeedbackTexture2D',
  'FeedbackTexture2DArray',
]);

export function isBuiltinType(name: string): boolean {
  return OBJECT_TYPES.has(name) || SCALAR_SET.has(name) || parseNumericType(name) !== undefined;
}

/** 補完に出す代表的な組み込み型。 */
export const COMPLETION_TYPES: string[] = (() => {
  const result: string[] = [];
  for (const scalar of ['bool', 'int', 'uint', 'half', 'float', 'double', 'min16float', 'fixed']) {
    result.push(scalar);
    for (let n = 2; n <= 4; n++) result.push(`${scalar}${n}`);
  }
  for (const scalar of ['half', 'float']) {
    for (let r = 2; r <= 4; r++) for (let c = 2; c <= 4; c++) result.push(`${scalar}${r}x${c}`);
  }
  for (const type of OBJECT_TYPES) {
    if (!result.includes(type)) result.push(type);
  }
  return result;
})();

/* ---------------------------------------------------------------------------
 * キーワード
 * ------------------------------------------------------------------------- */

export const CONTROL_KEYWORDS = [
  'if',
  'else',
  'for',
  'while',
  'do',
  'switch',
  'case',
  'default',
  'break',
  'continue',
  'return',
  'discard',
  'goto',
];

export const STORAGE_KEYWORDS = [
  'struct',
  'class',
  'interface',
  'cbuffer',
  'tbuffer',
  'typedef',
  'namespace',
  'template',
  'typename',
  'enum',
  'static',
  'const',
  'uniform',
  'extern',
  'volatile',
  'precise',
  'shared',
  'groupshared',
  'globallycoherent',
  'row_major',
  'column_major',
  'inline',
  'in',
  'out',
  'inout',
  'nointerpolation',
  'linear',
  'centroid',
  'noperspective',
  'sample',
  'snorm',
  'unorm',
  'point',
  'line',
  'triangle',
  'lineadj',
  'triangleadj',
  'register',
  'packoffset',
  'unsigned',
  'export',
];

export const LITERAL_KEYWORDS = ['true', 'false', 'NULL', 'this'];

export const HLSL_KEYWORDS = new Set([...CONTROL_KEYWORDS, ...STORAGE_KEYWORDS, ...LITERAL_KEYWORDS, 'sizeof']);

/** 関数の前に付く属性 `[numthreads(8,8,1)]` 等。 */
export const HLSL_ATTRIBUTES = [
  'numthreads',
  'unroll',
  'loop',
  'branch',
  'flatten',
  'forcecase',
  'call',
  'fastopt',
  'allow_uav_condition',
  'maxvertexcount',
  'domain',
  'partitioning',
  'outputtopology',
  'outputcontrolpoints',
  'patchconstantfunc',
  'maxtessfactor',
  'earlydepthstencil',
  'instance',
  'shader',
  'WaveSize',
];

/* ---------------------------------------------------------------------------
 * 組み込み関数
 * ------------------------------------------------------------------------- */

/**
 * 戻り値の型推論ルール。
 * - `argN`: N番目の引数と同じ型
 * - `scalarN`: N番目の引数のスカラー型
 * - `boolN`: N番目の引数と同じ次元のbool
 * - `mul` / `transpose`: 専用ルール
 * - それ以外: 固定の型名
 */
export interface IntrinsicInfo {
  signature: string;
  doc: string;
  minArgs: number;
  maxArgs: number;
  returns: string;
}

function intrinsic(signature: string, doc: string, returns: string, minArgs?: number): IntrinsicInfo {
  const inner = signature.substring(signature.indexOf('(') + 1, signature.lastIndexOf(')')).trim();
  const params = inner.length === 0 ? [] : inner.split(',');
  // `[` 以降の引数は省略可能。
  const bracket = inner.indexOf('[');
  const required = bracket < 0 ? params.length : inner.substring(0, bracket).split(',').filter((p) => p.trim()).length;
  return {
    signature,
    doc,
    returns,
    maxArgs: params.length,
    minArgs: minArgs ?? required,
  };
}

export const INTRINSICS: Record<string, IntrinsicInfo> = {
  abs: intrinsic('T abs(T x)', '絶対値を返します。', 'arg0'),
  acos: intrinsic('T acos(T x)', '逆余弦(アークコサイン)を返します。', 'arg0'),
  all: intrinsic('bool all(T x)', 'すべての成分が0以外ならtrueを返します。', 'bool'),
  any: intrinsic('bool any(T x)', 'いずれかの成分が0以外ならtrueを返します。', 'bool'),
  asdouble: intrinsic('double asdouble(uint lowbits, uint highbits)', 'ビット列をdoubleとして再解釈します。', 'double'),
  asfloat: intrinsic('float asfloat(T x)', 'ビット列をfloatとして再解釈します。', 'float'),
  asin: intrinsic('T asin(T x)', '逆正弦(アークサイン)を返します。', 'arg0'),
  asint: intrinsic('int asint(T x)', 'ビット列をintとして再解釈します。', 'int'),
  asuint: intrinsic('uint asuint(T x[, out uint lowbits, out uint highbits])', 'ビット列をuintとして再解釈します。', 'uint'),
  atan: intrinsic('T atan(T x)', '逆正接(アークタンジェント)を返します。', 'arg0'),
  atan2: intrinsic('T atan2(T y, T x)', 'y/x の逆正接を象限を考慮して返します。', 'arg0'),
  ceil: intrinsic('T ceil(T x)', 'x以上の最小の整数を返します。', 'arg0'),
  clamp: intrinsic('T clamp(T x, T min, T max)', 'xを[min, max]の範囲に制限します。', 'arg0'),
  clip: intrinsic('void clip(T x)', 'いずれかの成分が0未満ならピクセルを破棄します。', 'void'),
  cos: intrinsic('T cos(T x)', '余弦を返します。', 'arg0'),
  cosh: intrinsic('T cosh(T x)', '双曲線余弦を返します。', 'arg0'),
  countbits: intrinsic('uint countbits(uint x)', '1のビット数を返します。', 'arg0'),
  cross: intrinsic('float3 cross(float3 a, float3 b)', '外積を返します。', 'arg0'),
  ddx: intrinsic('T ddx(T x)', 'スクリーン空間x方向の偏微分を返します。', 'arg0'),
  ddx_coarse: intrinsic('T ddx_coarse(T x)', 'x方向の低精度な偏微分を返します。', 'arg0'),
  ddx_fine: intrinsic('T ddx_fine(T x)', 'x方向の高精度な偏微分を返します。', 'arg0'),
  ddy: intrinsic('T ddy(T x)', 'スクリーン空間y方向の偏微分を返します。', 'arg0'),
  ddy_coarse: intrinsic('T ddy_coarse(T x)', 'y方向の低精度な偏微分を返します。', 'arg0'),
  ddy_fine: intrinsic('T ddy_fine(T x)', 'y方向の高精度な偏微分を返します。', 'arg0'),
  degrees: intrinsic('T degrees(T x)', 'ラジアンを度に変換します。', 'arg0'),
  determinant: intrinsic('float determinant(floatNxN m)', '行列式を返します。', 'scalar0'),
  distance: intrinsic('float distance(T a, T b)', '2点間の距離を返します。', 'scalar0'),
  dot: intrinsic('float dot(T a, T b)', '内積を返します。', 'scalar0'),
  dst: intrinsic('float4 dst(float4 a, float4 b)', '距離ベクトルを計算します。', 'float4'),
  exp: intrinsic('T exp(T x)', 'eのx乗を返します。', 'arg0'),
  exp2: intrinsic('T exp2(T x)', '2のx乗を返します。', 'arg0'),
  f16tof32: intrinsic('float f16tof32(uint x)', '半精度ビット列をfloatに変換します。', 'float'),
  f32tof16: intrinsic('uint f32tof16(float x)', 'floatを半精度ビット列に変換します。', 'uint'),
  faceforward: intrinsic('T faceforward(T n, T i, T ng)', '視線に対して表向きの法線を返します。', 'arg0'),
  firstbithigh: intrinsic('int firstbithigh(int x)', '最上位の1ビットの位置を返します。', 'arg0'),
  firstbitlow: intrinsic('int firstbitlow(int x)', '最下位の1ビットの位置を返します。', 'arg0'),
  floor: intrinsic('T floor(T x)', 'x以下の最大の整数を返します。', 'arg0'),
  fma: intrinsic('T fma(T a, T b, T c)', 'a * b + c を融合積和演算で計算します。', 'arg0'),
  fmod: intrinsic('T fmod(T x, T y)', 'x / y の浮動小数点剰余を返します。', 'arg0'),
  frac: intrinsic('T frac(T x)', '小数部を返します。', 'arg0'),
  frexp: intrinsic('T frexp(T x, out T exp)', '仮数部と指数部に分解します。', 'arg0'),
  fwidth: intrinsic('T fwidth(T x)', 'abs(ddx(x)) + abs(ddy(x)) を返します。', 'arg0'),
  isfinite: intrinsic('bool isfinite(T x)', '有限値かどうかを返します。', 'bool0'),
  isinf: intrinsic('bool isinf(T x)', '無限大かどうかを返します。', 'bool0'),
  isnan: intrinsic('bool isnan(T x)', 'NaNかどうかを返します。', 'bool0'),
  ldexp: intrinsic('T ldexp(T x, T exp)', 'x * 2^exp を返します。', 'arg0'),
  length: intrinsic('float length(T v)', 'ベクトルの長さを返します。', 'scalar0'),
  lerp: intrinsic('T lerp(T a, T b, T s)', 'a と b を s で線形補間します。', 'arg0'),
  lit: intrinsic('float4 lit(float n_dot_l, float n_dot_h, float m)', 'ライティング係数を計算します。', 'float4'),
  log: intrinsic('T log(T x)', '自然対数を返します。', 'arg0'),
  log10: intrinsic('T log10(T x)', '常用対数を返します。', 'arg0'),
  log2: intrinsic('T log2(T x)', '2を底とする対数を返します。', 'arg0'),
  mad: intrinsic('T mad(T a, T b, T c)', 'a * b + c を返します。', 'arg0'),
  max: intrinsic('T max(T a, T b)', '大きい方を返します。', 'arg0'),
  min: intrinsic('T min(T a, T b)', '小さい方を返します。', 'arg0'),
  modf: intrinsic('T modf(T x, out T ip)', '整数部と小数部に分解します。', 'arg0'),
  msad4: intrinsic('uint4 msad4(uint reference, uint2 source, uint4 accum)', 'マスク付きSADを計算します。', 'uint4'),
  mul: intrinsic('mul(a, b)', '行列/ベクトルの積を返します。', 'mul'),
  noise: intrinsic('float noise(T x)', 'Perlinノイズを返します(テクスチャシェーダー専用)。', 'float'),
  normalize: intrinsic('T normalize(T v)', '正規化したベクトルを返します。', 'arg0'),
  pow: intrinsic('T pow(T x, T y)', 'xのy乗を返します。', 'arg0'),
  radians: intrinsic('T radians(T x)', '度をラジアンに変換します。', 'arg0'),
  rcp: intrinsic('T rcp(T x)', '逆数(1/x)の近似値を返します。', 'arg0'),
  reflect: intrinsic('T reflect(T i, T n)', '反射ベクトルを返します。', 'arg0'),
  refract: intrinsic('T refract(T i, T n, float eta)', '屈折ベクトルを返します。', 'arg0'),
  reversebits: intrinsic('uint reversebits(uint x)', 'ビット順を反転します。', 'arg0'),
  round: intrinsic('T round(T x)', '最も近い整数に丸めます。', 'arg0'),
  rsqrt: intrinsic('T rsqrt(T x)', '平方根の逆数を返します。', 'arg0'),
  saturate: intrinsic('T saturate(T x)', 'xを[0, 1]に制限します。', 'arg0'),
  sign: intrinsic('int sign(T x)', '符号(-1, 0, 1)を返します。', 'arg0'),
  sin: intrinsic('T sin(T x)', '正弦を返します。', 'arg0'),
  sincos: intrinsic('void sincos(T x, out T s, out T c)', '正弦と余弦を同時に求めます。', 'void'),
  sinh: intrinsic('T sinh(T x)', '双曲線正弦を返します。', 'arg0'),
  smoothstep: intrinsic('T smoothstep(T min, T max, T x)', 'エルミート補間による0〜1の値を返します。', 'arg2'),
  sqrt: intrinsic('T sqrt(T x)', '平方根を返します。', 'arg0'),
  step: intrinsic('T step(T y, T x)', 'x >= y なら1、そうでなければ0を返します。', 'arg1'),
  tan: intrinsic('T tan(T x)', '正接を返します。', 'arg0'),
  tanh: intrinsic('T tanh(T x)', '双曲線正接を返します。', 'arg0'),
  transpose: intrinsic('transpose(m)', '転置行列を返します。', 'transpose'),
  trunc: intrinsic('T trunc(T x)', '小数部を切り捨てます。', 'arg0'),
  // 旧形式のサンプリング関数(Built-in RP / CG)
  tex1D: intrinsic('float4 tex1D(sampler1D s, float t[, float ddx, float ddy])', '1Dテクスチャをサンプリングします。', 'float4'),
  tex2D: intrinsic('float4 tex2D(sampler2D s, float2 t[, float2 ddx, float2 ddy])', '2Dテクスチャをサンプリングします。', 'float4'),
  tex2Dlod: intrinsic('float4 tex2Dlod(sampler2D s, float4 t)', 'ミップレベルを指定して2Dテクスチャをサンプリングします。', 'float4'),
  tex2Dbias: intrinsic('float4 tex2Dbias(sampler2D s, float4 t)', 'バイアス付きで2Dテクスチャをサンプリングします。', 'float4'),
  tex2Dgrad: intrinsic('float4 tex2Dgrad(sampler2D s, float2 t, float2 ddx, float2 ddy)', '勾配を指定して2Dテクスチャをサンプリングします。', 'float4'),
  tex2Dproj: intrinsic('float4 tex2Dproj(sampler2D s, float4 t)', '射影付きで2Dテクスチャをサンプリングします。', 'float4'),
  tex3D: intrinsic('float4 tex3D(sampler3D s, float3 t[, float3 ddx, float3 ddy])', '3Dテクスチャをサンプリングします。', 'float4'),
  tex3Dlod: intrinsic('float4 tex3Dlod(sampler3D s, float4 t)', 'ミップレベルを指定して3Dテクスチャをサンプリングします。', 'float4'),
  texCUBE: intrinsic('float4 texCUBE(samplerCUBE s, float3 t[, float3 ddx, float3 ddy])', 'キューブマップをサンプリングします。', 'float4'),
  texCUBElod: intrinsic('float4 texCUBElod(samplerCUBE s, float4 t)', 'ミップレベルを指定してキューブマップをサンプリングします。', 'float4'),
  texCUBEbias: intrinsic('float4 texCUBEbias(samplerCUBE s, float4 t)', 'バイアス付きでキューブマップをサンプリングします。', 'float4'),
  // 同期・アトミック
  AllMemoryBarrier: intrinsic('void AllMemoryBarrier()', 'すべてのメモリアクセスを同期します。', 'void'),
  AllMemoryBarrierWithGroupSync: intrinsic('void AllMemoryBarrierWithGroupSync()', 'グループ内スレッドとメモリアクセスを同期します。', 'void'),
  DeviceMemoryBarrier: intrinsic('void DeviceMemoryBarrier()', 'デバイスメモリへのアクセスを同期します。', 'void'),
  DeviceMemoryBarrierWithGroupSync: intrinsic('void DeviceMemoryBarrierWithGroupSync()', 'グループ内スレッドとデバイスメモリを同期します。', 'void'),
  GroupMemoryBarrier: intrinsic('void GroupMemoryBarrier()', 'グループ共有メモリへのアクセスを同期します。', 'void'),
  GroupMemoryBarrierWithGroupSync: intrinsic('void GroupMemoryBarrierWithGroupSync()', 'グループ内スレッドと共有メモリを同期します。', 'void'),
  InterlockedAdd: intrinsic('void InterlockedAdd(inout R dest, T value[, out T original])', 'アトミックに加算します。', 'void'),
  InterlockedAnd: intrinsic('void InterlockedAnd(inout R dest, T value[, out T original])', 'アトミックにANDします。', 'void'),
  InterlockedCompareExchange: intrinsic('void InterlockedCompareExchange(inout R dest, T compare, T value, out T original)', '比較して一致すれば交換します。', 'void'),
  InterlockedCompareStore: intrinsic('void InterlockedCompareStore(inout R dest, T compare, T value)', '比較して一致すれば書き込みます。', 'void'),
  InterlockedExchange: intrinsic('void InterlockedExchange(inout R dest, T value, out T original)', 'アトミックに交換します。', 'void'),
  InterlockedMax: intrinsic('void InterlockedMax(inout R dest, T value[, out T original])', 'アトミックに最大値を書き込みます。', 'void'),
  InterlockedMin: intrinsic('void InterlockedMin(inout R dest, T value[, out T original])', 'アトミックに最小値を書き込みます。', 'void'),
  InterlockedOr: intrinsic('void InterlockedOr(inout R dest, T value[, out T original])', 'アトミックにORします。', 'void'),
  InterlockedXor: intrinsic('void InterlockedXor(inout R dest, T value[, out T original])', 'アトミックにXORします。', 'void'),
  // Wave / Quad
  WaveGetLaneCount: intrinsic('uint WaveGetLaneCount()', 'Wave内のレーン数を返します。', 'uint'),
  WaveGetLaneIndex: intrinsic('uint WaveGetLaneIndex()', '現在のレーン番号を返します。', 'uint'),
  WaveIsFirstLane: intrinsic('bool WaveIsFirstLane()', '最初のアクティブレーンならtrueを返します。', 'bool'),
  WaveActiveAnyTrue: intrinsic('bool WaveActiveAnyTrue(bool expr)', 'いずれかのレーンでtrueならtrueを返します。', 'bool'),
  WaveActiveAllTrue: intrinsic('bool WaveActiveAllTrue(bool expr)', 'すべてのレーンでtrueならtrueを返します。', 'bool'),
  WaveActiveAllEqual: intrinsic('bool WaveActiveAllEqual(T expr)', 'すべてのレーンで値が等しいかを返します。', 'bool'),
  WaveActiveBallot: intrinsic('uint4 WaveActiveBallot(bool expr)', '各レーンの評価結果をビットマスクで返します。', 'uint4'),
  WaveActiveCountBits: intrinsic('uint WaveActiveCountBits(bool expr)', 'trueのレーン数を返します。', 'uint'),
  WaveActiveSum: intrinsic('T WaveActiveSum(T expr)', 'アクティブレーンの合計を返します。', 'arg0'),
  WaveActiveProduct: intrinsic('T WaveActiveProduct(T expr)', 'アクティブレーンの積を返します。', 'arg0'),
  WaveActiveMin: intrinsic('T WaveActiveMin(T expr)', 'アクティブレーンの最小値を返します。', 'arg0'),
  WaveActiveMax: intrinsic('T WaveActiveMax(T expr)', 'アクティブレーンの最大値を返します。', 'arg0'),
  WaveActiveBitAnd: intrinsic('T WaveActiveBitAnd(T expr)', 'アクティブレーンのビットANDを返します。', 'arg0'),
  WaveActiveBitOr: intrinsic('T WaveActiveBitOr(T expr)', 'アクティブレーンのビットORを返します。', 'arg0'),
  WaveActiveBitXor: intrinsic('T WaveActiveBitXor(T expr)', 'アクティブレーンのビットXORを返します。', 'arg0'),
  WavePrefixCountBits: intrinsic('uint WavePrefixCountBits(bool expr)', '前方レーンのtrue数を返します。', 'uint'),
  WavePrefixSum: intrinsic('T WavePrefixSum(T expr)', '前方レーンの合計を返します。', 'arg0'),
  WavePrefixProduct: intrinsic('T WavePrefixProduct(T expr)', '前方レーンの積を返します。', 'arg0'),
  WaveReadLaneAt: intrinsic('T WaveReadLaneAt(T expr, uint lane)', '指定レーンの値を返します。', 'arg0'),
  WaveReadLaneFirst: intrinsic('T WaveReadLaneFirst(T expr)', '最初のアクティブレーンの値を返します。', 'arg0'),
  QuadReadAcrossDiagonal: intrinsic('T QuadReadAcrossDiagonal(T expr)', 'Quad内の対角ピクセルの値を返します。', 'arg0'),
  QuadReadAcrossX: intrinsic('T QuadReadAcrossX(T expr)', 'Quad内の水平隣接ピクセルの値を返します。', 'arg0'),
  QuadReadAcrossY: intrinsic('T QuadReadAcrossY(T expr)', 'Quad内の垂直隣接ピクセルの値を返します。', 'arg0'),
  QuadReadLaneAt: intrinsic('T QuadReadLaneAt(T expr, uint index)', 'Quad内の指定ピクセルの値を返します。', 'arg0'),
  NonUniformResourceIndex: intrinsic('uint NonUniformResourceIndex(uint index)', '非一様なリソースindexであることを示します。', 'arg0'),
  EvaluateAttributeAtSample: intrinsic('T EvaluateAttributeAtSample(T value, uint index)', '指定サンプル位置で属性を評価します。', 'arg0'),
  EvaluateAttributeCentroid: intrinsic('T EvaluateAttributeCentroid(T value)', 'セントロイドで属性を評価します。', 'arg0'),
  EvaluateAttributeSnapped: intrinsic('T EvaluateAttributeSnapped(T value, int2 offset)', 'オフセット位置で属性を評価します。', 'arg0'),
  GetRenderTargetSampleCount: intrinsic('uint GetRenderTargetSampleCount()', 'レンダーターゲットのサンプル数を返します。', 'uint'),
  GetRenderTargetSamplePosition: intrinsic('float2 GetRenderTargetSamplePosition(int index)', 'サンプル位置を返します。', 'float2'),
  CheckAccessFullyMapped: intrinsic('bool CheckAccessFullyMapped(uint status)', 'タイルリソースが完全にマップ済みかを返します。', 'bool'),
  printf: intrinsic('void printf(string format, ...)', 'デバッグ出力を行います。', 'void', 1),
  errorf: intrinsic('void errorf(string format, ...)', 'エラーを出力します。', 'void', 1),
  abort: intrinsic('void abort()', 'シェーダーの実行を中止します。', 'void'),
};
// 可変長引数
INTRINSICS.printf.maxArgs = 32;
INTRINSICS.errorf.maxArgs = 32;

/* ---------------------------------------------------------------------------
 * オブジェクトのメソッド
 * ------------------------------------------------------------------------- */

export interface MethodInfo {
  signature: string;
  doc: string;
  minArgs: number;
  maxArgs: number;
  /** 'element' はテンプレート引数(省略時float4)の型。 */
  returns: string;
}

function method(signature: string, doc: string, returns: string, minArgs: number, maxArgs: number): MethodInfo {
  return { signature, doc, returns, minArgs, maxArgs };
}

const TEXTURE_SAMPLE_METHODS: Record<string, MethodInfo> = {
  Sample: method('Sample(SamplerState s, float2 uv[, int2 offset[, float clamp[, out uint status]]])', 'テクスチャをサンプリングします。', 'element', 2, 5),
  SampleBias: method('SampleBias(SamplerState s, float2 uv, float bias[, int2 offset[, float clamp]])', 'ミップバイアス付きでサンプリングします。', 'element', 3, 6),
  SampleLevel: method('SampleLevel(SamplerState s, float2 uv, float lod[, int2 offset[, out uint status]])', 'ミップレベルを指定してサンプリングします。', 'element', 3, 5),
  SampleGrad: method('SampleGrad(SamplerState s, float2 uv, float2 ddx, float2 ddy[, int2 offset[, float clamp]])', '勾配を指定してサンプリングします。', 'element', 4, 7),
  SampleCmp: method('SampleCmp(SamplerComparisonState s, float2 uv, float compare[, int2 offset])', '比較サンプリングを行います。', 'float', 3, 5),
  SampleCmpLevelZero: method('SampleCmpLevelZero(SamplerComparisonState s, float2 uv, float compare[, int2 offset])', 'ミップ0で比較サンプリングを行います。', 'float', 3, 5),
  Gather: method('Gather(SamplerState s, float2 uv[, int2 offset])', '4テクセルの赤成分を取得します。', 'float4', 2, 4),
  GatherRed: method('GatherRed(SamplerState s, float2 uv[, int2 offset])', '4テクセルの赤成分を取得します。', 'float4', 2, 7),
  GatherGreen: method('GatherGreen(SamplerState s, float2 uv[, int2 offset])', '4テクセルの緑成分を取得します。', 'float4', 2, 7),
  GatherBlue: method('GatherBlue(SamplerState s, float2 uv[, int2 offset])', '4テクセルの青成分を取得します。', 'float4', 2, 7),
  GatherAlpha: method('GatherAlpha(SamplerState s, float2 uv[, int2 offset])', '4テクセルのアルファ成分を取得します。', 'float4', 2, 7),
  GatherCmp: method('GatherCmp(SamplerComparisonState s, float2 uv, float compare[, int2 offset])', '比較付きGatherを行います。', 'float4', 3, 5),
  GatherCmpRed: method('GatherCmpRed(SamplerComparisonState s, float2 uv, float compare[, int2 offset])', '比較付きGatherを行います。', 'float4', 3, 8),
  CalculateLevelOfDetail: method('CalculateLevelOfDetail(SamplerState s, float2 uv)', 'LODを計算します。', 'float', 2, 2),
  CalculateLevelOfDetailUnclamped: method('CalculateLevelOfDetailUnclamped(SamplerState s, float2 uv)', 'クランプなしのLODを計算します。', 'float', 2, 2),
  Load: method('Load(int3 location[, int2 offset[, out uint status]])', 'テクセルを直接読み込みます。', 'element', 1, 3),
  GetDimensions: method('GetDimensions([uint mip,] out width, out height[, out levels])', 'テクスチャのサイズを取得します。', 'void', 1, 5),
};

const RW_TEXTURE_METHODS: Record<string, MethodInfo> = {
  Load: method('Load(int2 location[, out uint status])', 'テクセルを読み込みます。', 'element', 1, 2),
  GetDimensions: method('GetDimensions(out width, out height[, out depth])', 'テクスチャのサイズを取得します。', 'void', 1, 3),
};

const BUFFER_METHODS: Record<string, MethodInfo> = {
  Load: method('Load(int location[, out uint status])', '要素を読み込みます。', 'element', 1, 2),
  GetDimensions: method('GetDimensions(out uint count[, out uint stride])', '要素数を取得します。', 'void', 1, 2),
};

const STRUCTURED_BUFFER_METHODS: Record<string, MethodInfo> = {
  ...BUFFER_METHODS,
  IncrementCounter: method('IncrementCounter()', '隠しカウンタをインクリメントします。', 'uint', 0, 0),
  DecrementCounter: method('DecrementCounter()', '隠しカウンタをデクリメントします。', 'uint', 0, 0),
};

const BYTE_ADDRESS_METHODS: Record<string, MethodInfo> = {
  Load: method('Load(uint address[, out uint status])', '4バイトを読み込みます。', 'uint', 1, 2),
  Load2: method('Load2(uint address[, out uint status])', '8バイトを読み込みます。', 'uint2', 1, 2),
  Load3: method('Load3(uint address[, out uint status])', '12バイトを読み込みます。', 'uint3', 1, 2),
  Load4: method('Load4(uint address[, out uint status])', '16バイトを読み込みます。', 'uint4', 1, 2),
  GetDimensions: method('GetDimensions(out uint size)', 'バイトサイズを取得します。', 'void', 1, 1),
};

const RW_BYTE_ADDRESS_METHODS: Record<string, MethodInfo> = {
  ...BYTE_ADDRESS_METHODS,
  Store: method('Store(uint address, uint value)', '4バイトを書き込みます。', 'void', 2, 2),
  Store2: method('Store2(uint address, uint2 value)', '8バイトを書き込みます。', 'void', 2, 2),
  Store3: method('Store3(uint address, uint3 value)', '12バイトを書き込みます。', 'void', 2, 2),
  Store4: method('Store4(uint address, uint4 value)', '16バイトを書き込みます。', 'void', 2, 2),
  InterlockedAdd: method('InterlockedAdd(uint address, uint value[, out uint original])', 'アトミックに加算します。', 'void', 2, 3),
  InterlockedAnd: method('InterlockedAnd(uint address, uint value[, out uint original])', 'アトミックにANDします。', 'void', 2, 3),
  InterlockedOr: method('InterlockedOr(uint address, uint value[, out uint original])', 'アトミックにORします。', 'void', 2, 3),
  InterlockedXor: method('InterlockedXor(uint address, uint value[, out uint original])', 'アトミックにXORします。', 'void', 2, 3),
  InterlockedMax: method('InterlockedMax(uint address, uint value[, out uint original])', 'アトミックに最大値を書き込みます。', 'void', 2, 3),
  InterlockedMin: method('InterlockedMin(uint address, uint value[, out uint original])', 'アトミックに最小値を書き込みます。', 'void', 2, 3),
  InterlockedExchange: method('InterlockedExchange(uint address, uint value, out uint original)', 'アトミックに交換します。', 'void', 3, 3),
  InterlockedCompareExchange: method('InterlockedCompareExchange(uint address, uint compare, uint value, out uint original)', '比較して交換します。', 'void', 4, 4),
  InterlockedCompareStore: method('InterlockedCompareStore(uint address, uint compare, uint value)', '比較して書き込みます。', 'void', 3, 3),
};

const APPEND_METHODS: Record<string, MethodInfo> = {
  Append: method('Append(T value)', '要素を追加します。', 'void', 1, 1),
  GetDimensions: method('GetDimensions(out uint count, out uint stride)', '要素数を取得します。', 'void', 2, 2),
};

const CONSUME_METHODS: Record<string, MethodInfo> = {
  Consume: method('Consume()', '要素を取り出します。', 'element', 0, 0),
  GetDimensions: method('GetDimensions(out uint count, out uint stride)', '要素数を取得します。', 'void', 2, 2),
};

const STREAM_METHODS: Record<string, MethodInfo> = {
  Append: method('Append(T vertex)', '頂点をストリームに追加します。', 'void', 1, 1),
  RestartStrip: method('RestartStrip()', '現在のストリップを終了し新しいストリップを開始します。', 'void', 0, 0),
};

/** 型名(テンプレート引数を除く)に対応するメソッド表。 */
export function getObjectMethods(baseType: string): Record<string, MethodInfo> | undefined {
  if (/^(Texture(1D|2D|3D|Cube)(Array)?)$/.test(baseType) || baseType === 'Texture') return TEXTURE_SAMPLE_METHODS;
  if (/^Texture2DMS(Array)?$/.test(baseType)) {
    return {
      Load: method('Load(int2 location, int sampleIndex[, int2 offset])', 'サンプルを読み込みます。', 'element', 2, 3),
      GetDimensions: method('GetDimensions(out width, out height, out samples)', 'サイズを取得します。', 'void', 3, 4),
    };
  }
  if (/^(RW|RasterizerOrdered)Texture/.test(baseType)) return RW_TEXTURE_METHODS;
  if (/^(RW|RasterizerOrdered)?ByteAddressBuffer$/.test(baseType)) {
    return baseType === 'ByteAddressBuffer' ? BYTE_ADDRESS_METHODS : RW_BYTE_ADDRESS_METHODS;
  }
  if (/StructuredBuffer$/.test(baseType)) {
    if (baseType === 'AppendStructuredBuffer') return APPEND_METHODS;
    if (baseType === 'ConsumeStructuredBuffer') return CONSUME_METHODS;
    return STRUCTURED_BUFFER_METHODS;
  }
  if (/^(RW|RasterizerOrdered)?Buffer$/.test(baseType)) return BUFFER_METHODS;
  if (/^(Point|Line|Triangle)Stream$/.test(baseType)) return STREAM_METHODS;
  return undefined;
}

/* ---------------------------------------------------------------------------
 * セマンティクス
 * ------------------------------------------------------------------------- */

export const SEMANTICS: Record<string, string> = {
  POSITION: '頂点位置。',
  NORMAL: '頂点法線。',
  TANGENT: '頂点接線。',
  BINORMAL: '頂点従法線。',
  COLOR: '頂点カラー。',
  TEXCOORD: 'テクスチャ座標 / 汎用の補間値。',
  BLENDINDICES: 'スキニング用のボーンindex。',
  BLENDWEIGHT: 'スキニング用のウェイト。',
  PSIZE: 'ポイントサイズ。',
  FOG: 'フォグ係数。',
  VFACE: '表面なら正、裏面なら負(旧形式)。',
  VPOS: 'ピクセルのスクリーン座標(旧形式)。',
  DEPTH: '出力深度(旧形式)。',
  SV_POSITION: 'クリップ空間の頂点位置 / ピクセルシェーダーではスクリーン座標。',
  SV_TARGET: 'レンダーターゲットへの出力色。',
  SV_DEPTH: '出力深度値。',
  SV_DEPTHGREATEREQUAL: '保守的深度出力(元の深度以上)。',
  SV_DEPTHLESSEQUAL: '保守的深度出力(元の深度以下)。',
  SV_VERTEXID: '頂点ID。',
  SV_INSTANCEID: 'インスタンスID。',
  SV_PRIMITIVEID: 'プリミティブID。',
  SV_ISFRONTFACE: '表面ならtrue。',
  SV_SAMPLEINDEX: 'MSAAのサンプルindex。',
  SV_COVERAGE: 'MSAAカバレッジマスク。',
  SV_DISPATCHTHREADID: 'Dispatch全体でのスレッドID。',
  SV_GROUPID: 'スレッドグループID。',
  SV_GROUPTHREADID: 'グループ内のスレッドID。',
  SV_GROUPINDEX: 'グループ内のフラットなスレッドindex。',
  SV_CLIPDISTANCE: 'クリップ距離。',
  SV_CULLDISTANCE: 'カリング距離。',
  SV_RENDERTARGETARRAYINDEX: 'レンダーターゲット配列のindex。',
  SV_VIEWPORTARRAYINDEX: 'ビューポート配列のindex。',
  SV_VIEWID: 'マルチビューのビューID。',
  SV_STENCILREF: 'ステンシル参照値の出力。',
  SV_TESSFACTOR: 'テッセレーション係数(エッジ)。',
  SV_INSIDETESSFACTOR: 'テッセレーション係数(内部)。',
  SV_DOMAINLOCATION: 'ドメインシェーダーでの位置。',
  SV_OUTPUTCONTROLPOINTID: '出力コントロールポイントID。',
  SV_GSINSTANCEID: 'ジオメトリシェーダーのインスタンスID。',
  SV_BARYCENTRICS: '重心座標。',
  SV_SHADINGRATE: '可変レートシェーディングのレート。',
};

/** セマンティクス名(末尾の番号を除いた大文字)の説明を返す。 */
export function getSemanticInfo(name: string): string | undefined {
  const upper = name.toUpperCase();
  return SEMANTICS[upper] ?? SEMANTICS[upper.replace(/\d+$/, '')];
}

export const COMPLETION_SEMANTICS = [
  'POSITION',
  'NORMAL',
  'TANGENT',
  'COLOR',
  ...Array.from({ length: 8 }, (_, i) => `TEXCOORD${i}`),
  'BLENDINDICES',
  'BLENDWEIGHTS',
  'SV_POSITION',
  'SV_Target',
  ...Array.from({ length: 8 }, (_, i) => `SV_Target${i}`),
  'SV_Depth',
  'SV_VertexID',
  'SV_InstanceID',
  'SV_PrimitiveID',
  'SV_IsFrontFace',
  'SV_SampleIndex',
  'SV_Coverage',
  'SV_DispatchThreadID',
  'SV_GroupID',
  'SV_GroupThreadID',
  'SV_GroupIndex',
  'SV_ClipDistance0',
  'SV_RenderTargetArrayIndex',
  'SV_ViewID',
];

/* ---------------------------------------------------------------------------
 * 定義済みマクロ
 * ------------------------------------------------------------------------- */

/**
 * Unityのシェーダーコンパイラが定義するマクロの接頭辞。
 * include先を解析できなくても未定義扱いしない。
 */
export function isCompilerPredefinedMacro(name: string): boolean {
  return /^(SHADER_API_|SHADER_TARGET|SHADER_STAGE_|SHADER_AVAILABLE_|UNITY_VERSION|UNITY_COMPILER_|UNITY_PLATFORM_|UNITY_NO_|UNITY_ENABLE_|UNITY_PASS_|UNITY_HARDWARE_TIER|UNITY_COLORSPACE_GAMMA|UNITY_REVERSED_Z|UNITY_UV_STARTS_AT_TOP|UNITY_NEAR_CLIP_VALUE|UNITY_FRAMEBUFFER_FETCH_AVAILABLE|UNITY_PRETRANSFORM_TO_DISPLAY_ORIENTATION|UNITY_SINGLE_PASS_STEREO|STEREO_|INSTANCING_ON|PROCEDURAL_INSTANCING_ON|DOTS_INSTANCING_ON)/.test(
    name,
  );
}

/* ---------------------------------------------------------------------------
 * プリプロセッサ
 * ------------------------------------------------------------------------- */

export const DIRECTIVES: Record<string, string> = {
  include: '別ファイルを取り込みます。',
  include_with_pragmas: 'pragmaディレクティブも含めて別ファイルを取り込みます(Unity 2021.2以降)。',
  define: 'マクロを定義します。',
  undef: 'マクロ定義を取り消します。',
  if: '条件付きコンパイルを開始します。',
  ifdef: 'マクロが定義されている場合にコンパイルします。',
  ifndef: 'マクロが定義されていない場合にコンパイルします。',
  elif: '別の条件を指定します。',
  else: '条件が偽の場合にコンパイルします。',
  endif: '条件付きコンパイルを終了します。',
  pragma: 'コンパイラ指示を記述します。',
  error: 'コンパイルエラーを発生させます。',
  warning: 'コンパイル警告を発生させます。',
  line: '行番号を変更します。',
};

export const PRAGMAS: Record<string, string> = {
  vertex: '頂点シェーダー関数を指定します。',
  fragment: 'フラグメント(ピクセル)シェーダー関数を指定します。',
  geometry: 'ジオメトリシェーダー関数を指定します。',
  hull: 'ハルシェーダー関数を指定します。',
  domain: 'ドメインシェーダー関数を指定します。',
  kernel: 'コンピュートシェーダーのカーネル関数を指定します。',
  target: 'シェーダーモデルを指定します(例: 4.5)。',
  require: '必要なGPU機能を指定します。',
  multi_compile: 'すべての組み合わせのバリアントを生成するキーワードを宣言します。',
  multi_compile_local: 'ローカルキーワードでmulti_compileを宣言します。',
  multi_compile_vertex: '頂点ステージ用のmulti_compile。',
  multi_compile_fragment: 'フラグメントステージ用のmulti_compile。',
  multi_compile_local_vertex: '頂点ステージ用のローカルmulti_compile。',
  multi_compile_local_fragment: 'フラグメントステージ用のローカルmulti_compile。',
  shader_feature: 'マテリアルで使用されるバリアントだけを生成するキーワードを宣言します。',
  shader_feature_local: 'ローカルキーワードでshader_featureを宣言します。',
  shader_feature_vertex: '頂点ステージ用のshader_feature。',
  shader_feature_fragment: 'フラグメントステージ用のshader_feature。',
  shader_feature_local_vertex: '頂点ステージ用のローカルshader_feature。',
  shader_feature_local_fragment: 'フラグメントステージ用のローカルshader_feature。',
  dynamic_branch: '動的分岐用のキーワードを宣言します(Unity 2022.1以降)。',
  dynamic_branch_local: 'ローカルキーワードでdynamic_branchを宣言します。',
  multi_compile_instancing: 'GPUインスタンシング用のバリアントを生成します。',
  multi_compile_fog: 'フォグ用のバリアントを生成します。',
  multi_compile_fwdbase: 'ForwardBaseパス用のバリアントを生成します(Built-in RP)。',
  multi_compile_shadowcaster: 'ShadowCasterパス用のバリアントを生成します(Built-in RP)。',
  instancing_options: 'GPUインスタンシングのオプションを指定します。',
  only_renderers: '指定したグラフィックスAPIのみでコンパイルします。',
  exclude_renderers: '指定したグラフィックスAPIを除外します。',
  enable_d3d11_debug_symbols: 'デバッグシンボルを生成します。',
  skip_optimizations: '最適化を無効にします。',
  editor_sync_compilation: 'エディタで同期的にコンパイルします。',
  hlslcc_bytecode_disassembly: 'HLSLccの逆アセンブルを出力します。',
  disable_fastmath: '高速な数学最適化を無効にします。',
  use_dxc: 'DXCコンパイラを使用します。',
  never_use_dxc: 'DXCコンパイラを使用しません。',
  skip_variants: '指定したキーワードのバリアントを除外します。',
  surface: 'サーフェスシェーダー関数を指定します(Built-in RP)。',
};

/** #pragma の引数として関数名を取るもの。 */
export const FUNCTION_PRAGMAS = new Set(['vertex', 'fragment', 'geometry', 'hull', 'domain', 'kernel', 'surface']);

export const URP_KEYWORDS = [
  '_MAIN_LIGHT_SHADOWS',
  '_MAIN_LIGHT_SHADOWS_CASCADE',
  '_MAIN_LIGHT_SHADOWS_SCREEN',
  '_ADDITIONAL_LIGHTS_VERTEX',
  '_ADDITIONAL_LIGHTS',
  '_ADDITIONAL_LIGHT_SHADOWS',
  '_REFLECTION_PROBE_BLENDING',
  '_REFLECTION_PROBE_BOX_PROJECTION',
  '_REFLECTION_PROBE_ATLAS',
  '_SHADOWS_SOFT',
  '_SHADOWS_SOFT_LOW',
  '_SHADOWS_SOFT_MEDIUM',
  '_SHADOWS_SOFT_HIGH',
  '_SCREEN_SPACE_OCCLUSION',
  '_SCREEN_SPACE_IRRADIANCE',
  '_DBUFFER_MRT1',
  '_DBUFFER_MRT2',
  '_DBUFFER_MRT3',
  '_LIGHT_LAYERS',
  '_LIGHT_COOKIES',
  '_FORWARD_PLUS',
  '_CLUSTER_LIGHT_LOOP',
  '_WRITE_RENDERING_LAYERS',
  '_CASTING_PUNCTUAL_LIGHT_SHADOW',
  '_RENDER_PASS_ENABLED',
  '_GBUFFER_NORMALS_OCT',
  'LIGHTMAP_SHADOW_MIXING',
  'SHADOWS_SHADOWMASK',
  'DIRLIGHTMAP_COMBINED',
  'LIGHTMAP_ON',
  'DYNAMICLIGHTMAP_ON',
  'LIGHTMAP_BICUBIC_SAMPLING',
  'USE_LEGACY_LIGHTMAPS',
  '_MIXED_LIGHTING_SUBTRACTIVE',
  'EVALUATE_SH_MIXED',
  'EVALUATE_SH_VERTEX',
  'PROBE_VOLUMES_L1',
  'PROBE_VOLUMES_L2',
  'DEBUG_DISPLAY',
  'LOD_FADE_CROSSFADE',
  'FOG_LINEAR',
  'FOG_EXP',
  'FOG_EXP2',
  'INSTANCING_ON',
  'DOTS_INSTANCING_ON',
  '_NORMALMAP',
  '_PARALLAXMAP',
  '_RECEIVE_SHADOWS_OFF',
  '_DETAIL_MULX2',
  '_DETAIL_SCALED',
  '_EMISSION',
  '_METALLICSPECGLOSSMAP',
  '_SMOOTHNESS_TEXTURE_ALBEDO_CHANNEL_A',
  '_OCCLUSIONMAP',
  '_SPECULARHIGHLIGHTS_OFF',
  '_ENVIRONMENTREFLECTIONS_OFF',
  '_SPECULAR_SETUP',
  '_ALPHATEST_ON',
  '_ALPHAPREMULTIPLY_ON',
  '_ALPHAMODULATE_ON',
  '_SURFACE_TYPE_TRANSPARENT',
  '_CLEARCOAT',
  '_CLEARCOATMAP',
];

/* ---------------------------------------------------------------------------
 * ShaderLab
 * ------------------------------------------------------------------------- */

export interface KeywordInfo {
  label: string;
  doc: string;
  /** 補完時に挿入するスニペット。 */
  snippet?: string;
}

const RENDER_STATES: KeywordInfo[] = [
  { label: 'Cull', doc: 'カリングするポリゴン面を指定します。', snippet: 'Cull ${1|Back,Front,Off|}' },
  { label: 'ZWrite', doc: '深度バッファへの書き込みを指定します。', snippet: 'ZWrite ${1|On,Off|}' },
  {
    label: 'ZTest',
    doc: '深度テストの比較関数を指定します。',
    snippet: 'ZTest ${1|LEqual,Less,Greater,GEqual,Equal,NotEqual,Always,Never,Disabled|}',
  },
  { label: 'Blend', doc: 'ブレンド係数を指定します。', snippet: 'Blend ${1:SrcAlpha} ${2:OneMinusSrcAlpha}' },
  { label: 'BlendOp', doc: 'ブレンド演算を指定します。', snippet: 'BlendOp ${1|Add,Sub,RevSub,Min,Max|}' },
  { label: 'ColorMask', doc: '書き込むカラーチャンネルを指定します。', snippet: 'ColorMask ${1:RGBA}' },
  { label: 'AlphaToMask', doc: 'アルファ・トゥ・カバレッジを指定します。', snippet: 'AlphaToMask ${1|On,Off|}' },
  { label: 'Offset', doc: '深度オフセットを指定します。', snippet: 'Offset ${1:-1}, ${2:-1}' },
  { label: 'ZClip', doc: '深度クリップを指定します。', snippet: 'ZClip ${1|True,False|}' },
  { label: 'Conservative', doc: '保守的ラスタライズを指定します。', snippet: 'Conservative ${1|True,False|}' },
  {
    label: 'Stencil',
    doc: 'ステンシルテストを設定します。',
    snippet: 'Stencil\n{\n\tRef ${1:1}\n\tComp ${2:Always}\n\tPass ${3:Replace}\n}',
  },
];

export const SHADERLAB_KEYWORDS: Record<'Shader' | 'SubShader' | 'Pass' | 'Stencil' | 'Category', KeywordInfo[]> = {
  Shader: [
    { label: 'Properties', doc: 'マテリアルのプロパティを宣言します。', snippet: 'Properties\n{\n\t$0\n}' },
    { label: 'SubShader', doc: 'SubShaderを定義します。', snippet: 'SubShader\n{\n\tTags { "RenderType" = "Opaque" "RenderPipeline" = "UniversalPipeline" }\n\n\t$0\n}' },
    { label: 'Fallback', doc: 'フォールバックするシェーダーを指定します。', snippet: 'Fallback "${1:Hidden/Universal Render Pipeline/FallbackError}"' },
    { label: 'CustomEditor', doc: 'カスタムインスペクターを指定します。', snippet: 'CustomEditor "${1}"' },
    { label: 'CustomEditorForRenderPipeline', doc: 'パイプラインごとのカスタムインスペクターを指定します。', snippet: 'CustomEditorForRenderPipeline "${1}" "${2}"' },
    { label: 'HLSLINCLUDE', doc: 'すべてのパスで共有するHLSLコードを記述します。', snippet: 'HLSLINCLUDE\n$0\nENDHLSL' },
    { label: 'CGINCLUDE', doc: 'すべてのパスで共有するCGコードを記述します。', snippet: 'CGINCLUDE\n$0\nENDCG' },
    { label: 'Category', doc: 'コマンドをまとめて適用します。' },
  ],
  SubShader: [
    { label: 'Tags', doc: 'SubShaderのタグを指定します。', snippet: 'Tags { "${1:RenderType}" = "${2:Opaque}" }' },
    { label: 'LOD', doc: 'SubShaderのLOD値を指定します。', snippet: 'LOD ${1:100}' },
    { label: 'Pass', doc: 'パスを定義します。', snippet: 'Pass\n{\n\tName "${1:ForwardLit}"\n\tTags { "LightMode" = "${2:UniversalForward}" }\n\n\tHLSLPROGRAM\n\t#pragma vertex ${3:vert}\n\t#pragma fragment ${4:frag}\n\n\t#include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"\n\n\t$0\n\tENDHLSL\n}' },
    { label: 'UsePass', doc: '他のシェーダーのパスを使用します。', snippet: 'UsePass "${1}"' },
    { label: 'GrabPass', doc: '画面をテクスチャに取得します(Built-in RP)。' },
    { label: 'HLSLINCLUDE', doc: 'このSubShaderの全パスで共有するHLSLコードを記述します。', snippet: 'HLSLINCLUDE\n$0\nENDHLSL' },
    { label: 'PackageRequirements', doc: '必要なパッケージを指定します。', snippet: 'PackageRequirements\n{\n\t"${1:com.unity.render-pipelines.universal}"\n}' },
    ...RENDER_STATES,
  ],
  Pass: [
    { label: 'Name', doc: 'パス名を指定します。', snippet: 'Name "${1}"' },
    { label: 'Tags', doc: 'パスのタグを指定します。', snippet: 'Tags { "LightMode" = "${1:UniversalForward}" }' },
    { label: 'HLSLPROGRAM', doc: 'HLSLプログラムを記述します。', snippet: 'HLSLPROGRAM\n$0\nENDHLSL' },
    { label: 'CGPROGRAM', doc: 'CGプログラムを記述します(Built-in RP)。', snippet: 'CGPROGRAM\n$0\nENDCG' },
    { label: 'HLSLINCLUDE', doc: '共有HLSLコードを記述します。', snippet: 'HLSLINCLUDE\n$0\nENDHLSL' },
    { label: 'PackageRequirements', doc: '必要なパッケージを指定します。' },
    ...RENDER_STATES,
  ],
  Stencil: [
    { label: 'Ref', doc: 'ステンシル参照値。', snippet: 'Ref ${1:1}' },
    { label: 'ReadMask', doc: '読み取りマスク。', snippet: 'ReadMask ${1:255}' },
    { label: 'WriteMask', doc: '書き込みマスク。', snippet: 'WriteMask ${1:255}' },
    { label: 'Comp', doc: '比較関数。', snippet: 'Comp ${1|Always,Never,Less,Equal,LEqual,Greater,NotEqual,GEqual|}' },
    { label: 'Pass', doc: 'テスト成功時の操作。', snippet: 'Pass ${1|Keep,Zero,Replace,IncrSat,DecrSat,Invert,IncrWrap,DecrWrap|}' },
    { label: 'Fail', doc: 'テスト失敗時の操作。', snippet: 'Fail ${1|Keep,Zero,Replace,IncrSat,DecrSat,Invert,IncrWrap,DecrWrap|}' },
    { label: 'ZFail', doc: '深度テスト失敗時の操作。', snippet: 'ZFail ${1|Keep,Zero,Replace,IncrSat,DecrSat,Invert,IncrWrap,DecrWrap|}' },
    { label: 'CompFront', doc: '表面の比較関数。' },
    { label: 'PassFront', doc: '表面のテスト成功時の操作。' },
    { label: 'FailFront', doc: '表面のテスト失敗時の操作。' },
    { label: 'ZFailFront', doc: '表面の深度テスト失敗時の操作。' },
    { label: 'CompBack', doc: '裏面の比較関数。' },
    { label: 'PassBack', doc: '裏面のテスト成功時の操作。' },
    { label: 'FailBack', doc: '裏面のテスト失敗時の操作。' },
    { label: 'ZFailBack', doc: '裏面の深度テスト失敗時の操作。' },
  ],
  Category: [],
};
SHADERLAB_KEYWORDS.Category = [...SHADERLAB_KEYWORDS.SubShader];

export const SHADERLAB_VALUES = [
  'On',
  'Off',
  'Back',
  'Front',
  'Less',
  'Greater',
  'LEqual',
  'GEqual',
  'Equal',
  'NotEqual',
  'Always',
  'Never',
  'Disabled',
  'One',
  'Zero',
  'SrcColor',
  'SrcAlpha',
  'DstColor',
  'DstAlpha',
  'OneMinusSrcColor',
  'OneMinusSrcAlpha',
  'OneMinusDstColor',
  'OneMinusDstAlpha',
  'SrcAlphaSaturate',
  'Add',
  'Sub',
  'RevSub',
  'Min',
  'Max',
  'Keep',
  'Replace',
  'IncrSat',
  'DecrSat',
  'Invert',
  'IncrWrap',
  'DecrWrap',
  'True',
  'False',
];

export const PROPERTY_TYPE_COMPLETIONS: KeywordInfo[] = [
  { label: 'Float', doc: '浮動小数点数。', snippet: 'Float) = ${1:0}' },
  { label: 'Range', doc: 'スライダーで調整する浮動小数点数。', snippet: 'Range(${1:0}, ${2:1})) = ${3:0.5}' },
  { label: 'Int', doc: '整数(実体はfloat)。', snippet: 'Int) = ${1:0}' },
  { label: 'Integer', doc: '整数。', snippet: 'Integer) = ${1:0}' },
  { label: 'Color', doc: '色(float4)。', snippet: 'Color) = (${1:1}, ${2:1}, ${3:1}, ${4:1})' },
  { label: 'Vector', doc: 'ベクトル(float4)。', snippet: 'Vector) = (${1:0}, ${2:0}, ${3:0}, ${4:0})' },
  { label: '2D', doc: '2Dテクスチャ。', snippet: '2D) = "${1|white,black,gray,bump,red|}" {}' },
  { label: '2DArray', doc: '2Dテクスチャ配列。', snippet: '2DArray) = "" {}' },
  { label: '3D', doc: '3Dテクスチャ。', snippet: '3D) = "" {}' },
  { label: 'Cube', doc: 'キューブマップ。', snippet: 'Cube) = "" {}' },
  { label: 'CubeArray', doc: 'キューブマップ配列。', snippet: 'CubeArray) = "" {}' },
];

export const PROPERTY_ATTRIBUTES: KeywordInfo[] = [
  { label: 'HideInInspector', doc: 'インスペクターに表示しません。' },
  { label: 'NoScaleOffset', doc: 'テクスチャのTiling/Offsetを表示しません。' },
  { label: 'Normal', doc: '法線マップであることを示します。' },
  { label: 'HDR', doc: 'HDRカラー/テクスチャであることを示します。' },
  { label: 'Gamma', doc: 'sRGB値であることを示します。' },
  { label: 'PerRendererData', doc: 'MaterialPropertyBlockから設定される値であることを示します。' },
  { label: 'MainTexture', doc: 'メインテクスチャとして扱います。' },
  { label: 'MainColor', doc: 'メインカラーとして扱います。' },
  { label: 'Toggle', doc: 'チェックボックスとして表示し、キーワードを切り替えます。', snippet: 'Toggle(${1:_KEYWORD})' },
  { label: 'ToggleOff', doc: 'オフでキーワードを有効にするチェックボックス。', snippet: 'ToggleOff(${1:_KEYWORD_OFF})' },
  { label: 'ToggleUI', doc: 'キーワードを伴わないチェックボックス。' },
  { label: 'KeywordEnum', doc: 'キーワードを切り替える列挙。', snippet: 'KeywordEnum(${1:None, Add, Multiply})' },
  { label: 'Enum', doc: '列挙として表示します。', snippet: 'Enum(${1:UnityEngine.Rendering.CullMode})' },
  { label: 'PowerSlider', doc: '非線形スライダー。', snippet: 'PowerSlider(${1:3.0})' },
  { label: 'IntRange', doc: '整数スライダー。' },
  { label: 'Space', doc: '余白を挿入します。', snippet: 'Space(${1:10})' },
  { label: 'Header', doc: '見出しを表示します。', snippet: 'Header(${1:Header})' },
];

export const TAG_VALUES: Record<string, string[]> = {
  RenderPipeline: ['UniversalPipeline', 'HDRenderPipeline'],
  RenderType: ['Opaque', 'Transparent', 'TransparentCutout', 'Background', 'Overlay', 'TreeOpaque', 'TreeTransparentCutout', 'Grass', 'GrassBillboard'],
  Queue: ['Background', 'Geometry', 'AlphaTest', 'Transparent', 'Overlay', 'Geometry+1', 'Transparent+1'],
  LightMode: [
    'UniversalForward',
    'UniversalForwardOnly',
    'UniversalGBuffer',
    'ShadowCaster',
    'DepthOnly',
    'DepthNormals',
    'DepthNormalsOnly',
    'Meta',
    'Universal2D',
    'SRPDefaultUnlit',
    'MotionVectors',
    'XRMotionVectors',
  ],
  UniversalMaterialType: ['Lit', 'SimpleLit', 'Unlit', 'ComplexLit'],
  IgnoreProjector: ['True', 'False'],
  DisableBatching: ['True', 'False', 'LODFading'],
  ForceNoShadowCasting: ['True', 'False'],
  CanUseSpriteAtlas: ['True', 'False'],
  PreviewType: ['Sphere', 'Plane', 'Skybox'],
  ShaderModel: ['2.0', '3.0', '3.5', '4.0', '4.5', '5.0'],
};
