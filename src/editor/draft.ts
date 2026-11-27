import { policyTypesOf } from '@/model/netpol';
import type { LabelSelector, NetworkPolicyObject, NetworkPolicySpec, Peer, PolicyPort, PolicyRule } from '@/model/types';
import { parseCidr, parseLabels, parsePorts } from './parse';
import { displayRule, toYaml } from './yaml';

export type Side = 'in' | 'out';
export type Group = 'outside' | 'namespace' | 'cluster';

export type RuleInput = {
  readonly group: Group;
  readonly kind: 'any' | 'cidr' | 'labels' | 'dns';
  readonly cidr?: string;
  readonly ns?: string;
  readonly pod?: string;
  readonly ports: string;
};

export interface Row {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly kept: boolean;
}

declare const opaque: unique symbol;
export type Draft = { readonly [opaque]: true };

/** A rule of one side: the policy's own (with the peers removed from it) or one added in the editor. */
interface DraftRule {
  readonly rule: PolicyRule;
  readonly removedPeers: readonly number[];
  readonly removed: boolean;
  readonly added: boolean;
}

interface SideState {
  readonly open: boolean;
  /** Removed rules stay in the list, so every other row keeps its id. */
  readonly rules: readonly DraftRule[];
}

interface State {
  readonly base: NetworkPolicyObject;
  readonly in: SideState;
  readonly out: SideState;
}

const stateOf = (d: Draft) => d as unknown as State;
const draftOf = (s: State) => s as unknown as Draft;

const SIDES: readonly Side[] = ['in', 'out'];
const RULES_KEY = { in: 'ingress', out: 'egress' } as const;
const PEERS_KEY = { in: 'from', out: 'to' } as const;
const TYPE = { in: 'Ingress', out: 'Egress' } as const;
const GROUPS: readonly Group[] = ['outside', 'namespace', 'cluster'];

const ANY_ADDRESS = '0.0.0.0/0';
const ANYTHING = 'Anything, in this cluster or outside it';
const KEPT = 'Kept as written';
const DNS_TITLE = 'Kubernetes DNS';
const DNS_DETAIL = 'kube-dns in kube-system, UDP and TCP 53';
const NAMESPACE_NAME = 'kubernetes.io/metadata.name';
const KUBE_DNS_PEER: Peer = { namespaceSelector: { matchLabels: { [NAMESPACE_NAME]: 'kube-system' } }, podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } } };
const DNS_PORTS: readonly PolicyPort[] = [
  { port: 53, protocol: 'UDP' },
  { port: 53, protocol: 'TCP' },
];

const peersOf = (rule: PolicyRule, s: Side): readonly Peer[] => rule[PEERS_KEY[s]] ?? [];
const baseOpen = (p: NetworkPolicyObject, s: Side) => !policyTypesOf(p.spec).includes(TYPE[s]);

const only = (o: object, keys: readonly string[]) => Object.keys(o).every((k) => keys.includes(k));
const labelsOf = (sel: LabelSelector | undefined) => Object.entries(sel?.matchLabels ?? {});
const sameLabels = (sel: LabelSelector | undefined, labels: Readonly<Record<string, string>>) =>
  sel !== undefined && only(sel, ['matchLabels']) && JSON.stringify(labelsOf(sel).sort()) === JSON.stringify(Object.entries(labels).sort());

// What the editor can draw: an ipBlock without except, a selector with matchLabels only, a numbered
// port without endPort, and a rule with no other keys. Anything else is kept as written.
const drawnSelector = (sel: LabelSelector | undefined) => sel === undefined || only(sel, ['matchLabels']);
const drawnPeer = (p: Peer) =>
  Object.keys(p).length > 0 &&
  (p.ipBlock ? only(p, ['ipBlock']) && only(p.ipBlock, ['cidr']) : only(p, ['podSelector', 'namespaceSelector']) && drawnSelector(p.podSelector) && drawnSelector(p.namespaceSelector));
const drawnPort = (p: PolicyPort) => typeof p.port === 'number' && only(p, ['port', 'protocol']);
const drawn = (rule: PolicyRule, s: Side) => only(rule, [PEERS_KEY[s], 'ports']) && peersOf(rule, s).every(drawnPeer) && (rule.ports ?? []).every(drawnPort);

