'use client';

import { useReplaceParam } from '@/components/frame/useReplaceParam';
import { NamespacePicker, type NamespacePickerProps } from '@/components/map/NamespacePicker';

export interface TrafficToolbarProps {
  readonly namespaces: NamespacePickerProps['namespaces'];
  readonly compare: boolean;
}

/**
 * What the traffic view measures, the namespaces it shows, its window and the comparison toggle. The
 * window is fixed, so it is text, not a picker. The comparison is on unless the URL says `compare=0`,
 * so turning it on again removes the parameter.
 */
export function TrafficToolbar({ namespaces, compare }: TrafficToolbarProps) {
  const replaceParam = useReplaceParam();
  return (
    <div className="map-toolbar">
      <p className="muted toolbar-lead">Requests measured by Istio, read from Prometheus</p>
      <div className="map-controls">
        <NamespacePicker namespaces={namespaces} />
        <span className="toolbar-text">Last 5 minutes</span>
        <button type="button" className="toggle toggle-compare" aria-pressed={compare} onClick={() => replaceParam('compare', compare ? '0' : undefined)}>
          Compare with policies
        </button>
      </div>
    </div>
  );
}
