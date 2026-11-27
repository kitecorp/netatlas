import { ApiException } from '@kubernetes/client-node';
import { describe, expect, it } from 'vitest';
import { SHOP } from '@/model/fixtures/shop';
import type { ClusterStatus } from '@/model/status';
import type { NetworkPolicyObject, NetworkPolicySpec } from '@/model/types';
import { applyPolicy, applyResponse, parseApplyRequest, type ApplyDeps, type ApplyRequest } from './apply';
import type { ClusterEntry } from './store';

const istio = { rootNamespace: 'istio-system', trustDomain: 'cluster.local' };
const target = { cluster: 'atlas-a', namespace: 'shop', name: 'cart-allow' };
const spec: NetworkPolicySpec = { podSelector: { matchLabels: { app: 'cart' } }, policyTypes: ['Ingress'], ingress: [{ from: [{ podSelector: { matchLabels: { app: 'frontend' } } }] }] };
const request = (over: Partial<ApplyRequest> = {}): ApplyRequest => ({ token: 'person-token', resourceVersion: '41', spec, ...over });

const REACHABLE: ClusterStatus = { state: 'reachable', since: new Date('2026-11-27T10:00:00Z'), lastSeen: new Date('2026-11-27T10:05:00Z'), kubernetesVersion: 'v1.37.0' };

/** What the store keeps of cart-allow's metadata, every field of it the editor never models. */
const KEPT = {
  name: 'cart-allow',
  namespace: 'shop',
  uid: '6f1c2d3e-0000-4000-8000-000000000001',
  resourceVersion: '41',
  generation: 3,
  creationTimestamp: '2026-11-01T09:00:00Z',
  labels: { team: 'shop' },
  annotations: { 'netatlas.example/owner': 'cart-team' },
};

/** cart-allow as the cluster sends it, with managedFields and status. */
const stored = (resourceVersion = '41'): NetworkPolicyObject => ({
  apiVersion: 'networking.k8s.io/v1',
  kind: 'NetworkPolicy',
  metadata: { ...KEPT, resourceVersion, managedFields: [{ manager: 'kubectl', operation: 'Apply' }] },
  spec: { podSelector: { matchLabels: { app: 'cart' } }, policyTypes: ['Ingress', 'Egress'] },
  status: { conditions: [] },
});

const entry = (status: ClusterStatus = REACHABLE, policy: NetworkPolicyObject = stored()): ClusterEntry => ({
  config: { name: 'atlas-a', login: { type: 'inCluster' }, istio },
  status,
  resources: { ...SHOP, networkPolicies: [policy] },
  syncedAt: new Date('2026-11-27T10:05:00Z'),
  synced: true,
});

const v1Status = (code: number, message: string) => JSON.stringify({ kind: 'Status', apiVersion: 'v1', status: 'Failure', message, reason: 'Forbidden', code });
const apiError = (code: number, message?: string) =>
  new ApiException(code, code === 401 ? 'Unauthorized' : 'Unknown API Status Code!', message === undefined ? undefined : v1Status(code, message), {});

/** A recording fake for the one write: what it was sent, and what it answers or throws. */
function fake(opts: { entry?: ClusterEntry; fails?: unknown } = {}) {
  const calls: { cluster: string; token: string; body: NetworkPolicyObject }[] = [];
  const log: string[] = [];
  const deps: ApplyDeps = {
    cluster: (name) => (name === 'atlas-a' ? (opts.entry ?? entry()) : undefined),
    async replace(c, token, body) {
      calls.push({ cluster: c.name, token, body });
      if (opts.fails !== undefined) throw opts.fails;
      return { ...body, metadata: { ...body.metadata, resourceVersion: '43', managedFields: [{ manager: 'netatlas' }] }, status: {} };
    },
    log: (line) => log.push(line),
  };
  return { deps, calls, log };
}

const CHANGED = "The policy changed in the cluster after you opened it, so nothing was written. Copy your YAML, then reload to start from the cluster's version.";
const MALFORMED = 'The request needs a token, a resourceVersion and a spec.';
const TOO_LONG = 'The token is longer than any Kubernetes token.';
const UNREACHABLE = 'netatlas cannot reach this cluster now, so it cannot apply. Copy YAML still works.';
const FORBIDDEN =
  'networkpolicies.networking.k8s.io "cart-allow" is forbidden: User "system:serviceaccount:shop:policy-reader" cannot update resource "networkpolicies" in API group "networking.k8s.io" in the namespace "shop"';

