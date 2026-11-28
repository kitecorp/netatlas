import { describe, expect, it } from 'vitest';
import { ago, DEV, EDGE, EDGE_SINCE, PROD } from './fixtures/clusters';
import { WITH_ISTIOD } from './fixtures/shop';
import { matchesSearch, needsAttention, overviewRows, overviewTotals, policyCountText, totalNote } from './overview';
import type { ClusterResources, ClusterSnapshot } from './types';

const CONNECTING: ClusterSnapshot = { name: 'new-1', status: { state: 'connecting' }, synced: false };

/** `s` with its resources changed by `change`. */
const withResources = (s: ClusterSnapshot, change: (r: ClusterResources) => ClusterResources): ClusterSnapshot => {
  if (!s.resources) throw new Error(`${s.name} has no resources`);
  return { ...s, resources: change(s.resources) };
};

it('gives one row per cluster', () => {
  expect(overviewRows([PROD, EDGE, CONNECTING])).toStrictEqual([
    {
      kind: 'reachable',
      name: 'prod-eu-1',
      kubernetes: '1.37',
      workloads: 7,
      policies: { read: 7, cannotRead: [] },
      networkPolicies: 5,
      noPolicy: 2,
      enforcer: 'Calico',
      istio: 'sidecars',
      reading: false,
      dataAt: ago(4_000),
      cannotRead: [],
      meshEgress: [],
    },
    {
      kind: 'unreachable',
      name: 'edge-ap',
      since: EDGE_SINCE,
      reason: 'the API server stopped answering',
      dataAt: ago(720_000),
      workloads: 31,
      policies: { read: 4, cannotRead: [] },
    },
    { kind: 'connecting', name: 'new-1' },
  ]);
});

it.each<[string, ClusterSnapshot, Record<string, unknown>]>([
  ['an EKS version gives its major.minor', DEV, { kubernetes: '1.37' }],
  ['no enforcer found', DEV, { enforcer: 'none found: policies may not be enforced', noPolicy: 31, workloads: 32 }],
  ['a reachable cluster not read yet is still connecting', { ...PROD, resources: undefined, syncedAt: undefined, synced: false }, { kind: 'connecting', name: 'prod-eu-1' }],
  // The data age has one source, the time the reader last held the cluster's state, on every page.
  ['a reachable cluster whose reader starts again shows how old its data is', { ...PROD, syncedAt: ago(180_000), synced: false }, { reading: true, dataAt: ago(180_000) }],
])('reachable row %#: %s', (_name, snapshot, expected) => {
  const [row] = overviewRows([snapshot]);
  expect(Object.fromEntries(Object.keys(expected).map((k) => [k, (row as Record<string, unknown> | undefined)?.[k]]))).toStrictEqual(expected);
});

it.each<[string, ClusterSnapshot, Record<string, unknown>]>([
  [
    'unreachable and never seen keeps nulls for what it does not know',
    { name: 'far-1', status: { state: 'unreachable', since: ago(30_000), reason: 'the API server refused the connection' }, synced: false },
    { kind: 'unreachable', name: 'far-1', since: ago(30_000), reason: 'the API server refused the connection', dataAt: null, workloads: null, policies: null },
  ],
  [
    'unreachable counts its data from the reader, not from the last answer of the API server',
    { ...EDGE, status: { state: 'unreachable', since: EDGE_SINCE, reason: 'the API server stopped answering', lastSeen: ago(60_000) }, syncedAt: ago(10_800_000) },
    { kind: 'unreachable', name: 'edge-ap', since: EDGE_SINCE, reason: 'the API server stopped answering', dataAt: ago(10_800_000), workloads: 31, policies: { read: 4, cannotRead: [] } },
  ],
])('unreachable row %#: %s', (_name, snapshot, expected) => {
  expect(overviewRows([snapshot])).toStrictEqual([expected]);
});

