import { compareText, OUTSIDE, uniqueRefs } from './classes';
import { callerOf, destinationOf, workloadIndex, type Caller, type Destination, type WorkloadIndex } from './destinations';
import {
  bytesWords,
  cannotReadDepends,
  capitalised,
  connectionWords,
  forbidden,
  formatBytes,
  formatConnections,
  formatRequests,
  formatShare,
  joinNames,
  requestWords,
  shareWords,
} from './format';
import { byOrder, clusterGraph, type GraphEdge, type WorkloadNode } from './graph';
import { noAllowPolicyText } from './istio';
import { isIngressGateway, isWaypoint } from './istio-proxies';
import { isKubeDns } from './mesh-egress';
import { netpolEvaluator, type NetpolEvaluator } from './netpol';
import { hasProtocol, isEmpty } from './ports';
import type { PromSample } from './prometheus-answer';
import { readableNames } from './readable-names';
import { countOnce, labelOf, reporterOf } from './samples';
import type { TrafficFigures, TrafficSnapshot } from './traffic-status';
import type { ClusterResources, PolicyRef } from './types';

/** How an edge compares with the policies (design 5.8, "Compare with policies"). */
export type TrafficMark = 'allowed' | 'uncovered' | 'quiet' | 'unused' | 'not-measured' | 'refused-istio' | 'refused-network' | 'answered-denied' | 'outbound' | 'not-evaluated';

/** An edge's figures, each per second over the last 5 minutes; `errors` counts the 5xx answers. */
export interface EdgeFigures {
  readonly requests: number;
  readonly errors: number;
  readonly requestBytes: number;
  readonly responseBytes: number;
  readonly connections: number;
}

/** A pair with traffic (`figures` set, `label` empty), or an allowed pair with none (`figures` null). */
export interface TrafficEdge {
  readonly from: string;
  readonly to: string;
  readonly figures: EdgeFigures | null;
  readonly mark: TrafficMark;
  readonly notes: readonly string[];
  readonly label: string;
  /** The policies that let in the call an idle edge stands for, its NetworkPolicies and Istio's ALLOW policies; empty on an edge with figures. */
  readonly via: readonly PolicyRef[];
  /** Set where Istio lets the call in because no ALLOW policy selects the callee. */
  readonly noAllowPolicy?: NoAllowPolicy;
}

/** Why Istio lets in a call no ALLOW policy decides: the CUSTOM and DENY policies named as not refusing it, and whether a NetworkPolicy lets it in too. */
export interface NoAllowPolicy {
  readonly refusers: readonly PolicyRef[];
  readonly networkPolicy: boolean;
}

/** A node the traffic view draws that is not one of the graph's workloads. */
export interface ExtraNode {
  readonly id: string;
  readonly label: string;
  readonly sub: string;
}

/** One edge under What stands out, keyed by the id of its edge: the two ends' ids as a JSON pair, as the model keys its pairs. */
export interface StandsOutItem {
  readonly id: string;
  readonly text: string;
  readonly reason: string;
}

/** How a group of What stands out is coloured: traffic no policy covers in the open colour, refusals and denied answers in the warning one. */
export type StandsOutTone = 'normal' | 'open' | 'warn';

/** One group of What stands out: its title, its tone, and its items. */
export interface StandsOutGroup {
  readonly title: string;
  readonly tone: StandsOutTone;
  readonly items: readonly StandsOutItem[];
}

export interface TrafficModel {
  readonly edges: readonly TrafficEdge[];
  readonly extraNodes: readonly ExtraNode[];
  /** The groups that have items, in the order the groups are listed. */
  readonly standsOut: readonly StandsOutGroup[];
  readonly notes: readonly string[];
}

/** The one node for every caller with no proxy, which Istio cannot name. */
export const OUTSIDE_MESH = 'outside-mesh';

const NOTES = {
  ingress: 'what the gateway forwarded: Istio records nothing for the hop into a gateway',
  egressGateway: 'through the egress gateway: Istio splits this link in two',
  waypoint: "through a waypoint: figures per destination need the waypoint's metrics, not read in 0.2.0",
  tcpOnly: 'TCP only: no waypoint',
  outsideMesh: 'the callers are outside the mesh, so netatlas cannot tell which workloads they are',
  otherCluster: "the callers are in another cluster of the mesh, so netatlas does not compare the call with this cluster's policies",
  udpOnly: 'UDP only: Istio does not measure UDP',
  unseen: 'not running now',
  behindWaypoint: 'depends: traffic through waypoints is not attributed yet',
} as const;

