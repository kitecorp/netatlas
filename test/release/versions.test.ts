import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../scripts/release-versions.sh', import.meta.url));

interface Versions {
  packageJson: string;
  version: string;
  appVersion: string;
  /** The whole image reference of the first artifacthub.io/images entry. */
  image: string;
  /** The tag in the address of the second screenshot; the first is always at v1.2.3, so every address is read. */
  screenshot: string;
  /** A last images entry with this image, when set: the last line of the list is the one easiest to lose. */
  lastImage?: string;
  /** A last screenshots entry with this address, when set. */
  lastScreenshot?: string;
}

const AGREE: Versions = { packageJson: '1.2.3', version: '1.2.3', appVersion: '1.2.3', image: 'ghcr.io/kitecorp/netatlas:1.2.3', screenshot: 'v1.2.3' };

/** A Chart.yaml written as the chart's is, with the annotations as YAML inside a string. */
function chart(v: Versions) {
  return [
    'apiVersion: v2',
    'name: netatlas',
    `version: ${v.version}`,
    `appVersion: "${v.appVersion}"`,
    'annotations:',
    '  artifacthub.io/license: Apache-2.0',
    '  artifacthub.io/images: |',
    '    - name: netatlas',
    `      image: ${v.image}`,
    '      platforms:',
    '        - linux/amd64',
    ...(v.lastImage === undefined ? [] : ['    - name: second', `      image: ${JSON.stringify(v.lastImage)}`]),
    '  artifacthub.io/screenshots: |',
    '    - title: "Traffic: the calls Istio measured"',
    '      url: https://raw.githubusercontent.com/kitecorp/netatlas/v1.2.3/docs/screenshots/traffic.png',
    '    - title: Overview',
    `      url: https://raw.githubusercontent.com/kitecorp/netatlas/${v.screenshot}/docs/screenshots/overview.png`,
    ...(v.lastScreenshot === undefined ? [] : ['    - title: Fifth', `      url: ${JSON.stringify(v.lastScreenshot)}`]),
    '',
  ].join('\n');
}

/** Runs a copy of the check in a folder laid out as the repository is, holding the package.json and Chart.yaml given. */
function check(packageVersion: string, chartYaml: string, ...tag: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'netatlas-versions-'));
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'charts', 'netatlas'), { recursive: true });
  copyFileSync(script, join(root, 'scripts', 'release-versions.sh'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'netatlas', version: packageVersion }, null, 2));
  writeFileSync(join(root, 'charts', 'netatlas', 'Chart.yaml'), chartYaml);
  const run = spawnSync('bash', [join(root, 'scripts', 'release-versions.sh'), ...tag], { encoding: 'utf8' });
  return [run.status, run.stdout.trim(), run.stderr.split('\n').filter((line) => line !== '')];
}

const PACKAGE = 'package.json version is 1.2.3';
const PUSHES = 'the release pushes ghcr.io/kitecorp/netatlas:1.2.3';
const AT_TAG = 'each address must be a file at the tag v1.2.3 on raw.githubusercontent.com';
const TRAFFIC = 'https://raw.githubusercontent.com/kitecorp/netatlas/v1.2.3/docs/screenshots/traffic.png';
const OVERVIEW = 'https://raw.githubusercontent.com/kitecorp/netatlas/v1.2.3/docs/screenshots/overview.png';

