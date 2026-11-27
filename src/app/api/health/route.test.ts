import { expect, test } from 'vitest';
import { initStore } from '@/server/store';
import { GET } from './route';

const registry = {
  clusters: [{ name: 'atlas-a', login: { type: 'inCluster' as const }, istio: { rootNamespace: 'istio-system', trustDomain: 'cluster.local' } }],
};

// One test, because the store lives on globalThis for the whole worker and initStore runs once.
test('GET /api/health answers 503 until register() has made the store, then 200, and the store is made once', async () => {
  const before = GET();
  initStore(registry);
  const after = GET();

  expect([before.status, await before.json(), after.status, await after.json()]).toStrictEqual([
    503,
    { status: 'starting' },
    200,
    { status: 'ok', clusters: [{ name: 'atlas-a', state: 'connecting' }] },
  ]);
  expect(() => initStore(registry)).toThrow(new Error('store: already initialized'));
});
