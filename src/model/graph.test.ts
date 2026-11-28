import { describe, expect, it } from 'vitest';
import { authorizationPolicy, MESH_DENY_ADMIN, networkPolicy, RECOMMENDER_DENY, SHOP, WITH_ISTIOD, withPolicies } from './fixtures/shop';
import { clusterGraph, defaultHidden, workloadDetail } from './graph';
import type { ClusterResources, Mesh, PolicyRef } from './types';

const gateway = 'ingress/Deployment/gateway';
const frontend = 'shop/Deployment/frontend';
const cart = 'shop/Deployment/cart';
const recommender = 'shop/Deployment/recommender';
const api = 'payments/Deployment/api';
const postgres = 'payments/Deployment/postgres';

const np = (namespace: string, name: string): PolicyRef => ({ kind: 'NetworkPolicy', namespace, name });
const ap = (namespace: string, name: string): PolicyRef => ({ kind: 'AuthorizationPolicy', namespace, name });

const app = (name: string) => ({ matchLabels: { app: name } });

it('gives the allowed edges of the shop cluster, sorted by from, to, kind and label', () => {
  const edges = clusterGraph(SHOP).edges.filter((e) => !e.from.startsWith('kube-system/') && !e.to.startsWith('kube-system/'));
  expect(edges.map((e) => [e.from, e.to, e.kind, e.label])).toStrictEqual([
    [gateway, frontend, 'networkpolicy', 'TCP 8080'],
    ['outside', gateway, 'networkpolicy', 'TCP 443'],
    [api, postgres, 'networkpolicy', 'TCP 5432'],
    [cart, api, 'istio', 'POST /pay'],
    [cart, api, 'networkpolicy', 'TCP 8443'],
    [frontend, cart, 'istio', 'GET /cart'],
    [frontend, cart, 'networkpolicy', 'TCP 8080'],
    [recommender, postgres, 'networkpolicy', 'TCP 5432'],
  ]);
});

it('keeps the address block, the policies and the plain-text mark an edge carries', () => {
  const anyGet = authorizationPolicy('shop', 'cart-get', { selector: app('cart'), action: 'ALLOW', rules: [{ to: [{ operation: { methods: ['GET'] } }] }] });
  const edges = clusterGraph(withPolicies(SHOP, anyGet)).edges;
  expect([edges.find((e) => e.from === 'outside'), edges.find((e) => e.from === gateway && e.to === cart)]).toStrictEqual([
    { from: 'outside', to: gateway, kind: 'networkpolicy', label: 'TCP 443', peer: '0.0.0.0/0', via: [np('ingress', 'gateway-allow')] },
    { from: gateway, to: cart, kind: 'istio', label: 'GET', via: [ap('shop', 'cart-get')], plainText: 'accepted unless mutual TLS is STRICT' },
  ]);
});

it('groups the workloads by namespace, and marks what no policy restricts', () => {
  const g = clusterGraph(SHOP);
  expect(g.namespaces.map((n) => [n.name, n.workloads.map((w) => w.name)])).toStrictEqual([
    ['ingress', ['gateway']],
    ['kube-system', ['coredns']],
    ['payments', ['api', 'postgres']],
    ['shop', ['cart', 'frontend', 'recommender']],
  ]);
  const node = (id: string) => g.namespaces.flatMap((n) => n.workloads).find((w) => w.id === id);
  expect([node(cart), node(recommender), node(postgres)]).toStrictEqual([
    {
      id: cart,
      namespace: 'shop',
      kind: 'Deployment',
      name: 'cart',
      pods: 3,
      policies: [np('shop', 'cart-allow'), ap('shop', 'cart-callers')],
      restrictedBy: { ingress: [np('shop', 'cart-allow')], egress: [np('shop', 'cart-allow')] },
      ingressOpen: false,
      egressOpen: false,
      noPolicy: false,
      istioNotEnforced: false,
      istioEnforced: [ap('shop', 'cart-callers')],
      anyPeer: [],
      meshEgress: [],
      mesh: 'sidecar',
    },
    {
      id: recommender,
      namespace: 'shop',
      kind: 'Deployment',
      name: 'recommender',
      pods: 1,
      policies: [],
      restrictedBy: { ingress: [], egress: [] },
      ingressOpen: true,
      egressOpen: true,
      noPolicy: true,
      istioNotEnforced: false,
      istioEnforced: [],
      anyPeer: [],
      meshEgress: [],
      mesh: 'sidecar',
    },
    {
      id: postgres,
      namespace: 'payments',
      kind: 'Deployment',
      name: 'postgres',
      pods: 1,
      policies: [np('payments', 'postgres-allow')],
      restrictedBy: { ingress: [np('payments', 'postgres-allow')], egress: [] },
      ingressOpen: false,
      egressOpen: true,
      noPolicy: false,
      istioNotEnforced: false,
      istioEnforced: [],
      anyPeer: [],
      meshEgress: [],
      mesh: 'sidecar',
    },
  ]);
});