/** One kube-system kube-dns peer on exactly UDP and TCP 53. */
function isDns(rule: PolicyRule, s: Side): boolean {
  const peers = peersOf(rule, s), ports = rule.ports ?? [];
  const peer = peers[0];
  return (
    peers.length === 1 &&
    peer !== undefined &&
    only(peer, ['namespaceSelector', 'podSelector']) &&
    sameLabels(peer.namespaceSelector, { [NAMESPACE_NAME]: 'kube-system' }) &&
    sameLabels(peer.podSelector, { 'k8s-app': 'kube-dns' }) &&
    ports.length === 2 &&
    ports.every((p) => p.port === 53) &&
    ports.map((p) => p.protocol ?? 'TCP').sort().join() === 'TCP,UDP'
  );
}

const groupOf = (p: Peer | undefined): Group => (p?.ipBlock ? 'outside' : p && !p.namespaceSelector ? 'namespace' : 'cluster');

const pairsText = (sel: LabelSelector | undefined) => labelsOf(sel).map(([k, v]) => `${k}=${v}`).join(', ');

function nsName(sel: LabelSelector | undefined): string {
  const pairs = labelsOf(sel);
  const [first] = pairs;
  if (!first) return 'every namespace';
  return pairs.length === 1 && first[0] === NAMESPACE_NAME ? `namespace ${first[1]}` : `namespaces with ${pairsText(sel)}`;
}

/** The prototype's ruleTitle, read from a peer. */
function peerTitle(p: Peer, ns: string): string {
  if (p.ipBlock) return p.ipBlock.cidr === ANY_ADDRESS ? 'Any address' : p.ipBlock.cidr;
  const pods = labelsOf(p.podSelector).length ? `Pods with ${pairsText(p.podSelector)}` : 'Every pod';
  if (!p.namespaceSelector) return labelsOf(p.podSelector).length ? pods : `Every pod in ${ns}`;
  return `${pods} in ${nsName(p.namespaceSelector)}`;
}

const portsText = (rule: PolicyRule) => (rule.ports?.length ? rule.ports.map((p) => `${p.protocol ?? 'TCP'} ${String(p.port)}`).join(', ') : 'every port');

/** The prototype's ruleDetail: the rule's ports, after the address when it is any address. */
const peerDetail = (p: Peer, rule: PolicyRule) => `${p.ipBlock?.cidr === ANY_ADDRESS ? `${ANY_ADDRESS}, ` : ''}${portsText(rule)}`;

export function draftFromPolicy(p: NetworkPolicyObject): Draft {
  const side = (s: Side): SideState => ({
    open: baseOpen(p, s),
    rules: (p.spec[RULES_KEY[s]] ?? []).map((rule) => ({ rule, removedPeers: [], removed: false, added: false })),
  });
  return draftOf({ base: p, in: side('in'), out: side('out') });
}

/** The policy the draft started from, as the cluster had it. */
export function baseOf(d: Draft): NetworkPolicyObject {
  return stateOf(d).base;
}

const withSide = (d: Draft, s: Side, change: (side: SideState) => SideState): Draft => {
  const st = stateOf(d);
  return draftOf({ ...st, [s]: change(st[s]) });
};

export function toggleSide(d: Draft, s: Side): Draft {
  return withSide(d, s, (side) => ({ ...side, open: !side.open }));
}

export function isOpen(d: Draft, s: Side): boolean {
  return stateOf(d)[s].open;
}

function newPeer(i: RuleInput): Peer {
  const labels = (text: string | undefined) => Object.fromEntries(parseLabels(text ?? '') ?? []);
  if (i.group === 'outside') return { ipBlock: { cidr: i.kind === 'any' ? ANY_ADDRESS : (parseCidr(i.cidr ?? '') ?? '') } };
  if (i.group === 'namespace') return { podSelector: i.kind === 'any' ? {} : { matchLabels: labels(i.pod) } };
  if (i.kind === 'dns') return KUBE_DNS_PEER;
  if (i.kind === 'any') return { namespaceSelector: {} };
  const pod = labels(i.pod);
  return { namespaceSelector: { matchLabels: labels(i.ns) }, ...(Object.keys(pod).length ? { podSelector: { matchLabels: pod } } : {}) };
}

