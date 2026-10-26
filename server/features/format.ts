import * as path from 'path';
import { HlslCBuffer, HlslFunction, HlslMacro, HlslParameter, HlslStruct, HlslVariable, ShaderProperty } from '../parser/ast';
import { GlobalSymbol } from '../analysis/sourceFile';

/** 宣言を1行のHLSLコードとして表す。 */
export function formatVariable(variable: HlslVariable, options: { qualifiers?: boolean } = {}): string {
  const qualifiers = options.qualifiers && variable.qualifiers.length > 0 ? `${variable.qualifiers.join(' ')} ` : '';
  const dims = '[]'.repeat(variable.arrayDims);
  const semantic = variable.semantic ? ` : ${variable.semantic}` : '';
  if (variable.fromMacro && !variable.type) return `${variable.fromMacro}(${variable.name})`;
  return `${qualifiers}${variable.type} ${variable.name}${dims}${semantic}`;
}

export function formatParameter(param: HlslParameter): string {
  const qualifier = param.qualifier ? `${param.qualifier} ` : '';
  const dims = '[]'.repeat(param.arrayDims);
  const semantic = param.semantic ? ` : ${param.semantic}` : '';
  return `${qualifier}${param.type} ${param.name}${dims}${semantic}`;
}

export function formatFunction(fn: HlslFunction): string {
  const semantic = fn.semantic ? ` : ${fn.semantic}` : '';
  return `${fn.returnType} ${fn.name}(${fn.params.map(formatParameter).join(', ')})${semantic}`;
}

export function formatStruct(struct: HlslStruct, maxFields = 40): string {
  const lines = struct.fields.slice(0, maxFields).map((field) => `    ${formatVariable(field)};`);
  if (struct.fields.length > maxFields) lines.push(`    // ... 他 ${struct.fields.length - maxFields} 個`);
  for (const method of struct.methods.slice(0, 10)) lines.push(`    ${formatFunction(method)};`);
  return `struct ${struct.name}\n{\n${lines.join('\n')}\n};`;
}

export function formatCBuffer(cbuffer: HlslCBuffer, maxFields = 40): string {
  const lines = cbuffer.fields.slice(0, maxFields).map((field) => `    ${formatVariable(field)};`);
  if (cbuffer.fields.length > maxFields) lines.push(`    // ... 他 ${cbuffer.fields.length - maxFields} 個`);
  const head = cbuffer.style === 'macro' ? `CBUFFER_START(${cbuffer.name})` : `cbuffer ${cbuffer.name}`;
  return cbuffer.style === 'macro' ? `${head}\n${lines.join('\n')}\nCBUFFER_END` : `${head}\n{\n${lines.join('\n')}\n};`;
}

export function formatMacro(macro: HlslMacro, maxLength = 600): string {
  const params = macro.params ? `(${macro.params.join(', ')})` : '';
  let body = macro.body;
  if (body.length > maxLength) body = `${body.substring(0, maxLength)} ...`;
  if (body.includes('\n')) body = body.replace(/\n/g, ' \\\n    ');
  return `#define ${macro.name}${params} ${body}`.trimEnd();
}

export function formatProperty(property: ShaderProperty): string {
  const attributes = property.attributes.map((attribute) => `[${attribute}] `).join('');
  return `${attributes}${property.name} ("${property.displayName}", ${property.type}) = ${property.defaultValue}`;
}

export function formatSymbol(symbol: GlobalSymbol): string {
  switch (symbol.kind) {
    case 'function':
      return formatFunction(symbol.node);
    case 'struct':
      return formatStruct(symbol.node);
    case 'variable':
      return formatVariable(symbol.node, { qualifiers: true });
    case 'cbuffer':
      return formatCBuffer(symbol.node);
    case 'typedef':
      return `typedef ${symbol.node.type} ${symbol.node.name};`;
    case 'macro':
      return formatMacro(symbol.node);
  }
}

export function symbolKindLabel(symbol: GlobalSymbol): string {
  switch (symbol.kind) {
    case 'function':
      return '関数';
    case 'struct':
      return '構造体';
    case 'variable':
      return symbol.container ? `定数バッファ '${symbol.container.name || '(無名)'}' の変数` : symbol.node.fromMacro ? 'マクロで宣言された変数' : 'グローバル変数';
    case 'cbuffer':
      return '定数バッファ';
    case 'typedef':
      return '型エイリアス';
    case 'macro':
      return symbol.node.params ? '関数形式マクロ' : 'マクロ';
  }
}

/** ファイルの表示名(パッケージ内なら Packages/<name>/... 形式)。 */
export function displayPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const packageCache = /\/Library\/PackageCache\/([^/@]+)(?:@[^/]+)?\/(.*)$/.exec(normalized);
  if (packageCache) return `Packages/${packageCache[1]}/${packageCache[2]}`;
  const assets = /\/(Assets|Packages)\/(.*)$/.exec(normalized);
  if (assets) return `${assets[1]}/${assets[2]}`;
  return path.basename(filePath);
}

export function codeBlock(code: string): string {
  return '```hlsl\n' + code + '\n```';
}
