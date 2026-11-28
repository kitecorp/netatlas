import { count } from './format';
import type { FlowEdge, FlowNode } from './flow';
import type { ClusterGraph, WorkloadNode } from './graph';
import { allowedText, figureLabel, figureWords, type TrafficEdge, type TrafficMark, type TrafficModel } from './traffic';

/** What `trafficEdges` needs from the page: the mode, the ids of the nodes drawn, and the name of each. */
export interface TrafficEdgeOptions {
  readonly compare: boolean;
  readonly visible: ReadonlySet<string>;
  readonly names: ReadonlyMap<string, string>;
}

/** What a workload's box says on the traffic view: whether its traffic is measured from both sides, and whether no policy selects it. */
function meshSub(w: WorkloadNode): string {
  const pods = count(w.pods, 'pod', 'pods');
  if (w.mesh === 'none') return w.noPolicy ? `${pods} · not in the mesh · no policy` : `${pods} · not in the mesh`;
  return w.noPolicy ? `${pods} · no policy` : `${pods} · in the mesh`;
}

/**
 * The policy map's nodes as the traffic view draws them, at the same places: each workload says
 * whether it is in the mesh, and loses the marks of what its policies leave open, which speak about
 * the policies, not the traffic.
 */
export function trafficNodes<N extends FlowNode>(nodes: readonly N[], g: ClusterGraph): N[] {
  const workloads = new Map(g.namespaces.flatMap((n) => n.workloads).map((w) => [w.id, w]));
  return nodes.map((n) => {
    const w = n.type === 'workload' ? workloads.get(n.id) : undefined;
    return w ? { ...n, sub: meshSub(w), marks: undefined } : n;
  });
}

/** The model's nodes that are not workloads of the graph, drawn as the Internet node is. */
export function extraFlowNodes(m: TrafficModel): FlowNode[] {
  return m.extraNodes.map((n) => ({ id: n.id, type: 'outside', label: n.label, sub: n.sub, tone: 'normal' }));
}

/** The marks of a call the policies let in, whose spoken label says first what lets it in (`allowedText`). */
const LET_IN: ReadonlySet<TrafficMark> = new Set(['allowed', 'unused', 'quiet', 'not-measured']);

/** What each mark adds to an edge's spoken label, after what lets the call in; an edge the policies were not compared with adds nothing. */
const MARK_WORDS: Readonly<Record<TrafficMark, string | undefined>> = {
  allowed: undefined,
  uncovered: 'covered by no policy',
  unused: 'no calls recorded in the last 24 hours',
  quiet: 'no calls in the last 5 minutes',
  'not-measured': 'traffic not measured',
  'refused-istio': 'refused by Istio',
  'refused-network': 'refused by the network',
  'answered-denied': 'answered though the policies now deny it',
  outbound: 'leaves the cluster: see the Outbound view',
  'not-evaluated': undefined,
};

/** The legend of Compare with policies, one line per way an edge is drawn; a quiet edge is drawn as an unused one, and an edge not measured in the grey of one not compared. */
export const TRAFFIC_LEGEND: readonly { readonly mark: TrafficMark; readonly text: string }[] = [
  { mark: 'allowed', text: 'traffic seen, and a policy allows it' },
  { mark: 'uncovered', text: 'traffic seen, no policy covers it' },
  { mark: 'unused', text: 'allowed by a policy, no traffic seen' },
  { mark: 'refused-istio', text: 'refused by Istio' },
  { mark: 'refused-network', text: 'refused by the network' },
  { mark: 'answered-denied', text: 'answered though the policies now deny it' },
  { mark: 'outbound', text: 'leaves the cluster' },
  // The grey of the edges not compared with the policies, which the edges not measured share.
  { mark: 'not-evaluated', text: 'not compared with the policies, or not measured' },
];

/** What an idle edge's label says in place of figures: how long nothing was seen, or that nothing was measured. */
const IDLE_LABELS: Partial<Readonly<Record<TrafficMark, string>>> = { unused: 'no traffic, 24 h', quiet: 'no traffic, 5 min', 'not-measured': 'not measured' };

const labelOf = (e: TrafficEdge): string => (e.figures ? figureLabel(e.figures) : (IDLE_LABELS[e.mark] ?? ''));

/**
 * The model's edges as React Flow draws them, between the nodes drawn: an edge with either end hidden
 * is left out, as the policy map leaves out its edges. Without the comparison an edge carries no mark
 * and says only what was measured, so the idle edges, which have nothing measured, are left out too.
 */
export function trafficEdges(m: TrafficModel, { compare, visible, names }: TrafficEdgeOptions): FlowEdge[] {
  const name = (id: string) => names.get(id) ?? id;
  return m.edges
    .filter((e) => visible.has(e.from) && visible.has(e.to) && (compare || e.figures))
    .map((e, i): FlowEdge => {
      const words = compare ? [...(LET_IN.has(e.mark) ? [allowedText('a policy', e, name(e.to))] : []), MARK_WORDS[e.mark]] : [];
      const ariaLabel = [`From ${name(e.from)} to ${name(e.to)}`, ...(e.figures ? [figureWords(e.figures)] : []), ...words, ...e.notes].filter(Boolean).join(', ');
      return { id: `traffic-${i}`, source: e.from, target: e.to, kind: 'traffic', label: labelOf(e), ariaLabel, ...(compare ? { mark: e.mark } : {}) };
    });
}
