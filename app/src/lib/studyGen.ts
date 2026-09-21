import { aiChat, extractJsonObject, getAiConfig, type ApiMessage } from './ai';
import { pythonStatus, runPython } from './python';
import { CARDS_SYSTEM, GRADE_SYSTEM, QUIZ_SYSTEM } from './prompts';
import { studyApi, type ChatMessage, type NewCard, type QuestionType, type QuizQuestion, type SourceHit } from '../study/api';

/**
 * Flashcard and quiz generation with DeepSeek Flash. Output comes through a
 * forced tool call. Quiz answers that can be computed are re-derived in the
 * Python sandbox; a question whose check disagrees is dropped and replaced.
 */

export type StudyContext = { subject: string; notebook: string; courseContext: string };

export type GenSource =
  | { kind: 'topic'; prompt: string }
  | { kind: 'chat'; messages: ChatMessage[] }
  | { kind: 'mistakes'; items: { prompt: string; answer: string; explanation: string; topic: string }[] }
  /** Excerpts of the notebook's sources, plus what to focus on. */
  | { kind: 'sources'; hits: SourceHit[]; focus: string };

function describeSource(src: GenSource): string {
  if (src.kind === 'topic') return `Material to cover (from the student):\n${src.prompt}`;
  if (src.kind === 'sources') {
    const blocks = src.hits.map((h) => `<excerpt source="${h.sourceTitle}" where="${h.label}">\n${h.text}\n</excerpt>`).join('\n\n');
    return `Base everything on these excerpts from the student's course material (not on outside knowledge). Cover the important ideas across all of them.${src.focus.trim() ? `\nFocus on: ${src.focus.trim()}` : ''}\n\n${blocks}`;
  }
  if (src.kind === 'mistakes') {
    return `Questions the student got wrong:\n${src.items.map((m, i) => `${i + 1}. ${m.prompt}\n   Answer: ${m.answer}\n   Why: ${m.explanation}`).join('\n')}`;
  }
  const transcript = src.messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => `${m.role === 'user' ? 'Student' : 'Tutor'}: ${m.content}`)
    .join('\n\n');
  return `Base everything on this conversation (the tutor's explanations are the reference):\n\n${transcript.slice(-60_000)}`;
}

function contextBlock(ctx: StudyContext): string {
  return `Course: ${ctx.subject}\nNotebook: ${ctx.notebook}${ctx.courseContext.trim() ? `\nCourse notes (notation, conventions — follow them):\n${ctx.courseContext.trim()}` : ''}`;
}

async function forcedCall(system: string, user: string, tool: { function: { name: string } }): Promise<Record<string, unknown>> {
  const feature = tool.function.name === 'save_flashcards' ? 'flashcards' : 'quiz';
  const cfg = await getAiConfig();
  if (!cfg.hasKey) throw new Error('No DeepSeek API key yet. Add one in Settings.');
  const messages: ApiMessage[] = [{ role: 'system', content: system }, { role: 'user', content: user }];
  const reply = await aiChat({
    feature,
    model: cfg.flashModel,
    messages,
    tools: [tool],
    toolChoice: { type: 'function', function: { name: tool.function.name } },
    thinking: false,
  });
  const call = reply.tool_calls?.find((c) => c.function?.name === tool.function.name);
  const args = extractJsonObject(call?.function.arguments ?? reply.content);
  if (!args) throw new Error('The model did not return anything usable. Try again.');
  return args;
}

// ------------------------------------------------------------- flashcards

const CARDS_TOOL = {
  type: 'function',
  function: {
    name: 'save_flashcards',
    description: 'Save the flashcards.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'A short, specific name for this set, 2–5 words, e.g. "Lines in 3D space".' },
        cards: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              front: { type: 'string', description: 'A question or cue. Markdown; maths in $...$.' },
              back: { type: 'string', description: 'The answer, short, with one line of why if useful. Markdown; maths in $...$.' },
              topic: { type: 'string', description: 'Short topic name, e.g. "Ratio test".' },
            },
            required: ['front', 'back', 'topic'],
          },
        },
      },
      required: ['title', 'cards'],
    },
  },
};

export async function generateCards(ctx: StudyContext, src: GenSource, count: number, existingFronts: string[]): Promise<{ title: string; cards: NewCard[] }> {
  const avoid = existingFronts.length ? `\n\nThe notebook already has cards with these fronts; do not repeat them:\n${existingFronts.slice(-150).map((f) => `- ${f}`).join('\n')}` : '';
  const args = await forcedCall(
    CARDS_SYSTEM,
    `${contextBlock(ctx)}\n\n${describeSource(src)}\n\nWrite ${count} flashcards.${avoid}`,
    CARDS_TOOL,
  );
  const seen = new Set(existingFronts.map((f) => f.trim().toLowerCase()));
  const out: NewCard[] = [];
  for (const c of (args.cards as { front?: unknown; back?: unknown; topic?: unknown }[] | undefined) ?? []) {
    const front = String(c.front ?? '').trim();
    const back = String(c.back ?? '').trim();
    if (!front || !back || seen.has(front.toLowerCase())) continue;
    seen.add(front.toLowerCase());
    out.push({ front, back, topic: String(c.topic ?? '').trim() });
  }
  if (!out.length) throw new Error('No new cards came back. Try a different prompt.');
  return { title: String(args.title ?? '').trim() || 'Flashcards', cards: out };
}

