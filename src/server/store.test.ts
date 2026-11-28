import { expect, it } from 'vitest';
import { createStore, type ChangeKind } from './store';

const ISTIO = { rootNamespace: 'istio-system', trustDomain: 'cluster.local' };

// A page's stream that fails must not stop the other pages hearing of the change, nor make the update look failed.
it('tells every listener of a change, even when one before it throws', () => {
  const store = createStore({ clusters: [{ name: 'b', login: { type: 'inCluster' }, istio: ISTIO }] });
  const heard: [string, ChangeKind][] = [];
  store.on(() => {
    throw new Error('the stream is closed');
  });
  store.on((cluster, kind) => heard.push([cluster, kind]));

  const outcome = (() => {
    try {
      store.update('b', { synced: true });
      return 'updated';
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  })();

  expect({ outcome, heard, synced: store.clusters.get('b')?.synced }).toStrictEqual({ outcome: 'updated', heard: [['b', 'cluster']], synced: true });
});
