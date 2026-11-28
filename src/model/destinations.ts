import { compareText, workloadIdOf } from './classes';
import { isEgressGateway, type ProxySigns } from './istio-proxies';
import type { PromSample } from './prometheus-answer';
import { callerClusterOf, labelOf, reporterOf, UNKNOWN } from './samples';
import type { ClusterResources, Mesh, PodInfo } from './types';

/** The cluster's workloads as Istio's metrics name them: by namespace and name. */
export interface WorkloadIndex {
  /** The id of the workload of that namespace and name; the first id in id order wins a tie. */
  byName(namespace: string, name: string): string | undefined;
  /** The labels and proxy role of each of the workload's pods; none for an id it does not know. */
  pods(id: string): readonly ProxySigns[];
  /** `sidecar` if any of its pods is, else `ambient` if any is, else `none`; `none` for an id it does not know. */
  mesh(id: string): Mesh;
}

/** Istio names a workload by its namespace and name only; two kinds may share both. */
const nameKey = (namespace: string, name: string) => JSON.stringify([namespace, name]);

const meshOf = (pods: readonly PodInfo[]): Mesh => (['sidecar', 'ambient'] as const).find((m) => pods.some((p) => p.mesh === m)) ?? 'none';

export function workloadIndex(r: ClusterResources): WorkloadIndex {
  const pods = new Map<string, PodInfo[]>();
  for (const p of r.pods) {
    const id = workloadIdOf(p);
    pods.set(id, [...(pods.get(id) ?? []), p]);
  }
  const byName = new Map<string, string>();
  for (const id of [...pods.keys()].sort(compareText)) {
    const [first] = pods.get(id) ?? [];
    const key = first && nameKey(first.namespace, first.workload.name);
    if (key && !byName.has(key)) byName.set(key, id);
  }
  return {
    byName: (namespace, name) => byName.get(nameKey(namespace, name)),
    pods: (id) => pods.get(id) ?? [],
    mesh: (id) => meshOf(pods.get(id) ?? []),
  };
}

/** Where a call went, read from its destination labels. */
export type Destination =
  | { readonly kind: 'workload'; readonly id: string }
  | { readonly kind: 'egress-gateway'; readonly id: string }
  | { readonly kind: 'unseen'; readonly namespace: string; readonly name: string }
  | { readonly kind: 'service'; readonly host: string }
  | { readonly kind: 'mesh-cluster'; readonly cluster: string }
  | { readonly kind: 'external'; readonly host: string }
  | { readonly kind: 'blackhole'; readonly host?: string }
  | { readonly kind: 'unregistered' }
  | { readonly kind: 'unattributed' };

/** Who made a call, read from its source labels. */
export type Caller =
  | { readonly kind: 'workload'; readonly id: string }
  | { readonly kind: 'unseen'; readonly namespace: string; readonly name: string }
  | { readonly kind: 'outside-mesh' }
  | { readonly kind: 'mesh-cluster'; readonly cluster: string };

/** A Host header keeps the port the caller wrote (`pay.example.com:8080`); the host is the part before it. */
const hostOf = (service: string) => service.replace(/:\d+$/, '');

/** The upstream cluster names istiod gives unregistered traffic (pilot/pkg/networking/util/util.go). */
const BLACK_HOLE = 'BlackHoleCluster';
const PASSTHROUGH = 'PassthroughCluster';

/** The first case that holds, in the order of the mechanisms read from Istio's source (design 5.8). */
export function destinationOf(s: PromSample, w: WorkloadIndex, clusterDomain: string): Destination {
  const service = labelOf(s, 'destination_service'), serviceName = labelOf(s, 'destination_service_name');
  const workload = labelOf(s, 'destination_workload'), namespace = labelOf(s, 'destination_workload_namespace');
  const sourceCluster = labelOf(s, 'source_cluster'), cluster = labelOf(s, 'destination_cluster');
  // On a callee's own report the destination is the callee, in this cluster, whatever cluster called it.
  const otherCluster = reporterOf(s) !== 'destination' && sourceCluster !== UNKNOWN && cluster !== UNKNOWN && sourceCluster !== cluster;
  // REGISTRY_ONLY blocked it; plain HTTP still names the host it asked for.
  if (serviceName === BLACK_HOLE) return service === UNKNOWN ? { kind: 'blackhole' } : { kind: 'blackhole', host: hostOf(service) };
  // ALLOW_ANY let it out; only plain HTTP names the host, TLS and TCP name nothing.
  if (serviceName === PASSTHROUGH) return service === UNKNOWN ? { kind: 'unregistered' } : { kind: 'external', host: hostOf(service) };
  const host = hostOf(service), inCluster = host.endsWith(`.svc.${clusterDomain}`);
  if (workload !== UNKNOWN) {
    // Another cluster's workload of the same namespace and name as a local one is still another workload:
    // multi-cluster meshes run the same workloads in each cluster.
    if (otherCluster) return { kind: 'mesh-cluster', cluster };
    const id = w.byName(namespace, workload);
    if (id) return { kind: w.pods(id).some(isEgressGateway) ? 'egress-gateway' : 'workload', id };
    // Istio 1.32 names a ServiceEntry's endpoints as workloads no pod is: each inline endpoint
    // `<entry name>-<index>`, the one endpoint of a DNS entry without endpoints by the entry's name, both in
    // the entry's namespace (pilot/pkg/serviceregistry/serviceentry/conversion.go:363-391, 438-442). So a
    // call to a host that is no service of this cluster went to that host, not to a workload not running now.
    if (service !== UNKNOWN && !inCluster) return { kind: 'external', host };
    return { kind: 'unseen', namespace, name: workload };
  }
  if (inCluster) return otherCluster ? { kind: 'mesh-cluster', cluster } : { kind: 'service', host };
  // The workload is unknown by now. ztunnel reports an address it does not know this way, and so does a
  // Telemetry override that removed the labels.
  if (service === UNKNOWN && serviceName === UNKNOWN) return { kind: 'unattributed' };
  if (service !== UNKNOWN) return { kind: 'external', host };
  return { kind: 'unregistered' };
}

/**
 * A caller with no proxy has no workload name: only the callee's proxy saw the call. A caller in another
 * cluster of the mesh is not the local workload of its namespace and name.
 */
export function callerOf(s: PromSample, w: WorkloadIndex): Caller {
  const workload = labelOf(s, 'source_workload'), namespace = labelOf(s, 'source_workload_namespace');
  if (workload === UNKNOWN) return { kind: 'outside-mesh' };
  const cluster = callerClusterOf(s);
  if (cluster !== undefined) return { kind: 'mesh-cluster', cluster };
  const id = w.byName(namespace, workload);
  return id ? { kind: 'workload', id } : { kind: 'unseen', namespace, name: workload };
}
