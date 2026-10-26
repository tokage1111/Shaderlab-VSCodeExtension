import * as path from 'path';
import { fileURLToPath } from 'url';

const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';

/** Mapのキーとして使う正規化済みパス。Windows/macOSでは大文字小文字を区別しない。 */
export function pathKey(filePath: string): string {
  const normalized = path.normalize(filePath);
  return caseInsensitive ? normalized.toLowerCase() : normalized;
}

export function uriToPath(uri: string): string | undefined {
  if (!uri.startsWith('file:')) {
    return undefined;
  }
  try {
    return path.normalize(fileURLToPath(uri));
  } catch {
    return undefined;
  }
}

/**
 * VS Codeと同じ形式のfile URIを生成する。
 * 例: d:\Foo\a b.hlsl -> file:///d%3A/Foo/a%20b.hlsl
 */
export function pathToUri(filePath: string): string {
  let normalized = path.resolve(filePath).replace(/\\/g, '/');
  let prefix = '';
  const drive = /^([A-Za-z]):\//.exec(normalized);
  if (drive) {
    prefix = `/${drive[1].toLowerCase()}%3A`;
    normalized = normalized.substring(2);
  } else if (normalized.startsWith('//')) {
    // UNCパス: //server/share/...
    const slash = normalized.indexOf('/', 2);
    const authority = slash > 0 ? normalized.substring(2, slash) : normalized.substring(2);
    normalized = slash > 0 ? normalized.substring(slash) : '/';
    return `file://${authority}${encodePath(normalized)}`;
  }
  return `file://${prefix}${encodePath(normalized)}`;
}

function encodePath(value: string): string {
  return value
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

export const SHADER_SOURCE_EXTENSIONS = new Set(['.shader', '.hlsl', '.hlsli', '.cginc', '.compute', '.glslinc', '.cg']);

export function isShaderSourcePath(filePath: string): boolean {
  return SHADER_SOURCE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function isShaderLabPath(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === '.shader';
}