/** A short title for a chat, from its first exchange. */
export async function generateTitle(question: string, answer: string): Promise<string | null> {
  const cfg = await getAiConfig();
  if (!cfg.hasKey) return null;
  const reply = await aiChat({
    feature: 'chat',
    model: cfg.flashModel,
    thinking: false,
    messages: [
      { role: 'system', content: 'Name this conversation in 2 to 6 words, like a good document title: specific, no quotes, no final period, no "Question about". Reply with the title only.' },
      { role: 'user', content: `User: ${question.slice(0, 1500)}\n\nAssistant: ${answer.slice(0, 1500)}` },
    ],
  });
  const t = reply.content.trim().split('\n')[0].replace(/^["'#*\s]+|["'.*\s]+$/g, '');
  return t ? t.slice(0, 80) : null;
}

/** Missed quiz questions become cards directly: no model call needed. */
export const cardsFromMistakes = (items: { prompt: string; answer: string; explanation: string; topic: string }[]): NewCard[] =>
  items.map((m) => ({ front: m.prompt, back: `**${m.answer}**${m.explanation ? `\n\n${m.explanation}` : ''}`, topic: m.topic }));

// ----------------------------------------------------------------- quizzes

const QUIZ_TOOL = {
  type: 'function',
  function: {
    name: 'save_quiz',
    description: 'Save the quiz.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title, e.g. "Convergence tests".' },
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['mcq', 'tf', 'numeric', 'short'] },
              prompt: { type: 'string', description: 'The question. Markdown; maths in $...$.' },
              choices: { type: 'array', items: { type: 'string' }, description: 'mcq only: 4 options, one correct, plausible distractors.' },
              answer: { type: 'string', description: 'mcq: 0-based index of the right choice. tf: "true" or "false". numeric: the number only (no units). short: a model answer.' },
              tolerance: { type: 'number', description: 'numeric only: accepted absolute error.' },
              unit: { type: 'string', description: 'numeric only: unit the answer is given in, if any.' },
              explanation: { type: 'string', description: 'Worked solution shown after answering. Markdown; maths in $...$.' },
              topic: { type: 'string', description: 'Short topic name.' },
              check_code: {
                type: 'string',
                description: 'Python that derives the correct answer independently and prints it as the LAST line: mcq → the 0-based index, tf → True/False, numeric → the number in the stated unit. sympy (sp), numpy (np), scipy, pint (ureg, Q_) are available. Omit only for purely conceptual questions.',
              },
              figure_code: { type: 'string', description: 'Optional matplotlib code drawing a figure the question needs (graph, diagram). Leave the figure open; it is captured.' },
            },
            required: ['type', 'prompt', 'answer', 'explanation', 'topic'],
          },
        },
      },
      required: ['title', 'questions'],
    },
  },
};

type RawQuestion = {
  type?: unknown; prompt?: unknown; choices?: unknown; answer?: unknown; tolerance?: unknown; unit?: unknown;
  explanation?: unknown; topic?: unknown; check_code?: unknown; figure_code?: unknown;
};

const TYPES: QuestionType[] = ['mcq', 'tf', 'numeric', 'short'];

function normalise(q: RawQuestion): (QuizQuestion & { check?: string; figureCode?: string }) | null {
  const type = TYPES.find((t) => t === q.type);
  const prompt = String(q.prompt ?? '').trim();
  if (!type || !prompt) return null;
  const base = {
    type, prompt,
    explanation: String(q.explanation ?? '').trim(),
    topic: String(q.topic ?? '').trim() || 'General',
    check: typeof q.check_code === 'string' && q.check_code.trim() ? q.check_code : undefined,
    figureCode: typeof q.figure_code === 'string' && q.figure_code.trim() ? q.figure_code : undefined,
  };
  if (type === 'mcq') {
    const choices = Array.isArray(q.choices) ? q.choices.map((c) => String(c).trim()).filter(Boolean) : [];
    const idx = Number(q.answer);
    if (choices.length < 2 || !Number.isInteger(idx) || idx < 0 || idx >= choices.length) return null;
    return { ...base, choices, answer: idx };
  }
  if (type === 'tf') {
    const a = String(q.answer).trim().toLowerCase();
    if (a !== 'true' && a !== 'false') return null;
    return { ...base, answer: a };
  }
  if (type === 'numeric') {
    const n = parseNumber(String(q.answer));
    if (n === null) return null;
    const tol = Number(q.tolerance);
    return { ...base, answer: n, tolerance: Number.isFinite(tol) && tol > 0 ? tol : defaultTolerance(n), unit: String(q.unit ?? '').trim() || undefined };
  }
  const answer = String(q.answer ?? '').trim();
  return answer ? { ...base, answer } : null;
}

export const defaultTolerance = (n: number) => Math.max(Math.abs(n) * 0.01, 1e-6);

