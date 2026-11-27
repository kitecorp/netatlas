import { reduceStatus, type ProbeEvent } from './status';
import type { ClusterSnapshot } from './types';

/** How current a cluster's data is. Every age counts from `syncedAt`, so no two pages disagree. */
export type Freshness =
  | { readonly kind: 'none' }
  | { readonly kind: 'live'; readonly at: Date }
  /** The cluster answers, but its reader is starting again, so the data is as old as `at`. */
  | { readonly kind: 'reading'; readonly at: Date }
  | { readonly kind: 'unreachable'; readonly at: Date };

type Synced = Pick<ClusterSnapshot, 'status' | 'syncedAt' | 'synced'>;

/** What moves a cluster's status and the age of its data: a probe, a snapshot from the reader, or the reader stopping. */
export type SyncEvent = ProbeEvent | { readonly type: 'snapshot'; readonly at: Date } | { readonly type: 'reader-stopped' };

/**
 * The data is current while the reader holds the cluster, so each snapshot and each answer of the API
 * server in that time renews `syncedAt`. Once the reader stops, or the API server stops answering, the
 * age is frozen and grows on every page alike.
 */
export function reduceSync(c: Synced, e: SyncEvent): Synced {
  switch (e.type) {
    case 'snapshot':
      return { ...c, syncedAt: e.at, synced: true };
    case 'reader-stopped':
      return { ...c, synced: false };
    case 'ok':
      return { ...c, status: reduceStatus(c.status, e), ...(c.synced ? { syncedAt: e.at } : {}) };
    case 'failed':
      return { ...c, status: reduceStatus(c.status, e), synced: false };
  }
}

export function freshness(c: Synced): Freshness {
  if (!c.syncedAt) return { kind: 'none' };
  if (c.status.state === 'unreachable') return { kind: 'unreachable', at: c.syncedAt };
  return c.synced ? { kind: 'live', at: c.syncedAt } : { kind: 'reading', at: c.syncedAt };
}

/**
 * What the header's status says. `state` is the part a screen reader announces when it changes; the
 * age after it changes every second, so it stays outside that live region.
 */
export interface LiveLabel {
  readonly state: string;
  readonly age?: { readonly lead: string; readonly at: Date };
}

export function clusterLabel(c: Synced): LiveLabel {
  const f = freshness(c);
  switch (f.kind) {
    case 'live':
      return { state: 'Live', age: { lead: 'updated', at: f.at } };
    case 'reading':
      return { state: 'Reading again', age: { lead: 'data from', at: f.at } };
    case 'unreachable':
      return { state: 'Not live', age: { lead: 'data from', at: f.at } };
    case 'none':
      return { state: c.status.state === 'unreachable' ? 'Not live' : 'Connecting' };
  }
}

export const allClustersLabel = (reachable: number, clusters: number): LiveLabel => ({ state: `Live · ${reachable} of ${clusters} ${clusters === 1 ? 'cluster' : 'clusters'}` });
