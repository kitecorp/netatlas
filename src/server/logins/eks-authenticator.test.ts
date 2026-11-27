import type { User } from '@kubernetes/client-node';
import { expect, it } from 'vitest';
import { EKS_PROVIDER, EksAuthenticator } from './eks-authenticator';
import { REFERENCE } from './eks-token.fixture';
import { tokenDate } from './eks-token';

const eksUser = (clusterName: string): User => ({ name: clusterName, authProvider: { name: EKS_PROVIDER, config: { clusterName, region: 'eu-west-1' } } });

/** Applies the authenticator to one request per step, each at `minutes` after the reference time, and reads the signing date of each token. */
async function signingDates(steps: readonly { cluster: string; minutes: number }[]): Promise<string[]> {
  let now = REFERENCE.now;
  const auth = new EksAuthenticator({ credentials: async () => REFERENCE.credentials, now: () => now });
  const dates: string[] = [];
  for (const { cluster, minutes } of steps) {
    now = new Date(REFERENCE.now.getTime() + minutes * 60_000);
    const opts: { headers?: Record<string, string> } = {};
    await auth.applyAuthentication(eksUser(cluster), opts);
    dates.push(tokenDate(opts.headers?.Authorization?.replace(/^Bearer /, '') ?? ''));
  }
  return dates;
}

it('reuses a token for 10 minutes, then signs a new one', async () =>
  expect(await signingDates([0, 9, 11].map((minutes) => ({ cluster: 'a', minutes })))).toEqual([
    '20260102T030405Z',
    '20260102T030405Z',
    '20260102T031505Z',
  ]));

it('keeps one token per cluster', async () =>
  expect(
    await signingDates([
      { cluster: 'a', minutes: 0 },
      { cluster: 'b', minutes: 1 },
      { cluster: 'a', minutes: 2 },
    ]),
  ).toEqual(['20260102T030405Z', '20260102T030505Z', '20260102T030405Z']));
