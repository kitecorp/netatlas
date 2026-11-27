import { compareText, OUTSIDE, podClasses, refOf, uniqueRefs, type PodClass } from './classes';
import { ALL, EACH_DESTINATION, intersect, isEmpty, NONE, portsOfRule, union, type PortSet } from './ports';
import { matchesSelector } from './selectors';
import type { ClusterResources, IPBlock, NetworkPolicyObject, NetworkPolicySpec, Peer, PolicyRef, PolicyRule } from './types';

export interface NetpolEdge {
  readonly from: string;
  readonly to: string;
  readonly ports: PortSet;
  /** The address block of an edge from or to OUTSIDE, as text. */
  readonly peer?: string;
  readonly via: readonly PolicyRef[];
}

/** A rule with no peers: it lets in (or out) anything, in this cluster or outside it, so it is a mark, not an edge to every workload. */
export interface AnyPeerRule {
  readonly workload: string;
  readonly side: 'ingress' | 'egress';
  readonly ports: PortSet;
  readonly via: readonly PolicyRef[];
}

export interface NetpolResult {
  /** The policies that restrict each side of a workload. A workload with no entry is open both ways. */
  readonly covered: ReadonlyMap<string, { readonly ingress: readonly PolicyRef[]; readonly egress: readonly PolicyRef[] }>;
  readonly edges: readonly NetpolEdge[];
  readonly anyPeer: readonly AnyPeerRule[];
}

type Side = 'ingress' | 'egress';

const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => m.set(k, [...(m.get(k) ?? []), v]);

const cidrText = (b: IPBlock) => (b.except?.length ? `${b.cidr} except ${b.except.join(', ')}` : b.cidr);

/** Ordered pairs of classes, each once. */
class PairSet<T extends { readonly id: string }> implements Iterable<readonly [T, T]> {
  private readonly pairs = new Map<string, readonly [T, T]>();
  add(pair: readonly [T, T]) {
    this.pairs.set(JSON.stringify([pair[0].id, pair[1].id]), pair);
  }
  [Symbol.iterator]() {
    return this.pairs.values();
  }
}

/**
 * The sides a policy restricts. Kubernetes defaults an absent or empty policyTypes to Ingress, plus
 * Egress when the policy has at least one egress rule (networking/v1 SetDefaults_NetworkPolicy), so
 * `egress: []` alone restricts nothing out.
 */
export function policyTypesOf(spec: NetworkPolicySpec): readonly ('Ingress' | 'Egress')[] {
  if (spec.policyTypes?.length) return spec.policyTypes;
  return ['Ingress', ...(spec.egress?.length ? ['Egress' as const] : [])];
}

