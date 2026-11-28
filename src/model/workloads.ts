// What the cluster's controllers say about its pods: which workload owns each pod, which
// NetworkPolicy enforcer runs, and how Istio is installed. The direct source trims the objects it
// watches to these shapes, so the rules below read only what the cache keeps.
import { isIstiod } from './istio-proxies';
import type { Enforcer, IstioMode, PodInfo, WorkloadRef } from './types';

/** A pod as the source keeps it: everything the model reads except its workload, plus its owner. */
export type RawPod = Omit<PodInfo, 'workload'> & { readonly owner?: WorkloadRef };

/** A ReplicaSet or a Job, kept only to find the workload above a pod. */
export interface OwnedObject {
  readonly namespace: string;
  readonly name: string;
  readonly owner?: WorkloadRef;
}

export interface DaemonSetInfo {
  readonly namespace: string;
  readonly name: string;
  readonly containers: readonly { readonly name: string; readonly args: readonly string[] }[];
}

/**
 * Each list is indexed once by namespace and name. buildResources passes the same two lists for
 * every pod, so a cluster with many pods does not scan the ReplicaSets once per pod.
 */
const indexes = new WeakMap<readonly OwnedObject[], ReadonlyMap<string, OwnedObject>>();
function find(list: readonly OwnedObject[], namespace: string, name: string): OwnedObject | undefined {
  let index = indexes.get(list);
  if (!index) {
    index = new Map(list.map((o) => [`${o.namespace}/${o.name}`, o]));
    indexes.set(list, index);
  }
  return index.get(`${namespace}/${name}`);
}

/** The name the pod's metrics and policies are grouped under: the controller a person created, not the one it made. */
export function nameWorkload(pod: RawPod, replicaSets: readonly OwnedObject[], jobs: readonly OwnedObject[]): WorkloadRef {
  const owner = pod.owner;
  if (!owner || owner.kind === 'Node') return { kind: 'Pod', name: pod.name };
  const above = (list: readonly OwnedObject[], kind: string) => {
    const parent = find(list, pod.namespace, owner.name)?.owner;
    return parent?.kind === kind ? parent : owner;
  };
  if (owner.kind === 'ReplicaSet') return above(replicaSets, 'Deployment');
  if (owner.kind === 'Job') return above(jobs, 'CronJob');
  return owner;
}

const hasDaemonSet = (ds: readonly DaemonSetInfo[], name: string) => ds.some((d) => d.name === name);

/** The AWS VPC CNI enforces policies only when its node agent runs with this flag. */
const awsEnforces = (ds: readonly DaemonSetInfo[]) =>
  ds.some(
    (d) =>
      d.name === 'aws-node' &&
      d.containers.some((c) => c.name === 'aws-eks-nodeagent' && c.args.includes('--enable-network-policy=true')),
  );

export function detectEnforcer(ds: readonly DaemonSetInfo[]): Enforcer | null {
  if (hasDaemonSet(ds, 'calico-node')) return 'Calico';
  if (hasDaemonSet(ds, 'cilium')) return 'Cilium';
  if (awsEnforces(ds)) return 'AWS VPC CNI';
  return null;
}

export function detectIstio(ds: readonly DaemonSetInfo[], pods: readonly RawPod[]): IstioMode {
  if (hasDaemonSet(ds, 'ztunnel')) return 'ambient';
  // Every istiod pod carries app=istiod, revisioned installs included, while its name has a revision and a hash.
  if (pods.some(isIstiod)) return 'sidecars';
  return 'none';
}
