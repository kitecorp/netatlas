import type { WorkloadIndex } from './destinations';
import type { PromSample } from './prometheus-answer';

/** What Istio writes for a label it has no value for. */
export const UNKNOWN = 'unknown';

/** A sample's label by name. A label an operator removed with Istio's Telemetry API, or left empty, reads `unknown`. */
export function labelOf(s: PromSample, name: string): string {
  return s.labels[name] || UNKNOWN;
}

/** Which proxy reported the sample: `source` (the caller's), `destination` (the callee's) or `waypoint`. */
export const reporterOf = (s: PromSample): string => labelOf(s, 'reporter');

/**
 * The cluster of the mesh a callee's report names as its caller's, when that is another cluster than the
 * callee's own: the callee's sidecar writes its peer's cluster as `source_cluster` and its own as
 * `destination_cluster` (istio_stats.cc:1173-1175, 1242). Undefined for any other report, or a cluster
 * either label leaves unknown.
 */
export function callerClusterOf(s: PromSample): string | undefined {
  const source = labelOf(s, 'source_cluster'), destination = labelOf(s, 'destination_cluster');
  return reporterOf(s) === 'destination' && source !== UNKNOWN && destination !== UNKNOWN && source !== destination ? source : undefined;
}

/**
 * Whether the caller has no proxy to report the call. A sidecar cannot name such a caller (`unknown`), but
 * ztunnel can: it looks the caller up by its address and names it in its own report
 * (ztunnel inbound_passthrough.rs:166-200), so a seen caller outside the mesh counts too.
 */
function callerHasNoProxy(s: PromSample, w: WorkloadIndex): boolean {
  const name = labelOf(s, 'source_workload');
  if (name === UNKNOWN) return true;
  const id = w.byName(labelOf(s, 'source_workload_namespace'), name);
  return id !== undefined && w.mesh(id) === 'none';
}

/**
 * Each call once: the caller's report (`reporter="source"`), plus the callee's (`destination`) where the
 * caller has no proxy to report it or is in another cluster of the mesh, whose own report this cluster's
 * figures do not hold, and never a waypoint's copy.
 */
export function countOnce(samples: readonly PromSample[], w: WorkloadIndex): PromSample[] {
  return samples.filter((s) => reporterOf(s) === 'source' || (reporterOf(s) === 'destination' && (callerHasNoProxy(s, w) || callerClusterOf(s) !== undefined)));
}

/** The callers' reports only, which the Outbound view reads. */
export function fromSource(samples: readonly PromSample[]): PromSample[] {
  return samples.filter((s) => reporterOf(s) === 'source');
}
