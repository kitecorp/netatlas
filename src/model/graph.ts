import { compareText, OUTSIDE, uniqueRefs, workloadIdOf } from './classes';
import { cannotReadLine, forbidden, joinNames } from './format';
import { evaluateAuthorizationPolicies } from './istio';
import { evaluateNetworkPolicies } from './netpol';
import { formatPorts } from './ports';
import type { ClusterResources, PolicyRef, WatchedKind } from './types';

export interface WorkloadNode {
  readonly id: string;
  readonly namespace: string;
  readonly kind: string;
  readonly name: string;
  readonly pods: number;
  readonly policies: readonly PolicyRef[];
  readonly restrictedBy: { readonly ingress: readonly PolicyRef[]; readonly egress: readonly PolicyRef[] };
  readonly ingressOpen: boolean;
  readonly egressOpen: boolean;
  readonly noPolicy: boolean;
  readonly istioNotEnforced: boolean;
  /** The AuthorizationPolicies that apply to it and that its sidecar enforces. */
  readonly istioEnforced: readonly PolicyRef[];
  readonly anyPeer: readonly { readonly side: 'ingress' | 'egress'; readonly ports: string }[];
}

export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: 'networkpolicy' | 'istio';
  readonly label: string;
  readonly via: readonly PolicyRef[];
  readonly peer?: string;
  readonly depends?: 'depends on the request';
  readonly plainText?: 'accepted unless mutual TLS is STRICT';
}

export interface ClusterGraph {
  readonly namespaces: readonly { readonly name: string; readonly workloads: readonly WorkloadNode[] }[];
  readonly notEvaluated: readonly PolicyRef[];
  readonly edges: readonly GraphEdge[];
  /**
   * The kinds the map needs that the API server refused to list: without the policies nothing is said
   * about what they would allow, without the namespaces' labels a namespaceSelector selects nothing,
   * and without the pods there is no workload to draw.
   */
  readonly unreadable: readonly WatchedKind[];
}

export interface DetailLine {
  readonly peer: string;
  readonly label: string;
  readonly kind: 'networkpolicy' | 'istio';
  readonly note?: string;
}

export interface WorkloadDetail {
  readonly selectedBy: readonly PolicyRef[];
  readonly mayCallIt: readonly DetailLine[];
  readonly itMayCall: readonly DetailLine[];
  readonly summary: string;
}

const NO_SIDES = { ingress: [], egress: [] } as const;
const ANYTHING = 'Anything, in this cluster or outside it';
const HIDDEN = 'hidden on the map';

const sameRefs = (a: readonly PolicyRef[], b: readonly PolicyRef[]) => a.length === b.length && a.every((r, i) => JSON.stringify(r) === JSON.stringify(b[i]));

const byOrder = <T>(...keys: ((t: T) => string)[]) => (a: T, b: T) => keys.reduce((d, k) => d || compareText(k(a), k(b)), 0);

/**
 * The graph is worked out once per resources object: the reader hands over a new object on every
 * change and the same one otherwise, so the overview, the map and the policy list share one evaluation.
 */
const graphs = new WeakMap<ClusterResources, ClusterGraph>();

/** The map of one cluster: its workloads by namespace, what restricts each one, and the edges both kinds of policy allow. */
export function clusterGraph(r: ClusterResources): ClusterGraph {
  const cached = graphs.get(r);
  if (cached) return cached;
  const netpol = evaluateNetworkPolicies(r), istio = evaluateAuthorizationPolicies(r);
  const unreadable = (['namespaces', 'pods', 'networkpolicies', 'authorizationpolicies'] as const).filter((k) => forbidden(r, k));
  // A side or a workload is open only when netatlas could read every policy that might restrict it.
  const npRead = !forbidden(r, 'networkpolicies'), allRead = npRead && !forbidden(r, 'authorizationpolicies');
  const pods = new Map<string, { namespace: string; kind: string; name: string; pods: number }>();
  for (const p of r.pods) {
    const id = workloadIdOf(p), seen = pods.get(id);
    pods.set(id, { namespace: p.namespace, kind: p.workload.kind, name: p.workload.name, pods: (seen?.pods ?? 0) + 1 });
  }
  const nodes: WorkloadNode[] = [...pods].map(([id, w]) => {
    const restrictedBy = netpol.covered.get(id) ?? NO_SIDES;
    const applied = istio.applied.get(id) ?? [], notEnforced = istio.notEnforced.get(id) ?? [];
    const enforced = applied.filter((a) => !notEnforced.some((n) => n.kind === a.kind && n.namespace === a.namespace && n.name === a.name));
    return {
      id,
      ...w,
      policies: uniqueRefs([...restrictedBy.ingress, ...restrictedBy.egress, ...applied]),
      restrictedBy,
      ingressOpen: npRead && !restrictedBy.ingress.length,
      egressOpen: npRead && !restrictedBy.egress.length,
      noPolicy: allRead && !restrictedBy.ingress.length && !restrictedBy.egress.length && !enforced.length,
      istioNotEnforced: notEnforced.length > 0,
      istioEnforced: enforced,
      anyPeer: netpol.anyPeer.filter((m) => m.workload === id).map((m) => ({ side: m.side, ports: formatPorts(m.ports) })),
    };
  });
  const namespaces = [...new Set(nodes.map((n) => n.namespace))].sort(compareText).map((name) => ({
    name,
    workloads: nodes.filter((n) => n.namespace === name).sort(byOrder((n) => n.id)),
  }));
  const edges: GraphEdge[] = [
    ...netpol.edges.map((e): GraphEdge => ({ from: e.from, to: e.to, kind: 'networkpolicy', label: formatPorts(e.ports), via: e.via, ...(e.peer === undefined ? {} : { peer: e.peer }) })),
    ...istio.edges.map(({ from, to, label, via, ...marks }): GraphEdge => ({ from, to, kind: 'istio', label, via, ...marks })),
  ].sort(byOrder((e) => e.from, (e) => e.to, (e) => e.kind, (e) => e.label, (e) => e.peer ?? ''));
  const graph = { namespaces, notEvaluated: istio.notEvaluated, edges, unreadable };
  graphs.set(r, graph);
  return graph;
}

