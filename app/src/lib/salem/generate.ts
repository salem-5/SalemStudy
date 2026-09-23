import { aiChat, aiStream, getAiConfig, type ApiContent, type ApiMessage, type AiFeature } from '../ai';
import { formatResult, runPython } from '../python';
import { fitsSchema, type Schema } from '../schemaCheck';
import type { Meter } from '../meter';
import { toolLoop, type LoopTool } from '../toolLoop';
import type { RunTelemetry, SalemEvent } from './types';

/**
 * Structured generation: quizzes, flashcards, notes, titles, image reading.
 *
 * These are *plain model calls*. Generation is always handed its material in
 * the prompt — the excerpts, the slice of slides, the conversation — so there
 * is nothing to go and find, and putting an agent loop in front of it only
 * re-sent that material on every step. It cost a minute or more per deck and
 * produced nothing better.
 *
 * The agent is still there, and chat reaches for it when a turn genuinely
 * needs it (see `chatTurn.ts`). Nothing here does.
 *
 * Two things the old version did that this one cannot: DeepSeek's models all
 * reason before they answer, and the API refuses a forced tool choice on a
 * thinking model — both `tool_choice: "required"` and naming one function come
 * back as HTTP 400. So the shape is asked for as JSON instead, checked here
 * against the schema, and a reply that does not fit is retried with the
 * reason. Study material stays inside the material it was given: no tools
 * means no web, by construction.
 */

const ATTEMPTS = 3;

export type GenerateOptions = {
  /** Usage tag, e.g. 'quiz' or 'flashcards'. */
  feature: string;
  /** What this generator is for. */
  system: string;
  /** The material and the instruction. A list of parts carries images too. */
  instruction: string | unknown[];
  /** The shape the answer has to take. Checked before it comes back. */
  schema: unknown;
  /** Supply the run id when the caller needs to be able to stop it. */
  run?: string;
  /** Let it work in the sandbox before it answers. The solver needs this;
   *  nothing that is only rearranging material it was given does. */
  python?: { fileIds?: number[]; timeout?: number; maxCalls?: number };
  onEvent?: (event: SalemEvent) => void;
  /** What the run cost, once it is over. For the app's own usage counters. */
  onTelemetry?: (telemetry: RunTelemetry) => void;
  /** Adds what the calls cost to the piece of work they belong to. */
  meter?: Meter;
};

const feature = (name: string) => name as AiFeature;

/** What to ask for, given there is no tool call to put the shape in. */
const schemaAsk = (schema: unknown) =>
  'Answer with a single JSON object matching this schema exactly, and nothing else — '
  + `no prose, no code fence:\n${JSON.stringify(schema).slice(0, 6000)}`;

/**
 * `run_python` as a plain tool: the same sandbox, called from here rather
 * than from the runtime, so a solve can compute without an agent around it.
 */
function pythonTool(
  spec: NonNullable<GenerateOptions['python']>,
  timeout: number,
  onEvent?: (event: SalemEvent) => void,
): LoopTool {
  let used = 0;
  return {
    name: 'run_python',
    description:
      "Run Python in the app's sandbox and get its real output back. Use it for every "
      + 'calculation and anything structured. sympy (sp), numpy (np), mpmath (mp), scipy and '
      + 'matplotlib are installed. print() what you need; nothing carries over between calls.',
    parameters: {
      type: 'object',
      properties: { code: { type: 'string', description: 'The Python to run. print() every value you need.' } },
      required: ['code'],
    },
    label: 'Running Python',
    async run(args) {
      const code = String(args.code ?? '');
      if (!code.trim()) throw new Error('Call run_python with the code in the "code" argument.');
      if (spec.maxCalls != null && used >= spec.maxCalls) {
        throw new Error('You have used all the Python you are allowed for this question. Answer with what you have.');
      }
      used += 1;
      const r = await runPython(code, spec.timeout ?? timeout, spec.fileIds ?? []);
      const output = formatResult(r);
      onEvent?.({ kind: 'python', status: r.ok ? 'ok' : 'error', code, output, figures: [] });
      return { result: output, label: r.ok ? 'Ran Python' : 'Python failed' };
    },
  };
}

