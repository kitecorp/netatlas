import { cannotReadLine, count, forbidden, installedPolicyKinds, joinNames, kindName } from './format';
import { freshness } from './freshness';
import { clusterGraph } from './graph';
import type { ClusterResources, ClusterSnapshot, IstioMode, WatchedKind } from './types';

/** What a cluster's policies count: the policies read (null when no policy kind could be read), and the kinds refused. */
export interface PolicyCount {
  readonly read: number | null;
  readonly cannotRead: readonly WatchedKind[];
}

export type OverviewRow =
  | { readonly kind: 'connecting'; readonly name: string }
  | {
      readonly kind: 'reachable';
      readonly name: string;
      readonly kubernetes: string;
      readonly workloads: number | null;
      readonly policies: PolicyCount;
      readonly networkPolicies: number | null;
      readonly noPolicy: number | null;
      readonly enforcer: string;
      readonly istio: IstioMode | typeof CANNOT_READ;
      /** The cluster answers, but its reader is starting again, so the data is as old as `dataAt`. */
      readonly reading: boolean;
      readonly dataAt: Date;
      readonly cannotRead: readonly string[];
    }
  | {
      readonly kind: 'unreachable';
      readonly name: string;
      readonly since: Date;
      readonly reason: string;
      readonly dataAt: Date | null;
      readonly workloads: number | null;
      readonly policies: PolicyCount | null;
    };

/** A total over the reachable clusters, and the clusters whose part of it netatlas could not read. */
export interface Total {
  readonly value: number;
  readonly missing: readonly string[];
}

export interface OverviewTotals {
  readonly clusters: number;
  readonly unreachable: number;
  readonly workloads: Total;
  readonly policies: Total;
  readonly noPolicy: Total;
}

export interface Attention {
  readonly title: string;
  readonly text: string;
}

export const NO_ENFORCER = 'none found: policies may not be enforced';
export const CANNOT_READ = 'cannot read';

/** `v1.37.0` and `v1.37.2-eks-a737599` both give `1.37`; anything else is shown as it came. */
const majorMinor = (version: string) => /^v?(\d+)\.(\d+)/.exec(version)?.slice(1, 3).join('.') ?? version;

/** The policies read and the policy kinds refused; a refused kind is never counted as none. */
function policyCount(r: ClusterResources): PolicyCount {
  const installed = installedPolicyKinds(r);
  const cannotRead = installed.filter((k) => forbidden(r, k));
  const read = r.networkPolicies.length + (r.authorizationPolicies === 'not-installed' ? 0 : r.authorizationPolicies.length);
  return { read: cannotRead.length === installed.length ? null : read, cannotRead };
}

/** The Policies cell (`7`, `2 · cannot read AuthorizationPolicies`) or the same count in a sentence (`2 policies, cannot read …`). */
export function policyCountText(c: PolicyCount, style: 'cell' | 'sentence'): string {
  const refused = c.cannotRead.length ? `cannot read ${joinNames(c.cannotRead.map(kindName))}` : '';
  if (c.read === null) return refused;
  const read = style === 'cell' ? String(c.read) : count(c.read, 'policy', 'policies');
  return refused ? `${read}${style === 'cell' ? ' ·' : ','} ${refused}` : read;
}

/** The note under a total card, which names the clusters it leaves out. */
export const totalNote = (t: Total, note: string): string => (t.missing.length ? `${note}, not counting what netatlas cannot read in ${joinNames(t.missing)}` : note);

/** The counts read from a cluster's resources; null where netatlas could not read what the count needs. */
function counts(r: ClusterResources) {
  const nodes = clusterGraph(r).namespaces.flatMap((n) => n.workloads);
  const podsRead = !forbidden(r, 'pods');
  const policies = policyCount(r);
  return {
    workloads: podsRead ? nodes.length : null,
    policies,
    networkPolicies: forbidden(r, 'networkpolicies') ? null : r.networkPolicies.length,
    // A kind netatlas may not read is "cannot read", never "no policy".
    noPolicy: podsRead && !policies.cannotRead.length ? nodes.filter((n) => n.noPolicy).length : null,
  };
}

