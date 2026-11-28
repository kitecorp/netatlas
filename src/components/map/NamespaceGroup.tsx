'use client';

import type { Node, NodeProps } from '@xyflow/react';
import { NAMESPACE_TITLE } from '@/model/map-text';

export type NamespaceFlowNode = Node<Record<string, never>, 'namespace'>;

/** The box around one namespace's workloads; its title is a node of its own (`NamespaceTitle`), drawn above the lines. */
export function NamespaceGroup() {
  return <div className="map-namespace" />;
}

export type NamespaceTitleFlowNode = Node<{ label: string }, 'namespaceTitle'>;

/**
 * A namespace box's title, `namespace <name>`, placed in the box's corner at `NAMESPACE_TITLE`. It is set on the
 * box's own background, so a line drawn under it passes behind the title for the title's height only.
 */
export function NamespaceTitle({ data }: NodeProps<NamespaceTitleFlowNode>) {
  return (
    <span className="map-namespace-label" style={{ lineHeight: `${NAMESPACE_TITLE.lineHeight}px` }}>
      {data.label}
    </span>
  );
}
