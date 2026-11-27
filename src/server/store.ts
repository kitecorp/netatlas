import type { ClusterSnapshot } from '@/model/types';
import type { ClusterConfig, Registry } from './registry';

/** One cluster: its registry entry, and what the views read of it (`syncedAt` and `synced` move by reduceSync). */
export interface ClusterEntry extends Omit<ClusterSnapshot, 'name'> {
  readonly config: ClusterConfig;
}

export interface Store {
  readonly clusters: ReadonlyMap<string, ClusterEntry>;
  /** Replaces the cluster's entry with the patch applied, then tells every listener the cluster's name. */
  update(name: string, patch: Partial<Omit<ClusterEntry, 'config'>>): void;
  /** Returns the function that removes the listener. */
  on(fn: (cluster: string) => void): () => void;
}

export function createStore(r: Registry): Store {
  const clusters = new Map<string, ClusterEntry>(
    r.clusters.map((config) => [config.name, { config, status: { state: 'connecting' }, synced: false }]),
  );
  const listeners = new Set<(cluster: string) => void>();
  return {
    clusters,
    update(name, patch) {
      const entry = clusters.get(name);
      if (!entry) throw new Error(`store: no cluster named "${name}"`);
      clusters.set(name, { ...entry, ...patch });
      for (const fn of listeners) fn(name);
    },
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

// The holder lives on globalThis because register() runs from .next/server/instrumentation.js, a
// bundle separate from the route handlers and pages. Next.js 16.4.6 loads this module twice
// (measured): with a module-level variable, /api/health answered `starting` for ever.
const KEY = Symbol.for('netatlas.store');
const holder = globalThis as typeof globalThis & { [KEY]?: Store };

/** The store register() made, or undefined while it has not run. Never starts anything. */
export function getStore(): Store | undefined {
  return holder[KEY];
}

export function initStore(r: Registry): Store {
  if (holder[KEY]) throw new Error('store: already initialized');
  const store = createStore(r);
  holder[KEY] = store;
  return store;
}
