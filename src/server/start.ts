import { kubeConfigFor } from './logins/kubeconfig';
import { loadRegistry, type ClusterConfig } from './registry';
import { createRunner } from './runner';
import { directSource } from './sources/direct';
import { prometheusSource, type Every } from './sources/prometheus';
import { prometheusClient } from './sources/prometheus-client';
import { initStore, type Store } from './store';
import { trafficSink } from './traffic';

/**
 * Starts the cluster's runner and, when its registry entry names a Prometheus, its traffic source
 * beside it. The traffic source does not wait for the runner's probe, and the runner losing its
 * cluster never stops it: the traffic shows even while the API server does not answer.
 */
export function startCluster(c: ClusterConfig, store: Store, every?: Every): { stop(): Promise<void> } {
  const kc = kubeConfigFor(c);
  const runner = createRunner(c, kc, store, directSource(kc, c));
  runner.start();
  const traffic = c.prometheus && prometheusSource(c, prometheusClient(c.prometheus), every);
  void traffic?.start(trafficSink(store, c.name));
  return {
    async stop() {
      await Promise.all([runner.stop(), traffic?.stop()]);
    },
  };
}

/** Reads the registry, makes the store and starts each cluster. A bad registry stops the server. */
export function start(): void {
  const registry = loadRegistry();
  const store = initStore(registry);
  for (const c of registry.clusters) startCluster(c, store);
}
