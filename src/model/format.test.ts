import { expect, it } from 'vitest';
import { bytesWords, cannotReadLine, formatAge, formatBytes, formatRequests, formatShare, requestWords, shareWords } from './format';
import type { WatchedKind } from './types';

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

it.each<[WatchedKind, string]>([
  ['sidecars', "Cannot read Sidecars: netatlas's role does not allow it."],
  ['serviceentries', "Cannot read ServiceEntries: netatlas's role does not allow it."],
])('cannotReadLine(%s) names the kind as people read it', (kind, expected) => {
  expect(cannotReadLine(kind)).toBe(expected);
});

const REQUESTS = { formatRequests, requestWords };
it.each<[keyof typeof REQUESTS, number, string]>([
  ['formatRequests', 52.4, '52 req/s'],
  ['requestWords', 52.4, '52 requests a second'],
  ['formatRequests', 1.2, '1 req/s'],
  ['requestWords', 1.2, '1 request a second'],
  ['formatRequests', 0.84, '0.8 req/s'],
  ['requestWords', 0.84, '0.8 requests a second'],
  ['formatRequests', 0.04, '< 0.1 req/s'],
  ['requestWords', 0.04, 'less than 0.1 requests a second'],
])('%s(%s) is %s', (fn, perSecond, expected) => {
  expect(REQUESTS[fn](perSecond)).toBe(expected);
});

const SHARES = { formatShare, shareWords };
it.each<[keyof typeof SHARES, number, string]>([
  ['formatShare', 0.021, '2.1%'],
  ['shareWords', 0.021, '2.1 percent errors'],
  ['formatShare', 0.15, '15%'],
  ['formatShare', 1, '100%'],
  ['formatShare', 0.0004, '< 0.1%'],
])('%s(%s) is %s', (fn, share, expected) => {
  expect(SHARES[fn](share)).toBe(expected);
});

const BYTES = { formatBytes, bytesWords };
it.each<[keyof typeof BYTES, number, string]>([
  ['formatBytes', 18000, '18 kB/s'],
  ['bytesWords', 18000, '18 kilobytes a second over TCP'],
  ['formatBytes', 9500, '9.5 kB/s'],
  ['formatBytes', 9000, '9 kB/s'],
  ['formatBytes', 950, '950 B/s'],
  ['bytesWords', 950, '950 bytes a second over TCP'],
  ['formatBytes', 2.5e6, '2.5 MB/s'],
  ['bytesWords', 2.5e6, '2.5 megabytes a second over TCP'],
  ['formatBytes', 0.4, '< 1 B/s'],
  ['bytesWords', 0.4, 'less than 1 byte a second over TCP'],
  // The unit is chosen from the rounded value.
  ['formatBytes', 999999, '1 MB/s'],
  ['formatBytes', 999.6, '1 kB/s'],
])('%s(%s) is %s', (fn, perSecond, expected) => {
  expect(BYTES[fn](perSecond)).toBe(expected);
});
