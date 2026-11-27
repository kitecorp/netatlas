import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import type { User } from '@kubernetes/client-node';
import { eksToken, type AwsCredentials } from './eks-token';
import type { Authenticator } from './token-file';

type RequestOptions = Parameters<Authenticator['applyAuthentication']>[1];

export const EKS_PROVIDER = 'netatlas-eks';
/** EKS accepts a token for 15 minutes; using one for 10 leaves room for clock skew and slow requests. */
const REUSE_MS = 10 * 60_000;

export interface EksDeps {
  credentials: () => Promise<AwsCredentials>;
  now: () => Date;
}

/**
 * Sends the token `aws eks get-token` would make, signed with the pod's AWS role. The default
 * credential chain finds the role through IRSA or EKS Pod Identity, and refreshes it before it expires.
 */
export class EksAuthenticator implements Authenticator {
  private readonly cache = new Map<string, { token: string; signedAt: number }>();

  constructor(private readonly deps: EksDeps = { credentials: fromNodeProviderChain(), now: () => new Date() }) {}

  isAuthProvider(user: User): boolean {
    return user.authProvider?.name === EKS_PROVIDER;
  }

  async applyAuthentication(user: User, opts: RequestOptions): Promise<void> {
    const { clusterName, region }: { clusterName: string; region: string } = user.authProvider.config;
    const key = `${region}/${clusterName}`;
    const now = this.deps.now();
    let cached = this.cache.get(key);
    if (!cached || now.getTime() - cached.signedAt >= REUSE_MS) {
      cached = { token: await eksToken({ clusterName, region, credentials: await this.deps.credentials(), now }), signedAt: now.getTime() };
      this.cache.set(key, cached);
    }
    opts.headers = { ...opts.headers, Authorization: `Bearer ${cached.token}` };
  }
}
