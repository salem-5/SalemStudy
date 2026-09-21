import { aiStream, extractJsonObject, type AiFeature, getAiConfig, toSupportedImage, type AiConfig, type ApiContent, type ApiMessage } from './ai';
import { CHAT_PYTHON_TOOL, MEMORY_TOOLS } from './prompts';
import { formatResult, pythonStatus, runPython, sandboxName } from './python';
import { studyApi, type AppAction, type AttachmentInfo, type ChatMessage, type PythonRun, type Step } from '../study/api';

/**
 * One assistant turn for the chat views: builds the thread for DeepSeek Flash
 * from saved messages, runs the sandboxed Python the model asks for (figures
 * are stored as attachments), and returns the final text plus the runs.
 */

export type ChatSetup = { config: AiConfig; python: boolean };

export async function chatSetup(): Promise<ChatSetup> {
  const config = await getAiConfig();
  let python = false;
  if (config.pythonEnabled) {
    try { python = (await pythonStatus()).ready; } catch { python = false; }
  }
  return { config, python };
}

const TEXT_LIMIT = 40_000;
/** Images are re-sent only for the last few user turns; older ones are named. */
const IMAGE_TURNS = 3;

async function userContent(m: ChatMessage, withImages: boolean): Promise<ApiContent> {
  const atts: AttachmentInfo[] = m.meta?.attachments ?? [];
  let text = m.content;
  const images: string[] = [];
  for (const a of atts) {
    if (a.mime.startsWith('image/')) {
      if (withImages) {
        const url = await studyApi.attachmentData(a.id).then(toSupportedImage).catch(() => null);
        if (url) { images.push(url); continue; }
      }
      text += `\n\n[image "${a.name}" was attached${withImages ? ' but could not be read' : ' earlier in the chat'}]`;
    } else if (a.text) {
      const body = a.text.length > TEXT_LIMIT ? `${a.text.slice(0, TEXT_LIMIT)}\n… [${a.text.length - TEXT_LIMIT} more characters; read the file in Python for the rest]` : a.text;
      text += `\n\n<file name="${a.name}">\n${body}\n</file>`;
    } else {
      text += `\n\n[file "${a.name}" (${a.mime || 'unknown type'}) is attached and available to run_python as ./${a.name}]`;
    }
  }
  if (!images.length) return text;
  return [{ type: 'text', text }, ...images.map((url) => ({ type: 'image_url' as const, image_url: { url } }))];
}

/**
 * A saved reply as the model wrote it: its text in order, with each Python run
 * summarised where it happened, so it knows what it already computed.
 */
function assistantContent(m: ChatMessage): string {
  const runs = m.meta?.runs ?? [];
  if (!runs.length && !m.meta?.actions?.length) return m.content;
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
  const note = (r: PythonRun) => `[ran Python:\n\`\`\`python\n${clip(r.code, 1200)}\n\`\`\`\n→ ${clip(r.output, 600)}]`;
  const steps = m.meta?.steps;
  if (!steps) return `${m.content}\n\n${runs.map(note).join('\n')}`;
  return steps
    .map((st) => {
      if (st.type === 'text') return st.text;
      if (st.type === 'action') {
        const a = m.meta?.actions?.find((x) => x.id === st.id);
        return a ? `[did in the app: ${a.label}${a.ok ? '' : ' (failed)'}]` : '';
      }
      return note(runs.find((r) => r.id === st.id) ?? runs[0]);
    })
    .filter(Boolean)
    .join('\n\n');
}

export async function buildThread(system: string, history: ChatMessage[]): Promise<ApiMessage[]> {
  const out: ApiMessage[] = [{ role: 'system', content: system }];
  const userIdx = history.map((m, i) => (m.role === 'user' ? i : -1)).filter((i) => i >= 0);
  const recent = new Set(userIdx.slice(-IMAGE_TURNS));
  for (const [i, m] of history.entries()) {
    if (m.role === 'user') out.push({ role: 'user', content: await userContent(m, recent.has(i)) });
    else if (m.role === 'assistant' && (m.content || m.meta?.runs?.length)) out.push({ role: 'assistant', content: assistantContent(m) });
  }
  return out;
}

export type TurnResult = { text: string; runs: PythonRun[]; actions: AppAction[]; steps: Step[]; model: string; reasoning: string; thoughtMs: number };

