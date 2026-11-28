import type { V1Pod } from '@kubernetes/client-node';
import { expect, it } from 'vitest';
import type { MeshSettings } from '@/model/types';
import { trimMeshConfig, trimPod, trimPolicy } from './trim';

/** A cart pod as the API returns it, with the fields netatlas must not keep: env from a Secret, volumes, status detail. */
const cartPod = (): V1Pod => ({
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: {
    name: 'cart-6d5f7c9b8-4xkqz',
    namespace: 'shop',
    uid: '0b7e5a52-9c1d-4f7e-8a3b-2d6c1e9f4a70',
    resourceVersion: '48213',
    labels: { app: 'cart', 'pod-template-hash': '6d5f7c9b8' },
    annotations: { 'sidecar.istio.io/status': '{"initContainers":["istio-init","istio-proxy"]}' },
    ownerReferences: [{ apiVersion: 'apps/v1', kind: 'ReplicaSet', name: 'cart-6d5f7c9b8', uid: '5d1c', controller: true, blockOwnerDeletion: true }],
    managedFields: [{ manager: 'kube-controller-manager', operation: 'Update', apiVersion: 'v1' }],
  },
  spec: {
    serviceAccountName: 'cart',
    nodeName: 'worker-2',
    initContainers: [
      { name: 'istio-init', image: 'docker.io/istio/proxyv2:1.32.0', args: ['istio-iptables'] },
      {
        name: 'istio-proxy',
        image: 'docker.io/istio/proxyv2:1.32.0',
        restartPolicy: 'Always',
        ports: [{ name: 'http-envoy-prom', containerPort: 15090, protocol: 'TCP' }],
      },
    ],
    containers: [
      {
        name: 'cart',
        image: 'ghcr.io/example/cart:2.4.1',
        ports: [{ name: 'http', containerPort: 8080, protocol: 'TCP' }],
        env: [
          { name: 'LOG_LEVEL', value: 'info' },
          { name: 'DB_PASSWORD', valueFrom: { secretKeyRef: { name: 'cart-db', key: 'password' } } },
        ],
        volumeMounts: [{ name: 'config', mountPath: '/etc/cart' }],
      },
    ],
    volumes: [
      { name: 'config', configMap: { name: 'cart-config' } },
      { name: 'tls', secret: { secretName: 'cart-tls' } },
    ],
  },
  status: { phase: 'Running', podIP: '10.244.1.17', hostIP: '172.18.0.3' },
});

it('keeps only what the model reads from a pod', () =>
  expect(trimPod(cartPod())).toStrictEqual({
    name: 'cart-6d5f7c9b8-4xkqz',
    namespace: 'shop',
    labels: { app: 'cart', 'pod-template-hash': '6d5f7c9b8' },
    serviceAccount: 'cart',
    owner: { kind: 'ReplicaSet', name: 'cart-6d5f7c9b8' },
    phase: 'Running',
    ports: [{ name: 'http', port: 8080, protocol: 'TCP' }],
    mesh: 'sidecar',
  }));

const withMesh = (change: (p: V1Pod) => V1Pod) => trimPod(change(cartPod())).mesh;
const spec = (p: V1Pod) => p.spec ?? { containers: [] };

it.each([
  ['an istio-proxy init container', (p: V1Pod) => p, 'sidecar'],
  ['an istio-proxy container', (p: V1Pod) => ({ ...p, spec: { ...spec(p), initContainers: [], containers: [...spec(p).containers, { name: 'istio-proxy' }] } }), 'sidecar'],
  [
    'the ambient redirection annotation',
    (p: V1Pod) => ({ ...p, metadata: { ...p.metadata, annotations: { 'ambient.istio.io/redirection': 'enabled' } }, spec: { ...spec(p), initContainers: [] } }),
    'ambient',
  ],
  ['neither', (p: V1Pod) => ({ ...p, spec: { ...spec(p), initContainers: [] } }), 'none'],
] as const)('reads the mesh of a pod with %s', (_case, change, expected) => expect(withMesh(change)).toBe(expected));

/** What the pod keeps of its revision: `{}` when the key is absent, so a key holding undefined fails too. */
const revisionOf = (extra: Record<string, string>) => {
  const p = cartPod();
  const kept = trimPod({ ...p, metadata: { ...p.metadata, annotations: { ...p.metadata?.annotations, ...extra } } });
  return Object.fromEntries(Object.entries(kept).filter(([key]) => key === 'istioRevision'));
};

