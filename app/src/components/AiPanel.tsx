import { useEffect, useRef, useState } from 'react';
import type { Box, Question } from '../types';
import type { ChatEntry, useSolver } from '../lib/solver';
import { deepseekBalance, getAiConfig, setAiConfig, type AiConfig, type Balance, type ConfigPatch } from '../lib/ai';
import { fmtCost, fmtInt, pairCalls, pairCost, pairTotal, type UsageRecord } from '../lib/usage';
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

function Entry({ e, boxes }: { e: ChatEntry; boxes: Box[] }) {
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

export function AiPanel({ solver, question, questions, onOpenSettings, onClose }: {
  solver: Solver;
  question: Question | undefined;
  questions: number[];
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
    if (!cfg?.hasKey) { setBalance(null); return; }
    let alive = true;
    setBalBusy(true);
    deepseekBalance()
      .then((b) => { if (alive) setBalance(fmtBalance(b)); })
      .catch(() => { if (alive) setBalance(null); })
      .finally(() => { if (alive) setBalBusy(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg?.hasKey]);

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
    <aside className="ai">
      <header className="ai-head">
        <span className={`ai-status ${status}`}>{STATUS_LABEL[status]}</span>
        <span className="ai-title">AI SOLVE</span>
        {solver.attempt > 0 && <span className="ai-attempt">try {solver.attempt}</span>}
        <span className="spacer" />
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

export function AiSettingsDialog({ onClose, onSaved, usageMap }: {
  onClose: () => void;
  onSaved: (c: AiConfig) => void;
  usageMap: Record<string, UsageRecord>;
}) {
  const [cfg, setCfg] = useState<AiConfig | null>(null);
  const [key, setKey] = useState('');
  const [flash, setFlash] = useState('');
  const [pro, setPro] = useState('');
  const [base, setBase] = useState('');
  const [maxA, setMaxA] = useState(4);
  const [pause, setPause] = useState(2);
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
  };

  useEffect(() => {
    getAiConfig().then(apply).catch((e) => setErr(errText(e)));
  }, []);

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      const patch: ConfigPatch = { flashModel: flash, proModel: pro, baseUrl: base, maxAttempts: maxA, pauseAfter: pause };
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
