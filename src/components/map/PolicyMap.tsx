'use client';

import { Controls, MarkerType, Position, ReactFlow, useReactFlow, useStore, type Edge, type EdgeTypes, type FitViewOptions, type NodeTypes } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { TRAFFIC_LOOK } from '@/components/traffic/look';
import type { FlowEdge } from '@/model/flow';
import { namespaceTitleBox } from '@/model/map-text';
import type { PositionedFlow } from '@/server/layout';
import { edgeLabelSpots } from './edge-labels';
import { MapEdge, type MapFlowEdge } from './MapEdge';
import { NamespaceGroup, NamespaceTitle, type NamespaceFlowNode, type NamespaceTitleFlowNode } from './NamespaceGroup';
import { EDGE_KINDS, HANDLE_OFFSET, WorkloadNode, type WorkloadFlowNode } from './WorkloadNode';

// The Internet and the traffic view's extra nodes (callers outside the mesh, workloads not running now) share one look.
const nodeTypes: NodeTypes = { workload: WorkloadNode, outside: WorkloadNode, namespace: NamespaceGroup, namespaceTitle: NamespaceTitle };
// Every edge, of either kind of policy or of traffic, is drawn by one component, which puts its label at its spot.
const edgeTypes: EdgeTypes = { map: MapEdge };

const COLOURS = { networkpolicy: '#6cb6ff', istio: '#ffb454' } as const;

/**
 * The drawing order, set by hand (`zIndexMode="manual"`): namespace boxes, then the workload boxes, then
 * edge lines and labels, then the namespace boxes' titles. A line runs directly to its end across any box in
 * its way, and is drawn over that box, so it is seen crossing it: drawn under, it would seem to end at the
 * box, a call the policies may not allow. Each label sits on its own line, and its spot keeps it off the
 * boxes and the titles (`edgeLabelSpots`). A title is drawn above the lines on its box's background, so a
 * line that enters a box from above passes behind the title instead of striking its text through.
 */
const LAYER = { namespace: 0, box: 1, edge: 2, title: 3 } as const;

/** The id of a namespace box's title node; it starts with neither a workload id nor `namespace:`, so it is never taken for either. */
const titleId = (namespaceId: string): string => `title:${namespaceId}`;

/** What a map with no namespace drawn says, so that it is not an empty box. */
const NO_NAMESPACE = 'No namespace is shown. Open Namespaces to show one.';

/** Room around the map inside its box, as the layout leaves around its nodes. */
const PADDING = 24;
/** Room under the map for the zoom buttons (32 px, 15 px from the edge), so a fitted map never lies under them. */
const BUTTONS_ROOM = 56;
/** So low that any cluster's whole map fits its box when first drawn, however small that makes it; the person zooms in from there. */
const MIN_ZOOM = 0.001;
const MAX_ZOOM = 2;

/** The scale at which the whole map fits the box's width with its padding, never above 100%. */
const fitZoomOf = (boxWidth: number, mapWidth: number): number => Math.max(MIN_ZOOM, Math.min(1, (boxWidth - 2 * PADDING) / mapWidth));

/** React Flow's fit at that scale: it centres the map across the box, which is as tall as the scaled map with its room. */
const fitAt = (zoom: number): FitViewOptions => ({ padding: { top: `${PADDING}px`, right: `${PADDING}px`, bottom: `${BUTTONS_ROOM}px`, left: `${PADDING}px` }, minZoom: zoom, maxZoom: zoom });

/** A policy edge's look is its kind's, in the stylesheet; a traffic edge's is its mark's, or `seen` without one. */
function edgeLook(e: FlowEdge): Pick<Edge, 'className' | 'markerEnd' | 'style' | 'labelStyle'> {
  if (e.kind !== 'traffic') return { className: `map-edge map-edge-${e.kind}`, markerEnd: { type: MarkerType.ArrowClosed, color: COLOURS[e.kind] } };
  const look = TRAFFIC_LOOK[e.mark ?? 'seen'];
  return {
    className: 'map-edge map-edge-traffic',
    markerEnd: { type: MarkerType.ArrowClosed, color: look.line },
    style: { stroke: look.line, ...(look.dash ? { strokeDasharray: look.dash } : {}) },
    labelStyle: { fill: look.text },
  };
}

