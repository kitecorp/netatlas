import { cannotReadLine, forbidden } from './format';
import type { ClusterResources, WatchedKind } from './types';

/**
 * The kinds the Policy map, the Traffic view and the Outbound view read, in the order their lines are shown.
 * ReplicaSets and Jobs name the workload a pod belongs to: without the ReplicaSets a Deployment's pod is named
 * by its ReplicaSet, while Istio names it by the Deployment, so its measured calls read `not running now`.
 * DaemonSets are left to the overview, which names them.
 */
const VIEW_KINDS: readonly WatchedKind[] = ['namespaces', 'pods', 'replicasets', 'jobs', 'networkpolicies', 'authorizationpolicies', 'serviceentries', 'sidecars'];

/** The kinds the three views rest on that netatlas may not read, in the order their lines are shown. */
export const unreadViewKinds = (r: ClusterResources): WatchedKind[] => VIEW_KINDS.filter((k) => forbidden(r, k));

/**
 * The lines the Policy map, the Traffic view and the Outbound view show for the kinds netatlas may not read
 * that their verdicts depend on, one `cannotReadLine` per kind, so that none of them reads a refused kind as none.
 */
export function cannotReadLines(r: ClusterResources): string[] {
  return unreadViewKinds(r).map(cannotReadLine);
}
