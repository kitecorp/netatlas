import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { ClusterConfig } from '../registry';
import { EXPECTED_TOKEN, REFERENCE } from './eks-token.fixture';
import { kubeConfigFor, kubeConfigWithToken } from './kubeconfig';
import { TOKEN_FILE_PROVIDER, TokenFileAuthenticator } from './token-file';

const istio = { rootNamespace: 'istio-system', trustDomain: 'cluster.local' };

const tokenCluster = (dir: string): ClusterConfig => ({
  name: 'atlas-b',
  server: 'https://172.18.0.3:6443',
  ca: { data: 'LS0t' },
  login: { type: 'token', tokenFile: join(dir, 'token') },
  istio,
});

test('sends a token file without its trailing newline', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'netatlas-token-'));
  writeFileSync(join(dir, 'token'), 'eyJhbGciOi.fixture\n');
  const opts: { headers?: Record<string, string> } = {};

  await kubeConfigFor(tokenCluster(dir)).applyToHTTPSOptions(opts);

  expect(opts.headers).toStrictEqual({ Authorization: 'Bearer eyJhbGciOi.fixture' });
});

test('re-reads the token file once 60 s have passed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'netatlas-token-'));
  const file = join(dir, 'token');
  let now = new Date('2026-11-27T10:00:00Z');
  const auth = new TokenFileAuthenticator(() => now);
  const user = { name: 'atlas-b', authProvider: { name: TOKEN_FILE_PROVIDER, config: { file } } };
  const headerAt = async (seconds: number) => {
    now = new Date(Date.parse('2026-11-27T10:00:00Z') + seconds * 1000);
    const opts: { headers?: Record<string, string> } = {};
    await auth.applyAuthentication(user, opts);
    return opts.headers?.Authorization;
  };

  writeFileSync(file, 'first\n');
  const first = await headerAt(0);
  writeFileSync(file, 'second\n');
  const before = await headerAt(60);
  const after = await headerAt(61);

  expect([first, before, after]).toEqual(['Bearer first', 'Bearer first', 'Bearer second']);
});

test('points a token cluster at its server and CA', () => {
  const kc = kubeConfigFor({
    name: 'atlas-b',
    server: 'https://172.18.0.3:6443',
    ca: { file: '/var/run/netatlas/clusters/atlas-b/ca.crt' },
    login: { type: 'token', tokenFile: '/var/run/netatlas/clusters/atlas-b/token' },
    istio,
  });

  expect(kc.getCurrentCluster()).toStrictEqual({
    name: 'atlas-b',
    server: 'https://172.18.0.3:6443',
    caFile: '/var/run/netatlas/clusters/atlas-b/ca.crt',
    skipTLSVerify: false,
  });
});

test('points a token cluster with inline CA data at that data', () => {
  expect(kubeConfigFor(tokenCluster('/unused')).getCurrentCluster()).toStrictEqual({
    name: 'atlas-b',
    server: 'https://172.18.0.3:6443',
    caData: 'LS0t',
    skipTLSVerify: false,
  });
});

test("puts the signed token on an eks cluster's requests", async () => {
  const eksCluster: ClusterConfig = {
    name: 'prod',
    server: 'https://ABCDEF0123456789.gr7.eu-west-1.eks.amazonaws.com',
    ca: { data: 'LS0t' },
    login: { type: 'eks', clusterName: REFERENCE.clusterName, region: REFERENCE.region },
    istio,
  };
  const opts: { headers?: Record<string, string> } = {};

  await kubeConfigFor(eksCluster, { credentials: async () => REFERENCE.credentials, now: () => REFERENCE.now }).applyToHTTPSOptions(opts);

  expect(opts.headers).toStrictEqual({ Authorization: `Bearer ${EXPECTED_TOKEN}` });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

test("sends the person's token, not netatlas's", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'netatlas-token-'));
  writeFileSync(join(dir, 'token'), 'netatlas-token\n');
  const opts: { headers?: Record<string, string> } = {};

  await kubeConfigWithToken(tokenCluster(dir), 'person-token').applyToHTTPSOptions(opts);

  expect(opts.headers).toStrictEqual({ Authorization: 'Bearer person-token' });
});

test.each<[string, ClusterConfig, Record<string, unknown>]>([
  [
    'inCluster, at the service address with the service account CA',
    { name: 'atlas-a', login: { type: 'inCluster' }, istio },
    { name: 'atlas-a', server: 'https://10.96.0.1:443', caFile: '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt', skipTLSVerify: false },
  ],
  [
    'token, at its server with its CA file',
    { name: 'atlas-b', server: 'https://172.18.0.3:6443', ca: { file: '/var/run/netatlas/clusters/atlas-b/ca.crt' }, login: { type: 'token', tokenFile: '/unused' }, istio },
    { name: 'atlas-b', server: 'https://172.18.0.3:6443', caFile: '/var/run/netatlas/clusters/atlas-b/ca.crt', skipTLSVerify: false },
  ],
  [
    'eks, at its server with its CA data',
    { name: 'prod', server: 'https://ABCDEF.gr7.eu-west-1.eks.amazonaws.com', ca: { data: 'LS0t' }, login: { type: 'eks', clusterName: 'prod', region: 'eu-west-1' }, istio },
    { name: 'prod', server: 'https://ABCDEF.gr7.eu-west-1.eks.amazonaws.com', caData: 'LS0t', skipTLSVerify: false },
  ],
])('points the person-token config of %s', (_name, c, cluster) => {
  vi.stubEnv('KUBERNETES_SERVICE_HOST', '10.96.0.1');
  vi.stubEnv('KUBERNETES_SERVICE_PORT', '443');

  const kc = kubeConfigWithToken(c, 'person-token');

  expect([kc.getCurrentCluster(), kc.getCurrentUser()]).toStrictEqual([cluster, { name: c.name, token: 'person-token' }]);
});
