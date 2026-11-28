import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest';
import { ONE_SAMPLE, QUERY_TIMED_OUT } from '@/model/fixtures/prometheus';
import { trafficQueries } from '@/model/promql';
import type { TrafficPoll } from '@/model/traffic-status';
import type { PrometheusAuth, PrometheusConfig } from '../registry';
import { fakePrometheus, secretFile, type FakePrometheus, type Reply } from './fake-prometheus.fixture';
import { prometheusSource, type Every } from './prometheus';
import { prometheusClient, type PrometheusClient } from './prometheus-client';

// Undone last first: a source stops before the fake it reads closes.
const cleanups: (() => Promise<void> | void)[] = [];
let warn: MockInstance<Console['warn']>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  vi.restoreAllMocks();
});

const ISTIO = { rootNamespace: 'istio-system', trustDomain: 'cluster.local' };
const ONE: Reply = { status: 200, body: ONE_SAMPLE };
/** A poll every 50 ms, and the 24-hour query asked again only after 10 s. */
const QUICK: Every = { traffic: 50, recent: 10_000, recentRetry: 10_000 };
/** One poll in a test's time: the next is 10 s away. */
const ONCE: Every = { traffic: 10_000, recent: 10_000, recentRetry: 10_000 };

async function serve(answer: (query: string) => Reply, opts?: { holdMs?: number }): Promise<FakePrometheus> {
  const fake = await fakePrometheus(answer, opts);
  cleanups.push(() => fake.close());
  return fake;
}

/** The real client, made at the source's first query, so a source that cannot be made fails on its own error. */
function clientFor(p: PrometheusConfig): PrometheusClient {
  let client: PrometheusClient | undefined;
  return { query: (promql, signal) => (client ??= prometheusClient(p)).query(promql, signal) };
}

/** Starts cluster `b`'s traffic source against `fake`, and keeps each poll it sends and each loss it reports. */
function start(
  fake: FakePrometheus,
  every: Every,
  opts: { auth?: PrometheusAuth; clusterLabel?: PrometheusConfig['clusterLabel']; onPoll?: (p: TrafficPoll) => void } = {},
) {
  const prometheus: PrometheusConfig = { url: fake.url, auth: opts.auth ?? { type: 'none' }, ...(opts.clusterLabel && { clusterLabel: opts.clusterLabel }) };
  const source = prometheusSource({ name: 'b', login: { type: 'inCluster' }, istio: ISTIO, prometheus }, clientFor(prometheus), every);
  const polls: TrafficPoll[] = [];
  const lost: unknown[] = [];
  const started = source.start({
    update: (u) => {
      if (u.kind !== 'traffic') return;
      polls.push(u.poll);
      opts.onPoll?.(u.poll);
    },
    lost: (err) => lost.push(err),
  });
  let stopping: Promise<void> | undefined;
  const stop = () => (stopping ??= source.stop().then(() => started));
  cleanups.push(stop);
  return { polls, lost, stop };
}

/** The polls of the four figure queries, without the 24-hour query's. */
const figurePolls = (polls: TrafficPoll[]) => polls.filter((p) => p.type !== 'recent');

it('asks the four queries and the 24-hour query, and reports their samples', async () => {
  const fake = await serve(() => ONE);
  const run = start(fake, ONCE);
  await vi.waitFor(() => expect(run.polls).toHaveLength(2));
  await run.stop();

  const ok = run.polls.find((p) => p.type === 'ok');
  expect({
    queries: fake.seen.map((r) => r.query).sort(),
    polls: run.polls.map((p) => p.type).sort(),
    requests: ok?.type === 'ok' ? ok.figures.requests : undefined,
  }).toStrictEqual({
    queries: Object.values(trafficQueries()).sort(),
    polls: ['ok', 'recent'],
    requests: [{ labels: { reporter: 'source', source_workload: 'frontend' }, value: 12.5 }],
  });
});

it("a cluster label picks the cluster's own series out of a shared Prometheus", async () => {
  const fake = await serve(() => ONE);
  const run = start(fake, ONCE, { clusterLabel: { name: 'cluster', value: 'b' } });
  await vi.waitFor(() => expect(run.polls).toHaveLength(2));
  await run.stop();

  // The requests query, as the fake received it.
  expect(fake.seen.map((r) => r.query).filter((q) => q?.includes('(rate(istio_requests_total'))).toStrictEqual([
    'sum by (reporter, source_workload, source_workload_namespace, source_cluster, destination_workload, destination_workload_namespace, destination_service, destination_service_name, destination_cluster, response_code, response_flags) (rate(istio_requests_total{reporter=~"source|destination", cluster="b"}[5m])) > 0',
  ]);
});

