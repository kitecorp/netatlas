import { expect, it } from 'vitest';
import type { TrafficFigures, TrafficPoll, TrafficSnapshot } from '@/model/traffic-status';
import type { ClusterConfig } from './registry';
import { createStore, type ChangeKind, type ClusterEntry } from './store';
import { trafficSink } from './traffic';

const ISTIO = { rootNamespace: 'istio-system', trustDomain: 'cluster.local' };
const withPrometheus = (name: string, clusterDomain?: string): ClusterConfig => ({
  name,
  login: { type: 'inCluster' },
  istio: ISTIO,
  prometheus: { url: 'http://127.0.0.1:9090', auth: { type: 'none' } },
  ...(clusterDomain && { clusterDomain }),
});

const t1 = new Date('2026-11-28T10:00:00Z');
const FIGURES: TrafficFigures = { at: t1, requests: [{ labels: { reporter: 'source', source_workload: 'frontend' }, value: 12.5 }], requestBytes: [], responseBytes: [], closed: [] };

// The source went from connecting to reachable, a change of state, which every page's Prometheus line shows.
it("a traffic update changes only its cluster's traffic, and notifies", () => {
  const store = createStore({ clusters: [withPrometheus('a'), withPrometheus('b', 'b.example')] });
  const heard: [string, ChangeKind][] = [];
  store.on((cluster, kind) => heard.push([cluster, kind]));

  trafficSink(store, 'b').update({ kind: 'traffic', poll: { type: 'ok', figures: FIGURES } });

  const b = store.clusters.get('b');
  expect({ bTraffic: b?.traffic, bStatus: b?.status, aTraffic: store.clusters.get('a')?.traffic, heard }).toStrictEqual({
    bTraffic: { status: { state: 'reachable', since: t1, lastSeen: t1 }, clusterDomain: 'b.example', figures: FIGURES },
    bStatus: { state: 'connecting' },
    aTraffic: { status: { state: 'connecting' }, clusterDomain: 'cluster.local' },
    heard: [['b', 'cluster']],
  });
});

const t2 = new Date('2026-11-28T10:01:00Z');

// Only the pages that show traffic follow `traffic` changes; every page shows whether the source answers.
it.each<[string, TrafficPoll, [string, ChangeKind][]]>([
  ['new figures, still reachable', { type: 'ok', figures: { ...FIGURES, at: t2 } }, [['b', 'traffic']]],
  ['the 24-hour pairs', { type: 'recent', recent: { at: t2, pairs: [] } }, [['b', 'traffic']]],
  ['a failed poll: the source becomes unreachable', { type: 'failed', at: t2, reason: 'Prometheus refused the connection' }, [['b', 'cluster']]],
])('after a first answer, a poll is a cluster change only when the source changes state %#: %s', (_name, poll, expected) => {
  const store = createStore({ clusters: [withPrometheus('b')] });
  const sink = trafficSink(store, 'b');
  sink.update({ kind: 'traffic', poll: { type: 'ok', figures: FIGURES } });
  const heard: [string, ChangeKind][] = [];
  store.on((cluster, kind) => heard.push([cluster, kind]));

  sink.update({ kind: 'traffic', poll });

  expect(heard).toStrictEqual(expected);
});

it('a cluster update cannot write the traffic or the config', () => {
  const store = createStore({ clusters: [withPrometheus('b', 'b.example')] });
  const live: TrafficSnapshot = { status: { state: 'reachable', since: t1, lastSeen: t1 }, clusterDomain: 'b.example', figures: FIGURES };
  // The runner writes back the whole entry it read (reduceSync spreads it), so the patch carries the
  // traffic as it was before this update, and a config.
  const read = store.clusters.get('b') as ClusterEntry;
  store.updateTraffic('b', live);
  const patch: ClusterEntry = { ...read, config: withPrometheus('b', 'other.example'), synced: true };

  store.update('b', patch);

  expect(store.clusters.get('b')).toStrictEqual({
    config: withPrometheus('b', 'b.example'),
    status: { state: 'connecting' },
    synced: true,
    traffic: { status: { state: 'reachable', since: t1, lastSeen: t1 }, clusterDomain: 'b.example', figures: FIGURES },
  });
});
