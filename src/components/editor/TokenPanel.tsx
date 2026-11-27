export interface TokenPanelProps {
  readonly token: string;
  readonly hint: string;
  readonly sending: boolean;
  /** False when Apply is not offered now (both sides open, or a cluster netatlas cannot reach). */
  readonly allowed: boolean;
  readonly onToken: (token: string) => void;
  readonly onCancel: () => void;
  readonly onApply: () => void;
}

/**
 * Asks for the person's own token, which the editor sends in one request body only and keeps in this
 * tab's memory until then. It is a password field outside any form, so nothing puts it in a URL and the
 * screen shows dots. Browsers may still offer to save a password field whatever `autocomplete` says
 * (MDN, "How to turn off form autocompletion"), so the field also carries the opt-outs 1Password
 * documents (`data-1p-ignore`, developer.1password.com/docs/web/compatible-website-design) and that
 * Bitwarden's extension reads (`data-bwignore`, bitwarden/clients collect-autofill-content.service.ts).
 * Whether a given browser or manager still offers to save it is not checked by any test.
 */
export function TokenPanel({ token, hint, sending, allowed, onToken, onCancel, onApply }: TokenPanelProps) {
  const missing = token.trim() === '';
  return (
    <div className="token-panel">
      <label className="field">
        <b>Your Kubernetes token</b>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          // The panel opens from Apply to cluster, so the field it asks for takes the focus.
          autoFocus
          aria-describedby="token-hint"
          data-1p-ignore
          data-bwignore
          value={token}
          onChange={(e) => onToken(e.target.value)}
          placeholder="paste the token"
        />
      </label>
      <div className="muted token-text" id="token-hint">
        The write uses your own permissions, so Kubernetes decides whether you may change this policy. The token is used for this one write and is not stored. <span className="mono token-hint">{hint}</span>
      </div>
      <div className="actions">
        <button type="button" className="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="button button-apply" disabled={missing || sending || !allowed} onClick={onApply}>
          {sending ? 'Applying' : 'Apply with my token'}
        </button>
      </div>
    </div>
  );
}
