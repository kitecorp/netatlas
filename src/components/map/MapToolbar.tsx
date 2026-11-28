'use client';

import { useReplaceParam } from '@/components/frame/useReplaceParam';
import type { Flow } from '@/model/flow';
import { NamespacePicker, type NamespacePickerProps } from './NamespacePicker';

export interface MapToolbarProps {
  readonly counts: Flow['counts'];
  readonly namespaces: NamespacePickerProps['namespaces'];
  readonly show: { readonly networkpolicy: boolean; readonly istio: boolean };
}

const KINDS = [
  { kind: 'networkpolicy', label: 'NetworkPolicy' },
  { kind: 'istio', label: 'Istio' },
] as const;

/**
 * The counts of what the map shows, the namespaces it shows, and which kinds of policy it draws.
 * Each choice is written to the URL (`ns`, `show`), so the server draws the map again and a link
 * keeps it; the other parameters stay as they are.
 */
export function MapToolbar({ counts, namespaces, show }: MapToolbarProps) {
  const replaceParam = useReplaceParam();
  const toggleKind = (kind: keyof typeof show) => replaceParam('show', KINDS.filter((k) => (k.kind === kind ? !show[k.kind] : show[k.kind])).map((k) => k.kind).join(','));
  return (
    <div className="map-toolbar">
      <div className="map-counts">
        <span>
          <b>{counts.workloads}</b> {counts.workloads === 1 ? 'workload' : 'workloads'}
        </span>
        <span>
          <b>{counts.policies}</b> {counts.policies === 1 ? 'policy' : 'policies'}
        </span>
        <span>
          <b className="open-text">{counts.noPolicy}</b> {counts.noPolicy === 1 ? 'workload' : 'workloads'} with no policy
        </span>
      </div>
      <div className="map-controls">
        <NamespacePicker namespaces={namespaces} />
        {KINDS.map((k) => (
          <button key={k.kind} type="button" className={`toggle toggle-${k.kind}`} aria-pressed={show[k.kind]} onClick={() => toggleKind(k.kind)}>
            <svg aria-hidden="true" width="24" height="8" viewBox="0 0 24 8" className={`line-${k.kind}`}>
              <path d="M1 4 L23 4" />
            </svg>
            {k.label}
          </button>
        ))}
      </div>
    </div>
  );
}
