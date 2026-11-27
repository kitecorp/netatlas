// The example cluster the model's tests read, and the objects the kind journeys deploy: a gateway in
// `ingress` calls the shop's frontend, which calls cart, which calls the payments api, which calls
// postgres. Every egress side also reaches kube-dns.
import { refOf } from '../classes';
import type {
  AuthorizationPolicyObject,
  AuthorizationPolicySpec,
  ClusterResources,
  ContainerPort,
  NetworkPolicyObject,
  NetworkPolicySpec,
  PodInfo,
} from '../types';
import type { DaemonSetInfo, OwnedObject, RawPod } from '../workloads';

export const networkPolicy = (namespace: string, name: string, spec: NetworkPolicySpec): NetworkPolicyObject => ({
  apiVersion: 'networking.k8s.io/v1',
  kind: 'NetworkPolicy',
  metadata: { name, namespace },
  spec,
});

export const authorizationPolicy = (namespace: string, name: string, spec: AuthorizationPolicySpec): AuthorizationPolicyObject => ({
  apiVersion: 'security.istio.io/v1',
  kind: 'AuthorizationPolicy',
  metadata: { name, namespace },
  spec,
});

const MESHED = new Set(['shop', 'payments']);

const deployment = (namespace: string, name: string, podNames: readonly string[], ports: readonly ContainerPort[], extraLabels = {}): PodInfo[] =>
  podNames.map((pod) => ({
    name: pod,
    namespace,
    labels: { app: name, ...extraLabels },
    serviceAccount: name,
    workload: { kind: 'Deployment', name },
    phase: 'Running',
    ports,
    mesh: MESHED.has(namespace) ? 'sidecar' : 'none',
  }));

const inNamespace = (ns: string) => ({ matchLabels: { 'kubernetes.io/metadata.name': ns } });
const app = (name: string) => ({ matchLabels: { app: name } });
const tcp = (port: number) => ({ protocol: 'TCP' as const, port });

/** The egress rule every policy carries, so that each workload can still resolve names. */
const kubeDns = {
  to: [{ namespaceSelector: inNamespace('kube-system'), podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } } }],
  ports: [
    { protocol: 'UDP' as const, port: 53 },
    { protocol: 'TCP' as const, port: 53 },
  ],
};

export const SHOP: ClusterResources = {
  namespaces: [
    { name: 'ingress', labels: { 'kubernetes.io/metadata.name': 'ingress' } },
    { name: 'shop', labels: { 'kubernetes.io/metadata.name': 'shop', 'istio-injection': 'enabled' } },
    { name: 'payments', labels: { 'kubernetes.io/metadata.name': 'payments', 'istio-injection': 'enabled' } },
    { name: 'kube-system', labels: { 'kubernetes.io/metadata.name': 'kube-system' } },
  ],
  pods: [
    ...deployment('ingress', 'gateway', ['gateway-7b9c6d5f4-h2k8p', 'gateway-7b9c6d5f4-q7m4x'], [{ name: 'https', port: 443, protocol: 'TCP' }]),
    ...deployment('shop', 'frontend', ['frontend-5c8d7f6b9-j3n6w', 'frontend-5c8d7f6b9-r8t2v'], [{ name: 'http', port: 8080, protocol: 'TCP' }]),
    ...deployment(
      'shop',
      'cart',
      ['cart-6d5f7c9b8-4xkqz', 'cart-6d5f7c9b8-9wjm2', 'cart-6d5f7c9b8-tn7hc'],
      [{ name: 'http', port: 8080, protocol: 'TCP' }],
    ),
    ...deployment('shop', 'recommender', ['recommender-8f6b5d4c7-z5p9k'], []),
    ...deployment('payments', 'api', ['api-6b7d9c8f5-m4w7s', 'api-6b7d9c8f5-x2c9d'], [{ name: 'https', port: 8443, protocol: 'TCP' }]),
    ...deployment('payments', 'postgres', ['postgres-9d8c7b6f5-b6v3n'], [{ name: 'postgres', port: 5432, protocol: 'TCP' }]),
    ...deployment(
      'kube-system',
      'coredns',
      ['coredns-5d78c9869d-k7xwq', 'coredns-5d78c9869d-p4rzt'],
      [
        { name: 'dns', port: 53, protocol: 'UDP' },
        { name: 'dns-tcp', port: 53, protocol: 'TCP' },
      ],
      { 'k8s-app': 'kube-dns' },
    ),
  ],
  networkPolicies: [
    networkPolicy('ingress', 'gateway-allow', {
      podSelector: app('gateway'),
      policyTypes: ['Ingress', 'Egress'],
      ingress: [{ from: [{ ipBlock: { cidr: '0.0.0.0/0' } }], ports: [tcp(443)] }],
      egress: [{ to: [{ namespaceSelector: inNamespace('shop'), podSelector: app('frontend') }], ports: [tcp(8080)] }, kubeDns],
    }),
    networkPolicy('shop', 'frontend-allow', {
      podSelector: app('frontend'),
      policyTypes: ['Ingress', 'Egress'],
      ingress: [{ from: [{ namespaceSelector: inNamespace('ingress'), podSelector: app('gateway') }], ports: [tcp(8080)] }],
      egress: [{ to: [{ podSelector: app('cart') }], ports: [tcp(8080)] }, kubeDns],
    }),
    networkPolicy('shop', 'cart-allow', {
      podSelector: app('cart'),
      policyTypes: ['Ingress', 'Egress'],
      ingress: [{ from: [{ podSelector: app('frontend') }], ports: [tcp(8080)] }],
      egress: [{ to: [{ namespaceSelector: inNamespace('payments'), podSelector: app('api') }], ports: [tcp(8443)] }, kubeDns],
    }),
    networkPolicy('payments', 'api-allow', {
      podSelector: app('api'),
      policyTypes: ['Ingress', 'Egress'],
      ingress: [{ from: [{ namespaceSelector: inNamespace('shop'), podSelector: app('cart') }], ports: [tcp(8443)] }],
      egress: [{ to: [{ podSelector: app('postgres') }], ports: [tcp(5432)] }, kubeDns],
    }),
    networkPolicy('payments', 'postgres-allow', {
      podSelector: app('postgres'),
      policyTypes: ['Ingress'],
      ingress: [{ from: [{ podSelector: app('api') }, { namespaceSelector: inNamespace('shop'), podSelector: app('recommender') }], ports: [tcp(5432)] }],
    }),
  ],
  authorizationPolicies: [
    authorizationPolicy('shop', 'cart-callers', {
      selector: { matchLabels: { app: 'cart' } },
      action: 'ALLOW',
      rules: [{ from: [{ source: { principals: ['cluster.local/ns/shop/sa/frontend'] } }], to: [{ operation: { methods: ['GET'], paths: ['/cart'] } }] }],
    }),
    authorizationPolicy('payments', 'api-callers', {
      selector: { matchLabels: { app: 'api' } },
      action: 'ALLOW',
      rules: [{ from: [{ source: { principals: ['cluster.local/ns/shop/sa/cart'] } }], to: [{ operation: { methods: ['POST'], paths: ['/pay'] } }] }],
    }),
  ],
  readErrors: [],
  enforcer: 'Calico',
  istio: 'sidecars',
  istioSettings: { rootNamespace: 'istio-system', trustDomain: 'cluster.local' },
};

