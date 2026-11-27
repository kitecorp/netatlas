import { expect, test } from '@playwright/test';

// The editor takes a token that may write, so every page and route keeps other sites from framing it,
// the browser from guessing types, and its address out of a Referer.
test('every answer carries the security headers', async ({ request }) => {
  const read = async (path: string) => {
    const h = (await request.get(path)).headers();
    return [h['content-security-policy'], h['x-content-type-options'], h['referrer-policy']];
  };
  const expected = ["frame-ancestors 'none'", 'nosniff', 'no-referrer'];
  expect([await read('/'), await read('/policies'), await read('/api/health')]).toStrictEqual([expected, expected, expected]);
});
