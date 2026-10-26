import { Position, Range } from 'vscode-languageserver';

/** offset <-> 行/列 の変換表。 */
export class LineIndex {
  private readonly lineStarts: number[];

  public constructor(private readonly text: string) {
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) starts.push(i + 1);
    }
    this.lineStarts = starts;
  }

  public positionAt(offset: number): Position {
    const safe = Math.max(0, Math.min(offset, this.text.length));
    let low = 0;
    let high = this.lineStarts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (this.lineStarts[middle] <= safe) low = middle;
      else high = middle - 1;
    }
    return { line: low, character: safe - this.lineStarts[low] };
  }

  public offsetAt(position: Position): number {
    if (position.line >= this.lineStarts.length) return this.text.length;
    if (position.line < 0) return 0;
    const lineStart = this.lineStarts[position.line];
    const nextLineStart = position.line + 1 < this.lineStarts.length ? this.lineStarts[position.line + 1] : this.text.length;
    return Math.max(lineStart, Math.min(lineStart + position.character, nextLineStart));
  }

  public range(start: number, end: number): Range {
    return { start: this.positionAt(start), end: this.positionAt(end) };
  }

  public lineStart(line: number): number {
    return this.lineStarts[Math.max(0, Math.min(line, this.lineStarts.length - 1))];
  }
}
