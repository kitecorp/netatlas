import type { ReactNode } from 'react';

export interface PickerChoice {
  readonly label: string;
  readonly href: string;
  readonly current: boolean;
}

export interface LinkPickerProps {
  /** What the closed control shows, such as `Cluster: atlas-a`. */
  readonly summary: ReactNode;
  /** The name of the list of choices. */
  readonly menu: string;
  readonly choices: readonly PickerChoice[];
  /** The policy picker's look: no frame, names in monospace. */
  readonly plain?: boolean;
}

/** A header control: a disclosure with one link per choice, so it works without JavaScript. */
export function LinkPicker({ summary, menu, choices, plain = false }: LinkPickerProps) {
  return (
    <details className={plain ? 'picker picker-plain' : 'picker'}>
      <summary>
        {summary}
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" className="chevron">
          <path d="M2.5 4.5 L6 8 L9.5 4.5" />
        </svg>
      </summary>
      <ul className="picker-menu" aria-label={menu}>
        {choices.map((c) => (
          <li key={c.href}>
            <a href={c.href} aria-current={c.current ? 'page' : undefined} className={plain ? 'mono' : undefined}>
              {c.label}
            </a>
          </li>
        ))}
      </ul>
    </details>
  );
}
