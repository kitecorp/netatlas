/** The kinds netatlas reads, as `group/resource`: the direct source watches them and every reader role grants them. */
export const EXPECTED = ['/namespaces', '/pods', 'apps/daemonsets', 'apps/replicasets', 'batch/jobs', 'networking.k8s.io/networkpolicies', 'security.istio.io/authorizationpolicies'];

export interface Rule {
  apiGroups: string[];
  resources: string[];
  verbs: string[];
}

/** What a role's rules grant, one `[group/resource, verbs]` pair per kind, so a test compares them with EXPECTED. */
export const grants = (rules: Rule[]): [string, string[]][] =>
  rules.flatMap((r) => r.apiGroups.flatMap((g) => r.resources.map((res): [string, string[]] => [`${g}/${res}`, r.verbs])));

/** Every reader role grants each kind exactly these verbs: no write verb, and no kind beyond EXPECTED (so no Secrets). */
export const READ_ONLY: [string, string[]][] = EXPECTED.map((k) => [k, ['get', 'list', 'watch']]);
