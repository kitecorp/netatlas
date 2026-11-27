// The bearer token EKS accepts is the one `aws eks get-token` prints, which aws-iam-authenticator
// builds: a presigned STS GetCallerIdentity URL whose signature covers the cluster's name in the
// x-k8s-aws-id header, base64url-encoded behind a version prefix. EKS calls that URL to learn the
// caller's role. The URL says X-Amz-Expires=60, yet EKS accepts it for 15 minutes from X-Amz-Date.
import { Sha256 } from '@aws-crypto/sha256-js';
import { SignatureV4 } from '@smithy/signature-v4';

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

const PREFIX = 'k8s-aws-v1.';
const SIGNATURE = 'X-Amz-Signature';

/** encodeURIComponent leaves !'()* alone; Go's url.Values.Encode, which the reference token used, escapes them. */
const encode = (v: string) => encodeURIComponent(v).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);

export async function eksToken(i: { clusterName: string; region: string; credentials: AwsCredentials; now: Date }): Promise<string> {
  const host = `sts.${i.region}.amazonaws.com`;
  const signer = new SignatureV4({ service: 'sts', region: i.region, credentials: i.credentials, sha256: Sha256 });
  const signed = await signer.presign(
    {
      method: 'GET',
      protocol: 'https:',
      hostname: host,
      path: '/',
      headers: { host, 'x-k8s-aws-id': i.clusterName },
      query: { Action: 'GetCallerIdentity', Version: '2011-06-15' },
    },
    { signingDate: i.now, expiresIn: 60 },
  );
  // Sorted keys with the signature last, as the reference token orders them.
  const params = signed.query ?? {};
  const keys = Object.keys(params)
    .filter((k) => k !== SIGNATURE)
    .sort();
  const query = [...keys, SIGNATURE].map((k) => `${k}=${encode(String(params[k]))}`).join('&');
  return PREFIX + Buffer.from(`https://${host}/?${query}`).toString('base64url');
}

/** The X-Amz-Date the token was signed at, as in `20260102T030405Z`. */
export function tokenDate(token: string): string {
  const url = new URL(Buffer.from(token.slice(PREFIX.length), 'base64url').toString());
  return url.searchParams.get('X-Amz-Date') ?? '';
}
