/** 大文字小文字を区別しない編集距離(Damerau-Levenshtein の簡易版: 隣接文字の入れ替えを1とする)。 */
export function editDistance(a: string, b: string, limit = Infinity): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (Math.abs(x.length - y.length) > limit) return limit + 1;
  let previous2: number[] = [];
  let previous = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= y.length; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      let value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1]) value = Math.min(value, previous2[j - 2] + 1);
      current.push(value);
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > limit) return limit + 1;
    previous2 = previous;
    previous = current;
  }
  return previous[y.length];
}

/**
 * 打ち間違いと思われる名前の候補(近い順)。名前の長さに応じて許容する距離を変える。
 * 大文字小文字だけが違うものは最優先にする。
 */
export function similarNames(name: string, candidates: Iterable<string>, max = 3): string[] {
  const limit = name.length <= 3 ? 1 : name.length <= 8 ? 2 : 3;
  const scored: Array<{ candidate: string; distance: number }> = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (candidate === name || seen.has(candidate)) continue;
    seen.add(candidate);
    const distance = candidate.toLowerCase() === name.toLowerCase() ? 0 : editDistance(name, candidate, limit);
    if (distance <= limit) scored.push({ candidate, distance });
  }
  scored.sort((a, b) => a.distance - b.distance || a.candidate.localeCompare(b.candidate));
  return scored.slice(0, max).map((entry) => entry.candidate);
}

export function closestName(name: string, candidates: Iterable<string>): string | undefined {
  return similarNames(name, candidates, 1)[0];
}
