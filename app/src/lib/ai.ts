import { invoke } from '@tauri-apps/api/core';
import type { Box, Draft, Question } from '../types';

// ---------------------------------------------------------------------------
// Tauri bridge: settings live in a JSON file next to the app (see lib.rs), so
// the API key is never stored in the webview. `deepseek_chat` injects the key.
// ---------------------------------------------------------------------------

export type AiConfig = {
  hasKey: boolean;
  keyHint: string;
  flashModel: string;
  proModel: string;
  baseUrl: string;
  maxAttempts: number;
  pauseAfter: number;
};

export type ConfigPatch = {
  apiKey?: string;
  flashModel?: string;
  proModel?: string;
  baseUrl?: string;
  maxAttempts?: number;
  pauseAfter?: number;
};

export const getAiConfig = () => invoke<AiConfig>('get_config');
export const setAiConfig = (patch: ConfigPatch) => invoke<AiConfig>('set_config', { patch });
export const fetchImageData = (url: string) => invoke<string>('fetch_image_any', { url });

export type Balance = {
  is_available: boolean;
  balance_infos: { currency: string; total_balance: string; granted_balance: string; topped_up_balance: string }[];
};

export const deepseekBalance = () => invoke<Balance>('deepseek_balance');

export type TextPart = { type: 'text'; text: string };
export type ImagePart = { type: 'image_url'; image_url: { url: string } };
export type ApiContent = string | (TextPart | ImagePart)[];
export type ApiMessage = { role: 'system' | 'user' | 'assistant'; content: ApiContent };

export type ToolCall = { id: string; type: string; function: { name: string; arguments: string } };
export type AiReply = { content: string; reasoning: string; model: string; usage: unknown; tool_calls?: ToolCall[] | null };

export const aiChat = (args: {
  model: string;
  messages: ApiMessage[];
  thinking?: boolean;
  effort?: string;
  json?: boolean;
  tools?: unknown[];
  toolChoice?: unknown;
}) =>
  invoke<AiReply>('deepseek_chat', {
    model: args.model,
    messages: args.messages,
    thinking: args.thinking ?? null,
    effort: args.effort ?? null,
    json: args.json ?? null,
    tools: args.tools ?? null,
    choice: args.toolChoice ?? null,
  });

/** Forced tool call — the most reliable way to get structured answers out. */
export const SUBMIT_TOOL = {
  type: 'function',
  function: {
    name: 'submit_answers',
    description: 'Submit the final answer for every answer box.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Short reasoning the student can read.' },
        answers: {
          type: 'object',
          // The schema is the last thing the model reads before it writes the
          // answer, so the rule it breaks most often is repeated here.
          description: 'Map from box index (as a string, e.g. "1") to the answer typed into that box. Type only what goes inside the box: never repeat brackets, "=" signs, units or symbols that the question already prints around it.',
          additionalProperties: true,
        },
      },
      required: ['answers'],
    },
  },
};
export const FORCE_SUBMIT = { type: 'function', function: { name: 'submit_answers' } };

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

const WA_BASE = 'https://www.webassign.net';
// MathType's accessibility overlay can leak into the extracted text; never feed
// it to the model or treat its icon as a figure.
const CHROME_TEXT = /Press Space or Enter to edit this math answer\.?/gi;
const CHROME_IMG = /mathtype|overlay|mcorrect|mincorrect|mpartial/i;

export const stripChrome = (text: string): string =>
  text.replace(CHROME_TEXT, '').replace(/\[image: ([^\]]+)\]/gi, (m, url: string) => (CHROME_IMG.test(url) ? '' : m));

/**
 * Content images for a question. watex glyph GIFs are skipped: they are math
 * symbols that the text already carries via MathML/toText, and feeding dozens
 * of tiny brackets to the model is noise.
 */
export function questionImages(q: Question, max = 8): string[] {
  const out = new Set<string>();
  const add = (raw: string | null | undefined) => {
    if (!raw) return;
    const s = raw.trim();
    if (!/^https?:/i.test(s) || /\/watex\/img\//i.test(s) || CHROME_IMG.test(s)) return;
    out.add(s);
  };
  if (q.html) {
    const doc = new DOMParser().parseFromString(`<div>${q.html}</div>`, 'text/html');
    doc.querySelectorAll('img').forEach((img) => add(img.getAttribute('src')));
  }
  for (const m of q.text.matchAll(/\[image: ([^\]]+)\]/g)) add(m[1].startsWith('/') ? WA_BASE + m[1] : m[1]);
  return [...out].slice(0, max);
}

