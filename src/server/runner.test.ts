import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { ClusterStatus } from '@/model/status';
import { kubeConfigFor } from './logins/kubeconfig';
import type { ClusterConfig } from './registry';
import { createRunner, type Runner } from './runner';
import type { Source } from './sources/source';
import { createStore } from './store';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function tokenClusterAt(port: number): ClusterConfig {
  const dir = mkdtempSync(join(tmpdir(), 'netatlas-runner-'));
  writeFileSync(join(dir, 'token'), 'eyJhbGciOi.fixture\n');
  return {
    name: 'probed',
    server: `https://127.0.0.1:${port}`,
    ca: { data: 'LS0t' },
    login: { type: 'token', tokenFile: join(dir, 'token') },
    istio: { rootNamespace: 'istio-system', trustDomain: 'cluster.local' },
  };
}

/** These clusters never answer, so the runner never starts its source. */
const idleSource: Source = { label: 'none', start: async () => {}, stop: async () => {} };

/** Starts a runner and resolves with the first status after `connecting`, and the seconds it took. */
async function firstStatus(config: ClusterConfig): Promise<{ status: ClusterStatus; seconds: number }> {
  const store = createStore({ clusters: [config] });
  const runner: Runner = createRunner(config, kubeConfigFor(config), store, idleSource);
  const settled = new Promise<ClusterStatus>((resolve) =>
    store.on((name) => {
      const status = store.clusters.get(name)?.status;
      if (status && status.state !== 'connecting') resolve(status);
    }),
  );
  const startedAt = Date.now();
  runner.start();
  cleanups.push(() => runner.stop());
  const status = await settled;
  return { status, seconds: Math.round((Date.now() - startedAt) / 1000) };
}

const reasonOf = (s: ClusterStatus) => ({ state: s.state, reason: s.state === 'unreachable' ? s.reason : undefined });

test('an API server address that refuses the connection is unreachable at once', async () => {
  // A port that was just free and is closed again, so connecting to it is refused.
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));

  const { status, seconds } = await firstStatus(tokenClusterAt(port));

  expect({ ...reasonOf(status), seconds }).toStrictEqual({
    state: 'unreachable',
    reason: 'the API server refused the connection',
    seconds: 0,
  });
});

test('an API server that accepts the connection and never answers is unreachable after one probe', async () => {
  // A TCP listener that takes the connection and stays silent, as a hung API server does.
  const sockets: Socket[] = [];
  const server = createServer((s) => sockets.push(s));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => {
    for (const s of sockets) s.destroy();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const port = (server.address() as { port: number }).port;

  const { status, seconds } = await firstStatus(tokenClusterAt(port));

  expect({ ...reasonOf(status), seconds }).toStrictEqual({
    state: 'unreachable',
    reason: 'the API server stopped answering',
    seconds: 5,
  });
}, 10_000);
