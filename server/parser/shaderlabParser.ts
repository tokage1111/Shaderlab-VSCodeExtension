import {
  ParseIssue,
  TextFix,
  ShaderBlockKind,
  ShaderDocument,
  ShaderHlslBlock,
  ShaderPass,
  ShaderProperty,
  ShaderSectionKind,
  ShaderSubShader,
  ShaderTag,
} from './ast';
import { parseHlslUnit } from './hlslParser';
import { LexResult, stringValue, Token } from './lexer';
import { closestName } from './similarity';

const BLOCK_END: Record<ShaderBlockKind, string> = {
  HLSLPROGRAM: 'ENDHLSL',
  HLSLINCLUDE: 'ENDHLSL',
  CGPROGRAM: 'ENDCG',
  CGINCLUDE: 'ENDCG',
  GLSLPROGRAM: 'ENDGLSL',
};

export const PROPERTY_TYPES: Record<string, string> = {
  float: 'Float',
  range: 'Range',
  int: 'Int',
  integer: 'Integer',
  color: 'Color',
  vector: 'Vector',
  '2d': '2D',
  '3d': '3D',
  cube: 'Cube',
  '2darray': '2DArray',
  cubearray: 'CubeArray',
  any: 'Any',
  rect: 'Rect',
};

/** Property型ごとの既定値(既定値の書き忘れを補う修正で使う)。 */
function defaultPropertyValue(typeKind: string): string {
  switch (typeKind) {
    case 'Color':
      return '(1, 1, 1, 1)';
    case 'Vector':
      return '(0, 0, 0, 0)';
    case '2D':
    case '2DArray':
    case 'Rect':
      return '"white" {}';
    case '3D':
    case 'Cube':
    case 'CubeArray':
    case 'Any':
      return '"" {}';
    default:
      return '0';
  }
}

export function isHlslBlockKind(value: string): value is ShaderBlockKind {
  return Object.prototype.hasOwnProperty.call(BLOCK_END, value);
}

export function parseShaderLab(text: string, lexResult: LexResult): ShaderDocument {
  return new ShaderLabParser(text, lexResult).parse();
}

class ShaderLabParser {
  private readonly tokens: Token[];
  private readonly matching = new Map<number, number>();
  /** HLSLブロック開始トークンindex -> 終了トークンindex(見つからなければ-1)。 */
  private readonly blockEnds = new Map<number, number>();
  private readonly document: ShaderDocument = {
    properties: [],
    subShaders: [],
    blocks: [],
    sections: [],
    issues: [],
  };
  private i = 0;

  public constructor(
    private readonly text: string,
    private readonly lexResult: LexResult,
  ) {
    this.tokens = lexResult.tokens;
  }

  public parse(): ShaderDocument {
    this.computeStructure();
    const end = this.tokens.length;
    while (this.i < end) {
      const token = this.tokens[this.i];
      if (token.kind === 'ident' && token.value === 'Shader') {
        this.i++;
        if (this.tok()?.kind === 'string') {
          const nameToken = this.tok()!;
          this.document.name = stringValue(nameToken);
          this.document.nameStart = nameToken.start + 1;
          this.document.nameEnd = nameToken.start + 1 + this.document.name.length;
          this.i++;
        }
        if (this.isValue('{')) {
          this.parseContents('Shader', this.i, {});
        }
        continue;
      }
      if (token.kind === 'ident' && isHlslBlockKind(token.value)) {
        this.parseHlslBlock({});
        continue;
      }
      this.i++;
    }
    return this.document;
  }

  /** ShaderLabの括弧対応とHLSLブロックの範囲を求める。HLSLブロック内の括弧は数えない。 */
  private computeStructure(): void {
    const stack: number[] = [];
    for (let t = 0; t < this.tokens.length; t++) {
      const token = this.tokens[t];
      if (token.kind === 'ident' && isHlslBlockKind(token.value)) {
        const endName = BLOCK_END[token.value];
        let end = -1;
        for (let k = t + 1; k < this.tokens.length; k++) {
          const candidate = this.tokens[k];
          if (candidate.kind === 'ident' && (candidate.value === endName || isHlslBlockKind(candidate.value))) {
            if (candidate.value === endName) end = k;
            break;
          }
        }
        this.blockEnds.set(t, end);
        if (end < 0) {
          // 終了マーカーがない場合、次のブロック開始かファイル末尾までをHLSLとみなす。
          let k = t + 1;
          while (k < this.tokens.length && !(this.tokens[k].kind === 'ident' && isHlslBlockKind(this.tokens[k].value))) k++;
          t = k - 1;
        } else {
          t = end;
        }
        continue;
      }
      if (token.value === '{') {
        stack.push(t);
      } else if (token.value === '}') {
        const open = stack.pop();
        if (open === undefined) {
          this.issue(token.start, token.end, "対応する '{' がない '}' です。", 'error');
        } else {
          this.matching.set(open, t);
        }
      }
    }
    for (const open of stack) {
      const token = this.tokens[open];
      this.issue(token.start, token.end, "'{' が閉じられていません。", 'error');
    }
  }

