'use client';

import { useEffect, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import { isOpen, type RuleInput, type Side } from '@/editor/draft';
import { applyBody, reduce, reviewOf, saveState, staleNote, startSession } from '@/editor/session';
import type { Coverage } from '@/model/policies';
import type { NetworkPolicyObject } from '@/model/types';
import { CoverageCard } from './CoverageCard';
import { Lock } from './Lock';
import { RuleForm } from './RuleForm';
import { SideColumn, SideHead } from './SideColumn';
import { TokenPanel } from './TokenPanel';
import { YamlPane } from './YamlPane';

/**
 * Said when the Apply request gets no answer netatlas wrote, such as a port-forward that broke: the
 * request may have reached the cluster before the connection dropped, so nobody can say it did not.
 */
const NO_ANSWER = "netatlas did not answer, so it cannot tell whether the change was applied. Reload to see the cluster's version.";

const never = () => () => {};

export interface EditorProps {
  readonly cluster: string;
  readonly policy: NetworkPolicyObject;
  readonly coverage: Coverage;
  readonly tokenHint: string;
  readonly reachable: boolean;
}

/**
 * The editor of one NetworkPolicy. Every edit changes a draft in this tab; nothing leaves it until
 * Copy YAML or Apply with my token. A new render from the server (the change stream) hands the
 * cluster's version to the session, which follows it while the draft has no changes and otherwise
 * says the cluster moved on.
 */
export function Editor({ cluster, policy, coverage, tokenHint, reachable }: EditorProps) {
  const [s, dispatch] = useReducer(reduce, policy, startSession);
  const [sending, setSending] = useState(false);
  const status = useRef<HTMLDivElement>(null);
  // The server cannot know, so it renders Apply as not offered; the browser says whether the page is a secure context.
  const secure = useSyncExternalStore(never, () => window.isSecureContext, () => false);
  useEffect(() => dispatch({ type: 'cluster', policy }), [policy]);
  const { namespace, name } = policy.metadata;
  const review = reviewOf(s.draft, s.latest ?? undefined);
  const save = saveState(s, reachable, secure);
  const stale = staleNote(s);
  const formSide = s.form && s.menu ? (s.menu.split(':')[0] as Side) : undefined;

  const copy = () => {
    const done = (ok: boolean) => dispatch({ type: 'copied', ok });
    // Older browsers and pages without a secure context have no clipboard; the YAML below can still be selected.
    if (!navigator.clipboard?.writeText) return done(false);
    navigator.clipboard.writeText(review.yaml).then(
      () => done(true),
      () => done(false),
    );
  };

  const apply = async () => {
    setSending(true);
    try {
      const url = `/api/clusters/${encodeURIComponent(cluster)}/namespaces/${encodeURIComponent(namespace)}/networkpolicies/${encodeURIComponent(name)}`;
      const res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(applyBody(s)) });
      const answer = (await res.json().catch(() => ({}))) as { policy?: NetworkPolicyObject; message?: string };
      if (res.ok && answer.policy) {
        dispatch({ type: 'applied', policy: answer.policy });
        // The panel and its button go away, so the focus moves to the message that says what happened.
        requestAnimationFrame(() => status.current?.focus());
      } else dispatch({ type: 'refused', message: answer.message ?? NO_ANSWER });
    } catch {
      dispatch({ type: 'refused', message: NO_ANSWER });
    } finally {
      setSending(false);
    }
  };

  const sideProps = (side: Side) => ({
    side,
    draft: s.draft,
    ns: namespace,
    // The menu that opened the form stays set, so the form knows its side; it is not drawn behind the form.
    menu: s.form ? null : s.menu,
    onMenu: (menu: string | null) => dispatch({ type: 'menu', menu }),
    onAdd: (input: RuleInput) => dispatch({ type: 'add', side, input }),
    onForm: (form: RuleInput) => {
      dispatch({ type: 'menu', menu: `${side}:${form.group}` });
      dispatch({ type: 'form', form });
    },
    onRemove: (id: string) => dispatch({ type: 'remove', side, id }),
  });

  return (
    <>
      <div className="editor-intro">
        <div className="editor-intro-text">
          <h2 className="editor-title">{name}</h2>
          <div className="muted">Click a lock to open or restrict a side. Add rules to say what may pass. Nothing reaches the cluster until you review and save.</div>
        </div>
        <a className="button button-link" href={`/map/${encodeURIComponent(cluster)}?q=${encodeURIComponent(name)}`}>
          Show on the map
        </a>
      </div>
      <div className="canvas-box">
        <div className="canvas">
          <div className="canvas-heads">
            <SideHead side="in" open={isOpen(s.draft, 'in')} />
            <div className="canvas-lock-gap" />
            <div className="canvas-middle-title">The pods this policy covers</div>
            <div className="canvas-lock-gap" />
            <SideHead side="out" open={isOpen(s.draft, 'out')} />
          </div>
          <div className="canvas-row">
            <SideColumn {...sideProps('in')} />
            <Lock side="in" open={isOpen(s.draft, 'in')} onToggle={() => dispatch({ type: 'toggle', side: 'in' })} />
            <CoverageCard cluster={cluster} kind="NetworkPolicy" namespace={namespace} name={name} coverage={coverage} />
            <Lock side="out" open={isOpen(s.draft, 'out')} onToggle={() => dispatch({ type: 'toggle', side: 'out' })} />
            <SideColumn {...sideProps('out')} />
          </div>
        </div>
      </div>
      <YamlPane
        reviewing={s.phase === 'reviewing'}
        changes={review.changes}
        changed={review.changed > 0}
        yaml={review.yaml}
        lines={review.lines}
        diff={review.diff}
        save={save}
        message={s.message}
        stale={stale}
        statusRef={status}
        onRestart={() => dispatch({ type: 'restart' })}
        onDiscard={() => dispatch({ type: 'discard' })}
        onReview={() => dispatch({ type: 'review' })}
        onBack={() => dispatch({ type: 'back' })}
        onCopy={copy}
        onApply={() => dispatch({ type: 'token-panel', open: true })}
      >
        {s.tokenOpen && s.phase === 'reviewing' ? (
          <TokenPanel
            token={s.token}
            hint={tokenHint}
            sending={sending}
            allowed={save.apply}
            onToken={(token) => dispatch({ type: 'token', token })}
            onCancel={() => dispatch({ type: 'token-panel', open: false })}
            onApply={() => void apply()}
          />
        ) : null}
      </YamlPane>
      {s.form && formSide ? (
        <RuleForm
          side={formSide}
          form={s.form}
          ns={namespace}
          onChange={(form) => dispatch({ type: 'form', form })}
          group={s.form.group}
          onCancel={() => dispatch({ type: 'menu', menu: null })}
          onSubmit={() => s.form && dispatch({ type: 'add', side: formSide, input: s.form })}
        />
      ) : null}
    </>
  );
}
