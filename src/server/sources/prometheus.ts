import type { Answer } from '@/model/prometheus-answer';
import { trafficQueries, type TrafficQueries } from '@/model/promql';
import { messageOf } from '../message-of';
import type { ClusterConfig } from '../registry';
import type { PrometheusClient } from './prometheus-client';
import type { Source, SourceSink } from './source';

export const TRAFFIC_INTERVAL_MS = 30_000;
export const RECENT_INTERVAL_MS = 600_000;
export const RECENT_RETRY_MS = 120_000;

/** How long the source waits: after a poll ends, after the 24-hour query succeeded, and after it failed. */
export interface Every {
  traffic: number;
  recent: number;
  recentRetry: number;
}

const EVERY: Every = { traffic: TRAFFIC_INTERVAL_MS, recent: RECENT_INTERVAL_MS, recentRetry: RECENT_RETRY_MS };

const isFailed = (a: Answer): a is Extract<Answer, { ok: false }> => !a.ok;

/**
 * Polls one cluster's Prometheus beside the cluster reader, and independent of it: the reader losing
 * its cluster never stops the traffic. Each poll asks the four figure queries in parallel, with the
 * 24-hour query when it is due, and the next poll starts `every.traffic` after the last one ended, so
 * a Prometheus slower than the interval never gets two polls at once. A failure is reported and logged,
 * and the polling goes on, so the source never reports itself lost.
 */
export function prometheusSource(c: ClusterConfig, client: PrometheusClient, every: Every = EVERY): Source {
  const queries = trafficQueries(c.prometheus?.clusterLabel);
  const warn = (text: string) => console.warn(`netatlas: traffic for ${c.name}: ${text}`);
  let timer: NodeJS.Timeout | undefined;
  let abort: AbortController | undefined;
  let polling: Promise<void> | undefined;
  let stopped = true;
  /** When the 24-hour query is next due: at once at first, then after its wait for success or failure. */
  let recentDue = 0;

  async function askFigures(sink: SourceSink, at: Date, signal: AbortSignal) {
    const ask = (k: keyof TrafficQueries) => client.query(queries[k], signal);
    const [requests, requestBytes, responseBytes, closed] = await Promise.all([ask('requests'), ask('requestBytes'), ask('responseBytes'), ask('closed')]);
    if (stopped) return;
    if (requests.ok && requestBytes.ok && responseBytes.ok && closed.ok) {
      const figures = { at, requests: requests.samples, requestBytes: requestBytes.samples, responseBytes: responseBytes.samples, closed: closed.samples };
      sink.update({ kind: 'traffic', poll: { type: 'ok', figures } });
      return;
    }
    // The first failed query, in the order asked, names the poll's failure.
    const failure = [requests, requestBytes, responseBytes, closed].find(isFailed);
    if (!failure) return;
    warn(failure.reason);
    sink.update({ kind: 'traffic', poll: { type: 'failed', at, reason: failure.reason } });
  }

  async function askRecent(sink: SourceSink, at: Date, signal: AbortSignal) {
    const answer = await client.query(queries.recent, signal);
    if (stopped) return;
    recentDue = Date.now() + (answer.ok ? every.recent : every.recentRetry);
    // A failed 24-hour query sends nothing, so the pairs already shown stay.
    if (!answer.ok) warn(`the 24-hour query failed: ${answer.reason}`);
    else sink.update({ kind: 'traffic', poll: { type: 'recent', recent: { at, pairs: answer.samples } } });
  }

  function poll(sink: SourceSink) {
    const controller = new AbortController();
    abort = controller;
    const at = new Date();
    const parts = [askFigures(sink, at, controller.signal)];
    if (at.getTime() >= recentDue) parts.push(askRecent(sink, at, controller.signal));
    // Settled, not all: the next poll waits for both parts to end even when one throws (a listener
    // of the sink), and a throw is logged instead of ending the polling for good.
    polling = Promise.allSettled(parts).then((results) => {
      for (const r of results) if (r.status === 'rejected') warn(`the poll failed: ${messageOf(r.reason)}`);
      if (stopped) return;
      timer = setTimeout(() => poll(sink), every.traffic);
      timer.unref();
    });
  }

  return {
    label: 'Prometheus',
    async start(sink) {
      stopped = false;
      poll(sink);
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      abort?.abort();
      await polling;
    },
  };
}
