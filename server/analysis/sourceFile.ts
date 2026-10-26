import {
  HlslCBuffer,
  HlslFunction,
  HlslMacro,
  HlslStruct,
  HlslTypedef,
  HlslUnit,
  HlslVariable,
  ShaderDocument,
  ShaderHlslBlock,
} from '../parser/ast';
import { parseHlslUnit } from '../parser/hlslParser';
import { lex, LexResult, spansContain } from '../parser/lexer';
import { LineIndex } from '../parser/lineIndex';
import { parseShaderLab } from '../parser/shaderlabParser';
import { isShaderLabPath, pathKey } from '../project/pathUtils';

interface SymbolBase {
  name: string;
  file: SourceFile;
  unitIndex: number;
}

export type GlobalSymbol =
  | (SymbolBase & { kind: 'function'; node: HlslFunction })
  | (SymbolBase & { kind: 'struct'; node: HlslStruct })
  | (SymbolBase & { kind: 'variable'; node: HlslVariable; container?: HlslCBuffer })
  | (SymbolBase & { kind: 'cbuffer'; node: HlslCBuffer })
  | (SymbolBase & { kind: 'typedef'; node: HlslTypedef })
  | (SymbolBase & { kind: 'macro'; node: HlslMacro });

export type GlobalSymbolKind = GlobalSymbol['kind'];
export type SymbolOfKind<K extends GlobalSymbolKind> = Extract<GlobalSymbol, { kind: K }>;

/**
 * 1ファイル分の解析結果(字句・構文・シンボル)。内容が変わるたびに作り直す不変オブジェクト。
 */
export class SourceFile {
  public readonly key: string;
  public readonly isShaderLab: boolean;
  public readonly lexResult: LexResult;
  public readonly lineIndex: LineIndex;
  public readonly shader?: ShaderDocument;
  public readonly units: HlslUnit[];
  private readonly unitSymbols: GlobalSymbol[][];
  /** 単位ごとの関数本体(structのメソッドを含む)。開始位置順。 */
  private readonly unitBodies: HlslFunction[][];

  public constructor(
    public readonly uri: string,
    public readonly path: string,
    public readonly text: string,
    public readonly version: number,
  ) {
    this.key = pathKey(path);
    this.isShaderLab = isShaderLabPath(path);
    this.lexResult = lex(text);
    this.lineIndex = new LineIndex(text);
    if (this.isShaderLab) {
      this.shader = parseShaderLab(text, this.lexResult);
      this.units = this.shader.blocks.map((block) => block.unit);
    } else {
      this.units = [
        parseHlslUnit(text, this.lexResult.tokens, 0, this.lexResult.tokens.length, this.lexResult.directives, 0, text.length),
      ];
    }
    this.unitSymbols = this.units.map((unit, index) => this.collectSymbols(unit, index));
    this.unitBodies = this.units.map((unit) =>
      [...unit.functions, ...unit.structs.flatMap((struct) => struct.methods)].sort((a, b) => a.start - b.start),
    );
  }

  public get tokens() {
    return this.lexResult.tokens;
  }

  public symbolsOf(unitIndex: number): GlobalSymbol[] {
    return this.unitSymbols[unitIndex] ?? [];
  }

  /** offsetを含むHLSL単位のindex。ShaderLab部分なら -1。 */
  public unitIndexAt(offset: number): number {
    if (!this.isShaderLab) return 0;
    const blocks = this.shader!.blocks;
    for (let i = 0; i < blocks.length; i++) {
      if (offset >= blocks[i].codeStart && offset <= blocks[i].codeEnd) return i;
    }
    return -1;
  }

  /** offsetを含むstruct(メソッド本体からのメンバー参照の解決に使う)。 */
  public structAt(unitIndex: number, offset: number): HlslStruct | undefined {
    return this.units[unitIndex]?.structs.find((struct) => struct.start <= offset && offset <= struct.end);
  }

  public blockOf(unitIndex: number): ShaderHlslBlock | undefined {
    return this.shader?.blocks[unitIndex];
  }

  public isInComment(offset: number): boolean {
    return spansContain(this.lexResult.comments, offset) || this.isAtLineCommentEnd(offset);
  }

  public isInString(offset: number): boolean {
    const strings = this.lexResult.strings;
    // 文字列の開始引用符の直前は文字列外として扱う。
    return spansContain(strings, offset) && !strings.some((span) => span.start === offset);
  }

  /** 行コメントの末尾(改行の直前)もコメント内とみなす。 */
  private isAtLineCommentEnd(offset: number): boolean {
    const comments = this.lexResult.comments;
    let low = 0;
    let high = comments.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const span = comments[middle];
      if (span.end < offset) low = middle + 1;
      else if (span.end > offset) high = middle - 1;
      else return this.text.startsWith('//', span.start) && span.start < offset;
    }
    return false;
  }

  /** offsetを含む関数(本体または引数リスト)。structのメソッドも対象。 */
  public functionAt(unitIndex: number, offset: number): HlslFunction | undefined {
    const functions = this.unitBodies[unitIndex];
    if (!functions) return undefined;
    let low = 0;
    let high = functions.length - 1;
    let candidate = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (functions[middle].start <= offset) {
        candidate = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (candidate < 0) return undefined;
    const fn = functions[candidate];
    return offset <= fn.end ? fn : undefined;
  }

  private collectSymbols(unit: HlslUnit, unitIndex: number): GlobalSymbol[] {
    const symbols: GlobalSymbol[] = [];
    const base = { file: this, unitIndex };
    for (const fn of unit.functions) symbols.push({ ...base, kind: 'function', name: fn.name, node: fn });
    for (const struct of unit.structs) symbols.push({ ...base, kind: 'struct', name: struct.name, node: struct });
    for (const variable of unit.globals) symbols.push({ ...base, kind: 'variable', name: variable.name, node: variable });
    for (const cbuffer of unit.cbuffers) {
      if (cbuffer.name) symbols.push({ ...base, kind: 'cbuffer', name: cbuffer.name, node: cbuffer });
      // cbufferのメンバーはグローバル変数として参照できる。
      for (const field of cbuffer.fields) {
        symbols.push({ ...base, kind: 'variable', name: field.name, node: field, container: cbuffer });
      }
    }
    for (const typedef of unit.typedefs) symbols.push({ ...base, kind: 'typedef', name: typedef.name, node: typedef });
    for (const macro of unit.macros) symbols.push({ ...base, kind: 'macro', name: macro.name, node: macro });
    return symbols;
  }
}
