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
};

/** `NetworkPolicies`, `AuthorizationPolicies`: a kind as people read it. */
export const kindName = (kind: WatchedKind): string => KIND_NAMES[kind];

/** The line shown for a kind the API server refused to list (403), which is never the same as having none. */
export const cannotReadLine = (kind: WatchedKind): string => `Cannot read ${KIND_NAMES[kind]}: netatlas's role does not allow it.`;

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