describe('parseApplyRequest', () => {
  it('accepts a pasted token with its trailing newline', () => {
    expect(parseApplyRequest({ token: 'eyJ.abc\n', resourceVersion: '41', spec })).toStrictEqual({ token: 'eyJ.abc', resourceVersion: '41', spec });
  });

  it.each<[string, unknown, { status: 400; message: string } | ApplyRequest]>([
    ['a 16 384-byte token, the longest there is', { token: `${'a'.repeat(16_384)}\n`, resourceVersion: '41', spec }, { token: 'a'.repeat(16_384), resourceVersion: '41', spec }],
    ['a 16 385-byte token', { token: 'a'.repeat(16_385), resourceVersion: '41', spec }, { status: 400, message: TOO_LONG }],
    ['no body', null, { status: 400, message: MALFORMED }],
    ['a body that is not an object', 'token', { status: 400, message: MALFORMED }],
    ['no token', { resourceVersion: '41', spec }, { status: 400, message: MALFORMED }],
    ['a token of only white space', { token: ' \n', resourceVersion: '41', spec }, { status: 400, message: MALFORMED }],
    ['a token that is not text', { token: 42, resourceVersion: '41', spec }, { status: 400, message: MALFORMED }],
    ['a token with a space inside, which no header carries', { token: 'eyJ abc', resourceVersion: '41', spec }, { status: 400, message: MALFORMED }],
    ['no resourceVersion', { token: 't', spec }, { status: 400, message: MALFORMED }],
    ['an empty resourceVersion', { token: 't', resourceVersion: '', spec }, { status: 400, message: MALFORMED }],
    ['no spec', { token: 't', resourceVersion: '41' }, { status: 400, message: MALFORMED }],
    ['a spec that is a list', { token: 't', resourceVersion: '41', spec: [] }, { status: 400, message: MALFORMED }],
    ['a spec without a podSelector', { token: 't', resourceVersion: '41', spec: { policyTypes: ['Ingress'] } }, { status: 400, message: MALFORMED }],
  ])('parses %s', (_name, body, expected) => {
    expect(parseApplyRequest(body)).toStrictEqual(expected);
  });
});

describe('applyPolicy', () => {
  it('writes nothing when the policy changed since the draft began', async () => {
    const { deps, calls } = fake({ entry: entry(REACHABLE, stored('42')) });

    expect([await applyPolicy(target, request({ resourceVersion: '41' }), deps), calls]).toStrictEqual([{ status: 409, message: CHANGED }, []]);
  });

  it("keeps the cluster's metadata and replaces only the spec", async () => {
    const { deps, calls } = fake();
    const newSpec: NetworkPolicySpec = { podSelector: { matchLabels: { app: 'cart' } }, policyTypes: ['Ingress'], ingress: [] };

    const result = await applyPolicy(target, request({ spec: newSpec }), deps);

    expect([calls, result]).toStrictEqual([
      [{ cluster: 'atlas-a', token: 'person-token', body: { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: KEPT, spec: newSpec } }],
      { status: 200, policy: { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: { ...KEPT, resourceVersion: '43' }, spec: newSpec } },
    ]);
  });

  it.each<[string, typeof target, ClusterEntry, { status: number; message: string }]>([
    ['a cluster netatlas does not know', { ...target, cluster: 'atlas-x' }, entry(), { status: 404, message: 'netatlas does not know a cluster named atlas-x.' }],
    ['an unreachable cluster', target, entry({ state: 'unreachable', since: new Date('2026-11-27T10:00:00Z'), reason: 'the API server refused the connection' }), { status: 503, message: UNREACHABLE }],
    ['a cluster netatlas has not reached yet', target, entry({ state: 'connecting' }), { status: 503, message: UNREACHABLE }],
    ['a policy no longer in the store', { ...target, name: 'cart-gone' }, entry(), { status: 404, message: 'This policy is no longer in the cluster.' }],
  ])('refuses before any write: %s', async (_name, t, e, expected) => {
    const { deps, calls } = fake({ entry: e });

    expect([await applyPolicy(t, request(), deps), calls.length]).toStrictEqual([expected, 0]);
  });

  it("shows Kubernetes' message when the token may not write", async () => {
    const { deps } = fake({ fails: apiError(403, FORBIDDEN) });

    expect(await applyPolicy(target, request(), deps)).toStrictEqual({ status: 403, message: `Kubernetes refused the change: ${FORBIDDEN}` });
  });

  it.each<[string, unknown, { status: number; message: string }]>([
    ['401', apiError(401), { status: 401, message: 'Kubernetes did not accept this token. Check that it is for atlas-a and has not expired.' }],
    ['409', apiError(409, 'Operation cannot be fulfilled on networkpolicies.networking.k8s.io "cart-allow": the object has been modified'), { status: 409, message: CHANGED }],
    ['404', apiError(404, 'networkpolicies.networking.k8s.io "cart-allow" not found'), { status: 404, message: 'This policy is no longer in the cluster.' }],
    ['422', apiError(422, 'NetworkPolicy.networking.k8s.io "cart-allow" is invalid: spec.ingress[0].ports[0].port: Invalid value: 70000'), { status: 422, message: 'Kubernetes refused the change: NetworkPolicy.networking.k8s.io "cart-allow" is invalid: spec.ingress[0].ports[0].port: Invalid value: 70000' }],
    ['400', apiError(400, 'the body of the request was in an unknown format'), { status: 400, message: 'Kubernetes refused the change: the body of the request was in an unknown format' }],
    ['500', apiError(500, 'etcdserver: request timed out'), { status: 503, message: UNREACHABLE }],
    ['a refused connection', Object.assign(new Error('connect ECONNREFUSED 10.96.0.1:443'), { code: 'ECONNREFUSED' }), { status: 503, message: UNREACHABLE }],
    ['a 403 whose body is not a Status', new ApiException(403, 'Unknown API Status Code!', '<html>forbidden</html>', {}), { status: 403, message: 'Kubernetes refused the change: Forbidden' }],
  ])("maps Kubernetes' answer %s", async (_name, error, expected) => {
    const { deps } = fake({ fails: error });

    expect(await applyPolicy(target, request(), deps)).toStrictEqual(expected);
  });

  it.each<[string, unknown, number]>([
    ['a write that succeeds', undefined, 200],
    ['a 403 whose message repeats the token', apiError(403, 'token SECRET-TOKEN-123 may not update networkpolicies'), 403],
    ['a 401', apiError(401), 401],
    ['a connection error that names the token', new Error('request with Bearer SECRET-TOKEN-123 failed'), 503],
  ])('never puts the token in a result or a log line: %s', async (_name, error, status) => {
    const { deps, calls, log } = fake({ fails: error });

    const result = await applyPolicy(target, request({ token: 'SECRET-TOKEN-123' }), deps);

    expect([result.status, log, calls.map((c) => c.token)]).toStrictEqual([status, [`apply ${JSON.stringify({ cluster: 'atlas-a', namespace: 'shop', name: 'cart-allow', status })}`], ['SECRET-TOKEN-123']]);
    expect(JSON.stringify(result).includes('SECRET-TOKEN-123')).toBe(false);
  });

  it('never puts the token in the message of a 403 that repeats it', async () => {
    const { deps } = fake({ fails: apiError(403, 'token SECRET-TOKEN-123 may not update networkpolicies') });

    expect(await applyPolicy(target, request({ token: 'SECRET-TOKEN-123' }), deps)).toStrictEqual({ status: 403, message: 'Kubernetes refused the change: token [token] may not update networkpolicies' });
  });
});

