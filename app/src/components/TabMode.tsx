import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Check, Copy, ExternalLink, Globe, Loader2 } from 'lucide-react';
import { studyApi } from '../study/api';

/**
 * Running Salem in a browser tab.
 *
 * The app serves its own interface on `127.0.0.1` so it can sit beside the
 * student's other tabs. It is the same Salem, not a copy: the tab talks to
 * this window, so both see the same notebooks, the same chats and the same
 * AI. Closing the window closes the tab's backend with it.
 */

export type TabModeStatus = { running: boolean; port: number | null; url: string | null; origin: string | null };

export const tabModeStatus = () => invoke<TabModeStatus>('tab_mode_status');
export const startTabMode = () => invoke<TabModeStatus>('tab_mode_start');
export const stopTabMode = () => invoke<TabModeStatus>('tab_mode_stop');

export function TabModeDialog({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<TabModeStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(() => {
    tabModeStatus().then(setStatus).catch((e) => setError(String(e)));
  }, []);
  useEffect(refresh, [refresh]);

  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      setStatus(status?.running ? await stopTabMode() : await startTabMode());
    } catch (e) {
      setError(String(e));
    }
    setBusy(false);
  };

  const copy = async () => {
    if (!status?.url) return;
    try {
      await navigator.clipboard.writeText(status.url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setError('Could not copy — select the address and copy it by hand.');
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal tab-mode" onClick={(e) => e.stopPropagation()}>
        <div className="panel-title"><Globe /> Salem in a tab</div>
        <p className="muted small">
          Serve this window's interface on your own machine, so you can keep Salem in a browser tab
          next to everything else. It is the same Salem — the same notebooks, chats and settings —
          and it only works while this window is open.
        </p>

        {error && <p className="form-err">{error}</p>}

        {status?.running && status.url ? (
          <>
            <label className="field">
              <span className="field-label">Open this address</span>
              <input className="field-input mono" readOnly value={status.url} onFocus={(e) => e.currentTarget.select()} />
            </label>
            <p className="muted small">
              The address carries a one-off key, so nothing else on this machine can reach your
              study data. Keep it to yourself, and reopen the tab from here if you lose it — the key
              changes every time tab mode is restarted.
            </p>
            <div className="modal-actions">
              <button type="button" className="btn ghost" onClick={() => void copy()}>
                {copied ? <><Check />Copied</> : <><Copy />Copy address</>}
              </button>
              <button type="button" className="btn ghost" onClick={() => void studyApi.openUrl(status.url!)}>
                <ExternalLink />Open in browser
              </button>
              <button type="button" className="btn" disabled={busy} onClick={() => void toggle()}>
                {busy ? <Loader2 className="spin" /> : null}Turn off
              </button>
              <button type="button" className="btn primary" onClick={onClose}>Done</button>
            </div>
          </>
        ) : (
          <div className="modal-actions">
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="button" className="btn primary" disabled={busy} onClick={() => void toggle()}>
              {busy ? <><Loader2 className="spin" />Starting…</> : 'Turn on tab mode'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
