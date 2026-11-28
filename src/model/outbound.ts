// The Outbound view's rows: each destination outside the cluster, the workloads that may call it by
// NetworkPolicy and by Istio, and the workloads that do call it by their own proxies' reports; and the
// short list the map's Internet node shows.
import { unreadViewKinds } from './cannot-read';
import { compareText, workloadIdOf, type PodClass } from './classes';
import { callerOf, destinationOf, workloadIndex, type Caller, type Destination, type WorkloadIndex } from './destinations';
import { cannotReadDepends, forbidden, formatBytes, formatRequests, joinNames, workloadText } from './format';
import { byOrder } from './graph';
import { cidrText, netpolEvaluator, type NetpolEvaluator } from './netpol';
import {
  entriesSeenFrom,
  istioLayer,
  istioVerdict,
  netpolVerdictOnPorts,
  serviceEntryTargets,
  targetsPerPort,
  transportOf,
  type IstioLayer,
  type NetpolTarget,
  type PortTargets,
  type Verdict,
} from './outbound-mode';
import { formatPorts, NONE, union, type PortSet } from './ports';
import type { PromSample } from './prometheus-answer';
import { fromSource } from './samples';
import { OUTSIDE_MESH_NODE } from './traffic';
import type { TrafficFigures, TrafficSnapshot } from './traffic-status';
import type { ClusterResources, ServiceEntryObject } from './types';

export type OutboundKind = 'named' | 'seen' | 'blocked' | 'unregistered' | 'unattributed' | 'egress-gateway' | 'mesh-cluster' | 'address-range' | 'any';

/** A workload that may call the destination, as `<namespace> / <name>`, with its verdict on each layer. */
export interface MayCall {
  readonly workload: string;
  readonly netpol: string;
  readonly istio: string;
}

/**
 * Workloads of one May call cell that share both verdict texts: the view prints the workloads, then
 * `and <more> more` when `more` is above 0, then the two lines once.
 */
export interface MayCallGroup {
  /** At most the cap's number of workloads. */
  readonly workloads: readonly string[];
  /** How many workloads of the group the cap left out, 0 when none. */
  readonly more: number;
  readonly netpol: string;
  readonly istio: string;
}

/**
 * A workload that calls the destination, each figure per second: `requests`, `bytes` (both directions
 * summed), and `rate`, its requests plus its closed connections. `text` is its requests when it has any,
 * else its bytes; the figures stay so that the short list can sum several callers.
 */
export interface DoCall {
  readonly workload: string;
  readonly text: string;
  readonly rate: number;
  readonly requests: number;
  readonly bytes: number;
}

export interface OutboundRow {
  readonly kind: OutboundKind;
  readonly destination: string;
  readonly ports: string;
  readonly mayCall: readonly MayCall[];
  readonly othersMay: number;
  readonly doCall: readonly DoCall[];
  readonly note?: string;
}

export interface ShortList {
  /** `kind` tells a host or an address range from a sentence, which the panel sets as the table does. */
  readonly top: readonly { readonly kind: OutboundKind; readonly destination: string; readonly text: string }[];
  readonly named: number;
  readonly total: number;
}

/** The kinds that get one row per caller, in the order the view lists them. */
const PER_CALLER = ['blocked', 'unregistered', 'unattributed', 'egress-gateway'] as const;

type PerCallerKind = (typeof PER_CALLER)[number];

/** The kinds a call out of the cluster lands in. */
type CalledKind = 'named' | 'seen' | PerCallerKind | 'mesh-cluster';

const isPerCaller = (kind: CalledKind): kind is PerCallerKind => (PER_CALLER as readonly CalledKind[]).includes(kind);

