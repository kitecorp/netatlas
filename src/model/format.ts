import type { ClusterResources, WatchedKind } from './types';

const UNITS = [
  { ms: 86_400_000, short: 'd', long: 'day' },
  { ms: 3_600_000, short: 'h', long: 'hour' },
  { ms: 60_000, short: 'min', long: 'minute' },
  { ms: 1000, short: 's', long: 'second' },
] as const;

/** The overview's `12 min ago` (short) and the unreachable row's `12 minutes ago` (long), in the largest whole unit. */
export function formatAge(ms: number, style: 'short' | 'long'): string {
  const unit = UNITS.find((u) => ms >= u.ms) ?? UNITS[3];
  const n = Math.floor(Math.max(ms, 0) / unit.ms);
  return style === 'short' ? `${n} ${unit.short} ago` : `${n} ${unit.long}${n === 1 ? '' : 's'} ago`;
}

/** `a`, `a and b`, `a, b and c`. */
export function joinNames(names: readonly string[]): string {
  return names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** The text with its first letter capitalised, so that the rest of a sentence stands on its own. */
export const capitalised = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** A workload as a person reads it beside workloads of other namespaces: `traffic / client`. */
export const workloadText = (namespace: string, name: string): string => `${namespace} / ${name}`;

/** `1 pod`, `2 pods`. */
export const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

const KIND_NAMES: Readonly<Record<WatchedKind, string>> = {
  namespaces: 'Namespaces',
  pods: 'Pods',
  replicasets: 'ReplicaSets',
  jobs: 'Jobs',
  daemonsets: 'DaemonSets',
  networkpolicies: 'NetworkPolicies',
  authorizationpolicies: 'AuthorizationPolicies',
  serviceentries: 'ServiceEntries',
  sidecars: 'Sidecars',
};

/** `NetworkPolicies`, `AuthorizationPolicies`: a kind as people read it. */
export const kindName = (kind: WatchedKind): string => KIND_NAMES[kind];

/** The line shown for a kind the API server refused to list (403), which is never the same as having none. */
export const cannotReadLine = (kind: WatchedKind): string => `Cannot read ${KIND_NAMES[kind]}: netatlas's role does not allow it.`;

/**
 * A verdict's words when a kind the API server refused to list could decide it: the reader gives such a
 * kind as an empty list, which must never read as having none.
 */
export const cannotReadDepends = (kinds: readonly WatchedKind[]): string => `depends: netatlas's role may not read ${joinNames(kinds.map(kindName))}`;

/** Whether the API server refused to let netatlas list this kind. */
export const forbidden = (r: ClusterResources, kind: WatchedKind): boolean => r.readErrors.some((e) => e.kind === kind);

/** The policy kinds a cluster has, read or not: AuthorizationPolicies only where Istio is installed. */
export const installedPolicyKinds = (r: ClusterResources): WatchedKind[] => ['networkpolicies', ...(r.authorizationPolicies === 'not-installed' ? [] : ['authorizationpolicies' as const])];

/** What a page of a cluster says before netatlas has read it once. */
export const notReadYet = (cluster: string): string => `netatlas has not read ${cluster} yet.`;

/** What every list and side panel calls each policy kind. */
export const POLICY_KIND_TEXT: Readonly<Record<'NetworkPolicy' | 'AuthorizationPolicy', string>> = { NetworkPolicy: 'NetworkPolicy', AuthorizationPolicy: 'Istio AuthorizationPolicy' };

/** What Apply says, in the editor and in the route's answer, for a cluster netatlas cannot reach now. */
export const CANNOT_APPLY = 'netatlas cannot reach this cluster now, so it cannot apply. Copy YAML still works.';

/**
 * `n` with one decimal below `wholeFrom` and whole from it. It stays a number, so printing it drops a
 * trailing `.0` (`9.0` prints `9`), and `count` can pick the singular for exactly 1.
 */
const figure = (n: number, wholeFrom: number): number => (n < wholeFrom ? Math.round(n * 10) / 10 : Math.round(n));

/** Below this a request rate reads `< 0.1`: one decimal cannot show it. */
const FEWEST_REQUESTS = 0.1;

/** A rate of things a second as a label shows it, by the thing's short name: `52 req/s`, `0.8 req/s`, `< 0.1 req/s`. */
const rateLabel = (perSecond: number, short: string): string => (perSecond < FEWEST_REQUESTS ? `< ${FEWEST_REQUESTS} ${short}/s` : `${figure(perSecond, 1)} ${short}/s`);

/** A rate of things a second in words: `52 requests a second`, `1 request a second`. */
const rateWords = (perSecond: number, one: string, many: string): string =>
  perSecond < FEWEST_REQUESTS ? `less than ${FEWEST_REQUESTS} ${many} a second` : `${count(figure(perSecond, 1), one, many)} a second`;

/** A traffic edge's request rate as its label shows it: `52 req/s`, `0.8 req/s`, `< 0.1 req/s`. */
export const formatRequests = (perSecond: number): string => rateLabel(perSecond, 'req');

/** The request rate in words: `52 requests a second`, `1 request a second`. */
export const requestWords = (perSecond: number): string => rateWords(perSecond, 'request', 'requests');

/** A rate of closed connections as an edge's label shows it: `0.2 conn/s`. */
export const formatConnections = (perSecond: number): string => rateLabel(perSecond, 'conn');

/** The rate of closed connections in words: `0.2 connections a second`, `1 connection a second`. */
export const connectionWords = (perSecond: number): string => rateWords(perSecond, 'connection', 'connections');

/** Below this a share, in percent, reads `< 0.1%`. */
const SMALLEST_PERCENT = 0.1;

const percent = (share: number) => figure(share * 100, 10);

/** The share of requests that failed, from 0 to 1, as a label shows it: `2.1%`, `15%`, `< 0.1%`. */
export function formatShare(share: number): string {
  return share * 100 < SMALLEST_PERCENT ? `< ${SMALLEST_PERCENT}%` : `${percent(share)}%`;
}

/** The share in words: `2.1 percent errors`. */
export function shareWords(share: number): string {
  return `${share * 100 < SMALLEST_PERCENT ? `less than ${SMALLEST_PERCENT}` : percent(share)} percent errors`;
}

/** The byte units by powers of 1000, largest first; the first one the rate reaches is used. */
const BYTE_UNITS = [
  { size: 1e6, short: 'MB', one: 'megabyte', many: 'megabytes' },
  { size: 1e3, short: 'kB', one: 'kilobyte', many: 'kilobytes' },
  { size: 1, short: 'B', one: 'byte', many: 'bytes' },
] as const;

type ByteUnit = (typeof BYTE_UNITS)[number];

/** The rate in its unit, or undefined below 1 byte a second, which reads `< 1 B/s`. */
function inUnit(perSecond: number): { n: number; unit: ByteUnit } | undefined {
  const i = BYTE_UNITS.findIndex((u) => perSecond >= u.size);
  const reached = BYTE_UNITS[i], larger = BYTE_UNITS[i - 1];
  if (!reached) return undefined;
  const at = (unit: ByteUnit) => ({ n: figure(perSecond / unit.size, 10), unit });
  // Rounding can carry the figure to 1000 (999.6 B/s), which is 1 of the next unit up.
  const v = at(reached);
  return v.n >= 1000 && larger ? at(larger) : v;
}

/** A byte rate as a label shows it, in B, kB or MB by powers of 1000: `18 kB/s`, `9.5 kB/s`, `< 1 B/s`. */
export function formatBytes(perSecond: number): string {
  const v = inUnit(perSecond);
  return v ? `${v.n} ${v.unit.short}/s` : '< 1 B/s';
}

/** The byte rate in words: `18 kilobytes a second over TCP`. */
export function bytesWords(perSecond: number): string {
  const v = inUnit(perSecond);
  return `${v ? count(v.n, v.unit.one, v.unit.many) : 'less than 1 byte'} a second over TCP`;
}