/** The node of every caller Istio cannot name; the Outbound view names such a caller by its label too. */
export const OUTSIDE_MESH_NODE: ExtraNode = { id: OUTSIDE_MESH, label: 'Callers outside the mesh', sub: 'no proxy, so no workload name' };

/** Envoy's flags for a request no upstream answered: connection failure, no healthy upstream, retries used up. */
const NO_UPSTREAM: ReadonlySet<string> = new Set(['UF', 'UH', 'URX']);
/**
 * The flags of a connection cut below the application: Envoy's connection failure, and ztunnel's (ztunnel
 * src/proxy/metrics.rs:97-104, mapped from its errors at :827-858): a failed connection, a network policy, and a
 * TLS, HTTP/2, identity or revoked-certificate failure. Most mean the connection never reached the callee, but not
 * all: `H2_HANDSHAKE_FAILURE` is any HTTP/2 error, not only a failed handshake (:834-836); `CERT_REVOKED` is
 * also set when a certificate is revoked while the tunnel is up, which resets the streams that were carrying data
 * (metrics.rs:90, :854-855; h2/client.rs:237-247; h2/server.rs:196-205); and `CONNECT` is also ztunnel's flag for
 * every error it does not name, which includes a copy that fails after data flowed, since the flag comes from the
 * connection's final result (metrics.rs:749-756, :858, :862-863; outbound.rs:362-363; copy.rs:195, :217). The
 * caller's ztunnel also records an AuthorizationPolicy refusal as `CONNECT`, since all it gets is HTTP 401 on its
 * CONNECT (ztunnel h2/client.rs:143-144, metrics.rs:857-858), so DENY is checked first.
 */
const CONNECTION_FAILED: ReadonlySet<string> = new Set(['UF', 'CONNECT', 'NETWORK_POLICY', 'TLS_FAILURE', 'H2_HANDSHAKE_FAILURE', 'IDENTITY_ERROR', 'CERT_REVOKED']);
/** ztunnel's flag for a connection an AuthorizationPolicy refused, which only the callee's ztunnel records (inbound.rs:270-277, 331-332). */
const DENIED: ReadonlySet<string> = new Set(['DENY']);

/** Envoy joins several flags with `,`; none is `-`. */
const hasFlag = (s: PromSample, flags: ReadonlySet<string>) => labelOf(s, 'response_flags').split(',').some((f) => flags.has(f));

/** The share of requests that fail from which an edge is listed under Errors. */
const ERROR_SHARE = 0.01;

const pairKey = (from: string, to: string) => JSON.stringify([from, to]);

/** A traffic edge's end: a node id, and the extra node that draws it when it is not a workload of the graph. */
interface End {
  readonly id: string;
  readonly extra?: ExtraNode;
}

function unseenEnd(namespace: string, name: string): End {
  const id = `unseen:${namespace}/${name}`;
  return { id, extra: { id, label: name, sub: `${namespace} · not running now` } };
}

function callerEnd(c: Caller): End {
  switch (c.kind) {
    case 'workload':
      return { id: c.id };
    case 'unseen':
      return unseenEnd(c.namespace, c.name);
    case 'outside-mesh':
      return { id: OUTSIDE_MESH, extra: OUTSIDE_MESH_NODE };
    // As a call into another cluster of the mesh is drawn to the Internet node, a call from one is drawn from it.
    case 'mesh-cluster':
      return { id: OUTSIDE };
  }
}

/** In-cluster destinations are nodes of their own; every other kind is the Internet node, which the Outbound view breaks down. */
function destinationEnd(d: Destination): End {
  switch (d.kind) {
    case 'workload':
    case 'egress-gateway':
      return { id: d.id };
    case 'unseen':
      return unseenEnd(d.namespace, d.name);
    case 'service': {
      const id = `service:${d.host}`;
      return { id, extra: { id, label: d.host.split('.', 1)[0] ?? d.host, sub: 'no workload answered' } };
    }
    default:
      return { id: OUTSIDE };
  }
}

