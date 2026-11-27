import type { V1Pod } from '@kubernetes/client-node';
import { expect, it } from 'vitest';
import { trimPod, trimPolicy } from './trim';

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
