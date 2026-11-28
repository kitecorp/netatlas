'use client';

import { BaseEdge, type Edge, type EdgeProps } from '@xyflow/react';
import { curvePath, edgeCurve, pointOn } from './edge-labels';

/** An edge of either map, with the fraction of the way along it where its label goes (`edgeLabelSpots`). */
export type MapFlowEdge = Edge<{ spot: number }, 'map'>;

/** React Flow's default curve, with the label at its chosen spot instead of always the middle. */
export function MapEdge({ sourceX, sourceY, targetX, targetY, data, markerEnd, style, label, labelStyle }: EdgeProps<MapFlowEdge>) {
  const curve = edgeCurve({ x: sourceX, y: sourceY }, { x: targetX, y: targetY });
  const at = pointOn(curve, data?.spot ?? 0.5);
  return <BaseEdge path={curvePath(curve)} markerEnd={markerEnd} style={style} label={label} labelX={at.x} labelY={at.y} labelStyle={labelStyle} />;
}