/**
 * One pair's figures as they add up, with the parts the refusal rules compare with them: the requests
 * answered 403 (`forbidden`), the 503s no upstream answered (`noUpstream`), the counted closed connections
 * that never reached the callee (`failed`), and the closed connections the callee reported
 * (`calleeClosed`), counted or not, with those of them it denied (`denied`).
 */
type Sums = Record<keyof EdgeFigures | 'forbidden' | 'noUpstream' | 'failed' | 'calleeClosed' | 'denied', number>;

interface Tally {
  readonly caller: Caller;
  readonly destination: Destination;
  readonly from: End;
  readonly to: End;
  readonly sums: Sums;
}

/**
 * Each call counted once, summed per (caller, destination). A part is summed in the same order as its
 * whole, so when every non-zero sample is in the part, the two sums are equal to the last bit.
 */
function tallies(f: TrafficFigures, w: WorkloadIndex, clusterDomain: string): Tally[] {
  const byPair = new Map<string, Tally>();
  const ends = (s: PromSample) => {
    const caller = callerOf(s, w), destination = destinationOf(s, w, clusterDomain);
    const from = callerEnd(caller), to = destinationEnd(destination);
    return { caller, destination, from, to, key: pairKey(from.id, to.id) };
  };
  const of = (s: PromSample): Sums => {
    const { key, ...pair } = ends(s);
    const seen = byPair.get(key);
    if (seen) return seen.sums;
    const sums: Sums = { requests: 0, errors: 0, requestBytes: 0, responseBytes: 0, connections: 0, forbidden: 0, noUpstream: 0, failed: 0, calleeClosed: 0, denied: 0 };
    byPair.set(key, { ...pair, sums });
    return sums;
  };
  for (const s of countOnce(f.requests, w)) {
    const t = of(s), code = labelOf(s, 'response_code');
    t.requests += s.value;
    if (code.startsWith('5')) t.errors += s.value;
    if (code === '403') t.forbidden += s.value;
    if (code === '503' && hasFlag(s, NO_UPSTREAM)) t.noUpstream += s.value;
  }
  for (const s of countOnce(f.requestBytes, w)) of(s).requestBytes += s.value;
  for (const s of countOnce(f.responseBytes, w)) of(s).responseBytes += s.value;
  for (const s of countOnce(f.closed, w)) {
    const t = of(s);
    t.connections += s.value;
    if (hasFlag(s, CONNECTION_FAILED)) t.failed += s.value;
  }
  // The callee's own reports, which counting each call once drops when the caller has a proxy: only they
  // carry ztunnel's DENY. They add to a pair the counted reports found; they make no edge of their own.
  for (const s of f.closed) {
    const t = reporterOf(s) === 'destination' ? byPair.get(ends(s).key)?.sums : undefined;
    if (!t) continue;
    t.calleeClosed += s.value;
    if (hasFlag(s, DENIED)) t.denied += s.value;
  }
  return [...byPair.values()];
}

const figuresOf = ({ requests, errors, requestBytes, responseBytes, connections }: Sums): EdgeFigures => ({ requests, errors, requestBytes, responseBytes, connections });

const ZERO: EdgeFigures = { requests: 0, errors: 0, requestBytes: 0, responseBytes: 0, connections: 0 };

const plus = (a: EdgeFigures, b: EdgeFigures): EdgeFigures => ({
  requests: a.requests + b.requests,
  errors: a.errors + b.errors,
  requestBytes: a.requestBytes + b.requestBytes,
  responseBytes: a.responseBytes + b.responseBytes,
  connections: a.connections + b.connections,
});

/** What the marks read about the cluster, worked out once per model. */
interface Context {
  readonly w: WorkloadIndex;
  readonly e: NetpolEvaluator;
  readonly nodes: ReadonlyMap<string, WorkloadNode>;
  /** The (caller, callee) pairs Istio refuses, as its evaluator decides. */
  readonly istioDenied: ReadonlySet<string>;
  /** The graph's Istio edges, by pair. */
  readonly istioEdges: ReadonlyMap<string, readonly GraphEdge[]>;
  /** The workloads no ALLOW policy selects, with the CUSTOM and DENY policies that do. */
  readonly withoutAllow: ReadonlyMap<string, readonly PolicyRef[]>;
  /** Each workload's name as the model writes it, by id. */
  readonly names: ReadonlyMap<string, string>;
  /**
   * Why no pair can be said to be allowed or denied, when a policy kind could not be read: the reader
   * gives such a kind as an empty list, and a policy netatlas may not read could allow or deny any pair.
   */
  readonly unread: string | undefined;
}

