import { useCallback, useEffect, useRef, useState } from 'react';
import type { Question, SubmitResult } from '../types';
import {
  aiChat, answersFromReply, applyDeduction, extractJsonObject, FORCE_SUBMIT, getAiConfig, gradeFeedback,
  learnFromResults, loadImages, normalizeAnswers, questionImages, questionPrompt, SUBMIT_TOOL, SYSTEM_PROMPT,
  TRANSCRIBE_PROMPT, validateAnswers, type AiConfig, type ApiContent, type ApiMessage,
} from './ai';
import { addUsage, bucketOf, emptyPair, fmtCost, fmtInt, pairCalls, pairCost, pairTotal, type Agg } from './usage';

export type ChatEntry = {
  id: number;
  role: 'user' | 'assistant' | 'system';
  kind: 'chat' | 'solve' | 'feedback' | 'vision' | 'error' | 'manual' | 'usage';
  text: string;
  answers?: Record<string, unknown> | null;
  model?: string;
  tone?: 'info' | 'ok' | 'bad' | 'muted';
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

  const setStat = (s: SolverStatus) => { statusRef.current = s; setStatus(s); };
  const push = useCallback((e: Omit<ChatEntry, 'id'>) => {
    hasLogRef.current = true;
    setEntries((prev) => [...prev, entry(e)]);
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

  useEffect(() => { void reloadConfig(); }, [reloadConfig]);

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
      const r = await aiChat({ model: cfg.flashModel, messages: [{ role: 'user', content }], thinking: false });
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
        const firstUser = questionPrompt(q, { images: useVision, transcript: a > 0 ? transcriptRef.current : null });
        const content: ApiContent = useVision
          ? [{ type: 'text', text: firstUser }, ...imagesRef.current.map((url) => ({ type: 'image_url' as const, image_url: { url } }))]
          : firstUser;
        const messages: ApiMessage[] = [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content },
          ...convoRef.current,
        ];
        push({ role: 'system', kind: 'solve', tone: 'muted', text: `Attempt ${a + 1}/${cfg.maxAttempts} · ${model}${useVision ? ' · images' : ''}` });

        let reply;
        try {
          // Forced tool call: the reliable way to get structured answers.
          reply = await aiChat({ model, messages, thinking: false, tools: [SUBMIT_TOOL], toolChoice: FORCE_SUBMIT });
        } catch (e) {
          push({ role: 'system', kind: 'error', tone: 'bad', text: errText(e) });
          setStat('failed');
          return 'failed';
        }
        if (stopRef.current) { setStat('stopped'); return 'stopped'; }
        trackUsage(model, reply.usage);

        const parsed = answersFromReply(reply);
        const proposed = parsed.answers ? normalizeAnswers(q, parsed.answers) : {};
        const { answers, notes } = applyDeduction(q, proposed, correctRef.current, elimRef.current);
        const hasAnswers = Object.keys(answers).length > 0;
        push({ role: 'assistant', kind: 'solve', text: parsed.message || '(no explanation)', answers: hasAnswers ? answers : null, model: reply.model || model });
        convoRef.current.push({ role: 'assistant', content: reply.content });
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
    push({ role: 'system', kind: 'solve', tone: 'info', text: `Solving Q${n} — ${cfg.flashModel}, switching to ${cfg.proModel} after the first miss.` });
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
    const messages: ApiMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }];
    if (q) messages.push({ role: 'user', content: questionPrompt(q, { images: false, transcript: transcriptRef.current }) });
    messages.push(...convoRef.current);
    try {
      const r = await aiChat({ model: cfg.flashModel, messages, thinking: false });
      trackUsage(cfg.flashModel, r.usage);
      convoRef.current.push({ role: 'assistant', content: r.content });
      push({ role: 'assistant', kind: 'chat', text: r.content.trim() || '(empty)', model: r.model });
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
    const answers = normalizeAnswers(q, parsed);
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
    status, qnum, attempt, entries, queue, config,
    start, continueSolve, nextQuestion, stop, focus, send, manualFill, clearChat, reloadConfig,
  };
}