  private matchOf(index: number): number {
    return this.matching.get(index) ?? this.tokens.length;
  }

  private parseContents(
    kind: ShaderSectionKind,
    openIndex: number,
    context: { subShader?: ShaderSubShader; subShaderIndex?: number; pass?: ShaderPass; passIndex?: number },
  ): void {
    const close = this.matchOf(openIndex);
    const open = this.tokens[openIndex];
    const closeToken = this.tokens[Math.min(close, this.tokens.length - 1)];
    this.document.sections.push({ kind, start: open.start, end: close < this.tokens.length ? closeToken.end : this.text.length });
    this.i = openIndex + 1;
    while (this.i < close) {
      const token = this.tokens[this.i];
      if (token.kind !== 'ident') {
        if (token.value === '{') {
          this.skipSection('Other');
          continue;
        }
        this.i++;
        continue;
      }
      if (isHlslBlockKind(token.value)) {
        this.parseHlslBlock(context);
        continue;
      }
      switch (token.value) {
        case 'Properties':
          this.i++;
          if (this.isValue('{')) this.parseProperties();
          continue;
        case 'SubShader': {
          this.i++;
          if (!this.isValue('{')) continue;
          const subShader: ShaderSubShader = {
            tags: [],
            passes: [],
            start: token.start,
            end: this.tokens[Math.min(this.matchOf(this.i), this.tokens.length - 1)].end,
          };
          this.document.subShaders.push(subShader);
          const saved = this.i;
          this.parseContents('SubShader', saved, {
            subShader,
            subShaderIndex: this.document.subShaders.length - 1,
          });
          this.i = this.matchOf(saved) + 1;
          continue;
        }
        case 'Pass': {
          this.i++;
          if (!this.isValue('{')) continue;
          const pass: ShaderPass = {
            tags: [],
            start: token.start,
            end: this.tokens[Math.min(this.matchOf(this.i), this.tokens.length - 1)].end,
          };
          let passIndex: number | undefined;
          if (context.subShader) {
            context.subShader.passes.push(pass);
            passIndex = context.subShader.passes.length - 1;
          }
          const saved = this.i;
          this.parseContents('Pass', saved, { ...context, pass, passIndex });
          this.i = this.matchOf(saved) + 1;
          continue;
        }
        case 'Category': {
          this.i++;
          if (!this.isValue('{')) continue;
          const saved = this.i;
          this.parseContents('Category', saved, context);
          this.i = this.matchOf(saved) + 1;
          continue;
        }
        case 'Tags': {
          this.i++;
          if (!this.isValue('{')) continue;
          const tags = this.parseTags();
          if (context.pass) context.pass.tags.push(...tags);
          else if (context.subShader) context.subShader.tags.push(...tags);
          continue;
        }
        case 'Name': {
          this.i++;
          const nameToken = this.tok();
          if (nameToken?.kind === 'string' && context.pass) {
            context.pass.name = stringValue(nameToken);
            context.pass.nameStart = nameToken.start + 1;
            context.pass.nameEnd = nameToken.start + 1 + context.pass.name.length;
            this.i++;
          }
          continue;
        }
        case 'Stencil':
          this.i++;
          if (this.isValue('{')) this.skipSection('Stencil');
          continue;
        case 'PackageRequirements':
          this.i++;
          if (this.isValue('{')) this.skipSection('PackageRequirements');
          continue;
        default:
          this.i++;
          if (this.isValue('{')) this.skipSection('Other');
          continue;
      }
    }
    this.i = close + 1;
  }

  private skipSection(kind: ShaderSectionKind): void {
    const close = this.matchOf(this.i);
    const end = close < this.tokens.length ? this.tokens[close].end : this.text.length;
    this.document.sections.push({ kind, start: this.tokens[this.i].start, end });
    this.i = close + 1;
  }

