import { expect, it } from 'vitest';
import type { WorkloadRef } from './types';
import { detectEnforcer, detectIstio, nameWorkload, type DaemonSetInfo, type OwnedObject, type RawPod } from './workloads';

const pod = (name: string, owner?: WorkloadRef, labels: RawPod['labels'] = {}): RawPod => ({
  name,
  namespace: 'shop',
  labels,
  serviceAccount: 'default',
  phase: 'Running',
  ports: [],
  mesh: 'none',
  ...(owner && { owner }),
});

const replicaSets: OwnedObject[] = [
  { namespace: 'shop', name: 'cart-6d5f7c9b8', owner: { kind: 'Deployment', name: 'cart' } },
  { namespace: 'shop', name: 'legacy-5f4d', },
];
const jobs: OwnedObject[] = [
  { namespace: 'shop', name: 'report-29100', owner: { kind: 'CronJob', name: 'report' } },
  { namespace: 'shop', name: 'migrate' },
];

it.each([
  [pod('cart-6d5f7c9b8-4xkqz', { kind: 'ReplicaSet', name: 'cart-6d5f7c9b8' }), { kind: 'Deployment', name: 'cart' }],
  [pod('report-29100-q8z2m', { kind: 'Job', name: 'report-29100' }), { kind: 'CronJob', name: 'report' }],
  [pod('pod-x', { kind: 'Node', name: 'worker-1' }), { kind: 'Pod', name: 'pod-x' }],
  [pod('pod-y'), { kind: 'Pod', name: 'pod-y' }],
  [pod('postgres-0', { kind: 'StatefulSet', name: 'postgres' }), { kind: 'StatefulSet', name: 'postgres' }],
  [pod('legacy-5f4d-k2m9p', { kind: 'ReplicaSet', name: 'legacy-5f4d' }), { kind: 'ReplicaSet', name: 'legacy-5f4d' }],
  [pod('migrate-h7k3n', { kind: 'Job', name: 'migrate' }), { kind: 'Job', name: 'migrate' }],
])('nameWorkload %#', (p, expected) => expect(nameWorkload(p, replicaSets, jobs)).toEqual(expected));

const ds = (name: string, containers: DaemonSetInfo['containers'] = [{ name, args: [] }]): DaemonSetInfo => ({ namespace: 'kube-system', name, containers });
const awsNode = (flag: string) =>
  ds('aws-node', [
    { name: 'aws-node', args: [] },
    { name: 'aws-eks-nodeagent', args: ['--enable-ipv6=false', flag, '--metrics-bind-addr=:8162'] },
  ]);

it.each([
  [[ds('kube-proxy'), ds('calico-node')], 'Calico'],
  [[ds('cilium')], 'Cilium'],
  [[awsNode('--enable-network-policy=true')], 'AWS VPC CNI'],
  [[awsNode('--enable-network-policy=false')], null],
  [[ds('kindnet')], null],
])('detectEnforcer %#', (sets, expected) => expect(detectEnforcer(sets)).toBe(expected));

it.each([
  [[ds('ztunnel'), ds('istio-cni-node')], [pod('istiod-7d4b9c6f5-x2k9m', undefined, { app: 'istiod' })], 'ambient'],
  [[ds('istio-cni-node')], [pod('istiod-7d4b9c6f5-x2k9m', undefined, { app: 'istiod' })], 'sidecars'],
  [[ds('calico-node')], [pod('cart-6d5f7c9b8-4xkqz', undefined, { app: 'cart' })], 'none'],
])('detectIstio %#', (sets, pods, expected) => expect(detectIstio(sets, pods)).toBe(expected));
