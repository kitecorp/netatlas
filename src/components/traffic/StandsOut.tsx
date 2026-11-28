import type { StandsOutGroup, StandsOutTone } from '@/model/traffic';

/** The prototype's look of each tone: the open colour, the warning one, or the plain card. */
const TONE_CLASS: Readonly<Record<StandsOutTone, string>> = { normal: 'notice', open: 'notice notice-open', warn: 'notice notice-warn' };

/** The side panel of the traffic view: the model's groups, each item with its reason, then its notes. */
export function StandsOut({ groups, notes }: { groups: readonly StandsOutGroup[]; notes: readonly string[] }) {
  return (
    <aside className="side" aria-labelledby="stands-out-title">
      <h2 className="side-title" id="stands-out-title">
        What stands out
      </h2>
      {groups.length === 0 ? <p className="empty">Nothing stands out.</p> : null}
      {groups.map((group, i) => (
        <section key={group.title} className={TONE_CLASS[group.tone]} aria-labelledby={`stands-out-${i}`}>
          <h3 id={`stands-out-${i}`}>{group.title}</h3>
          <ul>
            {group.items.map((item) => (
              <li key={item.id} className="stands-out-item">
                <span>{item.text}</span>
                <span className="stands-out-reason">{item.reason}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {/* The model names each workload so no two can be mistaken, so no two notes are the same. */}
      {notes.map((note) => (
        <p key={note} className="stands-out-note">
          {note}
        </p>
      ))}
    </aside>
  );
}
