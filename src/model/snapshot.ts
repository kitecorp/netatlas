import type { ClusterResources, Labels, NetworkPolicyObject } from './types';
import { detectEnforcer, detectIstio, nameWorkload, type DaemonSetInfo, type OwnedObject, type RawPod } from './workloads';

/** What a source's caches hold at one moment, before the workloads, enforcer and Istio mode are worked out. */
export interface ResourcesInput {
  readonly namespaces: readonly { readonly name: string; readonly labels: Labels }[];
  readonly pods: readonly RawPod[];
  readonly replicaSets: readonly OwnedObject[];
  readonly jobs: readonly OwnedObject[];
  readonly daemonSets: readonly DaemonSetInfo[];
  readonly networkPolicies: readonly NetworkPolicyObject[];
  readonly authorizationPolicies: ClusterResources['authorizationPolicies'];
  readonly readErrors: ClusterResources['readErrors'];
  readonly istioSettings: ClusterResources['istioSettings'];
  readonly serviceEntries: ClusterResources['serviceEntries'];
  readonly sidecars: ClusterResources['sidecars'];
  readonly meshConfig: ClusterResources['meshConfig'];
}

const FINISHED = new Set(['Succeeded', 'Failed']);

export function buildResources(input: ResourcesInput): ClusterResources {
  return {
    namespaces: input.namespaces,
    // A pod that finished (a Job's, mostly) runs nothing, so it is neither a workload nor a peer. The
    // owner only leads to the workload; the model never reads it, so it is not carried on.
    pods: input.pods.filter((raw) => !FINISHED.has(raw.phase)).map((raw) => {
      const { owner: _owner, ...pod } = raw;
      return { ...pod, workload: nameWorkload(raw, input.replicaSets, input.jobs) };
    }),
    networkPolicies: input.networkPolicies,
    authorizationPolicies: input.authorizationPolicies,
    readErrors: input.readErrors,
    enforcer: detectEnforcer(input.daemonSets),
    istio: detectIstio(input.daemonSets, input.pods),
    istioSettings: input.istioSettings,
    serviceEntries: input.serviceEntries,
    sidecars: input.sidecars,
    meshConfig: input.meshConfig,
  };
}
