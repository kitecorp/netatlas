import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../scripts/release-unpublished.sh', import.meta.url));

/** Runs the check with a `docker` on PATH that prints `output` to stderr and exits with `status`. */
function check(output: string, status: number) {
  const bin = mkdtempSync(join(tmpdir(), 'netatlas-docker-'));
  writeFileSync(join(bin, 'docker'), `#!/usr/bin/env bash\nprintf '%s\\n' ${JSON.stringify(output)} >&2\nexit ${status}\n`);
  chmodSync(join(bin, 'docker'), 0o755);
  const run = spawnSync('bash', [script, 'ghcr.io/kitecorp/netatlas:0.1.0'], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` } });
  return [run.status, run.stdout.trim()];
}

// A version is released only when the registry says clearly that it is not there; anything else stops.
it.each<[string, string, number, (string | number | null)[]]>([
  ['the registry has the image', 'Name: ghcr.io/kitecorp/netatlas:0.1.0', 0, [1, '::error::ghcr.io/kitecorp/netatlas:0.1.0 is already published']],
  ['the registry says not found', 'ERROR: ghcr.io/kitecorp/netatlas:0.1.0: not found', 1, [0, 'ghcr.io/kitecorp/netatlas:0.1.0 is not published yet']],
  [
    'the registry fails to answer',
    'ERROR: failed to authorize: unexpected status from GET request to https://ghcr.io/token: 503 Service Unavailable',
    1,
    [1, '::error::cannot tell whether ghcr.io/kitecorp/netatlas:0.1.0 is published: ERROR: failed to authorize: unexpected status from GET request to https://ghcr.io/token: 503 Service Unavailable'],
  ],
])('%s', (_name, output, status, expected) => {
  expect(check(output, status)).toStrictEqual(expected);
});
