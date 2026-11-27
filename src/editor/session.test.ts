import { describe, expect, it } from 'vitest';
import type { NetworkPolicyObject } from '@/model/types';
import { isOpen, specOf } from './draft';
import { CART_ALLOW } from './fixtures';
import { applyBody, reduce, reviewOf, saveState, staleNote, startSession, type Session, type SessionAction } from './session';

const run = (s: Session, ...actions: SessionAction[]) => actions.reduce(reduce, s);

const RECOMMENDER = { group: 'namespace', kind: 'labels', pod: 'app=recommender', ports: '8080' } as const;
const KUBE_DNS = {
  to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } }, podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } } }],
  ports: [
    { port: 53, protocol: 'UDP' },
    { port: 53, protocol: 'TCP' },
  ],
};
const TO_API = { to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'payments' } }, podSelector: { matchLabels: { app: 'api' } } }], ports: [{ port: 8443, protocol: 'TCP' }] };

/** cart-allow with the recommender rule added in, as the editor writes it. */
const WITH_RECOMMENDER = {
  podSelector: { matchLabels: { app: 'cart' } },
  policyTypes: ['Ingress', 'Egress'],
  ingress: [
    { from: [{ podSelector: { matchLabels: { app: 'frontend' } } }], ports: [{ port: 8080, protocol: 'TCP' }] },
    { from: [{ podSelector: { matchLabels: { app: 'recommender' } } }], ports: [{ port: 8080, protocol: 'TCP' }] },
  ],
  egress: [TO_API, KUBE_DNS],
};

const reviewing = () => run(startSession(CART_ALLOW), { type: 'add', side: 'in', input: RECOMMENDER }, { type: 'review' }, { type: 'token-panel', open: true }, { type: 'token', token: 'secret-token' });

it("starts on the cluster's version, editing, with nothing open", () => {
  const s = startSession(CART_ALLOW);
  expect({ ...s, draft: reviewOf(s.draft).changes }).toStrictEqual({
    draft: 'No changes. This is what the cluster has now.',
    phase: 'editing',
    menu: null,
    form: null,
    tokenOpen: false,
    token: '',
    message: null,
    latest: null,
    replaced: null,
  });
});

it("shows the cluster's new version after Apply, with no changes left", () => {
  const applied: NetworkPolicyObject = { ...CART_ALLOW, metadata: { ...CART_ALLOW.metadata, resourceVersion: '48250' }, spec: WITH_RECOMMENDER as NetworkPolicyObject['spec'] };
  const s = reduce(reviewing(), { type: 'applied', policy: applied });
  expect([s.phase, s.message, s.token, s.tokenOpen, reviewOf(s.draft).changed, applyBody(s).resourceVersion]).toStrictEqual([
    'editing',
    { tone: 'ok', text: 'Applied. The cluster now has this version.' },
    '',
    false,
    0,
    '48250',
  ]);
});

// A render made from the store before the write can arrive after it; the version Apply replaced is not newer.
it('keeps the applied version when a late render brings the version it replaced', () => {
  const applied: NetworkPolicyObject = { ...CART_ALLOW, metadata: { ...CART_ALLOW.metadata, resourceVersion: '48250' }, spec: WITH_RECOMMENDER as NetworkPolicyObject['spec'] };
  const s = run(reviewing(), { type: 'applied', policy: applied }, { type: 'cluster', policy: CART_ALLOW });
  expect([applyBody(s).resourceVersion, specOf(s.draft), s.latest]).toStrictEqual(['48250', WITH_RECOMMENDER, null]);
});

it("keeps the draft and shows Kubernetes' message when refused", () => {
  const s = reduce(reviewing(), { type: 'refused', message: 'Kubernetes refused the change: denied' });
  expect([s.phase, s.message, s.token, specOf(s.draft)]).toStrictEqual(['reviewing', { tone: 'warn', text: 'Kubernetes refused the change: denied' }, '', WITH_RECOMMENDER]);
});

it("sends the token, the draft's resourceVersion and its spec", () => {
  expect(applyBody(reviewing())).toStrictEqual({ token: 'secret-token', resourceVersion: '48213', spec: WITH_RECOMMENDER });
});

