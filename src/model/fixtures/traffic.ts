// The shop's traffic as its Prometheus answers the figure queries, and four meshes built on SHOP (ambient,
// ambient with a waypoint, an egress gateway, an ingress gateway): the samples the traffic model's tests
// read. Each sample carries the labels the queries group by (`trafficQueries` in promql.ts): the call's
// labels, plus `response_code` and `response_flags` on requests and `response_flags` on closed connections.
import type { PromSample } from '../prometheus-answer';
import type { TrafficFigures, TrafficSnapshot } from '../traffic-status';
import type { ClusterResources, Labels } from '../types';
import { deployment, SHOP } from './shop';

const AT = new Date('2026-11-28T10:00:00Z');

/**
 * A call's labels from `<namespace>/<workload>` to `<namespace>/<workload>`, both in cluster `Kubernetes`,
 * the destination service being the destination workload's own (`<dw>.<dwn>.svc.cluster.local`) unless
 * `given` says otherwise. `unknown/unknown` is an end Istio could not name.
 */
export function call(reporter: string, from: string, to: string, given: Labels = {}): Labels {
  const [swn = '', sw = ''] = from.split('/'), [dwn = '', dw = ''] = to.split('/');
  const service = `${dw}.${dwn}.svc.cluster.local`;
  return {
    reporter,
    source_workload: sw,
    source_workload_namespace: swn,
    source_cluster: 'Kubernetes',
    destination_workload: dw,
    destination_workload_namespace: dwn,
    destination_service: service,
    destination_service_name: service,
    destination_cluster: 'Kubernetes',
    ...given,
  };
}

export const requests = (labels: Labels, code: string, flags: string, value: number): PromSample => ({ labels: { ...labels, response_code: code, response_flags: flags }, value });
export const closed = (labels: Labels, flags: string, value: number): PromSample => ({ labels: { ...labels, response_flags: flags }, value });
export const bytes = (labels: Labels, value: number): PromSample => ({ labels, value });

/** What ztunnel reports for a connection to an address it does not know: every destination label `unknown`. */
const UNATTRIBUTED: Labels = { destination_service: 'unknown', destination_service_name: 'unknown', destination_cluster: 'unknown' };

/** The rows of the shop's table, by letter; `l` is both byte rates, 9000 each. */
export const SHOP_ROWS = {
  a: requests(call('source', 'shop/frontend', 'shop/cart'), '200', '-', 12),
  b: requests(call('destination', 'shop/frontend', 'shop/cart'), '200', '-', 12),
  c: requests(call('source', 'shop/cart', 'payments/api'), '200', '-', 5.874),
  d: requests(call('source', 'shop/cart', 'payments/api'), '503', '-', 0.126),
  e: requests(call('source', 'shop/frontend', 'shop/recommender'), '200', '-', 3),
  f: requests(call('source', 'shop/cart', 'shop/recommender'), '503', 'UF,URX', 1),
  g: requests(call('source', 'payments/api', 'shop/cart'), '403', '-', 0.5),
  // A caller with no proxy: only the destination's sidecar reports the call, and cannot name the caller.
  h: requests(call('destination', 'unknown/unknown', 'shop/frontend'), '200', '-', 52),
  // Plain HTTP to a host no ServiceEntry registers: the Host header, with its port, is the destination service.
  i: requests(call('source', 'payments/api', 'unknown/unknown', { destination_service: 'pay.example.com:8080', destination_service_name: 'PassthroughCluster' }), '200', '-', 0.5),
  // search has no pods now.
  j: requests(call('source', 'shop/frontend', 'shop/search'), '200', '-', 1),
  // A waypoint's copy of row a.
  k: requests(call('waypoint', 'shop/frontend', 'shop/cart'), '200', '-', 12),
  l: bytes(call('source', 'payments/postgres', 'shop/recommender'), 9000),
  m: closed(call('source', 'payments/postgres', 'shop/recommender'), '-', 0.2),
} as const satisfies Readonly<Record<string, PromSample>>;

const { a, b, c, d, e, f, g, h, i, j, k, l, m } = SHOP_ROWS;

export const SHOP_TRAFFIC: TrafficSnapshot = {
  status: { state: 'reachable', since: AT, lastSeen: AT },
  clusterDomain: 'cluster.local',
  figures: { at: AT, requests: [a, b, c, d, e, f, g, h, i, j, k], requestBytes: [l], responseBytes: [l], closed: [m] },
  // The 24-hour query groups by reporter and the two workloads only.
  recent: {
    at: AT,
    pairs: [{ labels: { reporter: 'source', source_workload: 'api', source_workload_namespace: 'payments', destination_workload: 'postgres', destination_workload_namespace: 'payments' }, value: 1440 }],
  },
};

/** SHOP_TRAFFIC with other figures: the same source status, cluster domain and 24-hour pairs. */
export const withFigures = (figures: Partial<Omit<TrafficFigures, 'at'>>): TrafficSnapshot => ({
  ...SHOP_TRAFFIC,
  figures: { at: AT, requests: [], requestBytes: [], responseBytes: [], closed: [], ...figures },
});

