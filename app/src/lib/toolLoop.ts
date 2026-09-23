/**
 * The plain tool-calling loop: stream a reply, run the tools it asks for,
 * feed the results back, repeat.
 *
 * This is how the app talked to the model before the agent, and how it talks
 * to it again for everything that is not a genuinely demanding request. It
 * has no working memory, no planner and no sub-agents; it streams from the
 * first token, and one turn is one round trip plus one per tool call.
 *
 * When a turn turns out to need more than `rounds` passes of tool calls, the
 * loop stops and says so rather than grinding on — the caller decides whether
 * that is the moment to hand the work to the agent.
 */
import { aiStream, extractJsonObject, type ApiMessage, type AiFeature } from './ai';
import type { Meter } from './meter';
import type { SalemEvent } from './salem/types';

export type LoopTool = {
  name: string;
  description: string;
  /** JSON schema for the arguments. */
  parameters: unknown;
  /** What the UI says while it runs. */
  label?: string;
  run: (args: Record<string, unknown>) => Promise<{ result: unknown; label?: string; detail?: string }>;
};

export type LoopResult = {
  text: string;
  model: string;
  reasoning: string;
  thoughtMs: number;
  toolCalls: number;
  /** 'answered' when the model stopped by itself, 'cap' when it ran out of
   *  rounds and was still reaching for tools, 'cancelled' when stopped. */
  why: 'answered' | 'cap' | 'cancelled';
  /** The thread as it ended, so a caller escalating can carry the work over. */
  messages: ApiMessage[];
};

export type LoopOptions = {
  feature: AiFeature;
  model: string;
  messages: ApiMessage[];
  tools: LoopTool[];
  thinking?: boolean;
  effort?: string;
  /** How many times the model may come back wanting more tools. */
  rounds?: number;
  onEvent?: (event: SalemEvent) => void;
  /** Each request's stream id, so Stop can cancel it. */
  onStream?: (id: string | null) => void;
  cancelled?: () => boolean;
  /** Adds what each round cost to the piece of work it belongs to. */
  meter?: Meter;
};

const asFunction = (t: LoopTool) => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.parameters },
});

const friendly = (name: string) => name.replace(/_/g, ' ');

export async function toolLoop(options: LoopOptions): Promise<LoopResult> {
  const thread = [...options.messages];
  const byName = new Map(options.tools.map((t) => [t.name, t]));
  const rounds = options.rounds ?? 6;
  const stopped = () => options.cancelled?.() ?? false;
  const say = (event: SalemEvent) => options.onEvent?.(event);

  let text = '';
  let model = options.model;
  let reasoning = '';
  let thinkStart = 0;
  let thoughtMs = 0;
  let toolCalls = 0;

  for (let round = 0; round <= rounds; round++) {
    if (stopped()) return { text, model, reasoning, thoughtMs, toolCalls, why: 'cancelled', messages: thread };

    const id = crypto.randomUUID();
    options.onStream?.(id);
    let streamed = '';
    const reply = await aiStream(
      {
        id,
        feature: options.feature,
        model: options.model,
        messages: thread,
        tools: options.tools.length ? options.tools.map(asFunction) : undefined,
        thinking: options.thinking ?? false,
        effort: options.effort,
        meter: options.meter,
      },
      (content, thought) => {
        if (thought) {
          if (!thinkStart) thinkStart = Date.now();
          reasoning += thought;
        }
        if (content && thinkStart && !thoughtMs) thoughtMs = Date.now() - thinkStart;
        if (content) { streamed += content; say({ kind: 'text', text: content }); }
      },
    );
    options.onStream?.(null);
    // The words arrive as stream events, and the reply is built from those.
    // A browser tab gets them by polling, a beat behind: the finished reply
    // can come back before the last of them, and they are dropped when the
    // stream is closed. Whatever the stream did not bring — all of it, or the
    // tail — is taken from the finished reply, so no answer is cut short.
    const full = reply.content ?? '';
    if (full.length > streamed.length && full.startsWith(streamed)) {
      say({ kind: 'text', text: full.slice(streamed.length) });
    }
    if (thinkStart && !thoughtMs) thoughtMs = Date.now() - thinkStart;
    model = reply.model || model;
    if (reply.cancelled || stopped()) {
      text += reply.content ?? '';
      return { text, model, reasoning, thoughtMs, toolCalls, why: 'cancelled', messages: thread };
    }
    text += reply.content ?? '';

    const calls = options.tools.length ? (reply.tool_calls ?? []) : [];
    if (!calls.length) {
      return { text, model, reasoning, thoughtMs, toolCalls, why: 'answered', messages: thread };
    }
    // Out of rounds and still reaching for tools: this is the shape of a
    // request that wants the agent, so hand back rather than grinding on.
    if (round === rounds) {
      return { text, model, reasoning, thoughtMs, toolCalls, why: 'cap', messages: thread };
    }

    thread.push({
      role: 'assistant',
      content: reply.content ?? '',
      tool_calls: calls,
      ...(options.thinking && reply.reasoning ? { reasoning_content: reply.reasoning } : {}),
    });

    for (const call of calls) {
      if (stopped()) return { text, model, reasoning, thoughtMs, toolCalls, why: 'cancelled', messages: thread };
      const name = call.function?.name ?? '';
      const args = (extractJsonObject(call.function?.arguments ?? '') ?? {}) as Record<string, unknown>;
      const tool = byName.get(name);
      const answer = (content: string) =>
        thread.push({ role: 'tool', tool_call_id: call.id, name, content });

      if (!tool) {
        answer(`There is no tool called ${name}.`);
        continue;
      }
      toolCalls += 1;
      const callId = call.id || `${name}-${toolCalls}`;
      const label = tool.label ?? `Running ${friendly(name)}`;
      say({ kind: 'tool', id: callId, name, status: 'running', label, args: JSON.stringify(args).slice(0, 600) });
      try {
        const outcome = await tool.run(args);
        say({
          kind: 'tool', id: callId, name, status: 'ok',
          label: outcome.label ?? label, detail: outcome.detail,
          result: JSON.stringify(outcome.result ?? null).slice(0, 600),
        });
        answer(JSON.stringify(outcome.result ?? { ok: true }).slice(0, 60_000));
      } catch (e) {
        const detail = String(e instanceof Error ? e.message : e);
        say({ kind: 'tool', id: callId, name, status: 'error', label, detail });
        // The failure goes back to the model, never a fabricated success.
        answer(`Error: ${detail}`);
      }
    }
  }
  return { text, model, reasoning, thoughtMs, toolCalls, why: 'cap', messages: thread };
}
