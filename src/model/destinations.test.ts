import { expect, it } from 'vitest';
import { callerOf, destinationOf, workloadIndex, type Caller, type Destination } from './destinations';
import { deployment, SHOP } from './fixtures/shop';
import { EGRESS_GATEWAY } from './fixtures/traffic';
import type { ClusterResources, Labels } from './types';

const sample = (labels: Labels) => ({ labels, value: 1 });

// SHOP's workloads plus the egress gateway in istio-system.
it.each<[string, Labels, string, Destination]>([
  ['a workload netatlas sees', { destination_workload: 'cart', destination_workload_namespace: 'shop' }, 'cluster.local', { kind: 'workload', id: 'shop/Deployment/cart' }],
  [
    'plain HTTP to an unregistered host, its port dropped',
    { destination_service: 'pay.example.com:8080', destination_service_name: 'PassthroughCluster' },
    'cluster.local',
    { kind: 'external', host: 'pay.example.com' },
  ],
  ['TLS or TCP to an unregistered host', { destination_service: 'unknown', destination_service_name: 'PassthroughCluster' }, 'cluster.local', { kind: 'unregistered' }],
  ['HTTP that REGISTRY_ONLY blocked', { destination_service: 'pay.example.com', destination_service_name: 'BlackHoleCluster' }, 'cluster.local', { kind: 'blackhole', host: 'pay.example.com' }],
  ['TLS or TCP that REGISTRY_ONLY blocked', { destination_service: 'unknown', destination_service_name: 'BlackHoleCluster' }, 'cluster.local', { kind: 'blackhole' }],
  [
    'a wildcard ServiceEntry host',
    { destination_service: '*.fonts.example', destination_service_name: '*.fonts.example', destination_workload: 'unknown' },
    'cluster.local',
    { kind: 'external', host: '*.fonts.example' },
  ],
  [
    'a ServiceEntry host as ztunnel names it',
    { destination_service: 'api.partner.example', destination_service_name: 'partner' },
    'cluster.local',
    { kind: 'external', host: 'api.partner.example' },
  ],
  [
    'every destination label unknown',
    {
      source_workload: 'recommender',
      source_workload_namespace: 'shop',
      source_cluster: 'Kubernetes',
      destination_workload: 'unknown',
      destination_workload_namespace: 'unknown',
      destination_service: 'unknown',
      destination_service_name: 'unknown',
      destination_cluster: 'unknown',
    },
    'cluster.local',
    { kind: 'unattributed' },
  ],
  [
    'an egress gateway',
    { destination_workload: 'istio-egressgateway', destination_workload_namespace: 'istio-system' },
    'cluster.local',
    { kind: 'egress-gateway', id: 'istio-system/Deployment/istio-egressgateway' },
  ],
  ['a workload with no pods now', { destination_workload: 'search', destination_workload_namespace: 'shop' }, 'cluster.local', { kind: 'unseen', namespace: 'shop', name: 'search' }],
  [
    'a workload with no pods now, behind a service of the cluster',
    { destination_workload: 'search', destination_workload_namespace: 'shop', destination_service: 'search.shop.svc.cluster.local', destination_service_name: 'search.shop.svc.cluster.local' },
    'cluster.local',
    { kind: 'unseen', namespace: 'shop', name: 'search' },
  ],
  // Istio 1.32 names each inline endpoint of a ServiceEntry `<entry name>-<index>`, and the one endpoint of a
  // DNS entry without endpoints by the entry's name, both in the entry's namespace
  // (pilot/pkg/serviceregistry/serviceentry/conversion.go:363-391, 438-442): a destination workload that is no
  // workload of the cluster.
  [
    "a ServiceEntry host's endpoint, as the kind battery's client reports it",
    {
      reporter: 'source',
      destination_service: 'outside-http.example',
      destination_service_name: 'outside-http.example',
      destination_workload: 'outside-http-0',
      destination_workload_namespace: 'traffic',
    },
    'cluster.local',
    { kind: 'external', host: 'outside-http.example' },
  ],
  [
    'a DNS ServiceEntry without endpoints, named by the entry',
    { reporter: 'source', destination_service: 'outside-http.example', destination_service_name: 'outside-http.example', destination_workload: 'outside-http', destination_workload_namespace: 'traffic' },
    'cluster.local',
    { kind: 'external', host: 'outside-http.example' },
  ],
  [
    'a workload of another cluster of the mesh',
    { destination_workload: 'ledger', destination_workload_namespace: 'payments', source_cluster: 'west', destination_cluster: 'east' },
    'cluster.local',
    { kind: 'mesh-cluster', cluster: 'east' },
  ],
  // Another cluster comes first, even when the host it was called by is not a service of this cluster.
  [
    'a workload of another cluster, called by a host outside the cluster domain',
    { destination_workload: 'ledger', destination_workload_namespace: 'payments', destination_service: 'ledger.global', destination_service_name: 'ledger.global', source_cluster: 'west', destination_cluster: 'east' },
    'cluster.local',
    { kind: 'mesh-cluster', cluster: 'east' },
  ],
  // shop/cart runs here too, but another cluster's proxy answered the call (multi-primary, same names in both).
  [
    'a workload of another cluster that has the name of a local one',
    { destination_workload: 'cart', destination_workload_namespace: 'shop', source_cluster: 'Kubernetes', destination_cluster: 'cluster-2' },
    'cluster.local',
    { kind: 'mesh-cluster', cluster: 'cluster-2' },
  ],
  [
    'a service of the cluster no workload answered',
    { destination_workload: 'unknown', destination_service: 'search.shop.svc.cluster.local' },
    'cluster.local',
    { kind: 'service', host: 'search.shop.svc.cluster.local' },
  ],
  [
    'a service under another cluster domain',
    { destination_workload: 'unknown', destination_service: 'cart.shop.svc.corp.internal' },
    'corp.internal',
    { kind: 'service', host: 'cart.shop.svc.corp.internal' },
  ],
  ['a host under the default domain, read under another', { destination_service: 'x.svc.cluster.local' }, 'corp.internal', { kind: 'external', host: 'x.svc.cluster.local' }],
  [
    'no destination labels at all (Telemetry removed them)',
    { reporter: 'source', source_workload: 'frontend', source_workload_namespace: 'shop', source_cluster: 'Kubernetes' },
    'cluster.local',
    { kind: 'unattributed' },
  ],
])('destinationOf %#: %s', (_name, labels, clusterDomain, expected) => {
  expect(destinationOf(sample(labels), workloadIndex(EGRESS_GATEWAY.resources), clusterDomain)).toStrictEqual(expected);
});

