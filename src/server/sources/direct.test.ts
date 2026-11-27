import { createServer, type ServerResponse } from 'node:http';
import { KubeConfig } from '@kubernetes/client-node';
import { afterEach, expect, it } from 'vitest';
import { SHOP, SHOP_LISTED } from '@/model/fixtures/shop';
import type { ClusterResources } from '@/model/types';
import type { RawPod } from '@/model/workloads';
import type { ClusterConfig } from '../registry';
import { directSource } from './direct';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const owned = (kind: string, name: string) => [{ apiVersion: 'apps/v1', kind, name, uid: `${name}-uid`, controller: true }];

/** A pod as the API returns it, built back from the form the source keeps. */
const podJson = (p: RawPod) => ({
  metadata: { name: p.name, namespace: p.namespace, labels: p.labels, resourceVersion: '1', ownerReferences: p.owner && owned(p.owner.kind, p.owner.name) },
  spec: {
    serviceAccountName: p.serviceAccount,
    initContainers: p.mesh === 'sidecar' ? [{ name: 'istio-proxy', restartPolicy: 'Always' }] : [],
    containers: [{ name: 'app', ports: p.ports.map((c) => ({ name: c.name, containerPort: c.port, protocol: c.protocol })) }],
  },
  status: { phase: p.phase },
});

/** The list each path answers with: SHOP, and Calico's DaemonSet. */
const LISTS: Record<string, unknown[]> = {
  '/api/v1/namespaces': SHOP.namespaces.map((n) => ({ metadata: { name: n.name, labels: n.labels, resourceVersion: '1' } })),
  '/api/v1/pods': SHOP_LISTED.pods.map(podJson),
  '/apis/apps/v1/replicasets': SHOP_LISTED.replicaSets.map((r) => ({
    metadata: { name: r.name, namespace: r.namespace, resourceVersion: '1', ownerReferences: r.owner && owned(r.owner.kind, r.owner.name) },
  })),
  '/apis/apps/v1/daemonsets': SHOP_LISTED.daemonSets.map((d) => ({
    metadata: { name: d.name, namespace: d.namespace, resourceVersion: '1' },
    spec: { template: { spec: { containers: d.containers } } },
  })),
  '/apis/batch/v1/jobs': [],
  '/apis/networking.k8s.io/v1/networkpolicies': SHOP.networkPolicies.map(({ apiVersion: _a, kind: _k, ...p }) => p),
};

const json = (res: ServerResponse, status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));

const NP_PATH = '/apis/networking.k8s.io/v1/networkpolicies';

/**
 * An API server that lists SHOP, holds every watch open without events, lists Istio among its API
 * groups, and refuses to list AuthorizationPolicies as RBAC would. `revokeNetworkPolicies` acts as a role
 * edited mid-session: the NetworkPolicies watch ends, and every request for them is refused from then on.
 */
async function fakeApiServer(): Promise<{ url: string; revokeNetworkPolicies: () => void }> {
  const watches: { path: string; res: ServerResponse }[] = [];
  let revoked = false;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/apis')
      return json(res, 200, {
        kind: 'APIGroupList',
        apiVersion: 'v1',
        groups: [{ name: 'security.istio.io', versions: [{ groupVersion: 'security.istio.io/v1', version: 'v1' }], preferredVersion: { groupVersion: 'security.istio.io/v1', version: 'v1' } }],
      });
    if (url.pathname === '/apis/security.istio.io/v1/authorizationpolicies' || (revoked && url.pathname === NP_PATH))
      return json(res, 403, { kind: 'Status', apiVersion: 'v1', status: 'Failure', reason: 'Forbidden', code: 403, message: 'authorizationpolicies.security.istio.io is forbidden' });
    const items = LISTS[url.pathname];
    if (!items) return json(res, 404, { kind: 'Status', apiVersion: 'v1', status: 'Failure', reason: 'NotFound', code: 404 });
    if (url.searchParams.get('watch') === 'true') {
      res.writeHead(200, { 'content-type': 'application/json' }).flushHeaders();
      watches.push({ path: url.pathname, res });
      return;
    }
    json(res, 200, { kind: 'List', apiVersion: 'v1', metadata: { resourceVersion: '1' }, items });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => {
    for (const w of watches) w.res.destroy();
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    revokeNetworkPolicies: () => {
      revoked = true;
      for (const w of watches.filter((x) => x.path === NP_PATH)) w.res.end();
    },
  };
}

const cluster: ClusterConfig = {
  name: 'shop',
  server: 'unused',
  login: { type: 'token', tokenFile: 'unused' },
  istio: { rootNamespace: 'istio-system', trustDomain: 'cluster.local' },
};

async function kubeConfigAt(url: string): Promise<KubeConfig> {
  const kc = new KubeConfig();
  // client-node speaks plain HTTP only with TLS verification off; the fake server has no TLS to verify.
  kc.loadFromClusterAndUser({ name: 'shop', server: url, skipTLSVerify: true }, { name: 'shop' });
  return kc;
}

it('reports a kind it may not read and still loads the others', async () => {
  const kc = await kubeConfigAt((await fakeApiServer()).url);
  const source = directSource(kc, cluster);
  cleanups.unshift(() => source.stop());

  const first = await new Promise<ClusterResources>((resolve, reject) => {
    source.start({ update: (u) => resolve(u.resources), lost: reject }).catch(reject);
  });

  expect({
    readErrors: first.readErrors,
    networkPolicies: first.networkPolicies.length,
    pods: first.pods.length,
    deployments: new Set(first.pods.filter((p) => p.workload.kind === 'Deployment').map((p) => p.workload.name)).size,
    enforcer: first.enforcer,
  }).toStrictEqual({ readErrors: [{ kind: 'authorizationpolicies', reason: 'forbidden' }], networkPolicies: 5, pods: 13, deployments: 7, enforcer: 'Calico' });
});

// A role edited mid-session stops the kind's informer; what it had cached is no longer the cluster's.
it('drops what it held of a kind that becomes forbidden', async () => {
  const api = await fakeApiServer();
  const source = directSource(await kubeConfigAt(api.url), cluster);
  cleanups.unshift(() => source.stop());
  const snapshots: ClusterResources[] = [];
  const revoked = new Promise<ClusterResources>((resolve, reject) => {
    source
      .start({
        update: (u) => {
          snapshots.push(u.resources);
          if (snapshots.length === 1) api.revokeNetworkPolicies();
          if (u.resources.readErrors.some((e) => e.kind === 'networkpolicies')) resolve(u.resources);
        },
        lost: reject,
      })
      .catch(reject);
  });
  const after = await revoked;
  expect({ readErrors: after.readErrors.map((e) => e.kind), networkPolicies: after.networkPolicies.length, before: snapshots[0]?.networkPolicies.length }).toStrictEqual({
    readErrors: ['networkpolicies', 'authorizationpolicies'],
    networkPolicies: 0,
    before: 5,
  });
}, 10_000);
