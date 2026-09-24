import { useEffect, useRef, useState } from 'react';
import { Check, Download, ScanText, X } from 'lucide-react';
import { Modal } from './Dialogs';
import { installOcr, onPythonProgress, type PythonStatus } from '../lib/python';
import { readPipLine, type Step } from '../lib/pipProgress';

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

export function OcrInstallDialog({ status, suited = true, onDone, onClose }: {
  status: PythonStatus;
  suited?: boolean;
  onDone: () => void;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<'ask' | 'running' | 'done' | 'failed'>('ask');
  const [step, setStep] = useState<Step>({ stage: 'Starting…', file: null, files: 0, done: 0, total: 0, installing: false });
  const [error, setError] = useState<string | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const log = useRef<HTMLPreElement>(null);
  const size = status.ocrSizeMb ?? 240;

  useEffect(() => {
    if (phase !== 'running') return;
    const off = onPythonProgress((p) => {
      if (p.stage === 'stage') setStep((s) => ({ ...s, stage: p.line }));
      if (p.stage === 'log') {
        setStep((s) => readPipLine(s, p.line));
        if (!/^Progress\s+\d+/.test(p.line.trim())) setLines((l) => [...l.slice(-60), p.line]);
      }
    });
    return () => { void off.then((f) => f()); };
  }, [phase]);

  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [lines]);

  const start = async () => {
    setPhase('running');
    setError(null);
    try {
      await installOcr();
      setPhase('done');
      window.setTimeout(onDone, 900);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setPhase('failed');
    }
  };

  const pct = step.total ? Math.min(100, Math.round((step.done / step.total) * 100)) : 0;

  if (!status.ready) {
    return (
      <Modal title="Diagram labelling" onClose={onClose}>
        <div className="ocr-install">
          <p>Labelling diagrams runs in Salem's Python environment, which isn't set up yet.</p>
          <p className="muted small">Open Settings → Python and press Install, then turn this on again.</p>
          <div className="modal-actions"><button type="button" className="btn primary" onClick={onClose}>OK</button></div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Diagram labelling" onClose={phase === 'running' ? () => {} : onClose}>
      <div className="ocr-install">
        {phase === 'ask' && (
          <>
            <div className="ocr-install-head"><ScanText /><span>This needs a one-time download</span></div>
            <p>
              To make label-the-diagram questions, Salem reads the text on the diagrams in your sources, covers each label, and lets
              you fill them in. Reading text from pictures needs a text recognition add-on.
            </p>
            <p className="ocr-install-note">
              It is meant for subjects taught with labelled diagrams: biology, medicine, pharmacy, anatomy and chemistry.
              {!suited && ' This notebook\'s subject may not have many, so it could find few diagrams to use.'}
            </p>
            <p className="muted small">About {size} MB, downloaded once into Salem's Python environment. Nothing leaves your computer when it runs.</p>
            <div className="modal-actions">
              <button type="button" className="btn ghost" onClick={onClose}>Not now</button>
              <button type="button" className="btn primary" onClick={() => void start()}><Download />Download</button>
            </div>
          </>
        )}
        {phase !== 'ask' && (
          <>
            <div className="ocr-install-head">
              {phase === 'done' ? <Check className="ok" /> : phase === 'failed' ? <X className="bad" /> : <span className="dots"><i /><i /><i /></span>}
              <span>{phase === 'done' ? 'Diagram labelling is ready' : phase === 'failed' ? 'The download did not finish' : step.stage}</span>
            </div>
            {phase === 'running' && (
              <>
                <div className={`ocr-bar${step.installing || !step.total ? ' busy' : ''}`}><i style={{ width: step.installing || !step.total ? undefined : `${pct}%` }} /></div>
                <div className="ocr-install-meta muted small mono">
                  {step.installing
                    ? 'Setting up the downloaded packages…'
                    : step.file
                      ? `${step.file} · ${step.total ? `${mb(step.done)} of ${mb(step.total)}` : 'starting'} · file ${step.files}`
                      : 'Finding the packages…'}
                </div>
              </>
            )}
            {error && <p className="form-err">{error}</p>}
            {!!lines.length && phase !== 'done' && <pre ref={log} className="ocr-log mono">{lines.join('\n')}</pre>}
            {phase === 'failed' && (
              <div className="modal-actions">
                <button type="button" className="btn ghost" onClick={onClose}>Close</button>
                <button type="button" className="btn primary" onClick={() => void start()}>Try again</button>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
