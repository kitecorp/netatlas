/** The kinds netatlas reads, as `group/resource`: the direct source watches them and every reader role grants them. */
export const EXPECTED = [
  '/namespaces',
  '/pods',
  'apps/daemonsets',
  'apps/replicasets',
  'batch/jobs',
  'networking.istio.io/serviceentries',
  'networking.istio.io/sidecars',
  'networking.k8s.io/networkpolicies',
  'security.istio.io/authorizationpolicies',
];

export interface Rule {
  apiGroups: string[];
  resources: string[];
  resourceNames?: string[];
  verbs: string[];
}

/** What a role's rules grant, one `[group/resource, verbs, resourceNames]` triple per kind, so a test compares them with READ_ONLY. */
export const grants = (rules: Rule[]): [string, string[], string[]][] =>
  rules.flatMap((r) => r.apiGroups.flatMap((g) => r.resources.map((res): [string, string[], string[]] => [`${g}/${res}`, r.verbs, r.resourceNames ?? []])));

/** The objects every reader role may read by name only: the mesh config, the ConfigMap `istio`. */
export const NAMED: [string, string[], string[]][] = [['/configmaps', ['get', 'list', 'watch'], ['istio']]];

/**
 * Every reader role grants exactly these, in its rules' order: no write verb, the ConfigMap `istio` by
 * name, and no kind beyond EXPECTED (so no Secrets and no other ConfigMap).
 */
export const READ_ONLY: [string, string[], string[]][] = [...NAMED, ...EXPECTED.map((k): [string, string[], string[]] => [k, ['get', 'list', 'watch'], []])];
