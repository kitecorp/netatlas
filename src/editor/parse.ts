import type { Protocol } from '@/model/types';

// Kubernetes' rules for label keys and values (apimachinery validation IsQualifiedName and
// IsValidLabelValue): a name of at most 63 characters, starting and ending with a letter or digit,
// with '-', '_' and '.' inside; a key may carry a DNS subdomain prefix of at most 253 characters.
const NAME = /^[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/;
const PREFIX = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
const MAX_PREFIX = 253;

function validKey(key: string): boolean {
  const slash = key.lastIndexOf('/');
  if (slash < 0) return NAME.test(key);
  const prefix = key.slice(0, slash);
  return prefix.length <= MAX_PREFIX && PREFIX.test(prefix) && NAME.test(key.slice(slash + 1));
}

const parts = (text: string) =>
  text
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

/** `app=frontend, version=2` as pairs; null when any pair breaks Kubernetes' rules, so Apply never fails on syntax. */
export function parseLabels(text: string): [string, string][] | null {
  const out: [string, string][] = [];
  for (const part of parts(text)) {
    const eq = part.indexOf('=');
    if (eq < 0) return null;
    const key = part.slice(0, eq), value = part.slice(eq + 1);
    if (!validKey(key) || (value !== '' && !NAME.test(value))) return null;
    // A selector holds each key once; a second value would silently replace the first.
    if (out.some(([k]) => k === key)) return null;
    out.push([key, value]);
  }
  return out;
}

const FIRST_PORT = 1;
const LAST_PORT = 65535;

/** `8080, 443, 53/UDP`: each port from 1 to 65535, TCP unless it names UDP or SCTP. */
export function parsePorts(text: string): { port: number; protocol: Protocol }[] | null {
  const out: { port: number; protocol: Protocol }[] = [];
  for (const part of parts(text)) {
    const m = /^(\d{1,5})(?:\s*\/\s*(tcp|udp|sctp))?$/i.exec(part);
    if (!m) return null;
    const port = Number(m[1]);
    if (port < FIRST_PORT || port > LAST_PORT) return null;
    out.push({ port, protocol: (m[2] ?? 'TCP').toUpperCase() as Protocol });
  }
  return out;
}

// Leading zeros are refused, as Kubernetes refuses them in new objects (they read as octal elsewhere).
const OCTET = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4 = new RegExp(`^${OCTET}(\\.${OCTET}){3}$`);
const HEXTET = /^[0-9a-fA-F]{1,4}$/;

function validIpv6(address: string): boolean {
  const halves = address.split('::');
  if (halves.length > 2) return false;
  const groups = (s: string) => (s === '' ? [] : s.split(':'));
  const head = groups(halves[0] ?? ''), tail = groups(halves[1] ?? '');
  // An IPv4 address may end the address and stands for two groups.
  const last = (halves.length === 2 ? tail : head).at(-1);
  const v4 = last !== undefined && IPV4.test(last);
  const all = [...head, ...tail];
  const hexGroups = v4 ? all.slice(0, -1) : all;
  if (!hexGroups.every((g) => HEXTET.test(g))) return false;
  const count = hexGroups.length + (v4 ? 2 : 0);
  return halves.length === 2 ? count < 8 : count === 8;
}

/** An IPv4 or IPv6 address with a prefix length, trimmed; null for anything else. */
export function parseCidr(text: string): string | null {
  const s = text.trim();
  const m = /^([^/]+)\/(0|[1-9]\d{0,2})$/.exec(s);
  if (!m?.[1] || !m[2]) return null;
  const address = m[1], prefix = Number(m[2]);
  if (IPV4.test(address)) return prefix <= 32 ? s : null;
  if (address.includes(':') && validIpv6(address)) return prefix <= 128 ? s : null;
  return null;
}
