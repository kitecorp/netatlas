// What a workload may call outside the cluster, by the two layers that decide it: Istio by host name
// and NetworkPolicy by address. The two are kept side by side and never merged, because a host name and
// an address block are different kinds of rule and netatlas cannot join them. What netatlas cannot
// evaluate reads "depends", with its reason, never as a verdict it cannot prove.
import { blockAdmits, blockMayAdmit } from './cidr';
import { compareText, type PodClass } from './classes';
import { cannotReadDepends, forbidden, joinNames } from './format';
import { isGatewayOrWaypoint, isIstiod } from './istio-proxies';
import { cidrText, type AddressRule, type NetpolEvaluator } from './netpol';
import { admits, formatPorts, NONE, union } from './ports';
import { matchesSelector } from './selectors';
import type { ClusterResources, IPBlock, MeshSettings, OutboundSetting, Protocol, ServiceEntryObject, ServiceEntrySpec, SidecarObject } from './types';

export type Outcome = 'allowed' | 'blocked' | 'depends' | 'any';

export interface Verdict {
  readonly outcome: Outcome;
  readonly text: string;
}

/** What Istio lets a class call outside the cluster, by host name. */
export type IstioLayer =
  | { readonly kind: 'any-domain'; readonly text: string }
  | { readonly kind: 'registry-only'; readonly hosts: readonly { readonly host: string; readonly entry: string }[]; readonly text: string }
  | { readonly kind: 'depends'; readonly text: string }
  | { readonly kind: 'not-in-mesh'; readonly text: string };

/** A destination outside the cluster as NetworkPolicy sees it: its addresses (null when only a name is known) and its port. */
export interface NetpolTarget {
  readonly addresses: readonly string[] | null;
  readonly port?: { readonly number: number; readonly protocol: Protocol };
}

type FoundMesh = Extract<MeshSettings, { state: 'found' }>;
type ListedHosts = Extract<IstioLayer, { kind: 'registry-only' }>['hosts'];

/** A Sidecar egress host `namespace/host`. */
interface EgressHost {
  readonly namespace: string;
  readonly host: string;
}

const NOT_IN_MESH = 'not in the mesh';

/** The mesh config states netatlas cannot read settings from, and why. */
const UNREAD_MESH: Readonly<Record<Exclude<MeshSettings['state'], 'found'>, string>> = {
  missing: 'depends: the ConfigMap istio is missing',
  forbidden: "depends: netatlas's role may not read the ConfigMap istio",
  unparsable: 'depends: the mesh config is not valid YAML',
  'not-installed': 'depends: the cluster serves no networking.istio.io API',
};

const nameOf = (o: SidecarObject | ServiceEntryObject) => `${o.metadata.namespace}/${o.metadata.name}`;

const createdAt = (s: SidecarObject) => (typeof s.metadata.creationTimestamp === 'string' ? s.metadata.creationTimestamp : '');

/** The first of several Sidecars by Istio's order: the oldest, then by name (push_context.go sortConfigByCreationTime). */
const oldest = (list: readonly SidecarObject[]): SidecarObject | undefined =>
  [...list].sort((a, b) => compareText(createdAt(a), createdAt(b)) || compareText(a.metadata.name, b.metadata.name))[0];

/**
 * The one Sidecar that configures the class's proxy (push_context.go:1165-1221): a Sidecar in its
 * namespace whose selector matches, else that namespace's Sidecar without a selector, else the root
 * namespace's. Istio picks exactly one, and the next one down never fills in what it leaves out.
 */
function governingSidecar(c: PodClass, r: ClusterResources): SidecarObject | undefined {
  const list = r.sidecars === 'not-installed' ? [] : r.sidecars;
  const inNamespace = (ns: string) => list.filter((s) => s.metadata.namespace === ns);
  const own = inNamespace(c.namespace);
  // The CRD admits a Sidecar without a spec (only Istio's webhook refuses one), which governs as one without a selector does.
  const selectorOf = (s: SidecarObject) => s.spec?.workloadSelector;
  const selected = own.filter((s) => {
    const selector = selectorOf(s);
    return selector && matchesSelector({ matchLabels: selector.labels ?? {} }, c.labels);
  });
  return oldest(selected) ?? oldest(own.filter((s) => !selectorOf(s))) ?? oldest(inNamespace(r.istioSettings.rootNamespace).filter((s) => !selectorOf(s)));
}

