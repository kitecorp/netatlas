import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, expect, it } from 'vitest';
import { ONE_SAMPLE } from '@/model/fixtures/prometheus';
import type { ClusterConfig } from './registry';
import { fakePrometheus, secretFile } from './sources/fake-prometheus.fixture';
import { startCluster } from './start';
import { createStore } from './store';

// Undone last first: the cluster stops before the fake Prometheus closes.
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

it('the traffic source keeps running when the cluster reader fails', async () => {
  const fake = await fakePrometheus(() => ({ status: 200, body: ONE_SAMPLE }));
  cleanups.push(() => fake.close());
  // A token cluster, as runner.test.ts builds one, whose API server refuses the connection.
  const c: ClusterConfig = {
    name: 'b',
    server: 'https://127.0.0.1:2',
    ca: { data: 'LS0t' },
    login: { type: 'token', tokenFile: secretFile('token', 'cluster-token-fixture\n') },
    istio: { rootNamespace: 'istio-system', trustDomain: 'cluster.local' },
    prometheus: { url: fake.url, auth: { type: 'none' } },
  };
  const store = createStore({ clusters: [c] });

  const cluster = startCluster(c, store, { traffic: 50, recent: 10_000, recentRetry: 10_000 });
  cleanups.push(() => cluster.stop());
  await sleep(500);

  const entry = store.clusters.get('b');
  const status = entry?.status;
  // More than two polls' four queries: the polling went on after the API server refused.
  expect([status?.state, status?.state === 'unreachable' ? status.reason : undefined, entry?.traffic?.status.state, fake.seen.length > 8]).toStrictEqual([
    'unreachable',
    'the API server refused the connection',
    'reachable',
    true,
  ]);
});
