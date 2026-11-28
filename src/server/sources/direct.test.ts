import { createServer, type ServerResponse } from 'node:http';
import { KubeConfig } from '@kubernetes/client-node';
import { afterEach, expect, it } from 'vitest';
import { SHOP, SHOP_LISTED } from '@/model/fixtures/shop';
import type { ClusterResources, MeshSettings } from '@/model/types';
import type { RawPod } from '@/model/workloads';
import type { ClusterConfig } from '../registry';
import { directSource } from './direct';
import type { SourceUpdate } from './source';

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
const SIDECARS_PATH = '/apis/networking.istio.io/v1/sidecars';
const MESH_CONFIG_PATH = '/api/v1/namespaces/istio-system/configmaps';
/** The one ConfigMap the reader role names, which RBAC lets a list or watch read only with this selector. */
const MESH_CONFIG_SELECTOR = 'metadata.name=istio';

/** What the networking.istio.io group adds: a ServiceEntry with a field client-node's typed serializer would drop, and the mesh config. */
const NETWORKING_LISTS: Record<string, unknown[]> = {
  '/apis/networking.istio.io/v1/serviceentries': [
    {
      metadata: { name: 'partner-api', namespace: 'shop', resourceVersion: '1' },
      spec: { hosts: ['api.partner.example'], ports: [{ number: 443, name: 'tls', protocol: 'TLS' }], location: 'MESH_EXTERNAL', resolution: 'DNS', subjectAltNames: ['spiffe://x'] },
    },
  ],
  [MESH_CONFIG_PATH]: [{ metadata: { name: 'istio', namespace: 'istio-system', resourceVersion: '1' }, data: { mesh: 'outboundTrafficPolicy:\n  mode: REGISTRY_ONLY\n' } }],
};

const group = (name: string) => ({ name, versions: [{ groupVersion: `${name}/v1`, version: 'v1' }], preferredVersion: { groupVersion: `${name}/v1`, version: 'v1' } });

const forbidden = (res: ServerResponse, path: string) =>
  json(res, 403, { kind: 'Status', apiVersion: 'v1', status: 'Failure', reason: 'Forbidden', code: 403, message: `${path} is forbidden` });

/**
 * An API server that lists SHOP, holds every watch open without events, lists Istio among its API
 * groups, and refuses to list AuthorizationPolicies and ConfigMaps as RBAC would; it lets a request
 * read the ConfigMap `istio` only by its name. `networking` adds the networking.istio.io group, whose
 * Sidecars it refuses. `configMaps` replaces what a read of `istio` by name lists, with or without
 * `networking` (the source reads the mesh config only while that group is served), or refuses every
 * configmaps request with 'forbidden'. `revokeNetworkPolicies` acts as a role edited mid-session: the
 * NetworkPolicies watch ends, and every request for them is refused from then on.
 */