/** Adds the rule the form describes; a form with a field that does not parse, or a kind its group does not offer, changes nothing. */
export function addRule(d: Draft, s: Side, i: RuleInput): Draft {
  if (invalidFields(i).length || !menuOptions(s, i.group, '').some((o) => o.kind === i.kind)) return d;
  const ports = i.kind === 'dns' ? DNS_PORTS : (parsePorts(i.ports) ?? []);
  const rule: PolicyRule = { [PEERS_KEY[s]]: [newPeer(i)], ...(ports.length ? { ports } : {}) };
  return withSide(d, s, (side) => ({ ...side, rules: [...side.rules, { rule, removedPeers: [], removed: false, added: true }] }));
}

/**
 * Removes the peer of a row, or the whole rule of a kept or peerless row. A rule whose last peer goes
 * is removed with it: left as `from: []` it would let every caller in.
 */
export function removeRow(d: Draft, s: Side, id: string): Draft {
  const m = /^(in|out):(\d+)(?::(\d+))?$/.exec(id);
  if (m?.[1] !== s) return d;
  const index = Number(m[2]), peer = m[3] === undefined ? undefined : Number(m[3]);
  return withSide(d, s, (side) => ({
    ...side,
    rules: side.rules.map((r, i) => {
      if (i !== index || r.removed) return r;
      if (peer === undefined) return { ...r, removed: true };
      const peers = peersOf(r.rule, s);
      if (!drawn(r.rule, s) || peer >= peers.length) return r;
      const removedPeers = [...new Set([...r.removedPeers, peer])];
      return { ...r, removedPeers, removed: removedPeers.length === peers.length };
    }),
  }));
}

const GROUP_TITLES = { outside: 'Outside the cluster', cluster: 'Across the cluster' } as const;

/** The three boxes of one side, each with its rows. A side's rows stay while the side is open. */
export function groupsOf(d: Draft, s: Side): { group: Group; title: string; rows: Row[] }[] {
  const st = stateOf(d), ns = st.base.metadata.namespace;
  const rows = new Map<Group, Row[]>(GROUPS.map((g) => [g, []]));
  const add = (g: Group, row: Row) => rows.get(g)?.push(row);
  st[s].rules.forEach((r, i) => {
    if (r.removed) return;
    const peers = peersOf(r.rule, s);
    if (!drawn(r.rule, s)) add(groupOf(peers[0]), { id: `${s}:${i}`, title: KEPT, detail: toYaml(displayRule(r.rule)).trimEnd(), kept: true });
    else if (!peers.length) add('cluster', { id: `${s}:${i}`, title: ANYTHING, detail: portsText(r.rule), kept: false });
    else if (isDns(r.rule, s)) add('cluster', { id: `${s}:${i}:0`, title: DNS_TITLE, detail: DNS_DETAIL, kept: false });
    else
      peers.forEach((p, j) => {
        if (!r.removedPeers.includes(j)) add(groupOf(p), { id: `${s}:${i}:${j}`, title: peerTitle(p, ns), detail: peerDetail(p, r.rule), kept: false });
      });
  });
  return GROUPS.map((g) => ({ group: g, title: g === 'namespace' ? `In namespace ${ns}` : GROUP_TITLES[g], rows: rows.get(g) ?? [] }));
}

/** The fields of the add-rule form that do not parse, in the form's order. */
export function invalidFields(i: RuleInput): ('ns' | 'pod' | 'cidr' | 'ports')[] {
  const out: ('ns' | 'pod' | 'cidr' | 'ports')[] = [];
  if (i.kind === 'labels' && i.group === 'cluster' && !parseLabels(i.ns ?? '')?.length) out.push('ns');
  if (i.kind === 'labels') {
    const pod = parseLabels(i.pod ?? '');
    // Across the cluster an empty pod field means every pod in those namespaces; in the namespace it would mean nothing.
    if (pod === null || (i.group === 'namespace' && !pod.length)) out.push('pod');
  }
  if (i.group === 'outside' && i.kind === 'cidr' && parseCidr(i.cidr ?? '') === null) out.push('cidr');
  if (i.kind !== 'dns' && parsePorts(i.ports) === null) out.push('ports');
  return out;
}

