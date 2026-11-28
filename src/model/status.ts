/** Whether a source answers: `V` is what a reachable one also reports (a cluster its Kubernetes version). */
export type SourceStatus<V extends object = object> =
  | { readonly state: 'connecting' }
  | ({ readonly state: 'reachable'; readonly since: Date; readonly lastSeen: Date } & Readonly<V>)
  | { readonly state: 'unreachable'; readonly since: Date; readonly reason: string; readonly lastSeen?: Date };

export type ClusterStatus = SourceStatus<{ readonly kubernetesVersion: string }>;

export type ProbeEvent<V extends object = { readonly kubernetesVersion: string }> =
  | ({ readonly type: 'ok'; readonly at: Date } & Readonly<V>)
  | { readonly type: 'failed'; readonly at: Date; readonly reason: string };

export const PROBE_INTERVAL_MS = 15_000;
export const PROBE_TIMEOUT_MS = 5_000;
/** The code of the error a probe fails with when the API server takes the connection but never answers. */
export const PROBE_TIMEOUT_CODE = 'ProbeTimeout';
/** The code of the error netatlas throws, before it connects, for a token file whose token no header can carry. */
export const UNCARRIABLE_TOKEN_CODE = 'ERR_UNCARRIABLE_TOKEN';

const FIRST_RETRY_MS = 5_000;
const LONGEST_RETRY_MS = 300_000;

/** Moves a source's status by one probe. What an `ok` reports besides its time (`V`) replaces the last report. */
export function reduceStatus<V extends object>(s: SourceStatus<V>, e: ProbeEvent<V>): SourceStatus<V> {
  if (e.type === 'ok') {
    const { type: _ok, at, ...reported } = e;
    if (s.state === 'reachable') return { ...s, ...reported, lastSeen: at };
    return { state: 'reachable', since: at, lastSeen: at, ...reported };
  }
  if (s.state === 'unreachable') return { ...s, reason: e.reason };
  const lastSeen = s.state === 'reachable' ? { lastSeen: s.lastSeen } : {};
  return { state: 'unreachable', since: e.at, reason: e.reason, ...lastSeen };
}

/** The wait before retry number `attempt` (1 for the first retry after a failed probe). */
export function nextRetryDelay(attempt: number): number {
  return Math.min(FIRST_RETRY_MS * 2 ** (attempt - 1), LONGEST_RETRY_MS);
}

/** A failed probe's sentence, built from what was asked: the API server, or Prometheus. */
type Reason = (who: string) => string;
const API_SERVER = 'the API server';
const refused: Reason = (who) => `${who} refused the connection`;
const stopped: Reason = (who) => `${who} stopped answering`;
const notAccepted: Reason = (who) => `${who}'s certificate was not accepted`;
// The cluster's sentence follows the cluster's name ("Unreachable since 10:00: its address ..."), so
// "its" is the cluster. After "Traffic unavailable since 10:00:" it would read as the traffic, so any
// other `who` is named.
const unresolved: Reason = (who) => (who === API_SERVER ? 'its address could not be resolved' : `the address of ${who} could not be resolved`);

const REASONS: ReadonlyMap<unknown, Reason> = new Map<unknown, Reason>([
  ['ECONNREFUSED', refused],
  ['ETIMEDOUT', stopped],
  ['EHOSTUNREACH', stopped],
  [PROBE_TIMEOUT_CODE, stopped],
  ['ENOTFOUND', unresolved],
  ['SELF_SIGNED_CERT_IN_CHAIN', notAccepted],
  ['ERR_TLS_CERT_ALTNAME_INVALID', notAccepted],
  // A wrong CA against a server that sends only its own certificate, a self-signed one, or an old one.
  ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', notAccepted],
  ['DEPTH_ZERO_SELF_SIGNED_CERT', notAccepted],
  ['CERT_HAS_EXPIRED', notAccepted],
  // HTTP statuses as client-node reports them; Prometheus's are read from its answer instead.
  [401, () => "the API server did not accept netatlas's login"],
  [403, () => "netatlas's login may not read this cluster"],
  // A fixed sentence: netatlas sends no such token, and the sentence holds no part of it.
  [UNCARRIABLE_TOKEN_CODE, () => "netatlas's token file holds a character an Authorization header cannot carry"],
]);

/** An error's `code`, as Node's socket errors and client-node's ApiException carry it. */
export const codeOf = (v: unknown): unknown => (typeof v === 'object' && v !== null ? (v as { code?: unknown }).code : undefined);

/**
 * The sentence the overview shows for a failed probe of `who`. Node's socket errors carry `code`
 * (fetch wraps them as the `cause` of a TypeError), and client-node's ApiException carries the HTTP
 * status as `code`.
 */
export function unreachableReason(err: unknown, who = API_SERVER): string {
  const cause = typeof err === 'object' && err !== null ? (err as { cause?: unknown }).cause : undefined;
  for (const code of [codeOf(err), codeOf(cause)]) {
    const reason = REASONS.get(code);
    if (reason !== undefined) return reason(who);
  }
  return `${who} could not be reached`;
}
