// The direct source keeps only what the model reads. A pod as the API returns it carries env values
// (some from Secrets), volumes and managedFields; none of that reaches the cache or the browser, but
// for one value of istiod's environment, the name of the ConfigMap SHARED_MESH_CONFIG gives.
import type { V1Container, V1DaemonSet, V1Job, V1Namespace, V1ObjectMeta, V1Pod, V1ReplicaSet } from '@kubernetes/client-node';
import { parse } from 'yaml';
import { isRecord } from '@/model/is-record';
import { isIstiod } from '@/model/istio-proxies';
import type { Labels, Mesh, MeshSettings, OutboundSetting, Protocol, ProxyRole, ServiceEntryVisibility, WorkloadRef } from '@/model/types';
import type { DaemonSetInfo, OwnedObject, RawPod } from '@/model/workloads';

const ISTIO_PROXY = 'istio-proxy';
/** The control plane revision that injected the pod's proxy; absent means the default one. */
const ISTIO_REVISION = 'istio.io/rev';

/** The controlling owner, which is the one Kubernetes acts through; any owner when none is marked. */
function ownerOf(meta: V1ObjectMeta | undefined): WorkloadRef | undefined {
  const refs = meta?.ownerReferences ?? [];
  const ref = refs.find((r) => r.controller) ?? refs[0];
  return ref && { kind: ref.kind, name: ref.name };
}

/** The pod's Istio proxy: an init container on Kubernetes with native sidecars, a container before that and in gateways and waypoints. */
function istioProxyOf(p: V1Pod): V1Container | undefined {
  return [...(p.spec?.initContainers ?? []), ...(p.spec?.containers ?? [])].find((c) => c.name === ISTIO_PROXY);
}

function meshOf(p: V1Pod): Mesh {
  if (p.metadata?.annotations?.['ambient.istio.io/redirection'] === 'enabled') return 'ambient';
  return istioProxyOf(p) ? 'sidecar' : 'none';
}

/**
 * The words Istio 1.32 runs its proxy with, after `proxy` in the istio-proxy container's args (files under
 * manifests/charts/istio-control/istio-discovery/files/): `sidecar` (injection-template.yaml:199-200),
 * `router` for every gateway (gateway-injection-template.yaml:38-39) and `waypoint` (waypoint.yaml:110-111).
 */
const PROXY_ROLES: ReadonlySet<string> = new Set<ProxyRole>(['sidecar', 'router', 'waypoint']);

const isProxyRole = (word: string | undefined): word is ProxyRole => word !== undefined && PROXY_ROLES.has(word);

/** What the pod's Istio proxy runs as, so a gateway is known whatever its labels; undefined without a proxy or for another word. */
function proxyRoleOf(p: V1Pod): ProxyRole | undefined {
  const args = istioProxyOf(p)?.args ?? [];
  const at = args.indexOf('proxy');
  const word = at < 0 ? undefined : args[at + 1];
  return isProxyRole(word) ? word : undefined;
}

/**
 * The ConfigMap istiod loads as a second mesh config, named by a non-empty SHARED_MESH_CONFIG in one of
 * its containers (pilot/pkg/features/pilot.go:219-220, bootstrap/mesh.go:112-114). Only that one value of
 * istiod's environment is kept: the rest may come from Secrets.
 */
function sharedMeshConfigOf(p: V1Pod): string | undefined {
  if (!isIstiod({ labels: p.metadata?.labels ?? {} })) return undefined;
  return (p.spec?.containers ?? []).flatMap((c) => c.env ?? []).find((e) => e.name === 'SHARED_MESH_CONFIG' && e.value)?.value;
}

export function trimPod(p: V1Pod): RawPod {
  const owner = ownerOf(p.metadata);
  const istioRevision = p.metadata?.annotations?.[ISTIO_REVISION];
  const proxyRole = proxyRoleOf(p);
  const sharedMeshConfig = sharedMeshConfigOf(p);
  return {
    name: p.metadata?.name ?? '',
    namespace: p.metadata?.namespace ?? '',
    labels: p.metadata?.labels ?? {},
    serviceAccount: p.spec?.serviceAccountName ?? 'default',
    ...(owner && { owner }),
    phase: p.status?.phase ?? 'Unknown',
    // Only the app containers: the ports of an init container, the mesh proxy's among them, are not the workload's.
    ports: (p.spec?.containers ?? []).flatMap((c) =>
      (c.ports ?? []).map((port) => ({
        ...(port.name && { name: port.name }),
        port: port.containerPort,
        protocol: (port.protocol ?? 'TCP') as Protocol,
      })),
    ),
    mesh: meshOf(p),
    ...(istioRevision && { istioRevision }),
    ...(proxyRole && { proxyRole }),
    ...(sharedMeshConfig && { sharedMeshConfig }),
  };
}

/**
 * A policy as the editor shows it. List responses leave apiVersion and kind off each item, and the
 * editor's YAML starts with them, so they are set from the list's own kind when absent.
 */
export function trimPolicy<T extends object>(o: T, type: { apiVersion: string; kind: string }): T {
  const { status: _status, metadata, ...rest } = o as T & { status?: unknown; metadata?: Record<string, unknown> };
  const { managedFields: _managedFields, ...meta } = metadata ?? {};
  // An item's own apiVersion and kind, when it has them, replace the defaults and keep these first places.
  return { apiVersion: type.apiVersion, kind: type.kind, metadata: meta, ...rest } as unknown as T;
}

