import { expect, it } from 'vitest';
import { changedCount, changesText, diffLines } from './diff';
import { draftFromPolicy, removeRow, specOf, toggleSide, type Draft } from './draft';
import { CART_ALLOW_WITH_KEPT } from './fixtures';
import { forDisplay, toYaml } from './yaml';

it("diffLines(['a','b','c'], ['a','x','c']) keeps a and c, and replaces b with x", () => {
  expect(diffLines(['a', 'b', 'c'], ['a', 'x', 'c'])).toStrictEqual([
    { text: 'a', kind: 'same' },
    { text: 'b', kind: 'removed' },
    { text: 'x', kind: 'added' },
    { text: 'c', kind: 'same' },
  ]);
});

it.each<[number, string]>([
  [0, 'No changes. This is what the cluster has now.'],
  [1, '1 line changed, not saved'],
  [3, '3 lines changed, not saved'],
])('changesText(%i)', (n, expected) => {
  expect(changesText(n)).toBe(expected);
});

const linesOf = (v: unknown) => toYaml(v).split('\n');

it.each<[string, (d: Draft) => Draft, number]>([
  ['an untouched draft shows no difference', (d) => d, 0],
  ['a lock opened and closed again shows no difference', (d) => toggleSide(toggleSide(d, 'out'), 'out'), 0],
  ['removing the web peer removes its three lines', (d) => removeRow(d, 'in', 'in:2:1'), 3],
])('the review %#: %s', (_name, change, expected) => {
  const base = CART_ALLOW_WITH_KEPT;
  const draft = { ...base, spec: specOf(change(draftFromPolicy(base))) };
  expect(changedCount(diffLines(linesOf(forDisplay(base)), linesOf(forDisplay(draft))))).toBe(expected);
});
