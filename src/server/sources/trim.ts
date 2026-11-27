// The direct source keeps only what the model reads. A pod as the API returns it carries env values
// (some from Secrets), volumes and managedFields; none of that reaches the cache or the browser.
import type { V1Container, V1DaemonSet, V1Job, V1Namespace, V1ObjectMeta, V1Pod, V1ReplicaSet } from '@kubernetes/client-node';
import type { Labels, Mesh, Protocol, WorkloadRef } from '@/model/types';
import type { DaemonSetInfo, OwnedObject, RawPod } from '@/model/workloads';

const ISTIO_PROXY = 'istio-proxy';

/** The controlling owner, which is the one Kubernetes acts through; any owner when none is marked. */
function ownerOf(meta: V1ObjectMeta | undefined): WorkloadRef | undefined {
  const refs = meta?.ownerReferences ?? [];
  const ref = refs.find((r) => r.controller) ?? refs[0];
  return ref && { kind: ref.kind, name: ref.name };
}

function meshOf(p: V1Pod): Mesh {
  if (p.metadata?.annotations?.['ambient.istio.io/redirection'] === 'enabled') return 'ambient';
  // Istio injects the proxy as an init container on Kubernetes with native sidecars, and as a container before that.
  const containers: V1Container[] = [...(p.spec?.initContainers ?? []), ...(p.spec?.containers ?? [])];
  return containers.some((c) => c.name === ISTIO_PROXY) ? 'sidecar' : 'none';
}

export function trimPod(p: V1Pod): RawPod {
  const owner = ownerOf(p.metadata);
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

export function trimDaemonSet(d: V1DaemonSet): DaemonSetInfo {
  return {
    namespace: d.metadata?.namespace ?? '',
    name: d.metadata?.name ?? '',
    containers: (d.spec?.template.spec?.containers ?? []).map((c) => ({ name: c.name, args: c.args ?? [] })),
  };
}
