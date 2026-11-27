// The reference token: a Go reproduction of aws-iam-authenticator's GetWithSTS (aws-sdk-go-v2 1.48.1)
// signed these inputs, and its URL is signed 5c223e0809bf619356a1216de3154343eb3e325f5fc8ce898bcc35ea732b7efb.
// The credentials are AWS's documented signing examples, not a real key.
import type { AwsCredentials } from './eks-token';

export const REFERENCE = {
  clusterName: 'prod-eu-1',
  region: 'eu-west-1',
  now: new Date('2026-01-02T03:04:05Z'),
  credentials: {
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    sessionToken: 'IQoJb3JpZ2luX2VjEXAMPLE/token+with=chars',
  } satisfies AwsCredentials,
};

export const EXPECTED_TOKEN = 'k8s-aws-v1.aHR0cHM6Ly9zdHMuZXUtd2VzdC0xLmFtYXpvbmF3cy5jb20vP0FjdGlvbj1HZXRDYWxsZXJJZGVudGl0eSZWZXJzaW9uPTIwMTEtMDYtMTUmWC1BbXotQWxnb3JpdGhtPUFXUzQtSE1BQy1TSEEyNTYmWC1BbXotQ3JlZGVudGlhbD1BS0lERVhBTVBMRSUyRjIwMjYwMTAyJTJGZXUtd2VzdC0xJTJGc3RzJTJGYXdzNF9yZXF1ZXN0JlgtQW16LURhdGU9MjAyNjAxMDJUMDMwNDA1WiZYLUFtei1FeHBpcmVzPTYwJlgtQW16LVNlY3VyaXR5LVRva2VuPUlRb0piM0pwWjJsdVgyVmpFWEFNUExFJTJGdG9rZW4lMkJ3aXRoJTNEY2hhcnMmWC1BbXotU2lnbmVkSGVhZGVycz1ob3N0JTNCeC1rOHMtYXdzLWlkJlgtQW16LVNpZ25hdHVyZT01YzIyM2UwODA5YmY2MTkzNTZhMTIxNmRlMzE1NDM0M2ViM2UzMjVmNWZjOGNlODk4YmNjMzVlYTczMmI3ZWZi';
