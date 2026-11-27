import { createServer } from 'node:http';
import { ApiException, KubeConfig } from '@kubernetes/client-node';
import { afterEach, expect, it } from 'vitest';
import type { NetworkPolicyObject } from '@/model/types';
import { replacePolicy } from './replace-policy';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

interface Received {
  method: string;
  path: string;
  body: unknown;
}

/** An API server that records each request and answers with `status` and the body it was sent. */
async function fakeApiServer(status: number, received: Received[]): Promise<KubeConfig> {
  const server = createServer((req, res) => {
    let text = '';
    req.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
    req.on('end', () => {
      received.push({ method: req.method ?? '', path: req.url ?? '', body: JSON.parse(text) });
      const answer = status === 200 ? text : JSON.stringify({ kind: 'Status', apiVersion: 'v1', status: 'Failure', reason: 'Conflict', code: status, message: 'the object has been modified' });
      res.writeHead(status, { 'content-type': 'application/json' }).end(answer);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const kc = new KubeConfig();
  // client-node speaks plain HTTP only with TLS verification off; the fake server has no TLS to verify.
  kc.loadFromClusterAndUser({ name: 'shop', server: `http://127.0.0.1:${(server.address() as { port: number }).port}`, skipTLSVerify: true }, { name: 'shop', token: 'person-token' });
  return kc;
}

/** cart-allow with a spec field no client-node model knows, as a newer Kubernetes could add. */
const policy = {
  apiVersion: 'networking.k8s.io/v1',
  kind: 'NetworkPolicy',
  metadata: { name: 'cart-allow', namespace: 'shop', resourceVersion: '41' },
  spec: { podSelector: { matchLabels: { app: 'cart' } }, policyTypes: ['Ingress'], futureField: 'kept' },
} as unknown as NetworkPolicyObject;

it('sends the policy as plain JSON, so a field the client does not model arrives and comes back unchanged', async () => {
  const received: Received[] = [];
  const kc = await fakeApiServer(200, received);

  const returned = await replacePolicy(kc, policy);

  expect([received, returned]).toStrictEqual([[{ method: 'PUT', path: '/apis/networking.k8s.io/v1/namespaces/shop/networkpolicies/cart-allow', body: policy }], policy]);
});

it('throws the status of a refusal, which Apply turns into its message', async () => {
  const kc = await fakeApiServer(409, []);

  const code = await replacePolicy(kc, policy).then(
    () => 'written',
    (err: unknown) => (err instanceof ApiException ? err.code : 'another error'),
  );

  expect(code).toBe(409);
});
