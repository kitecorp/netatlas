import { kubeConfigFor } from './logins/kubeconfig';
import { loadRegistry } from './registry';
import { createRunner } from './runner';
import { directSource } from './sources/direct';
import { initStore } from './store';

/** Reads the registry, makes the store and starts one runner per cluster. A bad registry stops the server. */
export function start(): void {
  const registry = loadRegistry();
  const store = initStore(registry);
  for (const c of registry.clusters) {
    const kc = kubeConfigFor(c);
    createRunner(c, kc, store, directSource(kc, c)).start();
  }
}
