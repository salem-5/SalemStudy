import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Check, Loader2, TriangleAlert, X } from 'lucide-react';
import { Modal } from './Dialogs';
import { onPythonProgress, pythonSetup, pythonStatus, type PythonStatus } from '../lib/python';
import { runtimeStatus, type RuntimeStatus } from '../lib/salem/runtime';

const SKIP_KEY = 'wa.onboarding.skipped';

export const onboardingSkipped = (): boolean => {
  try { return localStorage.getItem(SKIP_KEY) === '1'; } catch { return false; }
};

export async function needsOnboarding(): Promise<boolean> {
  if (onboardingSkipped()) return false;
  const [python, ai] = await Promise.all([
    pythonStatus().catch(() => null),
    runtimeStatus().catch(() => null),
  ]);
  return !python?.ready || !ai?.ready;
}

export function Onboarding({ onClose }: { onClose: () => void }) {
  const [python, setPython] = useState<PythonStatus | null>(null);
  const [ai, setAi] = useState<RuntimeStatus | null>(null);
  const [busy, setBusy] = useState<'python' | null>(null);
  const [log, setLog] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    pythonStatus().then(setPython).catch(() => setPython(null));
    runtimeStatus().then(setAi).catch(() => setAi(null));
  }, []);
  useEffect(refresh, [refresh]);

  useEffect(() => {
    const un = onPythonProgress((p) => setLog(p.line));
    return () => { void un.then((f) => f()); };
  }, []);

  const install = async () => {
    setBusy('python');
    setError(null);
    setLog('Starting…');
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

  const rows: {
    key: 'python' | 'ai';
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
      what: 'Everything the assistant does — chat, notes, flashcards, quizzes — runs through it. It is installed into the same Python environment.',
      ready: !!ai?.ready,
      detail: ai?.ready
        ? `smolagents ${ai.hello?.smolagents ?? '?'} on Python ${ai.hello?.python ?? '?'}`
        : ai?.error ?? 'Not installed yet.',
      action: python?.ready && !ai?.ready
        ? { label: 'Repair the environment', run: () => void install() }
        : undefined,
    },
  ];

  const allReady = rows.every((r) => r.ready);

  return (
    <Modal title="Setting Salem up" onClose={busy ? () => {} : onClose} wide>
      <p className="muted small">
        Salem keeps its own Python, separate from anything else on your machine. It runs the maths,
        reads your PDFs, checks quiz answers, typesets your exports and hosts the assistant. You can
        set it up here — the app works without it, it just does a great deal less.
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
          onClick={() => { try { localStorage.setItem(SKIP_KEY, '1'); } catch { } onClose(); }}>
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
