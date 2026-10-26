import { Location } from 'vscode-languageserver';
import { resolveAt } from '../analysis/resolver';
import { GlobalSymbol, SourceFile, SymbolOfKind } from '../analysis/sourceFile';
import { Workspace } from '../analysis/workspace';

export async function provideDefinition(workspace: Workspace, file: SourceFile, offset: number): Promise<Location[] | null> {
  const result = await resolveAt(workspace, file, offset);
  if (!result) return null;
  const resolution = result.resolution;
  switch (resolution.kind) {
    case 'local':
      return [location(workspace, resolution.file, resolution.variable.nameStart, resolution.variable.nameEnd)];
    case 'symbol': {
      const first = resolution.symbols[0];
      if (!first) return null;
      // オーバーロードや #if による複数定義はすべて候補として返す(先頭が最も確からしいもの)。
      const sameKind = resolution.symbols.filter((symbol) => symbol.kind === first.kind);
      return sameKind.map((symbol) => symbolLocation(workspace, symbol));
    }
    case 'field':
      return [location(workspace, resolution.struct.file, resolution.field.nameStart, resolution.field.nameEnd)];
    case 'include':
      if (resolution.resolution.status !== 'resolved') return null;
      return [{ uri: workspace.uriFor(resolution.resolution.path), range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } }];
    case 'property': {
      // Property名からHLSL側の宣言(CBUFFER内の変数など)へ移動する。
      const declarations = await findPropertyDeclarations(workspace, file, resolution.property.name);
      if (declarations.length > 0) return declarations.map((symbol) => symbolLocation(workspace, symbol));
      return [location(workspace, file, resolution.property.nameStart, resolution.property.nameEnd)];
    }
    default:
      return null;
  }
}

export function symbolLocation(workspace: Workspace, symbol: GlobalSymbol): Location {
  return location(workspace, symbol.file, symbol.node.nameStart, symbol.node.nameEnd);
}

export function location(workspace: Workspace, file: SourceFile, start: number, end: number): Location {
  return { uri: workspace.uriFor(file.path), range: file.lineIndex.range(start, end) };
}

/** ShaderLab Property と同名のHLSL変数(各パスの翻訳単位から探す)。 */
export async function findPropertyDeclarations(workspace: Workspace, file: SourceFile, name: string): Promise<SymbolOfKind<'variable'>[]> {
  const result: SymbolOfKind<'variable'>[] = [];
  const seen = new Set<string>();
  for (let unitIndex = 0; unitIndex < file.units.length; unitIndex++) {
    const context = await workspace.contextForUnit(file, unitIndex);
    for (const symbol of context.lookupKind(name, 'variable')) {
      const key = `${symbol.file.key}:${symbol.node.nameStart}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(symbol);
    }
  }
  // 同じファイル内の宣言を優先する。
  return result.sort((a, b) => Number(b.file === file) - Number(a.file === file));
}