it('a failed query fails the poll, and the next poll recovers', async () => {
  let closedAsked = 0;
  const fake = await serve((query) => (query === trafficQueries().closed && ++closedAsked === 1 ? { status: 503, body: QUERY_TIMED_OUT } : ONE));
  const run = start(fake, QUICK);
  await vi.waitFor(() => expect(figurePolls(run.polls).length).toBeGreaterThanOrEqual(2));
  await run.stop();

  expect({
    polls: figurePolls(run.polls)
      .slice(0, 2)
      .map((p) => (p.type === 'failed' ? [p.type, p.reason] : [p.type])),
    lost: run.lost,
  }).toStrictEqual({
    polls: [['failed', 'Prometheus refused the query: timeout: query timed out in expression evaluation'], ['ok']],
    lost: [],
  });
});

it('a poll never starts while the previous one runs', async () => {
  // Each answer takes longer than the 50 ms between polls.
  const fake = await serve(() => ONE, { holdMs: 300 });
  const run = start(fake, QUICK);
  await sleep(1000);
  await run.stop();

  // The first poll's four queries and the 24-hour one.
  expect(fake.mostInFlight).toBe(5);
});

it('a failed 24-hour query keeps the old pairs and is asked again after the retry wait', async () => {
  const recent: string[] = [];
  const fake = await serve((query) => {
    if (query !== trafficQueries().recent) return ONE;
    recent.push('asked');
    return recent.length === 1 ? { status: 503, body: QUERY_TIMED_OUT } : ONE;
  });
  const run = start(fake, { traffic: 50, recent: 10_000, recentRetry: 300 }, { onPoll: (p) => p.type === 'recent' && recent.push('sent') });
  await sleep(200);
  const at200 = recent.filter((r) => r === 'asked').length;
  await sleep(500);
  const at700 = recent.filter((r) => r === 'asked').length;
  await run.stop();

  expect({ at200, at700, recent, polls: [...new Set(figurePolls(run.polls).map((p) => p.type))] }).toStrictEqual({
    at200: 1,
    at700: 2,
    // A failed 24-hour query sends nothing, so the pairs already shown stay.
    recent: ['asked', 'asked', 'sent'],
    polls: ['ok'],
  });
});

it('stop ends the polling', async () => {
  // A poll is still waiting for its answers when stop comes.
  const fake = await serve(() => ONE, { holdMs: 300 });
  const run = start(fake, QUICK);
  await vi.waitFor(() => expect(fake.seen).toHaveLength(5));
  await run.stop();
  const atStop = fake.seen.length;
  await sleep(200);

  // Stop aborts the five queries in flight, and no poll follows.
  expect({ after: fake.seen.slice(atStop), abandoned: fake.abandoned }).toStrictEqual({ after: [], abandoned: 5 });
});

it('a refused poll logs the reason and no credential', async () => {
  const fake = await serve(() => ({ status: 401, body: 'Unauthorized\n' }));
  const run = start(fake, ONCE, { auth: { type: 'bearer', tokenFile: secretFile('token', 'prom-token-fixture\n') } });
  await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(2));
  await run.stop();

  expect([...warn.mock.calls].sort()).toStrictEqual([
    ["netatlas: traffic for b: Prometheus did not accept netatlas's credentials"],
    ["netatlas: traffic for b: the 24-hour query failed: Prometheus did not accept netatlas's credentials"],
  ]);
});

// Kept last: if the polling broke, the stop below would reject and the cleanups after it would not run.
it('a listener that throws is logged, and the next poll still comes', async () => {
  vi.useFakeTimers();
  cleanups.push(() => {
    vi.useRealTimers();
  });
  // Every query answers at once with no samples, so the polls move only with the fake clock.
  const client: PrometheusClient = { query: async () => ({ ok: true, samples: [] }) };
  const source = prometheusSource({ name: 'b', login: { type: 'inCluster' }, istio: ISTIO, prometheus: { url: 'http://127.0.0.1:2', auth: { type: 'none' } } }, client, QUICK);
  const heard: TrafficPoll['type'][] = [];
  const lost: unknown[] = [];
  await source.start({
    update: (u) => {
      if (u.kind !== 'traffic') return;
      heard.push(u.poll.type);
      if (heard.length === 1) throw new Error('a listener failed');
    },
    lost: (err) => lost.push(err),
  });
  cleanups.push(() => source.stop());
  await vi.advanceTimersByTimeAsync(0);
  const firstPoll = heard.length;
  await vi.advanceTimersByTimeAsync(QUICK.traffic);

  expect({ firstPoll: heard.slice(0, firstPoll).sort(), nextPoll: heard.slice(firstPoll), warned: warn.mock.calls, lost }).toStrictEqual({
    // The first poll's figures and its 24-hour pairs, the first of them thrown on.
    firstPoll: ['ok', 'recent'],
    // The 24-hour query is not due again for 10 s.
    nextPoll: ['ok'],
    warned: [['netatlas: traffic for b: the poll failed: a listener failed']],
    lost: [],
  });
});
