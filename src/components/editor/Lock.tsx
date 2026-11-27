import type { Side } from '@/editor/draft';

const ARIA = {
  in: {
    open: 'Calls in are open: anything may call in. Restrict them to the rules on the left.',
    restricted: 'Calls in are restricted to the rules on the left. Open them to everything.',
  },
  out: {
    open: 'Calls out are open: these pods may call anything. Restrict them to the rules on the right.',
    restricted: 'Calls out are restricted to the rules on the right. Open them to everything.',
  },
} as const;

/** The lock between a side's rules and the pods: pressed is restricted, so only the rules may pass. */
export function Lock({ side, open, onToggle }: { side: Side; open: boolean; onToggle: () => void }) {
  return (
    <div className={`lock-cell lock-cell-${open ? 'open' : 'restricted'}`}>
      <button type="button" className={`lock lock-${open ? 'open' : 'restricted'}`} aria-pressed={!open} aria-label={ARIA[side][open ? 'open' : 'restricted']} onClick={onToggle}>
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" className="lock-icon">
          <rect x="3" y="7" width="10" height="7" rx="1.5" />
          <path d={open ? 'M5 7 V5 a3 3 0 0 1 5.6 -1.5' : 'M5 7 V5 a3 3 0 0 1 6 0 V7'} />
        </svg>
        {open ? 'Open' : 'Restricted'}
      </button>
    </div>
  );
}