const ADD_RULE_PLACES = { outside: 'outside the cluster', cluster: 'across the cluster' } as const;

/** The Add rule button's accessible name, which starts with its visible text, as WCAG 2.5.3 asks. */
export function addRuleName(s: Side, group: Group, ns: string): string {
  if (group === 'cluster') return `Add rule: ${s === 'in' ? 'calls in from' : 'calls out'} ${ADD_RULE_PLACES.cluster}`;
  return `Add rule: ${s === 'in' ? 'calls in from' : 'calls out to'} ${group === 'namespace' ? `namespace ${ns}` : ADD_RULE_PLACES.outside}`;
}

/** The prototype's optionsFor: what the Add rule menu of one box offers. */
export function menuOptions(s: Side, group: Group, ns: string): { kind: RuleInput['kind']; title: string; hint: string }[] {
  if (group === 'outside') {
    return [
      { kind: 'any', title: 'Any address', hint: '0.0.0.0/0, on every port or the ones you choose' },
      { kind: 'cidr', title: 'An address range', hint: 'For example 10.0.0.0/8' },
    ];
  }
  if (group === 'namespace') {
    return [
      { kind: 'any', title: `Every pod in ${ns}`, hint: 'On every port or the ones you choose' },
      { kind: 'labels', title: 'Pods with labels', hint: 'For example app=frontend, version=2' },
    ];
  }
  return [
    { kind: 'any', title: 'Every pod in every namespace', hint: 'On every port or the ones you choose' },
    { kind: 'labels', title: 'Pods in chosen namespaces', hint: 'By namespace labels, and pod labels if you want' },
    ...(s === 'out' ? [{ kind: 'dns' as const, title: DNS_TITLE, hint: 'kube-dns in kube-system, port 53' }] : []),
  ];
}

const changed = (st: State, s: Side) => st[s].open !== baseOpen(st.base, s) || st[s].rules.some((r) => r.added || r.removed || r.removedPeers.length > 0);

/**
 * The spec to save. A side nobody touched keeps the base's value exactly, and every field the editor
 * does not model passes through. An open side drops its rules and its policyTypes entry.
 */
export function specOf(d: Draft): NetworkPolicySpec {
  const st = stateOf(d), base = st.base.spec;
  const spec: Record<string, unknown> = { ...base };
  for (const s of SIDES) {
    if (!changed(st, s)) continue;
    const rules = st[s].open
      ? []
      : st[s].rules
          .filter((r) => !r.removed)
          .map((r) => (r.removedPeers.length ? { ...r.rule, [PEERS_KEY[s]]: peersOf(r.rule, s).filter((_, j) => !r.removedPeers.includes(j)) } : r.rule));
    if (rules.length) spec[RULES_KEY[s]] = rules;
    else delete spec[RULES_KEY[s]];
  }
  // The base's order, without the open sides, then each newly restricted side.
  const intended = policyTypesOf(base).filter((t) => SIDES.some((s) => TYPE[s] === t && !st[s].open));
  for (const s of SIDES) if (!st[s].open && !intended.includes(TYPE[s])) intended.push(TYPE[s]);
  // Kubernetes defaults an absent policyTypes from the egress rules, so it is written out whenever that default would differ.
  const effective = policyTypesOf(spec as NetworkPolicySpec);
  const sameSet = effective.length === intended.length && effective.every((t) => intended.includes(t));
  if (SIDES.some((s) => st[s].open !== baseOpen(st.base, s)) || !sameSet) spec.policyTypes = intended;
  return spec as NetworkPolicySpec;
}

/** With both sides open the policy blocks nothing; netatlas does not delete policies, so it is not saved. */
export function canSave(d: Draft): { ok: true } | { ok: false; reason: 'both-open' } {
  const st = stateOf(d);
  return st.in.open && st.out.open ? { ok: false, reason: 'both-open' } : { ok: true };
}