/** A pod's ReplicaSet is its name without the last part, as Kubernetes names a Deployment's pods. */
const replicaSetOf = (pod: PodInfo) => pod.name.slice(0, pod.name.lastIndexOf('-'));

/**
 * SHOP as a source's caches hold it: each pod owned by its ReplicaSet, each ReplicaSet by its
 * Deployment, and Calico's DaemonSet. Built from SHOP, so the two cannot drift apart.
 */
export const SHOP_LISTED: { readonly pods: readonly RawPod[]; readonly replicaSets: readonly OwnedObject[]; readonly daemonSets: readonly DaemonSetInfo[] } = {
  pods: SHOP.pods.map((p) => ({
    name: p.name,
    namespace: p.namespace,
    labels: p.labels,
    serviceAccount: p.serviceAccount,
    owner: { kind: 'ReplicaSet', name: replicaSetOf(p) },
    phase: p.phase,
    ports: p.ports,
    mesh: p.mesh,
  })),
  replicaSets: [...new Map(SHOP.pods.map((p) => [`${p.namespace}/${replicaSetOf(p)}`, { namespace: p.namespace, name: replicaSetOf(p), owner: p.workload }])).values()],
  daemonSets: [{ namespace: 'calico-system', name: 'calico-node', containers: [{ name: 'calico-node', args: [] }] }],
};

const sameRef = (a: NetworkPolicyObject | AuthorizationPolicyObject, b: NetworkPolicyObject | AuthorizationPolicyObject) => {
  const x = refOf(a), y = refOf(b);
  return x.kind === y.kind && x.namespace === y.namespace && x.name === y.name;
};

const upsert = <T extends NetworkPolicyObject | AuthorizationPolicyObject>(list: readonly T[], p: T): T[] =>
  list.some((q) => sameRef(q, p)) ? list.map((q) => (sameRef(q, p) ? p : q)) : [...list, p];

/** `r` with each policy given replacing the one of the same kind, namespace and name, or added. */
export function withPolicies(r: ClusterResources, ...policies: readonly (NetworkPolicyObject | AuthorizationPolicyObject)[]): ClusterResources {
  let { networkPolicies, authorizationPolicies } = r;
  for (const p of policies) {
    if (refOf(p).kind === 'NetworkPolicy') networkPolicies = upsert(networkPolicies, p as NetworkPolicyObject);
    else authorizationPolicies = upsert(authorizationPolicies === 'not-installed' ? [] : authorizationPolicies, p as AuthorizationPolicyObject);
  }
  return { ...r, networkPolicies, authorizationPolicies };
}
