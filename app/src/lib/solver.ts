import { useCallback, useEffect, useRef, useState } from 'react';
import type { Question, SubmitResult } from '../types';
import {
  applyDeduction, extractJsonObject, getAiConfig,
  gradeFeedback, learnFromResults, loadImages, needsPython, normalizeAnswers, questionImages,
  questionPrompt, SUBMIT_TOOL, systemPrompt, TRANSCRIBE_PROMPT, validateAnswers,
  type AiConfig, type ApiContent, type ApiMessage,
} from './ai';
import { generate, generateText, generateVision } from './salem/generate';
import { cancelRun } from './salem/runtime';
import type { SalemEvent } from './salem/types';
import { pythonStatus, type PythonStatus } from './python';
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

/**
 * The question and everything this thread has already said, as one task.
 *
 * The solver's thread is not a chat: it is one question worked at across
 * several attempts, with corrections and grader feedback appended. Folding it
 * into a single instruction keeps that order and keeps the question itself at
 * the top, which is what the model needs to read first.
 */
function threadText(question: ApiContent, thread: ApiMessage[]): unknown[] {
  const head = typeof question === 'string'
    ? question
    : question.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n');
  const images = typeof question === 'string' ? [] : question.filter((p) => p.type === 'image_url');
  const history = thread
    .map((m) => {
      const body = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return `${m.role === 'user' ? 'Feedback' : 'You said'}: ${body}`;
    })
    .join('\n\n');
  return [
    { type: 'text', text: history ? `${head}\n\n## What has happened so far\n${history}` : head },
    ...images,
  ];
}

/** One line about a Python run, for the solver's log. */
function summarizeOutput(output: string): string {
  const line = output.split('\n').map((l) => l.trim()).filter(Boolean).find((l) => !l.startsWith('stdout:')) ?? '';
  return line ? line.slice(0, 160) : 'Ran Python';
}

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
  /** The runtime run in flight, so Stop reaches it and not only the loop. */
  const runRef = useRef<string | null>(null);
  const stopRun = () => { if (runRef.current) void cancelRun(runRef.current); };
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
      const prompt = `${questionPrompt(q, { images: false, transcript: null })}\n\n${TRANSCRIBE_PROMPT}`;
      const described = await Promise.all(
        images.map((url) => generateVision({ feature: 'solver', prompt, image: url }).catch(() => '')),
      );
      const t = described.filter(Boolean).join('\n\n').trim();
      if (!t) return null;
      push({ role: 'system', kind: 'vision', tone: 'muted', text: `Figures read:\n${t}` });
      return t;
    } catch (e) {
      push({ role: 'system', kind: 'error', tone: 'bad', text: `Could not read the figures: ${errText(e)}` });
      return null;
    }
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
        push({
          role: 'system',
          kind: 'solve',
          tone: 'muted',
          text: `Attempt ${a + 1}/${cfg.maxAttempts} · ${model}${useVision ? ' · images' : ''}${py ? (forcePython ? ' · python (required)' : ' · python') : ''}`,
        });

        // One run of the Salem runtime: it works the question out, running
        // Python for the maths as often as its budget allows, and returns
        // answers already checked against the shape the app can submit.
        const budget = py ? Math.max(1, cfg.pythonMaxCalls || 6) : 0;
        const runId = crypto.randomUUID();
        runRef.current = runId;
        let ranPython = 0;
        let solved: { message?: unknown; answers?: unknown } | null = null;
        try {
          solved = await generate<{ message?: unknown; answers?: unknown }>({
            feature: 'solver',
            system: systemPrompt(py) + (forcePython ? '\n\nWork this question out in Python before answering. Do not answer from memory.' : ''),
            instruction: threadText(content, convoRef.current),
            schema: SUBMIT_TOOL.function.parameters,
            run: runId,
            python: { maxCalls: budget },
            onTelemetry: (t) => trackUsage(model, { prompt_tokens: t.input_tokens, completion_tokens: t.output_tokens }),
            onEvent: (event: SalemEvent) => {
              if (event.kind !== 'python') return;
              ranPython += 1;
              pyUsedRef.current = true;
              push({
                role: 'assistant', kind: 'python',
                text: event.status === 'ok' ? summarizeOutput(event.output) : 'Python failed',
                tone: event.status === 'ok' ? 'ok' : 'bad',
                code: event.code, output: event.output,
              });
              // What was computed belongs to the thread, so the next attempt
              // does not work it out again.
              convoRef.current.push({
                role: 'assistant',
                content: `[ran Python:\n${event.code}\n→ ${event.output.slice(0, 800)}]`,
              });
            },
          });
        } catch (e) {
          runRef.current = null;
          if (stopRef.current) { setStat('stopped'); return 'stopped'; }
          push({ role: 'system', kind: 'error', tone: 'bad', text: errText(e) });
          setStat('failed');
          return 'failed';
        }
        runRef.current = null;
        if (stopRef.current) { setStat('stopped'); return 'stopped'; }
        const usedPythonHere = ranPython > 0;

        const parsed = {
          message: String(solved?.message ?? ''),
          answers: (solved?.answers && typeof solved.answers === 'object' ? solved.answers : null) as Record<string, unknown> | null,
        };
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
        push({ role: 'assistant', kind: 'solve', text: parsed.message || '(no explanation)', answers: hasAnswers ? answers : null, model });
        // The answer arrived as structured data; the thread keeps a plain
        // transcript of it.
        convoRef.current.push({ role: 'assistant', content: JSON.stringify({ message: parsed.message, answers }) });
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
    if (runningRef.current) { pendingAdvanceRef.current = true; stopRef.current = true; stopRun(); return; }
    finalizeQuestion();
    stopRef.current = false;
    await advanceQueue();
  }

  function stop() {
    stopRef.current = true;
    stopRun();
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
    const budget = py ? Math.max(1, cfg.pythonMaxCalls || 6) : 0;
    const head = q ? questionPrompt(q, { images: false, transcript: transcriptRef.current }) : 'No question is open.';
    const runId = crypto.randomUUID();
    runRef.current = runId;
    try {
      // Talking about the question is a chat, not a solve: the runtime can
      // still compute, but nothing here touches the answer boxes.
      const text = await generateText({
        feature: 'solver',
        system: systemPrompt(py),
        instruction: threadText(head, convoRef.current),
        run: runId,
        python: { maxCalls: budget },
        onTelemetry: (t) => trackUsage(cfg.flashModel, { prompt_tokens: t.input_tokens, completion_tokens: t.output_tokens }),
        onEvent: (event: SalemEvent) => {
          if (event.kind !== 'python') return;
          pyUsedRef.current = true;
          push({
            role: 'assistant', kind: 'python',
            text: event.status === 'ok' ? summarizeOutput(event.output) : 'Python failed',
            tone: event.status === 'ok' ? 'ok' : 'bad',
            code: event.code, output: event.output,
          });
          convoRef.current.push({ role: 'assistant', content: `[ran Python:\n${event.code}\n→ ${event.output.slice(0, 800)}]` });
        },
      });
      convoRef.current.push({ role: 'assistant', content: text });
      push({ role: 'assistant', kind: 'chat', text: text.trim() || '(empty)', model: cfg.flashModel });
    } catch (e) {
      push({ role: 'system', kind: 'error', tone: 'bad', text: errText(e) });
    } finally {
      runRef.current = null;
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
