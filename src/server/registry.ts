import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse } from 'yaml';
import { isRecord } from '@/model/is-record';

export type Login =
  | { type: 'inCluster' }
  | { type: 'token'; tokenFile: string }
  | { type: 'eks'; clusterName: string; region: string };

export type PrometheusAuth = { type: 'none' } | { type: 'bearer'; tokenFile: string } | { type: 'basic'; usernameFile: string; passwordFile: string };

/** The Prometheus that holds a cluster's Istio metrics, and how netatlas reads it. */
export interface PrometheusConfig {
  url: string;
  auth: PrometheusAuth;
  ca?: { file: string } | { data: string };
  clusterLabel?: { name: string; value: string };
}

export interface ClusterConfig {
  name: string;
  server?: string;
  ca?: { file: string } | { data: string };
  login: Login;
  istio: { rootNamespace: string; trustDomain: string };
  prometheus?: PrometheusConfig;
  clusterDomain?: string;
}

export const DEFAULT_CLUSTER_DOMAIN = 'cluster.local';

/** The DNS domain the cluster's service hosts end in. */
export function clusterDomainOf(c: ClusterConfig): string {
  return c.clusterDomain ?? DEFAULT_CLUSTER_DOMAIN;
}

export interface Registry {
  clusters: ClusterConfig[];
}

export class RegistryError extends Error {
  override name = 'RegistryError';
}

const DEFAULT_FILE = '/etc/netatlas/clusters.yaml';
const ISTIO_DEFAULTS = { rootNamespace: 'istio-system', trustDomain: 'cluster.local' };
// The name appears in URLs, so it must be a DNS label, which is also what a namespace's name is.
const NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;
const LOGIN_TYPES = ['inCluster', 'token', 'eks'];
const PROMETHEUS_AUTH_TYPES = ['none', 'bearer', 'basic'];
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
// A lowercase DNS subdomain, as Kubernetes names a cluster's domain.
const DNS_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/** One entry of `clusters:` as written, before any check has run. */
interface RawCluster {
  name: string;
  server: unknown;
  caFile: unknown;
  caData: unknown;
  login: Record<string, unknown>;
  istio: Record<string, unknown>;
  clusterDomain: unknown;
  /** Undefined when the entry names no Prometheus. */
  prometheus: RawPrometheus | undefined;
}

interface RawPrometheus {
  url: unknown;
  /** Undefined when the entry gives no auth, which means none. */
  auth: Record<string, unknown> | undefined;
  caFile: unknown;
  caData: unknown;
  /** Undefined when the entry gives no clusterLabel. */
  clusterLabel: Record<string, unknown> | undefined;
}

const record = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});
const text = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const present = (v: unknown) => v !== undefined && v !== null && v !== '';

function fail(message: string): never {
  throw new RegistryError(`registry: ${message}`);
}

/**
 * Each check runs over every cluster before the next one starts, so a file with several faults
 * always reports the first fault in this order, whichever cluster carries it.
 */
