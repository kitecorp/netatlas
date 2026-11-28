import type { TrafficSnapshot } from '@/model/traffic-status';
import type { ClusterSnapshot } from '@/model/types';
import { messageOf } from './message-of';
import { clusterDomainOf, type ClusterConfig, type Registry } from './registry';

/** One cluster: its registry entry, and what the views read of it (`syncedAt` and `synced` move by reduceSync). */
export interface ClusterEntry extends Omit<ClusterSnapshot, 'name'> {
  readonly config: ClusterConfig;
}

/**
 * What changed: a cluster's own state, or its traffic, which only the pages that show traffic follow. A
 * traffic source that starts or stops answering is a cluster change, since every page counts the
 * sources that answer ("Prometheus, 1 of 1").
 */
export type ChangeKind = 'cluster' | 'traffic';

export interface Store {
  readonly clusters: ReadonlyMap<string, ClusterEntry>;
  /** Replaces the cluster's entry with the patch applied, then tells every listener the cluster's name, as a `cluster` change. */
  update(name: string, patch: Partial<Omit<ClusterEntry, 'config' | 'traffic'>>): void;
  /**
   * Replaces the cluster's traffic, then tells every listener the cluster's name: as a `cluster` change
   * when the source's state changed, else as a `traffic` change.
   */
  updateTraffic(name: string, traffic: TrafficSnapshot): void;
  /** Returns the function that removes the listener. */
  on(fn: (cluster: string, kind: ChangeKind) => void): () => void;
}

/** A cluster's entry before anything was read: connecting, and with a traffic source when it names a Prometheus. */
function firstEntry(config: ClusterConfig): ClusterEntry {
  const traffic: TrafficSnapshot | undefined = config.prometheus && { status: { state: 'connecting' }, clusterDomain: clusterDomainOf(config) };
  return { config, status: { state: 'connecting' }, synced: false, ...(traffic && { traffic }) };
}

export function createStore(r: Registry): Store {
  const clusters = new Map<string, ClusterEntry>(r.clusters.map((config) => [config.name, firstEntry(config)]));
  const listeners = new Set<(cluster: string, kind: ChangeKind) => void>();
  const replace = (name: string, change: (entry: ClusterEntry) => ClusterEntry, kind: ChangeKind) => {
    const entry = clusters.get(name);
    if (!entry) throw new Error(`store: no cluster named "${name}"`);
    clusters.set(name, change(entry));
    // One listener that fails, a page's closed stream, must not keep the others from hearing, nor make the update fail.
    for (const fn of listeners) {
      try {
        fn(name, kind);
      } catch (err) {
        console.warn(`netatlas: a listener of ${name} failed: ${messageOf(err)}`);
      }
    }
  };
  return {
    clusters,
    // Wider than the interface on purpose: its type keeps `config` and `traffic` out only at compile
    // time, and a caller that spreads the entry it read (the runner's reduceSync does) would write back
    // the traffic it read, undoing a traffic update made since. So both are dropped here.
    update(name, patch: Partial<ClusterEntry>) {
      const { config: _config, traffic: _traffic, ...rest } = patch;
      replace(name, (entry) => ({ ...entry, ...rest }), 'cluster');
    },
    updateTraffic(name, traffic) {
      const before = clusters.get(name)?.traffic?.status.state;
      replace(name, (entry) => ({ ...entry, traffic }), before === traffic.status.state ? 'traffic' : 'cluster');
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
