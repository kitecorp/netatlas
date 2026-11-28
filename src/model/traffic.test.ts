import { expect, it } from 'vitest';
import { authorizationPolicy, deployment, MESH_DENY_ADMIN, networkPolicy, RECOMMENDER_DENY, SHOP, withPolicies } from './fixtures/shop';
import { AMBIENT, bytes, call, closed, EGRESS_GATEWAY, INGRESS, requests, SHOP_ROWS, SHOP_TRAFFIC, WAYPOINT, withFigures, type TrafficCase } from './fixtures/traffic';
import { trafficModel, type EdgeFigures, type ExtraNode, type StandsOutGroup, type TrafficEdge, type TrafficMark } from './traffic';
import type { TrafficSnapshot } from './traffic-status';
import type { ClusterResources, Mesh, PolicyRef } from './types';

const gateway = 'ingress/Deployment/gateway';
const frontend = 'shop/Deployment/frontend';
const cart = 'shop/Deployment/cart';
const recommender = 'shop/Deployment/recommender';
const api = 'payments/Deployment/api';
const postgres = 'payments/Deployment/postgres';
const egressGateway = 'istio-system/Deployment/istio-egressgateway';

const np = (namespace: string, name: string): PolicyRef => ({ kind: 'NetworkPolicy', namespace, name });
const requestsOnly = (requests: number, errors = 0) => ({ requests, errors, requestBytes: 0, responseBytes: 0, connections: 0 });
/** The id of an edge, which keys its item under What stands out: its two ends' ids as a JSON pair. */
const edgeId = (from: string, to: string) => JSON.stringify([from, to]);

/** SHOP_TRAFFIC with recommender's pod outside the mesh. */
const RECOMMENDER_UNMESHED: ClusterResources = { ...SHOP, pods: SHOP.pods.map((p) => (p.workload.name === 'recommender' ? { ...p, mesh: 'none' } : p)) };

it('edges of the shop\'s traffic', () => {
  // The gateway-to-frontend and every to-coredns edge are absent: the gateway is not meshed, and coredns is kube-dns.
  expect(trafficModel(SHOP, SHOP_TRAFFIC)?.edges.map((e) => [e.from, e.to, e.mark, e.figures, e.notes, e.label])).toStrictEqual([
    ['outside-mesh', frontend, 'not-evaluated', requestsOnly(52), ['the callers are outside the mesh, so netatlas cannot tell which workloads they are'], ''],
    [api, 'outside', 'outbound', requestsOnly(0.5), [], ''],
    [api, postgres, 'quiet', null, [], 'TCP 5432'],
    [api, cart, 'refused-istio', requestsOnly(0.5), [], ''],
    [postgres, recommender, 'uncovered', { requests: 0, errors: 0, requestBytes: 9000, responseBytes: 9000, connections: 0.2 }, [], ''],
    [cart, api, 'allowed', requestsOnly(6, 0.126), [], ''],
    [cart, recommender, 'refused-network', requestsOnly(1, 1), [], ''],
    [frontend, cart, 'allowed', requestsOnly(12), [], ''],
    [frontend, recommender, 'answered-denied', requestsOnly(3), [], ''],
    [frontend, 'unseen:shop/search', 'not-evaluated', requestsOnly(1), ['not running now'], ''],
    [recommender, postgres, 'unused', null, [], 'TCP 5432'],
  ]);
});

// Every group of What stands out, each in its tone: the open colour for traffic no policy covers, the
// warning one for refusals and denied answers.
it('what stands out in the shop\'s traffic', () => {
  const model = trafficModel(SHOP, SHOP_TRAFFIC);
  expect({ standsOut: model?.standsOut, extraNodes: model?.extraNodes }).toStrictEqual({
    standsOut: [
      {
        title: 'Traffic no policy covers',
        tone: 'open',
        items: [{ id: edgeId(postgres, recommender), text: 'postgres calls recommender, 18 kilobytes a second over TCP.', reason: 'No policy restricts calls out of postgres or into recommender.' }],
      },
      {
        title: 'Allowed, not used',
        tone: 'normal',
        items: [{ id: edgeId(recommender, postgres), text: 'recommender may call postgres on TCP 5432.', reason: 'Allowed by postgres-allow. No calls recorded in the last 24 hours.' }],
      },
      { title: 'Errors', tone: 'normal', items: [{ id: edgeId(cart, api), text: 'cart calls api: 2.1% of requests fail.', reason: '6 requests a second over the last 5 minutes.' }] },
      {
        title: 'Refused calls',
        tone: 'warn',
        items: [
          { id: edgeId(api, cart), text: 'api calls cart: refused by Istio.', reason: 'Every answer was a 403, and the Istio policies on cart do not allow api.' },
          { id: edgeId(cart, recommender), text: 'cart calls recommender: refused by the network.', reason: 'No call got an answer: the connection failed, or no upstream was healthy.' },
        ],
      },
      {
        title: 'Answered though the policies deny it',
        tone: 'warn',
        items: [
          {
            id: edgeId(frontend, recommender),
            text: 'frontend calls recommender, 3 requests a second.',
            reason: 'The policies deny this call, yet it was answered: an enforcer may be missing, or a policy is newer than the figures.',
          },
        ],
      },
    ],
    extraNodes: [
      { id: 'outside-mesh', label: 'Callers outside the mesh', sub: 'no proxy, so no workload name' },
      { id: 'unseen:shop/search', label: 'search', sub: 'shop · not running now' },
    ],
  });
});

