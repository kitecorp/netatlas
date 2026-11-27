import { ApiException } from '@kubernetes/client-node';
import { CANNOT_APPLY } from '@/model/format';
import type { NetworkPolicyObject, NetworkPolicySpec } from '@/model/types';
import type { ClusterConfig } from './registry';
import { trimPolicy } from './sources/trim';
import type { ClusterEntry } from './store';

// Apply is the one write netatlas makes. It writes with the person's own token, which lives only in
// this request: it is never logged, stored, or put in an answer, and a Kubernetes message that
// repeats it has it replaced.

export interface ApplyRequest {
  token: string;
  resourceVersion: string;
  spec: NetworkPolicySpec;
}

export interface ApplyTarget {
  cluster: string;
  namespace: string;
  name: string;
}

export interface ApplyDeps {
  cluster(name: string): ClusterEntry | undefined;
  replace(c: ClusterConfig, token: string, body: NetworkPolicyObject): Promise<NetworkPolicyObject>;
  log(line: string): void;
}

type ApplyRefusal = { status: 400 | 401 | 403 | 404 | 409 | 422 | 503; message: string };
export type ApplyResult = { status: 200; policy: NetworkPolicyObject } | ApplyRefusal;

const TYPE = { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy' };
/** aws-iam-authenticator refuses longer tokens, and no other Kubernetes token comes near it. */
const LONGEST_TOKEN_BYTES = 16_384;
/** What an Authorization header can carry; anything else would fail in the request, after the checks. */
const TOKEN_CHARACTERS = /^[\x21-\x7e]+$/;

const MALFORMED = 'The request needs a token, a resourceVersion and a spec.';
const TOO_LONG = 'The token is longer than any Kubernetes token.';
const GONE = 'This policy is no longer in the cluster.';
const CHANGED = "The policy changed in the cluster after you opened it, so nothing was written. Copy your YAML, then reload to start from the cluster's version.";
const NOT_JSON = 'netatlas takes the policy as application/json.';
/** Used when a refusal carries no Status message. */
const REASONS: Record<number, string> = { 400: 'Bad Request', 403: 'Forbidden', 422: 'Unprocessable Entity' };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Checks the whole body before anything is written. A pasted token keeps its trailing newline, so it is trimmed. */
export function parseApplyRequest(body: unknown): ApplyRequest | { status: 400; message: string } {
  if (!isRecord(body)) return { status: 400, message: MALFORMED };
  const { token, resourceVersion, spec } = body;
  const trimmed = typeof token === 'string' ? token.trim() : '';
  if (Buffer.byteLength(trimmed, 'utf8') > LONGEST_TOKEN_BYTES) return { status: 400, message: TOO_LONG };
  if (!TOKEN_CHARACTERS.test(trimmed)) return { status: 400, message: MALFORMED };
  if (typeof resourceVersion !== 'string' || resourceVersion === '') return { status: 400, message: MALFORMED };
  if (!isRecord(spec) || !isRecord(spec.podSelector)) return { status: 400, message: MALFORMED };
  return { token: trimmed, resourceVersion, spec: spec as NetworkPolicySpec };
}

/** The `message` of the V1Status Kubernetes sends with a refusal, which client-node keeps as text in the body. */
function statusMessage(body: unknown): string | undefined {
  try {
    const parsed: unknown = typeof body === 'string' ? JSON.parse(body) : body;
    return isRecord(parsed) && typeof parsed.message === 'string' && parsed.message !== '' ? parsed.message : undefined;
  } catch {
    return undefined;
  }
}

/** What Kubernetes' answer means for the person; an error that is not an answer is a cluster netatlas cannot reach. */
function refusal(err: unknown, cluster: string, token: string): ApplyRefusal {
  if (!(err instanceof ApiException)) return { status: 503, message: CANNOT_APPLY };
  const code: number = err.code;
  switch (code) {
    case 401:
      return { status: 401, message: `Kubernetes did not accept this token. Check that it is for ${cluster} and has not expired.` };
    case 404:
      return { status: 404, message: GONE };
    case 409:
      return { status: 409, message: CHANGED };
    case 400:
    case 403:
    case 422: {
      const message = (statusMessage(err.body) ?? REASONS[code] ?? '').split(token).join('[token]');
      return { status: code, message: `Kubernetes refused the change: ${message}` };
    }
    default:
      return { status: 503, message: CANNOT_APPLY };
  }
}

async function decide(t: ApplyTarget, req: ApplyRequest, deps: ApplyDeps): Promise<ApplyResult> {
  const entry = deps.cluster(t.cluster);
  if (!entry) return { status: 404, message: `netatlas does not know a cluster named ${t.cluster}.` };
  if (entry.status.state !== 'reachable') return { status: 503, message: CANNOT_APPLY };
  const current = entry.resources?.networkPolicies.find((p) => p.metadata.namespace === t.namespace && p.metadata.name === t.name);
  if (!current) return { status: 404, message: GONE };
  if (current.metadata.resourceVersion !== req.resourceVersion) return { status: 409, message: CHANGED };
  // Everything the cluster holds stays, the fields the editor never models among them; only the spec
  // changes, and the draft's resourceVersion makes Kubernetes refuse the write if the policy moved on.
  const kept = trimPolicy(current, TYPE);
  const body: NetworkPolicyObject = { ...kept, metadata: { ...kept.metadata, resourceVersion: req.resourceVersion }, spec: req.spec };
  try {
    return { status: 200, policy: trimPolicy(await deps.replace(entry.config, req.token, body), TYPE) };
  } catch (err) {
    return refusal(err, t.cluster, req.token);
  }
}

// The names come from the URL, which Next.js decodes, so they are written as JSON: a newline in one
// stays escaped and cannot start a line that looks like another Apply.
const logLine = (t: ApplyTarget, status: number) => `apply ${JSON.stringify({ cluster: t.cluster, namespace: t.namespace, name: t.name, status })}`;

/** Replaces one NetworkPolicy with the person's token, and never one that changed since the draft began. */
export async function applyPolicy(t: ApplyTarget, req: ApplyRequest, deps: ApplyDeps): Promise<ApplyResult> {
  const result = await decide(t, req, deps);
  deps.log(logLine(t, result.status));
  return result;
}

/** The route's answer: `{ policy }` on 200, `{ message }` otherwise, which the editor reads. The body is never logged. */
export async function applyResponse(request: Request, t: ApplyTarget, deps: ApplyDeps): Promise<Response> {
  const refuse = (r: { status: 400 | 415; message: string }) => {
    deps.log(logLine(t, r.status));
    return Response.json({ message: r.message }, { status: r.status });
  };
  const mediaType = (request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') return refuse({ status: 415, message: NOT_JSON });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return refuse({ status: 400, message: MALFORMED });
  }
  const req = parseApplyRequest(body);
  if ('status' in req) return refuse(req);
  const result = await applyPolicy(t, req, deps);
  return result.status === 200
    ? Response.json({ policy: result.policy }, { status: 200 })
    : Response.json({ message: result.message }, { status: result.status });
}
