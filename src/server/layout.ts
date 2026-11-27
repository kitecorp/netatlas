import ELK, { type ElkNode } from 'elkjs/lib/elk.bundled.js';
import type { Flow, FlowNode } from '@/model/flow';

export type PositionedNode = FlowNode & { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

export interface PositionedFlow extends Omit<Flow, 'nodes'> {
  readonly nodes: readonly PositionedNode[];
  readonly width: number;
  readonly height: number;
}

/** Every workload and the Internet get the prototype's box. */
export const NODE_WIDTH = 176;
export const NODE_HEIGHT = 64;

const elk = new ELK();

/** ELK reads spacing from the box that holds the nodes, so the map and each namespace box carry it. */
const SPACING = {
  'elk.spacing.nodeNode': '32',
  // Room between layers for an edge's label, such as `TCP 8080` or `POST /pay`.
  'elk.layered.spacing.nodeNodeBetweenLayers': '120',
};

const ROOT_OPTIONS = {
  ...SPACING,
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  // Edges cross namespace boxes, so the layers are worked out across the whole map at once.
  'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
  'elk.padding': '[top=24,left=24,bottom=24,right=24]',
};

/** Room above a namespace box's workloads for its `namespace <name>` label. */
const NAMESPACE_OPTIONS = { ...SPACING, 'elk.padding': '[top=44,left=16,bottom=16,right=16]' };

/** The last layouts, by their flow: a map renders again on every probe, and the same flow gives the same layout. */
const laidOut = new Map<string, Promise<PositionedFlow>>();
const KEPT_LAYOUTS = 32;

/**
 * Positions toFlow's nodes with elkjs's layered layout, calls running left to right and each namespace
 * a box around its workloads. A child's x and y are relative to its namespace box, as React Flow reads
 * them; the order of the nodes is toFlow's, so a parent still comes before its children.
 */
export function layoutFlow(f: Flow): Promise<PositionedFlow> {
  const key = JSON.stringify(f);
  const kept = laidOut.get(key);
  if (kept) return kept;
  const layout = place(f);
  laidOut.set(key, layout);
  // A failed layout is not kept, and the oldest goes once the cache is full.
  layout.catch(() => laidOut.delete(key));
  if (laidOut.size > KEPT_LAYOUTS) laidOut.delete(laidOut.keys().next().value ?? '');
  return layout;
}

async function place(f: Flow): Promise<PositionedFlow> {
  const box = (n: FlowNode): ElkNode => ({ id: n.id, width: NODE_WIDTH, height: NODE_HEIGHT });
  const roots = f.nodes.filter((n) => n.parent === undefined);
  const graph: ElkNode = {
    id: 'map',
    layoutOptions: ROOT_OPTIONS,
    children: roots.map((r) => (r.type === 'namespace' ? { id: r.id, layoutOptions: NAMESPACE_OPTIONS, children: f.nodes.filter((n) => n.parent === r.id).map(box) } : box(r))),
    edges: f.edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  };
  const laid = await elk.layout(graph);
  const placed = new Map<string, ElkNode>();
  for (const r of laid.children ?? []) {
    placed.set(r.id, r);
    for (const c of r.children ?? []) placed.set(c.id, c);
  }
  return {
    ...f,
    nodes: f.nodes.map((n) => {
      const p = placed.get(n.id);
      return { ...n, x: p?.x ?? 0, y: p?.y ?? 0, width: p?.width ?? NODE_WIDTH, height: p?.height ?? NODE_HEIGHT };
    }),
    width: laid.width ?? 0,
    height: laid.height ?? 0,
  };
}
