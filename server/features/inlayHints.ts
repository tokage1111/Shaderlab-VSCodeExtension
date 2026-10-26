import { InlayHint, InlayHintKind } from 'vscode-languageserver';
import { SourceFile } from '../analysis/sourceFile';
import { TypeEvaluator } from '../analysis/typeEvaluator';
import { Workspace } from '../analysis/workspace';
import { HlslFunction } from '../parser/ast';

/**
 * out / inout 引数への呼び出し側の引数に `out:` / `inout:` を表示する。
 */
export async function provideInlayHints(workspace: Workspace, file: SourceFile, start: number, end: number): Promise<InlayHint[]> {
  if (!workspace.settings.inlayHints.parameterQualifiers) return [];
  const hints: InlayHint[] = [];
  const tokens = file.tokens;
  for (let unitIndex = 0; unitIndex < file.units.length; unitIndex++) {
    const unit = file.units[unitIndex];
    if (unit.end < start || unit.start > end) continue;
    const context = await workspace.contextForUnit(file, unitIndex);
    const evaluator = new TypeEvaluator(context, file, unitIndex);
    for (let index = unit.tokenStart; index < unit.tokenEnd; index++) {
      const token = tokens[index];
      if (token.start < start || token.start > end) continue;
      if (token.kind !== 'ident' || tokens[index + 1]?.value !== '(' || unit.declarationOffsets.has(token.start)) continue;
      if (tokens[index - 1]?.value === '.') continue;
      const symbols = context.lookup(token.value);
      if (symbols.length === 0 || symbols.some((symbol) => symbol.kind !== 'function')) continue;
      const close = evaluator.matchForward(index + 1);
      if (close < 0) continue;
      const args = evaluator.splitArguments(index + 1, close);
      const count = evaluator.countArguments(args);
      const candidates = symbols
        .map((symbol) => symbol.node as HlslFunction)
        .filter((fn) => count >= fn.params.filter((param) => !param.hasDefault).length && count <= fn.params.length);
      if (candidates.length === 0) continue;

      let paramIndex = 0;
      for (const [from, to] of args) {
        const width = evaluator.countArguments([[from, to]]);
        const qualifiers = new Set(candidates.map((fn) => fn.params[paramIndex]?.qualifier));
        paramIndex += width;
        if (qualifiers.size !== 1) continue;
        const qualifier = [...qualifiers][0];
        if (qualifier !== 'out' && qualifier !== 'inout') continue;
        hints.push({
          position: file.lineIndex.positionAt(tokens[from].start),
          label: `${qualifier}:`,
          kind: InlayHintKind.Parameter,
          paddingRight: true,
        });
      }
    }
  }
  return hints;
}
