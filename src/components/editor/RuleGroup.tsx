import { addRuleName, type Group, type Row, type RuleInput, type Side } from '@/editor/draft';
import { AddRuleMenu } from './AddRuleMenu';

export interface RuleGroupProps {
  readonly side: Side;
  readonly group: Group;
  readonly title: string;
  readonly rows: readonly Row[];
  /** The side is open, so its rules apply only once it is restricted again. */
  readonly open: boolean;
  readonly menuOpen: boolean;
  readonly ns: string;
  readonly onMenu: () => void;
  readonly onAdd: (input: RuleInput) => void;
  readonly onForm: (input: RuleInput) => void;
  readonly onRemove: (id: string) => void;
}

function emptyText(side: Side, open: boolean): string {
  if (open) return 'No rules here.';
  return side === 'in' ? 'Nothing from here may call in.' : 'Nothing here may be called.';
}

/** One box of a side (outside the cluster, the namespace, across the cluster): its rows and its Add rule menu. */
export function RuleGroup({ side, group, title, rows, open, menuOpen, ns, onMenu, onAdd, onForm, onRemove }: RuleGroupProps) {
  const line = open ? 'open' : rows.length ? 'restricted' : 'empty';
  const connector = <div className={`group-connector group-connector-${side} connector-${line}`} aria-hidden="true" />;
  return (
    <div className="group-row">
      {side === 'out' ? connector : null}
      <div className="group-box">
        <div className="group-head">
          <b>{title}</b>
          <button type="button" className="add-rule" aria-expanded={menuOpen} aria-label={addRuleName(side, group, ns)} data-add-rule={`${side}:${group}`} onClick={onMenu}>
            <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" className="icon-stroke">
              <path d="M6 1.5 V10.5 M1.5 6 H10.5" />
            </svg>
            Add rule
          </button>
        </div>
        {menuOpen ? <AddRuleMenu side={side} group={group} ns={ns} onAdd={onAdd} onForm={onForm} /> : null}
        {rows.map((r) => (
          <div key={r.id} className={r.kept ? 'rule-row rule-row-kept' : 'rule-row'}>
            <div className="rule-text">
              <span className="rule-title">{r.title}</span>
              {r.kept ? <pre className="rule-detail">{r.detail}</pre> : <span className="rule-detail">{r.detail}</span>}
            </div>
            <button type="button" className="remove-rule" aria-label={`Remove the rule ${r.title}`} onClick={() => onRemove(r.id)}>
              <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" className="icon-stroke">
                <path d="M2 2 L10 10 M10 2 L2 10" />
              </svg>
            </button>
          </div>
        ))}
        {rows.length ? null : <div className="empty group-empty">{emptyText(side, open)}</div>}
      </div>
      {side === 'in' ? connector : null}
    </div>
  );
}
