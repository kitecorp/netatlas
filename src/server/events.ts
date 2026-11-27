import type { Store } from './store';

/** How long a browser waits before it opens the stream again after it drops. */
const RETRY_MS = 3000;
/** A comment line this often keeps proxies and load balancers from closing an idle stream. */
const PING_MS = 25_000;

/**
 * The server-sent events of the store's changes: one `change` event naming the cluster, for one
 * cluster or for all of them (`cluster` null). The page then fetches what it shows again. The stream
 * ends, and stops listening to the store, when `signal` aborts (the browser went away).
 */
export function eventStream(store: Store, cluster: string | null, signal: AbortSignal): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let stop = () => {};
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (text: string) => controller.enqueue(encoder.encode(text));
      send(`retry: ${RETRY_MS}\n\n`);
      const off = store.on((name) => {
        if (cluster === null || name === cluster) send(`event: change\ndata: ${JSON.stringify({ cluster: name })}\n\n`);
      });
      const ping = setInterval(() => send(': ping\n\n'), PING_MS);
      stop = () => {
        off();
        clearInterval(ping);
      };
      const end = () => {
        stop();
        controller.close();
      };
      if (signal.aborted) end();
      else signal.addEventListener('abort', end, { once: true });
    },
    cancel() {
      stop();
    },
  });
}

/** GET /api/events?cluster=: 503 until register() has made the store, 404 for a cluster the registry does not list. */
export function eventsResponse(store: Store | undefined, url: string, signal: AbortSignal): Response {
  if (!store) return new Response('netatlas is starting', { status: 503 });
  const cluster = new URL(url).searchParams.get('cluster');
  if (cluster !== null && !store.clusters.has(cluster)) return new Response(`no cluster named ${cluster}`, { status: 404 });
  return new Response(eventStream(store, cluster, signal), {
    headers: {
      'Content-Type': 'text/event-stream',
      // no-transform keeps compressing proxies from holding events back; X-Accel-Buffering does the same for nginx.
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}
