import type { Store } from './store';

export type HealthBody = { status: 'ok'; clusters: { name: string; state: string }[] } | { status: 'starting' };

/** `starting` until register() has made the store; the route answers 503 for it. */
export function healthBody(store?: Store): HealthBody {
  if (!store) return { status: 'starting' };
  return { status: 'ok', clusters: [...store.clusters.values()].map((e) => ({ name: e.config.name, state: e.status.state })) };
}