/** What each row says that its figures cannot: why netatlas names no host, counts nothing, or lists no calls. */
const NOTES: Readonly<Record<PerCallerKind | 'address-range' | 'any', string>> = {
  blocked: 'Istio refused these calls: the host is not registered.',
  unregistered: 'Istio keeps no host, SNI or IP for these calls, so netatlas cannot name the destination.',
  unattributed: 'ztunnel recorded no destination for these calls.',
  'egress-gateway': "Istio splits this link in two: the gateway's own calls are listed under their hosts.",
  'address-range': 'Istio records no address, so calls to this range are not counted here.',
  any: 'What these workloads call is listed in the rows above.',
};

/** The map's Internet node lists the ten destinations with the most calls (design 5.8). */
const SHORT_LIST_LENGTH = 10;

/** A destination whose address netatlas does not know, on a port it does not know: what a call is when only its kind is known. */
const UNKNOWN_ADDRESS: NetpolTarget = { addresses: null };

/** Istio layers that let a workload reach a host no rule names: no sidecar to stop it, or a mode that lets every host out. */
const OPEN_LAYERS: ReadonlySet<IstioLayer['kind']> = new Set(['any-domain', 'not-in-mesh']);

/** What the rows read about the cluster, worked out once per call. */
interface Context {
  readonly r: ClusterResources;
  readonly e: NetpolEvaluator;
  /**
   * Whether the NetworkPolicies were read. The reader gives a kind it may not list as an empty list, which
   * reads as no policy, so without them no NetworkPolicy line is a verdict and no address is said reachable.
   */
  readonly netpolRead: boolean;
  /** Each workload's classes, by workload id, in id order: the order the view lists workloads that do not call. */
  readonly classes: ReadonlyMap<string, readonly PodClass[]>;
  /** Each workload's `<namespace> / <name>`, by workload id. */
  readonly names: ReadonlyMap<string, string>;
  readonly layer: (c: PodClass) => IstioLayer;
}

function contextOf(r: ClusterResources): Context {
  // The evaluator's own classes, because it finds classes by id (netpol.ts, PolicyIndex).
  const e = netpolEvaluator(r);
  const classes = new Map<string, PodClass[]>();
  for (const c of [...e.classes].sort(byOrder((x) => x.workloadId))) classes.set(c.workloadId, [...(classes.get(c.workloadId) ?? []), c]);
  const layers = new Map(e.classes.map((c) => [c.id, istioLayer(c, r)]));
  return {
    r,
    e,
    netpolRead: !forbidden(r, 'networkpolicies'),
    classes,
    names: new Map(r.pods.map((p) => [workloadIdOf(p), workloadText(p.namespace, p.workload.name)])),
    layer: (c) => layers.get(c.id) ?? istioLayer(c, r),
  };
}

const NETPOL_UNREAD: Verdict = { outcome: 'depends', text: cannotReadDepends(['networkpolicies']) };

/** A class's NetworkPolicy verdict on a destination served on these ports. */
const netpolLine = (ctx: Context, c: PodClass, targets: PortTargets): Verdict => (ctx.netpolRead ? netpolVerdictOnPorts(c, ctx.e, targets) : NETPOL_UNREAD);

/** What one caller sent to one destination, each per second; `closed` counts its closed connections. */
interface Sent {
  requests: number;
  bytes: number;
  closed: number;
}

/** A caller as the view names it, and its workload's id when netatlas sees that workload. */
interface CallerRef {
  readonly text: string;
  readonly id: string | undefined;
}

/** The calls to one destination: the kind of row they make, and what each caller sent, by the caller's text. */
interface Called {
  readonly kind: CalledKind;
  readonly destination: string;
  readonly callers: Map<string, { readonly caller: CallerRef; readonly sent: Sent }>;
}

function callerRef(c: Caller, names: Context['names']): CallerRef {
  switch (c.kind) {
    case 'workload':
      return { text: names.get(c.id) ?? c.id, id: c.id };
    case 'unseen':
      return { text: workloadText(c.namespace, c.name), id: undefined };
    // A caller's own report names no workload only when an operator removed the label: Istio cannot name it.
    case 'outside-mesh':
      return { text: OUTSIDE_MESH_NODE.label, id: undefined };
    // Only a callee's report names a caller in another cluster, and the rows read the callers' own reports.
    case 'mesh-cluster':
      return { text: `Another cluster of the mesh (${c.cluster})`, id: undefined };
  }
}

