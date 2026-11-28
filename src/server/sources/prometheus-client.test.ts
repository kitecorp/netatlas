import { createServer, type Socket } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { NO_SAMPLES } from '@/model/fixtures/prometheus';
import type { Answer } from '@/model/prometheus-answer';
import type { PrometheusConfig } from '../registry';
import { fakePrometheus, secretFile, testCertificates, unmountedFile } from './fake-prometheus.fixture';
import { prometheusClient } from './prometheus-client';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

it.each<[string, (url: string) => PrometheusConfig, { path: string; authorization: string | undefined }]>([
  ['no auth', (url) => ({ url, auth: { type: 'none' } }), { path: '/api/v1/query?query=up', authorization: undefined }],
  [
    'bearer, from a file with a trailing newline',
    (url) => ({ url, auth: { type: 'bearer', tokenFile: secretFile('token', 'prom-token-fixture\n') } }),
    { path: '/api/v1/query?query=up', authorization: 'Bearer prom-token-fixture' },
  ],
  [
    'basic, from a user file and a password file',
    (url) => ({ url, auth: { type: 'basic', usernameFile: secretFile('username', 'reader\n'), passwordFile: secretFile('password', 'pw-fixture\n') } }),
    // `printf 'reader:pw-fixture' | base64`
    { path: '/api/v1/query?query=up', authorization: 'Basic cmVhZGVyOnB3LWZpeHR1cmU=' },
  ],
  ['a URL with a path prefix', (url) => ({ url: `${url}/prom`, auth: { type: 'none' } }), { path: '/prom/api/v1/query?query=up', authorization: undefined }],
  ['a path prefix ending in a slash', (url) => ({ url: `${url}/prom/`, auth: { type: 'none' } }), { path: '/prom/api/v1/query?query=up', authorization: undefined }],
])('asks Prometheus %#: %s', async (_name, configFor, expected) => {
  const fake = await fakePrometheus(() => ({ status: 200, body: NO_SAMPLES }));
  cleanups.push(() => fake.close());

  const answer = await prometheusClient(configFor(fake.url)).query('up');

  expect({ seen: fake.seen.map(({ path, authorization }) => ({ path, authorization })), answer }).toStrictEqual({
    seen: [expected],
    answer: { ok: true, samples: [] },
  });
});

/** A TCP listener that takes the connection and stays silent, as a hung Prometheus does. */
async function silentServer(): Promise<string> {
  const sockets: Socket[] = [];
  const server = createServer((s) => sockets.push(s));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => {
    for (const s of sockets) s.destroy();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

it.each<[string, () => Promise<{ url: string; timeoutMs?: number }>, Answer]>([
  // Node's fetch refuses port 9, so a refused connection uses port 2.
  ['a refused connection', async () => ({ url: 'http://127.0.0.1:2' }), { ok: false, reason: 'Prometheus refused the connection' }],
  ['a server that never answers', async () => ({ url: await silentServer(), timeoutMs: 200 }), { ok: false, reason: 'Prometheus stopped answering' }],
])('reports a Prometheus it cannot reach %#: %s', async (_name, target, expected) => {
  const { url, timeoutMs } = await target();

  const answer = await prometheusClient({ url, auth: { type: 'none' } }, timeoutMs === undefined ? undefined : { timeoutMs }).query('up');

  expect(answer).toStrictEqual(expected);
});

// Port 2 refuses, so a client that asked before reading its files would answer "refused the connection".
it.each<[string, PrometheusConfig, Answer]>([
  [
    'a bearer token file',
    { url: 'http://127.0.0.1:2', auth: { type: 'bearer', tokenFile: unmountedFile('token') } },
    { ok: false, reason: 'the Prometheus credentials could not be read' },
  ],
  [
    'a basic password file',
    { url: 'http://127.0.0.1:2', auth: { type: 'basic', usernameFile: secretFile('username', 'reader\n'), passwordFile: unmountedFile('password') } },
    { ok: false, reason: 'the Prometheus credentials could not be read' },
  ],
  // A line break inside the token cannot go into a header, so the token is as good as unread; Node's own
  // error would leave the query rejected instead of answered.
  [
    'a bearer token file holding a line break',
    { url: 'http://127.0.0.1:2', auth: { type: 'bearer', tokenFile: secretFile('token', 'prom-token-fixture\nsecond-line\n') } },
    { ok: false, reason: 'the Prometheus credentials could not be read' },
  ],
  // The CA is read only for https.
  [
    'a CA file',
    { url: 'https://127.0.0.1:2', auth: { type: 'none' }, ca: { file: unmountedFile('ca.crt') } },
    { ok: false, reason: 'the Prometheus CA file could not be read' },
  ],
])('names a mounted file it cannot read, never its path %#: %s', async (_name, config, expected) => {
  const answer = await prometheusClient(config).query('up');

  expect(answer).toStrictEqual(expected);
});

/** NO_SAMPLES followed by spaces, which JSON allows, up to `bytes` bytes in all. */
const paddedTo = (bytes: number) => NO_SAMPLES + ' '.repeat(bytes - NO_SAMPLES.length);

// The pod's memory is limited, and the 10-second timer bounds time, not bytes.
it.each<[string, number, Answer]>([
  ['16 MiB', 16 * 1024 * 1024, { ok: true, samples: [] }],
  ['16 MiB and 1 byte', 16 * 1024 * 1024 + 1, { ok: false, reason: 'Prometheus answered with a body larger than 16 MiB' }],
])('reads an answer of at most 16 MiB %#: %s', async (_name, bytes, expected) => {
  const body = paddedTo(bytes);
  const fake = await fakePrometheus(() => ({ status: 200, body }));
  cleanups.push(() => fake.close());

  const answer = await prometheusClient({ url: fake.url, auth: { type: 'none' } }).query('up');

  expect(answer).toStrictEqual(expected);
});

// The CA decides whether the credential is sent: a server it does not vouch for never sees the token.
const certs = testCertificates();
const toBase64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

it.each<[string, PrometheusConfig['ca'], { authorization: (string | undefined)[]; answer: Answer }]>([
  ['the right CA, from a file', { file: secretFile('ca.crt', certs.ca) }, { authorization: ['Bearer prom-token-fixture'], answer: { ok: true, samples: [] } }],
  ['the right CA, as data', { data: toBase64(certs.ca) }, { authorization: ['Bearer prom-token-fixture'], answer: { ok: true, samples: [] } }],
  ['no CA', undefined, { authorization: [], answer: { ok: false, reason: "Prometheus's certificate was not accepted" } }],
  ['another CA', { file: secretFile('ca.crt', certs.otherCa) }, { authorization: [], answer: { ok: false, reason: "Prometheus's certificate was not accepted" } }],
  ['data that is no certificate', { data: toBase64('not a certificate\n') }, { authorization: [], answer: { ok: false, reason: "Prometheus's certificate was not accepted" } }],
])('sends the credential over https only to a server its CA vouches for %#: %s', async (_name, ca, expected) => {
  const fake = await fakePrometheus(() => ({ status: 200, body: NO_SAMPLES }), { tls: certs });
  cleanups.push(() => fake.close());

  const answer = await prometheusClient({ url: fake.url, auth: { type: 'bearer', tokenFile: secretFile('token', 'prom-token-fixture\n') }, ...(ca && { ca }) }).query('up');

  expect({ authorization: fake.seen.map((r) => r.authorization), answer }).toStrictEqual(expected);
});