/** The mesh config's settings for the class, or why netatlas cannot read them. */
function meshOf(c: PodClass, r: ClusterResources): FoundMesh | string {
  // A pod of another revision reads the ConfigMap istio-<revision>, which the reader does not watch.
  if (c.istioRevision !== undefined && c.istioRevision !== 'default') return `depends: the pod runs Istio revision ${c.istioRevision}, whose mesh config netatlas does not read`;
  if (r.meshConfig.state !== 'found') return UNREAD_MESH[r.meshConfig.state];
  // istiod applies a ConfigMap SHARED_MESH_CONFIG names under the ConfigMap istio, so it sets whatever the
  // latter leaves out (pilot/pkg/features/pilot.go:219-220, bootstrap/mesh.go:112-114). Only istiod loads a mesh config.
  const shared = r.pods.find((p) => isIstiod(p) && p.sharedMeshConfig)?.sharedMeshConfig;
  return shared ? `depends: istiod also reads the ConfigMap ${shared}, which netatlas does not read` : r.meshConfig;
}

interface Mode {
  readonly mode: OutboundSetting;
  readonly source: string;
}

/** The outbound mode and where it comes from, or why it depends. A Sidecar's policy, when set, replaces the mesh's (sidecar.go:393-400). */
function modeOf(sidecar: SidecarObject | undefined, mesh: FoundMesh | string): Mode | string {
  const policy = sidecar?.spec?.outboundTrafficPolicy;
  if (sidecar && policy) {
    // Replacing rather than merging, a policy without a mode is the proto's zero value, REGISTRY_ONLY.
    const mode = policy.mode ?? 'REGISTRY_ONLY';
    // The Sidecar CRD admits only these two; anything else is a mode netatlas does not know.
    if (mode === 'REGISTRY_ONLY' || mode === 'ALLOW_ANY') return { mode, source: `Sidecar ${nameOf(sidecar)}` };
    return `depends: the Sidecar ${nameOf(sidecar)} sets the outbound mode ${mode}, which netatlas does not know`;
  }
  if (typeof mesh === 'string') return mesh;
  const { outbound } = mesh;
  if (outbound === 'unset') return { mode: 'ALLOW_ANY', source: "Istio's default" };
  if (outbound === 'no-mode') return 'depends: the mesh config sets outboundTrafficPolicy without a mode';
  if (typeof outbound === 'object') return `depends: the mesh config sets the outbound mode ${outbound.other}, which netatlas does not know`;
  return { mode: outbound, source: 'the mesh config' };
}

/** `namespace/host` with neither part an exclusion, the one form of Sidecar egress host netatlas evaluates. */
function hostParts(h: string): EgressHost | null {
  const parts = h.split('/');
  const [namespace, host] = parts;
  if (parts.length !== 2 || namespace === undefined || host === undefined || namespace.startsWith('~') || host.startsWith('~')) return null;
  return { namespace, host };
}

/**
 * Whether host `n` is a subset of host pattern `o`, as Istio's host.Name.SubsetOf (pkg/config/host/name.go:64-87):
 * `*.x` covers `a.x` and `*.b.x`, `*fonts.example` covers `fonts.example`, `*` covers every host, an exact
 * host covers only itself and never a wildcard. Only when both are wildcards does the length count.
 */
function subsetOf(n: string, o: string): boolean {
  const nWild = n.startsWith('*'), oWild = o.startsWith('*');
  if (nWild) return oWild && n.length >= o.length && n.slice(1).endsWith(o.slice(1));
  if (oWild) return n.endsWith(o.slice(1));
  return n === o;
}

