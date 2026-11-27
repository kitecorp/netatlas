import { readFileSync } from 'node:fs';
import type { KubeConfig, User } from '@kubernetes/client-node';

/** client-node does not export its Authenticator interface, so take it from the method that accepts one. */
export type Authenticator = Parameters<KubeConfig['addAuthenticator']>[0];
type RequestOptions = Parameters<Authenticator['applyAuthentication']>[1];

export const TOKEN_FILE_PROVIDER = 'netatlas-token-file';
const REREAD_AFTER_MS = 60_000;

/**
 * Sends the token in a mounted file. client-node's own FileAuth sends the file as it is, so a
 * token saved with a trailing newline breaks the Authorization header; this one trims it. The file
 * is read again after 60 s, so a rotated Secret takes effect without a restart.
 */
export class TokenFileAuthenticator implements Authenticator {
  private readonly cache = new Map<string, { token: string; readAt: number }>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  isAuthProvider(user: User): boolean {
    return user.authProvider?.name === TOKEN_FILE_PROVIDER;
  }

  async applyAuthentication(user: User, opts: RequestOptions): Promise<void> {
    const file: string = user.authProvider.config.file;
    const now = this.now().getTime();
    let cached = this.cache.get(file);
    if (!cached || now - cached.readAt > REREAD_AFTER_MS) {
      // A run-time path: the comment stops Turbopack tracing it, which would copy the project into the build.
      cached = { token: readFileSync(/* turbopackIgnore: true */ file, 'utf8').trim(), readAt: now };
      this.cache.set(file, cached);
    }
    opts.headers = { ...opts.headers, Authorization: `Bearer ${cached.token}` };
  }
}