  private parseHlslBlock(context: { subShaderIndex?: number; passIndex?: number }): void {
    const startIndex = this.i;
    const startToken = this.tokens[startIndex];
    const kind = startToken.value as ShaderBlockKind;
    const endIndex = this.blockEnds.get(startIndex) ?? -1;
    let tokenEnd: number;
    let codeEnd: number;
    let end: number;
    if (endIndex >= 0) {
      tokenEnd = endIndex;
      codeEnd = this.tokens[endIndex].start;
      end = this.tokens[endIndex].end;
      this.i = endIndex + 1;
    } else {
      let k = startIndex + 1;
      while (k < this.tokens.length && !(this.tokens[k].kind === 'ident' && isHlslBlockKind(this.tokens[k].value))) k++;
      tokenEnd = k;
      codeEnd = k < this.tokens.length ? this.tokens[k].start : this.text.length;
      end = codeEnd;
      this.i = k;
      this.issue(startToken.start, startToken.end, `${kind} に対応する ${BLOCK_END[kind]} がありません。`, 'error');
    }
    const codeStart = startToken.end;
    const unit = parseHlslUnit(
      this.text,
      this.tokens,
      kind === 'GLSLPROGRAM' ? tokenEnd : startIndex + 1,
      tokenEnd,
      kind === 'GLSLPROGRAM' ? [] : this.lexResult.directives,
      codeStart,
      codeEnd,
    );
    const block: ShaderHlslBlock = {
      kind,
      start: startToken.start,
      end,
      codeStart,
      codeEnd,
      terminated: endIndex >= 0,
      unit,
      subShaderIndex: context.subShaderIndex,
      passIndex: context.passIndex,
    };
    this.document.blocks.push(block);
  }

  private parseTags(): ShaderTag[] {
    const close = this.matchOf(this.i);
    const tags: ShaderTag[] = [];
    this.document.sections.push({
      kind: 'Tags',
      start: this.tokens[this.i].start,
      end: close < this.tokens.length ? this.tokens[close].end : this.text.length,
    });
    for (let t = this.i + 1; t < close; t++) {
      const key = this.tokens[t];
      if (key.kind !== 'string') continue;
      let v = t + 1;
      if (this.tokens[v]?.value === '=') v++;
      const value = this.tokens[v];
      if (value && v < close && value.kind === 'string') {
        const keyText = stringValue(key);
        const valueText = stringValue(value);
        tags.push({
          key: keyText,
          value: valueText,
          keyStart: key.start + 1,
          keyEnd: key.start + 1 + keyText.length,
          valueStart: value.start + 1,
          valueEnd: value.start + 1 + valueText.length,
        });
        t = v;
      } else if (value && v < close) {
        this.issue(value.start, value.end, 'Tagの値は文字列で指定してください。', 'error', [
          { title: `"${value.value}" に変更`, edits: [{ start: value.start, end: value.end, newText: `"${value.value}"` }], preferred: true },
        ]);
      }
    }
    this.i = close + 1;
    return tags;
  }

  private parseProperties(): void {
    const close = this.matchOf(this.i);
    const openToken = this.tokens[this.i];
    this.document.propertiesSpan = {
      start: openToken.start,
      end: close < this.tokens.length ? this.tokens[close].end : this.text.length,
    };
    this.document.sections.push({ kind: 'Properties', ...this.document.propertiesSpan });
    this.i++;
    while (this.i < close) {
      const start = this.i;
      const property = this.parseProperty(close);
      if (property) {
        this.document.properties.push(property);
        continue;
      }
      // 次の行頭(属性または識別子)まで読み飛ばす。
      const line = this.lineOf(this.tokens[start].start);
      this.i = start + 1;
      while (this.i < close && this.lineOf(this.tokens[this.i].start) === line) this.i++;
    }
    this.i = close + 1;
  }

