'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Age } from './Age';

/** The page renders again at most this often, however many changes the clusters send. */
const REFRESH_MS = 2000;
/** The wait before opening a stream the browser gave up on. */
const REOPEN_MS = 5000;

export interface LiveProps {
  /** The cluster whose changes the page follows; every cluster's when absent. */
  readonly cluster?: string;
  readonly state: string;
  readonly age?: { readonly lead: string; readonly at: string };
  readonly renderedAt: string;
}

/**
 * Listens to the change stream (`/api/events`, for one cluster or all of them) and renders the page
 * again from the server when something changed. Changes that arrive within 2 s of a refresh are
 * gathered into one refresh at the end of that window. Only the state is a live region: the age after
 * it changes every second, and a screen reader would read each one out.
 */
export function LiveStatus({ cluster, state, age, renderedAt }: LiveProps) {
  const router = useRouter();
  const [connected, setConnected] = useState(true);
  useEffect(() => {
    let last = 0;
    let pending: ReturnType<typeof setTimeout> | undefined;
    let reopen: ReturnType<typeof setTimeout> | undefined;
    let source: EventSource | undefined;
    const refresh = () => {
      pending = undefined;
      last = Date.now();
      router.refresh();
    };
    const open = (reopened: boolean) => {
      source = new EventSource(cluster ? `/api/events?cluster=${encodeURIComponent(cluster)}` : '/api/events');
      source.addEventListener('change', () => {
        if (pending) return;
        const wait = last + REFRESH_MS - Date.now();
        if (wait <= 0) refresh();
        else pending = setTimeout(refresh, wait);
      });
      source.addEventListener('open', () => {
        setConnected(true);
        // Changes sent while the stream was closed are lost, so the page catches up at once.
        if (reopened) refresh();
      });
      // The browser reconnects by itself after a network error, but gives up for good on an answer
      // other than 200 (a 502 from an ingress while the pod restarts, or 503 before the store exists):
      // "if res's status is not 200 ... fail the connection" (https://html.spec.whatwg.org/multipage/server-sent-events.html).
      source.addEventListener('error', () => {
        setConnected(false);
        if (source?.readyState !== EventSource.CLOSED) return;
        reopen = setTimeout(() => open(true), REOPEN_MS);
      });
    };
    open(false);
    return () => {
      source?.close();
      clearTimeout(pending);
      clearTimeout(reopen);
    };
  }, [cluster, router]);
  return (
    <div className="dot-line">
      <span role="status" className="dot-line">
        <svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10">
          {connected ? <circle cx="5" cy="5" r="5" fill="var(--ok)" /> : <circle cx="5" cy="5" r="4.25" fill="none" stroke="var(--muted)" strokeWidth="1.5" />}
        </svg>
        {connected ? state : 'Not live: reconnecting'}
      </span>
      {connected && age ? (
        <span>
          {' · '}
          {age.lead} <Age at={age.at} renderedAt={renderedAt} style="short" />
        </span>
      ) : null}
    </div>
  );
}
