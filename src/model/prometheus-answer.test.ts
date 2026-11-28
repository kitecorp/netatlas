import { expect, it } from 'vitest';
import { NO_SAMPLES, ONE_SAMPLE, QUERY_TIMED_OUT } from './fixtures/prometheus';
import { readAnswer, type Answer } from './prometheus-answer';

it.each<[number, string, Answer]>([
  [200, ONE_SAMPLE, { ok: true, samples: [{ labels: { reporter: 'source', source_workload: 'frontend' }, value: 12.5 }] }],
  // A value that is not a number, and a native histogram, which carries no `value`, are left out.
  [
    200,
    '{"status":"success","data":{"resultType":"vector","result":[{"metric":{"reporter":"source"},"value":[1764324000,"NaN"]},{"metric":{"reporter":"destination"},"histogram":[1764324000,{"count":"2","sum":"0.5","buckets":[[0,"0","1","2"]]}]}]}}',
    { ok: true, samples: [] },
  ],
  [200, NO_SAMPLES, { ok: true, samples: [] }],
  // An empty string is no number, though JavaScript's Number reads it as 0.
  [200, '{"status":"success","data":{"resultType":"vector","result":[{"metric":{"reporter":"source"},"value":[1764324000,""]}]}}', { ok: true, samples: [] }],
  [
    400,
    String.raw`{"status":"error","errorType":"bad_data","error":"invalid parameter \"query\": 1:11: parse error: unexpected \"(\" in grouping opts, expected \",\" or \")\""}`,
    { ok: false, reason: 'Prometheus refused the query: bad_data: invalid parameter "query": 1:11: parse error: unexpected "(" in grouping opts, expected "," or ")"' },
  ],
  [503, QUERY_TIMED_OUT, { ok: false, reason: 'Prometheus refused the query: timeout: query timed out in expression evaluation' }],
  // A line break, an escape and a C1 control character each become one space, so the text cannot write a line of its own in the log.
  [
    400,
    JSON.stringify({ status: 'error', errorType: 'bad_data', error: 'parse error\nlevel=info msg="poll ok"\u001b[0m\u009b' }),
    { ok: false, reason: 'Prometheus refused the query: bad_data: parse error level=info msg="poll ok" [0m ' },
  ],
  // What Prometheus wrote, `bad_data: ` and 300 characters, is cut at 200 characters.
  [400, JSON.stringify({ status: 'error', errorType: 'bad_data', error: 'x'.repeat(300) }), { ok: false, reason: `Prometheus refused the query: bad_data: ${'x'.repeat(190)}…` }],
  [400, JSON.stringify({ status: 'error', errorType: 'bad_data', error: 'x'.repeat(190) }), { ok: false, reason: `Prometheus refused the query: bad_data: ${'x'.repeat(190)}` }],
  [200, '{"status":"success","data":{"resultType":"matrix","result":[]}}', { ok: false, reason: 'Prometheus answered with a matrix, not a vector' }],
  // A sign-in page of a proxy in front of Prometheus.
  [302, '<html><body>Sign in</body></html>', { ok: false, reason: 'Prometheus answered HTTP 302 with a body that is not JSON' }],
  [401, 'Unauthorized\n', { ok: false, reason: "Prometheus did not accept netatlas's credentials" }],
  // The status decides, even when the body is a Prometheus error.
  [403, '{"status":"error","errorType":"forbidden","error":"denied"}', { ok: false, reason: "netatlas's credentials may not query Prometheus" }],
  [404, '404 page not found\n', { ok: false, reason: 'Prometheus answered HTTP 404 with a body that is not JSON' }],
  [200, '{"status":"success"}', { ok: false, reason: 'Prometheus answered with a body netatlas does not understand' }],
])('readAnswer %#: HTTP %i', (status, body, expected) => {
  expect(readAnswer(status, body)).toStrictEqual(expected);
});