async function fakeApiServer({ networking = false, configMaps }: { networking?: boolean; configMaps?: 'forbidden' | unknown[] } = {}): Promise<{
  url: string;
  revokeNetworkPolicies: () => void;
}> {
  const watches: { path: string; res: ServerResponse }[] = [];
  const lists: Record<string, unknown[]> = { ...LISTS, ...(networking && NETWORKING_LISTS), ...(Array.isArray(configMaps) && { [MESH_CONFIG_PATH]: configMaps }) };
  let revoked = false;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/apis')
      return json(res, 200, { kind: 'APIGroupList', apiVersion: 'v1', groups: [group('security.istio.io'), ...(networking ? [group('networking.istio.io')] : [])] });
    const byName = url.pathname === MESH_CONFIG_PATH && url.searchParams.get('fieldSelector') === MESH_CONFIG_SELECTOR;
    if (
      url.pathname === '/apis/security.istio.io/v1/authorizationpolicies' ||
      (networking && url.pathname === SIDECARS_PATH) ||
      (url.pathname.endsWith('/configmaps') && (!byName || configMaps === 'forbidden')) ||
      (revoked && url.pathname === NP_PATH)
    )
      return forbidden(res, url.pathname);
    const items = lists[url.pathname];
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

/** The resources an update carries: the direct source sends no other kind of update. */
function resourcesOf(u: SourceUpdate): ClusterResources {
  if (u.kind !== 'resources') throw new Error(`the direct source sent a ${u.kind} update`);
  return u.resources;
}

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
    source.start({ update: (u) => resolve(resourcesOf(u)), lost: reject }).catch(reject);
  });

  expect({
    readErrors: first.readErrors,
    networkPolicies: first.networkPolicies.length,
    pods: first.pods.length,
    deployments: new Set(first.pods.filter((p) => p.workload.kind === 'Deployment').map((p) => p.workload.name)).size,
    enforcer: first.enforcer,
    // The fake lists no networking.istio.io group, so netatlas reads none of Istio's outbound settings.
    serviceEntries: first.serviceEntries,
    sidecars: first.sidecars,
    meshConfig: first.meshConfig,
  }).toStrictEqual({
    readErrors: [{ kind: 'authorizationpolicies', reason: 'forbidden' }],
    networkPolicies: 5,
    pods: 13,
    deployments: 7,
    enforcer: 'Calico',
    serviceEntries: 'not-installed',
    sidecars: 'not-installed',
    meshConfig: { state: 'not-installed' },
  });
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
          const resources = resourcesOf(u);
          snapshots.push(resources);
          if (snapshots.length === 1) api.revokeNetworkPolicies();
          if (resources.readErrors.some((e) => e.kind === 'networkpolicies')) resolve(resources);
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

it('reads ServiceEntries as plain JSON, and the mesh config by name only', async () => {
  const kc = await kubeConfigAt((await fakeApiServer({ networking: true })).url);
  const source = directSource(kc, cluster);
  cleanups.unshift(() => source.stop());

  const first = await new Promise<ClusterResources>((resolve, reject) => {
    source.start({ update: (u) => resolve(resourcesOf(u)), lost: reject }).catch(reject);
  });

  const entries = first.serviceEntries;
  expect({
    hosts: Array.isArray(entries) ? entries.map((e) => e.spec.hosts) : entries,
    subjectAltNames: Array.isArray(entries) ? entries.map((e) => e.spec.subjectAltNames) : entries,
    sidecars: first.sidecars,
    readErrors: first.readErrors.map((e) => e.kind),
    meshConfig: first.meshConfig,
  }).toStrictEqual({
    hosts: [['api.partner.example']],
    subjectAltNames: [['spiffe://x']],
    sidecars: [],
    readErrors: ['sidecars', 'authorizationpolicies'],
    meshConfig: { state: 'found', outbound: 'REGISTRY_ONLY' },
  });
});

// The mesh config is no kind of its own, so a refusal to read it shows in meshConfig and never in readErrors.
it.each<[string, 'forbidden' | unknown[], MeshSettings]>([
  ['every configmaps request refused', 'forbidden', { state: 'forbidden' }],
  ['no ConfigMap istio', [], { state: 'missing' }],
  ["the ConfigMap istio with no data, which is Istio's defaults", [{ metadata: { name: 'istio', namespace: 'istio-system', resourceVersion: '1' } }], { state: 'found', outbound: 'unset' }],
])('reads the mesh config %#: %s', async (_name, configMaps, meshConfig) => {
  const kc = await kubeConfigAt((await fakeApiServer({ networking: true, configMaps })).url);
  const source = directSource(kc, cluster);
  cleanups.unshift(() => source.stop());

  const first = await new Promise<ClusterResources>((resolve, reject) => {
    source.start({ update: (u) => resolve(resourcesOf(u)), lost: reject }).catch(reject);
  });

  expect({ meshConfig: first.meshConfig, readErrors: first.readErrors.map((e) => e.kind) }).toStrictEqual({ meshConfig, readErrors: ['sidecars', 'authorizationpolicies'] });
});
