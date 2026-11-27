import { KubeConfig, type Cluster, type User } from '@kubernetes/client-node';
import type { ClusterConfig } from '../registry';
import { EKS_PROVIDER, EksAuthenticator, type EksDeps } from './eks-authenticator';
import { TOKEN_FILE_PROVIDER, TokenFileAuthenticator, type Authenticator } from './token-file';

/** A remote cluster's server and CA, as the registry gives them. */
function remoteCluster(c: ClusterConfig): Cluster {
  const ca = c.ca && ('file' in c.ca ? { caFile: c.ca.file } : { caData: c.ca.data });
  return { name: c.name, server: c.server ?? '', ...ca, skipTLSVerify: false };
}

/**
 * A cluster read over the network: its server and CA from the registry, and a user whose header
 * comes from `authenticator`. The user carries no `token` field, because client-node lets a user
 * token overwrite any authenticator's header.
 */
function remote(kc: KubeConfig, c: ClusterConfig, authenticator: Authenticator, user: User): KubeConfig {
  kc.addAuthenticator(authenticator);
  kc.loadFromClusterAndUser(remoteCluster(c), user);
  return kc;
}

/**
 * A KubeConfig that reads one registry cluster with the login the registry names. `eks` replaces the
 * pod's AWS credentials and the clock, for tests.
 */
export function kubeConfigFor(c: ClusterConfig, eks?: EksDeps): KubeConfig {
  const kc = new KubeConfig();
  const login = c.login;
  switch (login.type) {
    case 'inCluster':
      kc.loadFromCluster();
      return kc;
    case 'token':
      return remote(kc, c, new TokenFileAuthenticator(), {
        name: c.name,
        authProvider: { name: TOKEN_FILE_PROVIDER, config: { file: login.tokenFile } },
      });
    case 'eks':
      return remote(kc, c, new EksAuthenticator(eks), {
        name: c.name,
        authProvider: { name: EKS_PROVIDER, config: { clusterName: login.clusterName, region: login.region } },
      });
  }
}

/**
 * A KubeConfig for Apply's one write: the cluster as netatlas reaches it, with the person's token as
 * the only credential. No authenticator is added, so netatlas's own login can never stand in for it.
 * The cluster netatlas runs in is reached at KUBERNETES_SERVICE_HOST and _PORT, trusting the service
 * account's ca.crt, as client-node's loadFromCluster sets it up.
 */
export function kubeConfigWithToken(c: ClusterConfig, token: string): KubeConfig {
  const kc = new KubeConfig();
  let cluster = remoteCluster(c);
  if (c.login.type === 'inCluster') {
    kc.loadFromCluster();
    const { server, caFile } = kc.getCurrentCluster() ?? { server: '', caFile: undefined };
    cluster = { name: c.name, server, ...(caFile ? { caFile } : {}), skipTLSVerify: false };
  }
  kc.loadFromClusterAndUser(cluster, { name: c.name, token });
  return kc;
}
