import { aiChat, aiStream, getAiConfig, type ApiContent, type ApiMessage, type AiFeature, aiCancel } from '../ai';
import { formatResult, runPython } from '../python';
import { fitsSchema, type Schema } from '../schemaCheck';
import type { Meter } from '../meter';
import type { Stop } from '../cancel.ts';
import { toolLoop, type LoopTool } from '../toolLoop';
import type { RunTelemetry, SalemEvent } from './types';

const ATTEMPTS = 3;

export type GenerateOptions = {
  feature: string;
  system: string;
  instruction: string | unknown[];
  schema: unknown;
  run?: string;
  python?: { fileIds?: number[]; timeout?: number; maxCalls?: number };
  onEvent?: (event: SalemEvent) => void;
  onTelemetry?: (telemetry: RunTelemetry) => void;
  meter?: Meter;
  stop?: Stop;
};

async function stoppable<R>(stop: Stop | undefined, call: (id?: string) => Promise<R>): Promise<R> {
  if (!stop) return call();
  stop.throwIfStopped();
  const id = crypto.randomUUID();
  const off = stop.onStop(() => { void aiCancel(id); });
  try {
    return await call(id);
  } finally {
    off();
    stop.throwIfStopped();
  }
}

const feature = (name: string) => name as AiFeature;

const schemaAsk = (schema: unknown) =>
  'Answer with a single JSON object matching this schema exactly, and nothing else — '
  + `no prose, no code fence:\n${JSON.stringify(schema).slice(0, 6000)}`;

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

  if (options.python) {
    let offStream = () => {};
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
      onStream: (id) => { offStream(); offStream = id && options.stop ? options.stop.onStop(() => { void aiCancel(id); }) : () => {}; },
      cancelled: () => !!options.stop?.stopped,
      onEvent: options.onEvent,
    });
    offStream();
    options.stop?.throwIfStopped();
    options.onTelemetry?.(telemetryOf(null, options.feature));
    const fitted = fitsSchema(worked.text, options.schema as Schema);
    if ('value' in fitted) return fitted.value as T;
    const again = await stoppable(options.stop, (id) => aiChat({
      id,
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
    }));
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
    const reply = await stoppable(options.stop, (id) => aiChat({
      id,
      meter: options.meter,
      feature: feature(options.feature),
      model: config.flashModel,
      messages,
      json: true,
      effort: config.effort,
      thinking: false,
    }));
    options.onTelemetry?.(telemetryOf(reply.usage, options.feature));
    const fitted = fitsSchema(reply.content ?? '', options.schema as Schema);
    if ('value' in fitted) return fitted.value as T;
    problem = fitted.problem;
  }
  throw new Error(`The model could not produce anything usable (${problem}). Try again.`);
}

export const generateQuick = <T>(options: GenerateOptions) => generate<T>(options);

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

export async function generateVision(options: {
  feature: string;
  system?: string;
  prompt: string;
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
