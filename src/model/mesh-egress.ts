import { compareText, uniqueRefs, type PodClass } from './classes';
import { joinNames } from './format';
import { isIstiod } from './istio-proxies';
import type { NetpolEvaluator } from './netpol';
import { admits } from './ports';
import type { ClusterResources, Labels, PolicyRef, Protocol } from './types';

/** A pod the mesh needs that a workload's egress policies keep it from: istiod, which configures its sidecar, or kube-dns. */
export interface MeshEgressGap {
  readonly target: 'istiod' | 'kube-dns';
  readonly via: readonly PolicyRef[];
}

type Target = MeshEgressGap['target'];

/** Whether a pod with these labels serves the cluster's DNS, as kube-dns and CoreDNS label theirs. */
export const isKubeDns = (labels: Labels): boolean => labels['k8s-app'] === 'kube-dns';

interface Need {
  readonly port: number;
  readonly protocol: Protocol;
  /** What the workload loses when its egress leaves the target out. */
  readonly loss: string;
  /** Whether a class is one of the target's pods. */
  readonly serves: (c: PodClass, r: ClusterResources) => boolean;
  /** Whether a class needs the target at all. */
  readonly needs: (c: PodClass) => boolean;
  /**
   * Whether an address rule that admits the port counts as reaching the target. netatlas cannot tell
   * which address answers DNS (NodeLocal DNSCache listens on a link-local one), so for kube-dns it does.
   */
  readonly byAddress: boolean;
}

// Names resolve over UDP, so kube-dns is asked for UDP 53; only a sidecar asks istiod for its configuration.
const NEEDS: Readonly<Record<Target, Need>> = {
  istiod: {
    port: 15012,
    protocol: 'TCP',
    // The agent's readiness probe fails until istiod's first CDS and LDS updates arrive (pilot-agent status/ready/probe.go:45-83).
    loss: 'New pods do not become ready while these policies apply: their sidecar waits for configuration from istiod.',
    serves: (c, r) => c.namespace === r.istioSettings.rootNamespace && isIstiod(c),
    needs: (c) => c.mesh === 'sidecar',
    byAddress: false,
  },
  'kube-dns': {
    port: 53,
    protocol: 'UDP',
    loss: 'Names do not resolve.',
    serves: (c) => isKubeDns(c.labels),
    needs: () => true,
    byAddress: true,
  },
};

/** The targets in the order a workload's gaps are listed. */
const TARGETS: readonly Target[] = ['istiod', 'kube-dns'];

/**
 * The gaps of each workload that has one, by workload id, sorted. A workload has a gap when one of its
 * classes needs the target, its egress is restricted, and no egress rule admits the target's port on
 * any of the target's pods (nor, for kube-dns, on an address). A target with no pod seen (an external
 * control plane, say) is not checked, and neither are the target's own pods: CoreDNS resolves through
 * its upstream, never through itself, and istiod does not ask itself for configuration.
 */
export function meshEgressGaps(r: ClusterResources, e: NetpolEvaluator): ReadonlyMap<string, readonly MeshEgressGap[]> {
  const byWorkload = new Map<string, Map<Target, PolicyRef[]>>();
  for (const target of TARGETS) {
    const need = NEEDS[target];
    const pods = e.classes.filter((c) => need.serves(c, r));
    const [first] = pods;
    if (!first) continue;
    for (const a of e.classes) {
      if (!need.needs(a) || need.serves(a, r)) continue;
      // restrictedBy names the policies that select a, so any one of the target's pods gives it.
      const { restrictedBy } = e.egress(a, first);
      if (!restrictedBy.length) continue;
      if (pods.some((b) => admits(e.egress(a, b).ports, need.port, need.protocol)) || (need.byAddress && reachesByAddress(e, a, need))) continue;
      const gaps = byWorkload.get(a.workloadId) ?? new Map<Target, PolicyRef[]>();
      gaps.set(target, [...(gaps.get(target) ?? []), ...restrictedBy]);
      byWorkload.set(a.workloadId, gaps);
    }
  }
  return new Map(
    [...byWorkload]
      .sort(([x], [y]) => compareText(x, y))
      .map(([id, gaps]) => [id, [...gaps].map(([target, via]): MeshEgressGap => ({ target, via: uniqueRefs(via) }))] as const),
  );
}

/** Whether an address rule of a's egress, a peerless one or an ipBlock, admits the target's port. */
function reachesByAddress(e: NetpolEvaluator, a: PodClass, need: Need): boolean {
  const rules = e.addresses(a);
  return rules === 'any' || rules.some((rule) => admits(rule.ports, need.port, need.protocol));
}

/** `cannot reach istiod on TCP 15012 (frontend-allow). New pods …`: the gap as the rest of a sentence about the workload. */
export function meshEgressText(g: MeshEgressGap): string {
  const need = NEEDS[g.target];
  return `cannot reach ${g.target} on ${need.protocol} ${need.port} (${joinNames(g.via.map((v) => v.name))}). ${need.loss}`;
}
