import { expect, type Locator, type Page } from '@playwright/test';

/**
 * A laptop screen. Laid out top to bottom, atlas-b's maps fit its width at full size, so a row at this size
 * cannot tell a map the browser scaled down from one it left at 100%; the 375 pixel rows can (`expectFitsPhone`).
 */
export const WIDE = { width: 1440, height: 900 };

/**
 * atlas-b's namespaces the map shows by default, kube-system and the root namespace istio-system being hidden.
 * The checks below need these and never forbid more: a namespace a journey made, left by a run that was stopped
 * before it deleted it, is drawn too, and truthfully.
 */
const ATLAS_B_NAMESPACES = ['ingress', 'local-path-storage', 'payments', 'shop', 'traffic'];

/** React Flow gives each node it draws the test id `rf__node-<node id>`; a namespace box's node id is `namespace:<name>`. */
const namespaceBoxes = (page: Page) => page.getByTestId(/^rf__node-namespace:/);

/** Waits until the map draws a box for each of atlas-b's default namespaces. */
async function expectAtlasBNamespaces(page: Page): Promise<void> {
  for (const name of ATLAS_B_NAMESPACES) await expect(page.getByTestId(`rf__node-namespace:${name}`)).toBeVisible();
}

/** Each namespace box's title, `namespace <name>`, wherever the map draws it: in the box's corner, or in a layer above the lines. */
export const namespaceTitles = (page: Page) => page.getByRole('application').getByText(/^namespace /);

/**
 * The boxes atlas-b's map draws with its default namespaces, on either page: its workloads, and the Internet, which
 * one component draws too. The traffic page can draw more, all truthful: a call that failed while a pod was still
 * starting draws a box for the service nobody answered (`service:<host>`) for the 5 minutes the figures cover. So
 * the checks need these boxes and never forbid others.
 */
const ATLAS_B_BOXES = [
  'rf__node-ingress/Deployment/gateway',
  'rf__node-local-path-storage/Deployment/local-path-provisioner',
  'rf__node-outside',
  'rf__node-payments/Deployment/api',
  'rf__node-payments/Deployment/postgres',
  'rf__node-shop/Deployment/cart',
  'rf__node-shop/Deployment/frontend',
  'rf__node-shop/Deployment/recommender',
  'rf__node-traffic/Deployment/client',
  'rf__node-traffic/Deployment/server',
];

interface Box {
  readonly x: number;
  readonly y: number;
  readonly right: number;
  readonly bottom: number;
}

/** Two rectangles overlap when they share more than an edge; half a pixel allows for rounding in the scaled map. */
const overlap = (a: Box, b: Box) => a.x < b.right - 0.5 && b.x < a.right - 0.5 && a.y < b.bottom - 0.5 && b.y < a.bottom - 0.5;

/** What the edge labels of the map lie on, each as `<label> on <what>`: the workload boxes and the Internet by their test ids, the namespace titles by their text. */
export interface LabelsOn {
  readonly boxes: readonly string[];
  readonly titles: readonly string[];
}

/**
 * Reads the map of atlas-b open on the page and says which edge labels lie on a box or on a namespace title.
 * `label` matches every text an edge label of that page shows. A label is measured as it is drawn: its text on
 * its background, which React Flow puts in one group, so the group's rectangle is the whole label. React Flow
 * sizes that background in the browser and hides the label until then, so the labels are read once all show.
 */
