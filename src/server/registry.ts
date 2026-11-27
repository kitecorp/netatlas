import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse } from 'yaml';

export type Login =
  | { type: 'inCluster' }
  | { type: 'token'; tokenFile: string }
  | { type: 'eks'; clusterName: string; region: string };

export interface ClusterConfig {
  name: string;
  server?: string;
  ca?: { file: string } | { data: string };
  login: Login;
  istio: { rootNamespace: string; trustDomain: string };
}

export interface Registry {
  clusters: ClusterConfig[];
}

export class RegistryError extends Error {
  override name = 'RegistryError';
}

const DEFAULT_FILE = '/etc/netatlas/clusters.yaml';
const ISTIO_DEFAULTS = { rootNamespace: 'istio-system', trustDomain: 'cluster.local' };
// The name appears in URLs, so it must be a DNS label.
const NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;
const LOGIN_TYPES = ['inCluster', 'token', 'eks'];

/** One entry of `clusters:` as written, before any check has run. */
interface RawCluster {
  name: string;
  server: unknown;
  caFile: unknown;
  caData: unknown;
  login: Record<string, unknown>;
  istio: Record<string, unknown>;
}

const record = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
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
];

function inCluster(c: RawCluster) {
  return c.login.type === 'inCluster';
}

function remote(all: RawCluster[]) {
  return all.filter((c) => !inCluster(c));
}

function toConfig(c: RawCluster, baseDir: string): ClusterConfig {
  const file = (v: unknown) => resolve(/* turbopackIgnore: true */ baseDir, text(v));
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
  if (login.type === 'inCluster') return { name: c.name, login, istio };
  const ca = present(c.caFile) ? { file: file(c.caFile) } : { data: text(c.caData) };
  return { name: c.name, server: text(c.server), ca, login, istio };
}

/** Reads the registry file's text. Relative caFile and tokenFile paths resolve against `baseDir`. */
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
