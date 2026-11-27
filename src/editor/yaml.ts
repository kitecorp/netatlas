import { stringify } from 'yaml';
import type { AuthorizationPolicyObject, NetworkPolicyObject, Peer, PolicyPort, PolicyRule } from '@/model/types';

/** The annotation `kubectl apply` writes: a copy of the whole policy, which is noise in a review. */
const LAST_APPLIED = 'kubectl.kubernetes.io/last-applied-configuration';
/** Fields the API server keeps for itself; a copy pasted into git must not carry them. */
const SERVER_FIELDS = new Set(['uid', 'resourceVersion', 'generation', 'creationTimestamp', 'managedFields']);

type Obj = Readonly<Record<string, unknown>>;

/** `o` with the keys of `order` first, in that order, then every other key in its own order. */
function ordered(o: Obj, order: readonly string[]): Obj {
  const known = order.filter((k) => Object.hasOwn(o, k));
  return Object.fromEntries([...known, ...Object.keys(o).filter((k) => !order.includes(k))].map((k) => [k, o[k]]));
}

/** `o` with `key` replaced by `f` of its value, only where `o` has it, so no key appears that was not there. */
const mapKey = (o: Obj, key: string, f: (v: never) => unknown): Obj => (Object.hasOwn(o, key) ? { ...o, [key]: f(o[key] as never) } : o);

const displayPeer = (p: Peer) => ordered(p, ['namespaceSelector', 'podSelector', 'ipBlock']);
const displayPort = (p: PolicyPort) => ordered(p, ['port', 'endPort', 'protocol']);

/** One rule in the order the prototype writes it: its peers (`from` or `to`), then its ports. */
export function displayRule(rule: PolicyRule): Obj {
  const peers = (o: Obj, key: string) => mapKey(o, key, (ps: readonly Peer[]) => ps.map(displayPeer));
  const withPorts = mapKey(peers(peers(rule, 'from'), 'to'), 'ports', (ps: readonly PolicyPort[]) => ps.map(displayPort));
  return ordered(withPorts, ['from', 'to', 'ports']);
}

/**
 * The policy as Copy YAML, the review and the Istio view show it: without the fields the server keeps for itself and
 * the last-applied annotation, its known keys in the prototype's order, and every other field kept,
 * so nothing the editor does not model is lost. The base and the draft both pass through it, so an
 * untouched draft shows no difference.
 */
export function forDisplay(p: NetworkPolicyObject | AuthorizationPolicyObject): unknown {
  const metaFields = Object.entries(p.metadata).filter(([k]) => !SERVER_FIELDS.has(k) && k !== 'annotations');
  const annotations = Object.entries(p.metadata.annotations ?? {}).filter(([k]) => k !== LAST_APPLIED);
  const metadata = ordered(Object.fromEntries([...metaFields, ...(annotations.length ? [['annotations', Object.fromEntries(annotations)]] : [])]), ['name', 'namespace', 'labels', 'annotations']);
  const rules = (rs: readonly PolicyRule[]) => rs.map(displayRule);
  // An AuthorizationPolicy has none of these keys, so its spec stays as written.
  const spec = ordered(mapKey(mapKey(p.spec as Obj, 'ingress', rules), 'egress', rules), ['podSelector', 'policyTypes', 'ingress', 'egress']);
  return ordered({ ...p, metadata, spec }, ['apiVersion', 'kind', 'metadata', 'spec']);
}

/** YAML 1.1, so every string a 1.1 reader would take for another type (yes, on, 0123, null) is quoted. */
export function toYaml(v: unknown): string {
  return stringify(v, { version: '1.1', indent: 2, lineWidth: 0 });
}