export function trimNamespace(n: V1Namespace): { name: string; labels: Labels } {
  return { name: n.metadata?.name ?? '', labels: n.metadata?.labels ?? {} };
}

export function trimOwned(o: V1ReplicaSet | V1Job): OwnedObject {
  const owner = ownerOf(o.metadata);
  return { namespace: o.metadata?.namespace ?? '', name: o.metadata?.name ?? '', ...(owner && { owner }) };
}

type Outbound = Extract<MeshSettings, { state: 'found' }>['outbound'];

/** OutboundTrafficPolicy.Mode by number, as the mesh config may give it (istio/api mesh/v1alpha1/config.proto:175-211). */
const MODES: Readonly<Record<number, OutboundSetting>> = { 0: 'REGISTRY_ONLY', 1: 'ALLOW_ANY', 3: 'ALLOW_ANY_DYNAMIC_DNS' };
const MODE_NAMES: readonly string[] = Object.values(MODES);

/** The mesh's outbound mode; undefined when the policy is not one Istio could read. */
function outboundOf(policy: unknown): Outbound | undefined {
  if (policy === undefined || policy === null) return 'unset';
  if (!isRecord(policy)) return undefined;
  const { mode } = policy;
  if (mode === undefined || mode === null) return 'no-mode';
  if (typeof mode === 'number') return MODES[mode] ?? { other: String(mode) };
  if (typeof mode === 'string') return MODE_NAMES.includes(mode) ? (mode as OutboundSetting) : { other: mode };
  return undefined;
}

/**
 * A field of a mesh config message under its JSON name, else its proto name. istiod decodes the mesh
 * config with jsonpb (pkg/util/protomarshal/protomarshal.go:175-177, 196-202), which takes a field under
 * either name and, when both are there, the JSON one, even a null (golang/protobuf jsonpb/decode.go:322-334).
 */
const fieldOf = (message: Record<string, unknown>, jsonName: string, protoName: string): unknown => (Object.hasOwn(message, jsonName) ? message[jsonName] : message[protoName]);

/** ServiceEntryVisibility.Visibility by number (istio/api mesh/v1alpha1/config.proto:1795-1821). */
const VISIBILITIES: Readonly<Record<number, string>> = { 0: 'VISIBILITY_UNSPECIFIED', 1: 'NONE', 2: 'NAMESPACE', 3: 'PUBLIC' };

/**
 * The mesh's serviceEntryVisibility, a message (config.proto:1785-1835); null when it is left out, and
 * undefined when it is not one Istio could read. Its default visibility is kept as written, by name.
 */
function visibilityOf(message: unknown): ServiceEntryVisibility | null | undefined {
  if (message === undefined || message === null) return null;
  if (!isRecord(message)) return undefined;
  const defaultVisibility = fieldOf(message, 'defaultVisibility', 'default_visibility');
  const policies = message.policies;
  const name = typeof defaultVisibility === 'number' ? (VISIBILITIES[defaultVisibility] ?? String(defaultVisibility)) : typeof defaultVisibility === 'string' ? defaultVisibility : undefined;
  // istiod turns the YAML into JSON with sigs.k8s.io/yaml (pkg/util/protomarshal/protomarshal.go:196-202, v1.6.0 by
  // go.mod:118), which reads y, yes and on as true (go.yaml.in/yaml/v2 resolve.go:37-39), while the YAML 1.2 read here
  // keeps them as words. So every value but absent, null and false counts as set: a word such as no or off then reads
  // "depends" too, never a false "listed".
  const applies = fieldOf(message, 'applyToSidecars', 'apply_to_sidecars');
  return { applyToSidecars: applies !== undefined && applies !== null && applies !== false, ...(name !== undefined && { defaultVisibility: name }), policies: Array.isArray(policies) ? policies.length : 0 };
}

/**
 * The settings netatlas reads from the mesh config, the `mesh` key of the ConfigMap `istio`'s data.
 * A setting the mesh config leaves out stays out, so its reader applies Istio's default.
 */
export function trimMeshConfig(data: Record<string, string> | undefined): MeshSettings {
  if (!data) return { state: 'missing' };
  let mesh: unknown;
  try {
    mesh = parse(data.mesh ?? '') ?? {};
  } catch {
    return { state: 'unparsable' };
  }
  if (!isRecord(mesh)) return { state: 'unparsable' };
  const outbound = outboundOf(fieldOf(mesh, 'outboundTrafficPolicy', 'outbound_traffic_policy'));
  const visibility = visibilityOf(fieldOf(mesh, 'serviceEntryVisibility', 'service_entry_visibility'));
  if (outbound === undefined || visibility === undefined) return { state: 'unparsable' };
  const exportTo = fieldOf(mesh, 'defaultServiceExportTo', 'default_service_export_to');
  return {
    state: 'found',
    outbound,
    ...(visibility && { serviceEntryVisibility: visibility }),
    ...(Array.isArray(exportTo) && { defaultServiceExportTo: exportTo.map(String) }),
  };
}

export function trimDaemonSet(d: V1DaemonSet): DaemonSetInfo {
  return {
    namespace: d.metadata?.namespace ?? '',
    name: d.metadata?.name ?? '',
    containers: (d.spec?.template.spec?.containers ?? []).map((c) => ({ name: c.name, args: c.args ?? [] })),
  };
}
