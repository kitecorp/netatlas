import { expect, it } from 'vitest';
import { eksToken, tokenDate } from './eks-token';
import { EXPECTED_TOKEN, REFERENCE } from './eks-token.fixture';

it('signs the token aws-iam-authenticator makes', async () => {
  const token = await eksToken(REFERENCE);

  expect([token, tokenDate(token)]).toEqual([EXPECTED_TOKEN, '20260102T030405Z']);
});