/** Fetch each image as a data URL. Failed images are dropped, not fatal. */
export async function loadImages(urls: string[]): Promise<string[]> {
  const results = await Promise.all(urls.map((u) => fetchImageData(u).catch(() => null)));
  const out: string[] = [];
  let total = 0;
  // DeepSeek caps the request body at 48 MiB; keep well under it.
  const LIMIT = 24 * 1024 * 1024;
  for (const r of results) {
    if (!r) continue;
    const usable = await toSupportedImage(r);
    if (!usable) continue;
    if (total + usable.length > LIMIT) break;
    total += usable.length;
    out.push(usable);
  }
  return out;
}

const RASTER = /^data:image\/(?:png|jpe?g|gif|webp)[;,]/i;

function decodeImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('decode failed'));
    el.src = src;
  });
}

async function drawToPng(dataUrl: string, maxSide: number): Promise<string | null> {
  try {
    const img = await decodeImage(dataUrl);
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth || 1000, img.naturalHeight || 800));
    const w = Math.max(1, Math.round((img.naturalWidth || 1000) * scale));
    const h = Math.max(1, Math.round((img.naturalHeight || 800) * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

/**
 * DeepSeek only accepts png/jpeg/gif/webp. WebAssign also uses SVG, so convert
 * anything else to PNG through a canvas (and drop it if it can't be decoded).
 */
export async function toSupportedImage(dataUrl: string): Promise<string | null> {
  if (RASTER.test(dataUrl)) return dataUrl;
  return drawToPng(dataUrl, 1600);
}

/** Always a real PNG (pdflatex only reads PNG/JPEG/PDF). */
export async function toPngImage(dataUrl: string): Promise<string | null> {
  return drawToPng(dataUrl, 2000);
}

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT = `You are an expert STEM tutor that solves WebAssign questions correctly and completely.

You will be given a question, its answer boxes, and sometimes images (or a transcription of them). Solve it and return ONLY a single JSON object, with no markdown fences and nothing before or after it:

{"message": "brief reasoning the student can read", "answers": {"<box index>": <answer>}}

## Hard rules — every one of these loses the mark if you break it

1. TYPE ONLY WHAT GOES IN THE BOX. Each box description shows the printed text around it as "sits in the question as: …before [n] after…". Anything in that surrounding text is already on the page: never retype it.
   - Printed brackets stay printed. For "= ( [1] , [2] )" answer 1 and 2, NOT "(1" or "(1, 2)". For "⟨ [1] ⟩" answer the contents, not "⟨…⟩".
   - Printed "=" stays printed. For "u · v = [1]" answer "-3", never "u . v = -3" and never "= -3".
   - Printed symbols and units stay printed. For "[1] °" answer "60", not "60°". Same for %, $, m/s and any unit in the sentence.
   - Only include a bracket when it is part of the value itself and nothing like it is already printed — an interval "(0, 5]", or a vector "<1, 2, 3>" typed into a bare box.
2. Follow the problem's own wording. If it says to enter a word in a special case ("if the planes are parallel, enter PARALLEL"), enter that word instead of a number when the case applies.
3. Answer every box you can work out. Omit a box, or set it to null, only to leave it unchanged.

## What each kind of box takes

- Keys are the box numbers shown as [n], written as strings.
- math: a plain expression in the app's math syntax below. Never MathML, never LaTeX, never an "=".
- text: the exact string WebAssign expects (often a number, fraction or short phrase).
- essay: a full written answer as a plain string.
- choice: the exact choice label or value from the list given for that box.
- checkboxes: a JSON array of the selected labels/values.
- multiselect: a JSON array with one entry per dropdown, in order (use "" to leave one blank).
- unsupported: a raw response string only if you are sure; otherwise omit.

## Worked example

Question: "Find a · b. a = ⟨2, 3⟩, b = ⟨4, 1⟩. a · b = [1]. The angle is [2] °."
Correct: {"message": "Dot product 2(4)+3(1)=11; cos θ = 11/(√13·√17).", "answers": {"1": "11", "2": "arccos(11/sqrt(221))"}}
Wrong: {"answers": {"1": "a . b = 11", "2": "arccos(11/sqrt(221))°"}}

Math syntax:
- Fractions: 1/2, (x+1)/(x-2). After "/", only one factor is the denominator, so use parentheses.
- Powers/subscripts: x^2, e^(-x), x_1. Roots: sqrt(x), root(3, x).
- Functions: sin(x), cos(x), tan(x), sec(x), csc(x), cot(x), arcsin(x)/asin(x), arccos, arctan, sinh, cosh, tanh, coth, ln(x), log_2(x), log(x), exp(x).
- Function powers: sin^2(x). Absolute value: |x-1|.
- Vectors: <1, 2, 3>, vec(v), hat(u); unit vectors: #i, #j, #k. Dot product: a . b (or a * b).
- Intervals: (0, inf], [1, 2). Comparisons: <=, >=, !=.
- Constants: pi, inf, theta, Delta, DNE, undefined, nosolution. Plain text: "none".
- Prefer exact values (fractions, sqrt, pi). If a decimal is required, give enough digits.

If the user gives extra instructions or corrections, follow them. If feedback says an answer was wrong, rethink from scratch and give a corrected answer. Always reply with the JSON object.`;

const BRACKETS: [string, string][] = [['(', ')'], ['[', ']'], ['{', '}'], ['<', '>'], ['⟨', '⟩'], ['|', '|'], ['‖', '‖']];
const PRINTED_UNITS = ['°', '%', '$', '£', '€'];

/**
 * Spell out, for this box, exactly what the page already prints around it.
 * The general rule is in the system prompt; models follow it far better when
 * the instruction sits next to the box it applies to.
 */
function printedAlready(ctx: { before: string; after: string }): string[] {
  const out: string[] = [];
  const before = ctx.before.trimEnd();
  const after = ctx.after.trimStart();
  const pair = BRACKETS.find(([o, c]) => before.endsWith(o) && after.startsWith(c));
  if (pair) {
    out.push(`the question already prints ${pair[0]} ${pair[1]} around this box — give only what goes inside them`);
  }
  if (/[=:]$/.test(before)) out.push('the question already prints the "=" — give only the value, with no "=" in it');
  const unit = PRINTED_UNITS.find((u) => after.startsWith(u)) ?? PRINTED_UNITS.find((u) => before.endsWith(u));
  if (unit) out.push(`the question already prints "${unit}" — leave it out of the answer`);
  return out;
}

export function describeBox(b: Box, ctx?: { before: string; after: string }, specials?: string[]): string {
  const lines = [`[${b.index}] kind=${b.kind}${b.display ? ` display=${b.display}` : ''}`];
  if (b.part.maxSubmissions != null) lines.push(`  attempts ${b.part.submissions ?? 0}/${b.part.maxSubmissions}`);
  if (b.choices?.length) lines.push('  choices: ' + b.choices.map((c) => `${JSON.stringify(c.value)}=${JSON.stringify(c.label)}`).join(' | '));
  if (b.hint) lines.push('  hint: ' + b.hint);
  if (b.status !== 'unanswered') lines.push(`  last grade: ${b.status}${b.mark?.title ? ` (${b.mark.title})` : ''}`);
  if (ctx && (ctx.before || ctx.after)) {
    lines.push(`  sits in the question as: …${ctx.before} [${b.index}] ${ctx.after}…`);
    for (const warning of printedAlready(ctx)) lines.push(`  ${warning}`);
  }
  if (specials?.length) {
    lines.push(`  obey the problem's special-case rule: when it applies, this box takes the word ${specials.join(' or ')}, otherwise the computed value.`);
  }
  return lines.join('\n');
}

/** "…enter PARALLEL or PERPENDICULAR…" → ["PARALLEL or PERPENDICULAR"]. */
function specialInstructions(text: string): string[] {
  const out: string[] = [];
  const re = /\benter\s+([A-Z]{2,}(?:\s+or\s+[A-Z]{2,})?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const s = m[1].replace(/\s+/g, ' ').trim();
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

/** Text immediately around each `[n]` marker, so the model sees printed delimiters. */
export function boxContexts(q: Question): Map<number, { before: string; after: string }> {
  const out = new Map<number, { before: string; after: string }>();
  const text = stripChrome(q.text);
  const re = /\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const n = Number(m[1]);
    if (out.has(n)) continue;
    const before = text.slice(Math.max(0, m.index - 48), m.index).replace(/\s+/g, ' ').trim();
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 48).replace(/\s+/g, ' ').trim();
    out.set(n, { before, after });
  }
  return out;
}

export function questionPrompt(q: Question, opts: { images: boolean; transcript: string | null }): string {
  const parts: string[] = [];
  parts.push(`# Question ${q.number}${q.code ? ` — ${q.code}` : ''}`);
  if (q.total != null) parts.push(`Points: ${q.total}`);
  parts.push('## Problem\n' + stripChrome(q.text).trim());
  const ctx = boxContexts(q);
  const specials = specialInstructions(stripChrome(q.text));
  parts.push('## Answer boxes\n' + (q.boxes.length ? q.boxes.map((b) => describeBox(b, ctx.get(b.index), specials)).join('\n') : '(none)'));
  if (opts.transcript) parts.push('## Figures (transcribed from the images)\n' + opts.transcript);
  if (opts.images) parts.push('The referenced images are attached to this message — read them carefully.');
  return parts.join('\n\n');
}

export const TRANSCRIBE_PROMPT = `Transcribe and describe every attached image in exhaustive, literal detail. If an image contains mathematics, write it in the app's math syntax. If it is a graph, diagram or figure, describe the axes, labels, curves, shaded regions, marked points and all numeric values needed to solve the problem. Output plain text only, one section per image.`;

// ---------------------------------------------------------------------------
// Parsing the model's reply
// ---------------------------------------------------------------------------

export type ModelReply = { message: string; answers: Record<string, unknown> | null; raw: string };

function tryParse(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Pull the first JSON object out of a reply, tolerating fences and prose. */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced) {
    const hit = tryParse(fenced[1].trim());
    if (hit) return hit;
  }
  const direct = tryParse(text.trim());
  if (direct) return direct;
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const hit = tryParse(text.slice(start, i + 1));
        if (hit) return hit;
        break;
      }
    }
  }
  return null;
}

