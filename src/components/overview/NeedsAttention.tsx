import type { Attention } from '@/model/overview';

const TONES: Readonly<Record<string, string>> = {
  'Policies not enforced': 'notice notice-warn',
  'Open workloads': 'notice notice-open',
  'Egress the mesh needs': 'notice notice-warn',
};

/** needsAttention's items under their titles, one line each. */
export function NeedsAttention({ items }: { items: readonly Attention[] }) {
  const groups = new Map<string, string[]>();
  for (const item of items) groups.set(item.title, [...(groups.get(item.title) ?? []), item.text]);
  return (
    <aside className="side" aria-labelledby="attention-title">
      <h2 className="side-title" id="attention-title">
        Needs attention
      </h2>
      {[...groups].map(([title, lines], i) =>
        title ? (
          <section key={title} className={TONES[title] ?? 'notice'} aria-labelledby={`attention-${i}`}>
            <h3 id={`attention-${i}`}>{title}</h3>
            <ul>
              {lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </section>
        ) : (
          lines.map((line) => (
            <p key={line} className="empty">
              {line}
            </p>
          ))
        ),
      )}
    </aside>
  );
}
