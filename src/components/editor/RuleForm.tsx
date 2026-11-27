import { useEffect, useRef, type ChangeEvent, type KeyboardEvent } from 'react';
import { invalidFields, menuOptions, type Group, type RuleInput, type Side } from '@/editor/draft';

const LABELS_HINT = 'Write labels as key=value, separated by commas.';

export interface RuleFormProps {
  readonly side: Side;
  readonly group: Group;
  readonly form: RuleInput;
  readonly ns: string;
  readonly onChange: (form: RuleInput) => void;
  readonly onCancel: () => void;
  readonly onSubmit: () => void;
}

type Field = 'ns' | 'pod' | 'cidr' | 'ports';

/**
 * The dialog that asks for a new rule's labels, address range and ports. A field that does not parse
 * says how to write it. It is modal: Tab stays inside it, and on closing the focus goes back to the
 * Add rule button that opened it (its menu is gone by then).
 */
export function RuleForm({ side, group, form, ns, onChange, onCancel, onSubmit }: RuleFormProps) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dialog.current?.querySelector('input')?.focus();
    return () => document.querySelector<HTMLButtonElement>(`[data-add-rule="${side}:${group}"]`)?.focus();
  }, [side, group]);
  const showNs = form.group === 'cluster' && form.kind === 'labels';
  const showPod = form.kind === 'labels';
  const showCidr = form.group === 'outside' && form.kind === 'cidr';
  const invalid = invalidFields(form);
  // A field says it is wrong only once something is written in it; an empty required field just keeps Add rule disabled.
  const bad = (field: Field) => invalid.includes(field) && (form[field] ?? '').trim() !== '';
  const title = menuOptions(side, form.group, ns).find((o) => o.kind === form.kind)?.title ?? 'Add rule';
  const set = (field: Field) => (e: ChangeEvent<HTMLInputElement>) => onChange({ ...form, [field]: e.target.value });
  /** The hint under a field, tied to it so a screen reader reads it with the field. */
  const checked = (field: Field) => ({ 'aria-invalid': bad(field), ...(bad(field) ? { 'aria-describedby': `rule-form-${field}-hint` } : {}) });
  const hint = (field: Field, text: string) =>
    bad(field) ? (
      <div className="field-bad" id={`rule-form-${field}-hint`}>
        {text}
      </div>
    ) : null;
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') return onCancel();
    if (e.key !== 'Tab') return;
    const stops = [...(dialog.current?.querySelectorAll<HTMLElement>('input, button:not([disabled])') ?? [])];
    const first = stops[0], last = stops.at(-1);
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last?.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first?.focus();
    }
  };
  return (
    <div className="dialog-backdrop">
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="rule-form-title" className="dialog" onKeyDown={onKeyDown}>
        <h2 id="rule-form-title" className="dialog-title">
          {title}
        </h2>
        <div className="dialog-info">{side === 'in' ? 'Calls in from what you choose here will be allowed.' : 'Calls out to what you choose here will be allowed.'}</div>
        {showNs ? (
          <>
            <label className="field">
              <b>Namespace labels</b>
              <input className="mono" value={form.ns ?? ''} onChange={set('ns')} placeholder="kubernetes.io/metadata.name=payments" {...checked('ns')} />
            </label>
            {hint('ns', LABELS_HINT)}
          </>
        ) : null}
        {showPod ? (
          <>
            <label className="field">
              <b>{form.group === 'namespace' ? 'Pod labels' : 'Pod labels (leave empty for every pod in those namespaces)'}</b>
              <input className="mono" value={form.pod ?? ''} onChange={set('pod')} placeholder="app=frontend, version=2" {...checked('pod')} />
            </label>
            {hint('pod', LABELS_HINT)}
          </>
        ) : null}
        {showCidr ? (
          <>
            <label className="field">
              <b>Address range</b>
              <input className="mono" value={form.cidr ?? ''} onChange={set('cidr')} placeholder="10.0.0.0/8" {...checked('cidr')} />
            </label>
            {hint('cidr', 'Write an address range such as 10.0.0.0/8.')}
          </>
        ) : null}
        <label className="field">
          <span>
            <b>Ports</b> <span className="muted">(leave empty for every port)</span>
          </span>
          <input className="mono" value={form.ports} onChange={set('ports')} placeholder="8080, 443, 53/UDP" {...checked('ports')} />
        </label>
        {hint('ports', 'Write ports as numbers, with /UDP for UDP, for example 8080, 53/UDP.')}
        <div className="dialog-actions">
          <button type="button" className="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="button button-primary" disabled={invalid.length > 0} onClick={onSubmit}>
            Add rule
          </button>
        </div>
      </div>
    </div>
  );
}
