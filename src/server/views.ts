import type { ClusterSnapshot } from '@/model/types';
import type { ClusterConfig } from './registry';
import type { Store } from './store';

/** Every cluster in the registry's order, as the views read it. */
export function snapshots(store: Store): ClusterSnapshot[] {
  return [...store.clusters.values()].map(({ config, ...rest }) => ({ name: config.name, ...rest }));
}

/** One cluster as the views read it, or undefined for a name the registry does not list. */
export function snapshotOf(store: Store, cluster: string): ClusterSnapshot | undefined {
  const entry = store.clusters.get(cluster);
  if (!entry) return undefined;
  const { config, ...rest } = entry;
  return { name: config.name, ...rest };
}

/** What the frame shows on every page: the clusters by name, and how many of them answer now. */
export function frameOf(store: Store | undefined): { names: string[]; reachable: number } {
  const entries = [...(store?.clusters.values() ?? [])];
  return { names: entries.map((e) => e.config.name), reachable: entries.filter((e) => e.status.state === 'reachable').length };
}

/** How a person gets a token for Apply on this cluster: on EKS the command names the cluster netatlas reads. */
export function tokenHint(c: ClusterConfig): string {
  return c.login.type === 'eks'
    ? `On EKS: aws eks get-token --cluster-name ${c.login.clusterName} --region ${c.login.region} --query status.token --output text`
    : 'kubectl create token <account> --duration 15m';
}
