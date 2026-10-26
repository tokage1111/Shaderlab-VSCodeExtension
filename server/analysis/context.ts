import { HlslInclude } from '../parser/ast';
import { isIdentifierText } from '../parser/lexer';
import { GlobalSymbol, GlobalSymbolKind, SourceFile, SymbolOfKind } from './sourceFile';

export interface ContextEntry {
  file: SourceFile;
  unitIndex: number;
}

export interface UnresolvedInclude {
  file: SourceFile;
  include: HlslInclude;
  builtin: boolean;
}

/**
 * 1つの翻訳単位(HLSLファイル + include先すべて、またはShaderLabの1パス)から見えるシンボルの集合。
 * ShaderLabではパスごとに別の翻訳単位になるため、別パスのstruct/関数は混ざらない。
 */
export class AnalysisContext {
  private readonly byName = new Map<string, GlobalSymbol[]>();
  public readonly fileKeys = new Set<string>();
  /** すべてのincludeを解決でき、未定義判定を信頼できる。 */
  public readonly complete: boolean;
  private readonly aliasCache = new Map<string, string>();

  public constructor(
    public readonly key: string,
    public readonly entries: ContextEntry[],
    public readonly unresolved: UnresolvedInclude[],
    /** 依存しているファイル(同一性で鮮度を判定する)。 */
    public readonly dependencies: SourceFile[],
    public readonly projectGeneration: number,
  ) {
    for (const entry of entries) {
      this.fileKeys.add(entry.file.key);
      for (const symbol of entry.file.symbolsOf(entry.unitIndex)) {
        const list = this.byName.get(symbol.name);
        if (list) list.push(symbol);
        else this.byName.set(symbol.name, [symbol]);
      }
    }
    // #if 内の見つからないincludeは無効な分岐である可能性が高いので完全性の判定から除く。
    this.complete = unresolved.every((entry) => entry.include.conditional && !entry.builtin);
  }

  public static empty(key: string): AnalysisContext {
    return new AnalysisContext(key, [], [], [], -1);
  }

  public lookup(name: string): GlobalSymbol[] {
    return this.byName.get(name) ?? [];
  }

  public lookupKind<K extends GlobalSymbolKind>(name: string, kind: K): SymbolOfKind<K>[] {
    return this.lookup(name).filter((symbol): symbol is SymbolOfKind<K> => symbol.kind === kind);
  }

  public has(name: string): boolean {
    return this.byName.has(name);
  }

  public *allSymbols(): IterableIterator<GlobalSymbol> {
    for (const list of this.byName.values()) yield* list;
  }

  public names(): IterableIterator<string> {
    return this.byName.keys();
  }

  public containsFile(key: string): boolean {
    return this.fileKeys.has(key);
  }

  /**
   * typedef / オブジェクト形式マクロ(`#define real half`)をたどって型名を解決する。
   * テンプレート引数部分はそのまま残す。
   */
  public resolveTypeAlias(typeName: string): string {
    const cached = this.aliasCache.get(typeName);
    if (cached !== undefined) return cached;
    let current = typeName;
    for (let depth = 0; depth < 8; depth++) {
      const angle = current.indexOf('<');
      const base = angle >= 0 ? current.substring(0, angle) : current;
      const suffix = angle >= 0 ? current.substring(angle) : '';
      const symbols = this.lookup(base);
      const typedef = symbols.find((symbol) => symbol.kind === 'typedef');
      if (typedef && typedef.kind === 'typedef') {
        current = typedef.node.type + suffix;
        continue;
      }
      const macro = symbols.find((symbol) => symbol.kind === 'macro' && !symbol.node.params);
      if (macro && macro.kind === 'macro' && isTypeLikeBody(macro.node.body)) {
        current = macro.node.body.replace(/\s+/g, '') + suffix;
        continue;
      }
      break;
    }
    this.aliasCache.set(typeName, current);
    return current;
  }

  public isFresh(projectGeneration: number, currentFile: (key: string) => SourceFile | undefined): boolean {
    if (this.projectGeneration !== projectGeneration) return false;
    for (const dependency of this.dependencies) {
      if (currentFile(dependency.key) !== dependency) return false;
    }
    return true;
  }
}

function isTypeLikeBody(body: string): boolean {
  const trimmed = body.trim();
  return isIdentifierText(trimmed) || /^[A-Za-z_][A-Za-z0-9_]*\s*<[^;{}()]*>$/.test(trimmed);
}
