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

export type AgentKind = 'chat' | 'notebook' | 'task' | 'generation';

export type RunMode = 'auto' | 'direct' | 'agentic';

export type SalemEvent =
  | { kind: 'state'; state: ExecState; detail?: string }
  | { kind: 'text'; text: string }
  | { kind: 'note'; text: string }
  | { kind: 'tool'; id: string; name: string; status: 'running' | 'ok' | 'error' | 'cancelled'; label: string; detail?: string; args?: string; result?: string; mutating?: boolean }
  | { kind: 'subagent'; name: string; status: 'running' | 'ok' | 'error'; label: string; detail?: string; task?: string }
  | { kind: 'python'; status: 'ok' | 'error'; code: string; output: string; figures?: (string | null)[] }
  | { kind: 'step'; n: number; agent: string; tokens: number }
  | { kind: 'usage'; cost: number }
  | { kind: 'memory'; state: TaskState };

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
  structured?: unknown;
  state: ExecState;
  path: 'direct' | 'agentic' | 'fallback';
  steps?: number;
  degraded?: boolean;
  reason?: string;
  memory?: TaskState;
  telemetry?: RunTelemetry;
};

export type SalemTool = {
  name: string;
  description: string;
  inputs: Record<string, ToolInput>;
  outputType?: 'string' | 'object' | 'array' | 'number' | 'boolean' | 'any';
  mutating?: boolean;
  scopes: string[];
  label?: string;
  state?: ExecState;
  timeout?: number;
  run?: (args: Record<string, unknown>) => Promise<ToolOutcome>;
};

export type ToolInput = {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'any';
  description: string;
  nullable?: boolean;
  enum?: string[];
  items?: { type: string };
};

export type ToolOutcome = {
  result: unknown;
  label?: string;
  detail?: string;
};

export type ToolSpec = Omit<SalemTool, 'run'>;

export const toSpec = (tool: SalemTool): ToolSpec => {
  const { run: _run, ...spec } = tool;
  return spec;
};