/** Whether the entry is visible to the namespace by exportTo; an empty one takes the mesh's default, else every namespace. */
function exportedTo(se: ServiceEntryObject, namespace: string, meshDefault: readonly string[] | undefined): boolean {
  const exportTo = se.spec.exportTo?.length ? se.spec.exportTo : meshDefault?.length ? meshDefault : ['*'];
  // `.` is the entry's own namespace and `~` none.
  return exportTo.some((x) => x === '*' || x === namespace || (x === '.' && se.metadata.namespace === namespace));
}

/**
 * Of a host's entries, those the namespace sees by exportTo, the one in the namespace itself first, as
 * Istio keeps that one of two entries for one host (sidecar.go:870-916). The mesh's default exportTo is
 * taken as unset while the mesh config cannot be read.
 */
export function entriesSeenFrom(entries: readonly ServiceEntryObject[], namespace: string, r: ClusterResources): ServiceEntryObject[] {
  const meshDefault = r.meshConfig.state === 'found' ? r.meshConfig.defaultServiceExportTo : undefined;
  const seen = entries.filter((se) => exportedTo(se, namespace, meshDefault));
  return [...seen.filter((se) => se.metadata.namespace === namespace), ...seen.filter((se) => se.metadata.namespace !== namespace)];
}

/**
 * The hosts of the entries visible to the class's namespace that one of the Sidecar's egress hosts
 * imports, sorted by host. REGISTRY_ONLY admits every host in the registry whatever the entry's
 * location, which sets only how Istio treats the backends (conversion.go:295). Of two entries for one
 * host, the one in the class's own namespace comes first, as Istio keeps that one (sidecar.go:870-916).
 */
function listedHosts(c: PodClass, r: ClusterResources, imports: readonly EgressHost[], mesh: FoundMesh): ListedHosts {
  const entries = r.serviceEntries === 'not-installed' ? [] : r.serviceEntries;
  // `.` in an egress host is the proxy's own namespace, even in the root namespace's Sidecar.
  const imported = (se: ServiceEntryObject, host: string) =>
    imports.some((i) => (i.namespace === '*' || (i.namespace === '.' ? c.namespace : i.namespace) === se.metadata.namespace) && subsetOf(host, i.host));
  // Namespace names hold no `/`, so the prefix names the entry's namespace exactly.
  const elsewhere = (entry: string) => (entry.startsWith(`${c.namespace}/`) ? 0 : 1);
  return entries
    .filter((se) => exportedTo(se, c.namespace, mesh.defaultServiceExportTo))
    .flatMap((se) => se.spec.hosts.filter((host) => imported(se, host)).map((host) => ({ host, entry: nameOf(se) })))
    .sort((a, b) => compareText(a.host, b.host) || elsewhere(a.entry) - elsewhere(b.entry) || compareText(a.entry, b.entry));
}

const depends = (text: string): IstioLayer => ({ kind: 'depends', text });

/** The default visibilities that leave every ServiceEntry public: unspecified, or left out, resolves to PUBLIC (config.proto:1796-1797, 1823-1825). */
const PUBLIC_VISIBILITY: ReadonlySet<string | undefined> = new Set([undefined, 'VISIBILITY_UNSPECIFIED', 'PUBLIC']);