  private parseProperty(close: number): ShaderProperty | undefined {
    const first = this.tokens[this.i];
    const attributes: string[] = [];
    while (this.isValue('[') && this.i < close) {
      const attributeClose = this.findInLine(this.i, ']', close);
      if (attributeClose < 0) {
        this.issue(this.tokens[this.i].start, this.tokens[this.i].end, "Property属性の ']' がありません。", 'error', this.attributeCloseFix(close));
        return undefined;
      }
      attributes.push(this.text.substring(this.tokens[this.i].end, this.tokens[attributeClose].start).trim());
      this.i = attributeClose + 1;
    }
    const nameToken = this.tok();
    if (!nameToken || this.i >= close) return undefined;
    if (nameToken.kind !== 'ident') {
      this.issue(nameToken.start, nameToken.end, 'Property名が必要です。', 'error');
      return undefined;
    }
    this.i++;
    if (!this.isValue('(')) {
      this.issue(nameToken.start, nameToken.end, `Property '${nameToken.value}' の構文が正しくありません。 _Name ("表示名", 型) = 既定値 の形式で記述してください。`, 'error');
      return undefined;
    }
    const parenClose = this.findMatchingParen(this.i, close);
    const display = this.tokens[this.i + 1];
    const comma = this.tokens[this.i + 2];
    if (parenClose < 0 || display?.kind !== 'string' || comma?.value !== ',') {
      this.issue(nameToken.start, nameToken.end, `Property '${nameToken.value}' の構文が正しくありません。 _Name ("表示名", 型) = 既定値 の形式で記述してください。`, 'error');
      return undefined;
    }
    const typeStart = this.tokens[this.i + 3]?.start ?? comma.end;
    const typeEnd = this.tokens[parenClose].start;
    const type = this.text.substring(typeStart, typeEnd).trim();
    const typeKey = type.replace(/\s*\(.*$/s, '').toLowerCase();
    const typeKind = PROPERTY_TYPES[typeKey] ?? '';
    if (!typeKind) {
      const suggestion = closestName(typeKey, Object.keys(PROPERTY_TYPES));
      const fixes: TextFix[] | undefined = suggestion
        ? [
            {
              title: `'${PROPERTY_TYPES[suggestion]}' に変更`,
              edits: [{ start: typeStart, end: typeStart + type.replace(/\s*\(.*$/s, '').length, newText: PROPERTY_TYPES[suggestion] }],
              preferred: true,
            },
          ]
        : undefined;
      this.issue(typeStart, Math.max(typeStart + 1, typeEnd), `不明なProperty型 '${type}' です。`, 'warning', fixes);
    }
    this.i = parenClose + 1;
    let defaultValue = '';
    let end = this.tokens[parenClose].end;
    if (this.isValue('=')) {
      this.i++;
      const valueStart = this.tok();
      if (valueStart && this.i < close) {
        if (valueStart.value === '(') {
          const valueClose = this.findMatchingParen(this.i, close);
          const last = valueClose >= 0 ? valueClose : this.i;
          end = this.tokens[last].end;
          this.i = last + 1;
        } else if (valueStart.kind === 'string') {
          end = valueStart.end;
          this.i++;
          if (this.isValue('{')) {
            const braceClose = this.matchOf(this.i);
            end = this.tokens[Math.min(braceClose, close - 1)].end;
            this.i = Math.min(braceClose, close - 1) + 1;
          }
        } else {
          if (valueStart.value === '-' || valueStart.value === '+') this.i++;
          end = this.tokens[this.i]?.end ?? valueStart.end;
          this.i++;
        }
        defaultValue = this.text.substring(valueStart.start, end).trim();
      }
    } else {
      const value = defaultPropertyValue(typeKind);
      const at = this.tokens[parenClose].end;
      this.issue(nameToken.start, nameToken.end, `Property '${nameToken.value}' に既定値 (= ...) がありません。`, 'error', [
        { title: `既定値 '= ${value}' を追加`, edits: [{ start: at, end: at, newText: ` = ${value}` }], preferred: true },
      ]);
    }
    return {
      name: nameToken.value,
      nameStart: nameToken.start,
      nameEnd: nameToken.end,
      displayName: stringValue(display),
      type,
      typeKind,
      typeStart,
      typeEnd,
      defaultValue,
      attributes,
      start: first.start,
      end,
    };
  }

  /** `[Attr` / `[Attr(args)` の直後に ']' を補う修正。 */
  private attributeCloseFix(limit: number): TextFix[] | undefined {
    const name = this.tokens[this.i + 1];
    if (!name || name.kind !== 'ident' || this.i + 1 >= limit) return undefined;
    let last = this.i + 1;
    if (this.tokens[last + 1]?.value === '(') {
      const parenClose = this.findMatchingParen(last + 1, limit);
      if (parenClose < 0) return undefined;
      last = parenClose;
    }
    const at = this.tokens[last].end;
    return [{ title: "']' を追加", edits: [{ start: at, end: at, newText: ']' }], preferred: true }];
  }

  private findMatchingParen(open: number, limit: number): number {
    let depth = 0;
    for (let t = open; t < limit; t++) {
      const value = this.tokens[t].value;
      if (value === '(') depth++;
      else if (value === ')') {
        depth--;
        if (depth === 0) return t;
      }
    }
    return -1;
  }

  private findInLine(from: number, value: string, limit: number): number {
    const line = this.lineOf(this.tokens[from].start);
    for (let t = from + 1; t < limit; t++) {
      if (this.lineOf(this.tokens[t].start) !== line) return -1;
      if (this.tokens[t].value === value) return t;
    }
    return -1;
  }

  private lineCache?: number[];

  private lineOf(offset: number): number {
    if (!this.lineCache) {
      this.lineCache = [0];
      for (let k = 0; k < this.text.length; k++) {
        if (this.text.charCodeAt(k) === 10) this.lineCache.push(k + 1);
      }
    }
    const starts = this.lineCache;
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return low;
  }

  private tok(): Token | undefined {
    return this.tokens[this.i];
  }

  private isValue(value: string): boolean {
    return this.tokens[this.i]?.value === value;
  }

  private issue(start: number, end: number, message: string, severity: ParseIssue['severity'], fixes?: TextFix[]): void {
    this.document.issues.push(fixes ? { start, end, message, severity, fixes } : { start, end, message, severity });
  }
}
