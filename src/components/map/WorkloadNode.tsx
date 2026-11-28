'use client';

import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import Link from 'next/link';
import type { FlowEdge } from '@/model/flow';

export type WorkloadNodeData = {
  label: string;
  sub: string;
  tone: 'normal' | 'open';
  marks: readonly string[];
  /** Where choosing it leads: the same map with the side panel open on it. Absent on the traffic view, whose nodes open nothing. */
  href?: string;
  selected: boolean;
  highlighted: boolean;
};

export type WorkloadFlowNode = Node<WorkloadNodeData, 'workload' | 'outside'>;

/**
 * Calls leave a box from its bottom edge and arrive at its top edge (the map is laid out top to bottom).
 * Each edge has one handle per kind of policy, along the box's width a quarter of its 176 px each side of
 * the middle, so a call both kinds allow is drawn as two parallel lines 88 px apart: their labels, at the
 * same height side by side, stay apart up to 88 px wide each (`TCP 8080` takes 66). The traffic view draws
 * one edge per pair, so its handle is the middle.
 */
export const HANDLE_OFFSET: Readonly<Record<FlowEdge['kind'], number>> = { networkpolicy: -44, istio: 44, traffic: 0 };
export const EDGE_KINDS: readonly FlowEdge['kind'][] = ['networkpolicy', 'istio', 'traffic'];

/** A workload's box, or the Internet's: its name, what covers it, and the marks of what it leaves open (rules with no peers, sides no policy restricts). */
export function WorkloadNode({ data, type }: NodeProps<WorkloadFlowNode>) {
  const className = ['map-node', `map-node-${type === 'outside' ? 'outside' : data.tone}`, data.selected ? 'map-node-selected' : '', data.highlighted ? 'map-node-match' : '']
    .filter(Boolean)
    .join(' ');
  const body = (
    <>
      <b>{data.label}</b>
      <span className="map-node-sub">{data.sub}</span>
      {data.marks.map((m) => (
        <span key={m} className="map-node-mark">
          {m}
        </span>
      ))}
    </>
  );
  return (
    <>
      {EDGE_KINDS.map((k) => (
        <Handle key={k} id={`target-${k}`} type="target" position={Position.Top} isConnectable={false} className="map-handle" style={{ left: `calc(50% + ${HANDLE_OFFSET[k]}px)` }} />
      ))}
      {data.href ? (
        <Link href={data.href} scroll={false} className={className} aria-current={data.selected ? 'true' : undefined}>
          {body}
        </Link>
      ) : (
        <div className={className}>{body}</div>
      )}
      {EDGE_KINDS.map((k) => (
        <Handle key={k} id={`source-${k}`} type="source" position={Position.Bottom} isConnectable={false} className="map-handle" style={{ left: `calc(50% + ${HANDLE_OFFSET[k]}px)` }} />
      ))}
    </>
  );
}
