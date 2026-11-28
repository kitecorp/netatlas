import { expect, test } from '@playwright/test';
import { kubectl } from './kube';

// Stops atlas-b's Prometheus (Istio's sample, the Deployment istio-system/prometheus) while the traffic
// view is open. The cluster itself stays reachable, so the overview still reads it; only the traffic
// says it is unavailable, and keeps its last figures with their age.
const ATLAS_B = 'kind-atlas-b';

const scalePrometheus = (replicas: number) => kubectl(ATLAS_B, '--namespace', 'istio-system', 'scale', 'deployment/prometheus', `--replicas=${replicas}`);

/** Prometheus back at one replica and ready, so the journeys after this one, and the next run, find it. */
function restorePrometheus() {
  scalePrometheus(1);
  kubectl(ATLAS_B, '--namespace', 'istio-system', 'rollout', 'status', 'deployment/prometheus', '--timeout=120s');
}

// The test restores it in a finally as soon as it ends; afterAll restores it again for a test that timed out.
test.afterAll(() => {
  test.setTimeout(150_000);
  restorePrometheus();
});

test('Prometheus scaled to zero shows "traffic unavailable since"', async ({ page }) => {
  test.setTimeout(150_000);
  await page.goto('/traffic/atlas-b');
  // Named by its mark: a call that failed while server was starting draws a second edge from client to a box
  // named server, the service nobody answered, for the 5 minutes the figures cover.
  const toServer = page.getByLabel(/^From client to server, .*, allowed by a policy$/);
  await expect(toServer).toBeVisible({ timeout: 60_000 });

  try {
    scalePrometheus(0);

    // The page is not reloaded: the next traffic poll fails, and the page renders again on it. With no
    // endpoint behind the NodePort, the connection is refused or times out.
    await expect(
      page.getByText(/^Traffic unavailable since \d\d:\d\d: Prometheus (refused the connection|stopped answering)\. Showing figures from (\d+ seconds|1 minute|\d+ minutes) ago\.$/),
    ).toBeVisible({ timeout: 90_000 });
    await expect(toServer).toBeVisible();

    await page.goto('/');
    await expect(page.getByRole('row', { name: /^atlas-b/ }).getByRole('cell').nth(6)).toHaveText('sidecars');
  } finally {
    restorePrometheus();
  }
});
