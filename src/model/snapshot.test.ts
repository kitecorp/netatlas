import { expect, it } from 'vitest';
import { SHOP, SHOP_LISTED } from './fixtures/shop';
import { buildResources } from './snapshot';
import type { PodInfo } from './types';

const istiodPod = {
  name: 'istiod-7d4b9c6f5-x2k9m',
  namespace: 'istio-system',
  labels: { app: 'istiod', istio: 'pilot' },
  serviceAccount: 'istiod',
  phase: 'Running',
  ports: [{ name: 'grpc-xds', port: 15010, protocol: 'TCP' }],
  mesh: 'none',
} as const satisfies Omit<PodInfo, 'workload'>;

it('names each pod by its workload and finds the enforcer and Istio from what the caches hold', () =>
  expect(
    buildResources({
      namespaces: SHOP.namespaces,
      pods: [...SHOP_LISTED.pods, { ...istiodPod, owner: { kind: 'ReplicaSet', name: 'istiod-7d4b9c6f5' } }],
      replicaSets: [...SHOP_LISTED.replicaSets, { namespace: 'istio-system', name: 'istiod-7d4b9c6f5', owner: { kind: 'Deployment', name: 'istiod' } }],
      jobs: [],
      daemonSets: SHOP_LISTED.daemonSets,
      networkPolicies: SHOP.networkPolicies,
      authorizationPolicies: SHOP.authorizationPolicies,
      readErrors: [],
      istioSettings: { rootNamespace: 'istio-system', trustDomain: 'cluster.local' },
    }),
  ).toEqual({ ...SHOP, pods: [...SHOP.pods, { ...istiodPod, workload: { kind: 'Deployment', name: 'istiod' } }] }));

// A finished Job's pod keeps no workload running, so it is neither a workload nor a peer.
it('leaves out pods that finished', () => {
  const finished = (phase: string) => ({ ...istiodPod, name: `report-${phase.toLowerCase()}`, labels: { app: 'report' }, phase, owner: { kind: 'Job', name: 'report-29101' } });
  const r = buildResources({
    namespaces: SHOP.namespaces,
    pods: [...SHOP_LISTED.pods, finished('Succeeded'), finished('Failed'), finished('Running')],
    replicaSets: SHOP_LISTED.replicaSets,
    jobs: [],
    daemonSets: SHOP_LISTED.daemonSets,
    networkPolicies: [],
    authorizationPolicies: 'not-installed',
    readErrors: [],
    istioSettings: { rootNamespace: 'istio-system', trustDomain: 'cluster.local' },
  });
  expect(r.pods.filter((p) => p.labels.app === 'report').map((p) => p.name)).toStrictEqual(['report-running']);
});
