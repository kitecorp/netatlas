'use client';

import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import Link from 'next/link';

export type WorkloadNodeData = {
  label: string;
  sub: string;
  tone: 'normal' | 'open';
  marks: readonly string[];
  /** Where choosing it leads: the same map with the side panel open on it. Absent for the Internet. */
  href?: string;
  selected: boolean;
  highlighted: boolean;
};

export type WorkloadFlowNode = Node<WorkloadNodeData, 'workload' | 'outside'>;

/**
 * Each side has one handle per kind of policy, a little above and below the middle, so a call both
 * kinds allow is drawn as two parallel lines with their labels apart, as in the prototype.
 */
export const HANDLE_OFFSET = { networkpolicy: -10, istio: 10 } as const;
const KINDS = ['networkpolicy', 'istio'] as const;

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
      {KINDS.map((k) => (
        <Handle key={k} id={`target-${k}`} type="target" position={Position.Left} isConnectable={false} className="map-handle" style={{ top: `calc(50% + ${HANDLE_OFFSET[k]}px)` }} />
      ))}
      {data.href ? (
        <Link href={data.href} scroll={false} className={className} aria-current={data.selected ? 'true' : undefined}>
          {body}
        </Link>
      ) : (
        <div className={className}>{body}</div>
      )}
      {KINDS.map((k) => (
        <Handle key={k} id={`source-${k}`} type="source" position={Position.Right} isConnectable={false} className="map-handle" style={{ top: `calc(50% + ${HANDLE_OFFSET[k]}px)` }} />
      ))}
    </>
  );
}