export function istioLayer(c: PodClass, r: ClusterResources): IstioLayer {
  // A pod without a proxy is not in the mesh, whatever its labels say.
  if (c.mesh === 'none') return { kind: 'not-in-mesh', text: NOT_IN_MESH };
  // Gateways and waypoints take the gateway scope: no Sidecar and no outbound mode governs them (push_context.go:1170-1174).
  if (isGatewayOrWaypoint(c)) return depends('depends: a gateway or waypoint forwards only what its routes name, and netatlas does not read them');
  if (c.mesh === 'ambient') return { kind: 'any-domain', text: 'any domain: ztunnel passes unknown traffic through' };
  // A Sidecar netatlas may not read could set either mode, or limit the hosts.
  if (forbidden(r, 'sidecars')) return depends(cannotReadDepends(['sidecars']));
  const sidecar = governingSidecar(c, r), mesh = meshOf(c, r), mode = modeOf(sidecar, mesh);
  if (typeof mode === 'string') return depends(mode);
  if (mode.mode !== 'REGISTRY_ONLY') return { kind: 'any-domain', text: `any domain (${mode.mode}, ${mode.source})` };
  // Under REGISTRY_ONLY the hosts a workload may call are those the ServiceEntries list.
  if (forbidden(r, 'serviceentries')) return depends(cannotReadDepends(['serviceentries']));
  // A Sidecar's REGISTRY_ONLY still sees the ServiceEntries the mesh config's settings decide.
  if (typeof mesh === 'string') return depends(mesh);
  const visibility = mesh.serviceEntryVisibility;
  // With applyToSidecars, istiod caps the entries a sidecar sees: NAMESPACE keeps an entry to its own
  // namespace and NONE hides it (push_context.go:1082-1094), and a policy picks entries by their
  // namespace's labels. Without it only ztunnel and waypoints apply the setting.
  if (visibility?.applyToSidecars && (!PUBLIC_VISIBILITY.has(visibility.defaultVisibility) || visibility.policies > 0))
    return depends('depends: the mesh sets serviceEntryVisibility for sidecars, which netatlas does not evaluate');
  const listeners = sidecar?.spec?.egress ?? [];
  const hosts = listeners.length ? listeners.flatMap((l) => l.hosts) : ['*/*'];
  const odd = hosts.find((h) => hostParts(h) === null);
  if (sidecar && odd !== undefined) return depends(`depends: the Sidecar ${nameOf(sidecar)} lists egress hosts netatlas does not evaluate (${odd})`);
  if (sidecar && listeners.some((l) => l.port !== undefined && l.port !== null)) return depends(`depends: the Sidecar ${nameOf(sidecar)} limits an egress listener to one port`);
  const imports = hosts.flatMap((h) => hostParts(h) ?? []);
  return { kind: 'registry-only', hosts: listedHosts(c, r, imports, mesh), text: `only the hosts listed (REGISTRY_ONLY, ${mode.source})` };
}

/**
 * The entry that admits the host: one listing it exactly, else the most specific wildcard that covers
 * it, as Envoy matches a host. The sort is stable, so of two equal hosts the one listedHosts put first wins.
 */
function admittingEntry(hosts: ListedHosts, host: string): string | undefined {
  const exact = hosts.find((h) => h.host === host);
  if (exact) return exact.entry;
  return hosts.filter((h) => subsetOf(host, h.host)).sort((a, b) => b.host.length - a.host.length)[0]?.entry;
}

/** The Istio verdict for one host; `host` null is a destination with no host. */
export function istioVerdict(layer: IstioLayer, host: string | null, podNamespace: string): Verdict {
  switch (layer.kind) {
    case 'any-domain':
      return { outcome: 'any', text: layer.text };
    case 'depends':
      return { outcome: 'depends', text: layer.text };
    case 'not-in-mesh':
      return { outcome: 'any', text: NOT_IN_MESH };
    case 'registry-only': {
      const entry = host === null ? undefined : admittingEntry(layer.hosts, host);
      return entry === undefined
        ? { outcome: 'blocked', text: `blocked: REGISTRY_ONLY, and no ServiceEntry visible to ${podNamespace} lists it` }
        : { outcome: 'allowed', text: `listed: REGISTRY_ONLY admits it (ServiceEntry ${entry})` };
    }
  }
}

type BlockRule = AddressRule & { readonly block: IPBlock };

const portText = (p: NonNullable<NetpolTarget['port']>) => `${p.protocol} ${p.number}`;