/** A host as the rows match it: host names are compared without regard to case (RFC 4343). */
const hostKey = (host: string) => host.toLowerCase();

/** The row a call lands in; none for a call inside the cluster, which is not outbound. `external` maps each ServiceEntry host's key to the host as its entry writes it. */
function rowOf(d: Destination, external: ReadonlyMap<string, string>, names: Context['names']): Pick<Called, 'kind' | 'destination'> | undefined {
  switch (d.kind) {
    case 'workload':
    case 'unseen':
    case 'service':
      return undefined;
    // A ServiceEntry host, a wildcard one included, is reported as the entry writes it, whatever the case of the call's Host header.
    case 'external': {
      const named = external.get(hostKey(d.host));
      return named === undefined ? { kind: 'seen', destination: d.host } : { kind: 'named', destination: named };
    }
    case 'blackhole':
      return { kind: 'blocked', destination: d.host === undefined ? 'Blocked by REGISTRY_ONLY' : `Blocked by REGISTRY_ONLY: ${d.host}` };
    case 'unregistered':
      return { kind: 'unregistered', destination: 'Unregistered TLS or TCP traffic' };
    case 'unattributed':
      return { kind: 'unattributed', destination: 'Unattributed traffic' };
    case 'egress-gateway':
      return { kind: 'egress-gateway', destination: `Through the egress gateway ${names.get(d.id) ?? d.id}` };
    case 'mesh-cluster':
      return { kind: 'mesh-cluster', destination: `Another cluster of the mesh (${d.cluster})` };
  }
}

/** The callers' own reports, summed per (row, caller). Only the caller's proxy saw where a call left the cluster. */
function calledOf(f: TrafficFigures, ctx: Context, w: WorkloadIndex, clusterDomain: string, external: ReadonlyMap<string, string>): Called[] {
  const byKey = new Map<string, Called>();
  const sentBy = (s: PromSample): Sent | undefined => {
    const row = rowOf(destinationOf(s, w, clusterDomain), external, ctx.names);
    if (!row) return undefined;
    const caller = callerRef(callerOf(s, w), ctx.names);
    const key = JSON.stringify([row.kind, row.destination, isPerCaller(row.kind) ? caller.text : '']);
    const called = byKey.get(key) ?? { ...row, callers: new Map() };
    byKey.set(key, called);
    const known = called.callers.get(caller.text);
    if (known) return known.sent;
    const sent: Sent = { requests: 0, bytes: 0, closed: 0 };
    called.callers.set(caller.text, { caller, sent });
    return sent;
  };
  const add = (samples: readonly PromSample[], part: keyof Sent) => {
    for (const s of fromSource(samples)) {
      const sent = sentBy(s);
      if (sent) sent[part] += s.value;
    }
  };
  add(f.requests, 'requests');
  add(f.requestBytes, 'bytes');
  add(f.responseBytes, 'bytes');
  add(f.closed, 'closed');
  return [...byKey.values()];
}

/** Requests when there are any, else bytes: TCP and TLS carry no requests, only bytes. */
const figureText = (requests: number, bytes: number) => (requests > 0 ? formatRequests(requests) : formatBytes(bytes));

const sumOf = (calls: readonly DoCall[], figure: 'rate' | 'requests' | 'bytes') => calls.reduce((n, c) => n + c[figure], 0);

/** Rows by their callers' summed rate, highest first. */
const byRate = (a: OutboundRow, b: OutboundRow) => sumOf(b.doCall, 'rate') - sumOf(a.doCall, 'rate');

/**
 * Rows by their callers' summed bytes, most first: among rows of equal rate, the short list's tie-break,
 * because a long-lived TCP or TLS connection has no requests and closes no connection, so only its bytes count.
 */
