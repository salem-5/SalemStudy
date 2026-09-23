/**
 * The Salem AI layer as the rest of the app sees it.
 *
 * Nothing outside `lib/salem` knows that the runtime is smolagents, or that it
 * is Python at all: features ask for a run and read execution states back.
 * Replacing the runtime means replacing this folder.
 */

/** What the runtime is doing. Never what the model is thinking. */
export type ExecState =
  | 'planning'
  | 'executing'
  | 'waiting_tool'
  | 'waiting_subagent'
  | 'running_python'
  | 'retrieving'
  | 'validating'
  | 'retrying'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** Which agent shape a request needs. The runtime may still escalate. */
export type AgentKind = 'chat' | 'notebook' | 'task' | 'generation';

/** `auto` lets the runtime choose; `direct` and `agentic` force a path. */
export type RunMode = 'auto' | 'direct' | 'agentic';

export type SalemEvent =
  | { kind: 'state'; state: ExecState; detail?: string }
  | { kind: 'text'; text: string }
  | { kind: 'note'; text: string }
  | { kind: 'tool'; id: string; name: string; status: 'running' | 'ok' | 'error' | 'cancelled'; label: string; detail?: string; args?: string; result?: string; mutating?: boolean }
  | { kind: 'subagent'; name: string; status: 'running' | 'ok' | 'error'; label: string; detail?: string; task?: string }
  | { kind: 'python'; status: 'ok' | 'error'; code: string; output: string; figures?: (string | null)[] }
  | { kind: 'step'; n: number; agent: string; tokens: number }
  /** A model call the run made, and what it cost (USD). */
  | { kind: 'usage'; cost: number }
  | { kind: 'memory'; state: TaskState };

/** The compact state a long task carries between runs. */
export type TaskState = {
  taskId?: string;
  objective?: string;
  constraints?: string[];
  dates?: Record<string, string>;
  numbers?: Record<string, string>;
  entities?: string[];
  done?: string[];
  pending?: string[];
  decisions?: string[];
  validations?: string[];
  unresolved?: string[];
  expected_final_state?: string;
  summary?: string;
};

export type RunTelemetry = {
  run: string;
  feature: string;
  durationMs: number;
  state: string;
  steps: number;
  tool_calls: number;
  tool_failures: number;
  python_calls: number;
  python_failures: number;
  retrieval_failures: number;
  subagents: number;
  retries: number;
  input_tokens: number;
  output_tokens: number;
};

export type SalemResult = {
  text: string;
  /** Set when the request asked for schema-validated data. */
  structured?: unknown;
  state: ExecState;
  path: 'direct' | 'agentic' | 'fallback';
  steps?: number;
  /** True when the answer arrived despite something failing — it is partial,
   *  and the reason says what went wrong. Never presented as a clean success. */
  degraded?: boolean;
  reason?: string;
  memory?: TaskState;
  telemetry?: RunTelemetry;
};

/**
 * One Salem tool. The declaration is the contract: the runtime builds the
 * model-facing schema from it, and the app is what actually runs `run`.
 */
export type SalemTool = {
  name: string;
  description: string;
  inputs: Record<string, ToolInput>;
  outputType?: 'string' | 'object' | 'array' | 'number' | 'boolean' | 'any';
  /** Changes the student's data. Read-only agents never see these, retries of
   *  them are deduplicated, and the UI marks them. */
  mutating?: boolean;
  scopes: string[];
  /** What the UI says while it runs, e.g. "Checking the calendar". */
  label?: string;
  /** The execution state to show. Defaults to `waiting_tool`. */
  state?: ExecState;
  timeout?: number;
  /** Omitted for tools the Rust side serves (the sandbox, the web). */
  run?: (args: Record<string, unknown>) => Promise<ToolOutcome>;
};

export type ToolInput = {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'any';
  description: string;
  /** Optional arguments must say so, or the runtime will demand them. */
  nullable?: boolean;
  enum?: string[];
  items?: { type: string };
};

export type ToolOutcome = {
  result: unknown;
  /** A past-tense line for the chat log: "Added Calculus midterm". */
  label?: string;
  detail?: string;
};

/** The wire form sent to the runtime: the declaration without its body. */
export type ToolSpec = Omit<SalemTool, 'run'>;

export const toSpec = (tool: SalemTool): ToolSpec => {
  const { run: _run, ...spec } = tool;
  return spec;
};
