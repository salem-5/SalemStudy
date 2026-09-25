import { useEffect, useState } from 'react';
import { Download, RotateCw, Sparkles, X } from 'lucide-react';
import { Modal } from './Dialogs';
import { Markdown } from '../lib/markdown';
import { studyApi } from '../study/api';
import {
  appVersion, autoUpdates, canUpdate, changelogAfterUpdate, checkForUpdates, currentChangelog, installFound, RELEASES_URL,
  restartNow, setAutoUpdates, startAutoUpdates, useUpdateState, type Changelog, type UpdateState,
} from '../lib/updater';

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

function progressText(s: Extract<UpdateState, { status: 'downloading' }>): string {
  if (!s.total) return s.done ? `${mb(s.done)} downloaded` : 'Starting the download…';
  return `${Math.min(100, Math.round((s.done / s.total) * 100))}% of ${mb(s.total)}`;
}

export function WhatsNew({ log, onClose }: { log: Changelog; onClose: () => void }) {
  return (
    <Modal title={`What's new in ${log.version}`} onClose={onClose} wide>
      <div className="whats-new">
        <div className="whats-new-head">
          <Sparkles />
          <span>SalemStudy updated to <b>{log.version}</b></span>
        </div>
        <Markdown className="whats-new-notes" text={log.notes} />
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={() => void studyApi.openUrl(RELEASES_URL)}>All releases</button>
          <button type="button" className="btn primary" onClick={onClose} autoFocus>Got it</button>
        </div>
      </div>
    </Modal>
  );
}

export function UpdateCenter() {
  const state = useUpdateState();
  const [log, setLog] = useState<Changelog | null>(null);
  const [hidden, setHidden] = useState<string | null>(null);

  useEffect(() => {
    if (!canUpdate()) return;
    let alive = true;
    changelogAfterUpdate().then((l) => { if (alive && l) setLog(l); }).catch(() => {});
    startAutoUpdates();
    return () => { alive = false; };
  }, []);

  const ready = state.status === 'ready' && hidden !== state.version ? state : null;
  return (
    <>
      {log && <WhatsNew log={log} onClose={() => setLog(null)} />}
      {ready && (
        <div className="update-card" role="status">
          <Download />
          <div className="update-card-text">
            <b>SalemStudy {ready.version} is installed</b>
            <span className="muted">It starts the next time you open the app, or restart now.</span>
          </div>
          <button type="button" className="btn primary" onClick={() => void restartNow()}><RotateCw />Restart</button>
          <button type="button" className="icon-btn" onClick={() => setHidden(ready.version)} aria-label="Later" title="Later"><X /></button>
        </div>
      )}
    </>
  );
}

export function UpdatesSection() {
  const state = useUpdateState();
  const [version, setVersion] = useState<string | null>(null);
  const [auto, setAuto] = useState(autoUpdates);
  const [log, setLog] = useState<Changelog | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
  const local = canUpdate();

  useEffect(() => { appVersion().then(setVersion).catch(() => setVersion(null)); }, []);

  const openLog = async () => {
    if (log) { setLog(null); return; }
    setLogError(null);
    try {
      const l = await currentChangelog();
      if (l.notes.trim()) setLog(l);
      else setLogError('No changelog was published for this version.');
    } catch {
      setLogError('Could not load the changelog.');
    }
  };

  const line = (() => {
    switch (state.status) {
      case 'checking': return 'Checking for updates…';
      case 'current': return "You're on the latest version.";
      case 'available': return `Version ${state.version} is available.`;
      case 'downloading': return `Downloading ${state.version}: ${progressText(state)}`;
      case 'ready': return `Version ${state.version} is installed. It starts on the next launch.`;
      case 'error': return `Could not update: ${state.message}`;
      default: return auto ? 'Updates download and install on their own.' : 'Automatic updates are off.';
    }
  })();

  return (
    <section>
      <h4>Updates</h4>
      <div className="update-row">
        <span className="update-version">SalemStudy <b>{version ?? '…'}</b></span>
        {local && (
          <>
            {state.status === 'available'
              ? <button type="button" className="btn primary" onClick={() => void installFound()}><Download />Install {state.version}</button>
              : state.status === 'ready'
                ? <button type="button" className="btn primary" onClick={() => void restartNow()}><RotateCw />Restart to update</button>
                : (
                  <button type="button" className="btn" disabled={state.status === 'checking' || state.status === 'downloading'}
                    onClick={() => void checkForUpdates({ install: auto })}>
                    Check for updates
                  </button>
                )}
          </>
        )}
        <button type="button" className="btn ghost" onClick={() => void openLog()}>{log ? 'Hide changes' : "What's new"}</button>
      </div>
      {local && <span className={`muted small${state.status === 'error' ? ' bad-text' : ''}`}>{line}</span>}
      {logError && <span className="muted small bad-text">{logError}</span>}
      {local && (
        <label className="toggle">
          <input type="checkbox" checked={auto} onChange={(e) => { setAuto(e.target.checked); setAutoUpdates(e.target.checked); }} />
          <span>Update automatically <span className="muted">- new versions download in the background, and what changed is shown after they install</span></span>
        </label>
      )}
      {log && <Markdown className="whats-new-notes inline" text={log.notes} />}
    </section>
  );
}
