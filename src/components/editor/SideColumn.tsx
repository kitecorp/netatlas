import { groupsOf, isOpen, type Draft, type RuleInput, type Side } from '@/editor/draft';
import { RuleGroup } from './RuleGroup';

const NOTE = {
  in: { open: 'Open: anything may call in. These rules apply once you restrict it.', restricted: 'Restricted: only these may call in.' },
  out: { open: 'Open: they may call anything. These rules apply once you restrict it.', restricted: 'Restricted: only these may be called.' },
} as const;

export interface SideColumnProps {
  readonly side: Side;
  readonly draft: Draft;
  readonly ns: string;
  /** The open Add rule menu, as `<side>:<group>`. */
  readonly menu: string | null;
  readonly onMenu: (menu: string | null) => void;
  readonly onAdd: (input: RuleInput) => void;
  readonly onForm: (input: RuleInput) => void;
  readonly onRemove: (id: string) => void;
}

/** The heading of one side: who may call in, or what the pods may call, and whether the side is open. */
export function SideHead({ side, open }: { side: Side; open: boolean }) {
  return (
    <div className={`side-head side-head-${side}`}>
      <div className="side-head-title">{side === 'in' ? 'Who may call in' : 'What they may call'}</div>
      <div className={open ? 'side-note warn-text' : 'side-note muted'}>{NOTE[side][open ? 'open' : 'restricted']}</div>
    </div>
  );
}

/** One side's three boxes, joined by a line to its lock. */
export function SideColumn({ side, draft, ns, menu, onMenu, onAdd, onForm, onRemove }: SideColumnProps) {
  const open = isOpen(draft, side);
  return (
    <div className={`side-column side-column-${side} bus-${open ? 'open' : 'restricted'}`}>
      {groupsOf(draft, side).map((g) => {
        const key = `${side}:${g.group}`;
        return (
          <RuleGroup
            key={g.group}
            side={side}
            group={g.group}
            title={g.title}
            rows={g.rows}
            open={open}
            menuOpen={menu === key}
            ns={ns}
            onMenu={() => onMenu(menu === key ? null : key)}
            onAdd={onAdd}
            onForm={onForm}
            onRemove={onRemove}
          />
        );
      })}
    </div>
  );
}