export function netpolVerdict(c: PodClass, e: NetpolEvaluator, t: NetpolTarget): Verdict {
  const rules = e.addresses(c);
  if (rules === 'any') return { outcome: 'any', text: 'any address: no NetworkPolicy restricts its egress' };
  // restrictedBy names the policies that select c's egress whichever class is asked about, so c itself serves.
  const names = joinNames(e.egress(c, c).restrictedBy.map((p) => p.name));
  const { port } = t;
  // Whether a rule may open the target's port. Without a port (STATIC endpoints that disagree on it), the
  // port matters only when a rule names ports: any rule may open it, and only one that opens every port proves it does.
  const opens = (rule: AddressRule) => port === undefined || admits(rule.ports, port.number, port.protocol);
  const proves = (rule: AddressRule) => (port === undefined ? rule.ports === 'all' : opens(rule));
  const peerless = rules.filter((rule) => rule.block === null);
  if (peerless.some(proves)) return { outcome: 'any', text: `any address on ${formatPorts(peerless.reduce((p, rule) => union(p, rule.ports), NONE))} (${names})` };
  // From here a rule with no peers that may open the port is one that names ports, for a target without one.
  const blocks = rules.filter((rule): rule is BlockRule => rule.block !== null);
  // An empty list is no address known, as null is.
  if (!t.addresses?.length) {
    if (blocks.some(opens)) return { outcome: 'depends', text: `depends on the address the name resolves to (${names})` };
    if (peerless.some(opens)) return { outcome: 'depends', text: `depends on the port it calls (${names})` };
    // Address rules that open other ports only: the port is what no rule admits, not every address.
    if (rules.length && port) return { outcome: 'blocked', text: `blocked by ${names}: no egress rule admits ${portText(port)} to an address outside the cluster` };
    return { outcome: 'blocked', text: `blocked: its egress admits no address outside the cluster (${names})` };
  }
  const each = t.addresses.map((address) => {
    // A rule with no peers admits every address, on the ports it names.
    const admitting = [...peerless, ...blocks.filter((rule) => blockAdmits(rule.block, address))];
    // A rule that admits the address on other ports only refuses it on this port, so the text names the port.
    const refusedAs = admitting.length && port ? `${address} on ${portText(port)}` : address;
    // A range a block admits only part of: calls to some of its addresses pass and to the others do not.
    // Blocks that split a range between them still admit it only in part each, so the range depends too.
    const inPart = blocks.some((rule) => opens(rule) && !blockAdmits(rule.block, address) && blockMayAdmit(rule.block, address));
    return { address, refusedAs, rule: admitting.find((rule): rule is BlockRule => rule.block !== null && proves(rule)), maybe: admitting.some(opens), inPart };
  });
  // Only the addresses no rule admits on any port it may call are named, so the text never calls an admitted one refused.
  const refused = each.filter((a) => !a.rule && !a.maybe && !a.inPart).map((a) => a.refusedAs);
  if (refused.length === each.length) return { outcome: 'blocked', text: `blocked by ${names}: no egress rule admits ${refused.join(', ')}` };
  // Calls to the admitted addresses pass: a STATIC entry spreads its calls over its endpoints, and a NONE one passes the address the app dialled.
  if (refused.length) return { outcome: 'depends', text: `depends on which address it calls: no egress rule of ${names} admits ${refused.join(', ')}` };
  const partly = each.filter((a) => !a.rule && !a.maybe).map((a) => a.address);
  if (partly.length) return { outcome: 'depends', text: `depends on which address of ${joinNames(partly)} it calls (${names})` };
  // Reached only without a port: a rule admits the address on some ports, and netatlas does not know which one is called.
  if (each.some((a) => !a.rule)) return { outcome: 'depends', text: `depends on the port it calls (${names})` };
  const by = [...new Set(each.flatMap((a) => (a.rule ? [`${a.rule.via.name} (${cidrText(a.rule.block)})`] : [])))];
  return { outcome: 'allowed', text: `allowed by ${joinNames(by)}` };
}

export type ServiceEntryPort = NonNullable<ServiceEntrySpec['ports']>[number];
type ServiceEntryEndpoint = NonNullable<ServiceEntrySpec['endpoints']>[number];

const positive = (n: number | undefined) => (n !== undefined && n > 0 ? n : undefined);

/**
 * The port the sidecar connects to, for every resolution: the endpoint's own port for the port's name,
 * else targetPort, else the number (conversion.go:357-363, 417-430). A NONE entry has no endpoints, and
 * its passthrough cluster still connects on targetPort (conversion.go:231-239, cluster_builder.go:533-540).
 */
const upstreamPort = (port: ServiceEntryPort, endpoint?: ServiceEntryEndpoint) => positive(endpoint?.ports?.[port.name]) ?? positive(port.targetPort) ?? port.number;