export async function edgeLabelsOn(page: Page, label: RegExp): Promise<LabelsOn> {
  const map = page.getByRole('application');
  // Every node but the namespace boxes, by React Flow's test id `rf__node-<node id>`.
  const boxes = map.getByTestId(/^rf__node-(?!namespace:)/);
  const labels = map.getByText(label);
  // One label per edge, so a label the pattern misses fails here rather than passing unseen.
  await expect(labels).toHaveCount(await map.getByLabel(/^From /).count());
  for (const l of await labels.all()) await expect(l).toBeVisible();

  // All read in one call, so the map cannot move between them.
  const seen = await boxes
    .or(namespaceTitles(page))
    .or(labels)
    .evaluateAll((els) =>
      els.map((e) => {
        const id = e.getAttribute('data-testid'), text = e.textContent ?? '';
        // No edge label and no workload's box says `namespace ...`, so the text tells a title wherever it is drawn.
        const kind = text.startsWith('namespace ') ? 'title' : id !== null ? 'box' : 'label';
        const r = (kind === 'label' ? (e.parentElement ?? e) : e).getBoundingClientRect();
        return { kind, name: kind === 'box' ? (id ?? '') : text, rect: { x: r.x, y: r.y, right: r.right, bottom: r.bottom } };
      }),
    );
  const of = (kind: string) => seen.filter((s) => s.kind === kind);
  // Each list holds at least one name, so a read that found no box or no title fails here.
  expect(of('box').map((b) => b.name)).toEqual(expect.arrayContaining(ATLAS_B_BOXES));
  expect(of('title').map((t) => t.name)).toEqual(expect.arrayContaining(ATLAS_B_NAMESPACES.map((n) => `namespace ${n}`)));

  const lyingOn = (under: typeof seen) => of('label').flatMap((l) => under.filter((u) => overlap(l.rect, u.rect)).map((u) => `${l.name} on ${u.name}`));
  return { boxes: lyingOn(of('box')), titles: lyingOn(of('title')) };
}

/** Every workload box is 176 pixels wide at 100%, so the width it is drawn at over 176 is the scale of the map. */
const WORKLOAD_WIDTH = 176;

/** The scale the map is drawn at, read from atlas-b's client box. */
const scaleOf = async (page: Page) => ((await page.getByTestId('rf__node-traffic/Deployment/client').boundingBox())?.width ?? 0) / WORKLOAD_WIDTH;

/**
 * Checks that the box lies whole inside the map box. Playwright's viewport ratio is an IntersectionObserver's,
 * which clips the box by every ancestor that clips its content, so a box the map box cuts off reads below 1.
 * The check asks for 0.99, since Chromium reads a box drawn wholly inside at 0.99999994. The ratio also needs
 * the box on the screen, and a map laid out top to bottom can reach below a 900 pixel screen, so the page alone
 * is scrolled to the box first: `scrollIntoViewIfNeeded` would also scroll the map box, which clips the map,
 * and could bring a box it cuts off into view. Both run again until the check holds, because the map may be
 * fitted to its box after the scroll, which moves the box.
 */
async function expectWholeInMapBox(box: Locator): Promise<void> {
  await expect(async () => {
    await box.evaluate((e) => {
      const r = e.getBoundingClientRect();
      window.scrollBy(0, r.top + r.height / 2 - window.innerHeight / 2);
    });
    await expect(box).toBeInViewport({ ratio: 0.99, timeout: 1_000 });
    // toPass alone has no time limit; 5 s is Playwright's expect timeout.
  }).toPass({ timeout: 5_000 });
}

/** Checks that every namespace box the map draws, atlas-b's own among them, lies whole inside the map box. */
async function expectNamespacesInMapBox(page: Page): Promise<void> {
  await expectAtlasBNamespaces(page);
  for (const box of await namespaceBoxes(page).all()) await expectWholeInMapBox(box);
}

/**
 * Opens a map of atlas-b at 1440 by 900 and checks that every namespace box lies whole inside the map box. The
 * server draws the map at 100% from the top left, and atlas-b's maps fit this width at that size, so this holds
 * whether or not the browser scales the map; `expectFitsPhone` is the check that needs it scaled down.
 */
export async function expectMapFits(page: Page, path: string): Promise<void> {
  await page.setViewportSize(WIDE);
  await page.goto(path);
  await expectNamespacesInMapBox(page);
}

/**
 * Opens a map of atlas-b at 1440 by 900, checks that it fits its box (`expectMapFits`), then that Zoom In
 * makes the map larger. Returns the scale read once those checks pass, which may be before the browser scaled
 * the map.
 */
