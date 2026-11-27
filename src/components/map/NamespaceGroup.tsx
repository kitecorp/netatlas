'use client';

import type { Node, NodeProps } from '@xyflow/react';

export type NamespaceFlowNode = Node<{ label: string }, 'namespace'>;

/** The box around one namespace's workloads, with its name in the corner. */
export function NamespaceGroup({ data }: NodeProps<NamespaceFlowNode>) {
  return (
    <div className="map-namespace">
      <span className="map-namespace-label">{data.label}</span>
    </div>
  );
}
