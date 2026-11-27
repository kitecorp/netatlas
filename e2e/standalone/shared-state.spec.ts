import { expect, test } from '@playwright/test';

// register() runs from a bundle separate from the route handlers and pages, so this proves both
// read the one store it fills, in the server the container image runs.
test('the state register() writes is the state route handlers and pages read', async ({ request, page }) => {
  await expect
    .poll(async () => (await request.get('/api/health')).json(), { timeout: 30_000 })
    .toEqual({ status: 'ok', clusters: [{ name: 'fixture-down', state: 'unreachable' }] });
  await page.goto('/');
  await expect(page.getByRole('row', { name: /fixture-down/ })).toContainText('the API server refused the connection');
});
