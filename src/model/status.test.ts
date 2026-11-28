import { describe, expect, test } from 'vitest';
import { nextRetryDelay, PROBE_TIMEOUT_CODE, reduceStatus, unreachableReason, type ClusterStatus, type ProbeEvent } from './status';

const t1 = new Date('2026-11-27T10:00:00Z');
const t2 = new Date('2026-11-27T10:00:15Z');
const t3 = new Date('2026-11-27T10:00:30Z');

describe('reduceStatus', () => {
  test.each<[string, ClusterStatus, ProbeEvent, ClusterStatus]>([
    [
      'a failure makes a reachable cluster unreachable since then and keeps lastSeen',
      { state: 'reachable', since: t1, lastSeen: t2, kubernetesVersion: 'v1.37.0' },
      { type: 'failed', at: t3, reason: 'the API server refused the connection' },
      { state: 'unreachable', since: t3, reason: 'the API server refused the connection', lastSeen: t2 },
    ],
    [
      'a failure while connecting makes the cluster unreachable since then, never seen',
      { state: 'connecting' },
      { type: 'failed', at: t1, reason: 'the API server stopped answering' },
      { state: 'unreachable', since: t1, reason: 'the API server stopped answering' },
    ],
    [
      'a later failure changes only the reason',
      { state: 'unreachable', since: t1, reason: 'the API server stopped answering', lastSeen: t1 },
      { type: 'failed', at: t3, reason: 'the API server refused the connection' },
      { state: 'unreachable', since: t1, reason: 'the API server refused the connection', lastSeen: t1 },
    ],
    [
      'an ok makes an unreachable cluster reachable since then',
      { state: 'unreachable', since: t1, reason: 'the API server stopped answering', lastSeen: t1 },
      { type: 'ok', at: t3, kubernetesVersion: 'v1.37.0' },
      { state: 'reachable', since: t3, lastSeen: t3, kubernetesVersion: 'v1.37.0' },
    ],
    [
      'an ok makes a connecting cluster reachable since then',
      { state: 'connecting' },
      { type: 'ok', at: t1, kubernetesVersion: 'v1.37.2-eks-a737599' },
      { state: 'reachable', since: t1, lastSeen: t1, kubernetesVersion: 'v1.37.2-eks-a737599' },
    ],
    [
      'an ok moves only lastSeen if the cluster was already reachable',
      { state: 'reachable', since: t1, lastSeen: t2, kubernetesVersion: 'v1.37.0' },
      { type: 'ok', at: t3, kubernetesVersion: 'v1.37.0' },
      { state: 'reachable', since: t1, lastSeen: t3, kubernetesVersion: 'v1.37.0' },
    ],
  ])('reduceStatus %#: %s', (_name, before, event, after) => {
    expect(reduceStatus(before, event)).toStrictEqual(after);
  });
});

test('retries after 5 s, doubling up to 5 minutes', () => {
  expect([1, 2, 3, 6, 7, 20].map(nextRetryDelay)).toEqual([5000, 10000, 20000, 160000, 300000, 300000]);
});

const coded = (code: string | number) => Object.assign(new Error('probe failed'), { code });

describe('unreachableReason', () => {
  test.each<[unknown, string]>([
    [coded('ECONNREFUSED'), 'the API server refused the connection'],
    [new TypeError('fetch failed', { cause: coded('ECONNREFUSED') }), 'the API server refused the connection'],
    [coded('ETIMEDOUT'), 'the API server stopped answering'],
    [coded('EHOSTUNREACH'), 'the API server stopped answering'],
    [coded('ProbeTimeout'), 'the API server stopped answering'],
    [coded('ENOTFOUND'), 'its address could not be resolved'],
    [new TypeError('fetch failed', { cause: coded('SELF_SIGNED_CERT_IN_CHAIN') }), "the API server's certificate was not accepted"],
    [coded('ERR_TLS_CERT_ALTNAME_INVALID'), "the API server's certificate was not accepted"],
    // A server that sends only its leaf certificate, checked against the wrong CA, fails with these.
    [coded('UNABLE_TO_VERIFY_LEAF_SIGNATURE'), "the API server's certificate was not accepted"],
    [coded('DEPTH_ZERO_SELF_SIGNED_CERT'), "the API server's certificate was not accepted"],
    [coded('CERT_HAS_EXPIRED'), "the API server's certificate was not accepted"],
    [coded(401), "the API server did not accept netatlas's login"],
    [coded(403), "netatlas's login may not read this cluster"],
    // netatlas refuses to send such a token (src/server/secret-file.ts), so the sentence is fixed and holds no part of it.
    [coded('ERR_UNCARRIABLE_TOKEN'), "netatlas's token file holds a character an Authorization header cannot carry"],
    [coded(500), 'the API server could not be reached'],
    [new Error('something else'), 'the API server could not be reached'],
    ['a thrown string', 'the API server could not be reached'],
  ])('unreachableReason %#', (err, reason) => {
    expect(unreachableReason(err)).toBe(reason);
  });

  test.each<[unknown, string]>([
    [{ code: 'ECONNREFUSED' }, 'Prometheus refused the connection'],
    [{ code: PROBE_TIMEOUT_CODE }, 'Prometheus stopped answering'],
    [{ code: 'CERT_HAS_EXPIRED' }, "Prometheus's certificate was not accepted"],
    // The default `who` keeps "its address could not be resolved" (the table above).
    [{ code: 'ENOTFOUND' }, 'the address of Prometheus could not be resolved'],
    [{}, 'Prometheus could not be reached'],
  ])("unreachableReason(err, 'Prometheus') %#", (err, reason) => {
    expect(unreachableReason(err, 'Prometheus')).toBe(reason);
  });
});