it.each<[string, Record<string, string>, Record<string, string>]>([
  ['with', { 'istio.io/rev': 'canary' }, { istioRevision: 'canary' }],
  ['without', {}, {}],
])("keeps a pod's istio.io/rev annotation as istioRevision: %s it", (_case, extra, expected) => expect(revisionOf(extra)).toStrictEqual(expected));

/**
 * What istiod's pod keeps of its environment: `{}` when the key is absent, so a key holding undefined fails
 * too. The pod is the cart pod made istiod's, its discovery container run with `env`.
 */
const sharedMeshConfigOf = (env: { name: string; value?: string }[]) => {
  const p = cartPod();
  const istiod: V1Pod = {
    ...p,
    metadata: { ...p.metadata, name: 'istiod-79f74bbfc4-fbprk', namespace: 'istio-system', labels: { app: 'istiod', istio: 'pilot' } },
    spec: { ...spec(p), initContainers: [], containers: [{ name: 'discovery', image: 'docker.io/istio/pilot:1.32.0', env }] },
  };
  return Object.fromEntries(Object.entries(trimPod(istiod)).filter(([key]) => key === 'sharedMeshConfig'));
};

// istiod loads a second mesh ConfigMap when SHARED_MESH_CONFIG names one (pilot/pkg/features/pilot.go:219-220, bootstrap/mesh.go:112-114).
it.each<[string, { name: string; value?: string }[], Record<string, string>]>([
  ['named', [{ name: 'PILOT_ENABLE_AMBIENT', value: 'true' }, { name: 'SHARED_MESH_CONFIG', value: 'istio-shared' }], { sharedMeshConfig: 'istio-shared' }],
  // Istio's default is the empty string, which loads nothing.
  ['empty', [{ name: 'SHARED_MESH_CONFIG', value: '' }], {}],
])("keeps the ConfigMap istiod's SHARED_MESH_CONFIG names as sharedMeshConfig: %s", (_case, env, expected) => expect(sharedMeshConfigOf(env)).toStrictEqual(expected));

/** What the pod keeps of its proxy's role: `{}` when the key is absent, so a key holding undefined fails too. */
const roleOf = (change: (p: V1Pod) => V1Pod) => Object.fromEntries(Object.entries(trimPod(change(cartPod()))).filter(([key]) => key === 'proxyRole'));

/** The istio-proxy args of Istio 1.32's templates: injection-template.yaml:199-200, gateway-injection-template.yaml:38-39, waypoint.yaml:110-111. */
const proxyArgs = (role: string) => ['proxy', role, '--domain', '$(POD_NAMESPACE).svc.cluster.local'];

/** The cart pod with its istio-proxy init container, a native sidecar, run with `args`. */
const nativeProxy = (args: string[]) => (p: V1Pod): V1Pod => ({
  ...p,
  spec: { ...spec(p), initContainers: (spec(p).initContainers ?? []).map((c) => (c.name === 'istio-proxy' ? { ...c, args } : c)) },
});

/** The cart pod with istio-proxy as a container run with `args`, as a gateway's or a waypoint's pod has it. */
const proxyContainer = (args: string[]) => (p: V1Pod): V1Pod => ({ ...p, spec: { ...spec(p), initContainers: [], containers: [...spec(p).containers, { name: 'istio-proxy', args }] } });

it.each<[string, (p: V1Pod) => V1Pod, Record<string, string>]>([
  ['sidecar, in a native sidecar', nativeProxy(proxyArgs('sidecar')), { proxyRole: 'sidecar' }],
  ['router, in a container', proxyContainer(proxyArgs('router')), { proxyRole: 'router' }],
  ['waypoint, in a container', proxyContainer(proxyArgs('waypoint')), { proxyRole: 'waypoint' }],
  // A word none of Istio 1.32's templates writes.
  ['another word', proxyContainer(proxyArgs('gateway')), {}],
  ['no istio-proxy container', (p) => ({ ...p, spec: { ...spec(p), initContainers: [] } }), {}],
])("keeps the role of a pod's Istio proxy as proxyRole: %s", (_case, change, expected) => expect(roleOf(change)).toStrictEqual(expected));

