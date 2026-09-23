import { useCallback, useEffect, useRef, useState } from 'react';
import { ProviderSettings } from './ProviderSettings';
import { Select } from './Select';
import { Download, Monitor, Moon, RectangleHorizontal, Search, Settings as SettingsIcon, Square, Sun, TriangleAlert, Upload, X } from 'lucide-react';
import type { Box, Question } from '../types';
import type { ChatEntry, useSolver } from '../lib/solver';
import { deepseekBalance, getAiConfig, setAiConfig, type AiConfig, type Balance, type ConfigPatch, type Effort } from '../lib/ai';
import { onPythonProgress, pythonSetup, pythonStatus, type PythonStatus } from '../lib/python';
import { fmtCost, fmtInt, type UsageRecord } from '../lib/usage';
import { refetchesLeft } from '../lib/cache';
import { MathView } from './MathView';
import { Modal } from './Dialogs';
import { invoke } from '@tauri-apps/api/core';
import { restartRuntime, runtimeStatus, runtimeTelemetry, type RuntimeStatus } from '../lib/salem/runtime';
import { studyApi, type MemoryState, type UsageSummary } from '../study/api';
import { setSolverEnabled, useSolverEnabled } from '../lib/features';
import { exportData, fmtBytes, importData, pickImport, resetData, type ExportInfo } from '../lib/dataFile';
import { TONES, setPersonal, usePersonal } from '../lib/personal';
import { ACCENTS, PALETTES, paletteOf, setAccentPref, setShapePref, setThemePref, useAccentPref, useShapePref, useThemePref, type Palette, type ShapePref } from '../lib/theme';

type Solver = ReturnType<typeof useSolver>;

const STATUS_LABEL: Record<Solver['status'], string> = {
  idle: 'READY',
  running: 'SOLVING',
  awaiting: 'NEEDS YOU',
  done: 'SOLVED',
  failed: 'GAVE UP',
  stopped: 'STOPPED',
};

const errText = (e: unknown) =>
  (e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message)
    : e && typeof e === 'object' && 'error' in e ? String((e as { error: unknown }).error) : String(e));

export function fmtBalance(b: Balance): string {
  const infos = b.balance_infos ?? [];
  if (infos.length) return infos.map((x) => `${x.currency} ${x.total_balance}`).join(' · ');
  return b.is_available ? 'available' : 'unavailable';
}

