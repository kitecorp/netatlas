import { compareText, podClasses, refOf, uniqueRefs, type PodClass } from './classes';
import { joinNames } from './format';
import { matchesSelector } from './selectors';
import type { AuthorizationPolicyObject, ClusterResources, IstioOperation, IstioRule, IstioSource, Labels, PolicyRef } from './types';

export interface IstioEdge {
  readonly from: string;
  readonly to: string;
  /** The requests the edge allows, such as 'GET /cart' or 'any request'. */
  readonly label: string;
  /** The ALLOW policies that let the call in; empty when no ALLOW policy selects the callee. */
  readonly via: readonly PolicyRef[];
  /** The CUSTOM and DENY policies that may refuse some of its requests; absent when there is none. A CUSTOM or DENY policy allows nothing. */
  readonly mayRefuse?: readonly PolicyRef[];
  readonly depends?: 'depends on the request';
  /** Set when the caller is outside the mesh: its plain-text call gets in only while the destination's mutual TLS mode is not STRICT. */
  readonly plainText?: 'accepted unless mutual TLS is STRICT';
}

export interface IstioResult {
  /** The policies that apply to each workload. */
  readonly applied: ReadonlyMap<string, readonly PolicyRef[]>;
  /** The policies of workloads outside the mesh, which have no proxy to enforce them. */
  readonly notEnforced: ReadonlyMap<string, readonly PolicyRef[]>;
  /** Policies attached to a waypoint by targetRef or targetRefs, which netatlas shows as text and does not evaluate. */
  readonly notEvaluated: readonly PolicyRef[];
  readonly edges: readonly IstioEdge[];
  /**
   * The pairs of workloads whose every call Istio refuses, whichever pods make and serve it, sorted by
   * caller and callee. An edge's absence does not say this: a callee with only DENY policies (or, in
   * ambient, only CUSTOM ones) has no edge and lets in every caller no DENY rule names.
   */
  readonly denied: readonly { readonly from: string; readonly to: string }[];
  /**
   * Each workload in the mesh that CUSTOM or DENY policies select and no ALLOW policy does, with those policies: Istio
   * lets in every request to it that they do not refuse. A workload with any pod an ALLOW policy selects is left out.
   */
  readonly withoutAllow: ReadonlyMap<string, readonly PolicyRef[]>;
}

type Match = 'yes' | 'no' | 'depends';
/** The actions evaluated per caller; CUSTOM is matched as an ALLOW rule is, since its rules say which requests go to the external service. */
type Action = 'ALLOW' | 'DENY';
/** The caller's mutual TLS identity; every part is empty for a plain-text caller, which has none. */
interface Source {
  readonly principal: string;
  readonly namespace: string;
  /** `<namespace>/<account>`. */
  readonly serviceAccount: string;
  readonly trustDomain: string;
}

const DEPENDS = 'depends on the request';
const PLAIN_TEXT = 'accepted unless mutual TLS is STRICT';
const ANY_REQUEST = 'any request';

/**
 * Istio's string match: exact, a 'prefix*', a '*suffix', or '*', which is a presence match: "`*`
 * will match when value is not empty" (https://istio.io/latest/docs/reference/config/security/authorization-policy/).
 */
export function istioMatch(pattern: string, value: string): boolean {
  if (pattern === '*') return value !== '';
  if (pattern.startsWith('*')) return value.endsWith(pattern.slice(1));
  if (pattern.endsWith('*')) return value.startsWith(pattern.slice(0, -1));
  return pattern === value;
}

// Every part of one source or rule must hold, so the weakest part decides; any one of several sources
// or operations suffices, so the strongest decides.
const RANK: Readonly<Record<Match, number>> = { no: 0, depends: 1, yes: 2 };
const all = (ms: readonly Match[]): Match => ms.reduce<Match>((a, m) => (RANK[m] < RANK[a] ? m : a), 'yes');
const any = (ms: readonly Match[]): Match => ms.reduce<Match>((a, m) => (RANK[m] > RANK[a] ? m : a), 'no');

const listed = (values: readonly string[] | undefined): values is readonly string[] => !!values?.length;

/** A field Istio compares with the mutual TLS identity: `values` must match, `notValues` must not. */
const identity = (value: string, values: readonly string[] | undefined, notValues: readonly string[] | undefined): Match[] => [
  ...(listed(values) ? [values.some((p) => istioMatch(p, value)) ? 'yes' : 'no'] as const : []),
  ...(listed(notValues) ? [notValues.some((p) => istioMatch(p, value)) ? 'no' : 'yes'] as const : []),
];

