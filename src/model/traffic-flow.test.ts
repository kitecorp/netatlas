import { describe, expect, it } from 'vitest';
import { OUTSIDE } from './classes';
import { authorizationPolicy, RECOMMENDER_DENY, SHOP, withPolicies } from './fixtures/shop';
import { call, requests, SHOP_ROWS, SHOP_TRAFFIC, WAYPOINT, withFigures, type TrafficCase } from './fixtures/traffic';
import { toFlow } from './flow';
import { clusterGraph } from './graph';
import { OUTSIDE_MESH, trafficModel, type TrafficModel } from './traffic';
import { extraFlowNodes, TRAFFIC_LEGEND, trafficEdges, trafficNodes } from './traffic-flow';
import type { ClusterResources } from './types';

const frontend = 'shop/Deployment/frontend';
const cart = 'shop/Deployment/cart';
const recommender = 'shop/Deployment/recommender';
const api = 'payments/Deployment/api';
const postgres = 'payments/Deployment/postgres';
const search = 'unseen:shop/search';

const BOTH = { networkpolicy: true, istio: true };

const SHOP_CASE: TrafficCase = { resources: SHOP, traffic: SHOP_TRAFFIC };
/** postgres to recommender with its closed connections alone: no request and no byte read. */
const CONNECTIONS_ONLY: TrafficCase = { resources: SHOP, traffic: withFigures({ closed: [SHOP_ROWS.m] }) };

/** postgres's requests to recommender, 4 a second, each answered 200. */
const postgresToRecommender = requests(call('source', 'payments/postgres', 'shop/recommender'), '200', '-', 4);
/** recommender's only Istio policy a DENY of one address on one port, and no figures: postgres to recommender had no calls in 24 hours. */
const ONLY_A_DENY_IDLE: TrafficCase = { resources: withPolicies(SHOP, RECOMMENDER_DENY), traffic: withFigures({}) };
/** The same policy, and postgres's requests to recommender. */
const ONLY_A_DENY_CALLED: TrafficCase = { resources: withPolicies(SHOP, RECOMMENDER_DENY), traffic: withFigures({ requests: [postgresToRecommender] }) };
/** recommender's only Istio policy a DENY of frontend's calls, which does not name postgres, and postgres's requests to recommender. */
const A_DENY_OF_ANOTHER_CALLED: TrafficCase = {
  resources: withPolicies(
    SHOP,
    authorizationPolicy('shop', 'recommender-refuses-frontend', {
      selector: { matchLabels: { app: 'recommender' } },
      action: 'DENY',
      rules: [{ from: [{ source: { principals: ['cluster.local/ns/shop/sa/frontend'] } }] }],
    }),
  ),
  traffic: withFigures({ requests: [postgresToRecommender] }),
};

/** A case's traffic model; each case here carries figures, so the model exists. */
function modelOf({ resources, traffic }: TrafficCase): TrafficModel {
  const m = trafficModel(resources, traffic);
  if (!m) throw new Error('the case carries figures, so trafficModel gives a model');
  return m;
}

const shopModel = () => modelOf(SHOP_CASE);

/** Every node of the cluster drawn: each workload by its name, the Internet, and the model's extra nodes by their labels. */
function everyName(r: ClusterResources, m: TrafficModel): ReadonlyMap<string, string> {
  return new Map([
    ...clusterGraph(r).namespaces.flatMap((n) => n.workloads.map((w) => [w.id, w.name] as const)),
    [OUTSIDE, 'Internet'] as const,
    ...m.extraNodes.map((n) => [n.id, n.label] as const),
  ]);
}

/** A case's traffic edges with every node drawn but the workloads of namespace `hidden`, as the page leaves them out. */
function edgesOf(c: TrafficCase, compare: boolean, hidden?: string) {
  const m = modelOf(c);
  const names = new Map([...everyName(c.resources, m)].filter(([id]) => hidden === undefined || !id.startsWith(`${hidden}/`)));
  return trafficEdges(m, { compare, visible: new Set(names.keys()), names });
}

