import { menuOptions, type Group, type RuleInput, type Side } from '@/editor/draft';

/** What one box's Add rule offers. Kubernetes DNS is added at once; every other choice opens the form. */
export function AddRuleMenu({ side, group, ns, onAdd, onForm }: { side: Side; group: Group; ns: string; onAdd: (input: RuleInput) => void; onForm: (input: RuleInput) => void }) {
  return (
    <div className="rule-menu">
      {menuOptions(side, group, ns).map((o) => {
        const input: RuleInput = { group, kind: o.kind, pod: '', ns: '', cidr: '', ports: '' };
        return (
          <button key={o.kind} type="button" className="rule-option" onClick={() => (o.kind === 'dns' ? onAdd(input) : onForm(input))}>
            <span className="rule-option-title">{o.title}</span>
            <span className="rule-option-hint">{o.hint}</span>
          </button>
        );
      })}
    </div>
  );
}
