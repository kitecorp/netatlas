import { CANNOT_APPLY } from '@/model/format';
import type { NetworkPolicyObject, NetworkPolicySpec } from '@/model/types';
import { changedCount, changesText, diffLines, type DiffLine } from './diff';
import { addRule, baseOf, canSave, draftFromPolicy, removeRow, specOf, toggleSide, type Draft, type RuleInput, type Side } from './draft';
import { forDisplay, toYaml } from './yaml';

// The editor's state between the cluster's version and the one write. The token lives here, in the
// browser tab's memory only: it is cleared after every Apply, refused or not, and when the panel closes.

/** `select` asks for the YAML to be shown on its own, ready to select, when the browser blocked the copy. */
export type Message = { readonly tone: 'ok' | 'warn'; readonly text: string; readonly select?: true };

export interface Session {
  readonly draft: Draft;
  readonly phase: 'editing' | 'reviewing';
  /** The open Add rule menu, as `<side>:<group>`. It stays set while the menu's form is open, so the form knows where it adds. */
  readonly menu: string | null;
  readonly form: RuleInput | null;
  readonly tokenOpen: boolean;
  readonly token: string;
  readonly message: Message | null;
  /** The cluster's version when it moved on from the one the changed draft began from; null otherwise. */
  readonly latest: NetworkPolicyObject | null;
  /** The resourceVersion the last Apply replaced, which a render made before the write can still bring. */
  readonly replaced: string | null;
}

export type SessionAction =
  | { readonly type: 'toggle'; readonly side: Side }
  | { readonly type: 'menu'; readonly menu: string | null }
  | { readonly type: 'form'; readonly form: RuleInput | null }
  | { readonly type: 'add'; readonly side: Side; readonly input: RuleInput }
  | { readonly type: 'remove'; readonly side: Side; readonly id: string }
  | { readonly type: 'review' }
  | { readonly type: 'back' }
  | { readonly type: 'discard' }
  | { readonly type: 'token-panel'; readonly open: boolean }
  | { readonly type: 'token'; readonly token: string }
  | { readonly type: 'copied'; readonly ok: boolean }
  | { readonly type: 'applied'; readonly policy: NetworkPolicyObject }
  | { readonly type: 'refused'; readonly message: string }
  /** The policy as the page rendered it from the cluster now. */
  | { readonly type: 'cluster'; readonly policy: NetworkPolicyObject }
  | { readonly type: 'restart' };

const APPLIED = 'Applied. The cluster now has this version.';
const COPIED = "Copied. Paste it over the policy's file in git.";
const COPY_BLOCKED = 'The browser blocked the copy. Select the YAML below and copy it.';
const BOTH_OPEN = 'Both sides are open, so this policy blocks nothing. netatlas does not delete policies: remove it with kubectl or from git.';
const NEEDS_HTTPS = 'Apply needs netatlas to be opened over HTTPS or through kubectl port-forward, so the token is not sent in plain text. Copy YAML still works.';
const CHANGED_IN_CLUSTER = 'This policy changed in the cluster since you started. Your draft is based on the older version.';

export function startSession(p: NetworkPolicyObject): Session {
  return { draft: draftFromPolicy(p), phase: 'editing', menu: null, form: null, tokenOpen: false, token: '', message: null, latest: null, replaced: null };
}

const versionOf = (p: NetworkPolicyObject) => p.metadata.resourceVersion ?? '';

/**
 * A newer version from the cluster. A draft with no changes starts again from it and keeps what is
 * open; a changed draft keeps its edits and remembers the newer version, so the review shows what a
 * copy of the draft would undo there.
 */
function followCluster(s: Session, p: NetworkPolicyObject): Session {
  const latest = s.latest ?? baseOf(s.draft);
  // Kubernetes asks clients not to order resourceVersions, so the replaced one is known by equality only.
  if (versionOf(p) === versionOf(latest) || versionOf(p) === s.replaced) return s;
  if (versionOf(p) === versionOf(baseOf(s.draft))) return { ...s, latest: null };
  return reviewOf(s.draft).changed === 0 ? { ...s, draft: draftFromPolicy(p), latest: null } : { ...s, latest: p };
}

