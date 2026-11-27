import { describe, expect, it } from 'vitest';
import { DEV, PROD } from './fixtures/clusters';
import { authorizationPolicy, networkPolicy, SHOP, withPolicies } from './fixtures/shop';
import { coverage, missingPolicyText, policyRows } from './policies';
import type { ClusterResources, ClusterSnapshot, NetworkPolicyObject, PolicyRef } from './types';

const np = (namespace: string, name: string): PolicyRef => ({ kind: 'NetworkPolicy', namespace, name });
const ap = (namespace: string, name: string): PolicyRef => ({ kind: 'AuthorizationPolicy', namespace, name });

const cartAllow = SHOP.networkPolicies.find((p) => p.metadata.name === 'cart-allow') as NetworkPolicyObject;
const CART_PODS = ['cart-6d5f7c9b8-4xkqz', 'cart-6d5f7c9b8-9wjm2', 'cart-6d5f7c9b8-tn7hc'];
const withShop = (r: ClusterResources): ClusterSnapshot => ({ ...PROD, resources: r });

it('lists the policies a search for cart finds, each with its link', () => {
  expect(policyRows([PROD], { query: 'cart' })).toStrictEqual([
    {
      cluster: 'prod-eu-1',
      rows: [
        { namespace: 'shop', name: 'cart-allow', kind: 'NetworkPolicy', covers: ['Deployment cart'], notes: [], href: '/policies/prod-eu-1/shop/networkpolicies/cart-allow' },
        { namespace: 'shop', name: 'cart-callers', kind: 'AuthorizationPolicy', covers: ['Deployment cart'], notes: [], href: '/policies/prod-eu-1/shop/authorizationpolicies/cart-callers' },
      ],
      cannotRead: [],
      empty: 'No policy matches the search.',
    },
  ]);
});

// A kind netatlas may not read is never "no policies": the group says it cannot read it.
describe('the policy list of a cluster whose role refuses a policy kind', () => {
  const refuse = (r: ClusterResources, ...kinds: ('networkpolicies' | 'authorizationpolicies')[]): ClusterResources => ({
    ...r,
    ...(kinds.includes('networkpolicies') ? { networkPolicies: [] } : {}),
    ...(kinds.includes('authorizationpolicies') ? { authorizationPolicies: [] } : {}),
    readErrors: kinds.map((kind) => ({ kind, reason: 'forbidden' as const })),
  });
  it.each<[string, ClusterSnapshot, { rows: number; cannotRead: string[]; empty: string }]>([
    ['every kind read', PROD, { rows: 7, cannotRead: [], empty: 'This cluster has no policies.' }],
    [
      'NetworkPolicies refused, with no Istio',
      withShop({ ...refuse(SHOP, 'networkpolicies'), authorizationPolicies: 'not-installed' }),
      { rows: 0, cannotRead: ["Cannot read NetworkPolicies: netatlas's role does not allow it."], empty: '' },
    ],
    [
      'AuthorizationPolicies refused, NetworkPolicies read',
      withShop(refuse(SHOP, 'authorizationpolicies')),
      { rows: 5, cannotRead: ["Cannot read AuthorizationPolicies: netatlas's role does not allow it."], empty: 'No NetworkPolicies in this cluster.' },
    ],
    ['nothing read yet', { name: 'new-1', status: { state: 'connecting' }, synced: false }, { rows: 0, cannotRead: [], empty: 'netatlas has not read new-1 yet.' }],
  ])('refused %#: %s', (_name, c, expected) => {
    const [g] = policyRows([c], {});
    expect(g && { rows: g.rows.length, cannotRead: g.cannotRead, empty: g.empty }).toStrictEqual(expected);
  });

  it.each<[string, ClusterResources | undefined, 'NetworkPolicy' | 'AuthorizationPolicy', string]>([
    ['a policy that went away', SHOP, 'NetworkPolicy', 'This policy is no longer in the cluster.'],
    ['a NetworkPolicy of a refused kind', refuse(SHOP, 'networkpolicies'), 'NetworkPolicy', "Cannot read NetworkPolicies: netatlas's role does not allow it."],
    ['an AuthorizationPolicy of a refused kind', refuse(SHOP, 'authorizationpolicies'), 'AuthorizationPolicy', "Cannot read AuthorizationPolicies: netatlas's role does not allow it."],
    ['a cluster not read yet', undefined, 'NetworkPolicy', 'netatlas has not read prod-eu-1 yet.'],
  ])('missingPolicyText %#: %s', (_name, r, kind, expected) => {
    expect(missingPolicyText('prod-eu-1', r, kind)).toBe(expected);
  });
});

