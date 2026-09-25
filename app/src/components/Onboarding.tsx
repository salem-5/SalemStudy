import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Check, Loader2, TriangleAlert, X } from 'lucide-react';
import { Modal } from './Dialogs';
import { installOcr, onPythonProgress, pythonSetup, pythonStatus, type PythonStatus } from '../lib/python';
import { readPipLine, type Step } from '../lib/pipProgress';
import { runtimeStatus, type RuntimeStatus } from '../lib/salem/runtime';

const SKIP_KEY = 'wa.onboarding.skipped';
/** Bumped when setup gains a requirement, so a "do not ask again" from before still shows it once. */
const SKIP_VERSION = '2';

export const onboardingSkipped = (): boolean => {
  try { return localStorage.getItem(SKIP_KEY) === SKIP_VERSION; } catch { return false; }
};

/** Anything can ask for setup to be shown, e.g. an option that needs a package that is missing. */
export const OPEN_SETUP = 'wa:open-setup';
export const openSetup = () => window.dispatchEvent(new Event(OPEN_SETUP));
/** Sent after setup has installed something, so anything waiting on a package can look again. */
export const PYTHON_CHANGED = 'wa:python-changed';

export async function needsOnboarding(): Promise<boolean> {
  if (onboardingSkipped()) return false;
  const [python, ai] = await Promise.all([
    pythonStatus().catch(() => null),
    runtimeStatus().catch(() => null),
  ]);
  return !python?.ready || !python.ocrReady || !ai?.ready;
}

export function Onboarding({ onClose }: { onClose: () => void }) {
  const [python, setPython] = useState<PythonStatus | null>(null);
  const [ai, setAi] = useState<RuntimeStatus | null>(null);
  const [busy, setBusy] = useState<'python' | 'ocr' | null>(null);
  const [log, setLog] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    pythonStatus().then((s) => { setPython(s); window.dispatchEvent(new Event(PYTHON_CHANGED)); }).catch(() => setPython(null));
    runtimeStatus().then(setAi).catch(() => setAi(null));
  }, []);
  useEffect(refresh, [refresh]);

  // pip reports a download as "Progress 123 of 456" lines: shown as a percentage, not raw.
  const step = useRef<Step>({ stage: '', file: null, files: 0, done: 0, total: 0, installing: false });
  useEffect(() => {
    const un = onPythonProgress((p) => {
      if (p.stage !== 'log') { setLog(p.line); return; }
      const next = readPipLine(step.current, p.line);
      const changed = next !== step.current;
      step.current = next;
      if (!changed) { if (!/^\s*$/.test(p.line)) setLog(p.line); return; }
      setLog(next.installing ? next.stage
        : next.file ? `Downloading ${next.file}${next.total ? ` · ${Math.min(100, Math.round((next.done / next.total) * 100))}%` : '…'}`
          : p.line);
    });
    return () => { void un.then((f) => f()); };
  }, []);

  const install = async () => {
    setBusy('python');
    setError(null);
    setLog('Starting…');
    step.current = { stage: '', file: null, files: 0, done: 0, total: 0, installing: false };
    try {
      await pythonSetup(false);
      await invoke('salem_restart').catch(() => {});
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
    setLog('');
    setBusy(null);
    refresh();
  };

  const addOcr = async () => {
    setBusy('ocr');
    setError(null);
    setLog('Starting…');
    step.current = { stage: '', file: null, files: 0, done: 0, total: 0, installing: false };
    try {
      await installOcr();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
    setLog('');
    setBusy(null);
    refresh();
  };

  const rows: {
    key: 'python' | 'ai' | 'ocr';
    name: string;
    what: string;
    ready: boolean;
    detail: string;
    action?: { label: string; run: () => void };
  }[] = [
    {
      key: 'python',
      name: 'Python',
      what: 'Runs the maths, reads your PDFs and checks quiz answers. Salem keeps its own copy, separate from anything else on your machine.',
      ready: !!python?.ready,
      detail: python?.ready
        ? `Python ${python.version} · ${python.source === 'venv' ? "Salem's own environment" : 'your own interpreter'}`
        : python?.error ?? python?.help ?? 'Not set up yet.',
      action: { label: python?.ready ? 'Reinstall' : 'Install Python', run: () => void install() },
    },
    {
      key: 'ai',
      name: 'The AI runtime',
      what: 'Everything the assistant does - chat, notes, flashcards, quizzes - runs through it. It is installed into the same Python environment.',
      ready: !!ai?.ready,
      detail: ai?.ready
        ? `smolagents ${ai.hello?.smolagents ?? '?'} on Python ${ai.hello?.python ?? '?'}`
        : ai?.error ?? 'Not installed yet.',
      action: python?.ready && !ai?.ready
        ? { label: 'Repair the environment', run: () => void install() }
        : undefined,
    },
    {
      key: 'ocr',
      name: 'Diagram labelling',
      what: 'Reads the labels on diagrams in your sources, so quizzes can cover them for you to fill in. About 240 MB, and it runs on your computer.',
      ready: !!python?.ocrReady,
      detail: python?.ocrReady ? 'Text recognition is installed.' : python?.ready ? 'Not installed yet.' : 'Installed along with Python.',
      action: python?.ready && !python.ocrReady ? { label: 'Install', run: () => void addOcr() } : undefined,
    },
  ];

  const allReady = rows.every((r) => r.ready);

  return (
    <Modal title="Setting Salem up" onClose={busy ? () => {} : onClose} wide>
      <p className="muted small">
        Salem keeps its own Python, separate from anything else on your machine. It runs the maths,
        reads your PDFs and the labels on diagrams, checks quiz answers, typesets your exports and hosts
        the assistant. You can set it up here - the app works without it, it just does a great deal less.
      </p>

      <div className="onboard-list">
        {rows.map((row) => (
          <div key={row.key} className={`onboard-row${row.ready ? ' ready' : ''}`}>
            <span className="onboard-icon">
              {busy === row.key ? <Loader2 className="spin" /> : row.ready ? <Check /> : <TriangleAlert />}
            </span>
            <div className="onboard-text">
              <div className="onboard-name">{row.name}</div>
              <div className="muted small">{row.what}</div>
              <div className="muted small onboard-detail">{row.detail}</div>
            </div>
            {row.action && (
              <button type="button" className="btn" disabled={!!busy} onClick={row.action.run}>{row.action.label}</button>
            )}
          </div>
        ))}
      </div>

      {busy && <div className="gen-status"><span className="dots"><i /><i /><i /></span>{log || 'Working…'}</div>}
      {error && <div className="form-err"><X />{error}</div>}

      <div className="modal-actions">
        <button type="button" className="btn ghost" disabled={!!busy}
          onClick={() => { try { localStorage.setItem(SKIP_KEY, SKIP_VERSION); } catch { } onClose(); }}>
          Do not ask again
        </button>
        <span className="spacer" />
        <button type="button" className="btn ghost" disabled={!!busy} onClick={refresh}>Check again</button>
        <button type="button" className="btn primary" disabled={!!busy} onClick={onClose}>
          {allReady ? 'All set' : 'Later'}
        </button>
      </div>
    </Modal>
  );
}