// The release publishes the image and the chart under one version, so every place that names it must agree before a tag
// is pushed (CI runs the check with no tag) and with the tag itself (the release runs it with the tag).
it.each<[string, Partial<Versions>, string[], unknown[]]>([
  ['every place names one version', {}, [], [0, '1.2.3', []]],
  ['every place names the version of the tag', {}, ['v1.2.3'], [0, '1.2.3', []]],
  ['package.json differs from the tag', { packageJson: '1.2.4' }, ['v1.2.3'], [1, '', ['::error::package.json version is 1.2.4 where the tag is v1.2.3']]],
  ['the chart version differs', { version: '1.2.4' }, [], [1, '', [`::error::Chart.yaml version is 1.2.4 where ${PACKAGE}`]]],
  ['the appVersion differs', { appVersion: '1.2.4' }, [], [1, '', [`::error::Chart.yaml appVersion is 1.2.4 where ${PACKAGE}`]]],
  [
    'the image differs',
    { image: 'ghcr.io/kitecorp/netatlas:1.2.4' },
    [],
    [1, '', [`::error::Chart.yaml artifacthub.io/images names ghcr.io/kitecorp/netatlas:1.2.4 where ${PACKAGE}: ${PUSHES}`]],
  ],
  // The listing would show an image the release never pushed.
  [
    'the image is of another repository, with the version as its tag',
    { image: 'docker.io/library/nginx:1.2.3' },
    [],
    [1, '', [`::error::Chart.yaml artifacthub.io/images names docker.io/library/nginx:1.2.3 where ${PACKAGE}: ${PUSHES}`]],
  ],
  [
    'the last image entry is empty',
    { lastImage: '' },
    [],
    [1, '', [`::error::Chart.yaml artifacthub.io/images names an entry with no image where ${PACKAGE}: ${PUSHES}`]],
  ],
  // Only an address at the release's own tag shows that version's pictures: another tag shows another version's, and a
  // branch moves after the release.
  [
    'one screenshot is at another tag',
    { screenshot: 'v1.2.4' },
    [],
    [1, '', [`::error::Chart.yaml artifacthub.io/screenshots names https://raw.githubusercontent.com/kitecorp/netatlas/v1.2.4/docs/screenshots/overview.png where ${PACKAGE}: ${AT_TAG}`]],
  ],
  // ah lint passes an empty screenshot address, so this check is the one that stops a broken picture.
  [
    'the last screenshot entry is empty',
    { lastScreenshot: '' },
    [],
    [1, '', [`::error::Chart.yaml artifacthub.io/screenshots names an entry with no url where ${PACKAGE}: ${AT_TAG}`]],
  ],
  [
    'the tag differs from every place',
    {},
    ['v1.2.4'],
    [
      1,
      '',
      [
        '::error::package.json version is 1.2.3 where the tag is v1.2.4',
        '::error::Chart.yaml version is 1.2.3 where the tag is v1.2.4',
        '::error::Chart.yaml appVersion is 1.2.3 where the tag is v1.2.4',
        '::error::Chart.yaml artifacthub.io/images names ghcr.io/kitecorp/netatlas:1.2.3 where the tag is v1.2.4: the release pushes ghcr.io/kitecorp/netatlas:1.2.4',
        `::error::Chart.yaml artifacthub.io/screenshots names ${TRAFFIC} where the tag is v1.2.4: each address must be a file at the tag v1.2.4 on raw.githubusercontent.com`,
        `::error::Chart.yaml artifacthub.io/screenshots names ${OVERVIEW} where the tag is v1.2.4: each address must be a file at the tag v1.2.4 on raw.githubusercontent.com`,
      ],
    ],
  ],
])('%s', (_name, change, tag, expected) => {
  const v = { ...AGREE, ...change };

  expect(check(v.packageJson, chart(v), ...tag)).toStrictEqual(expected);
});

// A check that finds nothing to compare would pass whatever the release publishes.
it('refuses a chart whose annotations name no image and no screenshot', () => {
  const bare = ['apiVersion: v2', 'name: netatlas', 'version: 1.2.3', 'appVersion: "1.2.3"', ''].join('\n');

  expect(check('1.2.3', bare)).toStrictEqual([
    1,
    '',
    ['::error::Chart.yaml artifacthub.io/images names no image', '::error::Chart.yaml artifacthub.io/screenshots names no address'],
  ]);
});

// yq's own reason follows on the next line; its words belong to yq, so only the first line is compared.
it('says which annotation it cannot read, rather than passing it', () => {
  const [status, stdout, stderr] = check('1.2.3', chart(AGREE).replace('    - name: netatlas\n', '    - name: [netatlas\n'));

  expect([status, stdout, (stderr as string[])[0]]).toStrictEqual([1, '', '::error::yq could not read Chart.yaml artifacthub.io/images:']);
});