const CHECKS: ((clusters: RawCluster[]) => void)[] = [
  (all) => {
    if (all.length === 0) fail('no clusters are listed');
  },
  (all) => {
    const seen = new Set<string>();
    for (const c of all) {
      if (seen.has(c.name)) fail(`cluster name "${c.name}" appears twice`);
      seen.add(c.name);
    }
  },
  (all) => {
    for (const c of all)
      if (!NAME.test(c.name)) fail(`cluster name "${c.name}" must be 1 to 63 lowercase letters, digits or dashes`);
  },
  (all) => {
    for (const c of remote(all)) if (!present(c.server)) fail(`cluster "${c.name}" needs a server`);
  },
  (all) => {
    for (const c of remote(all))
      if (!text(c.server).startsWith('https://')) fail(`cluster "${c.name}" server must start with https://`);
  },
  (all) => {
    for (const c of remote(all))
      if (!present(c.caFile) && !present(c.caData)) fail(`cluster "${c.name}" needs caFile or caData`);
  },
  (all) => {
    for (const c of remote(all))
      if (present(c.caFile) && present(c.caData)) fail(`cluster "${c.name}" has both caFile and caData`);
  },
  (all) => {
    if (all.filter(inCluster).length > 1) fail('only one cluster can use inCluster login');
  },
  (all) => {
    for (const c of all.filter(inCluster))
      if (present(c.server) || present(c.caFile) || present(c.caData))
        fail(`cluster "${c.name}" uses inCluster login, so it takes no server or CA`);
  },
  (all) => {
    for (const c of all.filter((c) => c.login.type === 'eks')) {
      const region = text(c.login.region);
      if (!REGION.test(region)) fail(`cluster "${c.name}" region "${region}" is not an AWS region name`);
    }
  },
  (all) => {
    for (const c of all) {
      const type = text(c.login.type);
      if (!LOGIN_TYPES.includes(type)) fail(`cluster "${c.name}" login type "${type}" is not inCluster, token or eks`);
    }
  },
  (all) => {
    for (const c of all) {
      if (c.login.type === 'token' && !present(c.login.tokenFile)) fail(`cluster "${c.name}" token login needs tokenFile`);
      if (c.login.type === 'eks' && !present(c.login.clusterName)) fail(`cluster "${c.name}" eks login needs clusterName`);
    }
  },
  (all) => {
    for (const [c, p] of prometheuses(all)) if (!present(p.url)) fail(`cluster "${c.name}" prometheus needs a url`);
  },
  (all) => {
    for (const [c, p] of prometheuses(all))
      if (!/^https?:\/\//.test(text(p.url))) fail(`cluster "${c.name}" prometheus url must start with http:// or https://`);
  },
  (all) => {
    // A URL can pass the scheme check and still not parse (a port above 65535). The message leaves the
    // URL out, because a URL that does not parse may still carry a password.
    for (const [c, p] of prometheuses(all)) if (!URL.canParse(text(p.url))) fail(`cluster "${c.name}" prometheus url is not a URL netatlas can read`);
  },
  (all) => {
    for (const [c, p] of prometheuses(all))
      if (carriesUserinfo(text(p.url)))
        fail(`cluster "${c.name}" prometheus url must not carry a user or password: use auth basic with a Secret`);
  },
  (all) => {
    for (const [c, p] of prometheuses(all)) {
      const type = authType(p);
      if (!PROMETHEUS_AUTH_TYPES.includes(type)) fail(`cluster "${c.name}" prometheus auth type "${type}" is not none, bearer or basic`);
    }
  },
  (all) => {
    for (const [c, p] of prometheuses(all)) {
      const type = authType(p);
      if (type === 'bearer' && !present(p.auth?.tokenFile)) fail(`cluster "${c.name}" prometheus bearer auth needs tokenFile`);
      if (type === 'basic' && !(present(p.auth?.usernameFile) && present(p.auth?.passwordFile)))
        fail(`cluster "${c.name}" prometheus basic auth needs usernameFile and passwordFile`);
    }
  },
  (all) => {
    for (const [c, p] of prometheuses(all))
      if (present(p.caFile) && present(p.caData)) fail(`cluster "${c.name}" prometheus has both caFile and caData`);
  },
  (all) => {
    for (const [c, p] of prometheuses(all))
      if (p.clusterLabel && !(present(p.clusterLabel.name) && present(p.clusterLabel.value)))
        fail(`cluster "${c.name}" prometheus clusterLabel needs a name and a value`);
  },
  (all) => {
    for (const [c, p] of prometheuses(all)) {
      const name = text(p.clusterLabel?.name);
      if (p.clusterLabel && !LABEL_NAME.test(name)) fail(`cluster "${c.name}" prometheus clusterLabel name "${name}" is not a Prometheus label name`);
    }
  },
  (all) => {
    for (const c of all) {
      const domain = text(c.clusterDomain);
      if (present(c.clusterDomain) && !DNS_NAME.test(domain)) fail(`cluster "${c.name}" clusterDomain "${domain}" is not a DNS name`);
    }
  },
  // The root namespace goes into the path of the request for the mesh config.
  (all) => {
    for (const c of all) {
      const namespace = text(c.istio.rootNamespace);
      if (present(c.istio.rootNamespace) && !NAME.test(namespace)) fail(`cluster "${c.name}" istio rootNamespace "${namespace}" is not a namespace name`);
    }
  },
];

function inCluster(c: RawCluster) {
  return c.login.type === 'inCluster';
}

function remote(all: RawCluster[]) {
  return all.filter((c) => !inCluster(c));
}

/** The clusters that name a Prometheus, each with it. */
function prometheuses(all: RawCluster[]): [RawCluster, RawPrometheus][] {
  return all.flatMap((c): [RawCluster, RawPrometheus][] => (c.prometheus ? [[c, c.prometheus]] : []));
}

/** An entry without auth reads Prometheus with no credentials. */
function authType(p: RawPrometheus) {
  return p.auth ? text(p.auth.type) : 'none';
}

/**
 * Node's http.request sends a URL's user and password as a Basic Authorization header, so they would
 * come from the ConfigMap instead of a mounted Secret. The check before this one has already refused a
 * URL that does not parse.
 */
function carriesUserinfo(url: string) {
  const parsed = new URL(url);
  return parsed.username !== '' || parsed.password !== '';
}

function toConfig(c: RawCluster, baseDir: string): ClusterConfig {
  const file = (v: unknown) => resolve(/* turbopackIgnore: true */ baseDir, text(v));
  const ca = (caFile: unknown, caData: unknown) => (present(caFile) ? { file: file(caFile) } : { data: text(caData) });
  const login: Login =
    c.login.type === 'inCluster'
      ? { type: 'inCluster' }
      : c.login.type === 'token'
        ? { type: 'token', tokenFile: file(c.login.tokenFile) }
        : { type: 'eks', clusterName: text(c.login.clusterName), region: text(c.login.region) };
  const istio = {
    rootNamespace: present(c.istio.rootNamespace) ? text(c.istio.rootNamespace) : ISTIO_DEFAULTS.rootNamespace,
    trustDomain: present(c.istio.trustDomain) ? text(c.istio.trustDomain) : ISTIO_DEFAULTS.trustDomain,
  };
  const p = c.prometheus;
  const auth = (a: Record<string, unknown> | undefined): PrometheusAuth =>
    a?.type === 'bearer'
      ? { type: 'bearer', tokenFile: file(a.tokenFile) }
      : a?.type === 'basic'
        ? { type: 'basic', usernameFile: file(a.usernameFile), passwordFile: file(a.passwordFile) }
        : { type: 'none' };
  const prometheus: PrometheusConfig | undefined = p && {
    url: text(p.url),
    auth: auth(p.auth),
    ...((present(p.caFile) || present(p.caData)) && { ca: ca(p.caFile, p.caData) }),
    ...(p.clusterLabel && { clusterLabel: { name: text(p.clusterLabel.name), value: text(p.clusterLabel.value) } }),
  };
  // Absent keys, not undefined ones, when the entry leaves them out; clusterDomainOf supplies the
  // default domain.
  const optional = {
    ...(prometheus && { prometheus }),
    ...(present(c.clusterDomain) && { clusterDomain: text(c.clusterDomain) }),
  };
  if (login.type === 'inCluster') return { name: c.name, login, istio, ...optional };
  return { name: c.name, server: text(c.server), ca: ca(c.caFile, c.caData), login, istio, ...optional };
}

function rawPrometheus(p: Record<string, unknown>): RawPrometheus {
  return {
    url: p.url,
    auth: present(p.auth) ? record(p.auth) : undefined,
    caFile: p.caFile,
    caData: p.caData,
    clusterLabel: present(p.clusterLabel) ? record(p.clusterLabel) : undefined,
  };
}

/** Reads the registry file's text. Relative caFile, tokenFile, usernameFile and passwordFile paths resolve against `baseDir`. */
export function parseRegistry(source: string, baseDir: string): Registry {
  const listed: unknown = record(parse(source)).clusters;
  const raw: RawCluster[] = (Array.isArray(listed) ? listed : []).map((entry) => {
    const c = record(entry);
    return {
      name: text(c.name),
      server: c.server,
      caFile: c.caFile,
      caData: c.caData,
      login: record(c.login),
      istio: record(c.istio),
      clusterDomain: c.clusterDomain,
      prometheus: present(c.prometheus) ? rawPrometheus(record(c.prometheus)) : undefined,
    };
  });
  for (const check of CHECKS) check(raw);
  return { clusters: raw.map((c) => toConfig(c, baseDir)) };
}

/** Reads the registry from `path`, else NETATLAS_CLUSTERS_FILE, else the chart's mount point. */
export function loadRegistry(path?: string): Registry {
  // The file is mounted at run time, so the build must not trace it: without the turbopackIgnore
  // comments here and in toConfig, Turbopack copies the whole project into .next/standalone.
  const file = resolve(/* turbopackIgnore: true */ path ?? (process.env.NETATLAS_CLUSTERS_FILE || DEFAULT_FILE));
  return parseRegistry(readFileSync(/* turbopackIgnore: true */ file, 'utf8'), dirname(file));
}