describe('a kind netatlas may not read says so and never counts as no policy', () => {
  it.each<[string, ClusterSnapshot, Record<string, unknown>]>([
    [
      'a 403 on AuthorizationPolicies',
      withResources(PROD, (r) => ({ ...r, authorizationPolicies: [], readErrors: [{ kind: 'authorizationpolicies', reason: 'forbidden' }] })),
      { policies: { read: 5, cannotRead: ['authorizationpolicies'] }, noPolicy: null, cannotRead: ["Cannot read AuthorizationPolicies: netatlas's role does not allow it."] },
    ],
    [
      'a 403 on NetworkPolicies and pods',
      withResources(PROD, (r) => ({
        ...r,
        pods: [],
        networkPolicies: [],
        readErrors: [
          { kind: 'pods', reason: 'forbidden' },
          { kind: 'networkpolicies', reason: 'forbidden' },
        ],
      })),
      {
        workloads: null,
        policies: { read: 2, cannotRead: ['networkpolicies'] },
        networkPolicies: null,
        noPolicy: null,
        cannotRead: ["Cannot read Pods: netatlas's role does not allow it.", "Cannot read NetworkPolicies: netatlas's role does not allow it."],
      },
    ],
    [
      'a 403 on NetworkPolicies where Istio is not installed reads no policy at all',
      withResources(DEV, (r) => ({ ...r, networkPolicies: [], readErrors: [{ kind: 'networkpolicies', reason: 'forbidden' }] })),
      { policies: { read: null, cannotRead: ['networkpolicies'] }, networkPolicies: null, noPolicy: null },
    ],
    [
      'a 403 on DaemonSets says the enforcer and the Istio mode cannot be read',
      withResources(PROD, (r) => ({ ...r, enforcer: null, readErrors: [{ kind: 'daemonsets', reason: 'forbidden' }] })),
      { enforcer: 'cannot read', istio: 'cannot read', cannotRead: ["Cannot read DaemonSets: netatlas's role does not allow it."] },
    ],
  ])('cannot read %#: %s', (_name, snapshot, expected) => {
    const [row] = overviewRows([snapshot]);
    expect(Object.fromEntries(Object.keys(expected).map((k) => [k, (row as Record<string, unknown> | undefined)?.[k]]))).toStrictEqual(expected);
  });
});

it('totals the reachable clusters and counts the unreachable', () => {
  expect(overviewTotals(overviewRows([PROD, DEV, EDGE]))).toStrictEqual({
    clusters: 3,
    unreachable: 1,
    workloads: { value: 39, missing: [] },
    policies: { value: 10, missing: [] },
    noPolicy: { value: 33, missing: [] },
  });
});

it('never adds a count netatlas could not read to a total as nothing', () => {
  const noIstio = withResources(PROD, (r) => ({ ...r, authorizationPolicies: [], readErrors: [{ kind: 'authorizationpolicies', reason: 'forbidden' }] }));
  expect(overviewTotals(overviewRows([noIstio, DEV]))).toStrictEqual({
    clusters: 2,
    unreachable: 0,
    workloads: { value: 39, missing: [] },
    policies: { value: 8, missing: ['prod-eu-1'] },
    noPolicy: { value: 31, missing: ['prod-eu-1'] },
  });
});

it.each<[string, Parameters<typeof policyCountText>, string]>([
  ['every kind read, in a cell', [{ read: 7, cannotRead: [] }, 'cell'], '7'],
  ['one kind refused, in a cell', [{ read: 2, cannotRead: ['authorizationpolicies'] }, 'cell'], '2 · cannot read AuthorizationPolicies'],
  ['nothing read, in a cell', [{ read: null, cannotRead: ['networkpolicies', 'authorizationpolicies'] }, 'cell'], 'cannot read NetworkPolicies and AuthorizationPolicies'],
  ['every kind read, in a sentence', [{ read: 1, cannotRead: [] }, 'sentence'], '1 policy'],
  ['one kind refused, in a sentence', [{ read: 4, cannotRead: ['networkpolicies'] }, 'sentence'], '4 policies, cannot read NetworkPolicies'],
])('policyCountText %#: %s', (_name, args, expected) => {
  expect(policyCountText(...args)).toBe(expected);
});

it.each<[string, Parameters<typeof totalNote>, string]>([
  ['a whole total', [{ value: 10, missing: [] }, 'NetworkPolicy and Istio'], 'NetworkPolicy and Istio'],
  ['a total missing two clusters', [{ value: 8, missing: ['dev-eu', 'prod-eu-1'] }, 'NetworkPolicy and Istio'], 'NetworkPolicy and Istio, not counting what netatlas cannot read in dev-eu and prod-eu-1'],
])('totalNote %#: %s', (_name, args, expected) => {
  expect(totalNote(...args)).toBe(expected);
});