export async function expectMapFitsAndZooms(page: Page, path: string): Promise<number> {
  await expectMapFits(page, path);

  // Read once the checks above pass. They hold whether or not the browser has scaled the map (`expectMapFits`), so
  // this is the scale the map is drawn at then, scaled or not; Zoom In must make the map larger than that.
  const fitted = await scaleOf(page);
  await page.getByRole('button', { name: 'Zoom In', exact: true }).click();
  await expect.poll(() => scaleOf(page)).toBeGreaterThan(fitted);
  return fitted;
}

/**
 * Opens a map of atlas-b on a 375 pixel wide phone and checks that the page scrolls no wider than the screen,
 * and that every namespace box lies whole inside the map box. At this width the map at 100% is wider than its
 * box, which clips it, so the boxes lie inside only once the browser has scaled the map down to fit.
 */
export async function expectFitsPhone(page: Page, path: string): Promise<void> {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(path);
  await expectAtlasBNamespaces(page);

  expect(await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth])).toStrictEqual([375, 375]);
  await expectNamespacesInMapBox(page);
}

/**
 * The titles of the namespace boxes on the map open on the page that an edge's line is drawn over, by title. A
 * line may pass behind a title; it may not be painted over the title's text. Each line is followed along its path
 * a pixel at a time, and at each point inside a title's text the browser says what it paints there, topmost first
 * (`elementsFromPoint`). That list holds only what takes pointer events, and React Flow turns them off for an
 * edge nobody can click and a node nobody can drag; so the read turns them on for the lines and the titles, which
 * changes what a point hits, never what is painted over what. The page is scrolled to each title first, because
 * the browser answers only for points on the screen. Fails when no line crosses any title at all, so a map whose
 * lines all miss the titles cannot pass unchecked.
 */
export async function titlesUnderLines(page: Page): Promise<readonly string[]> {
  const map = page.getByRole('application');
  const read = await namespaceTitles(page)
    .or(map.getByLabel(/^From /))
    .evaluateAll((els) => {
      // An edge is drawn as a group with the role img and its spoken label, and its first path is the line (React Flow's BaseEdge).
      const lines = els.filter((e) => e.getAttribute('role') === 'img').flatMap((g) => g.querySelector('path') ?? []);
      const titles = els.filter((e): e is HTMLElement => e instanceof HTMLElement);
      for (const e of [...lines, ...titles]) e.style.pointerEvents = e instanceof HTMLElement ? 'auto' : 'visibleStroke';
      const crossed = new Set<string>(), over = new Set<string>();
      for (const title of titles) {
        const name = title.textContent ?? '';
        const text = document.createRange();
        text.selectNodeContents(title);
        const first = text.getBoundingClientRect();
        window.scrollBy(0, first.top + first.height / 2 - window.innerHeight / 2);
        const r = text.getBoundingClientRect();
        for (const line of lines) {
          const toScreen = line.getScreenCTM();
          if (!toScreen) continue;
          for (let at = 0, length = line.getTotalLength(); at <= length; at += 1) {
            const p = line.getPointAtLength(at).matrixTransform(toScreen);
            if (p.x <= r.left || p.x >= r.right || p.y <= r.top || p.y >= r.bottom) continue;
            // Only where the browser finds both: the text's box can reach past the title's own, where nothing of it is painted.
            const painted = document.elementsFromPoint(p.x, p.y), lineAt = painted.indexOf(line), titleAt = painted.indexOf(title);
            if (lineAt === -1 || titleAt === -1) continue;
            crossed.add(name);
            if (lineAt < titleAt) over.add(name);
          }
        }
      }
      for (const e of [...lines, ...titles]) e.style.pointerEvents = '';
      return { crossed: [...crossed], over: [...over].sort() };
    });
  expect(read.crossed, 'some line of the map crosses a namespace title, so the check has a point to read').not.toStrictEqual([]);
  return read.over;
}
