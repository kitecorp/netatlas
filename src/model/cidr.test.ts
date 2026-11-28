import { expect, it } from 'vitest';
import { blockAdmits, rangeOf, type AddressRange } from './cidr';
import type { IPBlock } from './types';

it.each<[string, AddressRange | null]>([
  // 10 x 2^24 = 167772160; a /8 spans 2^24 addresses, so it ends 16777215 later.
  ['10.0.0.0/8', { bits: 32, first: 167772160n, last: 184549375n }],
  // The host bits of 10.0.0.1 are masked off.
  ['10.0.0.1/8', { bits: 32, first: 167772160n, last: 184549375n }],
  // An address alone is its own range: 203 x 2^24 + 113 x 2^8 + 10.
  ['203.0.113.10', { bits: 32, first: 3405803786n, last: 3405803786n }],
  // Every IPv4 address, the block egress policies most often name: 2^32 - 1 does not fit a 32-bit shift.
  ['0.0.0.0/0', { bits: 32, first: 0n, last: 4294967295n }],
  ['2001:db8::/64', { bits: 128, first: 0x20010db8000000000000000000000000n, last: 0x20010db800000000ffffffffffffffffn }],
  ['2001:db8::1', { bits: 128, first: 0x20010db8000000000000000000000001n, last: 0x20010db8000000000000000000000001n }],
  ['example.com', null],
  ['300.1.1.1', null],
])('rangeOf(%j)', (text, expected) => {
  expect(rangeOf(text)).toStrictEqual(expected);
});

const partner: IPBlock = { cidr: '203.0.113.0/24', except: ['203.0.113.128/25'] };

it.each<[IPBlock, string, boolean]>([
  [partner, '203.0.113.10', true],
  // Inside the cidr, but inside its except too.
  [partner, '203.0.113.200', false],
  // 203.0.113.0 to .63: all inside the cidr, none in the except.
  [partner, '203.0.113.0/26', true],
  // The whole /24 holds the except's half, so not all of it is admitted.
  [partner, '203.0.113.0/24', false],
  [partner, '198.51.100.1', false],
  // Another family is never inside an IPv4 block.
  [partner, '2001:db8::1', false],
  [{ cidr: '0.0.0.0/0' }, '203.0.113.200', true],
  [{ cidr: '2001:db8::/32' }, '2001:db8::1', true],
])('blockAdmits(%j, %j)', (block, address, expected) => {
  expect(blockAdmits(block, address)).toBe(expected);
});