// The fields of a rule, source and operation that the reference lists (https://istio.io/latest/docs/
// reference/config/security/authorization-policy/, read for release 1.32, the Istio the journeys install).
// A field outside these lists could narrow or widen the rule in ways netatlas cannot know, so it makes
// that part depend on the request: it never reads as "any source".
const RULE_FIELDS = new Set(['from', 'to', 'when']);
const FROM_FIELDS = new Set(['source']);
const TO_FIELDS = new Set(['operation']);
const SOURCE_FIELDS = new Set([
  'principals', 'notPrincipals', 'requestPrincipals', 'notRequestPrincipals', 'namespaces', 'notNamespaces',
  'serviceAccounts', 'notServiceAccounts', 'ipBlocks', 'notIpBlocks', 'remoteIpBlocks', 'notRemoteIpBlocks',
  'trustDomains', 'notTrustDomains',
]);
const OPERATION_FIELDS = new Set(['hosts', 'notHosts', 'ports', 'notPorts', 'methods', 'notMethods', 'paths', 'notPaths']);
const unknown = (o: object, known: ReadonlySet<string>): Match[] => (Object.keys(o).some((k) => !known.has(k)) ? ['depends'] : []);

/**
 * `serviceAccounts` is `<namespace>/<account>`, or `<account>` for one in the policy's namespace, and
 * allows "no form of wildcard", so it is compared exactly.
 */
function accounts(src: Source, policyNs: string, values: readonly string[] | undefined, notValues: readonly string[] | undefined): Match[] {
  const named = (vs: readonly string[]) => vs.some((v) => src.serviceAccount !== '' && (v.includes('/') ? v : `${policyNs}/${v}`) === src.serviceAccount);
  return [...(listed(values) ? [named(values) ? 'yes' : 'no'] as const : []), ...(listed(notValues) ? [named(notValues) ? 'no' : 'yes'] as const : [])];
}

function sourceMatch(s: IstioSource, src: Source, policyNs: string): Match {
  // JWT principals and addresses are known only from each request.
  const perRequest = [s.requestPrincipals, s.notRequestPrincipals, s.ipBlocks, s.notIpBlocks, s.remoteIpBlocks, s.notRemoteIpBlocks].some(listed);
  return all([
    ...identity(src.principal, s.principals, s.notPrincipals),
    ...identity(src.namespace, s.namespaces, s.notNamespaces),
    ...accounts(src, policyNs, s.serviceAccounts, s.notServiceAccounts),
    ...identity(src.trustDomain, s.trustDomains, s.notTrustDomains),
    ...(perRequest ? ['depends' as const] : []),
    ...unknown(s, SOURCE_FIELDS),
  ]);
}

function operationLabel(o: IstioOperation): string {
  const values = (prefix: string, vs: readonly string[] | undefined) => (listed(vs) ? [`${prefix}${vs.join(',')}`] : []);
  const label = [
    ...values('', o.methods),
    ...values('not ', o.notMethods),
    ...values('', o.paths),
    ...values('not ', o.notPaths),
    ...values('host ', o.hosts),
    ...values('not host ', o.notHosts),
    ...values('port ', o.ports),
    ...values('not port ', o.notPorts),
  ].join(' ');
  return label || ANY_REQUEST;
}

/**
 * A DENY rule denies only the requests its operation matches: "Deny a request if it matches any of the
 * rules" (https://istio.io/latest/docs/reference/config/security/authorization-policy/). Methods, paths
 * and hosts are known only from each request, and netatlas shows ports without checking them, so a DENY
 * operation that names any of them depends on the request; the ALLOW edge carries them in its label.
 */
function operationMatch(o: IstioOperation, action: Action): Match {
  const named = [o.methods, o.notMethods, o.paths, o.notPaths, o.hosts, o.notHosts, o.ports, o.notPorts].some(listed);
  return all([action === 'DENY' && named ? 'depends' : 'yes', ...unknown(o, OPERATION_FIELDS)]);
}