const TCP_ONLY = 'TCP only: no waypoint';
const THROUGH_WAYPOINT = "through a waypoint: figures per destination need the waypoint's metrics, not read in 0.2.0";
const OUTSIDE_MESH_NODE = { id: 'outside-mesh', label: 'Callers outside the mesh', sub: 'no proxy, so no workload name' };
const tcp = (requestBytes: number, responseBytes: number, connections: number) => ({ requests: 0, errors: 0, requestBytes, responseBytes, connections });
const meshOf = (r: ClusterResources, workload: string, mesh: Mesh): ClusterResources => ({ ...r, pods: r.pods.map((p) => (p.workload.name === workload ? { ...p, mesh } : p)) });

/** WAYPOINT with its waypoint's pod carrying no gateway label, its proxy run as `waypoint`. */
const ROLE_WAYPOINT: TrafficCase = {
  resources: { ...WAYPOINT.resources, pods: WAYPOINT.resources.pods.map((p) => (p.workload.name === 'waypoint' ? { ...p, labels: { app: 'waypoint' }, proxyRole: 'waypoint' } : p)) },
  traffic: WAYPOINT.traffic,
};

const fromGatewayNoProxy = bytes(call('destination', 'ingress/gateway', 'shop/frontend'), 2000);
const postgresToRecommender200 = requests(call('source', 'payments/postgres', 'shop/recommender'), '200', '-', 4);

const client = 'traffic/Deployment/client';

/** SHOP plus the kind battery's load generator, client, in namespace traffic and in the mesh. */
const WITH_CLIENT: ClusterResources = {
  ...SHOP,
  namespaces: [...SHOP.namespaces, { name: 'traffic', labels: { 'kubernetes.io/metadata.name': 'traffic', 'istio-injection': 'enabled' } }],
  pods: [...SHOP.pods, ...deployment('traffic', 'client', ['client-6f9c8d7b5-v4n2x'], []).map((p) => ({ ...p, mesh: 'sidecar' as const }))],
};

/**
 * client's HTTP to the ServiceEntry traffic/outside-http (STATIC, one endpoint), as its sidecar reported it on
 * the kind battery: the destination workload is the entry's endpoint, which Istio names `<entry name>-<index>`.
 */
const toServiceEntry = call('source', 'traffic/client', 'traffic/outside-http-0', { destination_service: 'outside-http.example', destination_service_name: 'outside-http.example' });

type Drawn = { edges: [string, string, TrafficMark, EdgeFigures | null, string[]][]; extraNodes: ExtraNode[] };

// Each list is in edge order: by from, then to.
it.each<[string, TrafficCase, Drawn]>([
  [
    'AMBIENT',
    AMBIENT,
    {
      edges: [
        [api, postgres, 'allowed', tcp(300, 300, 0.1), [TCP_ONLY]],
        // The callee's DENY report is not counted again: the 0.3 is the caller's CONNECT report.
        [api, cart, 'refused-istio', tcp(0, 0, 0.3), [TCP_ONLY]],
        [cart, recommender, 'refused-network', tcp(0, 0, 0.2), [TCP_ONLY]],
        [recommender, 'outside', 'outbound', tcp(500, 500, 0), []],
      ],
      extraNodes: [],
    },
  ],
  // One row: the waypoint's own copy is dropped, and a waypoint is no ingress gateway, so no edge from outside reaches it.
  ['WAYPOINT', WAYPOINT, { edges: [[frontend, 'shop/Deployment/waypoint', 'not-evaluated', tcp(1000, 1000, 0), [THROUGH_WAYPOINT]]], extraNodes: [] }],
  // No gateway label on its pod: its proxy's role alone says waypoint, and it is marked as the labelled one is.
  ['the waypoint known by its role alone', ROLE_WAYPOINT, { edges: [[frontend, 'shop/Deployment/waypoint', 'not-evaluated', tcp(1000, 1000, 0), [THROUGH_WAYPOINT]]], extraNodes: [] }],
  [
    'EGRESS_GATEWAY',
    EGRESS_GATEWAY,
    {
      edges: [
        [egressGateway, 'outside', 'outbound', requestsOnly(2), []],
        [cart, egressGateway, 'answered-denied', requestsOnly(2), ['through the egress gateway: Istio splits this link in two']],
      ],
      extraNodes: [],
    },
  ],
  // The edge from outside carries what the gateway forwarded.
  [
    'INGRESS',
    INGRESS,
    {
      edges: [
        [gateway, frontend, 'allowed', requestsOnly(52), []],
        ['outside', gateway, 'not-evaluated', requestsOnly(52), ['what the gateway forwarded: Istio records nothing for the hop into a gateway']],
      ],
      extraNodes: [],
    },
  ],
  // ztunnel names the unmeshed gateway in the callee's report, the only report of the call.
  ['AMBIENT, a caller outside the mesh', { resources: AMBIENT.resources, traffic: withFigures({ requestBytes: [fromGatewayNoProxy], responseBytes: [fromGatewayNoProxy] }) }, { edges: [[gateway, frontend, 'allowed', tcp(2000, 2000, 0), [TCP_ONLY]]], extraNodes: [] }],
  // A gateway with no proxy reports nothing, so no edge from outside invents its figures; its calls arrive as callers outside the mesh.
  [
    'an ingress gateway outside the mesh',
    { resources: meshOf(INGRESS.resources, 'gateway', 'none'), traffic: withFigures({ requests: [SHOP_ROWS.h] }) },
    { edges: [['outside-mesh', frontend, 'not-evaluated', requestsOnly(52), ['the callers are outside the mesh, so netatlas cannot tell which workloads they are']]], extraNodes: [OUTSIDE_MESH_NODE] },
  ],
  // Requests were read, so the edge is not TCP only.
  ["a sidecar caller's requests into an ambient workload", { resources: meshOf(SHOP, 'recommender', 'ambient'), traffic: withFigures({ requests: [postgresToRecommender200] }) }, { edges: [[postgres, recommender, 'uncovered', requestsOnly(4), []]], extraNodes: [] }],
  [
    'a service no workload answered',
    {
      resources: SHOP,
      traffic: withFigures({ requests: [requests(call('source', 'shop/frontend', 'unknown/unknown', { destination_service: 'search.shop.svc.cluster.local', destination_service_name: 'search.shop.svc.cluster.local' }), '200', '-', 1)] }),
    },
    {
      edges: [[frontend, 'service:search.shop.svc.cluster.local', 'not-evaluated', requestsOnly(1), []]],
      extraNodes: [{ id: 'service:search.shop.svc.cluster.local', label: 'search', sub: 'no workload answered' }],
    },
  ],
  // cart's report of a call from shop/frontend in cluster-2: frontend runs here too, and its own report is in
  // cluster-2's Prometheus. Drawn from the Internet node, as a call into another cluster is drawn to it, and
  // not compared with this cluster's policies; no edge from the local frontend.
  [
    'a caller in another cluster that has the name of a local workload',
    { resources: SHOP, traffic: withFigures({ requests: [requests(call('destination', 'shop/frontend', 'shop/cart', { source_cluster: 'cluster-2' }), '200', '-', 2)] }) },
    { edges: [['outside', cart, 'not-evaluated', requestsOnly(2), ["the callers are in another cluster of the mesh, so netatlas does not compare the call with this cluster's policies"]]], extraNodes: [] },
  ],
  // Not a node for the endpoint: the call goes to the Internet node.
  ['a call to a ServiceEntry host, its endpoint named as Istio names it', { resources: WITH_CLIENT, traffic: withFigures({ requests: [requests(toServiceEntry, '200', '-', 0.499)] }) }, { edges: [[client, 'outside', 'outbound', requestsOnly(0.499), []]], extraNodes: [] }],
])('edges with figures, and extra nodes, in other meshes %#: %s', (_name, { resources, traffic }, expected) => {
  const model = trafficModel(resources, traffic);
  expect({ edges: model?.edges.filter((e) => e.figures).map((e) => [e.from, e.to, e.mark, e.figures, e.notes]), extraNodes: model?.extraNodes }).toStrictEqual(expected);
});

