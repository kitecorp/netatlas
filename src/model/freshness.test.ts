import { describe, expect, it } from 'vitest';
import { ago } from './fixtures/clusters';
import { allClustersLabel, clusterLabel, freshness, reduceSync, type SyncEvent } from './freshness';
import type { ClusterSnapshot } from './types';

const REACHABLE = { state: 'reachable', since: ago(3_600_000), lastSeen: ago(1_000), kubernetesVersion: 'v1.37.0' } as const;
const UNREACHABLE = { state: 'unreachable', since: ago(60_000), reason: 'the API server stopped answering', lastSeen: ago(75_000) } as const;
const at = ago(180_000);

it.each<[string, Pick<ClusterSnapshot, 'status' | 'syncedAt' | 'synced'>, ReturnType<typeof freshness>]>([
  ['nothing read yet', { status: { state: 'connecting' }, synced: false }, { kind: 'none' }],
  ['answering, with the reader holding the current state', { status: REACHABLE, syncedAt: at, synced: true }, { kind: 'live', at }],
  // A reader that stopped (a list failing with 503, or the first list after an outage) holds old data.
  ['answering, while the reader starts again', { status: REACHABLE, syncedAt: at, synced: false }, { kind: 'reading', at }],
  ['answering, never read', { status: REACHABLE, synced: false }, { kind: 'none' }],
  ['not answering, with old data', { status: UNREACHABLE, syncedAt: at, synced: false }, { kind: 'unreachable', at }],
  ['not answering, never read', { status: UNREACHABLE, synced: false }, { kind: 'none' }],
])('freshness %#: %s', (_name, c, expected) => {
  expect(freshness(c)).toStrictEqual(expected);
});

it.each<[string, Pick<ClusterSnapshot, 'status' | 'syncedAt' | 'synced'>, ReturnType<typeof clusterLabel>]>([
  ['live', { status: REACHABLE, syncedAt: at, synced: true }, { state: 'Live', age: { lead: 'updated', at } }],
  ['reading', { status: REACHABLE, syncedAt: at, synced: false }, { state: 'Reading again', age: { lead: 'data from', at } }],
  ['unreachable', { status: UNREACHABLE, syncedAt: at, synced: false }, { state: 'Not live', age: { lead: 'data from', at } }],
  ['connecting', { status: { state: 'connecting' }, synced: false }, { state: 'Connecting' }],
  ['unreachable, never read', { status: UNREACHABLE, synced: false }, { state: 'Not live' }],
])('clusterLabel %#: %s', (_name, c, expected) => {
  expect(clusterLabel(c)).toStrictEqual(expected);
});

it('counts the clusters that answer on pages of every cluster', () => {
  expect([allClustersLabel(2, 3), allClustersLabel(1, 1)]).toStrictEqual([{ state: 'Live · 2 of 3 clusters' }, { state: 'Live · 1 of 1 cluster' }]);
});

describe('reduceSync', () => {
  const t = (s: number) => ago(-s * 1000);
  const live = { status: { ...REACHABLE, lastSeen: t(0) }, syncedAt: t(0), synced: true } as const;
  it.each<[string, Pick<ClusterSnapshot, 'status' | 'syncedAt' | 'synced'>, SyncEvent, Pick<ClusterSnapshot, 'status' | 'syncedAt' | 'synced'>]>([
    ['a snapshot holds the cluster now', { status: { state: 'connecting' }, synced: false }, { type: 'snapshot', at: t(1) }, { status: { state: 'connecting' }, syncedAt: t(1), synced: true }],
    ['an answer while the reader holds the cluster keeps the data current', live, { type: 'ok', at: t(15), kubernetesVersion: 'v1.37.0' }, { status: { ...REACHABLE, lastSeen: t(15) }, syncedAt: t(15), synced: true }],
    [
      'an answer while the reader starts again leaves the data as old as it is',
      { ...live, synced: false },
      { type: 'ok', at: t(15), kubernetesVersion: 'v1.37.0' },
      { status: { ...REACHABLE, lastSeen: t(15) }, syncedAt: t(0), synced: false },
    ],
    ['a reader that stopped holds the cluster no longer', live, { type: 'reader-stopped' }, { ...live, synced: false }],
    [
      'a failed probe stops the reader and keeps the age of the data',
      live,
      { type: 'failed', at: t(15), reason: 'the API server stopped answering' },
      { status: { state: 'unreachable', since: t(15), reason: 'the API server stopped answering', lastSeen: t(0) }, syncedAt: t(0), synced: false },
    ],
  ])('reduceSync %#: %s', (_name, before, event, after) => {
    expect(reduceSync(before, event)).toStrictEqual(after);
  });
});
