// Answers of Prometheus's instant query API (`GET /api/v1/query`), in the envelope Prometheus v3
// writes: the vector and error forms were measured on prom/prometheus:v3.10.0.

/** A vector holding one sample of the frontend's calls. */
export const ONE_SAMPLE =
  '{"status":"success","data":{"resultType":"vector","result":[{"metric":{"reporter":"source","source_workload":"frontend"},"value":[1764324000,"12.5"]}]}}';

/** A vector with no samples: the query matched no series. */
export const NO_SAMPLES = '{"status":"success","data":{"resultType":"vector","result":[]}}';

/** What Prometheus answers, with HTTP 503, when a query runs past its timeout. */
export const QUERY_TIMED_OUT = '{"status":"error","errorType":"timeout","error":"query timed out in expression evaluation"}';