function AnswerList({ answers, boxes }: { answers: Record<string, unknown>; boxes: Box[] }) {
  return (
    <div className="ai-answers">
      {Object.entries(answers).map(([k, v]) => {
        const box = boxes[Number(k) - 1];
        return (
          <div key={k} className="ai-answer">
            <span className="ai-answer-box">[{k}]</span>
            <span className="ai-answer-val">
              {box?.kind === 'math' ? <MathView expr={String(v)} /> : Array.isArray(v) ? v.join(', ') : String(v)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** A sandboxed Python run: the snippet, and its output once it finishes. */
function PythonEntry({ e }: { e: ChatEntry }) {
  const [open, setOpen] = useState(false);
  const tone = e.running ? 'run' : e.tone === 'bad' ? 'bad' : 'ok';
  return (
    <div className={`ai-py ${tone}`}>
      <button type="button" className="ai-py-head" onClick={() => setOpen((v) => !v)}>
        <span className="ai-py-tag">PY</span>
        <span className="ai-py-line">{e.running ? 'running…' : e.text}</span>
        <span className="ai-py-toggle">{open ? '−' : '+'}</span>
      </button>
      {open && (
        <div className="ai-py-body">
          <pre className="ai-py-code">{e.code}</pre>
          {e.output && <pre className="ai-py-out">{e.output}</pre>}
        </div>
      )}
    </div>
  );
}

function Entry({ e, boxes }: { e: ChatEntry; boxes: Box[] }) {
  if (e.kind === 'python') return <PythonEntry e={e} />;
  if (e.role === 'user') {
    return <div className="ai-msg user"><div className="ai-bubble">{e.text}</div></div>;
  }
  if (e.role === 'assistant' && e.kind === 'chat') {
    return (
      <div className="ai-msg assistant">
        <div className="ai-meta">{e.model || 'assistant'}</div>
        <div className="ai-bubble">{e.text}</div>
      </div>
    );
  }
  if (e.role === 'assistant') {
    return (
      <div className="ai-msg assistant solve">
        <div className="ai-meta">{e.model || 'assistant'}</div>
        {e.text && <div className="ai-bubble">{e.text}</div>}
        {e.answers && Object.keys(e.answers).length > 0 && <AnswerList answers={e.answers} boxes={boxes} />}
      </div>
    );
  }
  return (
    <div className={`ai-sys ${e.kind} ${e.tone ?? 'muted'}`}>
      {e.text.split('\n').map((line, i) => <div key={i}>{line || '\u00a0'}</div>)}
    </div>
  );
}

export function AiPanel({ solver, question, questions, open, onOpenSettings, onClose }: {
  solver: Solver;
  question: Question | undefined;
  questions: number[];
  open: boolean;
  onOpenSettings: () => void;
  onClose: () => void;
}) {
  const [chat, setChat] = useState('');
  const [manual, setManual] = useState('');
  const [balance, setBalance] = useState<string | null>(null);
  const [balBusy, setBalBusy] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [solver.entries]);

  const cfg = solver.config;
  const status = solver.status;
  const boxes = question?.boxes ?? [];
  const qnum = question?.number;
  const running = status === 'running';
  const awaiting = status === 'awaiting';

  const refreshBalance = () => {
    if (!cfg?.hasKey) { setBalance(null); return; }
    setBalBusy(true);
    deepseekBalance()
      .then((b) => setBalance(fmtBalance(b)))
      .catch(() => setBalance(null))
      .finally(() => setBalBusy(false));
  };

  useEffect(() => {
    if (!open || !cfg?.hasKey) { if (!cfg?.hasKey) setBalance(null); return; }
    let alive = true;
    setBalBusy(true);
    deepseekBalance()
      .then((b) => { if (alive) setBalance(fmtBalance(b)); })
      .catch(() => { if (alive) setBalance(null); })
      .finally(() => { if (alive) setBalBusy(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cfg?.hasKey]);

  const sendChat = () => {
    const t = chat.trim();
    if (!t) return;
    setChat('');
    void solver.send(t);
  };

  const doManual = (submit: boolean) => {
    const t = manual.trim();
    if (!t) return;
    if (submit) setManual('');
    void solver.manualFill(t, submit);
  };

  return (
    <aside className={`ai${open ? '' : ' closed'}`} aria-hidden={!open}>
      <div className="ai-inner">
      <header className="ai-head">
        <span className={`ai-status ${status}`}>{STATUS_LABEL[status]}</span>
        <span className="ai-title">AI SOLVE</span>
        {solver.attempt > 0 && <span className="ai-attempt">try {solver.attempt}</span>}
        <span className="spacer" />
        <button
          type="button"
          className={`ai-py-chip ${!cfg?.pythonEnabled ? 'off' : solver.python?.ready ? 'ok' : 'bad'}`}
          title={
            !cfg?.pythonEnabled ? 'Python is switched off — click to open settings'
              : solver.python?.ready ? `Python ${solver.python.version} sandbox ready — the solver computes with sympy/numpy`
                : 'Python is not installed yet — click to set it up'
          }
          onClick={onOpenSettings}
        >
          py
        </button>
        <button
          type="button"
          className="ai-balance"
          title={balance ? `DeepSeek balance: ${balance}` : 'Check DeepSeek balance'}
          onClick={refreshBalance}
        >
          {balBusy ? '…' : balance ?? 'balance'}
        </button>
        <button type="button" className="icon-btn" title="AI settings" onClick={onOpenSettings}><SettingsIcon /></button>
        <button type="button" className="icon-btn" title="Close panel" onClick={onClose}><X /></button>
      </header>

      {!cfg?.hasKey && (
        <div className="ai-warn">
          No API key yet. <button type="button" className="link" onClick={onOpenSettings}>Add one</button>
        </div>
      )}

      <div className="ai-log" ref={logRef}>
        {solver.entries.length === 0 && (
          <div className="ai-empty">
            Right-click an assignment or a question and choose <b>Solve with AI</b>.
            You can also chat here to add instructions, and fill an answer by hand below.
          </div>
        )}
        {solver.entries.map((e) => <Entry key={e.id} e={e} boxes={boxes} />)}
      </div>

      {awaiting && (
        <div className="ai-actions">
          <button type="button" className="btn primary" onClick={() => void solver.continueSolve()}>Continue</button>
          <button type="button" className="btn ghost" onClick={() => void solver.nextQuestion()}>Next question</button>
          <button type="button" className="btn ghost" onClick={solver.stop}>Stop</button>
        </div>
      )}

      {running && (
        <div className="ai-actions">
          <span className="ai-working"><i /><i /><i /></span>
          <span className="muted">working…</span>
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={solver.stop}>Stop</button>
        </div>
      )}

      {!running && !awaiting && (
        <div className="ai-actions">
          <button
            type="button"
            className="btn"
            disabled={!qnum || !cfg?.hasKey}
            onClick={() => qnum && void solver.start([qnum])}
          >
            {status === 'done' ? 'Solve again' : 'Solve Q'}{qnum ? qnum : ''}
          </button>
          {questions.length > 1 && qnum && (
            <button
              type="button"
              className="btn ghost"
              disabled={!cfg?.hasKey}
              title="Solve this question and every question after it"
              onClick={() => void solver.start(questions.filter((n) => n >= qnum))}
            >
              From here →
            </button>
          )}
          <span className="spacer" />
          {solver.entries.length > 0 && <button type="button" className="btn ghost" onClick={solver.clearChat}>Clear</button>}
        </div>
      )}

      <div className="ai-manual">
        <div className="ai-label">Manual answer <span className="muted">— single value, or {'{"1":"x","2":"3"}'}</span></div>
        <textarea
          className="ai-manual-input"
          value={manual}
          spellCheck={false}
          placeholder={boxes.length === 1 ? 'the answer' : '{"1": "...", "2": "..."}'}
          onChange={(e) => setManual(e.target.value)}
        />
        <div className="ai-manual-actions">
          <button type="button" className="btn ghost" disabled={running || !manual.trim() || !qnum} onClick={() => doManual(false)}>Fill</button>
          <button type="button" className="btn" disabled={running || !manual.trim() || !qnum} onClick={() => doManual(true)}>Fill &amp; submit</button>
        </div>
      </div>

      <div className="ai-chat">
        <textarea
          className="ai-chat-input"
          value={chat}
          spellCheck={false}
          placeholder={awaiting ? 'Add an instruction and press Enter to continue…' : 'Extra instructions or a question…'}
          onChange={(e) => setChat(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
          }}
        />
        <button type="button" className="btn" disabled={!chat.trim()} onClick={sendChat}>Send</button>
      </div>
      </div>
    </aside>
  );
}

function BalanceRow({ onChanged }: { onChanged?: () => void }) {
  const [balance, setBalance] = useState<Balance | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const check = async () => {
    setBusy(true); setErr(null);
    try {
      const b = await deepseekBalance();
      setBalance(b);
      onChanged?.();
    } catch (e) {
      setErr(errText(e));
      setBalance(null);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="account-row">
      <button type="button" className="btn ghost" disabled={busy} onClick={check}>{busy ? 'Checking…' : 'Check balance'}</button>
      {balance && (
        <span className="account-balance">
          {fmtBalance(balance)}
          {!balance.is_available && <span className="warn"> · insufficient</span>}
        </span>
      )}
      {err && <span className="ai-settings-err">{err}</span>}
    </div>
  );
}

/**
 * The Python sandbox: what is installed, and the one button that installs it.
 * The environment is the app's own virtualenv, so nothing on the machine's
 * Python is touched.
 */
function PythonSection({ cfg, patch, onChanged, solverOn }: {
  solverOn: boolean;
  cfg: { enabled: boolean; auto: boolean; path: string; timeout: number; maxCalls: number };
  patch: (p: Partial<{ enabled: boolean; auto: boolean; path: string; timeout: number; maxCalls: number }>) => void;
  onChanged: () => void;
}) {
  const [status, setStatus] = useState<PythonStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const refresh = () => {
    pythonStatus().then(setStatus).catch((e) => setErr(errText(e)));
  };
  useEffect(refresh, []);
  useEffect(() => {
    // Outside Tauri (browser dev mode) there is no event bus; ignore it.
    const un = onPythonProgress((p) => setLine(p.line)).catch(() => null);
    return () => { void un.then((f) => f?.()); };
  }, []);

  const install = async (repair: boolean) => {
    setBusy(true);
    setErr(null);
    setLine('Starting…');
    try {
      // The interpreter override has to be on disk before setup reads it.
      await setAiConfig({ pythonPath: cfg.path });
      setStatus(await pythonSetup(repair));
      // Whatever was installed only reaches the AI runtime after it restarts.
      await invoke('salem_restart').catch(() => {});
      onChanged();
    } catch (e) {
      setErr(errText(e));
      refresh();
    } finally {
      setBusy(false);
      setLine('');
    }
  };

  const ready = status?.ready === true;
  return (
    <section>
      <h4>PYTHON</h4>
      <div className="account-row">
        <span className={`py-badge ${ready ? 'ok' : 'bad'}`}>{ready ? 'READY' : 'NOT SET UP'}</span>
        {status?.version && <span className="muted">Python {status.version} · {status.source === 'venv' ? 'app environment' : 'custom interpreter'}</span>}
        <span className="spacer" />
        <button type="button" className="btn ghost" disabled={busy} onClick={() => void install(false)}>
          {busy ? 'Working…' : ready ? 'Update packages' : 'Install'}
        </button>
        {ready && (
          <button type="button" className="btn ghost danger" disabled={busy} onClick={() => void install(true)} title="Delete the environment and build it again">
            Rebuild
          </button>
        )}
      </div>
      {busy && line && <div className="py-log">{line}</div>}
      {status && status.packages.length > 0 && (
        <div className="py-packages">
          {status.packages.map((p) => (
            <span key={p.name} className={p.version ? 'py-pkg ok' : 'py-pkg'}>{p.name} {p.version ?? '—'}</span>
          ))}
        </div>
      )}
      {status && !ready && <p className="muted">{status.error ? `${status.error} ` : ''}{status.help}</p>}
      {err && <div className="ai-settings-err">{err}</div>}
      <label className="account-check">
        <input type="checkbox" checked={cfg.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
        <span>Let the AI run Python (chats, quizzes{solverOn ? ', the solver' : ''})</span>
      </label>
      {solverOn && (
        <label className="account-check">
          <input type="checkbox" checked={cfg.auto} onChange={(e) => patch({ auto: e.target.checked })} />
          <span>Solver: require it for any question that needs calculating (off: only after a wrong answer)</span>
        </label>
      )}
      <div className="ai-settings-row">
        <label>
          <span>Seconds per run</span>
          <input type="number" min={1} max={180} value={cfg.timeout} onChange={(e) => patch({ timeout: Number(e.target.value) })} />
        </label>
        <label>
          <span>Runs per attempt</span>
          <input type="number" min={1} max={20} value={cfg.maxCalls} onChange={(e) => patch({ maxCalls: Number(e.target.value) })} />
        </label>
      </div>
      <label>
        <span>Interpreter to build the environment with (blank = found automatically)</span>
        <input
          value={cfg.path}
          spellCheck={false}
          placeholder={status?.interpreter ?? 'e.g. C:\\Python313\\python.exe or /opt/homebrew/bin/python3'}
          onChange={(e) => patch({ path: e.target.value })}
        />
      </label>
      <p className="muted">
        Code runs in a throwaway folder with no network, no other programs and no access to your files, and is stopped when it runs past its time.
      </p>
    </section>
  );
}

export function AiSettingsDialog({ onClose, onSaved, onClearCache, onPythonChanged }: {
  onClose: () => void;
  onSaved: (c: AiConfig) => void;
  usageMap?: Record<string, UsageRecord>;
  onClearCache: () => void;
  onPythonChanged: () => void;
}) {
  const [cfg, setCfg] = useState<AiConfig | null>(null);
  const [maxA, setMaxA] = useState(4);
  const [pause, setPause] = useState(2);
  const [effort, setEffort] = useState<Effort>('low');
  const [py, setPy] = useState({ enabled: true, auto: true, path: '', timeout: 25, maxCalls: 6 });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const solverOn = useSolverEnabled();

  const apply = (c: AiConfig) => {
    setCfg(c);
    setMaxA(c.maxAttempts);
    setPause(c.pauseAfter);
    setEffort(c.effort ?? 'low');
    setPy({
      enabled: c.pythonEnabled,
      auto: c.pythonAuto,
      path: c.pythonPath,
      timeout: c.pythonTimeout,
      maxCalls: c.pythonMaxCalls,
    });
  };

  useEffect(() => {
    getAiConfig().then(apply).catch((e) => setErr(errText(e)));
  }, []);

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      const patch: ConfigPatch = {
        maxAttempts: maxA, pauseAfter: pause, effort,
        pythonEnabled: py.enabled, pythonAuto: py.auto, pythonPath: py.path,
        pythonTimeout: py.timeout, pythonMaxCalls: py.maxCalls,
      };
      const next = await setAiConfig(patch);
      onSaved(next);
      onClose();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="SETTINGS" onClose={onClose} wide>
      <div className="ai-settings">
        <section>
          <h4>MODEL</h4>
          <ProviderSettings solverOn={solverOn} onChanged={(c) => { setCfg(c); onSaved(c); }} />
        </section>

        {cfg?.provider === 'deepseek' && (
          <section>
            <h4>BALANCE</h4>
            <BalanceRow />
          </section>
        )}

        <section>
          <h4>APPEARANCE</h4>
          <ThemePicker />
        </section>

        <section>
          <h4>WINDOW</h4>
          <TrayToggle />
        </section>

        <PersonalSection />

        <MemorySection />

        <section>
          <h4>FEATURES</h4>
          <label className="feature-row">
            <span className="feature-text">
              <b>Assignment Solver</b>
              <span className="muted">Solve WebAssign assignments with the AI, through the userscript in your browser. Adds a sidebar entry and its own settings here.</span>
            </span>
            <span className="switch">
              <input type="checkbox" checked={solverOn} onChange={(e) => setSolverEnabled(e.target.checked)} />
              <span className="switch-track"><span className="switch-thumb" /></span>
            </span>
          </label>
        </section>

        <UsageSection />

        <RuntimeSection />

        <DataSection />

        <PythonSection cfg={py} patch={(p) => setPy((v) => ({ ...v, ...p }))} onChanged={onPythonChanged} solverOn={solverOn} />

        {solverOn && <section>
          <h4>CACHE</h4>
          <div className="account-row">
            <button type="button" className="btn ghost" onClick={onClearCache}>Clear question cache</button>
            <span className="muted">
              Questions are cached this session. Refetches left: {refetchesLeft()}. Completed assignments are never refetched.
            </span>
          </div>
        </section>}

        <section>
          <h4>REASONING</h4>
          <label>
            <span>How hard to think</span>
            <Select className="field-input" value={effort} onChange={(v) => setEffort(v as Effort)}
              options={[
                { value: 'low', label: 'Fast', hint: 'least reasoning per step' },
                { value: 'high', label: 'Balanced' },
                { value: 'max', label: 'Thorough', hint: 'slowest' },
              ]} />
            <small>
              An agent spends most of its steps choosing a tool, where extra reasoning buys
              nothing and costs a second each time. Turn it up for a hard task.
            </small>
          </label>
          {solverOn && <div className="ai-settings-row">
            <label>
              <span>Max attempts per question</span>
              <input type="number" min={1} max={10} value={maxA} onChange={(e) => setMaxA(Number(e.target.value))} />
            </label>
            <label>
              <span>Pause for approval after N misses</span>
              <input type="number" min={0} max={10} value={pause} onChange={(e) => setPause(Number(e.target.value))} />
            </label>
          </div>}
        </section>

        {err && <div className="ai-settings-err">{err}</div>}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>Close</button>
          <button type="button" className="btn primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </Modal>
  );
}

const FEATURE_LABEL: Record<string, string> = {
  solver: 'Assignment solver', chat: 'Assistant chat', notebook: 'Notebook chat', notes: 'Notes', flashcards: 'Flashcards',
  quiz: 'Quizzes', sources: 'Reading sources', overview: 'Notebook overviews', other: 'Other',
};

/** Closing the window hides Salem to the tray (on by default), so tab mode
 *  and anything still being written keep running. */
function TrayToggle() {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => { getAiConfig().then((c) => setOn(c.closeToTray)).catch(() => {}); }, []);
  if (on === null) return null;
  return (
    <label className="toggle">
      <input type="checkbox" checked={on}
        onChange={async (e) => { const v = e.target.checked; setOn(v); await setAiConfig({ closeToTray: v }).catch(() => setOn(!v)); }} />
      <span>Keep running in the tray when the window is closed <span className="muted">— tab mode and anything being written carry on; quit from the tray icon</span></span>
    </label>
  );
}

function ThemePicker() {
  const pref = useThemePref();
  const accent = useAccentPref();
  const shape = useShapePref();
  const preset = ACCENTS.some((a) => a.color === accent);
  const showing = paletteOf(pref);
  const swatch = (p: Palette) => (
    <span className="theme-mini" style={{ '--b': p.swatch[0], '--p': p.swatch[1], '--t': p.swatch[2], '--a': p.swatch[3] } as React.CSSProperties}>
      <i className="mini-side" /><i className="mini-card"><b /><b /><em /></i>
    </span>
  );
  return (
    <>
      <div className="theme-grid" role="radiogroup" aria-label="Theme">
        <button type="button" role="radio" aria-checked={pref === 'system'} className={`theme-opt${pref === 'system' ? ' on' : ''}`}
          onClick={() => setThemePref('system')} title="Graphite or Paper, following your system">
          <span className="theme-mini split">{swatch(PALETTES.find((p) => p.id === 'dark')!)}{swatch(PALETTES.find((p) => p.id === 'light')!)}</span>
          <span className="theme-name"><Monitor />System</span>
        </button>
        {PALETTES.map((p) => (
          <button key={p.id} type="button" role="radio" aria-checked={pref === p.id} className={`theme-opt${pref === p.id ? ' on' : ''}`}
            onClick={() => setThemePref(p.id)} title={`${p.name} (${p.base})`}>
            {swatch(p)}
            <span className="theme-name">{p.base === 'dark' ? <Moon /> : <Sun />}{p.name}</span>
          </button>
        ))}
      </div>
      <div className="accent-row" role="radiogroup" aria-label="Shape">
        <span>Shape</span>
        <div className="seg small shape-seg" style={{ '--n': 2 } as React.CSSProperties}>
          {(['sharp', 'rounded'] as ShapePref[]).map((v) => (
            <button key={v} type="button" role="radio" aria-checked={shape === v} className={`seg-item${shape === v ? ' on' : ''}`} onClick={() => setShapePref(v)}>
              {v === 'sharp' ? <><Square />Sharp</> : <><RectangleHorizontal />Rounded</>}
            </button>
          ))}
          <span className="seg-glider" style={{ transform: `translateX(${shape === 'sharp' ? 0 : 100}%)` }} />
        </div>
      </div>
      <div className="accent-row" role="radiogroup" aria-label="Accent colour">
        <span>Accent</span>
        {ACCENTS.map((a) => (
          <button key={a.name} type="button" role="radio" aria-checked={accent === a.color} title={a.color ? a.name : `${showing.name}'s own`}
            className={`accent-dot${accent === a.color ? ' on' : ''}`} style={{ '--c': a.color || showing.swatch[3] } as React.CSSProperties}
            onClick={() => setAccentPref(a.color)} />
        ))}
        <label className={`accent-dot accent-custom${preset ? '' : ' on'}`} title="Custom colour">
          <input type="color" value={accent || showing.swatch[3]} onChange={(e) => setAccentPref(e.target.value)} />
        </label>
      </div>
    </>
  );
}

/**
 * How the AI runtime has actually been behaving.
 *
 * Counts and durations only — never what was asked or answered. This is the
 * page to look at when the AI "feels broken": it says whether tools are
 * failing, whether runs are being retried, and whether the runtime can even
 * start.
 */
function RuntimeSection() {
  const [health, setHealth] = useState<RuntimeStatus | null>(null);
  const [stats, setStats] = useState<RuntimeStats | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    runtimeStatus().then(setHealth).catch(() => setHealth(null));
    runtimeTelemetry().then((t) => setStats(t as RuntimeStats)).catch(() => setStats(null));
  }, []);
  useEffect(() => { load(); }, [load]);

  const total = stats?.total;
  const rate = total && total.runs ? Math.round((total.completed / total.runs) * 100) : null;
  const toolRate = total && total.toolCalls ? Math.round((total.toolFailures / total.toolCalls) * 100) : 0;

  return (
    <section>
      <h4>AI RUNTIME</h4>
      {health ? (
        health.ready ? (
          <p className="muted small">
            Ready · smolagents {health.hello?.smolagents ?? '?'} on Python {health.hello?.python ?? '?'}
          </p>
        ) : (
          <div className="runtime-trouble">
            <p className="form-err">Not running: {health.error ?? 'unknown reason'}</p>
            {health.interpreter && <p className="muted small mono">Tried: {health.interpreter}</p>}
            {health.details && (
              <details>
                <summary className="muted small">What Python said</summary>
                <pre className="runtime-log">{health.details}</pre>
              </details>
            )}
            <p className="muted small">
              If you have just installed or updated Python, press Restart the runtime below.
            </p>
          </div>
        )
      ) : <p className="muted small">Checking…</p>}

      {total && total.runs > 0 ? (
        <>
          <div className="usage-totals">
            <div className="usage-total">
              <span className="usage-num">{rate}%</span>
              <span className="muted">finished · {fmtInt(total.runs)} runs</span>
            </div>
            <div className="usage-total">
              <span className="usage-num">{Math.round(total.avgDurationMs / 100) / 10}s</span>
              <span className="muted">average run</span>
            </div>
            <div className="usage-total">
              <span className="usage-num">{toolRate}%</span>
              <span className="muted">of {fmtInt(total.toolCalls)} tool calls failed</span>
            </div>
          </div>
          <p className="muted small">
            {fmtInt(total.retries)} retries · {fmtInt(total.pythonFailures)} Python failures ·{' '}
            {fmtInt(total.retrievalFailures)} retrieval failures · {fmtInt(total.subagents)} sub-agents ·{' '}
            {fmtInt(total.failed)} failed · {fmtInt(total.cancelled)} stopped
          </p>
          {!!stats?.byFeature?.length && (
            <div className="usage-features">
              {stats.byFeature.map((f) => (
                <div key={f.feature} className="usage-feature">
                  <span className="usage-feature-name">{FEATURE_LABEL[f.feature] ?? f.feature}</span>
                  <span className="usage-bar"><span style={{ width: `${(f.runs / Math.max(1, total.runs)) * 100}%` }} /></span>
                  <span className="usage-feature-num">{fmtInt(f.runs)}</span>
                  <span className="muted usage-feature-tok">{f.failed ? `${fmtInt(f.failed)} failed` : 'all fine'}</span>
                </div>
              ))}
            </div>
          )}
        </>
      ) : <p className="muted small">No AI runs recorded yet.</p>}

      <div className="account-row">
        <button type="button" className="btn ghost" onClick={load}>Refresh</button>
        <button
          type="button"
          className="btn ghost"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            // Restarting picks up a changed interpreter or a reinstalled
            // smolagents without closing the app.
            await restartRuntime().catch(() => {});
            await runtimeStatus().then(setHealth).catch(() => {});
            setBusy(false);
          }}
        >
          {busy ? 'Restarting…' : 'Restart the runtime'}
        </button>
      </div>
    </section>
  );
}

type RuntimeStats = {
  total: {
    runs: number; completed: number; failed: number; cancelled: number; avgDurationMs: number;
    toolCalls: number; toolFailures: number; pythonCalls: number; pythonFailures: number;
    retrievalFailures: number; retries: number; subagents: number; tokens: number;
  };
  byFeature: { feature: string; runs: number; failed: number; avgDurationMs: number }[];
};

/** Every AI call the app makes, totalled: solver, chats, notes, cards, quizzes, reading sources. */
function UsageSection() {
  const [u, setU] = useState<UsageSummary | null>(null);
  const [confirm, setConfirm] = useState(false);
  const load = () => studyApi.usage().then(setU).catch(() => setU(null));
  useEffect(() => { load(); }, []);
  const maxCost = Math.max(1e-9, ...(u?.byFeature ?? []).map((f) => f.cost));
  return (
    <section>
      <h4>USAGE</h4>
      {!u || u.total.calls === 0 ? (
        <p className="muted">No AI calls recorded yet. Everything that uses the AI is counted here.</p>
      ) : (
        <>
          <div className="usage-totals">
            <div className="usage-total"><span className="usage-num">{fmtCost(u.total.cost)}</span><span className="muted">spent in total</span></div>
            <div className="usage-total"><span className="usage-num">{fmtInt(u.total.tokens)}</span><span className="muted">tokens · {fmtInt(u.total.calls)} calls</span></div>
            <div className="usage-total"><span className="usage-num">{fmtCost(u.last30.cost)}</span><span className="muted">last 30 days · {fmtInt(u.last30.tokens)} tok</span></div>
          </div>
          <div className="usage-features">
            {u.byFeature.map((f) => (
              <div key={f.key} className="usage-feature">
                <span className="usage-feature-name">{FEATURE_LABEL[f.key] ?? f.key}</span>
                <span className="usage-bar"><span style={{ width: `${(f.cost / maxCost) * 100}%` }} /></span>
                <span className="usage-feature-num">{fmtCost(f.cost)}</span>
                <span className="muted usage-feature-tok">{fmtInt(f.tokens)} tok</span>
              </div>
            ))}
          </div>
          <div className="account-row">
            <span className="muted">
              {u.byModel.map((m) => `${m.key}: ${fmtInt(m.calls)} calls`).join(' · ')}
              {u.since && ` · since ${new Date(u.since).toLocaleDateString()}`}. Costs are estimates from DeepSeek's list prices, including off-peak rates.
            </span>
            {confirm ? (
              <>
                <button type="button" className="btn ghost danger" onClick={async () => { await studyApi.resetUsage(); setConfirm(false); load(); }}>Reset totals</button>
                <button type="button" className="btn ghost" onClick={() => setConfirm(false)}>Keep</button>
              </>
            ) : <button type="button" className="btn ghost" onClick={() => setConfirm(true)}>Reset…</button>}
          </div>
        </>
      )}
    </section>
  );
}

/** Custom instructions for the chats (not the solver). */
function PersonalSection() {
  const p = usePersonal();
  return (
    <section>
      <h4>PERSONALIZATION</h4>
      <p className="muted">Used by the assistant and notebook chats, like custom instructions. Stays on this computer.</p>
      <div className="tone-row" role="radiogroup" aria-label="Response style">
        {TONES.map((t) => (
          <button key={t.tone} type="button" role="radio" aria-checked={p.tone === t.tone} className={`tone-opt${p.tone === t.tone ? ' on' : ''}`} onClick={() => setPersonal({ tone: t.tone })} title={t.hint}>
            <b>{t.label}</b><span>{t.hint}</span>
          </button>
        ))}
      </div>
      <label>
        <span>What should the AI know about you?</span>
        <textarea className="textarea" rows={3} value={p.about} onChange={(e) => setPersonal({ about: e.target.value })}
          placeholder="e.g. Second-year mechanical engineering student. Taking Calculus III and Dynamics. I learn best from worked examples." />
      </label>
      <label>
        <span>How should it respond?</span>
        <textarea className="textarea" rows={3} value={p.instructions} onChange={(e) => setPersonal({ instructions: e.target.value })}
          placeholder="e.g. Use SI units. Show every algebra step. Keep answers short unless I ask for more." />
      </label>
    </section>
  );
}

/** What the chats have learned about the student: see it, fix it, delete it. */
function MemorySection() {
  const p = usePersonal();
  const [state, setState] = useState<MemoryState | null>(null);
  const [adding, setAdding] = useState('');
  const [editing, setEditing] = useState<number | null>(null);
  const [filter, setFilter] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = () => studyApi.memories().then(setState).catch((e) => setErr(errText(e)));
  useEffect(() => { void load(); }, []);
  const act = async (fn: () => Promise<unknown>) => { setErr(null); try { await fn(); } catch (e) { setErr(errText(e)); } await load(); };

  const items = state?.items ?? [];
  const pct = state ? Math.min(100, Math.round((state.used / state.capacity) * 100)) : 0;
  const shown = filter.trim() ? items.filter((m) => m.text.toLowerCase().includes(filter.trim().toLowerCase())) : items;
  return (
    <section>
      <h4>MEMORY</h4>
      <label className="feature-row">
        <span className="feature-text">
          <b>Let the AI remember things about you</b>
          <span className="muted">The assistant and notebook chats save lasting facts (your courses, goals, what you find hard, how you like explanations) and use them in every conversation. Nothing leaves this computer except with the questions you send.</span>
        </span>
        <span className="switch">
          <input type="checkbox" checked={p.memory} onChange={(e) => setPersonal({ memory: e.target.checked })} />
          <span className="switch-track"><span className="switch-thumb" /></span>
        </span>
      </label>
      <div className="memory-meter" title={`${state?.used ?? 0} of ${state?.capacity ?? 0} characters`}>
        <span className="memory-bar"><span style={{ width: `${pct}%` }} className={pct >= 90 ? 'full' : ''} /></span>
        <span className="muted">{items.length} memor{items.length === 1 ? 'y' : 'ies'} · {pct}% full</span>
      </div>
      {items.length > 6 && (
        <div className="thread-search memory-search"><Search /><input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search memories" /></div>
      )}
      <ul className="memory-list">
        {shown.map((m) => (
          <li key={m.id} className="memory-item">
            {editing === m.id ? (
              <input
                className="thread-rename"
                autoFocus
                defaultValue={m.text}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { e.currentTarget.value = m.text; e.currentTarget.blur(); } }}
                onBlur={(e) => { const t = e.currentTarget.value.trim(); setEditing(null); if (t && t !== m.text) void act(() => studyApi.updateMemory(m.id, t)); }}
              />
            ) : (
              <button type="button" className="memory-text" onClick={() => setEditing(m.id)} title="Click to edit">
                {m.text}
                <span className="muted memory-meta">{m.source === 'user' ? 'added by you' : 'from a chat'} · {new Date(m.createdAt).toLocaleDateString()}</span>
              </button>
            )}
            <button type="button" className="task-x memory-x" onClick={() => void act(() => studyApi.deleteMemory(m.id))} aria-label="Delete memory"><X /></button>
          </li>
        ))}
        {!items.length && <li className="muted memory-empty">Nothing yet. As you chat, facts about you show up here. You can also add one yourself.</li>}
      </ul>
      <form className="account-row" onSubmit={(e) => { e.preventDefault(); if (adding.trim()) void act(async () => { await studyApi.addMemory(adding, 'user'); setAdding(''); }); }}>
        <input value={adding} onChange={(e) => setAdding(e.target.value)} placeholder="Add a memory, e.g. I'm taking Physics 1 and Calculus 2 this term" />
        <button type="submit" className="btn ghost" disabled={!adding.trim()}>Add</button>
        {items.length > 0 && (confirm ? (
          <>
            <button type="button" className="btn ghost danger" onClick={() => { setConfirm(false); void act(() => studyApi.clearMemories()); }}>Delete all</button>
            <button type="button" className="btn ghost" onClick={() => setConfirm(false)}>Keep</button>
          </>
        ) : <button type="button" className="btn ghost" onClick={() => setConfirm(true)}>Clear…</button>)}
      </form>
      {err && <div className="ai-settings-err">{err}</div>}
    </section>
  );
}

/** Export everything to one file, import one (replacing everything), or start over. */
function DataSection() {
  const [withSettings, setWithSettings] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState<{ path: string; info: ExportInfo } | null>(null);
  const [resetting, setResetting] = useState(false);
  const [forgetKey, setForgetKey] = useState(false);
  const [typed, setTyped] = useState('');

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label); setErr(null); setDone(null);
    try { await fn(); } catch (e) { setErr(errText(e)); } finally { setBusy(null); }
  };
  const doExport = () => run('Exporting…', async () => {
    const r = await exportData(withSettings);
    if (r) setDone(`Exported ${fmtBytes(r.bytes)} to ${r.path}`);
  });
  const name = (p: string) => p.split(/[\\/]/).pop();
  const count = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

  return (
    <section>
      <h4>DATA</h4>
      <div className="data-row">
        <div className="feature-text">
          <b>Export</b>
          <span className="muted">One file with everything: subjects, notebooks, sources and their files, notes, flashcards, quizzes, chats, schedule and memory.</span>
          <label className="account-check">
            <input type="checkbox" checked={withSettings} onChange={(e) => setWithSettings(e.target.checked)} />
            <span>Include settings (appearance, personalization, AI and Python settings). Your API key is never exported.</span>
          </label>
        </div>
        <button type="button" className="btn" disabled={!!busy} onClick={() => void doExport()}><Download />Export…</button>
      </div>

      <div className="data-row">
        <div className="feature-text">
          <b>Import</b>
          <span className="muted">Replace everything here with an exact copy from an export. Your API key stays.</span>
        </div>
        <button type="button" className="btn" disabled={!!busy} onClick={() => void run('Reading the file…', async () => { const p = await pickImport(); if (p) { setPending(p); setResetting(false); } })}><Upload />Import…</button>
      </div>

      {pending && (
        <div className="danger-panel">
          <div className="danger-title"><TriangleAlert />Replace all your data with this export?</div>
          <p>
            <b>{name(pending.path)}</b>{pending.info.exportedAt ? `, exported ${new Date(pending.info.exportedAt).toLocaleString()}` : ''} ({fmtBytes(pending.info.bytes)}) contains {count(pending.info.subjects, 'subject')}, {count(pending.info.notebooks, 'notebook')}, {count(pending.info.sources, 'source')}, {count(pending.info.notes, 'note')}, {count(pending.info.chats, 'chat')} and {count(pending.info.events, 'event')}
            {pending.info.hasSettings ? ', plus settings.' : ' (no settings; yours are kept).'}
          </p>
          <p>Everything you have now is <b>replaced</b>: subjects, notebooks, sources, notes, cards, quizzes, chats, schedule and memory{pending.info.hasSettings ? ', and your settings' : ''}. A copy of your current data is kept in the app folder as <code>study.before-import.db</code> until the next import. The app restarts when it is done.</p>
          <div className="danger-actions">
            <button type="button" className="btn ghost" onClick={() => setPending(null)}>Cancel</button>
            <button type="button" className="btn danger-solid" disabled={!!busy} onClick={() => void run('Importing…', () => importData(pending.path))}>Replace my data</button>
          </div>
        </div>
      )}

      <div className="data-row">
        <div className="feature-text">
          <b className="danger-text">Reset all data</b>
          <span className="muted">Delete everything and start over like a new account.</span>
        </div>
        <button type="button" className="btn ghost danger" disabled={!!busy} onClick={() => { setResetting(true); setPending(null); setTyped(''); }}>Reset…</button>
      </div>

      {resetting && (
        <div className="danger-panel big">
          <div className="danger-title"><TriangleAlert />This permanently deletes all of your data</div>
          <ul>
            <li>every subject and notebook, with all sources and uploaded files</li>
            <li>all notes, flashcard decks, quizzes, scores and analytics</li>
            <li>every chat, the schedule, syllabuses and everything the AI remembers about you</li>
            <li>your preferences (theme, personalization, timer)</li>
          </ul>
          <p>It cannot be undone. <b>Export first</b> if you might want any of it back.</p>
          <label className="account-check">
            <input type="checkbox" checked={forgetKey} onChange={(e) => setForgetKey(e.target.checked)} />
            <span>Also remove my API keys and AI settings</span>
          </label>
          <label className="danger-confirm">
            <span>Type <b>RESET</b> to confirm</span>
            <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="RESET" autoComplete="off" spellCheck={false} />
          </label>
          <div className="danger-actions">
            <button type="button" className="btn ghost" onClick={() => void doExport()} disabled={!!busy}><Download />Export first</button>
            <span className="spacer" />
            <button type="button" className="btn ghost" onClick={() => setResetting(false)}>Cancel</button>
            <button type="button" className="btn danger-solid" disabled={typed.trim() !== 'RESET' || !!busy} onClick={() => void run('Deleting…', () => resetData(forgetKey))}>Delete everything</button>
          </div>
        </div>
      )}

      {busy && <div className="gen-status"><span className="dots"><i /><i /><i /></span>{busy}</div>}
      {done && <p className="muted data-done">{done}</p>}
      {err && <div className="ai-settings-err">{err}</div>}
    </section>
  );
}