const { recent: _recent, ...WITHOUT_RECENT } = SHOP_TRAFFIC;

/** No figures, and a 24-hour query that answered with no pairs: every allowed pair is unused. */
const NOTHING_IN_24_HOURS: TrafficSnapshot = { ...withFigures({}), recent: { at: new Date('2026-11-28T10:00:00Z'), pairs: [] } };

/** SHOP_TRAFFIC with its 24-hour pairs read at `at`; the figures were read at 2026-11-28T10:00:00Z. */
const pairsReadAt = (at: string): TrafficSnapshot => ({ ...SHOP_TRAFFIC, recent: { at: new Date(at), pairs: SHOP_TRAFFIC.recent?.pairs ?? [] } });

/** SHOP with one more rule: frontend may call recommender on UDP 8125, as a StatsD client does, and on nothing else. */
const FRONTEND_STATSD: ClusterResources = withPolicies(
  SHOP,
  networkPolicy('shop', 'frontend-statsd', {
    podSelector: { matchLabels: { app: 'frontend' } },
    policyTypes: ['Egress'],
    egress: [{ to: [{ podSelector: { matchLabels: { app: 'recommender' } } }], ports: [{ protocol: 'UDP', port: 8125 }] }],
  }),
);

/** An ALLOW policy for every workload of shop that admits every caller in shop, a common policy. */
const SAME_NAMESPACE = authorizationPolicy('shop', 'same-namespace', { rules: [{ from: [{ source: { namespaces: ['shop'] } }] }] });

it.each<[string, ClusterResources, TrafficSnapshot, TrafficEdge]>([
  [
    'without the 24-hour pairs, an allowed pair with no traffic is quiet',
    SHOP,
    WITHOUT_RECENT,
    { from: recommender, to: postgres, figures: null, mark: 'quiet', notes: [], label: 'TCP 5432', via: [np('payments', 'postgres-allow')] },
  ],
  // WAYPOINT's 24-hour pairs lack recommender to postgres, which would read unused without the waypoint. (frontend to
  // cart is no idle edge there: ztunnel cannot read cart-callers' HTTP rule, so Istio refuses the pair.)
  [
    'behind a waypoint, an idle edge to an ambient workload is not measured and says why',
    WAYPOINT.resources,
    WAYPOINT.traffic,
    { from: recommender, to: postgres, figures: null, mark: 'not-measured', notes: ['depends: traffic through waypoints is not attributed yet'], label: 'TCP 5432', via: [np('payments', 'postgres-allow')] },
  ],
  // The 24-hour query kept failing while the figures went on: pairs more than 30 minutes older than the figures say nothing.
  [
    'with 24-hour pairs read 30 minutes and 1 second before the figures, an allowed pair with no traffic is quiet',
    SHOP,
    pairsReadAt('2026-11-28T09:29:59Z'),
    { from: recommender, to: postgres, figures: null, mark: 'quiet', notes: [], label: 'TCP 5432', via: [np('payments', 'postgres-allow')] },
  ],
  [
    'with 24-hour pairs read 30 minutes before the figures, an allowed pair missing from them is unused',
    SHOP,
    pairsReadAt('2026-11-28T09:30:00Z'),
    { from: recommender, to: postgres, figures: null, mark: 'unused', notes: [], label: 'TCP 5432', via: [np('payments', 'postgres-allow')] },
  ],
  // Istio measures no UDP (pkg/config/protocol/instance.go:48-50), so no calls recorded is no sign of no calls.
  [
    'a pair allowed on UDP only is not measured and says why',
    FRONTEND_STATSD,
    NOTHING_IN_24_HOURS,
    { from: frontend, to: recommender, figures: null, mark: 'not-measured', notes: ['UDP only: Istio does not measure UDP'], label: 'UDP 8125', via: [np('shop', 'frontend-statsd')] },
  ],
  // The NetworkPolicies decide what the network lets through whatever Istio edge the pair has: only UDP can pass, so
  // an ALLOW policy for the whole namespace leaves the pair not measured. "Allowed, not used" lists unused edges only.
  [
    'a pair allowed on UDP only, which an ALLOW policy for the whole namespace also admits, is not measured and says why',
    withPolicies(FRONTEND_STATSD, SAME_NAMESPACE),
    NOTHING_IN_24_HOURS,
    {
      from: frontend,
      to: recommender,
      figures: null,
      mark: 'not-measured',
      notes: ['UDP only: Istio does not measure UDP'],
      label: 'UDP 8125',
      via: [np('shop', 'frontend-statsd'), { kind: 'AuthorizationPolicy', namespace: 'shop', name: 'same-namespace' }],
    },
  ],
])('idle edges without the 24-hour pairs, and behind waypoints %#: %s', (_name, resources, traffic, expected) => {
  expect(trafficModel(resources, traffic)?.edges.find((e) => e.from === expected.from && e.to === expected.to)).toStrictEqual(expected);
});

