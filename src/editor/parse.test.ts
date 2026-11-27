import { describe, expect, it } from 'vitest';
import { parseCidr, parseLabels, parsePorts } from './parse';

describe('parseLabels follows Kubernetes key and value rules, so Apply never fails on syntax', () => {
  it.each<[string, [string, string][] | null]>([
    ['', []],
    ['app=frontend, version=2', [['app', 'frontend'], ['version', '2']]],
    ['example.com/tier=web', [['example.com/tier', 'web']]],
    ['app=', [['app', '']]],
    ['app', null],
    ['-app=x', null],
    ['app=x y', null],
    [`app=${'a'.repeat(64)}`, null],
    [`app=${'a'.repeat(63)}`, [['app', 'a'.repeat(63)]]],
    [`${'k'.repeat(64)}=x`, null],
    ['Example.com/tier=web', null],
    ['app=a, app=b', null],
  ])('parseLabels(%j)', (text, expected) => {
    expect(parseLabels(text)).toStrictEqual(expected);
  });
});

it.each<[string, { port: number; protocol: string }[] | null]>([
  ['8080, 443, 53/UDP', [{ port: 8080, protocol: 'TCP' }, { port: 443, protocol: 'TCP' }, { port: 53, protocol: 'UDP' }]],
  ['', []],
  ['9000/sctp', [{ port: 9000, protocol: 'SCTP' }]],
  ['0', null],
  ['65536', null],
  ['http', null],
  ['80/HTTP', null],
])('parsePorts(%j)', (text, expected) => {
  expect(parsePorts(text)).toStrictEqual(expected);
});

it.each<[string, string | null]>([
  [' 192.168.1.0/24 ', '192.168.1.0/24'],
  ['fd00::/8', 'fd00::/8'],
  ['2001:db8::1:0:0:1/128', '2001:db8::1:0:0:1/128'],
  ['::ffff:10.0.0.0/104', '::ffff:10.0.0.0/104'],
  ['10.0.0.0', null],
  ['300.0.0.0/8', null],
  ['10.0.0.0/33', null],
  ['010.0.0.0/8', null],
  ['fd00::/129', null],
  ['fd00::1::/64', null],
  ['fd00:12345::/64', null],
])('parseCidr(%j)', (text, expected) => {
  expect(parseCidr(text)).toBe(expected);
});