export function parseModelReply(content: string): ModelReply {
  const raw = content ?? '';
  const obj = extractJsonObject(raw);
  if (!obj) return { message: raw.trim(), answers: null, raw };
  const message = typeof obj.message === 'string' ? obj.message
    : typeof obj.explanation === 'string' ? obj.explanation
      : typeof obj.reasoning === 'string' ? obj.reasoning : '';
  let answers: Record<string, unknown> | null = null;
  const a = obj.answers ?? obj.answer;
  if (a && typeof a === 'object' && !Array.isArray(a)) answers = a as Record<string, unknown>;
  else if (Array.isArray(a)) answers = Object.fromEntries(a.map((v, i) => [String(i + 1), v]));
  return { message, answers, raw };
}

/** Prefer the forced tool call's arguments; fall back to parsing the content. */
export function answersFromReply(reply: AiReply): ModelReply {
  const call = (reply.tool_calls ?? []).find((t) => t.function?.name === 'submit_answers');
  if (call) {
    const obj = extractJsonObject(call.function.arguments ?? '');
    const a = obj?.answers;
    if (a && typeof a === 'object' && !Array.isArray(a)) {
      const message = typeof obj!.message === 'string' ? obj!.message : '';
      return { message, answers: a as Record<string, unknown>, raw: call.function.arguments ?? '' };
    }
  }
  return parseModelReply(reply.content ?? '');
}