// The gateway and coredns run no proxy in SHOP: only the shop's and the payments' pods are injected.
it.each<[string, Mesh]>([
  [frontend, 'sidecar'],
  [gateway, 'none'],
  ['kube-system/Deployment/coredns', 'none'],
])('gives %s the mesh %s', (id, expected) => {
  expect(clusterGraph(SHOP).namespaces.flatMap((n) => n.workloads).find((w) => w.id === id)?.mesh).toBe(expected);
});

describe('marks on a workload', () => {
  const recommenderNode = (r: ClusterResources) => {
    const w = clusterGraph(r).namespaces.flatMap((n) => n.workloads).find((x) => x.id === recommender);
    return w && { ingressOpen: w.ingressOpen, egressOpen: w.egressOpen, noPolicy: w.noPolicy, istioNotEnforced: w.istioNotEnforced, anyPeer: w.anyPeer };
  };
  const peerless = networkPolicy('shop', 'recommender-in', { podSelector: app('recommender'), policyTypes: ['Ingress'], ingress: [{ ports: [{ protocol: 'TCP', port: 8080 }] }] });
  const outsideMesh: ClusterResources = { ...SHOP, pods: SHOP.pods.map((p) => (p.workload.name === 'recommender' ? { ...p, mesh: 'none' } : p)) };
  const recommenderCallers = authorizationPolicy('shop', 'recommender-callers', { selector: app('recommender'), rules: [{}] });
  it.each<[string, ClusterResources, ReturnType<typeof recommenderNode>]>([
    ['a rule with no peers is a mark, not an edge', withPolicies(SHOP, peerless), { ingressOpen: false, egressOpen: true, noPolicy: false, istioNotEnforced: false, anyPeer: [{ side: 'ingress', ports: 'TCP 8080' }] }],
    ['an Istio policy on a workload outside the mesh is not enforced, so it still has no policy', withPolicies(outsideMesh, recommenderCallers), { ingressOpen: true, egressOpen: true, noPolicy: true, istioNotEnforced: true, anyPeer: [] }],
    [
      'NetworkPolicies netatlas may not read leave no side open and no workload without a policy',
      { ...SHOP, networkPolicies: [], readErrors: [{ kind: 'networkpolicies', reason: 'forbidden' }] },
      { ingressOpen: false, egressOpen: false, noPolicy: false, istioNotEnforced: false, anyPeer: [] },
    ],
    [
      'AuthorizationPolicies netatlas may not read leave no workload without a policy',
      { ...SHOP, authorizationPolicies: [], readErrors: [{ kind: 'authorizationpolicies', reason: 'forbidden' }] },
      { ingressOpen: true, egressOpen: true, noPolicy: false, istioNotEnforced: false, anyPeer: [] },
    ],
    // A DENY policy allows nothing, yet it selects the workload, so the workload is not one no policy selects.
    ['a DENY policy alone still selects it, so it has a policy', withPolicies(SHOP, RECOMMENDER_DENY), { ingressOpen: true, egressOpen: true, noPolicy: false, istioNotEnforced: false, anyPeer: [] }],
  ])('mark %#: %s', (_name, r, expected) => {
    expect(recommenderNode(r)).toStrictEqual(expected);
  });
});

// Without the namespaces' labels a namespaceSelector selects nothing, so edges would vanish with no word.
it.each<[string, ClusterResources, string[]]>([
  ['every kind read', SHOP, []],
  ['namespaces refused', { ...SHOP, namespaces: [], readErrors: [{ kind: 'namespaces', reason: 'forbidden' }] }, ['namespaces']],
  [
    'pods and AuthorizationPolicies refused',
    { ...SHOP, pods: [], authorizationPolicies: [], readErrors: [{ kind: 'pods', reason: 'forbidden' }, { kind: 'authorizationpolicies', reason: 'forbidden' }] },
    ['pods', 'authorizationpolicies'],
  ],
  ['DaemonSets refused, which the map does not need', { ...SHOP, readErrors: [{ kind: 'daemonsets', reason: 'forbidden' }] }, []],
])('unreadable %#: %s', (_name, r, expected) => {
  expect(clusterGraph(r).unreadable).toStrictEqual(expected);
});

