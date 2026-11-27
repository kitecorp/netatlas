// Clusters as the overview reads them: prod-eu-1 is SHOP, dev-eu has policies but no enforcer and
// many open workloads, and edge-ap stopped answering 12 minutes before NOW and keeps its last data.
import type { ClusterResources, ClusterSnapshot, PodInfo } from '../types';
import { networkPolicy, SHOP } from './shop';

export const NOW = new Date('2026-11-27T10:00:00Z');
export const ago = (ms: number) => new Date(NOW.getTime() - ms);

const SECOND = 1000;
const MINUTE = 60 * SECOND;

const pod = (namespace: string, app: string): PodInfo => ({
  name: `${app}-7d9c8f5b6-x2c9d`,
  namespace,
  labels: { app },
  serviceAccount: app,
  workload: { kind: 'Deployment', name: app },
  phase: 'Running',
  ports: [],
  mesh: 'none',
});

/** `open` workloads no policy selects, and one workload `web` that `policies` NetworkPolicies select. */
function cluster(namespace: string, open: number, policies: number, enforcer: ClusterResources['enforcer']): ClusterResources {
  const apps = Array.from({ length: open }, (_, i) => `svc-${String(i + 1).padStart(2, '0')}`);
  return {
    namespaces: [{ name: namespace, labels: { 'kubernetes.io/metadata.name': namespace } }],
    pods: [...apps.map((a) => pod(namespace, a)), pod(namespace, 'web')],
    networkPolicies: Array.from({ length: policies }, (_, i) => networkPolicy(namespace, `web-${i + 1}`, { podSelector: { matchLabels: { app: 'web' } }, policyTypes: ['Ingress'] })),
    authorizationPolicies: 'not-installed',
    readErrors: [],
    enforcer,
    istio: 'none',
    istioSettings: { rootNamespace: 'istio-system', trustDomain: 'cluster.local' },
  };
}

const reachable = (name: string, kubernetesVersion: string, resources: ClusterResources, seen: Date): ClusterSnapshot => ({
  name,
  status: { state: 'reachable', since: ago(60 * MINUTE), lastSeen: seen, kubernetesVersion },
  resources,
  syncedAt: seen,
  synced: true,
});

export const PROD = reachable('prod-eu-1', 'v1.37.0', SHOP, ago(4 * SECOND));

/** 31 open workloads and `web`, which 3 NetworkPolicies select. */
export const DEV = reachable('dev-eu', 'v1.37.2-eks-a737599', cluster('dev', 31, 3, null), ago(2 * SECOND));

export const EDGE_SINCE = ago(11 * MINUTE);

/** 30 open workloads and `web` (31 workloads), and 4 NetworkPolicies, last seen 12 minutes ago. */
export const EDGE: ClusterSnapshot = {
  name: 'edge-ap',
  status: { state: 'unreachable', since: EDGE_SINCE, reason: 'the API server stopped answering', lastSeen: ago(12 * MINUTE) },
  resources: cluster('edge', 30, 4, 'Calico'),
  syncedAt: ago(12 * MINUTE),
  synced: false,
};
