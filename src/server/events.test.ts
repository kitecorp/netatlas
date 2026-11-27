import { afterEach, expect, it, vi } from 'vitest';
import { eventsResponse, eventStream } from './events';
import type { ClusterConfig } from './registry';
import { createStore, type Store } from './store';

const config = (name: string): ClusterConfig => ({ name, login: { type: 'inCluster' }, istio: { rootNamespace: 'istio-system', trustDomain: 'cluster.local' } });
const twoClusters = (): Store => createStore({ clusters: [config('atlas-a'), config('atlas-b')] });

afterEach(() => {
  vi.useRealTimers();
});

it.each<[string, string | null, string]>([
  ['one cluster sends only its own changes', 'atlas-a', 'retry: 3000\n\nevent: change\ndata: {"cluster":"atlas-a"}\n\n'],
  ['all clusters send every change', null, 'retry: 3000\n\nevent: change\ndata: {"cluster":"atlas-b"}\n\nevent: change\ndata: {"cluster":"atlas-a"}\n\n'],
])('eventStream %#: %s, and stops listening once aborted', async (_name, cluster, expected) => {
  const store = twoClusters();
  const abort = new AbortController();
  const stream = eventStream(store, cluster, abort.signal);
  store.update('atlas-b', { synced: true });
  store.update('atlas-a', { synced: true });
  abort.abort();
  // A listener left behind would write to the closed stream and throw here.
  store.update('atlas-a', { synced: false });
  expect(await new Response(stream).text()).toBe(expected);
});

it('sends a ping every 25 s, so proxies keep the connection open', async () => {
  vi.useFakeTimers();
  const abort = new AbortController();
  const stream = eventStream(twoClusters(), null, abort.signal);
  vi.advanceTimersByTime(50_000);
  abort.abort();
  vi.advanceTimersByTime(25_000);
  expect(await new Response(stream).text()).toBe('retry: 3000\n\n: ping\n\n: ping\n\n');
});

it.each<[string, Store | undefined, string, (string | number | null)[]]>([
  ['one known cluster streams', twoClusters(), 'http://netatlas.test/api/events?cluster=atlas-a', [200, 'text/event-stream', 'no-cache, no-transform', 'no']],
  ['no cluster streams them all', twoClusters(), 'http://netatlas.test/api/events', [200, 'text/event-stream', 'no-cache, no-transform', 'no']],
  ['an unknown cluster is not found', twoClusters(), 'http://netatlas.test/api/events?cluster=atlas-z', [404, 'text/plain;charset=UTF-8', null, null]],
  ['before register() has made the store', undefined, 'http://netatlas.test/api/events', [503, 'text/plain;charset=UTF-8', null, null]],
])('GET /api/events %#: %s', (_name, store, url, expected) => {
  const abort = new AbortController();
  const res = eventsResponse(store, url, abort.signal);
  abort.abort();
  expect([res.status, res.headers.get('Content-Type'), res.headers.get('Cache-Control'), res.headers.get('X-Accel-Buffering')]).toStrictEqual(expected);
});
