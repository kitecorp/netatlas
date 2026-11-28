import { readFileSync } from 'node:fs';
import { UNCARRIABLE_TOKEN_CODE } from '@/model/status';

const REREAD_AFTER_MS = 60_000;

/**
 * Reads a file the chart mounts from a Secret, trimmed, because a token or password saved with a
 * trailing newline would break the Authorization header. Each reader keeps what it read per path and
 * reads the file again once 60 s have passed by its own clock, so a rotated Secret takes effect
 * without a restart. The cache belongs to the reader, never to the module, so each client keeps its own.
 */
export function secretFileReader(now: () => Date = () => new Date()): (path: string) => string {
  const cache = new Map<string, { text: string; readAt: number }>();
  return (path) => {
    const at = now().getTime();
    let cached = cache.get(path);
    if (!cached || at - cached.readAt > REREAD_AFTER_MS) {
      // A run-time path: the comment stops Turbopack tracing it, which would copy the project into the build.
      cached = { text: readFileSync(/* turbopackIgnore: true */ path, 'utf8').trim(), readAt: at };
      cache.set(path, cached);
    }
    return cached.text;
  };
}

/**
 * What an Authorization header can carry: visible ASCII, no space or control character. Anything else
 * fails inside the HTTP client, whose error quotes the header, credential and all (fetch's
 * `Headers.append: "<value>" is an invalid header value`).
 */
export const TOKEN_CHARACTERS = /^[\x21-\x7e]+$/;

/** Why a token read from a file cannot be sent; it names neither the token nor the file. */
export const UNCARRIABLE_TOKEN = 'the token file holds a character an Authorization header cannot carry';

/**
 * `Bearer <token>`, or a throw that names neither the token nor its file when no header can carry the
 * token. An empty file is sent as it was, so the server's 401 says what is wrong.
 */
export function bearerHeader(token: string): string {
  if (token !== '' && !TOKEN_CHARACTERS.test(token)) throw Object.assign(new Error(UNCARRIABLE_TOKEN), { code: UNCARRIABLE_TOKEN_CODE });
  return `Bearer ${token}`;
}
