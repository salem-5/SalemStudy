/**
 * One assistant turn.
 *
 * Normal chat is a plain streaming model call with tools — the loop in
 * `toolLoop.ts`. It answers from the first token, and a question that needs
 * one lookup costs one lookup.
 *
 * The agent is still here, and it is still the whole Salem runtime; it is
 * just not what every turn pays for. A turn earns it by behaving like a
 * demanding one: the model keeps coming back wanting more tools, round after
 * round, which is what importing a year's schedule out of a PDF looks like
 * and what asking a definition does not. At that point the work so far is
 * handed over and the agent takes the turn, in fast mode.
 */
import { invoke } from '@tauri-apps/api/core';
import { aiCancel, getAiConfig, type AiFeature, type ApiMessage } from './ai';
import { formatResult, runPython } from './python';
import { toolLoop, type LoopTool } from './toolLoop';
import { createMeter, type Meter } from './meter';
import { cancelRun, runSalem } from './salem/runtime';
import { registry, type ToolEnv } from './salem/tools';
import type { AgentKind, ExecState, SalemEvent, SalemTool } from './salem/types';
import { studyApi, type AppAction, type PythonRun, type Step } from '../study/api';

/**
 * What each agent may touch, mirroring `agents.py`.
 *
 * It lives here now because this side does the choosing: the tool list goes
 * to the runtime as `allow`, so when a turn does escalate, the agent gets
 * exactly the tools the loop had and there is only one place that decides.
 */
const SCOPES: Record<AgentKind, { scopes: string[]; readOnly: boolean }> = {
  chat: {
    scopes: ['study', 'schedule', 'notebooks', 'sources', 'notes', 'cards', 'quizzes',
      'search', 'web', 'python', 'memory', 'ui', 'settings'],
    readOnly: false,
  },
  notebook: {
    scopes: ['sources', 'notes', 'quizzes', 'cards', 'search', 'python', 'web'],
    readOnly: true,
  },
  task: {
    scopes: ['study', 'schedule', 'notebooks', 'sources', 'notes', 'cards', 'quizzes',
      'search', 'web', 'python', 'files', 'vision', 'memory', 'settings'],
    readOnly: false,
  },
  generation: { scopes: ['sources', 'notes', 'search', 'python'], readOnly: true },
};

/** How many rounds of tool calls a turn gets before it counts as demanding. */
const ROUNDS_BEFORE_THE_AGENT = 4;

export type ChatTurnOptions = {
  agent: AgentKind;
  system: string;
  messages: { role: 'user' | 'assistant' | 'system'; content: unknown }[];
  env: ToolEnv;
  model: string;
  feature?: string;
  conversationId?: number;
  /** Attachments of the whole thread, copied into every Python run. */
  files?: number[];
  sources?: number[];
  allow?: string[];
  thinking?: boolean;
  taskId?: string;
  objective?: string;
  run?: string;
  onProgress: (progress: {
    steps: Step[]; runs: PythonRun[]; actions: AppAction[]; state: ExecState; stateDetail: string;
  }) => void;
  /** How to abort the request in flight; null when there is none. The two
   *  paths are cancelled differently, so the turn hands this out. */
  onRun: (abort: (() => void) | null) => void;
  cancelled: () => boolean;
  /** What the reply has cost so far, each time it goes up. */
  onCost?: (usd: number) => void;
};

export type TurnResult = {
  text: string;
  runs: PythonRun[];
  actions: AppAction[];
  steps: Step[];
  model: string;
  reasoning: string;
  thoughtMs: number;
  state: ExecState;
  degraded?: boolean;
  reason?: string;
  /** What the whole turn cost, in USD. */
  cost: number;
};

/** The registry, filtered the way the chosen agent would filter it. */
function permitted(all: SalemTool[], options: ChatTurnOptions): SalemTool[] {
  const rule = SCOPES[options.agent];
  return all.filter((tool) => {
    if (options.allow) return options.allow.includes(tool.name);
    if (rule.readOnly && tool.mutating) return false;
    return tool.scopes.some((scope) => rule.scopes.includes(scope));
  });
}

