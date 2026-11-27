import { expect, it } from 'vitest';
import { formatAge } from './format';

it.each<[number, 'short' | 'long', string]>([
  [4000, 'short', '4 s ago'],
  [720000, 'short', '12 min ago'],
  [720000, 'long', '12 minutes ago'],
  [60000, 'long', '1 minute ago'],
  [30000, 'long', '30 seconds ago'],
  [1000, 'long', '1 second ago'],
  [7200000, 'short', '2 h ago'],
  [3600000, 'long', '1 hour ago'],
  [172800000, 'long', '2 days ago'],
])('formatAge(%i, %s) is %s', (ms, style, expected) => {
  expect(formatAge(ms, style)).toBe(expected);
});