/** The namespaces the map hides until someone shows them: `kube-*` and the Istio root namespace. */
export function defaultHidden(r: ClusterResources): ReadonlySet<string> {
  const names = [...r.namespaces.map((n) => n.name), ...r.pods.map((p) => p.namespace)];
  return new Set([...names.filter((n) => n.startsWith('kube-')), r.istioSettings.rootNamespace]);
}

const covers = (names: readonly string[], side: string) => `${joinNames(names)} ${names.length > 1 ? 'cover' : 'covers'} ${side}`;

/** What the NetworkPolicies do to the workload; they speak about the network only. */
function networkSentence(node: WorkloadNode, g: ClusterGraph): string {
  // Without the NetworkPolicies nothing can be said about either side, least of all that none selects it.
  if (g.unreadable.includes('networkpolicies')) return cannotReadLine('networkpolicies');
  const { ingress, egress } = node.restrictedBy;
  const inNames = ingress.map((r) => r.name), outNames = egress.map((r) => r.name);
  if (inNames.length && outNames.length) {
    return sameRefs(ingress, egress)
      ? `Everything else is blocked in both directions, because ${covers(inNames, 'ingress and egress')}.`
      : `Everything else is blocked in both directions: ${covers(inNames, 'ingress')} and ${covers(outNames, 'egress')}.`;
  }
  if (inNames.length) return `Everything else is blocked from calling it, because ${covers(inNames, 'ingress')}. It may call anything.`;
  if (outNames.length) return `It may call nothing else, because ${covers(outNames, 'egress')}. Anything may call it.`;
  return 'No NetworkPolicy selects it, so the network lets everything reach it and it may call anything.';
}

function summary(node: WorkloadNode, g: ClusterGraph): string {
  // An AuthorizationPolicy on a workload outside the mesh decides nothing, so only enforced ones are named.
  const istio = node.istioEnforced.map((r) => r.name).sort(compareText);
  const network = networkSentence(node, g);
  return istio.length ? `${network} Istio also decides which requests reach it: ${istio.join(', ')}.` : network;
}

/** What the side panel shows for one workload; undefined when the graph has no such workload. */
export function workloadDetail(g: ClusterGraph, id: string, hidden: ReadonlySet<string>): WorkloadDetail | undefined {
  const all = g.namespaces.flatMap((n) => n.workloads);
  const node = all.find((w) => w.id === id);
  if (!node) return undefined;
  const byId = new Map(all.map((w) => [w.id, w]));
  const isHidden = (peerId: string) => hidden.has(byId.get(peerId)?.namespace ?? '');
  const lineFor = (e: GraphEdge, peerId: string, outward: boolean): DetailLine => {
    const peer = byId.get(peerId);
    const notes = [
      ...(e.peer === undefined ? [] : [e.peer]),
      // A call out passes an Istio policy of the workload it calls, not one of this workload.
      ...(outward && e.kind === 'istio' ? [`its policy ${joinNames(e.via.map((v) => v.name))}`] : []),
      ...(e.depends ? [e.depends] : []),
      ...(e.plainText ? [e.plainText] : []),
      ...(isHidden(peerId) ? [HIDDEN] : []),
    ];
    const text = peerId === OUTSIDE ? 'Internet' : peer ? `${peer.namespace} / ${peer.name}` : peerId;
    return { peer: text, label: e.label, kind: e.kind, ...(notes.length ? { note: notes.join('; ') } : {}) };
  };
  // Visible peers first, then by peer; for one peer, what the NetworkPolicies allow before what Istio allows.
  const lines = (outward: boolean, side: 'ingress' | 'egress') => [
    ...g.edges
      .filter((e) => (outward ? e.from : e.to) === id)
      .map((e) => ({ e, peerId: outward ? e.to : e.from }))
      .sort(byOrder((x) => (isHidden(x.peerId) ? '1' : '0'), (x) => x.peerId, (x) => (x.e.kind === 'networkpolicy' ? '0' : '1'), (x) => x.e.label))
      .map(({ e, peerId }) => lineFor(e, peerId, outward)),
    ...node.anyPeer.filter((m) => m.side === side).map((m): DetailLine => ({ peer: ANYTHING, label: m.ports, kind: 'networkpolicy' })),
  ];
  return { selectedBy: node.policies, mayCallIt: lines(false, 'ingress'), itMayCall: lines(true, 'egress'), summary: summary(node, g) };
}