/** The rectangle the map's boxes cover: a namespace box holds its workloads, so the boxes without a parent are enough. */
function boundsOf(flow: PositionedFlow) {
  const roots = flow.nodes.filter((n) => n.parent === undefined);
  if (!roots.length) return { width: flow.width, height: flow.height };
  const left = Math.min(...roots.map((n) => n.x)), top = Math.min(...roots.map((n) => n.y));
  return { width: Math.max(...roots.map((n) => n.x + n.width)) - left, height: Math.max(...roots.map((n) => n.y + n.height)) - top };
}

/** The width of the element's content, kept current; undefined until the browser has measured it (on the server). */
function useWidth(ref: RefObject<HTMLElement | null>): number | undefined {
  const [width, setWidth] = useState<number | undefined>(undefined);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/**
 * Fits the map to its box whenever the box changes size (a panel opens or closes, the window is
 * resized) or the map changes, until the person zooms or pans; Fit View hands the fitting back.
 * A new zoom gives the box a new height, which React Flow measures a frame later (in whole pixels),
 * and its fit centres the map in the height it measured last; so the fit waits for the box's new
 * height, else the map is drawn off centre, up or down, for a frame on every change of width.
 */
function FitToBox({ moved, zoom, map, boxHeight }: { moved: RefObject<boolean>; zoom: number; map: string; boxHeight: number }) {
  const { fitView } = useReactFlow();
  const width = useStore((s) => s.width), height = useStore((s) => s.height);
  useEffect(() => {
    if (width > 0 && Math.abs(height - boxHeight) < 1 && !moved.current) void fitView(fitAt(zoom));
  }, [width, height, boxHeight, zoom, map, fitView, moved]);
  return null;
}

export interface PolicyMapProps {
  /** The map's name for assistive technology: `Policy map of atlas-b`. */
  readonly name: string;
  readonly flow: PositionedFlow;
  /** Each node's link, a workload's or the Internet's, which opens the side panel on it. */
  readonly hrefs: Readonly<Record<string, string>>;
  readonly selected?: string;
  readonly highlighted: readonly string[];
}

/**
 * The map, or with no namespace drawn a sentence that says how to show one, above what is still drawn: the
 * Internet node of a cluster with a traffic source, which opens the short list. A map with nothing at all to
 * draw draws no box. The drawn map is a component of its own, so it measures its box afresh whenever it
 * appears again.
 */
export function PolicyMap(props: PolicyMapProps) {
  const noNamespace = !props.flow.nodes.some((n) => n.type === 'namespace');
  return (
    <>
      {noNamespace ? <p className="empty">{NO_NAMESPACE}</p> : null}
      {props.flow.nodes.length ? <DrawnMap {...props} /> : null}
    </>
  );
}

/**
 * The map, drawn by React Flow from nodes the server already positioned. Every node and handle has
 * its size and place, so React Flow renders the whole map, edges included, on the server too. In the
 * browser the map is scaled to fit its box, and the box is as tall as the scaled map; the person can
 * zoom with the buttons, or with a pinch or Ctrl and scroll, and pan by dragging, while plain scrolling
 * still scrolls the page. Nothing is dragged, connected or selected.
 */
function DrawnMap({ name, flow, hrefs, selected, highlighted }: PolicyMapProps) {
  const box = useRef<HTMLDivElement>(null);
  const boxWidth = useWidth(box);
  const moved = useRef(false);
  const bounds = boundsOf(flow);
  // On the server the box is not measured yet, so the map is drawn at 100% until the browser fits it.
  const fitZoom = boxWidth === undefined ? 1 : fitZoomOf(boxWidth, bounds.width);
  const height = bounds.height * fitZoom + PADDING + BUTTONS_ROOM;
  const matches = new Set(highlighted);
  const nodes: (WorkloadFlowNode | NamespaceFlowNode | NamespaceTitleFlowNode)[] = flow.nodes.map((n) => {
    // The size is known, so React Flow counts each node measured from the start: a fit asked for after
    // the page renders again then runs at once, rather than waiting for a measurement that never comes.
    const size = { width: n.width, height: n.height };
    const place = { id: n.id, position: { x: n.x, y: n.y }, ...size, measured: size, ...(n.parent ? { parentId: n.parent } : {}) };
    if (n.type === 'namespace') return { ...place, type: 'namespace', data: {}, zIndex: LAYER.namespace };
    const href = hrefs[n.id];
    return {
      ...place,
      type: n.type,
      zIndex: LAYER.box,
      // React Flow lets pointer events through only to nodes it can select or drag; these hold a link.
      style: { pointerEvents: 'all' },
      // The same handles WorkloadNode draws, so the server can draw the edges before the browser measures them:
      // calls arrive at the top edge and leave from the bottom edge.
      handles: EDGE_KINDS.flatMap((k) => [
        { id: `target-${k}`, type: 'target' as const, position: Position.Top, x: n.width / 2 + HANDLE_OFFSET[k], y: 0 },
        { id: `source-${k}`, type: 'source' as const, position: Position.Bottom, x: n.width / 2 + HANDLE_OFFSET[k], y: n.height },
      ]),
      data: { label: n.label, sub: n.sub, tone: n.tone, marks: n.marks ?? [], ...(href ? { href } : {}), selected: n.id === selected, highlighted: matches.has(n.id) },
    };
  });
  // Each title after every box, since React Flow needs a parent before its children. Its place and size in the
  // box are the ones the label spots keep the labels off.
  for (const n of flow.nodes) {
    if (n.type !== 'namespace') continue;
    const t = namespaceTitleBox(n.label), size = { width: t.width, height: t.height };
    nodes.push({ id: titleId(n.id), type: 'namespaceTitle', parentId: n.id, position: { x: t.x, y: t.y }, ...size, measured: size, data: { label: n.label }, zIndex: LAYER.title });
  }
  const spots = edgeLabelSpots(flow);
  const edges: MapFlowEdge[] = flow.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: `source-${e.kind}`,
    targetHandle: `target-${e.kind}`,
    label: e.label,
    ariaLabel: e.ariaLabel,
    ...edgeLook(e),
    type: 'map',
    data: { spot: spots.get(e.id) ?? 0.5 },
    zIndex: LAYER.edge,
  }));
  return (
    <div className="map-box" ref={box}>
      <div style={{ height }}>
        <ReactFlow
          aria-label={name}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          zIndexMode="manual"
          defaultViewport={{ x: 0, y: 0, zoom: 1 }}
          minZoom={MIN_ZOOM}
          maxZoom={MAX_ZOOM}
          colorMode="dark"
          nodesDraggable={false}
          nodesConnectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          elementsSelectable={false}
          panOnDrag
          panOnScroll={false}
          zoomOnScroll={false}
          zoomOnPinch
          zoomOnDoubleClick={false}
          preventScrolling={false}
          // Only the person's own moves carry an event; a fit or a button's zoom carries none.
          onMove={(event) => {
            if (event) moved.current = true;
          }}
        >
          <Controls
            orientation="horizontal"
            showInteractive={false}
            fitViewOptions={fitAt(fitZoom)}
            onZoomIn={() => (moved.current = true)}
            onZoomOut={() => (moved.current = true)}
            onFitView={() => (moved.current = false)}
          />
          <FitToBox moved={moved} zoom={fitZoom} map={`${bounds.width}x${bounds.height}`} boxHeight={height} />
        </ReactFlow>
      </div>
    </div>
  );
}
