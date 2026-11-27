import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseAllDocuments } from 'yaml';
import { parseRegistry } from '@/server/registry';
import { grants, READ_ONLY, type Rule } from '@/server/sources/reader-kinds.fixture';

const root = fileURLToPath(new URL('../../', import.meta.url));
const CI_VALUES = ['-f', 'charts/netatlas/ci/two-clusters-values.yaml'];

interface Manifest {
  kind: string;
  metadata: { name: string };
  data?: Record<string, string>;
  rules?: Rule[];
  spec?: Record<string, never>;
}

/** Runs helm in the repository root; `args` follow `helm <command> t charts/netatlas`. */
function helm(command: 'template' | 'install', args: string[]) {
  const run = spawnSync('helm', [command, 't', 'charts/netatlas', ...args], { cwd: root, encoding: 'utf8' });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

function render(args: string[] = CI_VALUES): Manifest[] {
  const run = helm('template', args);
  if (run.status !== 0) throw new Error(`helm template failed: ${run.stderr}`);
  return parseAllDocuments(run.stdout).map((d) => d.toJS() as Manifest).filter(Boolean);
}

const find = (docs: Manifest[], kind: string) => docs.find((d) => d.kind === kind);

/** The Deployment's pod spec and its one container, as plain JSON. */
function pod(docs: Manifest[]) {
  const spec = find(docs, 'Deployment')?.spec as unknown as { replicas: number; template: { spec: { securityContext: unknown; volumes: unknown[]; containers: Record<string, unknown>[] } } };
  return { replicas: spec.replicas, spec: spec.template.spec, container: spec.template.spec.containers[0] ?? {} };
}

const istio = { rootNamespace: 'istio-system', trustDomain: 'cluster.local' };

describe('the netatlas chart', () => {
  it('renders a registry netatlas parses into the clusters in the values', () => {
    const registry = find(render(), 'ConfigMap')?.data?.['clusters.yaml'] ?? '';

    expect(parseRegistry(registry, '/etc/netatlas').clusters).toStrictEqual([
      { name: 'atlas-a', login: { type: 'inCluster' }, istio },
      {
        name: 'atlas-b',
        server: 'https://172.18.0.3:6443',
        ca: { file: '/var/run/netatlas/clusters/atlas-b/ca.crt' },
        login: { type: 'token', tokenFile: '/var/run/netatlas/clusters/atlas-b/token' },
        istio,
      },
      {
        name: 'prod-eu-1',
        server: 'https://ABCDEF0123456789.gr7.eu-west-1.eks.amazonaws.com',
        ca: { data: 'LS0t' },
        login: { type: 'eks', clusterName: 'prod-eu-1', region: 'eu-west-1' },
        istio: { rootNamespace: 'istio-system', trustDomain: 'prod.example' },
      },
    ]);
  });

  it("mounts each token cluster's Secret where its registry entry points", () => {
    const { spec, container } = pod(render());

    expect([spec.volumes, container.volumeMounts]).toStrictEqual([
      [
        { name: 'clusters', configMap: { name: 't' } },
        { name: 'cluster-atlas-b', secret: { secretName: 'netatlas-atlas-b' } },
        { name: 'next-cache', emptyDir: {} },
        { name: 'tmp', emptyDir: {} },
      ],
      [
        { name: 'clusters', mountPath: '/etc/netatlas', readOnly: true },
        { name: 'cluster-atlas-b', mountPath: '/var/run/netatlas/clusters/atlas-b', readOnly: true },
        { name: 'next-cache', mountPath: '/app/.next/cache' },
        { name: 'tmp', mountPath: '/tmp' },
      ],
    ]);
  });

  it('grants its reader role read on exactly the watched kinds', () => {
    const role = render().find((d) => d.kind === 'ClusterRole' && d.metadata.name === 't-reader');

    expect(grants(role?.rules ?? [])).toStrictEqual(READ_ONLY);
  });

  it('runs one pod as a non-root user, with a read-only root filesystem, no capabilities and the runtime default seccomp profile', () => {
    const { replicas, spec, container } = pod(render());

    expect([replicas, spec.securityContext, container.securityContext]).toStrictEqual([
      1,
      { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, seccompProfile: { type: 'RuntimeDefault' } },
      { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
    ]);
  });

  it('runs the server on port 3000 with the registry file, the health probes and the resources', () => {
    const { container } = pod(render());

    expect([container.image, container.env, container.ports, container.readinessProbe, container.livenessProbe, container.resources]).toStrictEqual([
      'ghcr.io/kitecorp/netatlas:0.1.0',
      [
        { name: 'NETATLAS_CLUSTERS_FILE', value: '/etc/netatlas/clusters.yaml' },
        { name: 'PORT', value: '3000' },
        { name: 'HOSTNAME', value: '0.0.0.0' },
      ],
      [{ name: 'http', containerPort: 3000, protocol: 'TCP' }],
      { httpGet: { path: '/api/health', port: 'http' }, periodSeconds: 10 },
      { httpGet: { path: '/api/health', port: 'http' }, periodSeconds: 20, failureThreshold: 6 },
      { requests: { cpu: '100m', memory: '256Mi' }, limits: { memory: '512Mi' } },
    ]);
  });

  it('serves on port 80 inside the cluster, and renders an ingress only when it is turned on', () => {
    const kinds = (args: string[]) => render([...CI_VALUES, ...args]).map((d) => d.kind).sort();

    expect([find(render(), 'Service')?.spec, kinds([]), kinds(['--set', 'ingress.enabled=true', '--set', 'ingress.host=netatlas.example.com'])]).toStrictEqual([
      { type: 'ClusterIP', selector: { 'app.kubernetes.io/name': 'netatlas', 'app.kubernetes.io/instance': 't' }, ports: [{ name: 'http', port: 80, targetPort: 'http', protocol: 'TCP' }] },
      ['ClusterRole', 'ClusterRoleBinding', 'ConfigMap', 'Deployment', 'Service', 'ServiceAccount'],
      ['ClusterRole', 'ClusterRoleBinding', 'ConfigMap', 'Deployment', 'Ingress', 'Service', 'ServiceAccount'],
    ]);
  });

  it('refuses a token cluster without a Secret', () => {
    const run = helm('template', ['--set-json', 'clusters=[{"name":"atlas-b","server":"https://172.18.0.3:6443","login":{"type":"token"}}]']);

    expect([run.status, run.stderr.match(/\): (.*)$/m)?.[1]]).toStrictEqual([1, 'cluster "atlas-b" uses token login, so it needs login.secretName']);
  });

  it('refuses an install with no clusters instead of starting a pod that stops', () => {
    const run = helm('template', []);

    expect([run.status, run.stderr.match(/\): (.*)$/m)?.[1]]).toStrictEqual([1, 'clusters is empty: list at least one cluster for netatlas to read']);
  });

  it('refuses an ingress with no host, which would render notes and TLS for an empty address', () => {
    const run = helm('template', [...CI_VALUES, '--set', 'ingress.enabled=true', '--set', 'ingress.tls.secretName=netatlas-tls']);

    expect([run.status, run.stderr.match(/\): (.*)$/m)?.[1]]).toStrictEqual([1, 'ingress.enabled needs ingress.host, the address people open netatlas on']);
  });

  // The reader role and the mounted token serve only an inCluster login; the EKS logins' webhook mounts its own token.
  it.each<[string, string[], string[], boolean | undefined]>([
    ['a cluster read with inCluster', CI_VALUES, ['ClusterRole', 'ClusterRoleBinding', 'ConfigMap', 'Deployment', 'Service', 'ServiceAccount'], undefined],
    [
      'EKS clusters only',
      ['--set-json', 'clusters=[{"name":"prod-eu-1","server":"https://x.eks.amazonaws.com","caData":"LS0t","login":{"type":"eks","clusterName":"prod-eu-1","region":"eu-west-1"}}]'],
      ['ConfigMap', 'Deployment', 'Service', 'ServiceAccount'],
      false,
    ],
  ])('grants the reader role and mounts the token for %s only when it is used', (_name, args, kinds, automount) => {
    const docs = render(args);
    expect([docs.map((d) => d.kind).sort(), (pod(docs).spec as { automountServiceAccountToken?: boolean }).automountServiceAccountToken]).toStrictEqual([kinds, automount]);
  });

  it.each<[string, string[], string[]]>([
    ['no ingress', [], []],
    [
      'an ingress without TLS',
      ['--set', 'ingress.enabled=true', '--set', 'ingress.host=netatlas.example.com'],
      [
        'Anyone who can reach netatlas.example.com sees every cluster\'s policies. netatlas has no login of its own, so protect this ingress. Apply sends a Kubernetes token: serve it over TLS only.',
        'This ingress names no TLS secret. netatlas offers Apply only over HTTPS, so unless TLS ends in front of the ingress, Apply stays off there and Copy YAML still works.',
      ],
    ],
    [
      'an ingress with TLS',
      ['--set', 'ingress.enabled=true', '--set', 'ingress.host=netatlas.example.com', '--set', 'ingress.tls.secretName=netatlas-tls'],
      ['Anyone who can reach netatlas.example.com sees every cluster\'s policies. netatlas has no login of its own, so protect this ingress. Apply sends a Kubernetes token: serve it over TLS only.'],
    ],
  ])('notes for %s give the port-forward line and the ingress warnings', (_name, args, warnings) => {
    const run = helm('install', [...CI_VALUES, ...args, '--dry-run=client']);
    const notes = run.stdout.slice(run.stdout.indexOf('NOTES:') + 'NOTES:'.length).trim().split('\n').filter((l) => l !== '');

    expect([run.status, notes]).toStrictEqual([0, ['Open netatlas on http://localhost:3000 after:', '  kubectl port-forward --namespace default service/t 3000:80', ...warnings]]);
  });
});
