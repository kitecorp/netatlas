import { isRecord } from './is-record';
import type { Labels } from './types';

/** One series of an instant vector: its labels and its value. */
export interface PromSample {
  readonly labels: Labels;
  readonly value: number;
}

export type Answer = { readonly ok: true; readonly samples: readonly PromSample[] } | { readonly ok: false; readonly reason: string };

const failed = (reason: string): Answer => ({ ok: false, reason });

const NOT_UNDERSTOOD = failed('Prometheus answered with a body netatlas does not understand');
/** The result types of Prometheus's query API besides `vector` (docs/querying/api.md, "Expression query result formats"). */
const OTHER_RESULTS = new Set(['matrix', 'scalar', 'string']);

function parsed(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * One series of a vector, or none: a native histogram carries `histogram` instead of `value`, and a
 * value that is not a finite number (Prometheus writes `NaN` and `+Inf` as strings) is no figure, nor
 * an empty one, which JavaScript's Number reads as 0.
 */
function sampleOf(series: unknown): PromSample[] {
  if (!isRecord(series) || !isRecord(series.metric) || !Array.isArray(series.value)) return [];
  const raw: unknown = series.value[1];
  const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN;
  if (!Number.isFinite(value)) return [];
  const labels = Object.fromEntries(Object.entries(series.metric).filter((e): e is [string, string] => typeof e[1] === 'string'));
  return [{ labels, value }];
}

/** How many characters of Prometheus's own error text a reason keeps; the reason goes into the log and onto every page. */
const ERROR_TEXT_LENGTH = 200;

/** C0 and C1 control characters and DEL, which could start a line of their own in the log or move a terminal's cursor. */
// oxlint-disable-next-line no-control-regex -- matching control characters is the point.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/** Prometheus's error text, each control character made a space and cut at ERROR_TEXT_LENGTH characters. */
function errorText(text: string): string {
  const chars = [...text.replace(CONTROL, ' ')];
  return chars.length > ERROR_TEXT_LENGTH ? `${chars.slice(0, ERROR_TEXT_LENGTH).join('')}…` : chars.join('');
}

/**
 * Reads Prometheus's answer to an instant query (`GET /api/v1/query`). The status decides first,
 * because a proxy in front of Prometheus answers 401, 403 or a sign-in page in a body of its own. A
 * body that is not Prometheus's JSON is never read as an empty answer, which would show as no traffic.
 */
export function readAnswer(status: number, body: string): Answer {
  if (status === 401) return failed("Prometheus did not accept netatlas's credentials");
  if (status === 403) return failed("netatlas's credentials may not query Prometheus");
  const json = parsed(body);
  if (json === undefined) return failed(`Prometheus answered HTTP ${status} with a body that is not JSON`);
  if (!isRecord(json)) return NOT_UNDERSTOOD;
  if (json.status === 'error' && typeof json.errorType === 'string' && typeof json.error === 'string')
    return failed(`Prometheus refused the query: ${errorText(`${json.errorType}: ${json.error}`)}`);
  const data = json.data;
  if (status < 200 || status > 299 || json.status !== 'success' || !isRecord(data)) return NOT_UNDERSTOOD;
  if (typeof data.resultType === 'string' && OTHER_RESULTS.has(data.resultType)) return failed(`Prometheus answered with a ${data.resultType}, not a vector`);
  if (data.resultType !== 'vector' || !Array.isArray(data.result)) return NOT_UNDERSTOOD;
  return { ok: true, samples: data.result.flatMap(sampleOf) };
}
