import type { AuthorizationPolicyObject, ContainerPort, Labels, Mesh, NetworkPolicyObject, PodInfo, PolicyRef } from './types';

/**
 * The pods of one workload that every policy treats alike: the same labels, service account,
 * container ports and mesh. A workload has more than one while a rollout changes any of them.
 */
export interface PodClass {
  readonly id: string;
  readonly workloadId: string;
  readonly namespace: string;
  readonly labels: Labels;
  readonly serviceAccount: string;
  readonly ports: readonly ContainerPort[];
  readonly mesh: Mesh;
}

/** The node that stands for every address outside the cluster. */
export const OUTSIDE = 'outside';

/** `<namespace>/<kind>/<name>`, the id of the workload a pod belongs to. */
export const workloadIdOf = (p: PodInfo): string => `${p.namespace}/${p.workload.kind}/${p.workload.name}`;

export function podClasses(pods: readonly PodInfo[]): PodClass[] {
  const byKey = new Map<string, PodClass>();
  const perWorkload = new Map<string, number>();
  for (const p of pods) {
    const workloadId = workloadIdOf(p);
    const labels = Object.entries(p.labels).sort(([a], [b]) => compareText(a, b));
    const ports = p.ports.map((c) => [c.name ?? '', c.port, c.protocol]).sort();
    const key = JSON.stringify([workloadId, labels, p.serviceAccount, ports, p.mesh]);
    if (byKey.has(key)) continue;
    const n = perWorkload.get(workloadId) ?? 0;
    perWorkload.set(workloadId, n + 1);
    byKey.set(key, {
      id: `${workloadId}#${n}`,
      workloadId,
      namespace: p.namespace,
      labels: p.labels,
      serviceAccount: p.serviceAccount,
      ports: p.ports,
      mesh: p.mesh,
    });
  }
  return [...byKey.values()];
}

/** Compares by code unit, not locale, so that the order is the same on every machine. */
export const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Each policy once, sorted by name, then namespace and kind. */
export function uniqueRefs(refs: Iterable<PolicyRef>): PolicyRef[] {
  const byKey = new Map<string, PolicyRef>();
  for (const r of refs) byKey.set(`${r.kind}/${r.namespace}/${r.name}`, r);
  return [...byKey.values()].sort(
    (a, b) => compareText(a.name, b.name) || compareText(a.namespace, b.namespace) || compareText(a.kind, b.kind),
  );
}

export function refOf(p: NetworkPolicyObject | AuthorizationPolicyObject): PolicyRef {
  // Only a NetworkPolicy has a podSelector, so the spec tells the two apart whether or not the object carries `kind`.
  const kind = 'podSelector' in p.spec ? 'NetworkPolicy' : 'AuthorizationPolicy';
  return { kind, namespace: p.metadata.namespace, name: p.metadata.name };
}
