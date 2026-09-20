import { useEffect, useRef, useState } from 'react';
import type { Box, Question } from '../types';
import type { ChatEntry, useSolver } from '../lib/solver';
import { deepseekBalance, getAiConfig, setAiConfig, type AiConfig, type Balance, type ConfigPatch } from '../lib/ai';
import { onPythonProgress, pythonSetup, pythonStatus, type PythonStatus } from '../lib/python';
import { fmtCost, fmtInt, pairCalls, pairCost, pairTotal, type UsageRecord } from '../lib/usage';
import { refetchesLeft } from '../lib/cache';
import { MathView } from './MathView';
import { Modal } from './Dialogs';
import { BarChart } from './UsageChart';

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
        <button type="button" className="icon-btn" title="AI settings" onClick={onOpenSettings}>⚙</button>
        <button type="button" className="icon-btn" title="Close panel" onClick={onClose}>✕</button>
      </header>

      {!cfg?.hasKey && (
        <div className="ai-warn">
          No DeepSeek API key yet. <button type="button" className="link" onClick={onOpenSettings}>Add one</button>
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
function PythonSection({ cfg, patch, onChanged }: {
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
        <span>Let the solver run Python</span>
      </label>
      <label className="account-check">
        <input type="checkbox" checked={cfg.auto} onChange={(e) => patch({ auto: e.target.checked })} />
        <span>Require it for any question that needs calculating (off: only after a wrong answer)</span>
      </label>
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

export function AiSettingsDialog({ onClose, onSaved, usageMap, onClearCache, onPythonChanged }: {
  onClose: () => void;
  onSaved: (c: AiConfig) => void;
  usageMap: Record<string, UsageRecord>;
  onClearCache: () => void;
  onPythonChanged: () => void;
}) {
  const [cfg, setCfg] = useState<AiConfig | null>(null);
  const [key, setKey] = useState('');
  const [flash, setFlash] = useState('');
  const [pro, setPro] = useState('');
  const [base, setBase] = useState('');
  const [maxA, setMaxA] = useState(4);
  const [pause, setPause] = useState(2);
  const [py, setPy] = useState({ enabled: true, auto: true, path: '', timeout: 25, maxCalls: 6 });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);

  const apply = (c: AiConfig) => {
    setCfg(c);
    setFlash(c.flashModel);
    setPro(c.proModel);
    setBase(c.baseUrl);
    setMaxA(c.maxAttempts);
    setPause(c.pauseAfter);
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
        flashModel: flash, proModel: pro, baseUrl: base, maxAttempts: maxA, pauseAfter: pause,
        pythonEnabled: py.enabled, pythonAuto: py.auto, pythonPath: py.path,
        pythonTimeout: py.timeout, pythonMaxCalls: py.maxCalls,
      };
      if (key.trim()) patch.apiKey = key.trim();
      const next = await setAiConfig(patch);
      onSaved(next);
      onClose();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setSaving(false);
    }
  };

  const removeKey = async () => {
    setSaving(true);
    setErr(null);
    try {
      const next = await setAiConfig({ apiKey: '' });
      apply(next);
      onSaved(next);
      setKey('');
    } catch (e) {
      setErr(errText(e));
    } finally {
      setSaving(false);
    }
  };

  const records = Object.values(usageMap).sort((a, b) => b.updated - a.updated);
  const active = records.find((r) => String(r.assignmentId) === sel) ?? records[0];
  const qBars = active
    ? Object.entries(active.questions)
      .map(([n, q]) => ({ n: Number(n), label: `Q${n}`, value: pairTotal(q), sub: `${q.attempts} attempt(s) · ~${fmtCost(pairCost(q))}` }))
      .sort((a, b) => a.n - b.n)
      .map(({ label, value, sub }) => ({ label, value, sub }))
    : [];

  return (
    <Modal title="AI / ACCOUNT" onClose={onClose} wide>
      <div className="ai-settings">
        <section>
          <h4>API KEY</h4>
          <div className="account-row">
            <input
              type="password"
              value={key}
              spellCheck={false}
              placeholder={cfg?.hasKey ? `saved: ${cfg.keyHint} — type a new key to replace` : 'sk-…'}
              onChange={(e) => setKey(e.target.value)}
            />
            <button type="button" className="btn ghost" disabled={saving || !key.trim()} onClick={save}>Save key</button>
            <button type="button" className="btn ghost danger" disabled={saving || !cfg?.hasKey} onClick={removeKey}>Remove key</button>
          </div>
          <p className="muted">
            Stored on this machine only, under the app config folder. Nothing is written to the project.
          </p>
        </section>

        <section>
          <h4>BALANCE</h4>
          <BalanceRow />
        </section>

        <section>
          <h4>USAGE</h4>
          {records.length === 0 ? (
            <p className="muted">No usage recorded yet. Solve a question and it will show up here.</p>
          ) : (
            <>
              <div className="account-row">
                <label className="account-pick">
                  <span>Assignment</span>
                  <select value={active ? String(active.assignmentId) : ''} onChange={(e) => setSel(e.target.value)}>
                    {records.map((r) => (
                      <option key={r.assignmentId} value={String(r.assignmentId)}>
                        {r.name || `#${r.assignmentId}`} — {fmtInt(pairTotal(r))} tok
                      </option>
                    ))}
                  </select>
                </label>
                {active && (
                  <span className="account-balance">
                    {fmtInt(pairTotal(active))} tokens · {pairCalls(active)} calls · ~{fmtCost(pairCost(active))}
                  </span>
                )}
              </div>
              <div className="chart-caption">Tokens per assignment</div>
              <BarChart
                data={records.map((r) => ({
                  label: r.name || `#${r.assignmentId}`,
                  value: pairTotal(r),
                  sub: `${pairCalls(r)} calls · ~${fmtCost(pairCost(r))}`,
                }))}
                unit="tok"
              />
              {active && (
                <>
                  <div className="chart-caption">Tokens per question — {active.name || `#${active.assignmentId}`}</div>
                  <BarChart data={qBars} unit="tok" empty="No questions recorded for this assignment." />
                </>
              )}
            </>
          )}
        </section>

        <PythonSection cfg={py} patch={(p) => setPy((v) => ({ ...v, ...p }))} onChanged={onPythonChanged} />

        <section>
          <h4>CACHE</h4>
          <div className="account-row">
            <button type="button" className="btn ghost" onClick={onClearCache}>Clear question cache</button>
            <span className="muted">
              Questions are cached this session. Refetches left: {refetchesLeft()}. Completed assignments are never refetched.
            </span>
          </div>
        </section>

        <section>
          <h4>MODEL</h4>
          <div className="ai-settings-row">
            <label>
              <span>First-try model (vision)</span>
              <input value={flash} spellCheck={false} onChange={(e) => setFlash(e.target.value)} />
            </label>
            <label>
              <span>Retry model (no vision)</span>
              <input value={pro} spellCheck={false} onChange={(e) => setPro(e.target.value)} />
            </label>
          </div>
          <label>
            <span>API base URL</span>
            <input value={base} spellCheck={false} onChange={(e) => setBase(e.target.value)} />
          </label>
          <div className="ai-settings-row">
            <label>
              <span>Max attempts per question</span>
              <input type="number" min={1} max={10} value={maxA} onChange={(e) => setMaxA(Number(e.target.value))} />
            </label>
            <label>
              <span>Pause for approval after N misses</span>
              <input type="number" min={0} max={10} value={pause} onChange={(e) => setPause(Number(e.target.value))} />
            </label>
          </div>
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
