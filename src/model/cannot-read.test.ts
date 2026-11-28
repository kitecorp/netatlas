import { expect, it } from 'vitest';
import { cannotReadLines } from './cannot-read';
import { SHOP } from './fixtures/shop';
import type { ClusterResources, WatchedKind } from './types';

/** SHOP as a reader delivers it when the API server refuses these kinds: each named in readErrors. */
const refusing = (...kinds: WatchedKind[]): ClusterResources => ({ ...SHOP, readErrors: kinds.map((kind) => ({ kind, reason: 'forbidden' as const })) });

// The views read the namespaces, the pods, the ReplicaSets and Jobs that own pods, both kinds of policy, the
// ServiceEntries and the Sidecars, and name each of them netatlas may not read, always in that order. Without the
// ReplicaSets a Deployment's pod is named by its ReplicaSet, so its measured calls would read `not running now`
// with no line saying why. DaemonSets give no line here; the overview names them.
it.each<[string, ClusterResources, string[]]>([
  ['nothing refused', refusing(), []],
  [
    // The two kinds the map and the Traffic view did not name.
    'ServiceEntries and Sidecars refused',
    refusing('serviceentries', 'sidecars'),
    ["Cannot read ServiceEntries: netatlas's role does not allow it.", "Cannot read Sidecars: netatlas's role does not allow it."],
  ],
  [
    'every kind refused, in another order',
    refusing('sidecars', 'serviceentries', 'daemonsets', 'jobs', 'replicasets', 'authorizationpolicies', 'networkpolicies', 'pods', 'namespaces'),
    [
      "Cannot read Namespaces: netatlas's role does not allow it.",
      "Cannot read Pods: netatlas's role does not allow it.",
      "Cannot read ReplicaSets: netatlas's role does not allow it.",
      "Cannot read Jobs: netatlas's role does not allow it.",
      "Cannot read NetworkPolicies: netatlas's role does not allow it.",
      "Cannot read AuthorizationPolicies: netatlas's role does not allow it.",
      "Cannot read ServiceEntries: netatlas's role does not allow it.",
      "Cannot read Sidecars: netatlas's role does not allow it.",
    ],
  ],
])('cannotReadLines: %s', (_name, r, expected) => {
  expect(cannotReadLines(r)).toStrictEqual(expected);
});