export async function generate<T>(options: GenerateOptions): Promise<T> {
  const config = await getAiConfig();
  if (!config.hasKey) throw new Error('No API key for the chosen provider yet. Add one in Settings → Model.');

  const instruction: ApiContent = typeof options.instruction === 'string'
    ? options.instruction
    : (options.instruction as ApiContent);
  let problem = '';

  // With Python in play the answer is worked out over several calls, so it
  // cannot come back in JSON mode; the shape is asked for in the prompt and
  // the reply is parsed. One retry in JSON mode catches a model that wrote
  // the right answer in the wrong wrapper.
  if (options.python) {
    const worked = await toolLoop({
      meter: options.meter,
      feature: feature(options.feature),
      model: config.flashModel,
      effort: config.effort,
      messages: [
        { role: 'system', content: `${options.system}\n\n${schemaAsk(options.schema)}` },
        { role: 'user', content: instruction },
      ],
      tools: [pythonTool(options.python, config.pythonTimeout, options.onEvent)],
      rounds: options.python.maxCalls ?? 6,
      onStream: () => {},
      onEvent: options.onEvent,
    });
    options.onTelemetry?.(telemetryOf(null, options.feature));
    const fitted = fitsSchema(worked.text, options.schema as Schema);
    if ('value' in fitted) return fitted.value as T;
    const again = await aiChat({
      meter: options.meter,
      feature: feature(options.feature),
      model: config.flashModel,
      effort: config.effort,
      thinking: false,
      json: true,
      messages: [
        { role: 'system', content: schemaAsk(options.schema) },
        { role: 'user', content: `Put this into the required shape, changing nothing about the answer:\n\n${worked.text}` },
      ],
    });
    const second = fitsSchema(again.content ?? '', options.schema as Schema);
    if ('value' in second) return second.value as T;
    throw new Error(`The model could not produce anything usable (${second.problem}). Try again.`);
  }

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const messages: ApiMessage[] = [
      { role: 'system', content: `${options.system}\n\n${schemaAsk(options.schema)}` },
      { role: 'user', content: instruction },
    ];
    if (problem) {
      messages.push({
        role: 'user',
        content: `Your last answer did not fit: ${problem}\nWrite the whole object again, correctly.`,
      });
    }
    const reply = await aiChat({
      meter: options.meter,
      feature: feature(options.feature),
      model: config.flashModel,
      messages,
      json: true,
      effort: config.effort,
      thinking: false,
    });
    options.onTelemetry?.(telemetryOf(reply.usage, options.feature));
    const fitted = fitsSchema(reply.content ?? '', options.schema as Schema);
    if ('value' in fitted) return fitted.value as T;
    problem = fitted.problem;
  }
  throw new Error(`The model could not produce anything usable (${problem}). Try again.`);
}

/** Kept for callers that want to say out loud that one pass is enough. */
export const generateQuick = <T>(options: GenerateOptions) => generate<T>(options);

/**
 * Prose rather than data: an overview, a set of notes, a summary.
 *
 * Streamed, so a note appears as it is written.
 */
export async function generateText(options: Omit<GenerateOptions, 'schema'> & { stream?: boolean }): Promise<string> {
  const config = await getAiConfig();
  if (!config.hasKey) throw new Error('No API key for the chosen provider yet. Add one in Settings → Model.');

  const instruction: ApiContent = typeof options.instruction === 'string'
    ? options.instruction
    : (options.instruction as ApiContent);
  const messages: ApiMessage[] = [
    { role: 'system', content: options.system },
    { role: 'user', content: instruction },
  ];
  if (options.python) {
    const worked = await toolLoop({
      meter: options.meter,
      feature: feature(options.feature),
      model: config.flashModel,
      effort: config.effort,
      messages,
      tools: [pythonTool(options.python, config.pythonTimeout, options.onEvent)],
      rounds: options.python.maxCalls ?? 6,
      onEvent: options.onEvent,
    });
    options.onTelemetry?.(telemetryOf(null, options.feature));
    const worked_text = worked.text.trim();
    if (!worked_text) throw new Error('The model returned nothing. Try again.');
    return worked_text;
  }
  const reply = await aiStream(
    {
      id: options.run,
      feature: feature(options.feature),
      model: config.flashModel,
      effort: config.effort,
      thinking: false,
      messages,
      meter: options.meter,
    },
    (content) => {
      if (content) options.onEvent?.({ kind: 'text', text: content });
    },
  );
  options.onTelemetry?.(telemetryOf(reply.usage, options.feature));
  const text = (reply.content ?? '').trim();
  if (!text) throw new Error('The model returned nothing. Try again.');
  return text;
}

/**
 * Reading an image: a scanned page, a photo of handwriting, a diagram.
 *
 * A page that cannot be read fails visibly rather than coming back as empty
 * text that looks like a blank page.
 */
export async function generateVision(options: {
  feature: string;
  system?: string;
  prompt: string;
  /** A data URL the model can accept; convert with `toSupportedImage` first. */
  image: string;
  notebookId?: number | null;
}): Promise<string> {
  const config = await getAiConfig();
  if (!config.hasKey) throw new Error('Reading images needs an API key (Settings → Model).');

  const reply = await aiChat({
    feature: feature(options.feature),
    model: config.flashModel,
    effort: config.effort,
    thinking: false,
    messages: [
      { role: 'system', content: options.system ?? 'You read images accurately and return only what was asked for.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: options.prompt },
          { type: 'image_url', image_url: { url: options.image } },
        ],
      },
    ],
  });
  return (reply.content ?? '').trim();
}

function telemetryOf(usage: unknown, feature: string): RunTelemetry {
  const u = (usage ?? {}) as Record<string, number>;
  return {
    run: '',
    feature,
    durationMs: 0,
    state: 'completed',
    steps: 1,
    tool_calls: 0,
    python_calls: 0,
    subagents: 0,
    input_tokens: Number(u.promptTokens ?? u.prompt_tokens ?? 0),
    output_tokens: Number(u.completionTokens ?? u.completion_tokens ?? 0),
    tool_failures: 0,
    retries: 0,
    python_failures: 0,
    retrieval_failures: 0,
  };
}