const byBytes = (a: OutboundRow, b: OutboundRow) => sumOf(b.doCall, 'bytes') - sumOf(a.doCall, 'bytes');

/** Whether any caller of the row has a figure: a request, a closed connection (both in `rate`) or a byte. */
const hasFigures = (x: OutboundRow) => sumOf(x.doCall, 'rate') > 0 || sumOf(x.doCall, 'bytes') > 0;

interface Calling {
  readonly id: string | undefined;
  readonly call: DoCall;
}

/** A row's callers by rate, highest first, then by name, which is also the order they lead its may call list in. */
function callingOf(called: Called | undefined): Calling[] {
  return [...(called?.callers.values() ?? [])]
    .map(({ caller, sent }) => ({
      id: caller.id,
      call: { workload: caller.text, text: figureText(sent.requests, sent.bytes), rate: sent.requests + sent.closed, requests: sent.requests, bytes: sent.bytes },
    }))
    .sort((a, b) => b.call.rate - a.call.rate || compareText(a.call.workload, b.call.workload));
}

/** A caller netatlas does not see has no classes, so no verdict: it is listed under do call only. */
const classesOf = (ctx: Context, id: string | undefined) => (id === undefined ? [] : (ctx.classes.get(id) ?? []));

const line = (ctx: Context, c: PodClass, netpol: string, istio: string): MayCall => ({ workload: ctx.names.get(c.workloadId) ?? c.workloadId, netpol, istio });

/** A class's line where no host is known: its NetworkPolicy verdict on an unknown address, and its Istio layer. */
const layerLine = (ctx: Context, c: PodClass) => line(ctx, c, netpolLine(ctx, c, [UNKNOWN_ADDRESS]).text, ctx.layer(c).text);

/** Each line once: the classes of one workload differ only during a rollout, and most read alike even then. */
const distinct = (lines: readonly MayCall[]): MayCall[] => [...new Map(lines.map((l) => [JSON.stringify([l.workload, l.netpol, l.istio]), l])).values()];

/** A class's verdict on one host by each layer. */
type Judge = (c: PodClass) => { readonly netpol: Verdict; readonly istio: Verdict };

/**
 * A host's row: its callers first, then, for a ServiceEntry host, the other workloads a rule of either
 * layer lets call it, by workload id. Every other workload neither layer blocks is counted, not listed:
 * those are the workloads that may call any host, and listing them would repeat them on every row.
 */
function hostRow(ctx: Context, kind: 'named' | 'seen', destination: string, ports: string, judge: Judge, called: Called | undefined): OutboundRow {
  const calling = callingOf(called);
  const judged = new Map([...ctx.classes].map(([id, classes]) => [id, classes.map((c) => ({ c, ...judge(c) }))]));
  const linesOf = (id: string | undefined) => (id === undefined ? [] : (judged.get(id) ?? []).map((v) => line(ctx, v.c, v.netpol.text, v.istio.text)));
  const callerIds = new Set(calling.map((x) => x.id));
  const others = [...judged].filter(([id]) => !callerIds.has(id));
  const isListed = (verdicts: readonly { netpol: Verdict; istio: Verdict }[]) => kind === 'named' && verdicts.some((v) => v.netpol.outcome === 'allowed' || v.istio.outcome === 'allowed');
  const listed = others.filter(([, verdicts]) => isListed(verdicts));
  const othersMay = others.filter(([, verdicts]) => !isListed(verdicts) && verdicts.some((v) => v.netpol.outcome !== 'blocked' && v.istio.outcome !== 'blocked')).length;
  return {
    kind,
    destination,
    ports,
    mayCall: distinct([...calling.flatMap((x) => linesOf(x.id)), ...listed.flatMap(([id]) => linesOf(id))]),
    othersMay,
    doCall: calling.map((x) => x.call),
  };
}

