import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { studyApi } from '../../study/api';
import { dispatch, answerTool, registry, type ToolEnv } from './tools';
import { toSpec, type AgentKind, type RunMode, type SalemEvent, type SalemResult, type SalemTool } from './types';

export type RunOptions = {
  agent: AgentKind;
  system?: string;
  messages: { role: 'user' | 'assistant' | 'system'; content: unknown }[];
  taskId?: string;
  objective?: string;
  mode?: RunMode;
  thinking?: boolean;
  model?: string;
  subagents?: string[];
  allow?: string[];
  files?: number[];
  sources?: number[];
  schema?: unknown;
  budget?: Partial<Record<'seconds' | 'steps' | 'toolCalls' | 'pythonCalls' | 'subagents' | 'subagentDepth' | 'tokens', number>>;
  feature?: string;
  env: ToolEnv;
  conversationId?: number;
  run?: string;
  onEvent?: (event: SalemEvent) => void;
};

export type RuntimeStatus = {
  ready: boolean;
  error: string | null;
  details: string | null;
  interpreter: string | null;
  hello: { version?: string; smolagents?: string; python?: string; executable?: string; error?: string } | null;
  nativeTools: string[];
};

export const runtimeStatus = () => invoke<RuntimeStatus>('salem_status');
export const restartRuntime = () => invoke<void>('salem_restart');
export const runtimeTelemetry = (since?: number) => invoke<unknown>('salem_telemetry', { since: since ?? null });
export const clearTaskState = (taskId: string) => invoke<void>('salem_task_clear', { taskId });
export const cancelRun = (run: string) => invoke<void>('salem_cancel', { run }).catch(() => {});

type Live = {
  tools: SalemTool[];
  onEvent: (event: SalemEvent) => void;
  onFigures: (figures: { name: string; dataUrl: string }[]) => void;
};

const live = new Map<string, Live>();
let wired: Promise<UnlistenFn[]> | null = null;

function wire(): Promise<UnlistenFn[]> {
  wired ??= Promise.all([
    listen<{ run: string; event: SalemEvent }>('salem://event', (e) => {
      live.get(e.payload.run)?.onEvent(e.payload.event);
    }),
    listen<{ run: string; figures: { name: string; dataUrl: string }[] }>('salem://figures', (e) => {
      live.get(e.payload.run)?.onFigures(e.payload.figures ?? []);
    }),
    listen<{ call: number; run: string; name: string; args: Record<string, unknown> }>('salem://tool', (e) => {
      const { call, run, name, args } = e.payload;
      const entry = live.get(run);
      if (!entry) {
        void answerTool(call, false, null, 'that request is no longer running');
        return;
      }
      void dispatch(entry.tools, name, args)
        .then((result) => answerTool(call, true, result))
        .catch((err) => answerTool(call, false, null, String(err instanceof Error ? err.message : err)));
    }),
  ]);
  return wired;
}

export async function runSalem(options: RunOptions): Promise<SalemResult & { run: string }> {
  const run = options.run ?? crypto.randomUUID();
  const tools = registry(options.env);
  const figures: number[] = [];

  await wire();
  live.set(run, {
    tools,
    onEvent: (event) => options.onEvent?.(event),
    onFigures: (captured) => {
      if (options.conversationId == null) return;
      for (const figure of captured) {
        void studyApi
          .attachmentAdd({
            conversationId: options.conversationId,
            kind: 'figure',
            name: figure.name,
            mime: figure.dataUrl.slice(5, figure.dataUrl.indexOf(';')),
            data: figure.dataUrl,
          })
          .then((saved) => figures.push(saved.id))
          .catch(() => {});
      }
    },
  });

  try {
    const result = await invoke<SalemResult>('salem_run', {
      run,
      input: {
        agent: options.agent,
        system: options.system ?? '',
        messages: options.messages,
        taskId: options.taskId ?? '',
        objective: options.objective ?? '',
        mode: options.mode ?? 'auto',
        thinking: options.thinking ?? false,
        model: options.model,
        tools: tools.map(toSpec),
        allow: options.allow ?? null,
        subagents: options.subagents ?? null,
        files: options.files ?? [],
        sources: options.sources ?? [],
        schema: options.schema ?? null,
        budget: options.budget ?? null,
        feature: options.feature ?? options.agent,
      },
    });
    return { ...result, run };
  } finally {
    live.delete(run);
  }
}
