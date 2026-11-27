export type ClusterStatus =
  | { readonly state: 'connecting' }
  | { readonly state: 'reachable'; readonly since: Date; readonly lastSeen: Date; readonly kubernetesVersion: string }
  | { readonly state: 'unreachable'; readonly since: Date; readonly reason: string; readonly lastSeen?: Date };

export type ProbeEvent =
  | { readonly type: 'ok'; readonly at: Date; readonly kubernetesVersion: string }
  | { readonly type: 'failed'; readonly at: Date; readonly reason: string };

export const PROBE_INTERVAL_MS = 15_000;
export const PROBE_TIMEOUT_MS = 5_000;
/** The code of the error a probe fails with when the API server takes the connection but never answers. */
export const PROBE_TIMEOUT_CODE = 'ProbeTimeout';

const FIRST_RETRY_MS = 5_000;
const LONGEST_RETRY_MS = 300_000;

export function reduceStatus(s: ClusterStatus, e: ProbeEvent): ClusterStatus {
  if (e.type === 'ok') {
    if (s.state === 'reachable') return { ...s, lastSeen: e.at, kubernetesVersion: e.kubernetesVersion };
    return { state: 'reachable', since: e.at, lastSeen: e.at, kubernetesVersion: e.kubernetesVersion };
  }
  if (s.state === 'unreachable') return { ...s, reason: e.reason };
  const lastSeen = s.state === 'reachable' ? { lastSeen: s.lastSeen } : {};
  return { state: 'unreachable', since: e.at, reason: e.reason, ...lastSeen };
}

/** The wait before retry number `attempt` (1 for the first retry after a failed probe). */
export function nextRetryDelay(attempt: number): number {
  return Math.min(FIRST_RETRY_MS * 2 ** (attempt - 1), LONGEST_RETRY_MS);
}

const REASONS: ReadonlyMap<unknown, string> = new Map<unknown, string>([
  ['ECONNREFUSED', 'the API server refused the connection'],
  ['ETIMEDOUT', 'the API server stopped answering'],
  ['EHOSTUNREACH', 'the API server stopped answering'],
  [PROBE_TIMEOUT_CODE, 'the API server stopped answering'],
  ['ENOTFOUND', 'its address could not be resolved'],
  ['SELF_SIGNED_CERT_IN_CHAIN', "the API server's certificate was not accepted"],
  ['ERR_TLS_CERT_ALTNAME_INVALID', "the API server's certificate was not accepted"],
  // A wrong CA against a server that sends only its own certificate, a self-signed one, or an old one.
  ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', "the API server's certificate was not accepted"],
  ['DEPTH_ZERO_SELF_SIGNED_CERT', "the API server's certificate was not accepted"],
  ['CERT_HAS_EXPIRED', "the API server's certificate was not accepted"],
  [401, "the API server did not accept netatlas's login"],
  [403, "netatlas's login may not read this cluster"],
]);

const codeOf = (v: unknown): unknown => (typeof v === 'object' && v !== null ? (v as { code?: unknown }).code : undefined);

/**
 * The sentence the overview shows for a failed probe. Node's socket errors carry `code` (fetch wraps
 * them as the `cause` of a TypeError), and client-node's ApiException carries the HTTP status as `code`.
 */
export function unreachableReason(err: unknown): string {
  const cause = typeof err === 'object' && err !== null ? (err as { cause?: unknown }).cause : undefined;
  for (const code of [codeOf(err), codeOf(cause)]) {
    const reason = REASONS.get(code);
    if (reason !== undefined) return reason;
  }
  return 'the API server could not be reached';
}
