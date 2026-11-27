import { OUTSIDE, uniqueRefs } from './classes';
import { count } from './format';
import type { ClusterGraph, GraphEdge, WorkloadNode } from './graph';

export interface FlowNode {
  readonly id: string;
  readonly type: 'workload' | 'namespace' | 'outside';
  readonly parent?: string;
  readonly label: string;
  readonly sub: string;
  readonly tone: 'normal' | 'open';
  readonly marks?: readonly string[];
}

export interface FlowEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly kind: 'networkpolicy' | 'istio';
  readonly label: string;
  readonly ariaLabel: string;
}

export interface Flow {
  readonly nodes: readonly FlowNode[];
  readonly edges: readonly FlowEdge[];
  readonly counts: { readonly workloads: number; readonly policies: number; readonly noPolicy: number };
}

export interface FlowOptions {
  readonly hidden: ReadonlySet<string>;
  readonly show: { readonly networkpolicy: boolean; readonly istio: boolean };
}

/** The id of a namespace's box on the map; workload ids hold slashes, so the two never meet. */
export const namespaceNodeId = (name: string): string => `namespace:${name}`;

const KIND_TEXT = { networkpolicy: 'a NetworkPolicy', istio: 'an Istio AuthorizationPolicy' } as const;

/** What a workload's box says under its name; a policy kind netatlas may not read is never "no policy". */
function subOf(w: WorkloadNode): string {
  const pods = count(w.pods, 'pod', 'pods');
  if (w.policies.length) return `${pods} · ${count(w.policies.length, 'policy', 'policies')}`;
  return `${pods} · ${w.noPolicy ? 'no policy' : 'cannot read its policies'}`;
}

/**
 * A rule with no peers allows anything on its ports; the map marks it on the workload instead of
 * drawing an edge to everything. A side no policy restricts allows anything on every port, so it gets
 * the same mark without ports. A workload no policy selects says so in its tone, so it gets none.
 * The ingress mark speaks about the network: where an enforced Istio policy also decides which
 * requests get in, it says so, since the Istio edges beside it admit fewer callers.
 */
function marksOf(w: WorkloadNode): string[] {
  if (w.noPolicy) return [];
  const caller = w.istioEnforced.length ? 'any caller on the network' : 'any caller';
  const peerless = (side: 'ingress' | 'egress', text: string) => w.anyPeer.filter((m) => m.side === side).map((m) => `${text} on ${m.ports}`);
  return [...(w.ingressOpen ? [caller] : peerless('ingress', caller)), ...(w.egressOpen ? ['may call anything'] : peerless('egress', 'may call anything'))];
}

/**
 * The map of one cluster as React Flow draws it: each shown namespace as a box before its workloads
 * (React Flow needs a parent before its children), then the Internet as one node with a stable id
 * when an edge reaches it, and the edges of the kinds shown between shown nodes, in the graph's order.
 */
export function toFlow(g: ClusterGraph, o: FlowOptions): Flow {
  const shown = g.namespaces.filter((n) => !o.hidden.has(n.name) && n.workloads.length);
  const workloads = shown.flatMap((n) => n.workloads);
  const byId = new Map(workloads.map((w) => [w.id, w]));
  const nameOf = (id: string) => (id === OUTSIDE ? 'Internet' : (byId.get(id)?.name ?? id));
  const visible = (id: string) => id === OUTSIDE || byId.has(id);
  const drawn = g.edges.filter((e) => o.show[e.kind] && visible(e.from) && visible(e.to));
  const ariaLabel = (e: GraphEdge) =>
    [`From ${nameOf(e.from)} to ${nameOf(e.to)}`, e.label, `allowed by ${KIND_TEXT[e.kind]}`, ...(e.depends ? [e.depends] : []), ...(e.plainText ? [e.plainText] : [])].join(', ');
  const nodes: FlowNode[] = shown.flatMap((n) => [
    { id: namespaceNodeId(n.name), type: 'namespace' as const, label: `namespace ${n.name}`, sub: '', tone: 'normal' as const },
    ...n.workloads.map((w): FlowNode => {
      const marks = marksOf(w);
      return { id: w.id, type: 'workload', parent: namespaceNodeId(n.name), label: w.name, sub: subOf(w), tone: w.noPolicy ? 'open' : 'normal', ...(marks.length ? { marks } : {}) };
    }),
  ]);
  if (drawn.some((e) => e.from === OUTSIDE || e.to === OUTSIDE)) nodes.push({ id: OUTSIDE, type: 'outside', label: 'Internet', sub: 'outside the cluster', tone: 'normal' });
  const shownNamespaces = new Set(shown.map((n) => n.name));
  return {
    nodes,
    edges: drawn.map((e, i) => ({ id: `edge-${i}`, source: e.from, target: e.to, kind: e.kind, label: e.label, ariaLabel: ariaLabel(e) })),
    counts: {
      workloads: workloads.length,
      // Waypoint policies select no workload, so they are counted by their namespace.
      policies: uniqueRefs([...workloads.flatMap((w) => w.policies), ...g.notEvaluated.filter((r) => shownNamespaces.has(r.namespace))]).length,
      noPolicy: workloads.filter((w) => w.noPolicy).length,
    },
  };
}

export interface MapState extends FlowOptions {
  readonly selected?: string;
  readonly query: string;
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const list = (v: string) => new Set(v.split(',').map((s) => s.trim()).filter(Boolean));

/**
 * The map's state from its URL. `ns` lists the namespaces shown (by default every one but
 * `defaultHidden`), `show` the kinds of policy drawn (by default both), `w` the workload the side
 * panel shows, and `q` the search. A parameter given twice counts once, by its first value.
 */
export function mapState(params: Readonly<Record<string, string | string[] | undefined>>, namespaces: readonly string[], defaultHidden: ReadonlySet<string>): MapState {
  const ns = first(params.ns), show = first(params.show), w = first(params.w);
  const shown = ns === undefined ? undefined : list(ns);
  const kinds = show === undefined ? undefined : list(show);
  return {
    hidden: new Set(namespaces.filter((n) => (shown ? !shown.has(n) : defaultHidden.has(n)))),
    show: { networkpolicy: kinds?.has('networkpolicy') ?? true, istio: kinds?.has('istio') ?? true },
    ...(w ? { selected: w } : {}),
    query: first(params.q)?.trim() ?? '',
  };
}
