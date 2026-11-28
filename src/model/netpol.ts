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

/** What one side of a call lets through. `restrictedBy` empty: no policy restricts the side, so `ports` is ALL. */
export interface SideVerdict {
  readonly restrictedBy: readonly PolicyRef[];
  readonly ports: PortSet;
  readonly via: readonly PolicyRef[];
}

/** An egress rule's address block and the ports it opens to it; `block` null is a rule with no peers, which reaches any address. */
export interface AddressRule {
  readonly block: IPBlock | null;
  readonly ports: PortSet;
  readonly via: PolicyRef;
}

/** The NetworkPolicy evaluation of one cluster, asked one pair of classes at a time. */
export interface NetpolEvaluator {
  readonly classes: readonly PodClass[];
  /** What a's egress lets through to b; named ports resolve on b. */
  egress(a: PodClass, b: PodClass): SideVerdict;
  /** What b's ingress lets in from a; named ports resolve on b. */
  ingress(b: PodClass, a: PodClass): SideVerdict;
  /** The ports a may call b on: what both sides let through, whether or not the map draws an edge. */
  between(a: PodClass, b: PodClass): PortSet;
  /** The address rules of a's egress; 'any' when no policy restricts it. */
  addresses(a: PodClass): 'any' | readonly AddressRule[];
}

type Side = 'ingress' | 'egress';

const SIDES: readonly Side[] = ['ingress', 'egress'];

/** A class and the policies that restrict one of its sides. */
interface Restricted {
  readonly self: PodClass;
  readonly policies: readonly NetworkPolicyObject[];
}

/**
 * The policies that restrict each side of each class, and whether a peer selects a class. Classes are
 * found by id, and podClasses numbers a workload's classes in the order its pods come. So a class reads
 * the same whether it is one of the evaluator's own `classes` or comes from podClasses of the same
 * `r.pods`, in the same order; a class built from other pods, or the same pods reordered, may not.
 */
interface PolicyIndex {
  readonly classes: readonly PodClass[];
  readonly of: Readonly<Record<Side, ReadonlyMap<string, Restricted>>>;
  readonly selects: (peer: Peer, policyNs: string, c: PodClass) => boolean;
}

const OPEN: SideVerdict = { restrictedBy: [], ports: ALL, via: [] };

const add = (m: Map<string, Restricted>, self: PodClass, p: NetworkPolicyObject) => m.set(self.id, { self, policies: [...(m.get(self.id)?.policies ?? []), p] });

const peersOf = (dir: Side, rule: PolicyRule) => (dir === 'ingress' ? rule.from : rule.to) ?? [];

function indexPolicies(r: ClusterResources): PolicyIndex {
  const nsLabels = new Map(r.namespaces.map((n) => [n.name, n.labels]));
  const classes = podClasses(r.pods);
  const of = { ingress: new Map<string, Restricted>(), egress: new Map<string, Restricted>() };
  for (const p of r.networkPolicies) {
    const types = policyTypesOf(p.spec);
    for (const c of classes) {
      if (c.namespace !== p.metadata.namespace || !matchesSelector(p.spec.podSelector, c.labels)) continue;
      if (types.includes('Ingress')) add(of.ingress, c, p);
      if (types.includes('Egress')) add(of.egress, c, p);
    }
  }
  // A peer without namespaceSelector means the policy's own namespace; an ipBlock never selects a pod here.
  const selects = (peer: Peer, policyNs: string, c: PodClass) =>
    !peer.ipBlock &&
    (peer.namespaceSelector ? matchesSelector(peer.namespaceSelector, nsLabels.get(c.namespace) ?? {}) : c.namespace === policyNs) &&
    (peer.podSelector ? matchesSelector(peer.podSelector, c.labels) : true);
  return { classes, of, selects };
}

function evaluatorOf({ classes, of, selects }: PolicyIndex): NetpolEvaluator {
  // What one side lets through between self and other, with named ports resolved on dst.
  const side = (dir: Side, self: PodClass, other: PodClass, dst: PodClass): SideVerdict => {
    const ps = of[dir].get(self.id)?.policies;
    if (!ps) return OPEN;
    let ports = NONE;
    const via: PolicyRef[] = [];
    for (const p of ps) for (const rule of p.spec[dir] ?? []) {
      const peers = peersOf(dir, rule);
      // A rule with no peers, or an empty list of them, matches every peer.
      if (peers.length && !peers.some((x) => selects(x, p.metadata.namespace, other))) continue;
      ports = union(ports, portsOfRule(rule.ports, dst));
      via.push(refOf(p));
    }
    return { restrictedBy: uniqueRefs(ps.map(refOf)), ports, via: uniqueRefs(via) };
  };
  const egress = (a: PodClass, b: PodClass) => side('egress', a, b, b);
  const ingress = (b: PodClass, a: PodClass) => side('ingress', b, a, b);
  // An address has no container ports to resolve a name on, so a rule left with no port admits no
  // address and is not listed.
  const addresses = (a: PodClass): 'any' | AddressRule[] => {
    const ps = of.egress.get(a.id)?.policies;
    if (!ps) return 'any';
    return ps.flatMap((p) =>
      (p.spec.egress ?? []).flatMap((rule): AddressRule[] => {
        const ports = portsOfRule(rule.ports, undefined), via = refOf(p), peers = peersOf('egress', rule);
        if (isEmpty(ports)) return [];
        if (!peers.length) return [{ block: null, ports, via }];
        return peers.flatMap((peer) => (peer.ipBlock ? [{ block: peer.ipBlock, ports, via }] : []));
      }),
    );
  };
  return { classes, egress, ingress, between: (a, b) => intersect(egress(a, b).ports, ingress(b, a).ports), addresses };
}

export function netpolEvaluator(r: ClusterResources): NetpolEvaluator {
  return evaluatorOf(indexPolicies(r));
}

/** `203.0.113.0/24 except 203.0.113.128/25`: an address block as the map and the Outbound view name it. */
export const cidrText = (b: IPBlock): string => (b.except?.length ? `${b.cidr} except ${b.except.join(', ')}` : b.cidr);

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
  const index = indexPolicies(r), { classes, of, selects } = index, e = evaluatorOf(index);
  const edges: NetpolEdge[] = [], anyPeer: AnyPeerRule[] = [], pairs = new PairSet<PodClass>();
  // Candidate pairs come from the rules' peers, so the cost is rules x classes, not classes squared.
  for (const dir of SIDES) for (const { self, policies } of of[dir].values()) for (const p of policies) for (const rule of p.spec[dir] ?? []) {
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
    const out = e.egress(a, b), inn = e.ingress(b, a);
    const ports = intersect(out.ports, inn.ports);
    if (!isEmpty(ports)) edges.push({ from: a.workloadId, to: b.workloadId, ports, via: [...out.via, ...inn.via] });
  }
  return { covered: coveredMap(of), edges: mergeEdges(edges), anyPeer: mergeAnyPeer(anyPeer) };
}

function coveredMap(of: PolicyIndex['of']): NetpolResult['covered'] {
  const sides = new Map<string, { ingress: PolicyRef[]; egress: PolicyRef[] }>();
  for (const dir of SIDES) for (const { self, policies } of of[dir].values()) {
    const entry = sides.get(self.workloadId) ?? { ingress: [], egress: [] };
    entry[dir].push(...policies.map(refOf));
    sides.set(self.workloadId, entry);
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
