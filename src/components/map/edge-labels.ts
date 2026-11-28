import { labelSpots, type Point, type Rect } from '@/model/label-spots';
import { namespaceTitleBox, textWidth } from '@/model/map-text';
import type { PositionedFlow } from '@/server/layout';
import { HANDLE_OFFSET } from './WorkloadNode';

/** A cubic Bézier from a caller's bottom edge to a callee's top edge, as React Flow's default edge draws one. */
export interface Curve {
  readonly from: Point;
  readonly c1: Point;
  readonly c2: Point;
  readonly to: Point;
}

/**
 * The curve of an edge from a bottom handle to a top handle, with the control points of React Flow's
 * `getBezierPath` at its default curvature (0.25): half the height between the ends below the caller
 * and above the callee, or a loop sized by the square root of that height when the callee is above the
 * caller. Every edge draws its path with it (`MapEdge`), so the spots the labels are placed at lie on
 * the line drawn.
 */
export function edgeCurve(from: Point, to: Point): Curve {
  const gap = to.y - from.y;
  const reach = gap >= 0 ? gap / 2 : 0.25 * 25 * Math.sqrt(-gap);
  return { from, c1: { x: from.x, y: from.y + reach }, c2: { x: to.x, y: to.y - reach }, to };
}

/** The point at `t` of the way along the curve, from 0 at the caller to 1 at the callee. */
export function pointOn({ from, c1, c2, to }: Curve, t: number): Point {
  const u = 1 - t;
  const at = (a: number, b: number, c: number, d: number) => u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
  return { x: at(from.x, c1.x, c2.x, to.x), y: at(from.y, c1.y, c2.y, to.y) };
}

/** The curve as an SVG path. */
export const curvePath = ({ from, c1, c2, to }: Curve): string => `M${from.x},${from.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${to.x},${to.y}`;

/** Where along its edge a label may go, in the order tried: the middle, then further out each side. */
const SPOTS = [0.5, 0.35, 0.65, 0.2, 0.8] as const;

/**
 * The room a label takes: its text inside React Flow's background of 4 px each side and 2 px above and
 * below, with 4 px more each side so two labels never meet.
 */
const labelSize = (text: string) => ({ width: textWidth(text) + 16, height: 24 });

/** A namespace box's title, `namespace <name>`, which the layout keeps on one line. */
function titleOf(box: Rect, title: string): Rect {
  const t = namespaceTitleBox(title);
  return { ...t, x: box.x + t.x, y: box.y + t.y };
}

/**
 * The fraction of the way along each labelled edge its label goes, by edge id, on either map: the
 * first of the five spots whose label touches no box drawn (workloads, the Internet and the extra
 * nodes), no namespace box's title and no label placed before it, in the order the edges come. A
 * policy edge needs it as much as a traffic edge: an edge that passes over a layer has its middle on
 * that layer's row, among its boxes. Positions are the flow's own, so the choice holds at any zoom.
 */
export function edgeLabelSpots(flow: PositionedFlow): ReadonlyMap<string, number> {
  const placed = new Map<string, Rect>();
  for (const n of flow.nodes) {
    const parent = n.parent === undefined ? undefined : placed.get(n.parent);
    placed.set(n.id, { x: n.x + (parent?.x ?? 0), y: n.y + (parent?.y ?? 0), width: n.width, height: n.height });
  }
  const boxes = flow.nodes.flatMap((n) => {
    const box = placed.get(n.id);
    if (!box) return [];
    return n.type === 'namespace' ? [titleOf(box, n.label)] : [box];
  });
  const labelled = flow.edges.flatMap((e) => {
    const s = placed.get(e.source), t = placed.get(e.target);
    if (!e.label || !s || !t) return [];
    // From the caller's bottom edge to the callee's top edge, at the handles WorkloadNode draws for the edge's kind.
    const offset = HANDLE_OFFSET[e.kind];
    const curve = edgeCurve({ x: s.x + s.width / 2 + offset, y: s.y + s.height }, { x: t.x + t.width / 2 + offset, y: t.y });
    return [{ id: e.id, candidates: SPOTS.map((f) => pointOn(curve, f)), ...labelSize(e.label) }];
  });
  const spots = labelSpots(labelled, boxes);
  return new Map(labelled.map((l, i) => [l.id, SPOTS[l.candidates.findIndex((p) => p === spots[i])] ?? SPOTS[0]]));
}