it.each<[string, ClusterResources, string[]]>([
  // The gateway and coredns are outside the mesh too, but no edge with figures reaches them.
  ['every workload the figures reach is in the mesh', SHOP, ['Callers outside the mesh are drawn as one node: they have no proxy, so Istio cannot name them.']],
  [
    'recommender is outside the mesh, and edges 5, 7 and 9 reach it with figures',
    RECOMMENDER_UNMESHED,
    ["recommender is not in the mesh, so its traffic is measured from the callers' side only.", 'Callers outside the mesh are drawn as one node: they have no proxy, so Istio cannot name them.'],
  ],
])('notes %#: %s', (_name, resources, expected) => {
  expect(trafficModel(resources, SHOP_TRAFFIC)?.notes).toStrictEqual(expected);
});

it('is undefined until the first figures', () => {
  expect(trafficModel(SHOP, { status: { state: 'connecting' }, clusterDomain: 'cluster.local' })).toBe(undefined);
});

// postgres has no egress policy and recommender no NetworkPolicy, so between them only an Istio policy on
// recommender decides: an ALLOW that admits frontend alone denies postgres, one that admits postgres allows it;
// a DENY decides only for the caller it names.
const onRecommender = (action: 'ALLOW' | 'DENY', namespace: string, account: string) =>
  withPolicies(
    SHOP,
    authorizationPolicy('shop', `recommender-${action === 'ALLOW' ? 'admits' : 'refuses'}-${account}`, {
      selector: { matchLabels: { app: 'recommender' } },
      action,
      rules: [{ from: [{ source: { principals: [`cluster.local/ns/${namespace}/sa/${account}`] } }] }],
    }),
  );

/** Figures without the 24-hour pairs, so that idle edges read quiet and only the traffic edge can stand out. */
const figuresOnly = (figures: Parameters<typeof withFigures>[0]): TrafficSnapshot => {
  const { recent: _pairs, ...rest } = withFigures(figures);
  return rest;
};
const { recent: _ambientPairs, ...AMBIENT_FIGURES_ONLY } = AMBIENT.traffic;

const CART_REFUSED_BY_NETWORK = { id: edgeId(cart, recommender), text: 'cart calls recommender: refused by the network.', reason: 'No call got an answer: the connection failed, or no upstream was healthy.' };
const ANSWERED_DENIED_REASON = 'The policies deny this call, yet it was answered: an enforcer may be missing, or a policy is newer than the figures.';
const NOT_USED = 'No calls recorded in the last 24 hours.';

/** postgres calls recommender, which the policies deny: the one item of the group of denied answers. */
const POSTGRES_ANSWERED: StandsOutGroup = {
  title: 'Answered though the policies deny it',
  tone: 'warn',
  items: [{ id: edgeId(postgres, recommender), text: 'postgres calls recommender, 4 requests a second.', reason: ANSWERED_DENIED_REASON }],
};

const tcp5432 = [{ protocol: 'TCP' as const, port: 5432 }];

/** An Istio ALLOW policy on postgres that admits api alone, so Istio refuses recommender, which postgres-allow admits. */
const POSTGRES_ADMITS_API = authorizationPolicy('payments', 'postgres-admits-api', {
  selector: { matchLabels: { app: 'postgres' } },
  action: 'ALLOW',
  rules: [{ from: [{ source: { principals: ['cluster.local/ns/payments/sa/api'] } }] }],
});

/** A DENY of one address, the only Istio policy of postgres: no ALLOW policy selects postgres, and netatlas, which knows no pod's address, cannot tell whose requests it refuses. */
const POSTGRES_DENY_ADDRESS = authorizationPolicy('payments', 'postgres-deny-address', {
  selector: { matchLabels: { app: 'postgres' } },
  action: 'DENY',
  rules: [{ from: [{ source: { ipBlocks: ['10.244.0.16/32'] } }] }],
});

/** SHOP plus namespace billing, in the mesh, with an api and a postgres of its own: billing's api may call its postgres on TCP 5432. */
const TWO_APIS: ClusterResources = withPolicies(
  {
    ...SHOP,
    namespaces: [...SHOP.namespaces, { name: 'billing', labels: { 'kubernetes.io/metadata.name': 'billing', 'istio-injection': 'enabled' } }],
    pods: [
      ...SHOP.pods,
      ...[
        ...deployment('billing', 'api', ['api-5f7d8c9b6-k3m8q'], [{ name: 'https', port: 8443, protocol: 'TCP' }]),
        ...deployment('billing', 'postgres', ['postgres-6c9b8d7f5-v2n4x'], [{ name: 'postgres', port: 5432, protocol: 'TCP' }]),
      ].map((p) => ({ ...p, mesh: 'sidecar' as const })),
    ],
  },
  networkPolicy('billing', 'api-allow', { podSelector: { matchLabels: { app: 'api' } }, policyTypes: ['Egress'], egress: [{ to: [{ podSelector: { matchLabels: { app: 'postgres' } } }], ports: tcp5432 }] }),
  networkPolicy('billing', 'postgres-allow', { podSelector: { matchLabels: { app: 'postgres' } }, policyTypes: ['Ingress'], ingress: [{ from: [{ podSelector: { matchLabels: { app: 'api' } } }], ports: tcp5432 }] }),
);

