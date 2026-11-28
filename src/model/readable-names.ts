import { workloadText } from './format';

/** What the rule needs of a workload: its id, and the namespace and name a person reads. */
export interface NamedWorkload {
  readonly id: string;
  readonly namespace: string;
  readonly name: string;
}

/**
 * Each workload by its bare name, or as `<namespace> / <name>` when another workload of the cluster has that
 * name, so it cannot be mistaken; by id. Every text that names a workload beside others (What stands out, the
 * spoken edge labels of both maps) reads it this one way.
 */
export function readableNames(workloads: readonly NamedWorkload[]): ReadonlyMap<string, string> {
  const sharing = Map.groupBy(workloads, (w) => w.name);
  return new Map(workloads.map((w) => [w.id, (sharing.get(w.name)?.length ?? 0) > 1 ? workloadText(w.namespace, w.name) : w.name]));
}
