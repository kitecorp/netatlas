import { expect, it } from 'vitest';
import { networkPolicy, SHOP, WITH_ISTIOD, withPolicies } from './fixtures/shop';
import { meshEgressGaps, meshEgressText, type MeshEgressGap } from './mesh-egress';
import { netpolEvaluator } from './netpol';
import type { ClusterResources, PodInfo, PolicyPort, PolicyRef } from './types';

const api = 'payments/Deployment/api';
const cart = 'shop/Deployment/cart';
const frontend = 'shop/Deployment/frontend';
const recommender = 'shop/Deployment/recommender';

const ref = (namespace: string, name: string): PolicyRef => ({ kind: 'NetworkPolicy', namespace, name });

/** A second egress policy of frontend's, to the pods labelled app=istiod in `namespace` on `port`. */
const frontendIstiod = (port: PolicyPort, namespace = 'istio-system') =>
  networkPolicy('shop', 'frontend-istiod', {
    podSelector: { matchLabels: { app: 'frontend' } },
    policyTypes: ['Egress'],
    egress: [{ to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': namespace } }, podSelector: { matchLabels: { app: 'istiod' } } }], ports: [port] }],
  });

/** A pod labelled app=istiod in shop, outside the Istio root namespace, so not Istio's istiod. */
const lookalike: PodInfo = {
  name: 'istiod-6c9f8d7b5-p2q4r',
  namespace: 'shop',
  labels: { app: 'istiod' },
  serviceAccount: 'istiod',
  workload: { kind: 'Deployment', name: 'istiod' },
  phase: 'Running',
  ports: [{ name: 'grpc-xds', port: 15012, protocol: 'TCP' }],
  mesh: 'none',
};

/** Closes CoreDNS's egress, so only the rule that a target's own pods are not checked keeps it off the list. */
const corednsClosed = networkPolicy('kube-system', 'coredns-closed', { podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } }, policyTypes: ['Egress'], egress: [] });

/** recommender's egress: istiod on TCP 15012, and the address NodeLocal DNSCache listens on, on `addressPort`. */
const recommenderNodeDns = (addressPort: PolicyPort) =>
  networkPolicy('shop', 'recommender-node-dns', {
    podSelector: { matchLabels: { app: 'recommender' } },
    policyTypes: ['Egress'],
    egress: [
      { to: [{ ipBlock: { cidr: '169.254.20.10/32' } }], ports: [addressPort] },
      { to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'istio-system' } }, podSelector: { matchLabels: { app: 'istiod' } } }], ports: [{ protocol: 'TCP', port: 15012 }] },
    ],
  });

/** Restricts recommender's egress with no rule, so it may call nothing. */
const recommenderClosed = networkPolicy('shop', 'recommender-closed', { podSelector: { matchLabels: { app: 'recommender' } }, policyTypes: ['Egress'], egress: [] });

type Gaps = [string, ['istiod' | 'kube-dns', string[]][]][];

/** Each workload's gaps as [target, policy names], in the map's order. */
const gapsOf = (r: ClusterResources) => [...meshEgressGaps(r, netpolEvaluator(r))].map(([id, gaps]) => [id, gaps.map((g) => [g.target, g.via.map((v) => v.name)])]);