// What ztunnel cannot read, as Istio 1.32 turns a selector policy into ztunnel's form
// (pilot/pkg/serviceregistry/ambient/authorization.go: httpOperations, httpSources, l4WhenAttributes;
// https://istio.io/latest/docs/ambient/usage/l4-policy/, "Policies with Layer 7 conditions").
const HTTP_OPERATION = ['hosts', 'notHosts', 'methods', 'notMethods', 'paths', 'notPaths'];
const HTTP_SOURCE = ['requestPrincipals', 'notRequestPrincipals', 'remoteIpBlocks', 'notRemoteIpBlocks'];
const L4_CONDITIONS = new Set(['source.ip', 'source.namespace', 'source.principal', 'destination.ip', 'destination.port']);
// handleRule builds ztunnel's source match from ipBlocks, namespaces, serviceAccounts and principals
// only, so it drops a source's trust domains for either action, and flags nothing.
const TRUST_DOMAINS = ['trustDomains', 'notTrustDomains'];

const names = (o: object, keys: readonly string[]) => keys.some((k) => listed((o as Record<string, readonly string[] | undefined>)[k]));
const without = <T extends object>(o: T, keys: readonly string[]): T => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k))) as T;
const isEmpty = (o: object) => Object.values(o).every((v) => v === undefined || (Array.isArray(v) && v.length === 0));

/**
 * One rule as ztunnel enforces it on an ambient destination without a waypoint, or undefined when it
 * never matches. An ALLOW rule with an HTTP attribute is dropped. A DENY rule loses its HTTP attributes,
 * and either rule loses its sources' trust domains. An entry left with nothing matches nothing, so a list
 * of such entries, or an HTTP condition, makes the whole rule never match (Istio's isMatchEmpty: "An
 * empty match sent to ztunnel is skipped").
 */
function forZtunnel(rule: IstioRule, action: Action): IstioRule | undefined {
  const from = rule.from ?? [], to = rule.to ?? [], when = rule.when ?? [];
  const httpWhen = when.some((c) => !L4_CONDITIONS.has(c.key));
  const http = httpWhen || from.some((f) => names(f.source ?? {}, HTTP_SOURCE)) || to.some((t) => names(t.operation ?? {}, HTTP_OPERATION));
  if (http && (action === 'ALLOW' || httpWhen)) return undefined;
  const strip = <E extends object>(entries: readonly E[], key: 'source' | 'operation', http: readonly string[]): E[] | undefined => {
    const kept = entries.flatMap((e) => {
      const inner = (e as Record<string, object | undefined>)[key] ?? {};
      if (!names(inner, http)) return [e];
      const left = without(inner, http);
      return isEmpty(left) ? [] : [{ ...e, [key]: left }];
    });
    return entries.length && !kept.length ? undefined : kept;
  };
  const keptFrom = strip(from, 'source', http ? [...HTTP_SOURCE, ...TRUST_DOMAINS] : TRUST_DOMAINS), keptTo = http ? strip(to, 'operation', HTTP_OPERATION) : to;
  if (!keptFrom || !keptTo) return undefined;
  return { ...rule, ...(rule.from ? { from: keptFrom } : {}), ...(rule.to ? { to: keptTo } : {}) };
}

/** Whether one rule holds for every request from `src` to `dst`, for none, or depends on the request; and what it allows. */
function ruleMatch(written: IstioRule, src: Source, dst: PodClass, policyNs: string, action: Action): { match: Match; label: string } {
  const rule = dst.mesh === 'ambient' ? forZtunnel(written, action) : written;
  if (!rule) return { match: 'no', label: ANY_REQUEST };
  const from = rule.from ?? [], to = rule.to ?? [];
  const source = from.length ? any(from.map((f) => all([sourceMatch(f.source ?? {}, src, policyNs), ...unknown(f, FROM_FIELDS)]))) : 'yes';
  const operation = to.length ? any(to.map((t) => all([operationMatch(t.operation ?? {}, action), ...unknown(t, TO_FIELDS)]))) : 'yes';
  // Any condition depends on the request, so a field netatlas does not know inside one changes nothing.
  const when: Match = rule.when?.length ? 'depends' : 'yes';
  const operations = to.map((t) => t.operation ?? {});
  return {
    match: all([source, operation, when, ...unknown(rule, RULE_FIELDS)]),
    label: operations.length ? operations.map(operationLabel).join('; ') : ANY_REQUEST,
  };
}

/** A policy attached to a waypoint by targetRef or targetRefs, which netatlas shows as text and does not evaluate. */
export const attachedToWaypoint = (p: AuthorizationPolicyObject): boolean => !!p.spec.targetRef || !!p.spec.targetRefs?.length;

/**
 * Whether a selector policy applies to pods of this namespace and labels: one in the root namespace
 * applies across the mesh, and one without a selector to its whole namespace.
 */
