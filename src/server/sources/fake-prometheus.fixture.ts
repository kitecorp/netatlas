import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A path in a folder of its own where nothing was written, as a Secret key the chart did not mount. */
export function unmountedFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), 'netatlas-secret-')), name);
}

/** Writes a fixture credential to a file of its own, as the chart mounts each key of a Secret, and returns its path. */
export function secretFile(name: string, text: string): string {
  const file = unmountedFile(name);
  writeFileSync(file, text);
  return file;
}

/** What the fake answers one query with. */
export interface Reply {
  status: number;
  body: string;
}

/** One request as the fake received it. */
export interface SeenRequest {
  /** The path with its query string, as the request line carries it. */
  path: string;
  /** The `query` parameter: the PromQL asked. */
  query: string | null;
  authorization: string | undefined;
}

/** A CA, a server certificate it signed for 127.0.0.1 with its key, and a second CA that signed nothing; each in PEM. */
export interface TestCertificates {
  readonly ca: string;
  readonly otherCa: string;
  readonly cert: string;
  readonly key: string;
}

/**
 * Makes the certificates with openssl in a folder of its own, at test time, so that no key is committed.
 * The server certificate names 127.0.0.1 as its IP address, which Node checks the host against. The commands
 * run on OpenSSL and on the LibreSSL a Mac ships as /usr/bin/openssl. Each signature names SHA-256 because
 * LibreSSL's `x509 -req` otherwise signs with SHA-1, which Node refuses ("ca md too weak"). `ecparam` is one
 * way to make a P-256 key that both builds accept.
 */
export function testCertificates(): TestCertificates {
  const dir = mkdtempSync(join(tmpdir(), 'netatlas-tls-'));
  const at = (name: string) => join(dir, name);
  const openssl = (...args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
  for (const key of ['ca.key', 'other-ca.key', 'server.key']) openssl('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', key);
  openssl('req', '-x509', '-new', '-sha256', '-key', 'ca.key', '-out', 'ca.crt', '-days', '1', '-subj', '/CN=netatlas-test-ca');
  openssl('req', '-x509', '-new', '-sha256', '-key', 'other-ca.key', '-out', 'other-ca.crt', '-days', '1', '-subj', '/CN=netatlas-other-ca');
  openssl('req', '-new', '-sha256', '-key', 'server.key', '-out', 'server.csr', '-subj', '/CN=127.0.0.1');
  writeFileSync(at('server.ext'), 'subjectAltName=IP:127.0.0.1\n');
  openssl('x509', '-req', '-sha256', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server.crt', '-days', '1', '-extfile', 'server.ext');
  const pem = (name: string) => readFileSync(at(name), 'utf8');
  return { ca: pem('ca.crt'), otherCa: pem('other-ca.crt'), cert: pem('server.crt'), key: pem('server.key') };
}

export interface FakePrometheus {
  /** `http://127.0.0.1:<port>`, or `https://` when the fake serves TLS, with no trailing slash. */
  url: string;
  /** Every request, in the order it arrived. */
  seen: SeenRequest[];
  /** The most requests the fake held unanswered at once. */
  readonly mostInFlight: number;
  /** The requests whose client went away before the fake answered. */
  readonly abandoned: number;
  close(): Promise<void>;
}

/**
 * A Prometheus on 127.0.0.1 that answers each request with `answer(query)`, after holding it
 * `holdMs`. Prometheus's API answers JSON as `application/json`; anything else goes as plain text,
 * as a proxy's error page would. With `tls` it serves https with that certificate and key.
 */
export async function fakePrometheus(
  answer: (query: string) => Reply,
  { holdMs = 0, tls }: { holdMs?: number; tls?: { cert: string; key: string } } = {},
): Promise<FakePrometheus> {
  const seen: SeenRequest[] = [];
  const timers = new Set<NodeJS.Timeout>();
  let inFlight = 0;
  let mostInFlight = 0;
  let abandoned = 0;
  const handle = (req: IncomingMessage, res: ServerResponse) => {
    const query = new URL(req.url ?? '/', 'http://prometheus.test').searchParams.get('query');
    seen.push({ path: req.url ?? '', query, authorization: req.headers.authorization });
    inFlight += 1;
    mostInFlight = Math.max(mostInFlight, inFlight);
    const timer = setTimeout(() => {
      timers.delete(timer);
      const { status, body } = answer(query ?? '');
      const type = body.startsWith('{') ? 'application/json' : 'text/plain; charset=utf-8';
      res.writeHead(status, { 'content-type': type }).end(body);
    }, holdMs);
    timers.add(timer);
    res.on('close', () => {
      inFlight -= 1;
      if (res.writableEnded) return;
      abandoned += 1;
      clearTimeout(timer);
      timers.delete(timer);
    });
  };
  const server = tls ? createTlsServer(tls, handle) : createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `${tls ? 'https' : 'http'}://127.0.0.1:${port}`,
    seen,
    get mostInFlight() {
      return mostInFlight;
    },
    get abandoned() {
      return abandoned;
    },
    async close() {
      for (const t of timers) clearTimeout(t);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