it('lists the waypoint policies it does not evaluate', () => {
  const waypoint = authorizationPolicy('shop', 'cart-waypoint', { targetRefs: [{ kind: 'Gateway', group: 'gateway.networking.k8s.io', name: 'waypoint' }], rules: [{}] });
  expect(clusterGraph(withPolicies(SHOP, waypoint)).notEvaluated).toStrictEqual([ap('shop', 'cart-waypoint')]);
});

it('hides the kube-* namespaces and the Istio root namespace by default', () => {
  const r: ClusterResources = { ...SHOP, namespaces: [...SHOP.namespaces, { name: 'kube-public', labels: {} }, { name: 'mesh-root', labels: {} }], istioSettings: { rootNamespace: 'mesh-root', trustDomain: 'cluster.local' } };
  expect([...defaultHidden(r)].sort()).toStrictEqual(['kube-public', 'kube-system', 'mesh-root']);
});

it('details cart: what selects it, what may call it and what it may call', () => {
  expect(workloadDetail(clusterGraph(SHOP), cart, defaultHidden(SHOP))).toStrictEqual({
    selectedBy: [np('shop', 'cart-allow'), ap('shop', 'cart-callers')],
    mayCallIt: [
      { peer: 'shop / frontend', label: 'TCP 8080', kind: 'networkpolicy' },
      { peer: 'shop / frontend', label: 'GET /cart', kind: 'istio' },
    ],
    itMayCall: [
      { peer: 'payments / api', label: 'TCP 8443', kind: 'networkpolicy' },
      { peer: 'payments / api', label: 'POST /pay', kind: 'istio', note: 'its policy api-callers' },
      { peer: 'kube-system / coredns', label: 'UDP 53, TCP 53', kind: 'networkpolicy', note: 'hidden on the map' },
    ],
    summary: 'Everything else is blocked in both directions, because cart-allow covers ingress and egress. Istio also decides which requests reach it: cart-callers.',
    needs: [],
  });
});

// recommender's only Istio policy is a DENY, and the mesh-wide DENY keeps frontend from the admin paths. No ALLOW
// policy selects recommender or postgres, so Istio lets in every request no DENY policy refuses (istio/api
// security/v1beta1/authorization_policy.proto:31 at 97748e4): the callers stay, and a DENY policy is named only as
// not refusing the call, never as the policy that lets it in. cart's ALLOW policy is the one named for cart.
it('details calls no ALLOW policy decides: the callers stay, and a DENY policy is never named as what lets them in', () => {
  const g = clusterGraph(withPolicies(SHOP, RECOMMENDER_DENY, MESH_DENY_ADMIN));
  expect({ callersOfRecommender: workloadDetail(g, recommender, new Set())?.mayCallIt.map((l) => l.peer), frontendMayCall: workloadDetail(g, frontend, new Set())?.itMayCall }).toStrictEqual({
    callersOfRecommender: ['ingress / gateway', 'kube-system / coredns', 'payments / api', 'payments / postgres', 'shop / cart', 'shop / frontend'],
    frontendMayCall: [
      { peer: 'kube-system / coredns', label: 'UDP 53, TCP 53', kind: 'networkpolicy' },
      { peer: 'payments / postgres', label: 'any request', kind: 'istio', note: 'no ALLOW policy selects it, so Istio lets in every request that mesh-deny-admin does not refuse; depends on the request' },
      { peer: 'shop / cart', label: 'TCP 8080', kind: 'networkpolicy' },
      { peer: 'shop / cart', label: 'GET /cart', kind: 'istio', note: 'its policy cart-callers; depends on the request' },
      {
        peer: 'shop / recommender',
        label: 'any request',
        kind: 'istio',
        note: 'no ALLOW policy selects it, so Istio lets in every request that mesh-deny-admin and recommender-deny do not refuse; depends on the request',
      },
    ],
  });
});

it('details the gateway: the Internet as its caller, with the address block', () => {
  expect(workloadDetail(clusterGraph(SHOP), gateway, new Set())?.mayCallIt).toStrictEqual([{ peer: 'Internet', label: 'TCP 443', kind: 'networkpolicy', note: '0.0.0.0/0' }]);
});