const nameOf = (c: Context, id: string) => c.names.get(id) ?? id;

const isWaypointWorkload = (c: Context, id: string) => c.w.pods(id).some(isWaypoint);

/** Each pair of a class of workload a and a class of workload b. */
const classPairs = (a: string, b: string, e: NetpolEvaluator) =>
  e.classes.filter((x) => x.workloadId === a).flatMap((ca) => e.classes.filter((y) => y.workloadId === b).map((cb) => [ca, cb] as const));

/** Whether the policies cover the call from workload a to workload b, and whether they deny it. Ports are not compared: Istio's metrics carry no destination port. */
function verdict(a: string, b: string, { e, nodes, istioDenied }: Context) {
  const pairs = classPairs(a, b, e);
  const netpolCovers = pairs.some(([ca, cb]) => e.egress(ca, cb).restrictedBy.length > 0 || e.ingress(cb, ca).restrictedBy.length > 0);
  const netpolDenies = netpolCovers && pairs.every(([ca, cb]) => isEmpty(e.between(ca, cb)));
  const istioCovers = (nodes.get(b)?.istioEnforced.length ?? 0) > 0;
  const istioDenies = istioDenied.has(pairKey(a, b));
  return { covered: netpolCovers || istioCovers, denied: netpolDenies || istioDenies, istioDenies, netpolCovers };
}

/**
 * Why Istio lets the call from a to b in where no ALLOW policy selects b, given whether a NetworkPolicy lets it in;
 * undefined where an ALLOW policy lets it in, or where nothing needs saying. It names the CUSTOM and DENY policies
 * the pair's Istio edges say may refuse some of its requests. A pair with no Istio edge, which none of them refuses,
 * is said to be let in this way only where no NetworkPolicy lets it in either, since nothing else then says why it
 * gets in; it names the callee's CUSTOM and DENY policies.
 */
function noAllowPolicy(a: string, b: string, networkPolicy: boolean, c: Context): NoAllowPolicy | undefined {
  const istio = c.istioEdges.get(pairKey(a, b));
  let refusers: readonly PolicyRef[] | undefined;
  if (istio) refusers = istio.some((x) => x.via.length) ? undefined : uniqueRefs(istio.flatMap((x) => x.mayRefuse ?? []));
  else if (!networkPolicy) refusers = c.withoutAllow.get(b);
  return refusers ? { refusers, networkPolicy } : undefined;
}

/**
 * What lets an edge's call in, as the Traffic view says it: allowed by `policies`, where a policy allows it, and,
 * where no ALLOW policy selects the callee, why Istio lets it in. "Allowed, not used" names the policies, and the
 * map's spoken label says `a policy`.
 */
export function allowedText(policies: string, e: TrafficEdge, callee: string): string {
  const n = e.noAllowPolicy;
  if (!n) return `allowed by ${policies}`;
  const istio = noAllowPolicyText(callee, n.refusers);
  return n.networkPolicy ? `allowed by ${policies}, and ${istio}` : istio;
}

/** Which rule found Istio's refusal: every answer a 403, ztunnel's DENY, or every connection closed with nothing sent back. */
type Refusal = 'forbidden' | 'deny' | 'closed';

/** An edge's mark, with the rule that found a refusal, whether an unread policy kind left the pair not compared, and why Istio lets an allowed call in where no ALLOW policy selects the callee. */
interface Judged {
  readonly mark: TrafficMark;
  readonly refusal?: Refusal;
  readonly unread?: boolean;
  readonly noAllowPolicy?: NoAllowPolicy;
}