/** A caller in another cluster of the mesh reads as Destination's value for a workload another cluster serves, its cluster named. */
type CallerRow = Caller | Extract<Destination, { kind: 'mesh-cluster' }>;

it.each<[string, Labels, CallerRow]>([
  ['a workload netatlas sees', { source_workload: 'frontend', source_workload_namespace: 'shop' }, { kind: 'workload', id: 'shop/Deployment/frontend' }],
  // The callee's report: shop/frontend runs here too, but the caller's proxy wrote cluster-2 as its own cluster.
  [
    'a caller in another cluster that has the name of a local workload',
    { reporter: 'destination', source_workload: 'frontend', source_workload_namespace: 'shop', source_cluster: 'cluster-2', destination_cluster: 'Kubernetes' },
    { kind: 'mesh-cluster', cluster: 'cluster-2' },
  ],
  ['a workload with no pods now', { source_workload: 'search', source_workload_namespace: 'shop' }, { kind: 'unseen', namespace: 'shop', name: 'search' }],
  ['a caller with no proxy', { source_workload: 'unknown', source_workload_namespace: 'unknown' }, { kind: 'outside-mesh' }],
  ['no source labels at all (Telemetry removed them)', { destination_workload: 'frontend', destination_workload_namespace: 'shop' }, { kind: 'outside-mesh' }],
])('callerOf %#: %s', (_name, labels, expected) => {
  expect(callerOf(sample(labels), workloadIndex(SHOP))).toStrictEqual(expected);
});

// Two workloads named frontend, in shop and in payments: each end is matched by namespace and name, never by name alone.
const TWO_FRONTENDS: ClusterResources = { ...SHOP, pods: [...SHOP.pods, ...deployment('payments', 'frontend', ['frontend-7d6c5b4f9-p8q2r'], [])] };
const frontendIn: Readonly<Record<'destination' | 'caller', (namespace: string) => Destination | Caller>> = {
  destination: (ns) => destinationOf(sample({ destination_workload: 'frontend', destination_workload_namespace: ns }), workloadIndex(TWO_FRONTENDS), 'cluster.local'),
  caller: (ns) => callerOf(sample({ source_workload: 'frontend', source_workload_namespace: ns }), workloadIndex(TWO_FRONTENDS)),
};

it.each<['destination' | 'caller', string, Destination | Caller]>([
  ['destination', 'payments', { kind: 'workload', id: 'payments/Deployment/frontend' }],
  ['destination', 'shop', { kind: 'workload', id: 'shop/Deployment/frontend' }],
  ['caller', 'payments', { kind: 'workload', id: 'payments/Deployment/frontend' }],
  ['caller', 'shop', { kind: 'workload', id: 'shop/Deployment/frontend' }],
])('matches by namespace and name %#: the %s frontend in %s', (end, namespace, expected) => {
  expect(frontendIn[end](namespace)).toStrictEqual(expected);
});

it('gives a (namespace, name) tie to the first id in id order, not the first pod', () => {
  // A DaemonSet frontend in shop, listed after the Deployment's pods; its id sorts first.
  const tie: ClusterResources = { ...SHOP, pods: [...SHOP.pods, ...deployment('shop', 'frontend', ['frontend-x7k2p'], []).map((p) => ({ ...p, workload: { kind: 'DaemonSet', name: 'frontend' } }))] };
  expect(workloadIndex(tie).byName('shop', 'frontend')).toBe('shop/DaemonSet/frontend');
});
