'use client';

import { useRouter } from 'next/navigation';
import type { Flow } from '@/model/flow';

export interface MapToolbarProps {
  readonly counts: Flow['counts'];
  readonly namespaces: readonly { readonly name: string; readonly shown: boolean }[];
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
  const router = useRouter();
  const go = (key: string, values: readonly string[]) => {
    const params = new URLSearchParams(window.location.search);
    params.set(key, values.join(','));
    router.replace(`?${params.toString()}`, { scroll: false });
  };
  const toggleNamespace = (name: string) => go('ns', namespaces.filter((n) => (n.name === name ? !n.shown : n.shown)).map((n) => n.name));
  const toggleKind = (kind: keyof typeof show) => go('show', KINDS.filter((k) => (k.kind === kind ? !show[k.kind] : show[k.kind])).map((k) => k.kind));
  const shownCount = namespaces.filter((n) => n.shown).length;
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
        <details className="picker picker-plain">
          <summary>
            Namespaces: {shownCount} of {namespaces.length}
            <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" className="chevron">
              <path d="M2.5 4.5 L6 8 L9.5 4.5" />
            </svg>
          </summary>
          <fieldset className="picker-menu">
            <legend className="eyebrow">Namespaces shown</legend>
            {namespaces.map((n) => (
              <label key={n.name} className="picker-check">
                <input type="checkbox" checked={n.shown} onChange={() => toggleNamespace(n.name)} />
                <span className="mono">{n.name}</span>
              </label>
            ))}
          </fieldset>
        </details>
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