describe('applyResponse', () => {
  const put = (body: string, contentType = 'application/json') => new Request('http://netatlas.local/api/clusters/atlas-a/namespaces/shop/networkpolicies/cart-allow', { method: 'PUT', headers: { 'content-type': contentType }, body });

  it.each<[string, Request, unknown, number, unknown]>([
    ['a JSON body that applies', put(JSON.stringify({ token: 'person-token\n', resourceVersion: '41', spec })), undefined, 200, { policy: { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: { ...KEPT, resourceVersion: '43' }, spec } }],
    ['JSON with a charset', put(JSON.stringify({ token: 'person-token', resourceVersion: '41', spec }), 'application/json; charset=utf-8'), apiError(403, FORBIDDEN), 403, { message: `Kubernetes refused the change: ${FORBIDDEN}` }],
    ['a body that is not JSON', put('token=t'), undefined, 400, { message: MALFORMED }],
    ['a JSON body without a token, before any write', put(JSON.stringify({ resourceVersion: '41', spec })), undefined, 400, { message: MALFORMED }],
    ['a form', put('token=t', 'application/x-www-form-urlencoded'), undefined, 415, { message: 'netatlas takes the policy as application/json.' }],
  ])('answers %s', async (_name, req, fails, status, body) => {
    const { deps, calls, log } = fake({ fails });

    const res = await applyResponse(req, target, deps);

    expect([res.status, await res.json(), log, calls.length]).toStrictEqual([
      status,
      body,
      [`apply ${JSON.stringify({ cluster: 'atlas-a', namespace: 'shop', name: 'cart-allow', status })}`],
      status === 200 || status === 403 ? 1 : 0,
    ]);
  });
});

// Next.js decodes the path, so an encoded newline in it would otherwise start a forged line in the log.
it('keeps a name with a newline on one log line', async () => {
  const { deps, log } = fake({});
  const forged = { cluster: 'x: 404\napply atlas-a/shop/cart-allow: 200\napply y', namespace: 'z', name: 'w' };
  await applyResponse(new Request('http://netatlas.local/', { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: 'x' }), forged, deps);
  expect(log).toStrictEqual(['apply {"cluster":"x: 404\\napply atlas-a/shop/cart-allow: 200\\napply y","namespace":"z","name":"w","status":415}']);
});
