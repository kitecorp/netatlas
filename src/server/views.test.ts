import { expect, it } from 'vitest';
import type { ClusterConfig } from './registry';
import { tokenHint } from './views';

const ISTIO = { rootNamespace: 'istio-system', trustDomain: 'cluster.local' };

it.each<[string, ClusterConfig, string]>([
  [
    'an EKS cluster names its cluster and region',
    { name: 'prod-eu-1', server: 'https://x.eks.amazonaws.com', ca: { data: 'Q0E=' }, login: { type: 'eks', clusterName: 'prod-eu', region: 'eu-central-1' }, istio: ISTIO },
    'On EKS: aws eks get-token --cluster-name prod-eu --region eu-central-1 --query status.token --output text',
  ],
  ['a token cluster', { name: 'dev', server: 'https://10.0.0.1:6443', ca: { data: 'Q0E=' }, login: { type: 'token', tokenFile: '/t' }, istio: ISTIO }, 'kubectl create token <account> --duration 15m'],
  ['the cluster netatlas runs in', { name: 'here', login: { type: 'inCluster' }, istio: ISTIO }, 'kubectl create token <account> --duration 15m'],
])('tokenHint: %s', (_name, c, expected) => {
  expect(tokenHint(c)).toBe(expected);
});
