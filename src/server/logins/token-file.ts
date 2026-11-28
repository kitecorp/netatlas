import type { KubeConfig, User } from '@kubernetes/client-node';
import { bearerHeader, secretFileReader } from '../secret-file';

/** client-node does not export its Authenticator interface, so take it from the method that accepts one. */
export type Authenticator = Parameters<KubeConfig['addAuthenticator']>[0];
type RequestOptions = Parameters<Authenticator['applyAuthentication']>[1];

export const TOKEN_FILE_PROVIDER = 'netatlas-token-file';

/**
 * Sends the token in a mounted file. client-node's own FileAuth sends the file as it is, so a
 * token saved with a trailing newline breaks the Authorization header; this one reads it through a
 * secret file reader, which trims it and reads it again after 60 s. A token no header can carry is
 * refused here, because the HTTP client's own error would put the token into the log.
 */
export class TokenFileAuthenticator implements Authenticator {
  private readonly read: (path: string) => string;

  constructor(now?: () => Date) {
    this.read = secretFileReader(now);
  }

  isAuthProvider(user: User): boolean {
    return user.authProvider?.name === TOKEN_FILE_PROVIDER;
  }

  async applyAuthentication(user: User, opts: RequestOptions): Promise<void> {
    const file: string = user.authProvider.config.file;
    opts.headers = { ...opts.headers, Authorization: bearerHeader(this.read(file)) };
  }
}
