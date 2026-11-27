'use client';

import { useEffect, useState } from 'react';
import { formatAge } from '@/model/format';

/**
 * How long ago `at` was, kept current in the browser. The server renders the age at `renderedAt`, and
 * the browser adds the time since it showed the page, never its own clock, which may differ from the
 * server's. Both renders start from the same text, so hydration agrees. The time counted belongs to
 * one render, so a new render from the server starts again from its own age.
 */
export function Age({ at, renderedAt, style }: { at: string; renderedAt: string; style: 'short' | 'long' }) {
  const base = new Date(renderedAt).getTime() - new Date(at).getTime();
  const [tick, setTick] = useState({ from: renderedAt, elapsed: 0 });
  useEffect(() => {
    const shown = performance.now();
    const timer = setInterval(() => setTick({ from: renderedAt, elapsed: performance.now() - shown }), 1000);
    return () => clearInterval(timer);
  }, [at, renderedAt]);
  const elapsed = tick.from === renderedAt ? tick.elapsed : 0;
  return <time dateTime={at}>{formatAge(base + elapsed, style)}</time>;
}