/** The first mark that holds (design 5.8). */
function judge({ caller, destination, to, sums: t }: Tally, c: Context): Judged {
  if (to.id === OUTSIDE) return { mark: 'outbound' };
  if (caller.kind !== 'workload' || (destination.kind !== 'workload' && destination.kind !== 'egress-gateway') || isWaypointWorkload(c, destination.id)) return { mark: 'not-evaluated' };
  const v = verdict(caller.id, destination.id, c);
  // The callee's ztunnel says Istio refused outright with DENY, while the caller's records the same
  // refusal as CONNECT, and a sidecar caller's requests then end 503 UF.
  if (t.calleeClosed > 0 && t.denied === t.calleeClosed) return { mark: 'refused-istio', refusal: 'deny' };
  // Envoy has no flag for an RBAC denial and an application may answer 403 itself, so a 403 counts
  // as Istio's refusal only when the policies deny the call too.
  if (t.requests > 0 && t.forbidden === t.requests && v.istioDenies) return { mark: 'refused-istio', refusal: 'forbidden' };
  if (t.requests > 0 ? t.noUpstream === t.requests : t.connections > 0 && t.failed === t.connections) return { mark: 'refused-network' };
  // Measured on a kind cluster with Istio 1.32 over 128 plain TCP connections between two sidecars that a
  // DENY AuthorizationPolicy refused: the caller's sidecar wrote flag `-` with each connection's request
  // bytes and no response byte, the callee's `-` with no byte either way, and no DENY, UF or UR anywhere;
  // Envoy's network RBAC filter closes a denied connection and sets no response flag (rbac_filter.cc:133-157
  // at 56e0748). The measured call went to a pod address in plain text, so Istio named neither end; a pair
  // Istio names, as a Service with a TCP port gives, goes over mutual TLS, which was not measured.
  if (t.requests === 0 && t.connections > 0 && t.responseBytes === 0 && v.istioDenies) return { mark: 'refused-istio', refusal: 'closed' };
  // The refusals stay: they are read from the figures. Allowed, uncovered or denied need every policy.
  if (c.unread) return { mark: 'not-evaluated', unread: true };
  if (v.denied) return { mark: 'answered-denied' };
  if (!v.covered) return { mark: 'uncovered' };
  const n = noAllowPolicy(caller.id, destination.id, v.netpolCovers, c);
  return { mark: 'allowed', ...(n ? { noAllowPolicy: n } : {}) };
}

function trafficNotes({ caller, destination, sums }: Tally, judged: Judged, c: Context): string[] {
  const callee = destination.kind === 'workload' || destination.kind === 'egress-gateway' ? destination.id : undefined;
  const waypoint = callee !== undefined && isWaypointWorkload(c, callee);
  return [
    ...(destination.kind === 'egress-gateway' ? [NOTES.egressGateway] : []),
    ...(waypoint ? [NOTES.waypoint] : []),
    // ztunnel sees connections only; without a waypoint nothing reads the requests in them.
    ...(callee !== undefined && !waypoint && sums.requests === 0 && c.w.mesh(callee) === 'ambient' ? [NOTES.tcpOnly] : []),
    ...(caller.kind === 'outside-mesh' ? [NOTES.outsideMesh] : []),
    ...(caller.kind === 'mesh-cluster' ? [NOTES.otherCluster] : []),
    ...(destination.kind === 'unseen' ? [NOTES.unseen] : []),
    ...(judged.unread && c.unread ? [c.unread] : []),
  ];
}

/** An edge, whether an idle edge's label is an Istio edge's (`GET /cart`) rather than a NetworkPolicy edge's (`TCP 5432`), and how its mark was found. */
interface Drafted extends Omit<Judged, 'mark' | 'noAllowPolicy'> {
  readonly edge: TrafficEdge;
  readonly istioLabel?: boolean;
}

function trafficDraft(t: Tally, c: Context): Drafted {
  const { mark, noAllowPolicy: n, ...judged } = judge(t, c);
  const edge: TrafficEdge = { from: t.from.id, to: t.to.id, figures: figuresOf(t.sums), mark, notes: trafficNotes(t, { mark, ...judged }, c), label: '', via: [], ...(n ? { noAllowPolicy: n } : {}) };
  return { ...judged, edge };
}

const isZero = (f: EdgeFigures) => f.requests === 0 && f.requestBytes === 0 && f.responseBytes === 0 && f.connections === 0;

/**
 * Istio records nothing for the hop into a gateway, so each gateway that forwarded something gets an
 * edge from outside the cluster carrying what it forwarded: the sum of its own outgoing figures. Only a
 * gateway with a proxy reports what it forwards; one without has no figures to sum, and its calls show as
 * callers outside the mesh.
 */