export function appliesTo(p: AuthorizationPolicyObject, rootNamespace: string, pod: { readonly namespace: string; readonly labels: Labels }): boolean {
  return (p.metadata.namespace === rootNamespace || p.metadata.namespace === pod.namespace) && matchesSelector({ matchLabels: p.spec.selector?.matchLabels ?? {} }, pod.labels);
}

const add = (m: Map<string, PolicyRef[]>, key: string, refs: readonly PolicyRef[]) => m.set(key, [...(m.get(key) ?? []), ...refs]);

/** Istio's order: CUSTOM, then DENY, then ALLOW. AUDIT only logs; waypoint policies are not evaluated. */
export function evaluateAuthorizationPolicies(r: ClusterResources): IstioResult {
  const applied = new Map<string, PolicyRef[]>(), notEnforced = new Map<string, PolicyRef[]>(), notEvaluated: PolicyRef[] = [], edges: IstioEdge[] = [];
  const refusersOnly = new Map<string, PolicyRef[]>(), allowed = new Set<string>();
  if (r.authorizationPolicies === 'not-installed') return { applied, notEnforced, notEvaluated, edges, denied: [], withoutAllow: refusersOnly };
  const { rootNamespace, trustDomain } = r.istioSettings;
  const classes = podClasses(r.pods);
  // The class pairs refused, counted per pair of workloads: the workloads' pair is refused only when all are.
  const refused = new Map<string, { from: string; to: string; classes: number }>();
  const refuse = (a: PodClass, b: PodClass) => {
    const k = JSON.stringify([a.workloadId, b.workloadId]);
    refused.set(k, { from: a.workloadId, to: b.workloadId, classes: (refused.get(k)?.classes ?? 0) + 1 });
  };
  const policies = r.authorizationPolicies.filter((p) => {
    if (attachedToWaypoint(p)) {
      notEvaluated.push(refOf(p));
      return false;
    }
    return p.spec.action !== 'AUDIT';
  });
  const rulesOf = (p: AuthorizationPolicyObject) => p.spec.rules ?? [];
  for (const b of classes) {
    const applies = policies.filter((p) => appliesTo(p, rootNamespace, b));
    if (!applies.length) continue;
    add(applied, b.workloadId, applies.map(refOf));
    if (b.mesh === 'none') {
      add(notEnforced, b.workloadId, applies.map(refOf));
      continue;
    }
    const of = (action: string) => applies.filter((p) => (p.spec.action ?? 'ALLOW') === action);
    const custom = of('CUSTOM'), deny = of('DENY'), allow = of('ALLOW');
    if (allow.length) allowed.add(b.workloadId);
    else add(refusersOnly, b.workloadId, [...custom, ...deny].map(refOf));
    for (const a of classes) {
      if (a.workloadId === b.workloadId) continue;
      // `principals`, `namespaces`, `serviceAccounts` and `trustDomains` are "derived from the peer
      // certificate" and need mutual TLS (https://istio.io/latest/docs/reference/config/security/authorization-policy/,
      // Source). A pod outside the mesh calls in plain text with no peer certificate, so all four are
      // empty: they never match it, not even '*', and their `not` forms always hold for it.
      const outside = a.mesh === 'none';
      const src: Source = outside
        ? { principal: '', namespace: '', serviceAccount: '', trustDomain: '' }
        : { principal: `${trustDomain}/ns/${a.namespace}/sa/${a.serviceAccount}`, namespace: a.namespace, serviceAccount: `${a.namespace}/${a.serviceAccount}`, trustDomain };
      const plain = outside ? { plainText: PLAIN_TEXT } as const : {};
      const holds = (p: AuthorizationPolicyObject, action: Action) => any(rulesOf(p).map((rule) => ruleMatch(rule, src, b, p.metadata.namespace, action).match));
      // A CUSTOM policy that may apply hands the request to an external service, so the answer depends on
      // it. Istio never sends one to ztunnel ("ztunnel does not support the CUSTOM action",
      // convertAuthorizationPolicy), so on an ambient destination it decides nothing.
      const deciding = b.mesh === 'ambient' ? [] : custom.filter((p) => holds(p, 'ALLOW') !== 'no');
      const denied = deny.map((p) => [p, holds(p, 'DENY')] as const);
      if (denied.some(([, m]) => m === 'yes')) {
        refuse(a, b);
        continue;
      }
      const denying = denied.filter(([, m]) => m === 'depends').map(([p]) => p);
      // The policies that may decide against the call are named on its edge apart from the ALLOW policies that let it
      // in: a CUSTOM or DENY policy only refuses. Istio builds a CUSTOM policy and a DENY policy into RBAC_DENY filters
      // and only ALLOW policies into an RBAC_ALLOW filter, and none at all from no ALLOW policy, so a workload no ALLOW
      // policy selects lets in every request nothing refuses (pilot/pkg/security/authz/builder/builder.go:186, 200,
      // 205 and 284-287 at 1.32.0).
      const refusers = [...deciding, ...denying].map(refOf);
      const depends = refusers.length > 0;
      const mayRefuse = depends ? { mayRefuse: refusers } : {};
      if (!allow.length) {
        if (depends) edges.push({ from: a.workloadId, to: b.workloadId, label: ANY_REQUEST, via: [], ...mayRefuse, depends: DEPENDS, ...plain });
        continue;
      }
      // An ALLOW policy with no rules matches nothing, so it denies every call.
      let admitted = false;
      for (const p of allow) for (const rule of rulesOf(p)) {
        const m = ruleMatch(rule, src, b, p.metadata.namespace, 'ALLOW');
        if (m.match === 'no') continue;
        admitted = true;
        edges.push({ from: a.workloadId, to: b.workloadId, label: m.label, via: [refOf(p)], ...mayRefuse, ...(m.match === 'depends' || depends ? { depends: DEPENDS } : {}), ...plain });
      }
      if (!admitted) refuse(a, b);
    }
  }
  const perWorkload = new Map<string, number>();
  for (const c of classes) perWorkload.set(c.workloadId, (perWorkload.get(c.workloadId) ?? 0) + 1);
  const classCount = (workloadId: string) => perWorkload.get(workloadId) ?? 0;
  const refusedPairs = [...refused.values()]
    .filter((p) => p.classes === classCount(p.from) * classCount(p.to))
    .map(({ from, to }) => ({ from, to }))
    .sort((a, b) => compareText(a.from, b.from) || compareText(a.to, b.to));
  return {
    applied: byWorkload(applied),
    notEnforced: byWorkload(notEnforced),
    notEvaluated: uniqueRefs(notEvaluated),
    edges: mergeIstioEdges(edges),
    denied: refusedPairs,
    withoutAllow: byWorkload(new Map([...refusersOnly].filter(([id]) => !allowed.has(id)))),
  };
}

