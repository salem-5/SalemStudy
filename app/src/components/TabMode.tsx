import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Check, Copy, ExternalLink, Globe, Loader2, Power } from 'lucide-react';
import { getAiConfig, setAiConfig } from '../lib/ai';
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

// What the desktop window knows about tab mode, shared: the dialog turns it
// on, and the gate round the whole app swaps the app for the lock screen.
let current: TabModeStatus | null = null;
const listeners = new Set<() => void>();
const publish = (s: TabModeStatus) => { current = s; listeners.forEach((l) => l()); return s; };

export const tabModeStatus = () => invoke<TabModeStatus>('tab_mode_status').then(publish);
export const startTabMode = () => invoke<TabModeStatus>('tab_mode_start').then(publish);
export const stopTabMode = () => invoke<TabModeStatus>('tab_mode_stop').then(publish);

export function useTabModeStatus(): TabModeStatus | null {
  const status = useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => current);
  useEffect(() => { if (!current) void tabModeStatus().catch(() => {}); }, []);
  return status;
}

/**
 * The whole desktop app, unless tab mode is on.
 *
 * While Salem is being used in a browser tab this window stays running — it
 * is what answers the tab — but the app in it is not usable: two copies of
 * the same notebook side by side, each able to write, is how work gets lost.
 * So it shows only that tab mode is on, and how to go back.
 */
export function TabModeGate({ children }: { children: ReactNode }) {
  const status = useTabModeStatus();
  if (status?.running) return <TabModeLock status={status} />;
  return <>{children}</>;
}

function TabModeLock({ status }: { status: TabModeStatus }) {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tray, setTray] = useState<boolean | null>(null);
  useEffect(() => { getAiConfig().then((c) => setTray(c.closeToTray)).catch(() => {}); }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(status.url ?? '');
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch { setError('Could not copy — select the address and copy it by hand.'); }
  };

  return (
    <div className="tab-lock">
      <div className="tab-lock-card">
        <span className="tab-lock-icon"><Globe /></span>
        <h1>Tab mode is on</h1>
        <p className="muted">
          Salem is open in your browser. While it is, it only works there — turn tab mode off to use it in
          this window again.
        </p>
        {status.url && <input className="field-input mono" readOnly value={status.url} onFocus={(e) => e.currentTarget.select()} />}
        {error && <p className="form-err">{error}</p>}
        <div className="tab-lock-actions">
          <button type="button" className="btn primary" onClick={() => status.url && void studyApi.openUrl(status.url)}>
            <ExternalLink />Open in browser
          </button>
          <button type="button" className="btn ghost" onClick={() => void copy()}>
            {copied ? <><Check />Copied</> : <><Copy />Copy address</>}
          </button>
          <button type="button" className="btn" disabled={busy}
            onClick={async () => { setBusy(true); try { await stopTabMode(); } catch (e) { setError(String(e)); setBusy(false); } }}>
            {busy ? <Loader2 className="spin" /> : <Power />}Turn off tab mode
          </button>
        </div>
        {tray !== null && (
          <label className="toggle tab-lock-tray">
            <input type="checkbox" checked={tray}
              onChange={async (e) => { const v = e.target.checked; setTray(v); await setAiConfig({ closeToTray: v }).catch(() => setTray(!v)); }} />
            <span>Keep running in the tray when this window is closed{tray ? ' — the browser tab keeps working' : ''}</span>
          </label>
        )}
      </div>
    </div>
  );
}

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
      if (status?.running) setStatus(await stopTabMode());
      else {
        const on = await startTabMode();
        setStatus(on);
        // Straight into the tab; this window becomes the lock screen.
        if (on.url) void studyApi.openUrl(on.url);
      }
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
          and while it is on, Salem works only there. Closing this window keeps it running in the tray.
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
