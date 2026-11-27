import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parse, parseAllDocuments } from 'yaml';
import { WATCHED } from './direct';
import { EXPECTED, grants, READ_ONLY, type Rule } from './reader-kinds.fixture';

/** A file read from the repository root. */
const repoFile = (path: string): string => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');

const accessManifest = () => parseAllDocuments(repoFile('deploy/reader-access.yaml')).map((d) => d.toJS() as { kind: string; type?: string; metadata: { name: string; namespace?: string; annotations?: Record<string, string> }; rules?: Rule[] });

it('the reader role grants read on exactly the watched kinds', () => expect(grants(parse(repoFile('charts/netatlas/files/reader-rules.yaml')))).toEqual(READ_ONLY));

it('the direct source watches exactly those kinds', () => expect(WATCHED.map((w) => `${w.group}/${w.resource}`)).toEqual(EXPECTED));

it("the reader access manifest's ClusterRole grants read on exactly the watched kinds", () =>
  expect(grants(accessManifest().find((d) => d.kind === 'ClusterRole')?.rules ?? [])).toEqual(READ_ONLY));

it('the reader access manifest makes the account, its binding and its long-lived token', () =>
  expect(accessManifest().map((d) => [d.kind, d.metadata.namespace ?? '', d.metadata.name, d.type ?? '', d.metadata.annotations?.['kubernetes.io/service-account.name'] ?? ''])).toEqual([
    ['Namespace', '', 'netatlas-access', '', ''],
    ['ServiceAccount', 'netatlas-access', 'netatlas-reader', '', ''],
    ['ClusterRole', '', 'netatlas-reader', '', ''],
    ['ClusterRoleBinding', '', 'netatlas-reader', '', ''],
    ['Secret', 'netatlas-access', 'netatlas-reader-token', 'kubernetes.io/service-account-token', 'netatlas-reader'],
  ]));

it('the reader access manifest binds that role to that account', () => {
  const binding = accessManifest().find((d) => d.kind === 'ClusterRoleBinding') as unknown as { roleRef: unknown; subjects: unknown };
  expect([binding.roleRef, binding.subjects]).toEqual([
    { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'netatlas-reader' },
    [{ kind: 'ServiceAccount', name: 'netatlas-reader', namespace: 'netatlas-access' }],
  ]);
});