const shopEdges = (compare: boolean) => edgesOf(SHOP_CASE, compare);

describe('trafficEdges', () => {
  it.each<[boolean, string, string, string, string, TrafficCase?]>([
    [true, cart, api, 'From cart to api, 6 requests a second, 2.1 percent errors, allowed by a policy', '6 req/s · 2.1% errors'],
    [true, postgres, recommender, 'From postgres to recommender, 18 kilobytes a second over TCP, covered by no policy', '18 kB/s'],
    [true, recommender, postgres, 'From recommender to postgres, allowed by a policy, no calls recorded in the last 24 hours', 'no traffic, 24 h'],
    [true, api, postgres, 'From api to postgres, allowed by a policy, no calls in the last 5 minutes', 'no traffic, 5 min'],
    [
      true,
      OUTSIDE_MESH,
      frontend,
      'From Callers outside the mesh to frontend, 52 requests a second, the callers are outside the mesh, so netatlas cannot tell which workloads they are',
      '52 req/s',
    ],
    [true, api, OUTSIDE, 'From api to Internet, 0.5 requests a second, leaves the cluster: see the Outbound view', '0.5 req/s'],
    [true, cart, recommender, 'From cart to recommender, 1 request a second, 100 percent errors, refused by the network', '1 req/s · 100% errors'],
    [true, frontend, search, 'From frontend to search, 1 request a second, not running now', '1 req/s'],
    // Without the comparison an edge says only what was measured.
    [false, cart, api, 'From cart to api, 6 requests a second, 2.1 percent errors', '6 req/s · 2.1% errors'],
    // Closed connections are the one figure read, so they are what the edge says.
    [true, postgres, recommender, 'From postgres to recommender, 0.2 connections a second, covered by no policy', '0.2 conn/s', CONNECTIONS_ONLY],
    // Behind a waypoint an idle edge does not claim there was no traffic. (frontend to cart has no idle edge there:
    // ztunnel cannot read cart-callers' HTTP rule, so Istio refuses the pair.)
    [true, recommender, postgres, 'From recommender to postgres, allowed by a policy, traffic not measured, depends: traffic through waypoints is not attributed yet', 'not measured', WAYPOINT],
    // recommender's only Istio policies are DENY policies, which allow nothing: Istio lets postgres in because no ALLOW
    // policy selects recommender (istio/api security/v1beta1/authorization_policy.proto:31 at 97748e4). The edge says
    // so, and never that a policy allows the call, idle or called, whether or not the DENY policy could refuse postgres.
    [
      true,
      postgres,
      recommender,
      'From postgres to recommender, no ALLOW policy selects recommender, so Istio lets in every request that recommender-deny does not refuse, no calls recorded in the last 24 hours',
      'no traffic, 24 h',
      ONLY_A_DENY_IDLE,
    ],
    [
      true,
      postgres,
      recommender,
      'From postgres to recommender, 4 requests a second, no ALLOW policy selects recommender, so Istio lets in every request that recommender-deny does not refuse',
      '4 req/s',
      ONLY_A_DENY_CALLED,
    ],
    [
      true,
      postgres,
      recommender,
      'From postgres to recommender, 4 requests a second, no ALLOW policy selects recommender, so Istio lets in every request that recommender-refuses-frontend does not refuse',
      '4 req/s',
      A_DENY_OF_ANOTHER_CALLED,
    ],
  ])('labels the edge %#: compare %s, from %s to %s', (compare, from, to, ariaLabel, label, c = SHOP_CASE) => {
    const drawn = edgesOf(c, compare).filter((e) => e.source === from && e.target === to);
    expect(drawn.map((e) => ({ kind: e.kind, ariaLabel: e.ariaLabel, label: e.label }))).toStrictEqual([{ kind: 'traffic', ariaLabel, label }]);
  });

  it('leaves out the idle edges without the comparison: 9 edges, against 11 with it', () => {
    const pairs = (compare: boolean) => shopEdges(compare).map((e) => `${e.source} to ${e.target}`);
    const off = pairs(false), on = pairs(true);
    expect({ off: off.length, on: on.length, leftOut: on.filter((p) => !off.includes(p)).sort() }).toStrictEqual({
      off: 9,
      on: 11,
      leftOut: [`${api} to ${postgres}`, `${recommender} to ${postgres}`],
    });
  });

  // cart to api crosses from shop to payments. The Internet and the model's extra nodes, search among them, are always drawn.
  it.each<[string, string, string[]]>([
    // cart to api and recommender to postgres lose their callee; api's and postgres's own edges lose their caller.
    ['the callee\'s side of cart to api', 'payments', [`${OUTSIDE_MESH} to ${frontend}`, `${cart} to ${recommender}`, `${frontend} to ${cart}`, `${frontend} to ${recommender}`, `${frontend} to ${search}`]],
    // cart's, frontend's and recommender's edges lose their caller; the edges into frontend, cart and recommender lose their callee.
    ['the caller\'s side of cart to api', 'shop', [`${api} to ${OUTSIDE}`, `${api} to ${postgres}`]],
  ])('leaves out an edge with either end in a hidden namespace %#: %s, %s hidden', (_side, hidden, expected) => {
    expect(edgesOf(SHOP_CASE, true, hidden).map((e) => `${e.source} to ${e.target}`)).toStrictEqual(expected);
  });
});

