'use client';

import { useSyncExternalStore } from 'react';

const hhmm = (hours: number, minutes: number) => `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;

const never = () => () => {};

/**
 * `HH:MM` in the viewer's time zone. The server knows only its own zone, so it renders UTC; React
 * hydrates with the server's text, then renders the browser's (the server and client snapshots of
 * useSyncExternalStore), so the two renders never disagree during hydration.
 */
export function LocalTime({ iso }: { iso: string }) {
  const inBrowser = useSyncExternalStore(never, () => true, () => false);
  const at = new Date(iso);
  return <time dateTime={iso}>{inBrowser ? hhmm(at.getHours(), at.getMinutes()) : hhmm(at.getUTCHours(), at.getUTCMinutes())}</time>;
}
