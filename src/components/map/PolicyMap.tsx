'use client';

import { MarkerType, Position, ReactFlow, type Edge, type NodeTypes } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { PositionedFlow } from '@/server/layout';
import { NamespaceGroup, type NamespaceFlowNode } from './NamespaceGroup';
import { HANDLE_OFFSET, WorkloadNode, type WorkloadFlowNode } from './WorkloadNode';

const nodeTypes: NodeTypes = { workload: WorkloadNode, outside: WorkloadNode, namespace: NamespaceGroup };

const COLOURS = { networkpolicy: '#6cb6ff', istio: '#ffb454' } as const;

export interface PolicyMapProps {
  readonly flow: PositionedFlow;
  /** Each workload's link, which opens the side panel on it. */
  readonly hrefs: Readonly<Record<string, string>>;
  readonly selected?: string;
  readonly highlighted: readonly string[];
}

/**
 * The map, drawn by React Flow from nodes the server already positioned. Every node and handle has
 * its size and place, so React Flow renders the whole map, edges included, on the server too; the
 * map is fixed, so nothing is dragged, connected or zoomed.
 */
export function PolicyMap({ flow, hrefs, selected, highlighted }: PolicyMapProps) {
  const matches = new Set(highlighted);
  const nodes: (WorkloadFlowNode | NamespaceFlowNode)[] = flow.nodes.map((n) => {
    const place = { id: n.id, position: { x: n.x, y: n.y }, width: n.width, height: n.height, ...(n.parent ? { parentId: n.parent } : {}) };
    if (n.type === 'namespace') return { ...place, type: 'namespace', data: { label: n.label }, zIndex: 0 };
    const href = hrefs[n.id];
    return {
      ...place,
      type: n.type,
      zIndex: 1,
      // React Flow lets pointer events through only to nodes it can select or drag; these hold a link.
      style: { pointerEvents: 'all' },
      // The same handles WorkloadNode draws, so the server can draw the edges before the browser measures them.
      handles: (['networkpolicy', 'istio'] as const).flatMap((k) => [
        { id: `target-${k}`, type: 'target' as const, position: Position.Left, x: 0, y: n.height / 2 + HANDLE_OFFSET[k] },
        { id: `source-${k}`, type: 'source' as const, position: Position.Right, x: n.width, y: n.height / 2 + HANDLE_OFFSET[k] },
      ]),
      data: { label: n.label, sub: n.sub, tone: n.tone, marks: n.marks ?? [], ...(href ? { href } : {}), selected: n.id === selected, highlighted: matches.has(n.id) },
    };
  });
  const edges: Edge[] = flow.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: `source-${e.kind}`,
    targetHandle: `target-${e.kind}`,
    label: e.label,
    ariaLabel: e.ariaLabel,
    className: `map-edge map-edge-${e.kind}`,
    markerEnd: { type: MarkerType.ArrowClosed, color: COLOURS[e.kind] },
    zIndex: 2,
  }));
  return (
    <div className="map-box">
      <div style={{ width: flow.width, height: flow.height }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          width={flow.width}
          height={flow.height}
          defaultViewport={{ x: 0, y: 0, zoom: 1 }}
          colorMode="dark"
          nodesDraggable={false}
          nodesConnectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          elementsSelectable={false}
          panOnDrag={false}
          panOnScroll={false}
          zoomOnScroll={false}
          zoomOnPinch={false}
          zoomOnDoubleClick={false}
          preventScrolling={false}
        />
      </div>
    </div>
  );
}