/**
 * The hosts of the ServiceEntries for destinations outside the mesh, each with its entries by namespace
 * and name; an entry without a location is MESH_EXTERNAL, the proto's zero value. A MESH_INTERNAL entry
 * stands for a service inside the mesh, so its hosts get no row of their own, and a call to one is
 * listed as a seen host, so that no call out of the cluster goes missing from the view.
 */
function externalHosts(r: ClusterResources): Map<string, ServiceEntryObject[]> {
  const entries = r.serviceEntries === 'not-installed' ? [] : r.serviceEntries;
  const byHost = new Map<string, ServiceEntryObject[]>();
  for (const se of [...entries].sort(byOrder((x) => x.metadata.namespace, (x) => x.metadata.name))) {
    if (se.spec.location === 'MESH_INTERNAL') continue;
    for (const host of se.spec.hosts) byHost.set(host, [...(byHost.get(host) ?? []), se]);
  }
  return byHost;
}

/**
 * What a caller connects to when no sidecar redirects its call: the name's own address, which netatlas
 * does not know, on each port the entry serves, not the targetPort or endpoint port a sidecar would
 * connect to, over that port's transport (UDP for a UDP port, pkg/config/protocol/instance.go:48-50).
 */
const dialled = (se: ServiceEntryObject): PortTargets =>
  targetsPerPort(se, (port) => ({ addresses: null, ...(port && { port: { number: port.number, protocol: transportOf(port) } }) }));

function namedRow(ctx: Context, host: string, entries: readonly ServiceEntryObject[], called: Called | undefined): OutboundRow[] {
  const [first] = entries;
  if (!first) return [];
  const ports = [...new Set(entries.flatMap((se) => (se.spec.ports ?? []).map((p) => (p.protocol ? `${p.protocol} ${p.number}` : `${p.number}`))))].join(', ');
  // What leaves the pod: a sidecar connects as the entry its namespace sees says; without a sidecar, or
  // when the namespace sees none of the entries, nothing redirects the call to what the app dialled.
  const targetsFor = (c: PodClass) => {
    const [seen] = entriesSeenFrom(entries, c.namespace, ctx.r);
    return c.mesh === 'sidecar' && seen ? serviceEntryTargets(seen) : dialled(seen ?? first);
  };
  const judge: Judge = (c) => ({ netpol: netpolLine(ctx, c, targetsFor(c)), istio: istioVerdict(ctx.layer(c), host, c.namespace) });
  return [hostRow(ctx, 'named', host, ports, judge, called)];
}

/** A host seen only in plain HTTP's Host header: no entry tells its address or port. */
function seenRow(ctx: Context, called: Called): OutboundRow {
  const judge: Judge = (c) => ({ netpol: netpolLine(ctx, c, [UNKNOWN_ADDRESS]), istio: istioVerdict(ctx.layer(c), called.destination, c.namespace) });
  return hostRow(ctx, 'seen', called.destination, '', judge, called);
}

/** A row with no host to judge: its callers, each with its line where no host is known. */
function callersRow(ctx: Context, called: Called): OutboundRow {
  const calling = callingOf(called);
  return {
    kind: called.kind,
    destination: called.destination,
    ports: '',
    mayCall: distinct(calling.flatMap((x) => classesOf(ctx, x.id).map((c) => layerLine(ctx, c)))),
    othersMay: 0,
    doCall: calling.map((x) => x.call),
    ...(isPerCaller(called.kind) && { note: NOTES[called.kind] }),
  };
}

/** The policies of one class that name an address block, and the ports they open to it. */
interface Naming {
  readonly policies: string[];
  ports: PortSet;
}

/**
 * One row per address block the egress rules that apply name, each with the workloads whose rules name
 * it, each with the ports its own rules open to it, and the ports all of them open. Workloads that
 * reach every address are on the `any` row, so they are not counted here. NetworkPolicies netatlas may
 * not read name no block it knows of.
 */