/** A registry tool as something the loop can call. */
function asLoopTool(tool: SalemTool, options: ChatTurnOptions, say: (e: SalemEvent) => void): LoopTool {
  const required = Object.entries(tool.inputs).filter(([, spec]) => !spec.nullable).map(([key]) => key);
  const properties = Object.fromEntries(
    Object.entries(tool.inputs).map(([key, spec]) => [key, {
      type: spec.type === 'any' ? 'string' : spec.type,
      description: spec.description,
      ...(spec.enum ? { enum: spec.enum } : {}),
      ...(spec.items ? { items: spec.items } : {}),
    }]),
  );
  return {
    name: tool.name,
    description: tool.description,
    label: tool.label,
    parameters: { type: 'object', properties, ...(required.length ? { required } : {}) },
    async run(args) {
      // The three the Rust side serves during an agent run are served here
      // instead; everything else already knows how to run itself.
      if (tool.name === 'run_python') return runPythonTool(args, options, say);
      if (tool.name === 'web_search') {
        const hits = await invoke<unknown[]>('web_search', { query: String(args.query ?? ''), count: args.count ?? null });
        return { result: hits, detail: `${hits.length} result(s)` };
      }
      if (tool.name === 'web_fetch') {
        const page = await invoke<unknown>('web_fetch', { url: String(args.url ?? ''), maxChars: args.maxChars ?? null });
        return { result: page };
      }
      if (!tool.run) throw new Error(`${tool.name} cannot run here.`);
      const missing = required.filter((key) => args[key] === undefined || args[key] === null);
      if (missing.length) throw new Error(`${tool.name} needs ${missing.join(', ')}.`);
      return tool.run(args);
    },
  };
}

async function runPythonTool(
  args: Record<string, unknown>,
  options: ChatTurnOptions,
  say: (e: SalemEvent) => void,
): Promise<{ result: unknown; label?: string; detail?: string }> {
  const code = String(args.code ?? '');
  if (!code.trim()) throw new Error('Call run_python with the code in the "code" argument.');
  const config = await getAiConfig();
  const r = await runPython(code, config.pythonTimeout, options.files ?? []);
  const figures: (string | null)[] = [];
  for (const figure of r.figures ?? []) {
    if (options.conversationId == null) continue;
    // A failure here loses a picture, not the answer.
    const saved = await studyApi.attachmentAdd({
      conversationId: options.conversationId,
      kind: 'figure',
      name: figure.name,
      mime: figure.dataUrl.slice(5, figure.dataUrl.indexOf(';')),
      data: figure.dataUrl,
    }).catch(() => null);
    if (saved) figures.push(String(saved.id));
  }
  const output = formatResult(r);
  say({ kind: 'python', status: r.ok ? 'ok' : 'error', code, output, figures });
  return { result: output, label: r.ok ? 'Ran Python' : 'Python failed' };
}

