'use client';

import { useReplaceParam } from '@/components/frame/useReplaceParam';

export interface NamespacePickerProps {
  readonly namespaces: readonly { readonly name: string; readonly shown: boolean }[];
}

/**
 * The namespaces a page of one cluster shows, as a list of checkboxes. Each choice is written to the
 * URL as `ns`, the names shown; none shown is an empty `ns`, which differs from no `ns` (the default).
 */
export function NamespacePicker({ namespaces }: NamespacePickerProps) {
  const replaceParam = useReplaceParam();
  const toggle = (name: string) => replaceParam('ns', namespaces.filter((n) => (n.name === name ? !n.shown : n.shown)).map((n) => n.name).join(','));
  const shownCount = namespaces.filter((n) => n.shown).length;
  return (
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
            <input type="checkbox" checked={n.shown} onChange={() => toggle(n.name)} />
            <span className="mono">{n.name}</span>
          </label>
        ))}
      </fieldset>
    </details>
  );
}
