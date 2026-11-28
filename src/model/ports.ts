import { compareText, type PodClass } from './classes';
import type { PolicyPort, Protocol } from './types';

export interface PortRange {
  readonly protocol: Protocol;
  readonly from: number;
  readonly to: number;
}

/** A named port left unresolved, because the rule has no one destination pod to resolve it on. */
export interface NamedPort {
  readonly protocol: Protocol;
  readonly name: string;
}

export type PortEntry = PortRange | NamedPort;

/**
 * A set of ports: 'all', or entries kept normal (the protocols in the order they first came; in each,
 * its ranges sorted and joined, then its port names sorted), so that two equal sets compare equal.
 */
export type PortSet = 'all' | readonly PortEntry[];

export const ALL: PortSet = 'all';
export const NONE: PortSet = [];

/**
 * The destination of a rule with no peers, which is every pod and address: a named port then stays
 * a name, which each destination pod resolves on its own container ports.
 */
export const EACH_DESTINATION = 'each destination';

const FIRST_PORT = 1;
const LAST_PORT = 65535;
const PROTOCOLS: readonly Protocol[] = ['TCP', 'UDP', 'SCTP'];

const isNamed = (e: PortEntry): e is NamedPort => 'name' in e;
const isWhole = (e: PortEntry) => !isNamed(e) && e.from <= FIRST_PORT && e.to >= LAST_PORT;

function normal(entries: readonly PortEntry[]): PortSet {
  const byProtocol = new Map<Protocol, { ranges: PortRange[]; names: Set<string> }>();
  for (const e of entries) {
    const group = byProtocol.get(e.protocol) ?? { ranges: [], names: new Set<string>() };
    if (isNamed(e)) group.names.add(e.name);
    else group.ranges.push(e);
    byProtocol.set(e.protocol, group);
  }
  const out: PortEntry[] = [];
  for (const [protocol, { ranges, names }] of byProtocol) {
    const merged: PortRange[] = [];
    for (const r of [...ranges].sort((a, b) => a.from - b.from)) {
      const last = merged.at(-1);
      if (last && r.from <= last.to + 1) merged[merged.length - 1] = { protocol, from: last.from, to: Math.max(last.to, r.to) };
      else merged.push({ protocol, from: r.from, to: r.to });
    }
    out.push(...merged);
    // Every port of a protocol already holds each of its named ports.
    if (!merged.some(isWhole)) out.push(...[...names].sort(compareText).map((name) => ({ protocol, name })));
  }
  // Every port of every protocol is every port, whichever way a policy wrote it.
  return PROTOCOLS.every((p) => out.some((e) => e.protocol === p && isWhole(e))) ? ALL : out;
}

export function union(a: PortSet, b: PortSet): PortSet {
  return a === 'all' || b === 'all' ? ALL : normal([...a, ...b]);
}

function meet(x: PortEntry, y: PortEntry): PortEntry | undefined {
  if (x.protocol !== y.protocol) return undefined;
  if (isNamed(x) || isNamed(y)) {
    if (isNamed(x) && isNamed(y)) return x.name === y.name ? x : undefined;
    // A name holds inside every port of its protocol. Against a narrower range only the destination
    // pod could tell; both sides of a call between two pods are always resolved, so this is not reached there.
    return isWhole(x) ? y : isWhole(y) ? x : undefined;
  }
  const from = Math.max(x.from, y.from), to = Math.min(x.to, y.to);
  return from <= to ? { protocol: x.protocol, from, to } : undefined;
}

export function intersect(a: PortSet, b: PortSet): PortSet {
  if (a === 'all') return b;
  if (b === 'all') return a;
  return normal(a.flatMap((x) => b.flatMap((y) => meet(x, y) ?? [])));
}

export function isEmpty(p: PortSet): boolean {
  return p !== 'all' && p.length === 0;
}

type Destination = PodClass | typeof EACH_DESTINATION | undefined;

function entriesOf(p: PolicyPort, dst: Destination): PortEntry[] {
  const protocol = p.protocol ?? 'TCP';
  if (p.port === undefined) return [{ protocol, from: FIRST_PORT, to: LAST_PORT }];
  if (typeof p.port === 'number') return [{ protocol, from: p.port, to: p.endPort ?? p.port }];
  if (dst === EACH_DESTINATION) return [{ protocol, name: p.port }];
  // A named port means the destination pod's container port of that name and protocol. With no
  // destination pod (an address outside the cluster) Kubernetes has nothing to resolve it on.
  return (dst?.ports ?? []).filter((c) => c.name === p.port && c.protocol === protocol).map((c) => ({ protocol, from: c.port, to: c.port }));
}

/**
 * The ports one NetworkPolicy rule lets through to `dst`: a pod, EACH_DESTINATION for a rule with
 * no peers, or undefined for an address outside the cluster. Kubernetes reads no ports, or an empty
 * list, as every port.
 */
export function portsOfRule(ports: readonly PolicyPort[] | undefined, dst: Destination): PortSet {
  if (!ports?.length) return ALL;
  return normal(ports.flatMap((p) => entriesOf(p, dst)));
}

/** Whether the set lets `port` through on `protocol`: by its ranges only, because a port name resolves only on a pod. */
export function admits(p: PortSet, port: number, protocol: Protocol): boolean {
  return p === 'all' || p.some((e) => !isNamed(e) && e.protocol === protocol && e.from <= port && port <= e.to);
}

/** Whether the set holds a port of the protocol, by a range or a name. */
export const hasProtocol = (p: PortSet, protocol: Protocol): boolean => p === 'all' || p.some((e) => e.protocol === protocol);

export function formatPorts(p: PortSet): string {
  if (p === 'all') return 'every port';
  return p
    .map((e) =>
      isNamed(e)
        ? `${e.protocol} port named ${e.name}`
        : isWhole(e)
          ? `every ${e.protocol} port`
          : e.from === e.to
            ? `${e.protocol} ${e.from}`
            : `${e.protocol} ${e.from}-${e.to}`,
    )
    .join(', ');
}
