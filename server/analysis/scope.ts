import { HlslFunction, HlslLocal, HlslParameter } from '../parser/ast';
import { SourceFile } from './sourceFile';

export interface LocalLookup {
  variable: HlslLocal | HlslParameter;
  isParameter: boolean;
  fn: HlslFunction;
}

/**
 * offset位置から見えるローカル変数/引数を探す。ブロックによるシャドーイングを考慮し、
 * 有効範囲内で最も内側(後に宣言されたもの)を返す。
 */
export function findLocal(file: SourceFile, unitIndex: number, name: string, offset: number): LocalLookup | undefined {
  const fn = file.functionAt(unitIndex, offset);
  if (!fn) return undefined;
  let best: HlslLocal | undefined;
  for (const local of fn.locals) {
    if (local.name !== name || local.scopeStart > offset || offset > local.scopeEnd) continue;
    if (!best || local.nameStart > best.nameStart) best = local;
  }
  if (best) return { variable: best, isParameter: false, fn };
  const param = fn.params.find((candidate) => candidate.name === name);
  if (param) return { variable: param, isParameter: true, fn };
  return undefined;
}

/** offset位置から見えるローカル変数/引数の一覧(補完用)。同名は内側を優先する。 */
export function visibleLocals(file: SourceFile, unitIndex: number, offset: number): LocalLookup[] {
  const fn = file.functionAt(unitIndex, offset);
  if (!fn || (fn.bodyStart !== undefined && offset < fn.bodyStart)) return [];
  const result = new Map<string, LocalLookup>();
  for (const param of fn.params) result.set(param.name, { variable: param, isParameter: true, fn });
  for (const local of fn.locals) {
    if (local.scopeStart > offset || offset > local.scopeEnd) continue;
    const existing = result.get(local.name);
    if (!existing || existing.isParameter || local.nameStart > existing.variable.nameStart) {
      result.set(local.name, { variable: local, isParameter: false, fn });
    }
  }
  return Array.from(result.values());
}