const waypoint = authorizationPolicy('shop', 'cart-waypoint', { targetRefs: [{ kind: 'Gateway', name: 'waypoint' }], rules: [{}] });
const gatewayCallers = authorizationPolicy('ingress', 'gateway-callers', { selector: { matchLabels: { app: 'gateway' } }, rules: [{}] });

it.each<[string, ClusterSnapshot[], { cluster?: string; query?: string }, [string, string[]][]]>([
  ['a cluster filter keeps that cluster only', [PROD, DEV], { cluster: 'dev-eu' }, [['dev-eu', ['web-1', 'web-2', 'web-3']]]],
  ['a query matches a selector label', [PROD], { query: 'APP=POSTGRES' }, [['prod-eu-1', ['postgres-allow']]]],
  ['a query matches a namespace', [PROD, DEV], { query: 'payments' }, [['prod-eu-1', ['api-allow', 'api-callers', 'postgres-allow']], ['dev-eu', []]]],
  ['a cluster with no data yet gives no rows', [{ ...PROD, resources: undefined }], {}, [['prod-eu-1', []]]],
])('policyRows %#: %s', (_name, clusters, filter, expected) => {
  expect(policyRows(clusters, filter).map((g) => [g.cluster, g.rows.map((r) => r.name)])).toStrictEqual(expected);
});

it.each<[string, ClusterResources, string, { covers: string[]; notes: string[] }]>([
  ['a waypoint policy is not evaluated', withPolicies(SHOP, waypoint), 'cart-waypoint', { covers: [], notes: ['Not evaluated: attached to a waypoint.'] }],
  ['an Istio policy on a workload outside the mesh is not enforced', withPolicies(SHOP, gatewayCallers), 'gateway-callers', { covers: ['Deployment gateway'], notes: ['Istio not enforced'] }],
])('policy notes %#: %s', (_name, r, name, expected) => {
  const row = policyRows([withShop(r)], { query: name })[0]?.rows.find((x) => x.name === name);
  expect(row && { covers: row.covers, notes: row.notes }).toStrictEqual(expected);
});

const twoCartPods: ClusterResources = {
  ...SHOP,
  pods: SHOP.pods.map((p) => (p.name === CART_PODS[0] || p.name === CART_PODS[1] ? { ...p, labels: { ...p.labels, version: '2' } } : p)),
};

it.each<[string, NetworkPolicyObject, ClusterResources, ReturnType<typeof coverage>]>([
  [
    "SHOP's cart-allow",
    cartAllow,
    SHOP,
    { chips: ['app = cart'], pods: CART_PODS, matchLine: '3 pods match now', workloadsLine: 'All of Deployment cart. Not covered: frontend, recommender.', alsoCoveredBy: [ap('shop', 'cart-callers')] },
  ],
  [
    'part of a workload',
    networkPolicy('shop', 'cart-v2', { podSelector: { matchLabels: { app: 'cart', version: '2' } } }),
    twoCartPods,
    {
      chips: ['app = cart', 'version = 2'],
      pods: CART_PODS.slice(0, 2),
      matchLine: '2 pods match now',
      workloadsLine: 'Part of Deployment cart (2 of 3 pods). Not covered: frontend, recommender.',
      alsoCoveredBy: [np('shop', 'cart-allow'), ap('shop', 'cart-callers')],
    },
  ],
  [
    'one pod',
    networkPolicy('shop', 'recommender-x', { podSelector: { matchLabels: { app: 'recommender' } } }),
    SHOP,
    { chips: ['app = recommender'], pods: ['recommender-8f6b5d4c7-z5p9k'], matchLine: '1 pod matches now', workloadsLine: 'All of Deployment recommender. Not covered: cart, frontend.', alsoCoveredBy: [] },
  ],
  [
    'expressions as chips',
    networkPolicy('shop', 'web-or-mobile', {
      podSelector: {
        matchExpressions: [
          { key: 'app', operator: 'In', values: ['web', 'mobile'] },
          { key: 'tier', operator: 'Exists' },
          { key: 'zone', operator: 'NotIn', values: ['a'] },
          { key: 'legacy', operator: 'DoesNotExist' },
        ],
      },
    }),
    SHOP,
    {
      chips: ['app in (web, mobile)', 'tier exists', 'zone not in (a)', 'legacy does not exist'],
      pods: [],
      matchLine: '0 pods match now',
      workloadsLine: 'Not covered: cart, frontend, recommender.',
      alsoCoveredBy: [],
    },
  ],
])('coverage %#: %s', (_name, p, r, expected) => {
  expect(coverage(p, r)).toStrictEqual(expected);
});
