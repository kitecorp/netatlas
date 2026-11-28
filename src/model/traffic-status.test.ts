import { describe, expect, it } from 'vitest';
import {
  reduceTraffic,
  trafficNote,
  trafficSourcesLabel,
  type RecentPairs,
  type TrafficFigures,
  type TrafficNote,
  type TrafficPoll,
  type TrafficSnapshot,
} from './traffic-status';
import type { ClusterSnapshot } from './types';

const t1 = new Date('2026-11-28T10:00:00Z');
const t2 = new Date('2026-11-28T10:00:30Z');
const t3 = new Date('2026-11-28T10:01:00Z');
const t4 = new Date('2026-11-28T10:01:30Z');

const REFUSED = 'Prometheus refused the connection';
const STOPPED = 'Prometheus stopped answering';
const DOMAIN = 'cluster.local';

const figures = (at: Date, value: number): TrafficFigures => ({
  at,
  requests: [{ labels: { reporter: 'source', source_workload: 'frontend' }, value }],
  requestBytes: [],
  responseBytes: [],
  closed: [],
});
const F1 = figures(t1, 2.5);
const F4 = figures(t4, 4);
const R1: RecentPairs = { at: t1, pairs: [{ labels: { source_workload: 'frontend', destination_workload: 'cart' }, value: 120 }] };
const R3: RecentPairs = { at: t3, pairs: [] };

const REACHABLE_T1: TrafficSnapshot = { status: { state: 'reachable', since: t1, lastSeen: t1 }, clusterDomain: DOMAIN, figures: F1 };
const UNREACHABLE_T2: TrafficSnapshot = { status: { state: 'unreachable', since: t2, reason: REFUSED, lastSeen: t1 }, clusterDomain: DOMAIN, figures: F1 };

describe('reduceTraffic', () => {
  it.each<[string, TrafficSnapshot, TrafficPoll, TrafficSnapshot]>([
    ['connecting, then ok', { status: { state: 'connecting' }, clusterDomain: DOMAIN }, { type: 'ok', figures: F1 }, REACHABLE_T1],
    ['reachable, then failed', REACHABLE_T1, { type: 'failed', at: t2, reason: REFUSED }, UNREACHABLE_T2],
    [
      'unreachable, then failed again',
      UNREACHABLE_T2,
      { type: 'failed', at: t3, reason: STOPPED },
      { status: { state: 'unreachable', since: t2, reason: STOPPED, lastSeen: t1 }, clusterDomain: DOMAIN, figures: F1 },
    ],
    ['unreachable, then ok', UNREACHABLE_T2, { type: 'ok', figures: F4 }, { status: { state: 'reachable', since: t4, lastSeen: t4 }, clusterDomain: DOMAIN, figures: F4 }],
    // Each poll's figures replace the last ones, also while the source stays reachable.
    ['reachable, then ok again', REACHABLE_T1, { type: 'ok', figures: F4 }, { status: { state: 'reachable', since: t1, lastSeen: t4 }, clusterDomain: DOMAIN, figures: F4 }],
    ['recent while unreachable', { ...UNREACHABLE_T2, recent: R1 }, { type: 'recent', recent: R3 }, { ...UNREACHABLE_T2, recent: R3 }],
    ['recent while connecting', { status: { state: 'connecting' }, clusterDomain: DOMAIN }, { type: 'recent', recent: R1 }, { status: { state: 'connecting' }, clusterDomain: DOMAIN, recent: R1 }],
  ])('reduceTraffic %#: %s', (_name, before, poll, after) => {
    expect(reduceTraffic(before, poll)).toStrictEqual(after);
  });
});

describe('trafficNote', () => {
  it.each<[string, TrafficSnapshot | undefined, TrafficNote]>([
    ['no traffic source', undefined, { kind: 'none', text: 'No traffic source for atlas-a: its registry entry names no Prometheus.' }],
    ['connecting', { status: { state: 'connecting' }, clusterDomain: DOMAIN }, { kind: 'reading' }],
    ['unreachable, with figures', UNREACHABLE_T2, { kind: 'unavailable', since: t2, reason: REFUSED, figuresAt: t1 }],
    ['unreachable, never answered', { status: { state: 'unreachable', since: t2, reason: REFUSED }, clusterDomain: DOMAIN }, { kind: 'unavailable', since: t2, reason: REFUSED }],
    ['reachable', REACHABLE_T1, { kind: 'live' }],
  ])('trafficNote %#: %s', (_name, traffic, expected) => {
    expect(trafficNote('atlas-a', traffic)).toStrictEqual(expected);
  });
});

const cluster = (name: string, traffic?: TrafficSnapshot): ClusterSnapshot => ({ name, status: { state: 'connecting' }, synced: false, ...(traffic && { traffic }) });

describe('trafficSourcesLabel', () => {
  it.each<[string, ClusterSnapshot[], string | null]>([
    ['no cluster names a Prometheus', [cluster('atlas-a'), cluster('atlas-b')], null],
    // atlas-c names no Prometheus, so it is not counted.
    ['two configured, one live', [cluster('atlas-a', REACHABLE_T1), cluster('atlas-b', UNREACHABLE_T2), cluster('atlas-c')], 'Prometheus, 1 of 2'],
  ])('trafficSourcesLabel %#: %s', (_name, clusters, expected) => {
    expect(trafficSourcesLabel(clusters)).toBe(expected);
  });
});