function rangeRows(ctx: Context): OutboundRow[] {
  if (!ctx.netpolRead) return [];
  const byRange = new Map<string, { readonly naming: Map<PodClass, Naming>; ports: PortSet }>();
  for (const classes of ctx.classes.values()) {
    for (const c of classes) {
      const rules = ctx.e.addresses(c);
      if (rules === 'any') continue;
      for (const rule of rules) {
        if (!rule.block) continue;
        const text = cidrText(rule.block), range = byRange.get(text) ?? { naming: new Map<PodClass, Naming>(), ports: NONE };
        const naming = range.naming.get(c) ?? { policies: [], ports: NONE };
        naming.policies.push(rule.via.name);
        naming.ports = union(naming.ports, rule.ports);
        range.naming.set(c, naming);
        range.ports = union(range.ports, rule.ports);
        byRange.set(text, range);
      }
    }
  }
  return [...byRange]
    .sort(([a], [b]) => compareText(a, b))
    .map(([text, { naming, ports }]): OutboundRow => ({
      kind: 'address-range',
      destination: text,
      ports: formatPorts(ports),
      // Worded as netpolVerdict words an allowed address, so that the two read alike, with the class's own
      // ports: the row's ports are every class's, and one class's rule opens no port for another.
      mayCall: distinct(
        [...naming].map(([c, own]) => line(ctx, c, `allowed by ${joinNames([...new Set(own.policies)].map((p) => `${p} (${text})`))} on ${formatPorts(own.ports)}`, ctx.layer(c).text)),
      ),
      othersMay: 0,
      doCall: [],
      note: NOTES['address-range'],
    }));
}

/** Whether a class's egress reaches addresses no rule names: no policy restricts it, or a rule with no peers admits every address. */
function reachesAnyAddress(e: NetpolEvaluator, c: PodClass): boolean {
  const rules = e.addresses(c);
  return rules === 'any' || rules.some((rule) => rule.block === null);
}

/**
 * One row for every workload that neither layer keeps to named destinations, by workload text, rather
 * than those workloads on every host's row; none when no workload is open. The row states a permission,
 * not a destination, so it counts no calls: each call is on the row of where it went.
 */
function anyRows(ctx: Context): OutboundRow[] {
  // A NetworkPolicy netatlas may not read could restrict any workload's egress.
  if (!ctx.netpolRead) return [];
  const open = [...ctx.classes.values()].flat().filter((c) => reachesAnyAddress(ctx.e, c) && OPEN_LAYERS.has(ctx.layer(c).kind));
  if (!open.length) return [];
  // The sort is stable, so the lines of one workload during a rollout keep their order.
  const mayCall = distinct(open.map((c) => layerLine(ctx, c))).sort((a, b) => compareText(a.workload, b.workload));
  return [{ kind: 'any', destination: 'Any other address or domain', ports: '', mayCall, othersMay: 0, doCall: [], note: NOTES.any }];
}

export function outboundRows(r: ClusterResources, t: TrafficSnapshot | undefined): OutboundRow[] {
  const ctx = contextOf(r), hosts = externalHosts(r);
  const called = t?.figures ? calledOf(t.figures, ctx, workloadIndex(r), t.clusterDomain, new Map([...hosts.keys()].map((host) => [hostKey(host), host]))) : [];
  const toHost = new Map(called.flatMap((x) => (x.kind === 'named' ? [[x.destination, x] as const] : [])));
  const named = [...hosts].flatMap(([host, entries]) => namedRow(ctx, host, entries, toHost.get(host)));
  const seen = called.filter((x) => x.kind === 'seen').map((x) => seenRow(ctx, x));
  // Named and seen hosts are one list: the busiest hosts come first, whether a ServiceEntry names them or not.
  const hostRows = [...named, ...seen].sort((a, b) => byRate(a, b) || compareText(a.destination, b.destination));
  // A per-caller row has exactly one caller.
  const byCaller = byOrder<OutboundRow>((x) => x.doCall[0]?.workload ?? '', (x) => x.destination);
  const perCaller = PER_CALLER.flatMap((kind) => called.filter((x) => x.kind === kind).map((x) => callersRow(ctx, x)).sort(byCaller));
  const meshClusters = called.filter((x) => x.kind === 'mesh-cluster').map((x) => callersRow(ctx, x)).sort(byOrder((x) => x.destination));
  return [...hostRows, ...perCaller, ...meshClusters, ...rangeRows(ctx), ...anyRows(ctx)];
}