/** A change to the draft: the old message no longer describes it. */
const edited = (s: Session, draft: Draft): Session => ({ ...s, draft, message: null });

export function reduce(s: Session, a: SessionAction): Session {
  switch (a.type) {
    case 'toggle':
      return { ...edited(s, toggleSide(s.draft, a.side)), menu: null, form: null };
    case 'menu':
      return { ...s, menu: a.menu, form: null };
    case 'form':
      return { ...s, form: a.form };
    case 'add': {
      const draft = addRule(s.draft, a.side, a.input);
      // addRule gives the same draft back for a form that does not parse, which then stays open.
      return draft === s.draft ? s : { ...edited(s, draft), menu: null, form: null };
    }
    case 'remove':
      return edited(s, removeRow(s.draft, a.side, a.id));
    case 'review':
      return { ...s, phase: 'reviewing', menu: null, form: null, message: null };
    case 'back':
      return { ...s, phase: 'editing', tokenOpen: false, token: '', message: null };
    case 'discard':
    case 'restart':
      return startSession(s.latest ?? baseOf(s.draft));
    case 'token-panel':
      return { ...s, tokenOpen: a.open, token: a.open ? s.token : '' };
    case 'token':
      return { ...s, token: a.token };
    case 'copied':
      return { ...s, message: a.ok ? { tone: 'ok', text: COPIED } : { tone: 'warn', text: COPY_BLOCKED, select: true } };
    case 'applied':
      return { ...startSession(a.policy), message: { tone: 'ok', text: APPLIED }, replaced: versionOf(baseOf(s.draft)) };
    case 'refused':
      return { ...s, token: '', message: { tone: 'warn', text: a.message } };
    case 'cluster':
      return followCluster(s, a.policy);
  }
}

/** What the editor says while the cluster holds a newer version than the one the changed draft began from. */
export const staleNote = (s: Session): string | null => (s.latest ? CHANGED_IN_CLUSTER : null);

/** The YAML text without the empty line after its last newline, as lines. */
const linesOf = (yaml: string) => yaml.replace(/\n$/, '').split('\n');

/**
 * The draft's YAML (what Copy YAML copies), its lines, and its line difference from the cluster's
 * version: `cluster` when the cluster moved on since the draft began, else the version it began from.
 */
export function reviewOf(d: Draft, cluster?: NetworkPolicyObject): { yaml: string; lines: string[]; diff: DiffLine[]; changes: string; changed: number } {
  const base = baseOf(d);
  const yaml = toYaml(forDisplay({ ...base, spec: specOf(d) }));
  const lines = linesOf(yaml);
  const diff = diffLines(linesOf(toYaml(forDisplay(cluster ?? base))), lines);
  const changed = changedCount(diff);
  return { yaml, lines, diff, changes: changesText(changed), changed };
}

/** The body of the Apply request. The resourceVersion is the one the draft began from, so Kubernetes refuses to overwrite a newer version. */
export function applyBody(s: Session): { token: string; resourceVersion: string; spec: NetworkPolicySpec } {
  return { token: s.token, resourceVersion: baseOf(s.draft).metadata.resourceVersion ?? '', spec: specOf(s.draft) };
}

/**
 * Whether Copy YAML and Apply are offered, and why not. With both sides open the policy would block
 * nothing, and netatlas never deletes one. Apply sends a token, so it needs a secure context: HTTPS, or
 * localhost and 127.0.0.0/8, which browsers count as secure (https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts),
 * so a port-forward keeps it.
 */
export function saveState(s: Session, reachable: boolean, secure: boolean): { copy: boolean; apply: boolean; banner: string | null; applyNote: string | null } {
  const saveable = canSave(s.draft).ok;
  return { copy: saveable, apply: saveable && reachable && secure, banner: saveable ? null : BOTH_OPEN, applyNote: !reachable ? CANNOT_APPLY : secure ? null : NEEDS_HTTPS };
}