const byWorkload = (m: Map<string, PolicyRef[]>): ReadonlyMap<string, readonly PolicyRef[]> =>
  new Map([...m].sort(([a], [b]) => compareText(a, b)).map(([w, refs]) => [w, uniqueRefs(refs)] as const));

/** One edge per (from, to, label), sorted by them. It depends on the request only if every rule behind it does. */
function mergeIstioEdges(edges: readonly IstioEdge[]): IstioEdge[] {
  const byKey = new Map<string, IstioEdge>();
  for (const e of edges) {
    const k = JSON.stringify([e.from, e.to, e.label]), seen = byKey.get(k);
    if (!seen) byKey.set(k, e);
    else {
      const { depends: _depends, mayRefuse: _mayRefuse, ...rest } = seen;
      const refusers = [...(seen.mayRefuse ?? []), ...(e.mayRefuse ?? [])];
      byKey.set(k, { ...rest, via: [...seen.via, ...e.via], ...(refusers.length ? { mayRefuse: refusers } : {}), ...(seen.depends && e.depends ? { depends: DEPENDS } : {}) });
    }
  }
  return [...byKey.values()]
    .sort((a, b) => compareText(a.from, b.from) || compareText(a.to, b.to) || compareText(a.label, b.label))
    .map((e) => ({ ...e, via: uniqueRefs(e.via), ...(e.mayRefuse ? { mayRefuse: uniqueRefs(e.mayRefuse) } : {}) }));
}

/**
 * Why Istio lets a call in where no ALLOW policy selects the callee, as every view says it: "If there are no ALLOW
 * policies for the workload, allow the request" once no CUSTOM or DENY policy refuses it (istio/api
 * security/v1beta1/authorization_policy.proto:28-33 at 97748e4). Those policies allow nothing, so they are named
 * only as not refusing the call. `callee` is how the text names the workload called.
 */
export function noAllowPolicyText(callee: string, refusers: readonly PolicyRef[]): string {
  return `no ALLOW policy selects ${callee}, so Istio lets in every request that ${joinNames(refusers.map((r) => r.name))} ${refusers.length === 1 ? 'does' : 'do'} not refuse`;
}