// `mark` is undefined where the model draws no edge at all between the two workloads.
it.each<[string, ClusterResources, TrafficSnapshot, string, string, { mark: TrafficMark | undefined; standsOut: StandsOutGroup[] }]>([
  // An application may answer 403 itself, and Envoy has no flag for an RBAC denial.
  [
    'every request a 403, which the policies allow, is no refusal by Istio',
    SHOP,
    figuresOnly({ requests: [requests(call('source', 'shop/frontend', 'shop/cart'), '403', '-', 2)] }),
    frontend,
    cart,
    { mark: 'allowed', standsOut: [] },
  ],
  // A connection held open, as one fortio TCP load keeps it, has bytes and no closed connection yet.
  [
    'bytes and no closed connection is no refusal by Istio',
    AMBIENT.resources,
    figuresOnly({ requestBytes: [bytes(call('source', 'payments/api', 'payments/postgres'), 300)], responseBytes: [bytes(call('source', 'payments/api', 'payments/postgres'), 300)] }),
    api,
    postgres,
    { mark: 'allowed', standsOut: [] },
  ],
  [
    'every request a 503 without UF, UH or URX is no refusal by the network',
    SHOP,
    figuresOnly({ requests: [SHOP_ROWS.d] }),
    cart,
    api,
    { mark: 'allowed', standsOut: [{ title: 'Errors', tone: 'normal', items: [{ id: edgeId(cart, api), text: 'cart calls api: 100% of requests fail.', reason: '0.1 requests a second over the last 5 minutes.' }] }] },
  ],
  ['calls an Istio ALLOW policy denies, answered 200', onRecommender('ALLOW', 'shop', 'frontend'), figuresOnly({ requests: [postgresToRecommender200] }), postgres, recommender, { mark: 'answered-denied', standsOut: [POSTGRES_ANSWERED] }],
  ['a pair only an Istio policy covers, which admits the caller', onRecommender('ALLOW', 'payments', 'postgres'), figuresOnly({ requests: [postgresToRecommender200] }), postgres, recommender, { mark: 'allowed', standsOut: [] }],
  [
    'a pair only the callee\'s ingress NetworkPolicy covers',
    SHOP,
    figuresOnly({ requests: [requests(call('source', 'shop/recommender', 'payments/postgres'), '200', '-', 4)] }),
    recommender,
    postgres,
    { mark: 'allowed', standsOut: [] },
  ],
  // Istio allows every caller a DENY rule does not name.
  ['a callee with only a DENY policy, called by a caller it does not name', onRecommender('DENY', 'shop', 'frontend'), figuresOnly({ requests: [postgresToRecommender200] }), postgres, recommender, { mark: 'allowed', standsOut: [] }],
  ['the caller a DENY rule names, answered 200', onRecommender('DENY', 'payments', 'postgres'), figuresOnly({ requests: [postgresToRecommender200] }), postgres, recommender, { mark: 'answered-denied', standsOut: [POSTGRES_ANSWERED] }],
  // The callee's DENY marks api to cart; cart to recommender has the caller's CONNECT only.
  [
    "ztunnel's DENY on the callee's side is a refusal by Istio",
    AMBIENT.resources,
    AMBIENT_FIGURES_ONLY,
    api,
    cart,
    {
      mark: 'refused-istio',
      standsOut: [
        {
          title: 'Refused calls',
          tone: 'warn',
          items: [
            { id: edgeId(api, cart), text: 'api calls cart: refused by Istio.', reason: 'ztunnel closed every connection with DENY.' },
            { id: edgeId(cart, recommender), text: 'cart calls recommender: refused by the network.', reason: 'No call got an answer: the connection failed, or no upstream was healthy.' },
          ],
        },
      ],
    },
  ],
  // The sidecar's requests failed as no upstream answered, but the callee's ztunnel says why: it refused every connection.
  [
    "ztunnel's DENY on the callee's side is read whatever the caller's requests",
    meshOf(SHOP, 'recommender', 'ambient'),
    figuresOnly({
      requests: [requests(call('source', 'payments/postgres', 'shop/recommender'), '503', 'UF', 1)],
      closed: [closed(call('destination', 'payments/postgres', 'shop/recommender'), 'DENY', 1)],
    }),
    postgres,
    recommender,
    {
      mark: 'refused-istio',
      standsOut: [{ title: 'Refused calls', tone: 'warn', items: [{ id: edgeId(postgres, recommender), text: 'postgres calls recommender: refused by Istio.', reason: 'ztunnel closed every connection with DENY.' }] }],
    },
  ],
  // ztunnel's other flags for a connection that failed before the callee answered (ztunnel src/proxy/metrics.rs:97-104, 825-860).
  ...['TLS_FAILURE', 'H2_HANDSHAKE_FAILURE', 'IDENTITY_ERROR', 'CERT_REVOKED'].map((flag): [string, ClusterResources, TrafficSnapshot, string, string, { mark: TrafficMark; standsOut: StandsOutGroup[] }] => [
    `every connection closed with ${flag} is a refusal by the network`,
    AMBIENT.resources,
    figuresOnly({ closed: [closed(call('source', 'shop/cart', 'shop/recommender'), flag, 0.2)] }),
    cart,
    recommender,
    { mark: 'refused-network', standsOut: [{ title: 'Refused calls', tone: 'warn', items: [CART_REFUSED_BY_NETWORK] }] },
  ]),
  // The figures measured on a kind cluster with Istio 1.32, over 128 plain TCP connections a DENY policy refused
  // between two sidecars: the caller's sidecar wrote flag `-`, 24 request bytes and no response byte for each
  // connection; the callee's wrote `-` with no byte either way; no DENY or UF anywhere. The rates are those 128
  // connections over 5 minutes. The measured call went to a pod address, so Istio named neither end; this pair
  // is named, as a call to a Service with a TCP port is.
  [
    'TCP between sidecars that Istio denies, every connection closed with nothing sent back',
    SHOP,
    figuresOnly({
      requestBytes: [bytes(call('source', 'payments/api', 'shop/cart'), 10.24)],
      closed: [closed(call('source', 'payments/api', 'shop/cart'), '-', 0.4267), closed(call('destination', 'payments/api', 'shop/cart'), '-', 0.4267)],
    }),
    api,
    cart,
    {
      mark: 'refused-istio',
      standsOut: [
        {
          title: 'Refused calls',
          tone: 'warn',
          items: [{ id: edgeId(api, cart), text: 'api calls cart: refused by Istio.', reason: 'Every connection closed with nothing sent back, and the Istio policies on cart do not allow api.' }],
        },
      ],
    },
  ],
  // Bytes came back, so the call was answered.
  [
    'TCP between sidecars that Istio denies, with bytes sent back',
    SHOP,
    figuresOnly({
      requestBytes: [bytes(call('source', 'payments/api', 'shop/cart'), 10.24)],
      responseBytes: [bytes(call('source', 'payments/api', 'shop/cart'), 10.24)],
      closed: [closed(call('source', 'payments/api', 'shop/cart'), '-', 0.4267), closed(call('destination', 'payments/api', 'shop/cart'), '-', 0.4267)],
    }),
    api,
    cart,
    {
      mark: 'answered-denied',
      standsOut: [{ title: 'Answered though the policies deny it', tone: 'warn', items: [{ id: edgeId(api, cart), text: 'api calls cart, 20 bytes a second over TCP.', reason: ANSWERED_DENIED_REASON }] }],
    },
  ],
  // postgres to recommender has only an Istio edge, so it is named by its requests; the others by their ports.
  [
    'an allowed pair with no calls in 24 hours, in the Istio form and the NetworkPolicy form',
    onRecommender('ALLOW', 'payments', 'postgres'),
    withFigures({}),
    postgres,
    recommender,
    {
      mark: 'unused',
      standsOut: [
        {
          title: 'Allowed, not used',
          tone: 'normal',
          items: [
            { id: edgeId(postgres, recommender), text: 'postgres may call recommender: any request.', reason: `Allowed by recommender-admits-postgres. ${NOT_USED}` },
            { id: edgeId(cart, api), text: 'cart may call api on TCP 8443.', reason: `Allowed by api-allow, api-callers and cart-allow. ${NOT_USED}` },
            { id: edgeId(frontend, cart), text: 'frontend may call cart on TCP 8080.', reason: `Allowed by cart-allow, cart-callers and frontend-allow. ${NOT_USED}` },
            { id: edgeId(recommender, postgres), text: 'recommender may call postgres on TCP 5432.', reason: `Allowed by postgres-allow. ${NOT_USED}` },
          ],
        },
      ],
    },
  ],
  // recommender's only Istio policy is a DENY of one address on one port. Istio lets the other callers in because no
  // ALLOW policy selects recommender (istio/api security/v1beta1/authorization_policy.proto:31 at 97748e4), so
  // postgres's line says that, and names the DENY policy only as not refusing the call. api, cart and frontend get no
  // line and no idle edge: their egress NetworkPolicies do not admit recommender, so one layer refuses each pair.
  [
    'a callee only a DENY policy selects, with no calls in 24 hours',
    withPolicies(SHOP, RECOMMENDER_DENY),
    withFigures({}),
    cart,
    recommender,
    {
      mark: undefined,
      standsOut: [
        {
          title: 'Allowed, not used',
          tone: 'normal',
          items: [
            {
              id: edgeId(postgres, recommender),
              text: 'postgres may call recommender: any request.',
              reason: 'No ALLOW policy selects recommender, so Istio lets in every request that recommender-deny does not refuse. No calls recorded in the last 24 hours.',
            },
            { id: edgeId(cart, api), text: 'cart may call api on TCP 8443.', reason: `Allowed by api-allow, api-callers and cart-allow. ${NOT_USED}` },
            { id: edgeId(frontend, cart), text: 'frontend may call cart on TCP 8080.', reason: `Allowed by cart-allow, cart-callers and frontend-allow. ${NOT_USED}` },
            { id: edgeId(recommender, postgres), text: 'recommender may call postgres on TCP 5432.', reason: `Allowed by postgres-allow. ${NOT_USED}` },
          ],
        },
      ],
    },
  ],
  // A DENY policy for the whole mesh, a common hardening: frontend to cart names cart's ALLOW policy and its
  // NetworkPolicies only. frontend's egress NetworkPolicy admits cart alone, so frontend to postgres and to
  // recommender, which Istio lets in because no ALLOW policy selects either, get no line.
  [
    'a DENY policy for the whole mesh, with no calls in 24 hours',
    withPolicies(SHOP, MESH_DENY_ADMIN),
    withFigures({}),
    frontend,
    cart,
    {
      mark: 'unused',
      standsOut: [
        {
          title: 'Allowed, not used',
          tone: 'normal',
          items: [
            { id: edgeId(cart, api), text: 'cart may call api on TCP 8443.', reason: `Allowed by api-allow, api-callers and cart-allow. ${NOT_USED}` },
            { id: edgeId(frontend, cart), text: 'frontend may call cart on TCP 8080.', reason: 'Allowed by cart-allow, cart-callers and frontend-allow. No calls recorded in the last 24 hours.' },
            { id: edgeId(recommender, postgres), text: 'recommender may call postgres on TCP 5432.', reason: `Allowed by postgres-allow. ${NOT_USED}` },
          ],
        },
      ],
    },
  ],
  // A pair is allowed and idle only when neither layer refuses it, as a call seen on it is judged by both. Istio's
  // ALLOW policy on recommender admits cart, but cart's egress NetworkPolicy admits api alone: no line, no idle edge.
  [
    "an Istio ALLOW policy admits a pair that a NetworkPolicy refuses, with no calls in 24 hours",
    onRecommender('ALLOW', 'shop', 'cart'),
    withFigures({}),
    cart,
    recommender,
    {
      mark: undefined,
      standsOut: [
        {
          title: 'Allowed, not used',
          tone: 'normal',
          items: [
            { id: edgeId(cart, api), text: 'cart may call api on TCP 8443.', reason: `Allowed by api-allow, api-callers and cart-allow. ${NOT_USED}` },
            { id: edgeId(frontend, cart), text: 'frontend may call cart on TCP 8080.', reason: `Allowed by cart-allow, cart-callers and frontend-allow. ${NOT_USED}` },
            { id: edgeId(recommender, postgres), text: 'recommender may call postgres on TCP 5432.', reason: `Allowed by postgres-allow. ${NOT_USED}` },
          ],
        },
      ],
    },
  ],
  // postgres-allow admits recommender, but Istio's ALLOW policy on postgres admits api alone: no line and no idle edge
  // for recommender to postgres. api to postgres, which both layers admit, is listed with the policies of both.
  [
    "a NetworkPolicy admits a pair that Istio's policies refuse, with no calls in 24 hours",
    withPolicies(SHOP, POSTGRES_ADMITS_API),
    NOTHING_IN_24_HOURS,
    recommender,
    postgres,
    {
      mark: undefined,
      standsOut: [
        {
          title: 'Allowed, not used',
          tone: 'normal',
          items: [
            { id: edgeId(api, postgres), text: 'api may call postgres on TCP 5432.', reason: `Allowed by api-allow, postgres-admits-api and postgres-allow. ${NOT_USED}` },
            { id: edgeId(cart, api), text: 'cart may call api on TCP 8443.', reason: `Allowed by api-allow, api-callers and cart-allow. ${NOT_USED}` },
            { id: edgeId(frontend, cart), text: 'frontend may call cart on TCP 8080.', reason: `Allowed by cart-allow, cart-callers and frontend-allow. ${NOT_USED}` },
          ],
        },
      ],
    },
  ],
  // recommender to postgres has an edge of each layer: postgres-allow admits it, and Istio lets it in because no ALLOW
  // policy selects postgres. One sentence names the NetworkPolicy, then says why Istio lets the call in. cart and
  // frontend, which Istio lets in too, are not listed: their egress NetworkPolicies do not admit postgres.
  [
    'a pair a NetworkPolicy admits and Istio lets in with no ALLOW policy, with no calls in 24 hours',
    withPolicies(SHOP, POSTGRES_DENY_ADDRESS),
    withFigures({}),
    recommender,
    postgres,
    {
      mark: 'unused',
      standsOut: [
        {
          title: 'Allowed, not used',
          tone: 'normal',
          items: [
            { id: edgeId(cart, api), text: 'cart may call api on TCP 8443.', reason: `Allowed by api-allow, api-callers and cart-allow. ${NOT_USED}` },
            { id: edgeId(frontend, cart), text: 'frontend may call cart on TCP 8080.', reason: `Allowed by cart-allow, cart-callers and frontend-allow. ${NOT_USED}` },
            {
              id: edgeId(recommender, postgres),
              text: 'recommender may call postgres on TCP 5432.',
              reason: 'Allowed by postgres-allow, and no ALLOW policy selects postgres, so Istio lets in every request that postgres-deny-address does not refuse. No calls recorded in the last 24 hours.',
            },
          ],
        },
      ],
    },
  ],
  // WAYPOINT's 24-hour pairs lack recommender to postgres, yet behind the waypoint it is not listed as allowed and not used.
  ['behind a waypoint, an idle edge is not measured, so not listed as unused', WAYPOINT.resources, WAYPOINT.traffic, recommender, postgres, { mark: 'not-measured', standsOut: [] }],
  // api and postgres each name two workloads, so they are named with their namespaces; the others by name alone.
  [
    'two namespaces that each hold an api and a postgres',
    TWO_APIS,
    NOTHING_IN_24_HOURS,
    'billing/Deployment/api',
    'billing/Deployment/postgres',
    {
      mark: 'unused',
      standsOut: [
        {
          title: 'Allowed, not used',
          tone: 'normal',
          items: [
            { id: edgeId('billing/Deployment/api', 'billing/Deployment/postgres'), text: 'billing / api may call billing / postgres on TCP 5432.', reason: `Allowed by api-allow and postgres-allow. ${NOT_USED}` },
            { id: edgeId(api, postgres), text: 'payments / api may call payments / postgres on TCP 5432.', reason: `Allowed by api-allow and postgres-allow. ${NOT_USED}` },
            { id: edgeId(cart, api), text: 'cart may call payments / api on TCP 8443.', reason: `Allowed by api-allow, api-callers and cart-allow. ${NOT_USED}` },
            { id: edgeId(frontend, cart), text: 'frontend may call cart on TCP 8080.', reason: `Allowed by cart-allow, cart-callers and frontend-allow. ${NOT_USED}` },
            { id: edgeId(recommender, postgres), text: 'recommender may call payments / postgres on TCP 5432.', reason: `Allowed by postgres-allow. ${NOT_USED}` },
          ],
        },
      ],
    },
  ],
])('marks by each clause of the rules %#: %s', (_name, resources, traffic, from, to, expected) => {
  const model = trafficModel(resources, traffic);
  expect({ mark: model?.edges.find((e) => e.from === from && e.to === to)?.mark, standsOut: model?.standsOut }).toStrictEqual(expected);
});