function ingressEdges(traffic: readonly TrafficEdge[], c: Context): Drafted[] {
  return [...c.nodes.keys()]
    .filter((id) => c.w.mesh(id) !== 'none' && c.w.pods(id).some(isIngressGateway))
    .flatMap((id): Drafted[] => {
      const figures = traffic.flatMap((e) => (e.from === id && e.figures ? [e.figures] : [])).reduce(plus, ZERO);
      return isZero(figures) ? [] : [{ edge: { from: OUTSIDE, to: id, figures, mark: 'not-evaluated', notes: [NOTES.ingress], label: '', via: [] } }];
    });
}

/**
 * Each pair of workloads the graph allows and no traffic edge joins. A call is attributed only to a
 * caller with a proxy, so only such a caller's pairs are judged idle. A pair is allowed only where neither
 * layer refuses it, as `judge` reads a call seen on it, so an idle edge and a seen call never disagree.
 */
function idleEdges(graphEdges: readonly GraphEdge[], busy: ReadonlySet<string>, recent: ReadonlySet<string> | undefined, waypoints: boolean, c: Context): Drafted[] {
  // Each idle edge says what the policies allow, and a policy of a kind netatlas may not read could refuse any pair.
  if (c.unread) return [];
  const { w, e } = c;
  const byPair = new Map<string, GraphEdge[]>();
  for (const x of graphEdges) {
    if (x.from === OUTSIDE || x.to === OUTSIDE) continue;
    const key = pairKey(x.from, x.to);
    byPair.set(key, [...(byPair.get(key) ?? []), x]);
  }
  return [...byPair].flatMap(([key, list]): Drafted[] => {
    const [first] = list;
    // Names resolve over UDP, which Istio does not measure, so a call to kube-dns over UDP never shows and
    // no pair to it is judged idle.
    if (!first || busy.has(key) || w.mesh(first.from) === 'none' || w.pods(first.to).some((p) => isKubeDns(p.labels))) return [];
    if (verdict(first.from, first.to, c).denied) return [];
    const netpol = list.find((x) => x.kind === 'networkpolicy');
    // A call through a waypoint names the waypoint as its destination, so an ambient callee's pairs say nothing.
    const behindWaypoint = waypoints && w.mesh(first.to) === 'ambient';
    // Istio's proxies carry no UDP (pkg/config/protocol/instance.go:48-50), so a pair the NetworkPolicies allow
    // on UDP alone has calls no figure counts, whatever Istio edge it has: the network lets nothing else through.
    // A side no NetworkPolicy restricts is open on every port, so a pair only Istio covers stays measured.
    const pairs = classPairs(first.from, first.to, e);
    const udpOnly =
      pairs.length > 0 &&
      pairs.every(([ca, cb]) => {
        const ports = e.between(ca, cb);
        return !hasProtocol(ports, 'TCP') && !hasProtocol(ports, 'SCTP');
      });
    const unmeasured = behindWaypoint ? NOTES.behindWaypoint : udpOnly ? NOTES.udpOnly : undefined;
    // Where nothing was measured the edge claims neither calls nor their absence.
    const mark = unmeasured ? 'not-measured' : !recent || recent.has(key) ? 'quiet' : 'unused';
    const n = noAllowPolicy(first.from, first.to, !!netpol, c);
    const edge: TrafficEdge = {
      from: first.from,
      to: first.to,
      figures: null,
      mark,
      notes: unmeasured ? [unmeasured] : [],
      label: (netpol ?? first).label,
      via: uniqueRefs(list.flatMap((x) => x.via)),
      ...(n ? { noAllowPolicy: n } : {}),
    };
    return [{ edge, istioLabel: !netpol }];
  });
}

/**
 * How much older than the figures the 24-hour pairs may be. The source asks for them every 10 minutes,
 * and again 2 minutes after each failure (src/server/sources/prometheus.ts), so pairs older than three
 * rounds mean the query keeps failing while the figures go on.
 */
const RECENT_PAIRS_LAST_MS = 30 * 60_000;

