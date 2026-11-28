import { expect, it } from 'vitest';
import { trafficQueries } from './promql';

// A series whose 5-minute rate is 0 is no call now, so `> 0` leaves it out, as the 24-hour query leaves out
// the pairs it did not see.
it('asks the fixed queries, without the waypoint reporter and without a series at rate 0', () => {
  expect(trafficQueries()).toStrictEqual({
    requests:
      'sum by (reporter, source_workload, source_workload_namespace, source_cluster, destination_workload, destination_workload_namespace, destination_service, destination_service_name, destination_cluster, response_code, response_flags) (rate(istio_requests_total{reporter=~"source|destination"}[5m])) > 0',
    requestBytes:
      'sum by (reporter, source_workload, source_workload_namespace, source_cluster, destination_workload, destination_workload_namespace, destination_service, destination_service_name, destination_cluster) (rate(istio_tcp_received_bytes_total{reporter=~"source|destination"}[5m])) > 0',
    responseBytes:
      'sum by (reporter, source_workload, source_workload_namespace, source_cluster, destination_workload, destination_workload_namespace, destination_service, destination_service_name, destination_cluster) (rate(istio_tcp_sent_bytes_total{reporter=~"source|destination"}[5m])) > 0',
    closed:
      'sum by (reporter, source_workload, source_workload_namespace, source_cluster, destination_workload, destination_workload_namespace, destination_service, destination_service_name, destination_cluster, response_flags) (rate(istio_tcp_connections_closed_total{reporter=~"source|destination"}[5m])) > 0',
    recent:
      'sum by (reporter, source_workload, source_workload_namespace, destination_workload, destination_workload_namespace) (increase(istio_requests_total{reporter=~"source|destination"}[24h])) > 0 or sum by (reporter, source_workload, source_workload_namespace, destination_workload, destination_workload_namespace) (increase(istio_tcp_connections_opened_total{reporter=~"source|destination"}[24h])) > 0',
  });
});

it("adds the cluster label to the matcher, with the value's quotes and backslashes escaped", () => {
  // The value is `prod "eu" \1`; PromQL reads `\"` as a quote and `\\` as one backslash.
  expect(trafficQueries({ name: 'cluster', value: 'prod "eu" \\1' }).requests).toBe(
    String.raw`sum by (reporter, source_workload, source_workload_namespace, source_cluster, destination_workload, destination_workload_namespace, destination_service, destination_service_name, destination_cluster, response_code, response_flags) (rate(istio_requests_total{reporter=~"source|destination", cluster="prod \"eu\" \\1"}[5m])) > 0`,
  );
});