/**
 * The rows of one destination text as one row, with their callers together, where the first of them is.
 * Each caller's unregistered, refused or unattributed traffic is a row of its own, and a list that drops
 * the callers would show the same text twice.
 */
function byDestination(rows: readonly OutboundRow[]): OutboundRow[] {
  const merged = new Map<string, OutboundRow>();
  for (const x of rows) {
    const known = merged.get(x.destination);
    merged.set(x.destination, known ? { ...known, doCall: [...known.doCall, ...x.doCall] } : x);
  }
  return [...merged.values()];
}

export function internetShortList(rows: readonly OutboundRow[]): ShortList {
  // A row that only moves bytes is listed too. Rows are merged before the order and the cap, and the sort
  // is stable, so entries of equal rate and bytes keep the order outboundRows gave them.
  const top = byDestination(rows)
    .filter(hasFigures)
    .sort((a, b) => byRate(a, b) || byBytes(a, b))
    .slice(0, SHORT_LIST_LENGTH)
    .map((x) => ({ kind: x.kind, destination: x.destination, text: figureText(sumOf(x.doCall, 'requests'), sumOf(x.doCall, 'bytes')) }));
  return { top, named: rows.filter((x) => x.kind === 'named' || x.kind === 'address-range').length, total: rows.filter((x) => x.kind !== 'any').length };
}

/**
 * The entries that share both verdict texts, as one group each, in the order of each group's first entry;
 * each group names its first `cap` workloads and counts the rest.
 */
export function mayCallGroups(mayCall: readonly MayCall[], cap = 12): MayCallGroup[] {
  const byVerdicts = new Map<string, { readonly workloads: string[]; readonly netpol: string; readonly istio: string }>();
  for (const m of mayCall) {
    const key = JSON.stringify([m.netpol, m.istio]);
    const group = byVerdicts.get(key) ?? { workloads: [], netpol: m.netpol, istio: m.istio };
    group.workloads.push(m.workload);
    byVerdicts.set(key, group);
  }
  return [...byVerdicts.values()].map((g) => ({ workloads: g.workloads.slice(0, cap), more: Math.max(g.workloads.length - cap, 0), netpol: g.netpol, istio: g.istio }));
}

/**
 * The rows a search keeps, in their order. Like the policy list's search, the query is matched ignoring
 * case and the spaces around it, and an empty query keeps every row. A row is kept whole when the query
 * is part of its destination or of a workload under May call or Do call; the `any` row, when its
 * destination does not match, keeps only the workloads that match, and goes when none does.
 */
export function searchOutboundRows(rows: readonly OutboundRow[], query: string): OutboundRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...rows];
  const holds = (text: string) => text.toLowerCase().includes(q);
  return rows.flatMap((x): OutboundRow[] => {
    if (holds(x.destination)) return [x];
    // The any row lists every open workload, so a search for some of them keeps only those.
    if (x.kind === 'any') {
      const mayCall = x.mayCall.filter((m) => holds(m.workload));
      return mayCall.length ? [{ ...x, mayCall }] : [];
    }
    return [...x.mayCall, ...x.doCall].some((c) => holds(c.workload)) ? [x] : [];
  });
}

/**
 * What the Outbound view says of a cluster for which it makes no row: that nothing leaves it only when netatlas read
 * every kind the view rests on; otherwise nothing, since a kind it may not read could hold what leaves the cluster,
 * and the view's Cannot read lines say why.
 */
export function noDestinationText(r: ClusterResources): string | undefined {
  return unreadViewKinds(r).length ? undefined : 'No destination outside the cluster.';
}