/** "3/2", "-0.5", "1.2e3", "2 m/s" → number. */
export function parseNumber(s: string): number | null {
  const t = s.trim().replace(/,/g, '').replace(/−/g, '-');
  const frac = t.match(/^(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)/);
  if (frac) {
    const v = Number(frac[1]) / Number(frac[2]);
    return Number.isFinite(v) ? v : null;
  }
  const m = t.match(/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i);
  if (!m) return null;
  const v = Number(m[0]);
  return Number.isFinite(v) ? v : null;
}

/** Does the check script's last printed line agree with the stated answer? */
export function checkAgrees(q: QuizQuestion, stdout: string): boolean {
  const last = stdout.trim().split('\n').pop()?.trim() ?? '';
  if (!last) return false;
  if (q.type === 'mcq') return Number.parseInt(last, 10) === q.answer;
  if (q.type === 'tf') return last.toLowerCase() === String(q.answer);
  if (q.type === 'numeric') {
    const v = parseNumber(last);
    return v !== null && Math.abs(v - Number(q.answer)) <= Math.max(q.tolerance ?? 0, defaultTolerance(Number(q.answer)));
  }
  return true;
}

export type QuizProgress = (text: string) => void;

export async function generateQuiz(ctx: StudyContext, src: GenSource, count: number, notebookId: number, progress: QuizProgress): Promise<{ title: string; questions: QuizQuestion[]; dropped: number }> {
  let python = false;
  try { python = (await pythonStatus()).ready; } catch { python = false; }
  const kept: QuizQuestion[] = [];
  let title = '';
  let dropped = 0;
  const failures: string[] = [];

  for (let round = 0; round < 3 && kept.length < count; round++) {
    const need = count - kept.length;
    progress(round === 0 ? `Writing ${need} questions…` : `Replacing ${need} question(s) that failed their check…`);
    const retry = failures.length ? `\n\nThese questions failed verification (the check did not reproduce the answer); do not repeat them:\n${failures.slice(-10).join('\n')}` : '';
    const args = await forcedCall(QUIZ_SYSTEM, `${contextBlock(ctx)}\n\n${describeSource(src)}\n\nWrite ${need} questions.${retry}`, QUIZ_TOOL);
    title ||= String(args.title ?? '').trim();
    const raw = Array.isArray(args.questions) ? (args.questions as RawQuestion[]) : [];
    for (const r of raw) {
      if (kept.length >= count) break;
      const q = normalise(r);
      if (!q) { dropped++; continue; }
      const { check, figureCode, ...question } = q;
      if (python && check) {
        progress(`Checking question ${kept.length + 1} in Python…`);
        const res = await runPython(check, 30).catch(() => null);
        if (!res?.ok || !checkAgrees(question, res.stdout || res.result || '')) {
          dropped++;
          failures.push(`- ${question.prompt.slice(0, 200)}`);
          continue;
        }
        question.verified = true;
      } else if (python && question.type === 'numeric') {
        // A calculation without a check cannot be trusted.
        dropped++;
        failures.push(`- ${question.prompt.slice(0, 200)} (no check_code)`);
        continue;
      } else {
        question.verified = false;
      }
      if (python && figureCode) {
        progress(`Drawing the figure for question ${kept.length + 1}…`);
        const res = await runPython(figureCode, 30).catch(() => null);
        const fig = res?.figures?.[0];
        if (fig) {
          const saved = await studyApi.attachmentAdd({ notebookId, kind: 'figure', name: fig.name, mime: 'image/png', data: fig.dataUrl });
          question.figure = saved.id;
        }
      }
      kept.push(question);
    }
  }
  if (!kept.length) throw new Error('No question passed its check. Try again or narrow the topic.');
  return { title: title || 'Practice quiz', questions: kept, dropped };
}

// ---------------------------------------------------------------- grading

const GRADE_TOOL = {
  type: 'function',
  function: {
    name: 'grade',
    description: 'Grade the answer.',
    parameters: {
      type: 'object',
      properties: {
        correct: { type: 'boolean', description: 'True if the answer is essentially right (same meaning as the reference; wording can differ).' },
        feedback: { type: 'string', description: 'One or two sentences to the student: what was right or missing.' },
      },
      required: ['correct', 'feedback'],
    },
  },
};

export async function gradeShort(q: QuizQuestion, given: string): Promise<{ correct: boolean; feedback: string }> {
  const args = await forcedCall(
    GRADE_SYSTEM,
    `Question: ${q.prompt}\n\nReference answer: ${q.answer}\n\nStudent answer: ${given}`,
    GRADE_TOOL,
  );
  return { correct: args.correct === true, feedback: String(args.feedback ?? '') };
}

/** Grade anything except short answers locally. */
export function gradeLocal(q: QuizQuestion, given: string): boolean {
  if (q.type === 'mcq') return Number(given) === q.answer;
  if (q.type === 'tf') return given === q.answer;
  if (q.type === 'numeric') {
    const v = parseNumber(given);
    return v !== null && Math.abs(v - Number(q.answer)) <= Math.max(q.tolerance ?? 0, defaultTolerance(Number(q.answer)));
  }
  return false;
}