/** A cluster's resources and its traffic snapshot, read together. */
export interface TrafficCase {
  readonly resources: ClusterResources;
  readonly traffic: TrafficSnapshot;
}

/** SHOP with the shop's and the payments' pods in ambient mode, ztunnel reporting their connections. */
const AMBIENT_RESOURCES: ClusterResources = { ...SHOP, istio: 'ambient', pods: SHOP.pods.map((p) => (p.mesh === 'sidecar' ? { ...p, mesh: 'ambient' } : p)) };

const apiToPostgres = call('source', 'payments/api', 'payments/postgres');
const recommenderUnattributed = bytes(call('source', 'shop/recommender', 'unknown/unknown', UNATTRIBUTED), 500);

export const AMBIENT: TrafficCase = {
  resources: AMBIENT_RESOURCES,
  traffic: withFigures({
    requestBytes: [bytes(apiToPostgres, 300), recommenderUnattributed],
    responseBytes: [bytes(apiToPostgres, 300), recommenderUnattributed],
    closed: [
      closed(apiToPostgres, '-', 0.1),
      // An AuthorizationPolicy refusal as ztunnel reports it: the callee's ztunnel records DENY on its inbound
      // check (inbound.rs:270-277, 331-332); the caller's gets HTTP 401 on its CONNECT and records it as a
      // connection failure (h2/client.rs:143-144, outbound.rs:309-312, metrics.rs:857-858).
      closed(call('source', 'payments/api', 'shop/cart'), 'CONNECT', 0.3),
      closed(call('destination', 'payments/api', 'shop/cart'), 'DENY', 0.3),
      closed(call('source', 'shop/cart', 'shop/recommender'), 'CONNECT', 0.2),
    ],
  }),
};

// ztunnel sends service-addressed traffic to the waypoint and names the waypoint as the destination
// workload and the service it was meant for as the destination service.
const throughWaypoint = bytes(call('source', 'shop/frontend', 'shop/waypoint', { destination_service: 'cart.shop.svc.cluster.local', destination_service_name: 'cart.shop.svc.cluster.local' }), 1000);

/**
 * AMBIENT plus a waypoint in `shop`, its pods labelled as Istio labels every waypoint's
 * (waypoint.yaml:69-70). Its proxy container is named istio-proxy and it carries no ambient redirection,
 * so the reader gives it mesh `sidecar`, which the helper's `shop` namespace also gives.
 */
export const WAYPOINT: TrafficCase = {
  resources: {
    ...AMBIENT_RESOURCES,
    pods: [
      ...AMBIENT_RESOURCES.pods,
      ...deployment('shop', 'waypoint', ['waypoint-6c8f9d7b5-w2x7k'], [], {
        'gateway.networking.k8s.io/gateway-name': 'waypoint',
        'gateway.networking.k8s.io/gateway-class-name': 'istio-waypoint',
      }),
    ],
  },
  traffic: withFigures({
    requestBytes: [throughWaypoint, bytes(call('waypoint', 'shop/frontend', 'shop/cart'), 1000)],
    responseBytes: [throughWaypoint],
  }),
};

/**
 * SHOP plus an egress gateway in istio-system, its pods labelled as the gateway chart labels them, and in the
 * mesh: it runs a container named istio-proxy, which the reader reads as mesh `sidecar` (trim.ts).
 */
export const EGRESS_GATEWAY: TrafficCase = {
  resources: {
    ...SHOP,
    namespaces: [...SHOP.namespaces, { name: 'istio-system', labels: { 'kubernetes.io/metadata.name': 'istio-system' } }],
    pods: [...SHOP.pods, ...deployment('istio-system', 'istio-egressgateway', ['istio-egressgateway-5d7c9b8f6-t4n8q'], [{ name: 'https', port: 8443, protocol: 'TCP' }], { istio: 'egressgateway' }).map((p) => ({ ...p, mesh: 'sidecar' as const }))],
  },
  traffic: withFigures({
    requests: [
      requests(call('source', 'shop/cart', 'istio-system/istio-egressgateway'), '200', '-', 2),
      // A gateway reports `source`, naming the host it forwarded to.
      requests(call('source', 'istio-system/istio-egressgateway', 'unknown/unknown', { destination_service: 'api.partner.example', destination_service_name: 'api.partner.example' }), '200', '-', 2),
    ],
  }),
};

/**
 * SHOP with the gateway's pods also labelled `istio=ingressgateway`, and in the mesh: Istio's own gateways
 * run a container named istio-proxy, which the reader reads as mesh `sidecar` (trim.ts).
 */
export const INGRESS: TrafficCase = {
  resources: { ...SHOP, pods: SHOP.pods.map((p) => (p.workload.name === 'gateway' ? { ...p, labels: { ...p.labels, istio: 'ingressgateway' }, mesh: 'sidecar' } : p)) },
  traffic: withFigures({ requests: [requests(call('source', 'ingress/gateway', 'shop/frontend'), '200', '-', 52)] }),
};