/** Tools that act in the app (standalone chat only); see lib/assistant. */
export type AppTools = {
  defs: unknown[];
  run: (name: string, args: Record<string, unknown>) => Promise<{ ok: boolean; label: string; detail?: string; result: unknown }>;
};

export async function runTurn(args: {
  setup: ChatSetup;
  system: string;
  history: ChatMessage[];
  conversationId: number;
  /** Attachments of the whole thread, copied into every Python run. */
  fileIds: number[];
  appTools?: AppTools;
  /** Usage tag: 'chat' for the Chat tab, 'notebook' for notebook chats. */
  feature?: AiFeature;
  /** Let the model reason before answering; the reasoning streams to `onProgress`. */
  thinking?: boolean;
  /** Give it save_memory / forget_memory (facts about the student, see Settings → Memory). */
  memory?: boolean;
  onProgress: (steps: Step[], runs: PythonRun[], actions: AppAction[], reasoning: string) => void;
  /** Called with each request's stream id, so Stop can cancel it. */
  onStream: (id: string | null) => void;
  cancelled: () => boolean;
}): Promise<TurnResult> {
  const { config, python } = args.setup;
  const model = config.flashModel;
  const thread = await buildThread(args.system, args.history);
  const runs: PythonRun[] = [];
  const actions: AppAction[] = [];
  // Text the model writes next to a tool call is part of the answer too; keep
  // every piece, in order, around the runs and actions.
  const steps: Step[] = [];
  const budget = Math.max(1, config.pythonMaxCalls);
  const appNames = new Set((args.appTools?.defs ?? []).map((d) => (d as { function: { name: string } }).function.name));
  let used = 0;
  let lastModel = model;
  let reasoning = '';
  let thinkStart = 0;
  let thoughtMs = 0;
  const say = (text: string) => { const t = text.trim(); if (t) steps.push({ type: 'text', text: t }); };
  const report = (live = '') => args.onProgress(
    live ? [...steps, { type: 'text', text: live }] : [...steps],
    runs.map((r) => ({ ...r })),
    actions.map((a) => ({ ...a })),
    reasoning,
  );
  const finish = (): TurnResult => ({
    text: steps.filter((st) => st.type === 'text').map((st) => (st as { text: string }).text).join('\n\n'),
    runs, actions, steps, model: lastModel, reasoning: reasoning.trim(), thoughtMs,
  });

  for (let step = 0; step < budget + 8; step++) {
    if (args.cancelled()) throw new Error('stopped');
    const tools = [...(python && used < budget ? [CHAT_PYTHON_TOOL] : []), ...(args.memory ? MEMORY_TOOLS : []), ...(args.appTools?.defs ?? [])];
    const id = crypto.randomUUID();
    args.onStream(id);
    let live = '';
    // Re-render the growing reply at most every 80 ms: rendering Markdown and
    // maths per token would freeze the window on long answers.
    let timer: number | null = null;
    const reply = await aiStream({ id, feature: args.feature ?? 'chat', model, messages: thread, tools: tools.length ? tools : undefined, thinking: args.thinking ?? false }, (content, thought) => {
      if (!content && !thought) return;
      if (thought) {
        if (!thinkStart) thinkStart = Date.now();
        reasoning += thought;
      }
      // Time spent thinking: from its first token to the first word of the answer.
      if (content && thinkStart && !thoughtMs) thoughtMs = Date.now() - thinkStart;
      live += content;
      timer ??= window.setTimeout(() => { timer = null; report(live); }, 80);
    });
    if (thinkStart && !thoughtMs) thoughtMs = Date.now() - thinkStart;
    if (timer !== null) window.clearTimeout(timer);
    args.onStream(null);
    lastModel = reply.model || model;
    if (reply.cancelled || args.cancelled()) {
      say(reply.content ?? live);
      throw new Error('stopped');
    }
    say(reply.content ?? '');
    const calls = tools.length ? (reply.tool_calls ?? []) : [];
    if (!calls.length) return finish();

    // In thinking mode the API wants the reasoning back with the tool call it led to.
    thread.push({ role: 'assistant', content: reply.content ?? '', tool_calls: calls, ...(args.thinking && reply.reasoning ? { reasoning_content: reply.reasoning } : {}) });
    if (reasoning && !reasoning.endsWith('\n\n')) reasoning += '\n\n';
    report();
    for (const c of calls) {
      const answer = (content: string) => thread.push({ role: 'tool', tool_call_id: c.id, name: c.function?.name, content });
      const name = c.function?.name ?? '';
      const parsed = extractJsonObject(c.function?.arguments ?? '') ?? {};
      if (args.cancelled()) throw new Error('stopped');

      if (name === 'save_memory' || name === 'forget_memory') {
        const action: AppAction = { id: c.id || `mem-${actions.length}`, name, label: 'Updating memory…', ok: false, running: true };
        actions.push(action);
        steps.push({ type: 'action', id: action.id });
        report();
        try {
          if (name === 'save_memory') {
            const fact = String(parsed.fact ?? '').trim();
            const replaces = Number(parsed.replaces);
            if (Number.isFinite(replaces) && replaces > 0) {
              await studyApi.updateMemory(replaces, fact);
              Object.assign(action, { ok: true, label: 'Memory updated', detail: fact });
            } else {
              const m = await studyApi.addMemory(fact, 'chat');
              Object.assign(action, { ok: true, label: 'Memory updated', detail: m.text });
            }
            answer('Saved.');
          } else {
            await studyApi.deleteMemory(Number(parsed.id));
            Object.assign(action, { ok: true, label: 'Forgot a memory' });
            answer('Deleted.');
          }
        } catch (e) {
          const msg = String(e instanceof Error ? e.message : e);
          Object.assign(action, { ok: false, label: /full/i.test(msg) ? 'Memory is full' : 'Could not update memory', detail: msg });
          answer(`Error: ${msg}`);
        }
        action.running = false;
        report();
        continue;
      }

      if (appNames.has(name) && args.appTools) {
        const action: AppAction = { id: c.id || `act-${actions.length}`, name, label: 'Working…', ok: false, running: true };
        actions.push(action);
        steps.push({ type: 'action', id: action.id });
        report();
        try {
          const r = await args.appTools.run(name, parsed);
          Object.assign(action, { ok: r.ok, label: r.label, detail: r.detail, running: false });
          answer(JSON.stringify(r.result ?? { ok: r.ok, message: r.label }));
        } catch (e) {
          Object.assign(action, { ok: false, label: `Could not ${name.replace(/_/g, ' ')}`, detail: String(e instanceof Error ? e.message : e), running: false });
          answer(`Error: ${action.detail}`);
        }
        report();
        continue;
      }

      const code = name === 'run_python' ? parsed.code : null;
      if (typeof code !== 'string' || !code.trim()) {
        answer(name === 'run_python' ? 'Call run_python with the code in the "code" argument.' : `There is no tool called ${name}.`);
        continue;
      }
      used += 1;
      const run: PythonRun = { id: c.id || `run-${runs.length}`, code, ok: false, output: '', figures: [], running: true };
      runs.push(run);
      steps.push({ type: 'run', id: run.id });
      report();
      try {
        const r = await runPython(code, config.pythonTimeout, args.fileIds);
        for (const f of r.figures ?? []) {
          const saved = await studyApi.attachmentAdd({
            conversationId: args.conversationId, kind: 'figure', name: f.name, mime: f.dataUrl.slice(5, f.dataUrl.indexOf(';')), data: f.dataUrl,
          });
          run.figures.push(saved.id);
        }
        run.ok = r.ok;
        run.output = formatResult(r);
      } catch (e) {
        run.output = `The sandbox could not run this: ${String(e)}`;
      }
      run.running = false;
      report();
      answer(run.output);
    }
  }
  say('I ran out of steps before finishing. Ask me to continue.');
  return finish();
}

/** Readable text out of an uploaded file, where there is one. */
export async function extractText(file: File, attachmentId: number, python: boolean): Promise<string | null> {
  const name = file.name.toLowerCase();
  const textual = file.type.startsWith('text/') || /\.(md|markdown|txt|tex|csv|tsv|json|py|js|ts|rs|c|cpp|h|java|m|r|sql|yaml|yml|xml|html|css)$/.test(name);
  if (textual) return (await file.text()).slice(0, 400_000);
  if ((file.type === 'application/pdf' || name.endsWith('.pdf')) && python) {
    const safe = sandboxName(file.name);
    const code = `doc = pymupdf.open(${JSON.stringify(safe)})\nfor i, page in enumerate(doc):\n    if i >= 60: break\n    print(f"--- page {i + 1} ---")\n    print(page.get_text())`;
    try {
      const r = await runPython(code, 60, [attachmentId]);
      return r.ok && r.stdout.trim() ? r.stdout : null;
    } catch {
      return null;
    }
  }
  return null;
}