/** One row per cluster, in the registry's order. The data's age counts from when the reader last held the cluster's state. */
export function overviewRows(clusters: readonly ClusterSnapshot[]): OverviewRow[] {
  return clusters.map((c): OverviewRow => {
    const s = c.status, f = freshness(c);
    if (s.state === 'unreachable') {
      // The last data stays on screen, marked with its age.
      const known = c.resources ? counts(c.resources) : null;
      return { kind: 'unreachable', name: c.name, since: s.since, reason: s.reason, dataAt: f.kind === 'none' ? null : f.at, workloads: known?.workloads ?? null, policies: known?.policies ?? null };
    }
    // A cluster that answers but has not been read yet has nothing to show either.
    if (s.state === 'connecting' || !c.resources || f.kind === 'none') return { kind: 'connecting', name: c.name };
    const r = c.resources;
    // Without the DaemonSets neither the enforcer nor ambient mode's ztunnel can be seen.
    const daemonSetsRead = !forbidden(r, 'daemonsets');
    return {
      kind: 'reachable',
      name: c.name,
      kubernetes: majorMinor(s.kubernetesVersion),
      ...counts(r),
      enforcer: daemonSetsRead ? (r.enforcer ?? NO_ENFORCER) : CANNOT_READ,
      istio: daemonSetsRead && !forbidden(r, 'pods') ? r.istio : CANNOT_READ,
      reading: f.kind === 'reading',
      dataAt: f.at,
      cannotRead: r.readErrors.map((e) => cannotReadLine(e.kind)),
    };
  });
}

/** The cards above the table: workloads, policies and open workloads count the reachable clusters only. */
export function overviewTotals(rows: readonly OverviewRow[]): OverviewTotals {
  const reachable = rows.flatMap((r) => (r.kind === 'reachable' ? [r] : []));
  const total = (f: (r: (typeof reachable)[number]) => { value: number | null; whole: boolean }): Total => ({
    value: reachable.reduce((n, r) => n + (f(r).value ?? 0), 0),
    missing: reachable.filter((r) => !f(r).whole).map((r) => r.name),
  });
  return {
    clusters: rows.length,
    unreachable: rows.filter((r) => r.kind === 'unreachable').length,
    workloads: total((r) => ({ value: r.workloads, whole: r.workloads !== null })),
    policies: total((r) => ({ value: r.policies.read, whole: !r.policies.cannotRead.length })),
    noPolicy: total((r) => ({ value: r.noPolicy, whole: r.noPolicy !== null })),
  };
}

/** What the overview asks someone to look at, across the reachable clusters, the kinds netatlas may not read last. */
export function needsAttention(rows: readonly OverviewRow[]): Attention[] {
  const reachable = rows.flatMap((r) => (r.kind === 'reachable' ? [r] : []));
  const unenforced = reachable
    .filter((r) => r.enforcer === NO_ENFORCER && (r.networkPolicies ?? 0) > 0)
    .map((r): Attention => {
      const n = r.networkPolicies ?? 0;
      return { title: 'Policies not enforced', text: `${r.name} has ${count(n, 'NetworkPolicy', 'NetworkPolicies')}, but no enforcer was found, so ${n === 1 ? 'it' : 'they'} may do nothing.` };
    });
  const open = reachable.filter((r) => (r.noPolicy ?? 0) > 0);
  const total = open.reduce((n, r) => n + (r.noPolicy ?? 0), 0);
  const most = open.reduce<(typeof open)[number] | undefined>((m, r) => (!m || (r.noPolicy ?? 0) > (m.noPolicy ?? 0) ? r : m), undefined);
  const openItems: Attention[] = most
    ? [
        {
          title: 'Open workloads',
          text:
            `${count(total, 'workload', 'workloads')} in ${count(open.length, 'cluster', 'clusters')} ${total === 1 ? 'has' : 'have'} no policy, so anything may call ${total === 1 ? 'it' : 'them'}.` +
            (open.length > 1 ? ` Most are in ${most.name} (${most.noPolicy}).` : ''),
        },
      ]
    : [];
  const cannotRead = reachable.flatMap((r) => r.cannotRead.map((line): Attention => ({ title: 'Cannot read', text: `${r.name}: ${line}` })));
  const items = [...unenforced, ...openItems, ...cannotRead];
  return items.length ? items : [{ title: '', text: 'Nothing needs attention.' }];
}

/**
 * Whether the overview's search keeps a cluster: the query matches, ignoring case, part of its name,
 * of a workload's name or of a policy's name. An empty query keeps every cluster.
 */
export function matchesSearch(c: ClusterSnapshot, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const r = c.resources;
  const policies = r ? [...r.networkPolicies, ...(r.authorizationPolicies === 'not-installed' ? [] : r.authorizationPolicies)] : [];
  const names = [c.name, ...(r?.pods.map((p) => p.workload.name) ?? []), ...policies.map((p) => p.metadata.name)];
  return names.some((n) => n.toLowerCase().includes(q));
}
