import type { IPBlock } from './types';

/** The addresses an address or a CIDR covers, as numbers of one family: 32 bits for IPv4, 128 for IPv6. */
export interface AddressRange {
  readonly bits: 32 | 128;
  readonly first: bigint;
  readonly last: bigint;
}

// Leading zeros are refused, as Kubernetes refuses them in new objects (they read as octal elsewhere).
const OCTET = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4 = new RegExp(`^${OCTET}(\\.${OCTET}){3}$`);
const HEXTET = /^[0-9a-fA-F]{1,4}$/;
const PREFIX = /^(0|[1-9]\d{0,2})$/;

const ipv4Of = (address: string): bigint | null =>
  IPV4.test(address) ? address.split('.').reduce((value, octet) => (value << 8n) | BigInt(octet), 0n) : null;

/** The groups of one side of an IPv6 address as 16-bit words; an IPv4 address may end the address and stands for two. */
function wordsOf(groups: readonly string[], mayEndInIpv4: boolean): bigint[] | null {
  const words: bigint[] = [];
  for (const [i, group] of groups.entries()) {
    const v4 = mayEndInIpv4 && i === groups.length - 1 ? ipv4Of(group) : null;
    if (v4 !== null) words.push(v4 >> 16n, v4 & 0xffffn);
    else if (HEXTET.test(group)) words.push(BigInt(`0x${group}`));
    else return null;
  }
  return words;
}

function ipv6Of(address: string): bigint | null {
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const compressed = halves.length === 2;
  const groups = (s: string) => (s === '' ? [] : s.split(':'));
  // Only the last group of the whole address may be IPv4, so with `::` only its right side may end in one.
  const head = wordsOf(groups(halves[0] ?? ''), !compressed), tail = wordsOf(groups(halves[1] ?? ''), compressed);
  if (!head || !tail) return null;
  const count = head.length + tail.length;
  // `::` stands for at least one group of zeros.
  if (compressed ? count >= 8 : count !== 8) return null;
  return [...head, ...Array<bigint>(8 - count).fill(0n), ...tail].reduce((value, word) => (value << 16n) | word, 0n);
}

/** An address or a CIDR as the range it covers, with its host bits masked; null for anything else. */
export function rangeOf(text: string): AddressRange | null {
  const slash = text.indexOf('/');
  const address = slash < 0 ? text : text.slice(0, slash);
  const v4 = ipv4Of(address);
  const parsed = v4 === null ? { bits: 128 as const, value: ipv6Of(address) } : { bits: 32 as const, value: v4 };
  if (parsed.value === null) return null;
  let prefix: number = parsed.bits;
  if (slash >= 0) {
    const prefixText = text.slice(slash + 1);
    if (!PREFIX.test(prefixText)) return null;
    prefix = Number(prefixText);
    if (prefix > parsed.bits) return null;
  }
  const hostBits = BigInt(parsed.bits - prefix);
  const first = (parsed.value >> hostBits) << hostBits;
  return { bits: parsed.bits, first, last: first + (1n << hostBits) - 1n };
}

/** Whether the whole range of `address` (an address or a CIDR) lies inside the block's cidr and outside every one of its excepts. */
export function blockAdmits(b: IPBlock, address: string): boolean {
  const range = rangeOf(address), cidr = rangeOf(b.cidr);
  if (!range || !cidr || range.bits !== cidr.bits || range.first < cidr.first || range.last > cidr.last) return false;
  // An except netatlas cannot read could hold any part of the range, so it admits nothing it cannot prove.
  return (b.except ?? []).every((text) => {
    const except = rangeOf(text);
    return except !== null && (except.bits !== range.bits || except.last < range.first || except.first > range.last);
  });
}

/**
 * Whether some address of `address` (an address or a CIDR) lies inside the block's cidr and outside
 * every one of its excepts. As blockAdmits does, it counts nothing it cannot prove: with an except
 * netatlas cannot read, the block may admit none of it.
 */
export function blockMayAdmit(b: IPBlock, address: string): boolean {
  const range = rangeOf(address), cidr = rangeOf(b.cidr);
  if (!range || !cidr || range.bits !== cidr.bits) return false;
  const excepts = (b.except ?? []).map(rangeOf);
  if (excepts.some((e) => e === null)) return false;
  // The part of the range inside the cidr, then whether the excepts, in address order, leave a gap in it.
  let next = range.first > cidr.first ? range.first : cidr.first;
  const last = range.last < cidr.last ? range.last : cidr.last;
  const sorted = excepts.filter((e): e is AddressRange => e !== null && e.bits === range.bits).sort((x, y) => (x.first < y.first ? -1 : x.first > y.first ? 1 : 0));
  for (const e of sorted) {
    if (next > last || e.first > next) break;
    if (e.last >= next) next = e.last + 1n;
  }
  return next <= last;
}