describe('clearing', () => {
  const withMessage = () => reduce(reviewing(), { type: 'refused', message: 'Kubernetes refused the change: denied' });

  it.each<[string, SessionAction]>([
    ['toggle', { type: 'toggle', side: 'out' }],
    ['add', { type: 'add', side: 'out', input: { group: 'outside', kind: 'any', ports: '443' } }],
    ['remove', { type: 'remove', side: 'in', id: 'in:1:0' }],
    ['discard', { type: 'discard' }],
  ])('an edit clears the message: %s', (_name, action) => {
    expect(reduce(withMessage(), action).message).toBe(null);
  });

  it('closing the token panel forgets the token', () => {
    const s = reduce(reviewing(), { type: 'token-panel', open: false });
    expect([s.tokenOpen, s.token]).toStrictEqual([false, '']);
  });

  it('going back to editing closes the token panel and forgets the token', () => {
    const s = reduce(reviewing(), { type: 'back' });
    expect([s.phase, s.tokenOpen, s.token]).toStrictEqual(['editing', false, '']);
  });
});

describe('the Add rule menu and form', () => {
  it('opening a menu closes any form, and picking an option keeps the menu so the form knows its side', () => {
    const s = run(startSession(CART_ALLOW), { type: 'menu', menu: 'in:namespace' }, { type: 'form', form: { group: 'namespace', kind: 'labels', pod: '', ports: '' } });
    expect([s.menu, s.form]).toStrictEqual(['in:namespace', { group: 'namespace', kind: 'labels', pod: '', ports: '' }]);
  });

  it('adding a rule closes the menu and the form', () => {
    const s = run(startSession(CART_ALLOW), { type: 'menu', menu: 'in:namespace' }, { type: 'form', form: RECOMMENDER }, { type: 'add', side: 'in', input: RECOMMENDER });
    expect([s.menu, s.form, specOf(s.draft)]).toStrictEqual([null, null, WITH_RECOMMENDER]);
  });

  it('a form that does not parse adds nothing and stays open', () => {
    const bad = { group: 'namespace', kind: 'labels', pod: 'app=', ports: 'http' } as const;
    const s = run(startSession(CART_ALLOW), { type: 'menu', menu: 'in:namespace' }, { type: 'form', form: bad }, { type: 'add', side: 'in', input: bad });
    expect([s.menu, s.form, reviewOf(s.draft).changed]).toStrictEqual(['in:namespace', bad, 0]);
  });
});

it('discard goes back to the cluster version', () => {
  const s = run(startSession(CART_ALLOW), { type: 'toggle', side: 'in' }, { type: 'discard' });
  expect([isOpen(s.draft, 'in'), reviewOf(s.draft).changed, s.phase]).toStrictEqual([false, 0, 'editing']);
});

it.each<[string, boolean, string]>([
  ['Copy YAML worked', true, "{\"tone\":\"ok\",\"text\":\"Copied. Paste it over the policy's file in git.\"}"],
  // The YAML to select is shown on its own, since the review's text is the line difference with its marks.
  ['the browser blocked the copy', false, '{"tone":"warn","text":"The browser blocked the copy. Select the YAML below and copy it.","select":true}'],
])('copied: %s', (_name, ok, expected) => {
  expect(JSON.stringify(reduce(reviewing(), { type: 'copied', ok }).message)).toBe(expected);
});

describe('reviewOf', () => {
  it('opening calls in removes Ingress from policyTypes and the 8-line ingress block', () => {
    const r = reviewOf(reduce(startSession(CART_ALLOW), { type: 'toggle', side: 'in' }).draft);
    expect([r.changes, r.diff.filter((l) => l.kind !== 'same').map((l) => `${l.kind === 'added' ? '+' : '-'} ${l.text}`)]).toStrictEqual([
      '9 lines changed, not saved',
      [
        '-     - Ingress',
        '-   ingress:',
        '-     - from:',
        '-         - podSelector:',
        '-             matchLabels:',
        '-               app: frontend',
        '-       ports:',
        '-         - port: 8080',
        '-           protocol: TCP',
      ],
    ]);
  });

  it('gives the YAML Copy YAML copies, without what the server keeps for itself', () => {
    expect(reviewOf(startSession(CART_ALLOW).draft).yaml.split('\n').slice(0, 6)).toStrictEqual([
      'apiVersion: networking.k8s.io/v1',
      'kind: NetworkPolicy',
      'metadata:',
      '  name: cart-allow',
      '  namespace: shop',
      '  labels:',
    ]);
  });
});

