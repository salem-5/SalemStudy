import { useCallback, useEffect, useRef, useState } from 'react';
import type { Question, SubmitResult } from '../types';
import {
  aiChat, answersFromReply, applyDeduction, extractJsonObject, FORCE_PYTHON, FORCE_SUBMIT, getAiConfig,
  gradeFeedback, learnFromResults, loadImages, needsPython, normalizeAnswers, PYTHON_TOOL, questionImages,
  questionPrompt, SUBMIT_TOOL, systemPrompt, TRANSCRIBE_PROMPT, validateAnswers,
  type AiConfig, type AiReply, type ApiContent, type ApiMessage, type ToolCall,
} from './ai';
import { formatResult, pythonStatus, runPython, summarize, type PythonStatus } from './python';
import { fixAnswers } from './answer-fix';
import { addUsage, bucketOf, emptyPair, fmtCost, fmtInt, pairCalls, pairCost, pairTotal, type Agg } from './usage';

export type ChatEntry = {
  id: number;
  role: 'user' | 'assistant' | 'system';
  kind: 'chat' | 'solve' | 'feedback' | 'vision' | 'error' | 'manual' | 'usage' | 'python';
  text: string;
  answers?: Record<string, unknown> | null;
  model?: string;
  tone?: 'info' | 'ok' | 'bad' | 'muted';
  /** kind === 'python': the snippet, its output, and whether it is still running. */
  code?: string;
  output?: string;
  running?: boolean;
};

export type SolverStatus = 'idle' | 'running' | 'awaiting' | 'done' | 'failed' | 'stopped';

export type SolverDeps = {
  questionOf: (n: number) => Question | undefined;
  applyAnswers: (q: Question, answers: Record<string, unknown>) => void;
  submit: (q: Question, answers: Record<string, unknown>) => Promise<SubmitResult>;
  afterGraded: (q: Question, r: SubmitResult) => void;
  toast: (kind: 'ok' | 'err' | 'info', text: string) => void;
  recordUsage: (qnum: number, model: string, usage: unknown) => void;
  onQueueDone: (usage: { flash: Agg; pro: Agg }) => void;
};

let seq = 1;
const entry = (e: Omit<ChatEntry, 'id'>): ChatEntry => ({ ...e, id: seq++ });
const errText = (e: unknown) =>
  (e && typeof e === 'object' && 'error' in e ? String((e as { error: unknown }).error) : e instanceof Error ? e.message : String(e));

