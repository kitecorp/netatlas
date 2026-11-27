import { compareText, refOf, uniqueRefs, workloadIdOf } from './classes';
import { cannotReadLine, count, forbidden, installedPolicyKinds, joinNames, kindName, notReadYet } from './format';
import { appliesTo, attachedToWaypoint } from './istio';
import { matchesSelector } from './selectors';
import type { AuthorizationPolicyObject, ClusterResources, ClusterSnapshot, LabelSelector, NetworkPolicyObject, PodInfo, PolicyRef } from './types';

export interface PolicyRow {
  readonly namespace: string;
  readonly name: string;
  readonly kind: PolicyRef['kind'];
  /** The workloads the policy selects now, as `<kind> <name>`. */
  readonly covers: readonly string[];
  readonly notes: readonly string[];
  readonly href: string;
}

export interface Coverage {
  readonly chips: readonly string[];
  readonly pods: readonly string[];
  readonly matchLine: string;
  readonly workloadsLine: string;
  readonly alsoCoveredBy: readonly PolicyRef[];
}

const NOT_EVALUATED = 'Not evaluated: attached to a waypoint.';
const NOT_ENFORCED = 'Istio not enforced';

type AnyPolicy = NetworkPolicyObject | AuthorizationPolicyObject;

/** The pods a policy selects now. A waypoint policy selects none by label: it is attached to a waypoint instead. */
function podsOf(p: AnyPolicy, r: ClusterResources): PodInfo[] {
  if (refOf(p).kind === 'NetworkPolicy') {
    const np = p as NetworkPolicyObject;
    return r.pods.filter((pod) => pod.namespace === np.metadata.namespace && matchesSelector(np.spec.podSelector, pod.labels));
  }
  const ap = p as AuthorizationPolicyObject;
  return attachedToWaypoint(ap) ? [] : r.pods.filter((pod) => appliesTo(ap, r.istioSettings.rootNamespace, pod));
}

const policiesOf = (r: ClusterResources): AnyPolicy[] => [...r.networkPolicies, ...(r.authorizationPolicies === 'not-installed' ? [] : r.authorizationPolicies)];

const workloadText = (pod: PodInfo) => `${pod.workload.kind} ${pod.workload.name}`;

const selectorLabels = (p: AnyPolicy) => {
  const labels = 'podSelector' in p.spec ? (p.spec as NetworkPolicyObject['spec']).podSelector.matchLabels : (p.spec as AuthorizationPolicyObject['spec']).selector?.matchLabels;
  return Object.entries(labels ?? {}).map(([k, v]) => `${k}=${v}`);
};

const PLURAL: Readonly<Record<PolicyRef['kind'], string>> = { NetworkPolicy: 'networkpolicies', AuthorizationPolicy: 'authorizationpolicies' };

/** The page of one policy: the editor for a NetworkPolicy, the read-only view for an AuthorizationPolicy. */
export const policyHref = (cluster: string, r: PolicyRef): string =>
  `/policies/${encodeURIComponent(cluster)}/${encodeURIComponent(r.namespace)}/${PLURAL[r.kind]}/${encodeURIComponent(r.name)}`;

function rowOf(cluster: string, p: AnyPolicy, r: ClusterResources): PolicyRow {
  const ref = refOf(p), pods = podsOf(p, r);
  const ap = ref.kind === 'AuthorizationPolicy' ? (p as AuthorizationPolicyObject) : undefined;
  const notes = [
    ...(ap && attachedToWaypoint(ap) ? [NOT_EVALUATED] : []),
    // An Istio policy needs a proxy beside the pod to enforce it.
    ...(ap && pods.some((pod) => pod.mesh === 'none') ? [NOT_ENFORCED] : []),
  ];
  return {
    namespace: ref.namespace,
    name: ref.name,
    kind: ref.kind,
    covers: [...new Set(pods.map(workloadText))].sort(compareText),
    notes,
    href: policyHref(cluster, ref),
  };
}

/** One cluster's part of the policy list: its rows, the policy kinds netatlas may not read, and what to say when it has no rows. */
export interface PolicyGroupRows {
  readonly cluster: string;
  readonly rows: PolicyRow[];
  readonly cannotRead: readonly string[];
  /** Said instead of the table when there are no rows; empty when the cannot-read lines say it all. */
  readonly empty: string;
}

const POLICY_KINDS = { NetworkPolicy: 'networkpolicies', AuthorizationPolicy: 'authorizationpolicies' } as const;