/** NetworkPolicy as Kubernetes defines it: a call is allowed when the caller may call out to the callee and the callee may be called by the caller. */
export function evaluateNetworkPolicies(r: ClusterResources): NetpolResult {
  const nsLabels = new Map(r.namespaces.map((n) => [n.name, n.labels]));
  const classes = podClasses(r.pods);
  const ingressOf = new Map<PodClass, NetworkPolicyObject[]>(), egressOf = new Map<PodClass, NetworkPolicyObject[]>();
  for (const p of r.networkPolicies) {
    const types = policyTypesOf(p.spec);
    for (const c of classes) {
      if (c.namespace !== p.metadata.namespace || !matchesSelector(p.spec.podSelector, c.labels)) continue;
      if (types.includes('Ingress')) push(ingressOf, c, p);
      if (types.includes('Egress')) push(egressOf, c, p);
    }
  }
  // A peer without namespaceSelector means the policy's own namespace; an ipBlock never selects a pod here.
  const selects = (peer: Peer, policyNs: string, c: PodClass) =>
    !peer.ipBlock &&
    (peer.namespaceSelector ? matchesSelector(peer.namespaceSelector, nsLabels.get(c.namespace) ?? {}) : c.namespace === policyNs) &&
    (peer.podSelector ? matchesSelector(peer.podSelector, c.labels) : true);
  const peersOf = (dir: Side, rule: PolicyRule) => (dir === 'ingress' ? rule.from : rule.to) ?? [];
  // Ports one side lets through between self and other; ALL when no policy restricts that side.
  const side = (of: Map<PodClass, NetworkPolicyObject[]>, dir: Side, self: PodClass, other: PodClass, dst: PodClass) => {
    const ps = of.get(self);
    if (!ps) return { ports: ALL, via: [] as PolicyRef[] };
    let ports = NONE;
    const via: PolicyRef[] = [];
    for (const p of ps) for (const rule of p.spec[dir] ?? []) {
      const peers = peersOf(dir, rule);
      // A rule with no peers, or an empty list of them, matches every peer.
      if (peers.length && !peers.some((x) => selects(x, p.metadata.namespace, other))) continue;
      ports = union(ports, portsOfRule(rule.ports, dst));
      via.push(refOf(p));
    }
    return { ports, via };
  };
  const edges: NetpolEdge[] = [], anyPeer: AnyPeerRule[] = [], pairs = new PairSet<PodClass>();
  // Candidate pairs come from the rules' peers, so the cost is rules x classes, not classes squared.
  for (const [dir, of] of [['ingress', ingressOf], ['egress', egressOf]] as const) for (const [self, ps] of of) for (const p of ps) for (const rule of p.spec[dir] ?? []) {
    const peers = peersOf(dir, rule);
    if (!peers.length) {
      // Calls out may go to any pod, so a named port stays a name; calls in resolve it on self.
      anyPeer.push({ workload: self.workloadId, side: dir, ports: portsOfRule(rule.ports, dir === 'ingress' ? self : EACH_DESTINATION), via: [refOf(p)] });
      continue;
    }
    for (const peer of peers) {
      if (peer.ipBlock) {
        // A port name resolves only on a pod, so a rule left with no port allows nothing and draws no edge.
        const ports = portsOfRule(rule.ports, dir === 'ingress' ? self : undefined);
        if (isEmpty(ports)) continue;
        const outside = { peer: cidrText(peer.ipBlock), via: [refOf(p)], ports };
        edges.push(dir === 'ingress' ? { from: OUTSIDE, to: self.workloadId, ...outside } : { from: self.workloadId, to: OUTSIDE, ...outside });
        continue;
      }
      for (const c of classes) if (selects(peer, p.metadata.namespace, c)) pairs.add(dir === 'ingress' ? [c, self] : [self, c]);
    }
  }
  for (const [a, b] of pairs) {
    if (a.workloadId === b.workloadId) continue;
    // Allowed only when a may call out to b and b may be called by a; named ports resolve against b.
    const out = side(egressOf, 'egress', a, b, b), inn = side(ingressOf, 'ingress', b, a, b);
    const ports = intersect(out.ports, inn.ports);
    if (!isEmpty(ports)) edges.push({ from: a.workloadId, to: b.workloadId, ports, via: [...out.via, ...inn.via] });
  }
  return { covered: coveredMap(ingressOf, egressOf), edges: mergeEdges(edges), anyPeer: mergeAnyPeer(anyPeer) };
}

function coveredMap(ingressOf: Map<PodClass, NetworkPolicyObject[]>, egressOf: Map<PodClass, NetworkPolicyObject[]>): NetpolResult['covered'] {
  const sides = new Map<string, { ingress: PolicyRef[]; egress: PolicyRef[] }>();
  for (const [dir, of] of [['ingress', ingressOf], ['egress', egressOf]] as const) for (const [c, ps] of of) {
    const entry = sides.get(c.workloadId) ?? { ingress: [], egress: [] };
    entry[dir].push(...ps.map(refOf));
    sides.set(c.workloadId, entry);
  }
  return new Map(
    [...sides]
      .sort(([a], [b]) => compareText(a, b))
      .map(([w, s]) => [w, { ingress: uniqueRefs(s.ingress), egress: uniqueRefs(s.egress) }] as const),
  );
}

/** Groups by `keyOf` (a list of strings, which also gives the order), joining ports by union and policies once each. */
function merge<T extends { readonly ports: PortSet; readonly via: readonly PolicyRef[] }>(items: readonly T[], keyOf: (t: T) => readonly string[]): T[] {
  const byKey = new Map<string, { key: readonly string[]; item: T }>();
  for (const t of items) {
    const key = keyOf(t), k = JSON.stringify(key), seen = byKey.get(k);
    byKey.set(k, { key, item: seen ? { ...seen.item, ports: union(seen.item.ports, t.ports), via: [...seen.item.via, ...t.via] } : t });
  }
  const order = (a: readonly string[], b: readonly string[]) => a.reduce((d, x, i) => d || compareText(x, b[i] ?? ''), 0);
  return [...byKey.values()].sort((a, b) => order(a.key, b.key)).map(({ item }) => ({ ...item, via: uniqueRefs(item.via) }));
}

/** One edge per (from, to, peer), sorted by from, to and peer. */
const mergeEdges = (edges: readonly NetpolEdge[]) => merge(edges, (e) => [e.from, e.to, e.peer ?? '']);

/** One mark per (workload, side), sorted by workload and side. */
const mergeAnyPeer = (marks: readonly AnyPeerRule[]) => merge(marks, (m) => [m.workload, m.side]);