function parseManual(q: Question, text: string): Record<string, unknown> | null {
  const t = text.trim();
  if (!t) return null;
  const obj = extractJsonObject(t);
  if (obj) {
    const answers = obj.answers;
    if (answers && typeof answers === 'object' && !Array.isArray(answers)) return answers as Record<string, unknown>;
    if (Object.keys(obj).some((k) => /^\d+$/.test(k) || /^[a-z]$/i.test(k))) return obj;
  }
  if (q.boxes.length === 1) return { '1': t };
  const out: Record<string, unknown> = {};
  for (const line of t.split(/\n|;/)) {
    const m = /^\s*\[?(\d+)\]?\s*[:=]\s*(.+)$/.exec(line);
    if (m) out[m[1]] = m[2].trim();
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Drives the DeepSeek solve loop: attempt 1 on Flash (with vision when the
 * question has figures), later attempts on the Pro model with a transcription
 * of those figures. After `pauseAfter` misses it parks in `awaiting` until the
 * user continues. Max `maxAttempts` submissions, then it gives up and lets the
 * user type the answer.
 *
 * It also remembers which parts are already correct and which choices have
 * been ruled out, so a single-choice box with one option left is picked
 * directly, and reports token usage per question and per assignment run.
 */
export function useSolver(deps: SolverDeps) {
  const depsRef = useRef(deps);
  depsRef.current = deps;

  const [status, setStatus] = useState<SolverStatus>('idle');
  const [qnum, setQnum] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [queue, setQueue] = useState<number[]>([]);
  const [config, setConfig] = useState<AiConfig | null>(null);
  const [python, setPython] = useState<PythonStatus | null>(null);

  const statusRef = useRef<SolverStatus>('idle');
  const qnumRef = useRef<number | null>(null);
  const attemptRef = useRef(0);
  const queueRef = useRef<number[]>([]);
  const configRef = useRef<AiConfig | null>(null);
  const convoRef = useRef<ApiMessage[]>([]);
  const transcriptRef = useRef<string | null>(null);
  const imagesRef = useRef<string[]>([]);
  const stopRef = useRef(false);
  const approveRef = useRef(true);
  const pendingAdvanceRef = useRef(false);
  const runningRef = useRef(false);
  const qUsageRef = useRef(emptyPair());
  const runUsageRef = useRef(emptyPair());
  const elimRef = useRef<Map<number, Set<string>>>(new Map());
  const correctRef = useRef<Map<number, unknown>>(new Map());
  const usagePostedRef = useRef(false);
  const runSizeRef = useRef(0);
  const hasLogRef = useRef(false);
  const pythonRef = useRef<PythonStatus | null>(null);
  /** Did this question's attempts actually run Python? */
  const pyUsedRef = useRef(false);
  /** Attempts that were worked out by hand and still came back wrong. */
  const handMissesRef = useRef(0);

  const setStat = (s: SolverStatus) => { statusRef.current = s; setStatus(s); };
  const push = useCallback((e: Omit<ChatEntry, 'id'>) => {
    hasLogRef.current = true;
    const it = entry(e);
    setEntries((prev) => [...prev, it]);
    return it.id;
  }, []);
  /** Fill in an entry that was logged before its result existed (a Python run). */
  const amend = useCallback((id: number, patch: Partial<ChatEntry>) => {
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  }, []);

  const reloadConfig = useCallback(async () => {
    try {
      const c = await getAiConfig();
      configRef.current = c;
      setConfig(c);
      return c;
    } catch {
      return null;
    }
  }, []);

  const reloadPython = useCallback(async () => {
    try {
      const s = await pythonStatus();
      pythonRef.current = s;
      setPython(s);
      return s;
    } catch {
      pythonRef.current = null;
      setPython(null);
      return null;
    }
  }, []);

  useEffect(() => { void reloadConfig(); void reloadPython(); }, [reloadConfig, reloadPython]);

  /** The sandbox is only offered when it is installed and switched on. */
  const pythonOn = () => Boolean(pythonRef.current?.ready && configRef.current?.pythonEnabled);

  function trackUsage(model: string, usage: unknown) {
    if (!usage || typeof usage !== 'object') return;
    const b = bucketOf(model);
    qUsageRef.current[b] = addUsage(qUsageRef.current[b], usage);
    runUsageRef.current[b] = addUsage(runUsageRef.current[b], usage);
    const n = qnumRef.current;
    if (n != null) depsRef.current.recordUsage(n, model, usage);
  }

  function finalizeQuestion() {
    if (usagePostedRef.current) return;
    const n = qnumRef.current;
    if (n == null) return;
    const u = qUsageRef.current;
    const calls = pairCalls(u);
    if (!calls) return;
    usagePostedRef.current = true;
    push({
      role: 'system',
      kind: 'usage',
      tone: 'info',
      text: `Q${n} · ${fmtInt(pairTotal(u))} tokens · ${calls} call(s) · ~${fmtCost(pairCost(u))}`,
    });
  }

  async function imagesFor(q: Question): Promise<string[]> {
    const urls = questionImages(q);
    if (!urls.length) return [];
    push({ role: 'system', kind: 'vision', tone: 'muted', text: `Loading ${urls.length} figure(s) for the vision model…` });
    const imgs = await loadImages(urls);
    if (!imgs.length) push({ role: 'system', kind: 'vision', tone: 'muted', text: 'No figures could be loaded.' });
    return imgs;
  }

  async function transcribe(q: Question, images: string[]): Promise<string | null> {
    const cfg = configRef.current;
    if (!cfg) return null;
    push({ role: 'system', kind: 'vision', tone: 'muted', text: 'Reading the figures with the Flash vision model…' });
    try {
      const content: ApiContent = [
        { type: 'text', text: `${questionPrompt(q, { images: false, transcript: null })}\n\n${TRANSCRIBE_PROMPT}` },
        ...images.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
      ];
      const r = await aiChat({ feature: 'solver', model: cfg.flashModel, messages: [{ role: 'user', content }], thinking: false });
      trackUsage(cfg.flashModel, r.usage);
      const t = r.content.trim();
      if (!t) return null;
      push({ role: 'system', kind: 'vision', tone: 'muted', text: `Figures read:\n${t}` });
      return t;
    } catch (e) {
      push({ role: 'system', kind: 'error', tone: 'bad', text: `Could not read the figures: ${errText(e)}` });
      return null;
    }
  }

  /** Run one snippet for the model, log it, and return what the model sees. */
  async function callPython(code: string): Promise<string> {
    const id = push({ role: 'assistant', kind: 'python', text: 'Running Python…', code, running: true });
    try {
      const r = await runPython(code, configRef.current?.pythonTimeout);
      pyUsedRef.current = true;
      amend(id, {
        running: false,
        text: summarize(r),
        output: formatResult(r),
        tone: r.ok ? 'ok' : 'bad',
      });
      return formatResult(r);
    } catch (e) {
      const msg = errText(e);
      amend(id, { running: false, text: `Python could not run: ${msg}`, output: msg, tone: 'bad' });
      // Tell the model instead of failing the attempt: it can still answer by
      // hand, and a broken sandbox should not cost a WebAssign submission.
      return `The sandbox could not run that code: ${msg}\nAnswer without Python.`;
    }
  }

  /**
   * Answer every tool call in one assistant turn, appending the assistant
   * message and one reply per call — the API rejects the next request if a
   * call is left unanswered. Returns how many snippets were actually run.
   */
  async function answerToolCalls(thread: ApiMessage[], calls: ToolCall[], content: string, budget: number): Promise<number> {
    thread.push({ role: 'assistant', content: content ?? '', tool_calls: calls });
    let used = 0;
    for (const c of calls) {
      const reply = (text: string) => thread.push({ role: 'tool', tool_call_id: c.id, name: c.function?.name, content: text });
      if (c.function?.name !== 'run_python') {
        reply(`There is no tool called "${c.function?.name}". Use run_python or submit_answers.`);
        continue;
      }
      if (used >= budget) {
        reply('The Python budget for this attempt is used up. Finish with what you have and call submit_answers now.');
        continue;
      }
      const args = extractJsonObject(c.function.arguments ?? '');
      const code = typeof args?.code === 'string' ? args.code : '';
      if (!code.trim()) {
        reply('No code was given. Send the snippet in the "code" argument.');
        continue;
      }
      used += 1;
      reply(await callPython(code));
    }
    return used;
  }

  async function solveCurrent(): Promise<SolverStatus> {
    if (runningRef.current) return statusRef.current;
    const cfg = configRef.current;
    const n = qnumRef.current;
    if (!cfg || n == null) { setStat('idle'); return 'idle'; }
    runningRef.current = true;
    try {
      while (attemptRef.current < cfg.maxAttempts) {
        if (stopRef.current) { setStat('stopped'); return 'stopped'; }
        const a = attemptRef.current;
        if (a >= cfg.pauseAfter && !approveRef.current) {
          push({ role: 'system', kind: 'solve', tone: 'info', text: `${a} attempt(s) used. Continue, give an answer, or move on.` });
          setStat('awaiting');
          return 'awaiting';
        }
        approveRef.current = false;
        const q = depsRef.current.questionOf(n);
        if (!q) { push({ role: 'system', kind: 'error', tone: 'bad', text: `Question ${n} is not loaded.` }); setStat('failed'); return 'failed'; }
        const left = q.boxes
          .map((b) => (b.part.maxSubmissions == null ? null : b.part.maxSubmissions - (b.part.submissions ?? 0)))
          .filter((x): x is number => x != null);
        if (left.length && left.every((x) => x <= 0)) {
          push({ role: 'system', kind: 'feedback', tone: 'bad', text: 'No WebAssign submissions left for this question.' });
          setStat('failed');
          return 'failed';
        }
        if (a > 0 && imagesRef.current.length && !transcriptRef.current) {
          transcriptRef.current = await transcribe(q, imagesRef.current);
        }
        const model = a === 0 ? cfg.flashModel : cfg.proModel;
        const useVision = a === 0 && imagesRef.current.length > 0;
        const py = pythonOn();
        // Insist on Python when the question needs calculating, and always
        // after the model has tried to do it in its head and been wrong.
        const forcePython = py && (
          (cfg.pythonAuto && needsPython(q)) || handMissesRef.current >= 1 || (a > 0 && !pyUsedRef.current)
        );
        if (py && a > 0 && !pyUsedRef.current) {
          convoRef.current.push({
            role: 'user',
            content: 'You worked that out by hand and it was marked wrong. Redo the whole calculation with run_python this time, check the result a second way, and only then answer.',
          });
        }
        const firstUser = questionPrompt(q, { images: useVision, transcript: a > 0 ? transcriptRef.current : null });
        const content: ApiContent = useVision
          ? [{ type: 'text', text: firstUser }, ...imagesRef.current.map((url) => ({ type: 'image_url' as const, image_url: { url } }))]
          : firstUser;
        const messages: ApiMessage[] = [
          { role: 'system', content: systemPrompt(py) },
          { role: 'user', content },
          ...convoRef.current,
        ];
        // Anything appended past this point is this attempt's tool traffic.
        const baseLen = messages.length;
        push({
          role: 'system',
          kind: 'solve',
          tone: 'muted',
          text: `Attempt ${a + 1}/${cfg.maxAttempts} · ${model}${useVision ? ' · images' : ''}${py ? (forcePython ? ' · python (required)' : ' · python') : ''}`,
        });

        // The model may run Python as often as its budget allows before it
        // answers; `submit_answers` is what ends the turn.
        const tools = py ? [PYTHON_TOOL, SUBMIT_TOOL] : [SUBMIT_TOOL];
        const budget = py ? Math.max(1, cfg.pythonMaxCalls || 6) : 0;
        let choice: unknown = py ? (forcePython ? FORCE_PYTHON : 'auto') : FORCE_SUBMIT;
        let reply: AiReply | null = null;
        let ranPython = 0;
        let failed = false;
        for (let round = 0; round < budget + 3; round++) {
          if (stopRef.current) { setStat('stopped'); return 'stopped'; }
          let turn: AiReply;
          try {
            turn = await aiChat({ feature: 'solver', model, messages, thinking: false, tools, toolChoice: choice });
          } catch (e) {
            push({ role: 'system', kind: 'error', tone: 'bad', text: errText(e) });
            failed = true;
            break;
          }
          trackUsage(model, turn.usage);
          const calls = (turn.tool_calls ?? []).filter((c) => c.function?.name);
          if (calls.some((c) => c.function.name === 'submit_answers')) { reply = turn; break; }
          if (!calls.length) {
            // Prose instead of an answer: keep it and ask for the answer.
            messages.push({ role: 'assistant', content: turn.content ?? '' });
            choice = FORCE_SUBMIT;
            continue;
          }
          ranPython += await answerToolCalls(messages, calls, turn.content ?? '', budget - ranPython);
          choice = ranPython >= budget ? FORCE_SUBMIT : 'auto';
        }
        if (failed) { setStat('failed'); return 'failed'; }
        if (stopRef.current) { setStat('stopped'); return 'stopped'; }
        if (!reply) {
          push({ role: 'system', kind: 'feedback', tone: 'bad', text: 'The model never came back with an answer — retrying.' });
          convoRef.current = [];
          attemptRef.current = a + 1;
          setAttempt(a + 1);
          continue;
        }
        // Everything the tool rounds added belongs to the thread, so the next
        // attempt can see what was already computed.
        convoRef.current.push(...messages.slice(baseLen));
        const usedPythonHere = ranPython > 0;

        const parsed = answersFromReply(reply);
        const proposed = parsed.answers ? normalizeAnswers(q, parsed.answers) : {};
        // Strip anything the question already prints around a box before it
        // can cost a submission.
        const cleaned = fixAnswers(q, proposed);
        const { answers, notes } = applyDeduction(q, cleaned.answers, correctRef.current, elimRef.current);
        notes.unshift(...cleaned.notes);
        // Tell the model, so the next attempt in this thread does it right.
        if (cleaned.notes.length) {
          convoRef.current.push({
            role: 'user',
            content: `Your answer repeated text the question already prints, so it was corrected: ${cleaned.notes.join(' | ')}. Type only what goes inside the box.`,
          });
        }
        const hasAnswers = Object.keys(answers).length > 0;
        push({ role: 'assistant', kind: 'solve', text: parsed.message || '(no explanation)', answers: hasAnswers ? answers : null, model: reply.model || model });
        // The answer came back as a tool call, so the thread keeps a plain
        // transcript of it rather than an unanswered call.
        convoRef.current.push({
          role: 'assistant',
          content: reply.content?.trim() || JSON.stringify({ message: parsed.message, answers }),
        });
        for (const note of notes) push({ role: 'system', kind: 'feedback', tone: 'muted', text: note });
        attemptRef.current = a + 1;
        setAttempt(a + 1);

        if (!hasAnswers) {
          // A malformed reply poisons the thread; a clean session reliably fixes
          // it, so drop the conversation and retry from the question prompt.
          convoRef.current = [];
          push({ role: 'system', kind: 'feedback', tone: 'bad', text: 'No answers in the reply — resetting the conversation and retrying.' });
          continue;
        }
        const errs = validateAnswers(q, answers);
        if (errs.length) {
          const note = `These answers cannot be sent to WebAssign:\n${errs.join('\n')}`;
          push({ role: 'system', kind: 'feedback', tone: 'bad', text: note });
          convoRef.current.push({ role: 'user', content: `${note}\nFix them and reply with corrected JSON.` });
          continue;
        }

        depsRef.current.applyAnswers(q, answers);
        let r: SubmitResult;
        try {
          r = await depsRef.current.submit(q, answers);
        } catch (e) {
          const note = `WebAssign rejected the submission: ${errText(e)}`;
          push({ role: 'system', kind: 'feedback', tone: 'bad', text: note });
          convoRef.current.push({ role: 'user', content: `${note}\nAdjust and reply with corrected JSON.` });
          continue;
        }
        depsRef.current.afterGraded(q, r);
        learnFromResults(q, answers, r.results, correctRef.current, elimRef.current);

        if (r.allCorrect) {
          push({ role: 'system', kind: 'feedback', tone: 'ok', text: `All correct after ${a + 1} attempt(s).` });
          setStat('done');
          return 'done';
        }
        // A miss that was worked out by hand is what makes the next attempt
        // insist on Python.
        if (!usedPythonHere) handMissesRef.current += 1;
        const fb = gradeFeedback(r.results.map((x) => ({ index: x.index, status: x.status, message: x.message })));
        push({ role: 'system', kind: 'feedback', tone: 'bad', text: fb });
        convoRef.current.push({ role: 'user', content: fb });
      }
      push({ role: 'system', kind: 'feedback', tone: 'bad', text: `Out of attempts (${cfg.maxAttempts}). Type the answer below to fill it in, or edit the boxes yourself.` });
      setStat('failed');
      return 'failed';
    } finally {
      runningRef.current = false;
    }
  }

  async function startQuestion(n: number, fresh: boolean): Promise<SolverStatus> {
    const q = depsRef.current.questionOf(n);
    if (!q) { push({ role: 'system', kind: 'error', tone: 'bad', text: `Question ${n} is not loaded.` }); setStat('idle'); return 'idle'; }
    const cfg = configRef.current ?? (await reloadConfig());
    if (!cfg) { push({ role: 'system', kind: 'error', tone: 'bad', text: 'Could not read AI settings.' }); setStat('idle'); return 'idle'; }
    if (!cfg.hasKey) {
      push({ role: 'system', kind: 'error', tone: 'bad', text: 'No DeepSeek API key set. Open AI settings and paste one.' });
      setStat('idle');
      return 'idle';
    }
    setQnum(n); qnumRef.current = n;
    setAttempt(0); attemptRef.current = 0;
    convoRef.current = [];
    transcriptRef.current = null;
    elimRef.current = new Map();
    correctRef.current = new Map();
    qUsageRef.current = emptyPair();
    usagePostedRef.current = false;
    pyUsedRef.current = false;
    handMissesRef.current = 0;
    stopRef.current = false;
    pendingAdvanceRef.current = false;
    approveRef.current = true;
    if (fresh) {
      setEntries([]);
      hasLogRef.current = false;
    } else if (hasLogRef.current) {
      push({ role: 'system', kind: 'solve', tone: 'muted', text: `── Q${n} ──` });
    }
    setStat('running');
    const py = pythonOn();
    push({
      role: 'system',
      kind: 'solve',
      tone: 'info',
      text: `Solving Q${n} — ${cfg.flashModel}, switching to ${cfg.proModel} after the first miss.`
        + (py ? ` Python sandbox ready (${cfg.pythonTimeout}s per run).` : ''),
    });
    imagesRef.current = await imagesFor(q);
    return solveCurrent();
  }

  async function advanceQueue() {
    if (stopRef.current) return;
    const q = queueRef.current;
    if (!q.length) {
      if (runSizeRef.current > 1) {
        const u = runUsageRef.current;
        if (pairCalls(u)) {
          push({ role: 'system', kind: 'usage', tone: 'ok', text: `Assignment finished · ${fmtInt(pairTotal(u))} tokens total · ~${fmtCost(pairCost(u))}` });
          depsRef.current.onQueueDone(u);
        }
      }
      setStat('idle');
      return;
    }
    const next = q.shift()!;
    setQueue([...q]);
    const res = await startQuestion(next, false);
    await afterSolve(res);
  }

  async function afterSolve(res: SolverStatus) {
    if (res !== 'awaiting' && res !== 'running') finalizeQuestion();
    if (res === 'done') { await advanceQueue(); return; }
    if (pendingAdvanceRef.current) { pendingAdvanceRef.current = false; await advanceQueue(); }
  }

  /** Start solving a list of questions in order. */
  async function start(list: number[]) {
    if (!list.length || runningRef.current) return;
    runUsageRef.current = emptyPair();
    runSizeRef.current = list.length;
    queueRef.current = list.slice(1);
    setQueue([...queueRef.current]);
    const res = await startQuestion(list[0], true);
    await afterSolve(res);
  }

  /** Approve continuing past the pause point. */
  async function continueSolve() {
    if (statusRef.current !== 'awaiting') return;
    approveRef.current = true;
    const res = await solveCurrent();
    await afterSolve(res);
  }

  /** Skip the current question and continue with the queue. */
  async function nextQuestion() {
    if (runningRef.current) { pendingAdvanceRef.current = true; stopRef.current = true; return; }
    finalizeQuestion();
    stopRef.current = false;
    await advanceQueue();
  }

  function stop() {
    stopRef.current = true;
    pendingAdvanceRef.current = false;
    queueRef.current = [];
    setQueue([]);
    if (!runningRef.current) { finalizeQuestion(); setStat('stopped'); }
  }

  /** Focus the panel on a question (only while idle; never disturbs a run). */
  function focus(n: number) {
    if (statusRef.current === 'running' || statusRef.current === 'awaiting') return;
    if (qnumRef.current === n) return;
    setQnum(n); qnumRef.current = n;
    setEntries([]);
    hasLogRef.current = false;
    convoRef.current = [];
    transcriptRef.current = null;
    imagesRef.current = [];
    attemptRef.current = 0;
    setAttempt(0);
    elimRef.current = new Map();
    correctRef.current = new Map();
    qUsageRef.current = emptyPair();
    usagePostedRef.current = false;
    pyUsedRef.current = false;
    handMissesRef.current = 0;
    setStat('idle');
  }

  /** A chat message: extra instruction, correction, or a free-form question. */
  async function send(text: string) {
    const t = text.trim();
    if (!t) return;
    push({ role: 'user', kind: 'chat', text: t });
    convoRef.current.push({ role: 'user', content: t });

    if (statusRef.current === 'awaiting') {
      approveRef.current = true;
      const res = await solveCurrent();
      await afterSolve(res);
      return;
    }
    if (statusRef.current === 'running') return; // folded into the next attempt

    const cfg = configRef.current;
    if (!cfg?.hasKey) { push({ role: 'system', kind: 'error', tone: 'bad', text: 'No DeepSeek API key set.' }); return; }
    const q = qnumRef.current != null ? depsRef.current.questionOf(qnumRef.current) : undefined;
    const py = pythonOn();
    const messages: ApiMessage[] = [{ role: 'system', content: systemPrompt(py) }];
    if (q) messages.push({ role: 'user', content: questionPrompt(q, { images: false, transcript: transcriptRef.current }) });
    messages.push(...convoRef.current);
    const baseLen = messages.length;
    const budget = py ? Math.max(1, cfg.pythonMaxCalls || 6) : 0;
    try {
      // The chat can compute too: it keeps answering tool calls until the
      // model writes a normal reply.
      let used = 0;
      for (let round = 0; round < budget + 1; round++) {
        const r = await aiChat({ feature: 'solver',
          model: cfg.flashModel,
          messages,
          thinking: false,
          tools: py ? [PYTHON_TOOL] : undefined,
        });
        trackUsage(cfg.flashModel, r.usage);
        const calls = (r.tool_calls ?? []).filter((c) => c.function?.name === 'run_python');
        if (calls.length && used < budget) {
          used += await answerToolCalls(messages, calls, r.content ?? '', budget - used);
          continue;
        }
        convoRef.current.push(...messages.slice(baseLen), { role: 'assistant', content: r.content });
        push({ role: 'assistant', kind: 'chat', text: r.content.trim() || '(empty)', model: r.model });
        return;
      }
      push({ role: 'system', kind: 'feedback', tone: 'bad', text: 'The model kept calling Python without answering. Ask again.' });
    } catch (e) {
      push({ role: 'system', kind: 'error', tone: 'bad', text: errText(e) });
    }
  }

  /** Fill the boxes from a typed answer; optionally submit it. */
  async function manualFill(text: string, submit: boolean) {
    const n = qnumRef.current;
    const q = n != null ? depsRef.current.questionOf(n) : undefined;
    if (!q) { depsRef.current.toast('err', 'No question selected.'); return; }
    const parsed = parseManual(q, text);
    if (!parsed) {
      push({ role: 'system', kind: 'manual', tone: 'bad', text: 'Could not read that answer. For several boxes use {"1": "...", "2": "..."}.' });
      return;
    }
    const fixed = fixAnswers(q, normalizeAnswers(q, parsed));
    const answers = fixed.answers;
    for (const note of fixed.notes) push({ role: 'system', kind: 'manual', tone: 'muted', text: note });
    const errs = validateAnswers(q, answers);
    if (errs.length) { push({ role: 'system', kind: 'manual', tone: 'bad', text: errs.join('\n') }); return; }
    depsRef.current.applyAnswers(q, answers);
    push({ role: 'user', kind: 'manual', text: `Manual answer: ${JSON.stringify(answers)}` });
    if (!submit) { depsRef.current.toast('ok', `Filled ${Object.keys(answers).length} box(es) for Q${q.number}.`); return; }
    try {
      const r = await depsRef.current.submit(q, answers);
      depsRef.current.afterGraded(q, r);
      learnFromResults(q, answers, r.results, correctRef.current, elimRef.current);
      if (r.allCorrect) {
        push({ role: 'system', kind: 'manual', tone: 'ok', text: 'Submitted — all correct.' });
        setStat('done');
      } else {
        push({ role: 'system', kind: 'manual', tone: 'bad', text: gradeFeedback(r.results.map((x) => ({ index: x.index, status: x.status, message: x.message }))) });
      }
    } catch (e) {
      push({ role: 'system', kind: 'error', tone: 'bad', text: errText(e) });
    }
  }

  function clearChat() {
    setEntries([]);
    hasLogRef.current = false;
    convoRef.current = [];
  }

  return {
    status, qnum, attempt, entries, queue, config, python,
    start, continueSolve, nextQuestion, stop, focus, send, manualFill, clearChat, reloadConfig, reloadPython,
  };
}
