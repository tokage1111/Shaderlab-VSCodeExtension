import { Range, ResponseError, TextEdit, WorkspaceEdit } from 'vscode-languageserver';
import { HLSL_KEYWORDS, isBuiltinType, INTRINSICS } from '../analysis/builtins';
import { resolveAt } from '../analysis/resolver';
import { SourceFile } from '../analysis/sourceFile';
import { Workspace } from '../analysis/workspace';
import { isIdentifierText } from '../parser/lexer';
import { uriToPath } from '../project/pathUtils';
import { provideReferences } from './references';

/** Unityが管理するため編集してはいけない場所(PackageCacheは再生成で上書きされる)。 */
const READ_ONLY_PATH = /[\\/]Library[\\/]PackageCache[\\/]/i;

/** 名前を変更できる位置か。変更できる場合は対象の識別子の範囲を返す。 */
export async function prepareRename(workspace: Workspace, file: SourceFile, offset: number): Promise<Range | null> {
  const result = await resolveAt(workspace, file, offset);
  if (!result) return null;
  const resolution = result.resolution;
  switch (resolution.kind) {
    case 'local':
    case 'field':
    case 'property':
      break;
    case 'symbol': {
      const readOnly = resolution.symbols.find((symbol) => READ_ONLY_PATH.test(symbol.file.path));
      if (readOnly) throw new ResponseError(0, `'${result.name}' はPackageCache内(${readOnly.file.path})で宣言されているため名前を変更できません。`);
      break;
    }
    default:
      throw new ResponseError(0, '名前を変更できるのは、変数・関数・構造体・メンバー・マクロ・Propertyのみです。');
  }
  return file.lineIndex.range(result.start, result.end);
}

export async function provideRename(workspace: Workspace, file: SourceFile, offset: number, newName: string): Promise<WorkspaceEdit | null> {
  if (!isIdentifierText(newName)) throw new ResponseError(0, `'${newName}' は識別子として使用できません。`);
  if (HLSL_KEYWORDS.has(newName) || isBuiltinType(newName) || Object.prototype.hasOwnProperty.call(INTRINSICS, newName)) {
    throw new ResponseError(0, `'${newName}' はHLSLの予約語・組み込みの名前のため使用できません。`);
  }
  // 名前を変更できない位置ならここで例外になる。
  if (!(await prepareRename(workspace, file, offset))) return null;

  const locations = await provideReferences(workspace, file, offset, true);
  const changes: Record<string, TextEdit[]> = {};
  for (const location of locations) {
    const filePath = uriToPath(location.uri);
    if (filePath && READ_ONLY_PATH.test(filePath)) {
      throw new ResponseError(0, `PackageCache内のファイル(${filePath})から参照されているため名前を変更できません。`);
    }
    (changes[location.uri] ??= []).push(TextEdit.replace(location.range, newName));
  }
  return { changes };
}
