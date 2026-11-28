/** Whether a parsed JSON or YAML value is a mapping, rather than a list, a scalar or null. */
export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
