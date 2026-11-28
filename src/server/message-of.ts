/** What a log line says of a thrown value: an Error's message, or the value itself when something else was thrown. */
export const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
