import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Check, Copy, ExternalLink, Globe, Loader2, Power } from 'lucide-react';
import { getAiConfig, setAiConfig } from '../lib/ai';
import { studyApi } from '../study/api';
import { Modal } from './Dialogs';

export type TabModeStatus = { running: boolean; port: number | null; url: string | null; origin: string | null };

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

export function TabModeGate({ children }: { children: ReactNode }) {
  const status = useTabModeStatus();
  const locked = !!status?.running;
  useEffect(() => {
    if (locked) document.documentElement.setAttribute('data-tab-locked', '');
    else document.documentElement.removeAttribute('data-tab-locked');
  }, [locked]);
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
    } catch { setError('Could not copy - select the address and copy it by hand.'); }
  };

  return (
    <div className="tab-lock">
      <div className="glow-wrap lock-glow">
      <span className="study-glow" aria-hidden />
      <div className="tab-lock-card">
        <span className="tab-lock-icon"><Globe /></span>
        <h1>Tab mode is on</h1>
        <p className="muted">
          Salem is open in your browser. While it is, it only works there - turn tab mode off to use it in
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
            <span>Keep running in the tray when this window is closed{tray ? ' - the browser tab keeps working' : ''}</span>
          </label>
        )}
      </div>
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
      setError('Could not copy - select the address and copy it by hand.');
    }
  };

  const on = !!(status?.running && status.url);
  return (
    <Modal title="Open Salem in a browser tab" className="tab-mode" onClose={onClose}>
      <div className="tab-mode-intro">
        <span className="tab-mode-icon"><Globe /></span>
        <p>
          Use Salem in a browser tab instead of this window, with the same notebooks, chats and settings.
          While it is on, Salem works only in the tab.
        </p>
      </div>

      {error && <p className="form-err">{error}</p>}

      {on ? (
        <>
          <label className="field">
            <span className="field-label">Address</span>
            <input className="field-input mono" readOnly value={status!.url!} onFocus={(e) => e.currentTarget.select()} />
            <span className="gen-hint">It holds a private key, so keep it to yourself. Restarting tab mode changes it.</span>
          </label>
          <div className="modal-actions">
            <button type="button" className="btn danger" disabled={busy} onClick={() => void toggle()}>
              {busy ? <Loader2 className="spin" /> : <Power />}Turn off
            </button>
            <span className="spacer" />
            <button type="button" className="btn" onClick={() => void copy()}>
              {copied ? <><Check />Copied</> : <><Copy />Copy</>}
            </button>
            <button type="button" className="btn primary" onClick={() => void studyApi.openUrl(status!.url!)}>
              <ExternalLink />Open tab
            </button>
          </div>
        </>
      ) : (
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void toggle()}>
            {busy ? <><Loader2 className="spin" />Starting…</> : 'Turn on tab mode'}
          </button>
        </div>
      )}
    </Modal>
  );
}