it.each<[Record<string, string> | undefined, MeshSettings]>([
  [undefined, { state: 'missing' }],
  [{ mesh: 'outboundTrafficPolicy:\n  mode: REGISTRY_ONLY\n' }, { state: 'found', outbound: 'REGISTRY_ONLY' }],
  [{ mesh: 'enablePrometheusMerge: true\n' }, { state: 'found', outbound: 'unset' }],
  [{}, { state: 'found', outbound: 'unset' }],
  [{ mesh: 'outboundTrafficPolicy: {}\n' }, { state: 'found', outbound: 'no-mode' }],
  [{ mesh: 'outboundTrafficPolicy:\n  mode: 3\n' }, { state: 'found', outbound: 'ALLOW_ANY_DYNAMIC_DNS' }],
  [{ mesh: 'outboundTrafficPolicy:\n  mode: SOMETHING\n' }, { state: 'found', outbound: { other: 'SOMETHING' } }],
  // serviceEntryVisibility is a message (api mesh/v1alpha1/config.proto:1785-1835): netatlas keeps whether
  // sidecars honour it, its default visibility as written, and how many policies it lists.
  [
    {
      mesh: [
        'serviceEntryVisibility:',
        '  defaultVisibility: NAMESPACE',
        '  applyToSidecars: true',
        '  policies:',
        '  - visibility: PUBLIC',
        '    matchingRules:',
        '    - namespaceSelector: {matchLabels: {team: platform}}',
        '  - visibility: NONE',
        '    matchingRules:',
        '    - namespaceSelector: {matchLabels: {team: sandbox}}',
        'defaultServiceExportTo: ["."]',
        '',
      ].join('\n'),
    },
    { state: 'found', outbound: 'unset', serviceEntryVisibility: { applyToSidecars: true, defaultVisibility: 'NAMESPACE', policies: 2 }, defaultServiceExportTo: ['.'] },
  ],
  // apply_to_sidecars is false and the policies none when left out.
  [{ mesh: 'serviceEntryVisibility:\n  defaultVisibility: NONE\n' }, { state: 'found', outbound: 'unset', serviceEntryVisibility: { applyToSidecars: false, defaultVisibility: 'NONE', policies: 0 } }],
  // istiod turns the mesh config into JSON with sigs.k8s.io/yaml (pkg/util/protomarshal/protomarshal.go:196-202, v1.6.0
  // by go.mod), which reads yes, on and y as true (go.yaml.in/yaml/v2 resolve.go:37,39), so a flag written `yes` is set.
  [
    { mesh: 'serviceEntryVisibility:\n  defaultVisibility: NAMESPACE\n  applyToSidecars: yes\n' },
    { state: 'found', outbound: 'unset', serviceEntryVisibility: { applyToSidecars: true, defaultVisibility: 'NAMESPACE', policies: 0 } },
  ],
  [
    { mesh: 'serviceEntryVisibility:\n  defaultVisibility: NAMESPACE\n  applyToSidecars: false\n' },
    { state: 'found', outbound: 'unset', serviceEntryVisibility: { applyToSidecars: false, defaultVisibility: 'NAMESPACE', policies: 0 } },
  ],
  // istiod reads the mesh config with jsonpb, which takes each field's proto name as well as its JSON name.
  [{ mesh: 'outbound_traffic_policy:\n  mode: REGISTRY_ONLY\n' }, { state: 'found', outbound: 'REGISTRY_ONLY' }],
  [{ mesh: 'default_service_export_to: ["."]\n' }, { state: 'found', outbound: 'unset', defaultServiceExportTo: ['.'] }],
  [
    { mesh: 'service_entry_visibility:\n  default_visibility: NAMESPACE\n  apply_to_sidecars: true\n' },
    { state: 'found', outbound: 'unset', serviceEntryVisibility: { applyToSidecars: true, defaultVisibility: 'NAMESPACE', policies: 0 } },
  ],
  // jsonpb sets the field from the proto name, then from the JSON name (golang/protobuf jsonpb decode.go:322-334).
  [{ mesh: 'outboundTrafficPolicy:\n  mode: ALLOW_ANY\noutbound_traffic_policy:\n  mode: REGISTRY_ONLY\n' }, { state: 'found', outbound: 'ALLOW_ANY' }],
  [{ mesh: 'a: [' }, { state: 'unparsable' }],
])("reads the mesh config's outbound settings %#", (data, expected) => expect(trimMeshConfig(data)).toStrictEqual(expected));

it('drops managedFields and status from a listed policy and names its kind', () =>
  expect(
    trimPolicy(
      {
        metadata: { name: 'cart-allow', namespace: 'shop', resourceVersion: '7', managedFields: [{ manager: 'kubectl' }] },
        spec: { podSelector: { matchLabels: { app: 'cart' } }, futureField: 'kept' },
        status: { conditions: [] },
      },
      { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy' },
    ),
  ).toStrictEqual({
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: { name: 'cart-allow', namespace: 'shop', resourceVersion: '7' },
    spec: { podSelector: { matchLabels: { app: 'cart' } }, futureField: 'kept' },
  }));
