import { expect, test } from 'vitest';
import { healthBody } from './health';
import { createStore } from './store';

test('healthBody answers starting until the store exists', () => {
  expect(healthBody(undefined)).toStrictEqual({ status: 'starting' });
});

test('healthBody lists every cluster with its state', () => {
  const store = createStore({
    clusters: [
      { name: 'atlas-a', login: { type: 'inCluster' }, istio: { rootNamespace: 'istio-system', trustDomain: 'cluster.local' } },
      {
        name: 'atlas-b',
        server: 'https://172.18.0.3:6443',
        ca: { file: '/var/run/netatlas/clusters/atlas-b/ca.crt' },
        login: { type: 'token', tokenFile: '/var/run/netatlas/clusters/atlas-b/token' },
        istio: { rootNamespace: 'istio-system', trustDomain: 'cluster.local' },
      },
    ],
  });
  store.update('atlas-b', {
    status: { state: 'unreachable', since: new Date('2026-11-27T10:00:00Z'), reason: 'the API server refused the connection' },
  });

  expect(healthBody(store)).toStrictEqual({
    status: 'ok',
    clusters: [
      { name: 'atlas-a', state: 'connecting' },
      { name: 'atlas-b', state: 'unreachable' },
    ],
  });
});
