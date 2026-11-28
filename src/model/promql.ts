/** The PromQL netatlas asks a cluster's Prometheus: one query per figure, fixed in code. */
export interface TrafficQueries {
  readonly requests: string;
  readonly requestBytes: string;
  readonly responseBytes: string;
  readonly closed: string;
  readonly recent: string;
}

/** The labels a call is grouped by: who called whom, as each reporter names both ends. */
const CALL = [
  'reporter',
  'source_workload',
  'source_workload_namespace',
  'source_cluster',
  'destination_workload',
  'destination_workload_namespace',
  'destination_service',
  'destination_service_name',
  'destination_cluster',
];

/** The labels a pair of workloads is grouped by in the 24-hour query. */
const PAIR = ['reporter', 'source_workload', 'source_workload_namespace', 'destination_workload', 'destination_workload_namespace'];

/** PromQL reads `\` and `"` inside a double-quoted string as escapes, so a label value escapes both. */
const quoted = (value: string) => `"${value.replace(/[\\"]/g, (ch) => `\\${ch}`)}"`;

/**
 * The five queries. The matcher keeps the sidecars' and ztunnel's reports (`source` and
 * `destination`) and leaves the waypoint's out; the model counts each call once. A cluster label
 * picks this cluster's series out of a Prometheus several clusters share. A series whose 5-minute rate
 * is 0 was seen earlier and is idle now, not a call: `> 0` leaves it out, and only the 24-hour pairs
 * tell that a pair was seen recently.
 */
export function trafficQueries(label?: { readonly name: string; readonly value: string }): TrafficQueries {
  const matcher = `{reporter=~"source|destination"${label ? `, ${label.name}=${quoted(label.value)}` : ''}}`;
  const rate = (metric: string, by: readonly string[] = []) => `sum by (${[...CALL, ...by].join(', ')}) (rate(${metric}${matcher}[5m])) > 0`;
  const seen = (metric: string) => `sum by (${PAIR.join(', ')}) (increase(${metric}${matcher}[24h])) > 0`;
  return {
    requests: rate('istio_requests_total', ['response_code', 'response_flags']),
    requestBytes: rate('istio_tcp_received_bytes_total'),
    responseBytes: rate('istio_tcp_sent_bytes_total'),
    closed: rate('istio_tcp_connections_closed_total', ['response_flags']),
    recent: `${seen('istio_requests_total')} or ${seen('istio_tcp_connections_opened_total')}`,
  };
}