export async function runChatTurn(options: ChatTurnOptions): Promise<TurnResult> {
  const config = await getAiConfig();
  if (!config.hasKey) throw new Error('No API key for the chosen provider yet. Add one in Settings → Model.');

  const all = registry(options.env);
  const tools = permitted(all, options);
  // Every call this turn makes, the loop's and the agent's, adds up here.
  const meter = createMeter(options.onCost);
  const steps: Step[] = [];
  const runs: PythonRun[] = [];
  const actions: AppAction[] = [];
  let live = '';
  let state: ExecState = 'executing';
  let detail = '';
  let timer: number | null = null;

  const flush = (immediate = false) => {
    const emit = () => {
      timer = null;
      options.onProgress({
        steps: live.trim() ? [...steps, { type: 'text', text: live.trim() }] : [...steps],
        runs: runs.map((r) => ({ ...r })),
        actions: actions.map((a) => ({ ...a })),
        state,
        stateDetail: detail,
      });
    };
    if (immediate) {
      if (timer !== null) window.clearTimeout(timer);
      emit();
      return;
    }
    // Rendering Markdown and maths per token would freeze the window.
    timer ??= window.setTimeout(emit, 80);
  };
  const settle = () => {
    if (live.trim()) steps.push({ type: 'text', text: live.trim() });
    live = '';
  };

  const say = (event: SalemEvent) => {
    switch (event.kind) {
      case 'text':
        live += event.text;
        flush();
        break;
      case 'note':
        settle();
        steps.push({ type: 'text', text: `_${event.text}_` });
        flush(true);
        break;
      case 'state':
        state = event.state;
        detail = event.detail ?? '';
        flush(true);
        break;
      case 'tool': {
        settle();
        const existing = actions.find((a) => a.id === event.id);
        const action: AppAction = existing ?? { id: event.id, name: event.name, label: event.label, ok: false, running: true };
        if (!existing) {
          actions.push(action);
          steps.push({ type: 'action', id: action.id });
        }
        action.label = event.label;
        action.detail = event.detail;
        action.running = event.status === 'running';
        action.ok = event.status === 'ok';
        flush(true);
        break;
      }
      case 'python': {
        settle();
        const id = `py-${runs.length}`;
        runs.push({ id, code: event.code, ok: event.status === 'ok', output: event.output, figures: [], running: false });
        steps.push({ type: 'run', id });
        flush(true);
        break;
      }
      default:
        break;
    }
  };

  const thread: ApiMessage[] = [
    { role: 'system', content: options.system },
    ...options.messages.map((m) => ({ role: m.role, content: m.content as string })),
  ];

  let result;
  try {
    state = 'executing';
    result = await toolLoop({
      feature: (options.feature ?? 'chat') as AiFeature,
      model: options.model,
      messages: thread,
      tools: tools.map((t) => asLoopTool(t, options, say)),
      thinking: options.thinking,
      effort: config.effort,
      rounds: ROUNDS_BEFORE_THE_AGENT,
      meter,
      onEvent: say,
      onStream: (id) => options.onRun(id ? () => void aiCancel(id) : null),
      cancelled: options.cancelled,
    });
  } finally {
    if (timer !== null) window.clearTimeout(timer);
  }
  settle();

  if (result.why === 'cancelled') {
    options.onRun(null);
    throw new Error('stopped');
  }

  if (result.why === 'cap') {
    // Four rounds in and still reaching for tools: this is the kind of turn
    // the agent is for. What has already been worked out goes with it, so
    // nothing is done twice.
    return agentic(options, result.messages, steps, runs, actions, say, flush, meter);
  }

  options.onRun(null);
  return {
    text: steps.filter((s) => s.type === 'text').map((s) => (s as { text: string }).text).join('\n\n'),
    runs, actions, steps,
    model: result.model,
    reasoning: result.reasoning,
    thoughtMs: result.thoughtMs,
    state: 'completed',
    cost: meter.total,
  };
}

/** Hand the turn to the Salem runtime, carrying over what the loop found. */
async function agentic(
  options: ChatTurnOptions,
  sofar: ApiMessage[],
  steps: Step[],
  runs: PythonRun[],
  actions: AppAction[],
  say: (e: SalemEvent) => void,
  flush: (immediate?: boolean) => void,
  meter: Meter,
): Promise<TurnResult> {
  say({ kind: 'note', text: 'This one needs a proper look — taking it step by step' });
  flush(true);

  const done = sofar
    .filter((m) => m.role === 'tool')
    .map((m) => `- ${(m as { name?: string }).name}: ${String((m as { content?: unknown }).content ?? '').slice(0, 1500)}`)
    .join('\n');
  const messages = [...options.messages];
  if (done) {
    messages.push({
      role: 'user',
      content: `What has already been looked up for this, so you do not repeat it:\n${done}`,
    });
  }

  const run = options.run ?? crypto.randomUUID();
  options.onRun(() => void cancelRun(run));
  const result = await runSalem({
    agent: options.agent,
    system: options.system,
    messages,
    model: options.model,
    feature: options.feature,
    conversationId: options.conversationId,
    files: options.files,
    sources: options.sources,
    // The loop and the agent get the same tools, decided in one place.
    allow: options.allow ?? permitted(registry(options.env), options).map((t) => t.name),
    thinking: options.thinking,
    taskId: options.taskId,
    objective: options.objective,
    env: options.env,
    run,
    onEvent: (event) => {
      if (event.kind === 'usage') meter.add(event.cost);
      say(event);
      if (options.cancelled()) void cancelRun(run);
    },
  });

  options.onRun(null);
  const text = steps.filter((s) => s.type === 'text').map((s) => (s as { text: string }).text).join('\n\n');
  const answer = result.text.trim();
  if (answer && !text.includes(answer)) {
    steps.push({ type: 'text', text: answer });
  }
  return {
    text: steps.filter((s) => s.type === 'text').map((s) => (s as { text: string }).text).join('\n\n'),
    runs, actions, steps,
    model: options.model,
    reasoning: '',
    thoughtMs: 0,
    state: result.state,
    degraded: result.degraded,
    reason: result.reason,
    cost: meter.total,
  };
}
