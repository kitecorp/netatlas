import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import type { DiffLine } from '@/editor/diff';
import type { Message } from '@/editor/session';

export interface YamlPaneProps {
  readonly reviewing: boolean;
  readonly changes: string;
  readonly changed: boolean;
  /** What Copy YAML copies, shown on its own when the browser blocked the copy. */
  readonly yaml: string;
  /** The draft's lines while editing; the line difference while reviewing. */
  readonly lines: readonly string[];
  readonly diff: readonly DiffLine[];
  readonly save: { readonly copy: boolean; readonly apply: boolean; readonly banner: string | null; readonly applyNote: string | null };
  readonly message: Message | null;
  /** Said while the cluster holds a newer version than the one the changed draft began from. */
  readonly stale: string | null;
  /** The status message, which takes the focus after Apply. */
  readonly statusRef: RefObject<HTMLDivElement | null>;
  readonly onRestart: () => void;
  readonly onDiscard: () => void;
  readonly onReview: () => void;
  readonly onBack: () => void;
  readonly onCopy: () => void;
  readonly onApply: () => void;
  /** The token panel, when it is open. */
  readonly children?: ReactNode;
}

const MARK = { same: '  ', added: '+ ', removed: '- ' } as const;

/** The YAML to copy by hand, selected once when it appears; a later render keeps what the person selected. */
function SelectedYaml({ yaml, rows }: { yaml: string; rows: number }) {
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => area.current?.select(), []);
  return <textarea ref={area} className="yaml yaml-select" aria-label="YAML to copy" readOnly value={yaml} rows={rows} onFocus={(e) => e.currentTarget.select()} />;
}

/** The draft as YAML, or while reviewing its line difference from the cluster's version, with what can be done with it. */
export function YamlPane({ reviewing, changes, changed, yaml, lines, diff, save, message, stale, statusRef, onRestart, onDiscard, onReview, onBack, onCopy, onApply, children }: YamlPaneProps) {
  return (
    <section className="yaml-pane" aria-labelledby="yaml-title">
      <div className="yaml-head">
        <div className="yaml-heading">
          <h3 className="yaml-title" id="yaml-title">
            {reviewing ? 'Review before saving' : 'Draft YAML'}
          </h3>
          <div className={changed ? 'yaml-changes warn-text' : 'yaml-changes muted'}>{changes}</div>
        </div>
        {reviewing ? (
          <div className="actions">
            <button type="button" className="button" onClick={onBack}>
              Back to editing
            </button>
            <button type="button" className="button button-primary" disabled={!save.copy} onClick={onCopy}>
              Copy YAML
            </button>
            <button type="button" className="button button-apply-open" disabled={!save.apply} onClick={onApply}>
              Apply to cluster
            </button>
            {save.applyNote ? <span className="apply-note warn-text">{save.applyNote}</span> : null}
          </div>
        ) : (
          <div className="actions">
            <button type="button" className="button" onClick={onDiscard}>
              Discard changes
            </button>
            <button type="button" className="button button-primary" onClick={onReview}>
              Review and save
            </button>
          </div>
        )}
      </div>
      {stale ? (
        <div className="note note-warn">
          {stale}{' '}
          <button type="button" className="button" onClick={onRestart}>
            Start again from the cluster&apos;s version
          </button>
        </div>
      ) : null}
      {save.banner ? <div className="note note-warn">{save.banner}</div> : null}
      {children}
      <div role="status" className="yaml-status" ref={statusRef} tabIndex={-1}>
        {message ? <div className={message.tone === 'ok' ? 'note note-ok' : 'note note-warn'}>{message.text}</div> : null}
      </div>
      {message?.select ? (
        // The review's text below is the line difference, with its marks, so the YAML to copy stands alone here.
        <SelectedYaml yaml={yaml} rows={Math.min(lines.length, 20)} />
      ) : null}
      {/* ARIA allows no name on a <pre>, so a heading names the block for screen readers. */}
      <h4 className="visually-hidden">{reviewing ? 'Line difference' : 'Draft YAML'}</h4>
      <pre className="yaml">
        {reviewing
          ? diff.map((l, i) => (
              <span key={i} className={`yaml-line yaml-${l.kind}`}>
                {MARK[l.kind]}
                {l.text}
                {'\n'}
              </span>
            ))
          : lines.map((l, i) => (
              <span key={i} className="yaml-line">
                {l}
                {'\n'}
              </span>
            ))}
      </pre>
    </section>
  );
}