/** The pairs of the 24-hour query, keyed as the traffic edges are; undefined until it has answered once, and while its last answer is too old to say what was not called. */
function recentPairs(t: TrafficSnapshot, w: WorkloadIndex): ReadonlySet<string> | undefined {
  if (!t.recent || (t.figures && t.figures.at.getTime() - t.recent.at.getTime() > RECENT_PAIRS_LAST_MS)) return undefined;
  return new Set(t.recent.pairs.map((p) => pairKey(callerEnd(callerOf(p, w)).id, destinationEnd(destinationOf(p, w, t.clusterDomain)).id)));
}

/** How one way of writing figures writes each of its parts. */
interface FigureTexts {
  readonly requests: (perSecond: number) => string;
  readonly share: (share: number) => string;
  readonly bytes: (perSecond: number) => string;
  readonly connections: (perSecond: number) => string;
}

/**
 * The requests, then the share that failed, then the bytes both ways, each when it is above 0; the
 * closed connections when they are the only figure, as on a connection refused before it carried a byte.
 */
function figureParts(f: EdgeFigures, t: FigureTexts): string[] {
  const bytes = f.requestBytes + f.responseBytes;
  const parts = [...(f.requests > 0 ? [t.requests(f.requests)] : []), ...(f.errors > 0 ? [t.share(f.errors / f.requests)] : []), ...(bytes > 0 ? [t.bytes(bytes)] : [])];
  return parts.length || f.connections === 0 ? parts : [t.connections(f.connections)];
}

/** The figures in words, as sentences and screen readers say them: `6 requests a second, 2.1 percent errors`. */
export const figureWords = (f: EdgeFigures): string => figureParts(f, { requests: requestWords, share: shareWords, bytes: bytesWords, connections: connectionWords }).join(', ');

/** The figures as an edge's label shows them: `6 req/s · 2.1% errors`. */
export const figureLabel = (f: EdgeFigures): string =>
  figureParts(f, { requests: formatRequests, share: (s) => `${formatShare(s)} errors`, bytes: formatBytes, connections: formatConnections }).join(' · ');

/** One group of What stands out: its title and tone, and the text and reason it gives an edge it lists. */
interface Group {
  readonly title: string;
  readonly tone: StandsOutTone;
  readonly item: (d: Drafted, name: (id: string) => string) => Omit<StandsOutItem, 'id'> | undefined;
}

/** What stands out, one rule per group, in the order the groups are listed. */
const GROUPS: readonly Group[] = [
  {
    title: 'Traffic no policy covers',
    tone: 'open',
    item: ({ edge: e }, name) =>
      e.mark === 'uncovered' && e.figures
        ? { text: `${name(e.from)} calls ${name(e.to)}, ${figureWords(e.figures)}.`, reason: `No policy restricts calls out of ${name(e.from)} or into ${name(e.to)}.` }
        : undefined,
  },
  {
    title: 'Allowed, not used',
    tone: 'normal',
    item: ({ edge: e, istioLabel }, name) =>
      e.mark === 'unused'
        ? {
            text: istioLabel ? `${name(e.from)} may call ${name(e.to)}: ${e.label}.` : `${name(e.from)} may call ${name(e.to)} on ${e.label}.`,
            reason: `${capitalised(allowedText(joinNames(e.via.map((v) => v.name)), e, name(e.to)))}. No calls recorded in the last 24 hours.`,
          }
        : undefined,
  },
  {
    title: 'Errors',
    tone: 'normal',
    // The failures are measured, so a pair an unread policy kind left not compared is listed too.
    item: ({ edge: e, unread }, name) =>
      (e.mark === 'allowed' || e.mark === 'uncovered' || e.mark === 'answered-denied' || unread) && e.figures && e.figures.requests > 0 && e.figures.errors / e.figures.requests >= ERROR_SHARE
        ? {
            text: `${name(e.from)} calls ${name(e.to)}: ${formatShare(e.figures.errors / e.figures.requests)} of requests fail.`,
            reason: `${capitalised(requestWords(e.figures.requests))} over the last 5 minutes.`,
          }
        : undefined,
  },
  {
    title: 'Refused calls',
    tone: 'warn',
    item: ({ edge: e, refusal }, name) => {
      const call = `${name(e.from)} calls ${name(e.to)}`;
      if (e.mark === 'refused-istio') {
        const denies = `the Istio policies on ${name(e.to)} do not allow ${name(e.from)}.`;
        const reasons: Readonly<Record<Refusal, string>> = {
          forbidden: `Every answer was a 403, and ${denies}`,
          deny: 'ztunnel closed every connection with DENY.',
          closed: `Every connection closed with nothing sent back, and ${denies}`,
        };
        return { text: `${call}: refused by Istio.`, reason: reasons[refusal ?? 'deny'] };
      }
      if (e.mark === 'refused-network') return { text: `${call}: refused by the network.`, reason: 'No call got an answer: the connection failed, or no upstream was healthy.' };
      return undefined;
    },
  },
  {
    title: 'Answered though the policies deny it',
    tone: 'warn',
    item: ({ edge: e }, name) =>
      e.mark === 'answered-denied' && e.figures
        ? {
            text: `${name(e.from)} calls ${name(e.to)}, ${figureWords(e.figures)}.`,
            reason: 'The policies deny this call, yet it was answered: an enforcer may be missing, or a policy is newer than the figures.',
          }
        : undefined,
  },
];

