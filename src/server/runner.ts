import { Observable, VersionApi, type KubeConfig, type ObservableMiddleware } from '@kubernetes/client-node';
import { reduceSync, type SyncEvent } from '@/model/freshness';
import { nextRetryDelay, PROBE_INTERVAL_MS, PROBE_TIMEOUT_CODE, PROBE_TIMEOUT_MS, unreachableReason, type ProbeEvent } from '@/model/status';
import type { ClusterConfig } from './registry';
import type { Source, SourceSink, SourceUpdate } from './sources/source';
import type { Store } from './store';

/** Hands the probe's signal to the request, so an abort ends a request the server never answers. */
function abortOn(signal: AbortSignal): ObservableMiddleware {
  return {
    pre: (ctx) => {
      ctx.setSignal(signal);
      return new Observable(Promise.resolve(ctx));
    },
    post: (ctx) => new Observable(Promise.resolve(ctx)),
  };
}

export interface Runner {
  start(): void;
  stop(): Promise<void>;
}

/**
 * Probes one cluster's API server for its version and keeps the cluster's status in the store:
 * every 15 s while it answers, and after a growing wait while it does not. The source reads the
 * cluster while it answers and stops when it does not; the store keeps its last resources meanwhile.
 */
export function createRunner(c: ClusterConfig, kc: KubeConfig, store: Store, source: Source): Runner {
  const api = kc.makeApiClient(VersionApi);
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | undefined;
  let abort: AbortController | undefined;
  let failures = 0;
  let stopped = false;
  let reading = false;

  /** Moves the cluster's status and the age of its data in the store, with `resources` when a snapshot brings them. */
  const sync = (e: SyncEvent, resources?: SourceUpdate['resources']) => {
    const entry = store.clusters.get(c.name);
    if (entry) store.update(c.name, { ...reduceSync(entry, e), ...(resources ? { resources } : {}) });
  };

  const sink: SourceSink = {
    update: (u) => sync({ type: 'snapshot', at: u.at }, u.resources),
    // A lost source starts again after the next probe that finds the cluster answering.
    lost: (err) => {
      console.warn(`netatlas: cluster ${c.name}: ${source.label} stopped: ${err instanceof Error ? err.message : String(err)}`);
      void stopSource();
    },
  };

  function startSource() {
    if (reading) return;
    reading = true;
    source.start(sink).catch(sink.lost);
  }

  async function stopSource() {
    if (!reading) return;
    reading = false;
    // The data stops being current now, whatever the stop waits for.
    sync({ type: 'reader-stopped' });
    await source.stop();
  }

  async function probe(): Promise<ProbeEvent> {
    const controller = new AbortController();
    abort = controller;
    // An API server that takes the connection and never answers would hold the probe forever, and the
    // cluster would never leave its last state, so the probe gives up after 5 s.
    const timeout = setTimeout(
      () => controller.abort(Object.assign(new Error('the probe timed out'), { code: PROBE_TIMEOUT_CODE })),
      PROBE_TIMEOUT_MS,
    );
    timeout.unref();
    try {
      const version = await api.getCode({}, { middleware: [abortOn(controller.signal)], middlewareMergeStrategy: 'append' });
      return { type: 'ok', at: new Date(), kubernetesVersion: version.gitVersion };
    } catch (err) {
      return { type: 'failed', at: new Date(), reason: unreachableReason(controller.signal.reason ?? err) };
    } finally {
      clearTimeout(timeout);
    }
  }

  function schedule(delay: number) {
    if (stopped) return;
    timer = setTimeout(run, delay);
    timer.unref();
  }

  function run() {
    inFlight = probe().then((event) => {
      if (stopped) return;
      sync(event);
      if (event.type === 'ok') startSource();
      else void stopSource();
      failures = event.type === 'ok' ? 0 : failures + 1;
      schedule(event.type === 'ok' ? PROBE_INTERVAL_MS : nextRetryDelay(failures));
    });
  }

  return {
    start() {
      stopped = false;
      run();
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      abort?.abort();
      await inFlight;
      await stopSource();
    },
  };
}