describe('saveState', () => {
  it.each<[string, SessionAction[], boolean, boolean, ReturnType<typeof saveState>]>([
    ['a draft with a side restricted, on a cluster netatlas reaches', [], true, true, { copy: true, apply: true, banner: null, applyNote: null }],
    [
      'both sides open',
      [
        { type: 'toggle', side: 'in' },
        { type: 'toggle', side: 'out' },
      ],
      true,
      true,
      { copy: false, apply: false, banner: 'Both sides are open, so this policy blocks nothing. netatlas does not delete policies: remove it with kubectl or from git.', applyNote: null },
    ],
    ['a cluster netatlas cannot reach', [], false, true, { copy: true, apply: false, banner: null, applyNote: 'netatlas cannot reach this cluster now, so it cannot apply. Copy YAML still works.' }],
    // A token sent over plain HTTP could be read on the way, so Apply needs HTTPS or localhost.
    [
      'a page without a secure context',
      [],
      true,
      false,
      { copy: true, apply: false, banner: null, applyNote: 'Apply needs netatlas to be opened over HTTPS or through kubectl port-forward, so the token is not sent in plain text. Copy YAML still works.' },
    ],
  ])('%s', (_name, actions, reachable, secure, expected) => {
    expect(saveState(run(startSession(CART_ALLOW), ...actions), reachable, secure)).toStrictEqual(expected);
  });
});

// The page renders again on every change in the cluster; the editor follows the cluster's version.
describe('a newer version of the policy in the cluster', () => {
  const NEWER: NetworkPolicyObject = {
    ...CART_ALLOW,
    metadata: { ...CART_ALLOW.metadata, resourceVersion: '48300' },
    spec: { ...CART_ALLOW.spec, ingress: [...(CART_ALLOW.spec.ingress ?? []), { from: [{ podSelector: { matchLabels: { app: 'gateway' } } }] }] },
  };
  const CHANGED = "This policy changed in the cluster since you started. Your draft is based on the older version.";

  it('restarts an untouched draft from it', () => {
    const s = reduce(startSession(CART_ALLOW), { type: 'cluster', policy: NEWER });
    expect([s.latest, applyBody(s).resourceVersion, reviewOf(s.draft).changes]).toStrictEqual([null, '48300', 'No changes. This is what the cluster has now.']);
  });

  it('keeps a changed draft, says the cluster moved on, and shows the difference from the newer version', () => {
    const s = run(startSession(CART_ALLOW), { type: 'add', side: 'in', input: RECOMMENDER }, { type: 'cluster', policy: NEWER });
    const r = reviewOf(s.draft, s.latest ?? undefined);
    expect([staleNote(s), applyBody(s).resourceVersion, specOf(s.draft), r.diff.filter((l) => l.kind !== 'same').map((l) => `${l.kind === 'added' ? '+' : '-'} ${l.text}`)]).toStrictEqual([
      CHANGED,
      '48213',
      WITH_RECOMMENDER,
      // The gateway rule the cluster added would go with a copy of this draft, so the review shows it removed.
      ['-               app: gateway', '+               app: recommender', '+       ports:', '+         - port: 8080', '+           protocol: TCP'],
    ]);
  });

  it("starts again from the cluster's version, and so does Discard", () => {
    const changed = run(startSession(CART_ALLOW), { type: 'add', side: 'in', input: RECOMMENDER }, { type: 'cluster', policy: NEWER });
    const restart = reduce(changed, { type: 'restart' }), discard = reduce(changed, { type: 'discard' });
    expect([restart, discard].map((s) => [staleNote(s), applyBody(s).resourceVersion, reviewOf(s.draft).changed])).toStrictEqual([
      [null, '48300', 0],
      [null, '48300', 0],
    ]);
  });

  it('changes nothing for the version the draft began from', () => {
    const s = startSession(CART_ALLOW);
    expect(reduce(s, { type: 'cluster', policy: CART_ALLOW }) === s).toBe(true);
  });
});