// ---------------------------------------------------------------------------
// Answer coercion + validation
// ---------------------------------------------------------------------------

/** Map keys (box number, letter or id) onto box indexes. */
export function normalizeAnswers(q: Question, answers: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(answers)) {
    const key = String(k).trim().replace(/[\[\]]/g, '');
    let box: Box | undefined;
    if (/^\d+$/.test(key)) box = q.boxes[Number(key) - 1];
    else if (/^[a-z]$/i.test(key)) box = q.boxes[key.toLowerCase().charCodeAt(0) - 97];
    else box = q.boxes.find((b) => b.id === key);
    if (box) out[String(box.index)] = v;
  }
  return out;
}

export function coerceDraft(box: Box, value: unknown): Draft | null {
  if (value === null || value === undefined) return null;
  const resolve = (raw: string): string => {
    const s = raw.trim();
    const hit = box.choices?.find((c) => c.value === s) || box.choices?.find((c) => c.label.toLowerCase() === s.toLowerCase());
    return hit ? hit.value : s;
  };
  if (box.kind === 'choice') return resolve(String(value));
  if (box.kind === 'checkboxes') {
    const arr = Array.isArray(value) ? value.map((x) => String(x)) : String(value).split(',');
    return arr.map(resolve).filter((x) => x !== '');
  }
  if (box.kind === 'multiselect') {
    const arr = Array.isArray(value) ? value.map((x) => String(x)) : String(value).split(',');
    // One entry per dropdown, in order; blanks must keep their position.
    return arr.map((x) => (x.trim() === '' ? '' : resolve(x)));
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function resolveChoice(box: Box, v: string): string | null {
  const a = String(v).trim();
  const hit = box.choices?.find((c) => c.value === a) || box.choices?.find((c) => c.label.toLowerCase() === a.toLowerCase());
  return hit ? hit.value : null;
}

/** Problems the user should see before we waste a submission. */
export function validateAnswers(q: Question, answers: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const [k, v] of Object.entries(answers)) {
    const box = q.boxes[Number(k) - 1];
    if (!box) { errors.push(`There is no box [${k}] in this question.`); continue; }
    if (v === null || v === undefined) continue;
    if (box.kind === 'choice' && resolveChoice(box, String(v)) === null) {
      errors.push(`Box [${box.index}]: "${v}" is not one of: ${box.choices?.map((c) => c.label).join(', ')}`);
    }
    if ((box.kind === 'checkboxes' || box.kind === 'multiselect') && box.choices) {
      const arr = Array.isArray(v) ? v : String(v).split(',');
      for (const x of arr) {
        if (String(x).trim() && resolveChoice(box, String(x)) === null) {
          errors.push(`Box [${box.index}]: "${x}" is not one of: ${box.choices.map((c) => c.label).join(', ')}`);
        }
      }
    }
    if (box.kind === 'unsupported' && typeof v !== 'string') {
      errors.push(`Box [${box.index}] (${box.typeName}) needs a raw response string.`);
    }
  }
  return errors;
}

export function gradeFeedback(results: { index: number; status: string; message: string | null }[]): string {
  const lines = results.map((r) => {
    const label = r.status === 'correct' ? 'CORRECT' : r.status === 'incorrect' ? 'WRONG' : r.status.toUpperCase();
    return `[${r.index}] ${label}${r.message ? ` — ${r.message}` : ''}`;
  });
  return 'WebAssign graded the submission:\n' + lines.join('\n') + '\nRe-examine the problem and give corrected answers as JSON.';
}

// ---------------------------------------------------------------------------
// Deduction: remember which parts are already correct and which choices have
// been ruled out, so a box with a single remaining option is picked directly.
// ---------------------------------------------------------------------------

const show = (v: unknown) => (Array.isArray(v) ? v.join(', ') : String(v));

/** Update the correct/eliminated maps from a graded submission. */
export function learnFromResults(
  q: Question,
  submitted: Record<string, unknown>,
  results: { index: number; status: string }[],
  correct: Map<number, unknown>,
  elim: Map<number, Set<string>>,
): void {
  for (const r of results) {
    const box = q.boxes[r.index - 1];
    const k = String(r.index);
    if (!box || !(k in submitted)) continue;
    if (r.status === 'correct') {
      correct.set(r.index, submitted[k]);
    } else if (r.status === 'incorrect' && box.kind === 'choice' && box.choices) {
      const v = coerceDraft(box, submitted[k]);
      if (typeof v === 'string' && v) {
        if (!elim.has(r.index)) elim.set(r.index, new Set());
        elim.get(r.index)!.add(v);
      }
    }
  }
}

/**
 * Override the model's answers with deductions: reuse parts already graded
 * correct, and for a single-choice box with one option left, pick it (it can
 * only be that one). Returns the final answers plus human-readable notes.
 */
export function applyDeduction(
  q: Question,
  answers: Record<string, unknown>,
  correct: Map<number, unknown>,
  elim: Map<number, Set<string>>,
): { answers: Record<string, unknown>; notes: string[] } {
  const out: Record<string, unknown> = { ...answers };
  const notes: string[] = [];
  for (const box of q.boxes) {
    const k = String(box.index);
    if (correct.has(box.index)) {
      const v = correct.get(box.index);
      if (JSON.stringify(out[k]) !== JSON.stringify(v)) {
        out[k] = v;
        notes.push(`[${box.index}] already correct — keeping ${show(v)}`);
      }
      continue;
    }
    if (box.kind !== 'choice' || !box.choices?.length) continue;
    const gone = elim.get(box.index) ?? new Set<string>();
    const remaining = box.choices.filter((c) => !gone.has(c.value));
    if (remaining.length === 1) {
      const forced = remaining[0].value;
      if (coerceDraft(box, out[k]) !== forced) {
        out[k] = forced;
        notes.push(`[${box.index}] only "${remaining[0].label}" is left — picking it`);
      }
      continue;
    }
    if (remaining.length > 1 && out[k] !== undefined) {
      const cur = coerceDraft(box, out[k]);
      if (typeof cur === 'string' && gone.has(cur)) {
        out[k] = remaining[0].value;
        notes.push(`[${box.index}] "${box.choices.find((c) => c.value === cur)?.label ?? cur}" was already ruled out — trying "${remaining[0].label}"`);
      }
    }
  }
  return { answers: out, notes };
}