it('explains every look of the comparison in eight lines, the grey one last', () => {
  expect(TRAFFIC_LEGEND).toStrictEqual([
    { mark: 'allowed', text: 'traffic seen, and a policy allows it' },
    { mark: 'uncovered', text: 'traffic seen, no policy covers it' },
    { mark: 'unused', text: 'allowed by a policy, no traffic seen' },
    { mark: 'refused-istio', text: 'refused by Istio' },
    { mark: 'refused-network', text: 'refused by the network' },
    { mark: 'answered-denied', text: 'answered though the policies now deny it' },
    { mark: 'outbound', text: 'leaves the cluster' },
    { mark: 'not-evaluated', text: 'not compared with the policies, or not measured' },
  ]);
});

describe('trafficNodes', () => {
  // kube-system, which holds coredns, is hidden by default, so every namespace is shown here.
  const shop = () => {
    const g = clusterGraph(SHOP);
    const nodes = toFlow(g, { hidden: new Set(), show: BOTH }).nodes;
    return { nodes, drawn: trafficNodes(nodes, g) };
  };

  it.each<[string, string]>([
    ['frontend', '2 pods · in the mesh'],
    ['gateway', '2 pods · not in the mesh'],
    ['coredns', '2 pods · not in the mesh · no policy'],
    ['recommender', '1 pod · no policy'],
  ])('says whether %s is in the mesh, and when no policy selects it: %s', (label, expected) => {
    expect(shop().drawn.find((n) => n.label === label)?.sub).toBe(expected);
  });

  it("drops the marks of what a workload's policies leave open", () => {
    const { nodes, drawn } = shop();
    const postgresMarks = (list: typeof nodes) => list.find((n) => n.label === 'postgres')?.marks;
    // The map marks postgres's open egress; the traffic view does not.
    expect([postgresMarks(nodes), postgresMarks(drawn)]).toStrictEqual([['may call anything'], undefined]);
  });
});

it("draws the model's extra nodes as the Internet node is drawn", () => {
  expect(extraFlowNodes(shopModel())).toStrictEqual([
    { id: OUTSIDE_MESH, type: 'outside', label: 'Callers outside the mesh', sub: 'no proxy, so no workload name', tone: 'normal' },
    { id: search, type: 'outside', label: 'search', sub: 'shop · not running now', tone: 'normal' },
  ]);
});
