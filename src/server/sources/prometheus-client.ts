import { request as httpRequest, type OutgoingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readAnswer, type Answer } from '@/model/prometheus-answer';
import { PROBE_TIMEOUT_CODE, unreachableReason } from '@/model/status';
import type { PrometheusAuth, PrometheusConfig } from '../registry';
import { bearerHeader, secretFileReader } from '../secret-file';

export interface PrometheusClient {
  /** Asks one instant query. Never throws: a failure is an answer with its reason. */
  query(promql: string, signal?: AbortSignal): Promise<Answer>;
}

const TIMEOUT_MS = 10_000;
/** The pod's memory is limited, and the timeout bounds time, not bytes: a larger answer is not read. */
const LARGEST_ANSWER_BYTES = 16 * 1024 * 1024;
const CREDENTIALS_UNREADABLE = 'the Prometheus credentials could not be read';
const CA_UNREADABLE = 'the Prometheus CA file could not be read';
const TOO_LARGE = 'Prometheus answered with a body larger than 16 MiB';

/** The instant query endpoint under the configured URL, keeping a path prefix with or without its trailing slash. */
function queryEndpoint(url: string): URL {
  const endpoint = new URL(url);
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, '')}/api/v1/query`;
  return endpoint;
}

function authorization(auth: PrometheusAuth, read: (path: string) => string): OutgoingHttpHeaders {
  switch (auth.type) {
    case 'none':
      return {};
    // A token no header can carry is as good as unread; Basic's base64 carries any character.
    case 'bearer':
      return { Authorization: bearerHeader(read(auth.tokenFile)) };
    case 'basic':
      return { Authorization: `Basic ${Buffer.from(`${read(auth.usernameFile)}:${read(auth.passwordFile)}`).toString('base64')}` };
  }
}

/**
 * Reads one cluster's Prometheus over `node:http` or `node:https`, because fetch takes no CA per
 * request. The credentials and the CA are read from their mounted files at each query, through the
 * client's own reader, so a rotated Secret takes effect within a minute. A reason is built only from
 * the HTTP status, Prometheus's error, the socket error's code, the answer's size, or which mounted
 * file could not be read; never from the request's headers or a file's path.
 */
export function prometheusClient(cfg: PrometheusConfig, opts: { timeoutMs?: number } = {}): PrometheusClient {
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const read = secretFileReader();
  const endpoint = queryEndpoint(cfg.url);
  const https = endpoint.protocol === 'https:';
  const caOf = (ca: NonNullable<PrometheusConfig['ca']>) => ('file' in ca ? read(ca.file) : Buffer.from(ca.data, 'base64').toString('utf8'));

  /**
   * The request's headers and CA, read from the mounted files, or the reason a file could not be read.
   * The reason names only which file failed, because a Secret not mounted points the operator at the
   * mount, not at the network. The read error is dropped: its message names the path.
   */
  function mountedOptions(): { headers: OutgoingHttpHeaders; ca?: string } | string {
    let headers: OutgoingHttpHeaders;
    try {
      headers = authorization(cfg.auth, read);
    } catch {
      return CREDENTIALS_UNREADABLE;
    }
    try {
      return { headers, ...(https && cfg.ca ? { ca: caOf(cfg.ca) } : {}) };
    } catch {
      return CA_UNREADABLE;
    }
  }

  return {
    query(promql, signal) {
      const options = mountedOptions();
      if (typeof options === 'string') return Promise.resolve({ ok: false, reason: options });
      return new Promise<Answer>((resolve) => {
        const url = new URL(endpoint);
        url.searchParams.set('query', promql);
        let settled = false;
        // Why netatlas ended the request itself (the timeout, or the caller's abort), which names the failure.
        let ended: unknown;
        let req: ReturnType<typeof httpRequest>;
        try {
          req = (https ? httpsRequest : httpRequest)(url, options, (res) => {
            const chunks: Buffer[] = [];
            let bytes = 0;
            res.on('data', (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes <= LARGEST_ANSWER_BYTES) chunks.push(chunk);
              else {
                settle({ ok: false, reason: TOO_LARGE });
                req.destroy();
              }
            });
            res.on('end', () => settle(readAnswer(res.statusCode ?? 0, Buffer.concat(chunks).toString('utf8'))));
            // An answer cut off before its end closes without `end`.
            res.on('error', fail);
            res.on('close', () => fail(res.errored));
          });
        } catch (err) {
          // Node checks the headers as it makes the request, and a query never throws: a failure is an answer.
          resolve({ ok: false, reason: unreachableReason(err, 'Prometheus') });
          return;
        }
        const end = (err: Error) => {
          ended = err;
          req.destroy(err);
        };
        // A Prometheus that takes the connection and never answers would hold the poll for ever.
        const timer = setTimeout(() => end(Object.assign(new Error('Prometheus did not answer in time'), { code: PROBE_TIMEOUT_CODE })), timeoutMs);
        timer.unref();
        const onAbort = () => end(new Error('the query was aborted'));
        function settle(answer: Answer) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve(answer);
        }
        function fail(err: unknown) {
          settle({ ok: false, reason: unreachableReason(ended ?? err, 'Prometheus') });
        }
        req.on('error', fail);
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
        req.end();
      });
    },
  };
}
