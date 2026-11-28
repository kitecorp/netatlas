import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { clusterDomainOf, loadRegistry, parseRegistry, RegistryError } from './registry';

const istioDefaults = { rootNamespace: 'istio-system', trustDomain: 'cluster.local' };

// A token cluster that passes every check, so each refusal below breaks one thing only.
const tokenCluster = (name: string, extra = '') => `
  - name: ${name}
    server: https://10.0.0.2:6443
    caFile: ${name}/ca.crt
    login:
      type: token
      tokenFile: ${name}/token${extra}`;

describe('parseRegistry', () => {
  test('parses the three logins with Istio defaults', () => {
    const text = `
clusters:
  - name: atlas-a
    login:
      type: inCluster
  - name: atlas-b
    server: https://172.18.0.3:6443
    caFile: b/ca.crt
    login:
      type: token
      tokenFile: b/token
  - name: prod-eu-1
    server: https://ABC123.gr7.eu-west-1.eks.amazonaws.com
    caData: LS0t
    login:
      type: eks
      clusterName: prod-eu-1
      region: eu-west-1
    istio:
      rootNamespace: mesh-root
`;
    expect(parseRegistry(text, '/etc/netatlas')).toStrictEqual({
      clusters: [
        { name: 'atlas-a', login: { type: 'inCluster' }, istio: istioDefaults },
        {
          name: 'atlas-b',
          server: 'https://172.18.0.3:6443',
          ca: { file: '/etc/netatlas/b/ca.crt' },
          login: { type: 'token', tokenFile: '/etc/netatlas/b/token' },
          istio: istioDefaults,
        },
        {
          name: 'prod-eu-1',
          server: 'https://ABC123.gr7.eu-west-1.eks.amazonaws.com',
          ca: { data: 'LS0t' },
          login: { type: 'eks', clusterName: 'prod-eu-1', region: 'eu-west-1' },
          istio: { rootNamespace: 'mesh-root', trustDomain: 'cluster.local' },
        },
      ],
    });
  });

  test.each([
    ['clusters: []', 'registry: no clusters are listed'],
    [`clusters:${tokenCluster('a')}${tokenCluster('a')}`, 'registry: cluster name "a" appears twice'],
    [`clusters:${tokenCluster('Prod EU')}`, 'registry: cluster name "Prod EU" must be 1 to 63 lowercase letters, digits or dashes'],
    [
      `clusters:
  - name: b
    caFile: b/ca.crt
    login: { type: token, tokenFile: b/token }`,
      'registry: cluster "b" needs a server',
    ],
    [
      `clusters:
  - name: b
    server: http://10.0.0.2:6443
    caFile: b/ca.crt
    login: { type: token, tokenFile: b/token }`,
      'registry: cluster "b" server must start with https://',
    ],
    [
      `clusters:
  - name: b
    server: https://10.0.0.2:6443
    login: { type: token, tokenFile: b/token }`,
      'registry: cluster "b" needs caFile or caData',
    ],
    [
      `clusters:
  - name: b
    server: https://10.0.0.2:6443
    caFile: b/ca.crt
    caData: LS0t
    login: { type: token, tokenFile: b/token }`,
      'registry: cluster "b" has both caFile and caData',
    ],
    [
      `clusters:
  - name: a
    login: { type: inCluster }
  - name: a2
    login: { type: inCluster }`,
      'registry: only one cluster can use inCluster login',
    ],
    [
      `clusters:
  - name: a
    server: https://10.0.0.1:6443
    login: { type: inCluster }`,
      'registry: cluster "a" uses inCluster login, so it takes no server or CA',
    ],
    [
      `clusters:
  - name: c
    server: https://ABC123.gr7.eu-west-1.eks.amazonaws.com
    caData: LS0t
    login: { type: eks, clusterName: c, region: eu west }`,
      'registry: cluster "c" region "eu west" is not an AWS region name',
    ],
    [
      `clusters:
  - name: d
    server: https://10.0.0.4:6443
    caData: LS0t
    login: { type: cert }`,
      'registry: cluster "d" login type "cert" is not inCluster, token or eks',
    ],
    [
      `clusters:
  - name: b
    server: https://10.0.0.2:6443
    caFile: b/ca.crt
    login: { type: token }`,
      'registry: cluster "b" token login needs tokenFile',
    ],
    [
      `clusters:
  - name: c
    server: https://ABC123.gr7.eu-west-1.eks.amazonaws.com
    caData: LS0t
    login: { type: eks, region: eu-west-1 }`,
      'registry: cluster "c" eks login needs clusterName',
    ],
  ])('refuses %#', (text, message) => {
    expect(() => parseRegistry(text, '/etc/netatlas')).toThrow(new RegistryError(message));
  });

  // Each fragment adds one fault to cluster "b", which passes every other check.
  test.each([
    ['prometheus: { auth: { type: none } }', 'registry: cluster "b" prometheus needs a url'],
    ['prometheus: { url: prometheus.example:9090 }', 'registry: cluster "b" prometheus url must start with http:// or https://'],
    // A port above 65535 passes the scheme check, but no URL parser reads it; the message leaves the URL out.
    ['prometheus: { url: http://prometheus:99999 }', 'registry: cluster "b" prometheus url is not a URL netatlas can read'],
    [
      'prometheus: { url: https://reader:pw-fixture@prometheus.example }',
      'registry: cluster "b" prometheus url must not carry a user or password: use auth basic with a Secret',
    ],
    ['prometheus: { url: https://prometheus.example, auth: { type: x } }', 'registry: cluster "b" prometheus auth type "x" is not none, bearer or basic'],
    ['prometheus: { url: https://prometheus.example, auth: { type: bearer } }', 'registry: cluster "b" prometheus bearer auth needs tokenFile'],
    [
      'prometheus: { url: https://prometheus.example, auth: { type: basic, usernameFile: prometheus/username } }',
      'registry: cluster "b" prometheus basic auth needs usernameFile and passwordFile',
    ],
    ['prometheus: { url: https://prometheus.example, caFile: prometheus/ca.crt, caData: Q0E= }', 'registry: cluster "b" prometheus has both caFile and caData'],
    ['prometheus: { url: https://prometheus.example, clusterLabel: { name: cluster } }', 'registry: cluster "b" prometheus clusterLabel needs a name and a value'],
    [
      'prometheus: { url: https://prometheus.example, clusterLabel: { name: x-y, value: b } }',
      'registry: cluster "b" prometheus clusterLabel name "x-y" is not a Prometheus label name',
    ],
    ['clusterDomain: Cluster_Local', 'registry: cluster "b" clusterDomain "Cluster_Local" is not a DNS name'],
    // The root namespace goes into the path of the request for the mesh config, so it must be a namespace name.
    ['istio: { rootNamespace: istio/system }', 'registry: cluster "b" istio rootNamespace "istio/system" is not a namespace name'],
  ])('refuses a Prometheus, cluster domain or Istio root namespace it cannot use %#', (fragment, message) => {
    expect(() => parseRegistry(`clusters:${tokenCluster('b', `\n    ${fragment}`)}`, '/etc/netatlas')).toThrow(new RegistryError(message));
  });

  test.each([
    [
      'prometheus: { url: https://prometheus.example:9090, auth: { type: bearer, tokenFile: prometheus/token }, caData: Q0E=, clusterLabel: { name: cluster, value: b } }',
      { url: 'https://prometheus.example:9090', auth: { type: 'bearer', tokenFile: '/etc/netatlas/prometheus/token' }, ca: { data: 'Q0E=' }, clusterLabel: { name: 'cluster', value: 'b' } },
    ],
    [
      'prometheus: { url: https://prometheus.example:9090, clusterLabel: { name: cluster, value: b } }',
      { url: 'https://prometheus.example:9090', auth: { type: 'none' }, clusterLabel: { name: 'cluster', value: 'b' } },
    ],
    [
      'prometheus: { url: https://prometheus.example:9090, auth: { type: basic, usernameFile: prometheus/username, passwordFile: /abs/password }, caFile: prometheus/ca.crt }',
      {
        url: 'https://prometheus.example:9090',
        auth: { type: 'basic', usernameFile: '/etc/netatlas/prometheus/username', passwordFile: '/abs/password' },
        ca: { file: '/etc/netatlas/prometheus/ca.crt' },
      },
    ],
  ])("reads a Prometheus with its files resolved against the registry's folder %#", (fragment, expected) => {
    const [b] = parseRegistry(`clusters:${tokenCluster('b', `\n    ${fragment}`)}`, '/etc/netatlas').clusters;

    expect(b?.prometheus).toStrictEqual(expected);
  });

  test.each([
    ['', 'cluster.local'],
    ['\n    clusterDomain: corp.internal', 'corp.internal'],
  ])('the cluster domain defaults to cluster.local %#', (fragment, expected) => {
    const [b] = parseRegistry(`clusters:${tokenCluster('b', fragment)}`, '/etc/netatlas').clusters;

    expect(b && clusterDomainOf(b)).toBe(expected);
  });
});

describe('loadRegistry', () => {
  test('reads the file it is given and resolves relative files against its folder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'netatlas-registry-'));
    mkdirSync(join(dir, 'conf'));
    const file = join(dir, 'conf', 'clusters.yaml');
    writeFileSync(file, `clusters:${tokenCluster('atlas-b')}\n`);

    expect(loadRegistry(file)).toStrictEqual({
      clusters: [
        {
          name: 'atlas-b',
          server: 'https://10.0.0.2:6443',
          ca: { file: join(dir, 'conf', 'atlas-b', 'ca.crt') },
          login: { type: 'token', tokenFile: join(dir, 'conf', 'atlas-b', 'token') },
          istio: istioDefaults,
        },
      ],
    });
  });
});
