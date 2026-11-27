import { expect, it } from 'vitest';
import { matchesSelector } from './selectors';
import type { LabelSelector, Labels } from './types';

const cart: Labels = { app: 'cart', tier: 'backend' };

it.each<[string, LabelSelector, Labels, boolean]>([
  ['{} matches every pod', {}, cart, true],
  ['{} matches a pod with no labels', {}, {}, true],
  ['matchLabels matches equal values', { matchLabels: { app: 'cart' } }, cart, true],
  ['matchLabels refuses another value', { matchLabels: { app: 'api' } }, cart, false],
  ['matchLabels refuses a missing key', { matchLabels: { zone: 'a' } }, cart, false],
  ['In matches a listed value', { matchExpressions: [{ key: 'app', operator: 'In', values: ['api', 'cart'] }] }, cart, true],
  ['In refuses an unlisted value', { matchExpressions: [{ key: 'app', operator: 'In', values: ['api'] }] }, cart, false],
  ['In refuses a missing key', { matchExpressions: [{ key: 'zone', operator: 'In', values: ['a'] }] }, cart, false],
  ['NotIn matches an unlisted value', { matchExpressions: [{ key: 'app', operator: 'NotIn', values: ['api'] }] }, cart, true],
  ['NotIn matches a missing key', { matchExpressions: [{ key: 'zone', operator: 'NotIn', values: ['a'] }] }, cart, true],
  ['NotIn refuses a listed value', { matchExpressions: [{ key: 'app', operator: 'NotIn', values: ['cart'] }] }, cart, false],
  ['Exists matches a present key', { matchExpressions: [{ key: 'tier', operator: 'Exists' }] }, cart, true],
  ['Exists refuses a missing key', { matchExpressions: [{ key: 'zone', operator: 'Exists' }] }, cart, false],
  ['DoesNotExist matches a missing key', { matchExpressions: [{ key: 'zone', operator: 'DoesNotExist' }] }, cart, true],
  ['DoesNotExist refuses a present key', { matchExpressions: [{ key: 'tier', operator: 'DoesNotExist' }] }, cart, false],
  [
    'matchLabels and matchExpressions both hold',
    { matchLabels: { app: 'cart' }, matchExpressions: [{ key: 'tier', operator: 'Exists' }] },
    cart,
    true,
  ],
  [
    'a failing matchExpressions refuses even when matchLabels holds',
    { matchLabels: { app: 'cart' }, matchExpressions: [{ key: 'tier', operator: 'In', values: ['frontend'] }] },
    cart,
    false,
  ],
  [
    'a failing matchLabels refuses even when matchExpressions holds',
    { matchLabels: { app: 'api' }, matchExpressions: [{ key: 'tier', operator: 'Exists' }] },
    cart,
    false,
  ],
  [
    'every expression must hold',
    { matchExpressions: [{ key: 'tier', operator: 'Exists' }, { key: 'zone', operator: 'Exists' }] },
    cart,
    false,
  ],
])('matchesSelector %#: %s', (_name, sel, labels, expected) => {
  expect(matchesSelector(sel, labels)).toBe(expected);
});