/** SHOP as the reader gives it when netatlas's role may not list one policy kind: none of that kind, and the kind in readErrors. */
const unreadable = (kind: 'networkpolicies' | 'authorizationpolicies'): ClusterResources => ({
  ...SHOP,
  ...(kind === 'networkpolicies' ? { networkPolicies: [] } : { authorizationPolicies: [] }),
  readErrors: [{ kind, reason: 'forbidden' }],
});
const NETWORK_POLICIES_UNREAD = "depends: netatlas's role may not read NetworkPolicies";
const AUTHORIZATION_POLICIES_UNREAD = "depends: netatlas's role may not read AuthorizationPolicies";
/** cart to api's 2.1% of failed requests: measured, so listed whether or not the policies could be read. */
const CART_API_ERRORS: StandsOutGroup = {
  title: 'Errors',
  tone: 'normal',
  items: [{ id: edgeId(cart, api), text: 'cart calls api: 2.1% of requests fail.', reason: '6 requests a second over the last 5 minutes.' }],
};

type Judged = { edges: [string, string, TrafficMark, string[]][]; standsOut: StandsOutGroup[] };

// A policy netatlas may not read could allow or deny any pair, so no pair is said to be allowed, uncovered or
// answered though denied, and no idle edge is drawn: each row compares every edge of the model, not only those with
// figures. The refusals stay: they are read from the figures. Edges in order: by from, then to.
it.each<[string, ClusterResources, TrafficSnapshot, Judged]>([
  // api to cart stays refused by Istio: its 403s and the AuthorizationPolicies, which netatlas could read, say so.
  [
    'NetworkPolicies unreadable',
    unreadable('networkpolicies'),
    SHOP_TRAFFIC,
    {
      edges: [
        ['outside-mesh', frontend, 'not-evaluated', ['the callers are outside the mesh, so netatlas cannot tell which workloads they are']],
        [api, 'outside', 'outbound', []],
        [api, cart, 'refused-istio', []],
        [postgres, recommender, 'not-evaluated', [NETWORK_POLICIES_UNREAD]],
        [cart, api, 'not-evaluated', [NETWORK_POLICIES_UNREAD]],
        [cart, recommender, 'refused-network', []],
        [frontend, cart, 'not-evaluated', [NETWORK_POLICIES_UNREAD]],
        [frontend, recommender, 'not-evaluated', [NETWORK_POLICIES_UNREAD]],
        [frontend, 'unseen:shop/search', 'not-evaluated', ['not running now']],
      ],
      standsOut: [
        CART_API_ERRORS,
        {
          title: 'Refused calls',
          tone: 'warn',
          items: [
            { id: edgeId(api, cart), text: 'api calls cart: refused by Istio.', reason: 'Every answer was a 403, and the Istio policies on cart do not allow api.' },
            CART_REFUSED_BY_NETWORK,
          ],
        },
      ],
    },
  ],
  // Without the AuthorizationPolicies api's 403s are no refusal by Istio; api to postgres and recommender to postgres,
  // which postgres-allow admits, had no calls, yet an AuthorizationPolicy netatlas could not read may refuse them, so
  // neither gets an idle edge, and recommender to postgres, with no calls in 24 hours, is not listed as allowed and not used.
  [
    'AuthorizationPolicies unreadable',
    unreadable('authorizationpolicies'),
    SHOP_TRAFFIC,
    {
      edges: [
        ['outside-mesh', frontend, 'not-evaluated', ['the callers are outside the mesh, so netatlas cannot tell which workloads they are']],
        [api, 'outside', 'outbound', []],
        [api, cart, 'not-evaluated', [AUTHORIZATION_POLICIES_UNREAD]],
        [postgres, recommender, 'not-evaluated', [AUTHORIZATION_POLICIES_UNREAD]],
        [cart, api, 'not-evaluated', [AUTHORIZATION_POLICIES_UNREAD]],
        [cart, recommender, 'refused-network', []],
        [frontend, cart, 'not-evaluated', [AUTHORIZATION_POLICIES_UNREAD]],
        [frontend, recommender, 'not-evaluated', [AUTHORIZATION_POLICIES_UNREAD]],
        [frontend, 'unseen:shop/search', 'not-evaluated', ['not running now']],
      ],
      standsOut: [CART_API_ERRORS, { title: 'Refused calls', tone: 'warn', items: [CART_REFUSED_BY_NETWORK] }],
    },
  ],
  // The Istio edges frontend to cart and cart to api had no calls in 24 hours, yet a NetworkPolicy netatlas
  // could not read may refuse them, so neither gets an idle edge, and neither is listed as allowed and not used.
  ['NetworkPolicies unreadable, no calls in 24 hours', unreadable('networkpolicies'), NOTHING_IN_24_HOURS, { edges: [], standsOut: [] }],
])('a policy kind netatlas may not read is not read as none %#: %s', (_name, resources, traffic, expected) => {
  const model = trafficModel(resources, traffic);
  expect({ edges: model?.edges.map((e) => [e.from, e.to, e.mark, e.notes]), standsOut: model?.standsOut }).toStrictEqual(expected);
});

// INGRESS's gateway with no figures: nothing was forwarded, so nothing is drawn from the Internet to it.
it('draws no edge from the Internet to an ingress gateway that forwarded nothing', () => {
  expect(trafficModel(INGRESS.resources, withFigures({}))?.edges.filter((e) => e.from === 'outside')).toStrictEqual([]);
});
