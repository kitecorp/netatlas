export interface DiffLine {
  readonly text: string;
  readonly kind: 'same' | 'added' | 'removed';
}

/**
 * The review's line difference: the longest common subsequence of the two YAML texts, as the
 * prototype computes it. Where both orders are as long, a removed line comes before an added one.
 */
export function diffLines(a: readonly string[], b: readonly string[]): DiffLine[] {
  const n = a.length, m = b.length;
  // lcs[i][j]: the length of the longest common subsequence of a[i..] and b[j..].
  const lcs = Array.from({ length: n + 1 }, () => Array.from<number>({ length: m + 1 }).fill(0));
  const at = (i: number, j: number) => lcs[i]?.[j] ?? 0;
  for (let i = n - 1; i >= 0; i -= 1) {
    const row = lcs[i] as number[];
    for (let j = m - 1; j >= 0; j -= 1) row[j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
  }
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    const x = a[i], y = b[j];
    if (x !== undefined && x === y) {
      out.push({ text: x, kind: 'same' });
      i += 1;
      j += 1;
    } else if (x !== undefined && (y === undefined || at(i + 1, j) >= at(i, j + 1))) {
      out.push({ text: x, kind: 'removed' });
      i += 1;
    } else if (y !== undefined) {
      out.push({ text: y, kind: 'added' });
      j += 1;
    }
  }
  return out;
}

export function changedCount(lines: readonly DiffLine[]): number {
  return lines.filter((l) => l.kind !== 'same').length;
}

/** The line under the review's title. */
export function changesText(n: number): string {
  if (n === 0) return 'No changes. This is what the cluster has now.';
  return n === 1 ? '1 line changed, not saved' : `${n} lines changed, not saved`;
}