const ONE_OPEN = withResources(DEV, (r) => ({ ...r, pods: r.pods.filter((p) => p.name.startsWith('svc-01-') || p.name.startsWith('web-')), networkPolicies: r.networkPolicies.slice(0, 1) }));

it.each<[string, ClusterSnapshot[], { title: string; text: string }[]]>([
  [
    'over prod, dev and edge',
    [PROD, DEV, EDGE],
    [
      { title: 'Policies not enforced', text: 'dev-eu has 3 NetworkPolicies, but no enforcer was found, so they may do nothing.' },
      { title: 'Open workloads', text: '33 workloads in 2 clusters have no policy, so anything may call them. Most are in dev-eu (31).' },
    ],
  ],
  [
    'singular forms',
    [ONE_OPEN],
    [
      { title: 'Policies not enforced', text: 'dev-eu has 1 NetworkPolicy, but no enforcer was found, so it may do nothing.' },
      { title: 'Open workloads', text: '1 workload in 1 cluster has no policy, so anything may call it.' },
    ],
  ],
  [
    'no Most are in clause when one cluster holds them all',
    [DEV, EDGE],
    [
      { title: 'Policies not enforced', text: 'dev-eu has 3 NetworkPolicies, but no enforcer was found, so they may do nothing.' },
      { title: 'Open workloads', text: '31 workloads in 1 cluster have no policy, so anything may call them.' },
    ],
  ],
  ['nothing left', [EDGE, CONNECTING], [{ title: '', text: 'Nothing needs attention.' }]],
  [
    'a kind netatlas cannot read, with nothing else to look at',
    [withResources(PROD, (r) => ({ ...r, pods: [], readErrors: [{ kind: 'pods', reason: 'forbidden' }] }))],
    [{ title: 'Cannot read', text: "prod-eu-1: Cannot read Pods: netatlas's role does not allow it." }],
  ],
])('needsAttention %#: %s', (_name, snapshots, expected) => {
  expect(needsAttention(overviewRows(snapshots))).toStrictEqual(expected);
});

// cart and api leave the mesh, so only frontend's sidecar misses istiod; the refused DaemonSets add a Cannot read item.
const FRONTEND_GAP: ClusterSnapshot = {
  ...PROD,
  name: 'shop',
  resources: {
    ...WITH_ISTIOD,
    pods: WITH_ISTIOD.pods.map((p) => (p.workload.name === 'cart' || p.workload.name === 'api' ? { ...p, mesh: 'none' } : p)),
    readErrors: [{ kind: 'daemonsets', reason: 'forbidden' }],
  },
};

it('names what keeps a workload from istiod after the open workloads and before what cannot be read', () => {
  const items = needsAttention(overviewRows([FRONTEND_GAP]));
  expect([items.map((i) => i.title), items.filter((i) => i.title === 'Egress the mesh needs')]).toStrictEqual([
    ['Open workloads', 'Egress the mesh needs', 'Cannot read'],
    [{ title: 'Egress the mesh needs', text: 'shop: shop / frontend cannot reach istiod on TCP 15012 (frontend-allow). New pods do not become ready while these policies apply: their sidecar waits for configuration from istiod.' }],
  ]);
});

describe('matchesSearch', () => {
  it.each<[string, string, string[]]>([
    ['nothing, which keeps every cluster', '  ', ['prod-eu-1', 'dev-eu', 'edge-ap', 'new-1']],
    ['part of a cluster name, ignoring case', 'EU', ['prod-eu-1', 'dev-eu']],
    ['a workload name', 'recommender', ['prod-eu-1']],
    ['a policy name', 'web-3', ['dev-eu', 'edge-ap']],
    ['an Istio policy name', 'cart-callers', ['prod-eu-1']],
    ['nothing any cluster has', 'zzz', []],
  ])('keeps the clusters matching %s', (_name, query, expected) => {
    expect([PROD, DEV, EDGE, CONNECTING].filter((c) => matchesSearch(c, query)).map((c) => c.name)).toStrictEqual(expected);
  });
});
