import ELK, { type ElkNode } from 'elkjs/lib/elk.bundled.js';
import type { Flow, FlowNode } from '@/model/flow';
import { NAMESPACE_TITLE, textWidth } from '@/model/map-text';

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
  // Boxes of one layer sit side by side; ELK keeps them this far apart whatever their width.
  'elk.spacing.nodeNode': '32',
  // Room between layers for an edge's label, such as `TCP 8080` or `POST /pay`, on a line running down.
  // A label takes 24 px of height with its margin, and the label spots nearest the boxes (a fifth of the
  // way along the curve, components/map/edge-labels.ts) lie a quarter of the gap from each end, so 80
  // keeps a label at any spot about 8 px clear of both boxes.
  'elk.layered.spacing.nodeNodeBetweenLayers': '80',
};

const ROOT_OPTIONS = {
  ...SPACING,
  'elk.algorithm': 'layered',
  'elk.direction': 'DOWN',
  // Edges cross namespace boxes, so the layers are worked out across the whole map at once.
  'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
  'elk.padding': '[top=24,left=24,bottom=24,right=24]',
};

/** Room above a namespace box's workloads for its `namespace <name>` label. */
const NAMESPACE_OPTIONS = { ...SPACING, 'elk.padding': '[top=44,left=16,bottom=16,right=16]' };

/**
 * A namespace box's options: at least as wide as its title with the same room each side, so a long name
 * (`namespace local-path-storage`) stays on one line rather than wrapping onto the workload under it.
 * The minimum is written as (height, width): with the direction DOWN and INCLUDE_CHILDREN, elkjs 0.12.1
 * lays the map out turned a quarter and reads a namespace box's minimum size in that frame (measured:
 * `(300,0)` gave a box 208 wide and 300 tall, while the direction RIGHT, or SEPARATE_CHILDREN, gave 300
 * wide). Journey 06's row "every namespace title is on one line" fails if a later elkjs reads it as (width, height).
 */
const namespaceOptions = (n: FlowNode) => ({
  ...NAMESPACE_OPTIONS,
  'elk.nodeSize.constraints': 'MINIMUM_SIZE',
  'elk.nodeSize.minimum': `(0,${Math.ceil(textWidth(n.label) + 2 * NAMESPACE_TITLE.left)})`,
});

/** The last layouts, by their flow: a map renders again on every probe, and the same flow gives the same layout. */
const laidOut = new Map<string, Promise<PositionedFlow>>();
const KEPT_LAYOUTS = 32;

/**
 * Positions toFlow's nodes with elkjs's layered layout, calls running top to bottom (a caller above what
 * it calls, so a long chain of callers grows down the page, which scrolls, rather than across a box the
 * map is shrunk to fit) and each namespace a box around its workloads. A child's x and y are relative to
 * its namespace box, as React Flow reads them; the order of the nodes is toFlow's, so a parent still
 * comes before its children.
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

/** The room between the laid-out flow and the column of extra nodes, and between two boxes of that column. */
const EXTRA_GAP_X = 48;
const EXTRA_GAP_Y = 24;

/**
 * Adds the nodes the traffic view draws that the policy map has none of (callers outside the mesh,
 * workloads not running now) as a column right of the laid-out flow. They are placed beside it, not
 * laid out with it, so the flow keeps the map's positions and `layoutFlow`'s cache serves both pages.
 */
export function withExtraNodes(p: PositionedFlow, extras: FlowNode[]): PositionedFlow {
  if (!extras.length) return p;
  const x = p.width + EXTRA_GAP_X;
  const placed = extras.map((n, i): PositionedNode => ({ ...n, x, y: i * (NODE_HEIGHT + EXTRA_GAP_Y), width: NODE_WIDTH, height: NODE_HEIGHT }));
  const bottom = Math.max(...placed.map((n) => n.y + n.height));
  return { ...p, nodes: [...p.nodes, ...placed], width: x + NODE_WIDTH, height: Math.max(p.height, bottom) };
}

async function place(f: Flow): Promise<PositionedFlow> {
  const box = (n: FlowNode): ElkNode => ({ id: n.id, width: NODE_WIDTH, height: NODE_HEIGHT });
  const roots = f.nodes.filter((n) => n.parent === undefined);
  const graph: ElkNode = {
    id: 'map',
    layoutOptions: ROOT_OPTIONS,
    children: roots.map((r) => (r.type === 'namespace' ? { id: r.id, layoutOptions: namespaceOptions(r), children: f.nodes.filter((n) => n.parent === r.id).map(box) } : box(r))),
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