/**
 * The policy list, grouped by cluster in the registry's order. A query matches, ignoring case, part of a
 * policy's name or namespace, a workload it covers, or a `key=value` label of its selector. A kind netatlas
 * may not read is named, never shown as "no policies".
 */
export function policyRows(clusters: readonly ClusterSnapshot[], filter: { readonly cluster?: string; readonly query?: string }): PolicyGroupRows[] {
  const query = filter.query?.trim().toLowerCase() ?? '';
  return clusters
    .filter((c) => filter.cluster === undefined || c.name === filter.cluster)
    .map((c) => {
      const r = c.resources;
      if (!r) return { cluster: c.name, rows: [], cannotRead: [], empty: notReadYet(c.name) };
      const rows = policiesOf(r)
        .filter((p) => !query || [p.metadata.name, p.metadata.namespace, ...selectorLabels(p), ...podsOf(p, r).map((pod) => pod.workload.name)].some((t) => t.toLowerCase().includes(query)))
        .map((p) => rowOf(c.name, p, r))
        .sort((a, b) => compareText(a.namespace, b.namespace) || compareText(a.name, b.name) || compareText(a.kind, b.kind));
      const refused = installedPolicyKinds(r).filter((k) => forbidden(r, k));
      const readable = installedPolicyKinds(r).filter((k) => !forbidden(r, k));
      const empty = query ? 'No policy matches the search.' : !refused.length ? 'This cluster has no policies.' : readable.length ? `No ${joinNames(readable.map(kindName))} in this cluster.` : '';
      return { cluster: c.name, rows, cannotRead: refused.map(cannotReadLine), empty };
    });
}

/** What a policy's page says when the cluster does not hold the policy: not read yet, a kind netatlas may not read, or gone. */
export function missingPolicyText(cluster: string, r: ClusterResources | undefined, kind: PolicyRef['kind']): string {
  if (!r) return notReadYet(cluster);
  return forbidden(r, POLICY_KINDS[kind]) ? cannotReadLine(POLICY_KINDS[kind]) : 'This policy is no longer in the cluster.';
}

function chipsOf(sel: LabelSelector): string[] {
  const values = (vs: readonly string[] | undefined) => `(${(vs ?? []).join(', ')})`;
  return [
    ...Object.entries(sel.matchLabels ?? {}).map(([k, v]) => `${k} = ${v}`),
    ...(sel.matchExpressions ?? []).map((e) => {
      switch (e.operator) {
        case 'In':
          return `${e.key} in ${values(e.values)}`;
        case 'NotIn':
          return `${e.key} not in ${values(e.values)}`;
        case 'Exists':
          return `${e.key} exists`;
        case 'DoesNotExist':
          return `${e.key} does not exist`;
      }
    }),
  ];
}

/** The middle card of the editor: what the policy's selector says, the pods it matches now, and who else covers them. */
export function coverage(p: NetworkPolicyObject, r: ClusterResources): Coverage {
  const matched = podsOf(p, r);
  const inNamespace = r.pods.filter((pod) => pod.namespace === p.metadata.namespace);
  const workloads = [...new Set(inNamespace.map(workloadIdOf))];
  const parts: string[] = [], notCovered: string[] = [];
  for (const id of workloads.sort(compareText)) {
    const all = inNamespace.filter((pod) => workloadIdOf(pod) === id), mine = matched.filter((pod) => workloadIdOf(pod) === id);
    const first = all[0];
    if (!first) continue;
    if (!mine.length) notCovered.push(first.workload.name);
    else if (mine.length === all.length) parts.push(`All of ${workloadText(first)}.`);
    else parts.push(`Part of ${workloadText(first)} (${mine.length} of ${count(all.length, 'pod', 'pods')}).`);
  }
  const self = refOf(p);
  const others = policiesOf(r).filter((q) => {
    const ref = refOf(q);
    if (ref.kind === self.kind && ref.namespace === self.namespace && ref.name === self.name) return false;
    const theirs = new Set(podsOf(q, r));
    return matched.some((pod) => theirs.has(pod));
  });
  return {
    chips: chipsOf(p.spec.podSelector),
    pods: matched.map((pod) => pod.name).sort(compareText),
    matchLine: matched.length === 1 ? '1 pod matches now' : `${matched.length} pods match now`,
    workloadsLine: [...parts, ...(notCovered.length ? [`Not covered: ${notCovered.sort(compareText).join(', ')}.`] : [])].join(' '),
    alsoCoveredBy: uniqueRefs(others.map(refOf)),
  };
}