/**
 * The transport a ServiceEntry port runs over, which is what a NetworkPolicy port rule matches: UDP when
 * its protocol is UDP, which Istio accepts as a port protocol (pkg/config/protocol/instance.go:48-50) and
 * reads without regard to case (:68-73); TCP for every other protocol Istio knows, HTTP, TLS and the rest.
 */
export const transportOf = (port: ServiceEntryPort): Protocol => (port.protocol?.toUpperCase() === 'UDP' ? 'UDP' : 'TCP');

/**
 * The address and port the sidecar connects to for one port of the entry, which is what a NetworkPolicy
 * sees leave the pod (conversion.go:213-225, 346-384): NONE passes the call through to the address the
 * app dialled, so its `addresses`; STATIC its endpoints' addresses; DNS and the other resolutions what a
 * name resolves to, which netatlas does not know, so null. The port is upstreamPort's for every
 * resolution, on the port's transport; an entry without ports gives a target without one.
 */
function serviceEntryTarget(se: ServiceEntryObject, port: ServiceEntryPort | undefined): NetpolTarget {
  const resolution = se.spec.resolution ?? 'NONE';
  if (resolution === 'NONE') return { addresses: se.spec.addresses?.length ? se.spec.addresses : null, ...(port && { port: { number: upstreamPort(port), protocol: transportOf(port) } }) };
  const endpoints = (se.spec.endpoints ?? []).filter((ep) => ep.address !== undefined);
  const addresses = resolution === 'STATIC' && endpoints.length ? endpoints.flatMap((ep) => ep.address ?? []) : null;
  // A DNS entry with no endpoints connects to its host on the port's targetPort or number. Endpoints that
  // disagree on the port leave it unknown, and the verdict then says what that leaves open.
  const numbers = new Set(port ? (endpoints.length ? endpoints.map((ep) => upstreamPort(port, ep)) : [upstreamPort(port)]) : []);
  const [number] = numbers;
  return { addresses, ...(port && number !== undefined && numbers.size === 1 && { port: { number, protocol: transportOf(port) } }) };
}

/** One target per port of a destination, at least one. */
export type PortTargets = readonly [NetpolTarget, ...NetpolTarget[]];

/** One target per port of the entry, in the entry's order; an entry without ports gives one target without a port. */
export function targetsPerPort(se: ServiceEntryObject, target: (port: ServiceEntryPort | undefined) => NetpolTarget): PortTargets {
  const [first, ...rest] = se.spec.ports ?? [];
  return first ? [target(first), ...rest.map(target)] : [target(undefined)];
}

/** What a NetworkPolicy sees leave the pod for each port of the entry: Istio serves every port of an entry (conversion.go:230-240). */
export const serviceEntryTargets = (se: ServiceEntryObject): PortTargets => targetsPerPort(se, (port) => serviceEntryTarget(se, port));

/**
 * The NetworkPolicy verdict on a destination served on several ports. Each port is judged, and the ports are
 * compared by outcome: a blocked text names its port and an allowed text its policy, so two ports blocked or
 * allowed alike read differently. When every port has the same outcome, and it is not "depends", that outcome
 * stands, with each distinct text once, in the entry's order. Else it depends on the port, since each call goes
 * to one of them.
 */
export function netpolVerdictOnPorts(c: PodClass, e: NetpolEvaluator, [first, ...others]: PortTargets): Verdict {
  const verdict = netpolVerdict(c, e, first), rest = others.map((t) => netpolVerdict(c, e, t));
  const texts = [...new Set([verdict, ...rest].map((v) => v.text))];
  if (texts.length === 1) return verdict;
  if (verdict.outcome !== 'depends' && rest.every((v) => v.outcome === verdict.outcome)) return { outcome: verdict.outcome, text: joinNames(texts) };
  // restrictedBy names the policies that select c's egress whichever class is asked about, so c itself serves.
  return { outcome: 'depends', text: `depends on the port it calls (${joinNames(e.egress(c, c).restrictedBy.map((p) => p.name))})` };
}