it('marks a plain-text caller and a rule with no peers in the detail', () => {
  const anyGet = authorizationPolicy('shop', 'recommender-get', { selector: app('recommender'), rules: [{ to: [{ operation: { methods: ['GET'] } }] }] });
  const peerless = networkPolicy('shop', 'recommender-in', { podSelector: app('recommender'), policyTypes: ['Ingress'], ingress: [{ ports: [{ protocol: 'TCP', port: 8080 }] }] });
  const lines = workloadDetail(clusterGraph(withPolicies(SHOP, anyGet, peerless)), recommender, new Set())?.mayCallIt;
  expect(lines?.filter((l) => l.note !== undefined)).toStrictEqual([
    { peer: 'ingress / gateway', label: 'GET', kind: 'istio', note: 'accepted unless mutual TLS is STRICT' },
    { peer: 'kube-system / coredns', label: 'GET', kind: 'istio', note: 'accepted unless mutual TLS is STRICT' },
  ]);
  expect(lines?.at(-1)).toStrictEqual({ peer: 'Anything, in this cluster or outside it', label: 'TCP 8080', kind: 'networkpolicy' });
});

it('details what keeps frontend from istiod, as a sentence', () => {
  expect(workloadDetail(clusterGraph(WITH_ISTIOD), frontend, new Set())?.needs).toStrictEqual([
    'Cannot reach istiod on TCP 15012 (frontend-allow). New pods do not become ready while these policies apply: their sidecar waits for configuration from istiod.',
  ]);
});

it('answers undefined for a workload the graph does not have', () => {
  expect(workloadDetail(clusterGraph(SHOP), 'shop/Deployment/nothing', new Set())).toBe(undefined);
});

describe('the detail summary', () => {
  const extraCart = networkPolicy('shop', 'cart-extra', { podSelector: app('cart'), policyTypes: ['Ingress', 'Egress'] });
  const postgresOut = networkPolicy('payments', 'postgres-out', { podSelector: app('postgres'), policyTypes: ['Egress'] });
  const recommenderOut = networkPolicy('shop', 'recommender-out', { podSelector: app('recommender'), policyTypes: ['Egress'] });
  const recommenderZeta = authorizationPolicy('shop', 'recommender-zeta', { selector: app('recommender'), rules: [{}] });
  const recommenderCallers = authorizationPolicy('shop', 'recommender-callers', { selector: app('recommender'), rules: [{}] });
  const outsideMesh: ClusterResources = { ...SHOP, pods: SHOP.pods.map((p) => (p.workload.name === 'recommender' ? { ...p, mesh: 'none' } : p)) };
  it.each<[string, ClusterResources, string, string]>([
    [
      'the same policy covers both directions, and an Istio policy decides the requests',
      SHOP,
      cart,
      'Everything else is blocked in both directions, because cart-allow covers ingress and egress. Istio also decides which requests reach it: cart-callers.',
    ],
    [
      'the same policies cover both directions',
      withPolicies(SHOP, extraCart),
      cart,
      'Everything else is blocked in both directions, because cart-allow and cart-extra cover ingress and egress. Istio also decides which requests reach it: cart-callers.',
    ],
    [
      'only Istio policies select it, named in sorted order',
      withPolicies(SHOP, recommenderZeta, recommenderCallers),
      recommender,
      'No NetworkPolicy selects it, so the network lets everything reach it and it may call anything. Istio also decides which requests reach it: recommender-callers, recommender-zeta.',
    ],
    [
      'an Istio policy on a workload outside the mesh is not enforced, so it is not named',
      withPolicies(outsideMesh, recommenderCallers),
      recommender,
      'No NetworkPolicy selects it, so the network lets everything reach it and it may call anything.',
    ],
    ['a different policy for each direction', withPolicies(SHOP, postgresOut), postgres, 'Everything else is blocked in both directions: postgres-allow covers ingress and postgres-out covers egress.'],
    ['ingress only', SHOP, postgres, 'Everything else is blocked from calling it, because postgres-allow covers ingress. It may call anything.'],
    ['egress only', withPolicies(SHOP, recommenderOut), recommender, 'It may call nothing else, because recommender-out covers egress. Anything may call it.'],
    ['neither', SHOP, recommender, 'No NetworkPolicy selects it, so the network lets everything reach it and it may call anything.'],
    [
      'NetworkPolicies netatlas may not read, which never reads as no policy',
      { ...SHOP, networkPolicies: [], readErrors: [{ kind: 'networkpolicies', reason: 'forbidden' }] },
      recommender,
      "Cannot read NetworkPolicies: netatlas's role does not allow it.",
    ],
  ])('summary %#: %s', (_name, r, id, expected) => {
    expect(workloadDetail(clusterGraph(r), id, new Set())?.summary).toBe(expected);
  });
});