/** Each group with the edges it lists, keyed by their pair; a group that lists none is left out. */
function standsOut(drafts: readonly Drafted[], name: (id: string) => string): StandsOutGroup[] {
  return GROUPS.flatMap(({ title, tone, item }) => {
    const items = drafts.flatMap((d) => {
      const listed = item(d, name);
      return listed ? [{ id: pairKey(d.edge.from, d.edge.to), ...listed }] : [];
    });
    return items.length ? [{ title, tone, items }] : [];
  });
}

/** The workloads outside the mesh that figures reach, then the note on callers outside the mesh when that node is drawn. */
function modelNotes(edges: readonly TrafficEdge[], c: Context): string[] {
  const unmeshed = [...new Set(edges.flatMap((e) => (e.figures ? [e.to] : [])))].filter((id) => c.nodes.has(id) && c.w.mesh(id) === 'none').sort(compareText);
  return [
    ...unmeshed.map((id) => `${nameOf(c, id)} is not in the mesh, so its traffic is measured from the callers' side only.`),
    ...(edges.some((e) => e.from === OUTSIDE_MESH) ? ['Callers outside the mesh are drawn as one node: they have no proxy, so Istio cannot name them.'] : []),
  ];
}

/** The cluster's traffic marked against its policies; undefined until the source gave its first figures. */
export function trafficModel(r: ClusterResources, t: TrafficSnapshot): TrafficModel | undefined {
  if (!t.figures) return undefined;
  const w = workloadIndex(r), g = clusterGraph(r), workloads = g.namespaces.flatMap((n) => n.workloads);
  const unread = (['networkpolicies', 'authorizationpolicies'] as const).filter((k) => forbidden(r, k));
  const c: Context = {
    w,
    e: netpolEvaluator(r),
    nodes: new Map(workloads.map((n) => [n.id, n])),
    istioDenied: new Set(g.istioDenied.map((p) => pairKey(p.from, p.to))),
    istioEdges: Map.groupBy(g.edges.filter((e) => e.kind === 'istio'), (e) => pairKey(e.from, e.to)),
    withoutAllow: g.istioWithoutAllow,
    names: readableNames(workloads),
    unread: unread.length ? cannotReadDepends(unread) : undefined,
  };
  const counted = tallies(t.figures, w, t.clusterDomain);
  const measured = counted.map((x) => trafficDraft(x, c));
  const traffic = measured.map((d) => d.edge);
  const waypoints = r.pods.some(isWaypoint);
  const drafts = [
    ...measured,
    ...ingressEdges(traffic, c),
    ...idleEdges(g.edges, new Set(traffic.map((e) => pairKey(e.from, e.to))), recentPairs(t, w), waypoints, c),
  ].sort(byOrder((d) => d.edge.from, (d) => d.edge.to));
  const edges = drafts.map((d) => d.edge);
  const extras = new Map(counted.flatMap((x) => [x.from.extra, x.to.extra]).flatMap((n) => (n ? [[n.id, n] as const] : [])));
  return {
    edges,
    extraNodes: [...extras.values()].sort(byOrder((n) => n.id)),
    standsOut: standsOut(drafts, (id) => nameOf(c, id)),
    notes: modelNotes(edges, c),
  };
}