it.each<[string, ClusterResources, Gaps]>([
  [
    'each sidecar whose egress leaves out istiod, with the policies that restrict it',
    WITH_ISTIOD,
    [
      [api, [['istiod', ['api-allow']]]],
      [cart, [['istiod', ['cart-allow']]]],
      [frontend, [['istiod', ['frontend-allow']]]],
    ],
  ],
  ['nothing when no istiod pod is seen, and every restricted side reaches kube-dns', SHOP, []],
  [
    'a rule to istiod on TCP 15012 clears frontend',
    withPolicies(WITH_ISTIOD, frontendIstiod({ protocol: 'TCP', port: 15012 })),
    [
      [api, [['istiod', ['api-allow']]]],
      [cart, [['istiod', ['cart-allow']]]],
    ],
  ],
  [
    "a rule to istiod on the port named grpc-xds clears frontend too, as the name resolves on istiod's pod",
    withPolicies(WITH_ISTIOD, frontendIstiod({ protocol: 'TCP', port: 'grpc-xds' })),
    [
      [api, [['istiod', ['api-allow']]]],
      [cart, [['istiod', ['cart-allow']]]],
    ],
  ],
  [
    'an egress policy with no rule keeps a sidecar from istiod and kube-dns',
    withPolicies(WITH_ISTIOD, recommenderClosed),
    [
      [api, [['istiod', ['api-allow']]]],
      [cart, [['istiod', ['cart-allow']]]],
      [frontend, [['istiod', ['frontend-allow']]]],
      [recommender, [['istiod', ['recommender-closed']], ['kube-dns', ['recommender-closed']]]],
    ],
  ],
  // A pod outside the mesh runs no sidecar to configure, but it still resolves names.
  [
    'an egress policy with no rule keeps a pod outside the mesh from kube-dns only',
    withPolicies({ ...WITH_ISTIOD, pods: WITH_ISTIOD.pods.map((p) => (p.workload.name === 'recommender' ? { ...p, mesh: 'none' as const } : p)) }, recommenderClosed),
    [
      [api, [['istiod', ['api-allow']]]],
      [cart, [['istiod', ['cart-allow']]]],
      [frontend, [['istiod', ['frontend-allow']]]],
      [recommender, [['kube-dns', ['recommender-closed']]]],
    ],
  ],
  [
    'a rule to app=istiod pods outside the root namespace is not a rule to istiod, so frontend keeps its gap',
    withPolicies({ ...WITH_ISTIOD, pods: [...WITH_ISTIOD.pods, lookalike] }, frontendIstiod({ protocol: 'TCP', port: 15012 }, 'shop')),
    [
      [api, [['istiod', ['api-allow']]]],
      [cart, [['istiod', ['cart-allow']]]],
      [frontend, [['istiod', ['frontend-allow', 'frontend-istiod']]]],
    ],
  ],
  // CoreDNS resolves through its upstream, never through itself, so kube-dns's own pods are not checked against it.
  [
    "kube-dns's own pods, even with their egress closed, have no kube-dns gap",
    withPolicies(WITH_ISTIOD, corednsClosed),
    [
      [api, [['istiod', ['api-allow']]]],
      [cart, [['istiod', ['cart-allow']]]],
      [frontend, [['istiod', ['frontend-allow']]]],
    ],
  ],
  // netatlas cannot tell which address answers DNS, so an address allowed on UDP 53 may be the resolver.
  [
    'an address allowed on UDP 53, as NodeLocal DNSCache needs, clears the kube-dns gap',
    withPolicies(WITH_ISTIOD, recommenderNodeDns({ protocol: 'UDP', port: 53 })),
    [
      [api, [['istiod', ['api-allow']]]],
      [cart, [['istiod', ['cart-allow']]]],
      [frontend, [['istiod', ['frontend-allow']]]],
    ],
  ],
  [
    'an address allowed only on TCP 443 answers no names, so the kube-dns gap stays',
    withPolicies(WITH_ISTIOD, recommenderNodeDns({ protocol: 'TCP', port: 443 })),
    [
      [api, [['istiod', ['api-allow']]]],
      [cart, [['istiod', ['cart-allow']]]],
      [frontend, [['istiod', ['frontend-allow']]]],
      [recommender, [['kube-dns', ['recommender-node-dns']]]],
    ],
  ],
])('meshEgressGaps %#: %s', (_name, r, expected) => {
  expect(gapsOf(r)).toStrictEqual(expected);
});

it.each<[string, MeshEgressGap, string]>([
  ['kube-dns', { target: 'kube-dns', via: [ref('mesh-egress', 'probe-egress')] }, 'cannot reach kube-dns on UDP 53 (probe-egress). Names do not resolve.'],
  [
    'istiod, with two policies joined',
    { target: 'istiod', via: [ref('shop', 'frontend-allow'), ref('shop', 'frontend-extra')] },
    'cannot reach istiod on TCP 15012 (frontend-allow and frontend-extra). New pods do not become ready while these policies apply: their sidecar waits for configuration from istiod.',
  ],
])('meshEgressText %#: %s', (_name, gap, expected) => {
  expect(meshEgressText(gap)).toBe(expected);
});
