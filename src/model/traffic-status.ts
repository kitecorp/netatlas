import type { PromSample } from './prometheus-answer';
import { reduceStatus, type SourceStatus } from './status';
import type { ClusterSnapshot } from './types';

/** The answers of one poll's four figure queries, and when the poll asked them. */
export interface TrafficFigures {
  readonly at: Date;
  readonly requests: readonly PromSample[];
  readonly requestBytes: readonly PromSample[];
  readonly responseBytes: readonly PromSample[];
  readonly closed: readonly PromSample[];
}

/** The pairs of workloads that called each other in the last 24 hours. */
export interface RecentPairs {
  readonly at: Date;
  readonly pairs: readonly PromSample[];
}

export type TrafficPoll =
  | { readonly type: 'ok'; readonly figures: TrafficFigures }
  | { readonly type: 'failed'; readonly at: Date; readonly reason: string }
  | { readonly type: 'recent'; readonly recent: RecentPairs };

/** A cluster's traffic source: whether its Prometheus answers, and the last figures and pairs it gave. */
export interface TrafficSnapshot {
  readonly status: SourceStatus;
  readonly clusterDomain: string;
  readonly figures?: TrafficFigures;
  readonly recent?: RecentPairs;
}

export type TrafficNote =
  | { readonly kind: 'none'; readonly text: string }
  | { readonly kind: 'reading' }
  | { readonly kind: 'unavailable'; readonly since: Date; readonly reason: string; readonly figuresAt?: Date }
  | { readonly kind: 'live' };

/**
 * Moves a cluster's traffic by one poll. Each ok poll's figures replace the last ones; a failed poll
 * keeps them, so the page goes on showing them with their age. The 24-hour pairs move on their own.
 */
export function reduceTraffic(t: TrafficSnapshot, p: TrafficPoll): TrafficSnapshot {
  switch (p.type) {
    case 'ok':
      return { ...t, status: reduceStatus(t.status, { type: 'ok', at: p.figures.at }), figures: p.figures };
    case 'failed':
      return { ...t, status: reduceStatus(t.status, { type: 'failed', at: p.at, reason: p.reason }) };
    case 'recent':
      return { ...t, recent: p.recent };
  }
}

/** What a page says about a cluster's traffic source; the component turns `unavailable` into its sentence. */
export function trafficNote(cluster: string, t: TrafficSnapshot | undefined): TrafficNote {
  if (!t) return { kind: 'none', text: `No traffic source for ${cluster}: its registry entry names no Prometheus.` };
  switch (t.status.state) {
    case 'connecting':
      return { kind: 'reading' };
    case 'unreachable':
      return { kind: 'unavailable', since: t.status.since, reason: t.status.reason, ...(t.figures && { figuresAt: t.figures.at }) };
    case 'reachable':
      return { kind: 'live' };
  }
}

/** The frame's line about traffic sources: how many of the clusters that name a Prometheus answer now. */
export function trafficSourcesLabel(clusters: readonly ClusterSnapshot[]): string | null {
  const configured = clusters.flatMap((c) => (c.traffic ? [c.traffic] : []));
  if (configured.length === 0) return null;
  return `Prometheus, ${configured.filter((t) => t.status.state === 'reachable').length} of ${configured.length}`;
}
