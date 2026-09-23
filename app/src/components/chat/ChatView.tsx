import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Brain, Check, ChevronRight, Copy, Loader2, Paperclip, Pencil, RefreshCw, Square, Volume2, VolumeX, X } from 'lucide-react';
import {
  ActionBarPrimitive,
  AuiIf,
  AssistantRuntimeProvider,
  AttachmentPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
  useExternalStoreRuntime,
  WebSpeechSynthesisAdapter,
  type AppendMessage,
  type AttachmentAdapter,
  type ReasoningMessagePartProps,
  type TextMessagePartProps,
  type ThreadMessageLike,
  type ToolCallMessagePartProps,
} from '@assistant-ui/react';
import { Markdown, type CiteRef } from '../../lib/markdown';
import { highlight } from '../../lib/highlight';
import { generateTitle } from '../../lib/studyGen';
import type { Citation } from '../../lib/retrieval';
import { chatSetup, extractText, type ChatSetup } from '../../lib/chatSetup';
import { beginRun, currentRun, endRun, isStopped, stopRun, updateRun, useChatRun, type ChatRun } from '../../lib/chatRuns';
import { ReferenceChips } from '../ReferenceChip';
import { describeReferences, type Reference } from '../../lib/reference';
import { runChatTurn } from '../../lib/chatTurn';
import { formatCost } from '../../lib/meter';
import type { ToolEnv } from '../../lib/salem/tools';
import type { AgentKind, ExecState } from '../../lib/salem/types';
import { toSupportedImage } from '../../lib/ai';
import { loadPosition, restoreWhenReady, watch } from '../../lib/scrollMemory';
import { markFresh } from '../../lib/chatThreads';
import { focusPrompt, memoryPrompt, nowPrompt, personalPrompt, spacePrompt, setPersonal, usePersonal } from '../../lib/personal';
import { studyApi, type AppAction, type AttachmentInfo, type ChatMessage, type ChatThread, type PythonRun } from '../../study/api';

/**
 * The chat used by the standalone Chat tab and by every notebook: the thread
 * UI comes from assistant-ui (running on an external store, so SQLite stays
 * the source of truth), the answers from the Salem AI runtime (lib/salem).
 *
 * The view knows nothing about how an answer was produced. It renders the
 * execution states the runtime reports — searching, running Python, asking a
 * sub-agent — in the order they happened, which is why a long agentic turn
 * reads as a sequence of steps instead of a spinner.
 */

type UiMessage = ChatMessage & { pending?: boolean };

/** A chat with no app tools: the notebook chat, and the standalone chat with
 *  App control switched off. Source tools still work — they come from the
 *  notebook and the source list, not from this. */
const emptyEnv: ToolEnv = { tree: () => [], refresh: async () => [], open: () => {} };

const TEXT_LIMIT = 40_000;
/** Images are only re-sent for the last few turns; older ones are named. */
const IMAGE_TURNS = 3;

/**
 * The saved thread as the runtime should see it: attachment text inlined,
 * recent images attached, and every assistant reply carrying what it did, so
 * the agent knows what it already computed.
 */
async function salemMessages(history: UiMessage[]): Promise<{ role: 'user' | 'assistant'; content: unknown }[]> {
  const out: { role: 'user' | 'assistant'; content: unknown }[] = [];
  const userTurns = history.map((m, i) => (m.role === 'user' ? i : -1)).filter((i) => i >= 0);
  const recent = new Set(userTurns.slice(-IMAGE_TURNS));
  for (const [i, m] of history.entries()) {
    if (m.pending) continue;
    if (m.role === 'user') {
      out.push({ role: 'user', content: await userContent(m, recent.has(i)) });
    } else if (m.role === 'assistant' && (m.content || m.meta?.runs?.length)) {
      out.push({ role: 'assistant', content: assistantContent(m) });
    }
  }
  return out;
}

async function userContent(m: UiMessage, withImages: boolean): Promise<unknown> {
  const attachments = m.meta?.attachments ?? [];
  const references = m.meta?.references ?? [];
  let text = m.content;
  // Before the attachments, because it is what the message is about: the
  // student pointed at this *here*, in this turn, and a later turn pointing
  // at something else must not be read against it.
  const pointed = describeReferences(references);
  if (pointed) text = `${pointed}\n\n---\n\n${text}`;
  const images: string[] = [];
  for (const a of attachments) {
    if (a.mime.startsWith('image/')) {
      if (withImages) {
        const url = await studyApi.attachmentData(a.id).then(toSupportedImage).catch(() => null);
        if (url) { images.push(url); continue; }
      }
      text += `\n\n[image "${a.name}" was attached${withImages ? ' but could not be read' : ' earlier in the chat'}]`;
    } else if (a.text) {
      const body = a.text.length > TEXT_LIMIT
        ? `${a.text.slice(0, TEXT_LIMIT)}\n… [${a.text.length - TEXT_LIMIT} more characters; read the file in Python for the rest]`
        : a.text;
      text += `\n\n<file name="${a.name}">\n${body}\n</file>`;
    } else {
      text += `\n\n[file "${a.name}" (${a.mime || 'unknown type'}) is attached and available to run_python as ./${a.name}]`;
    }
  }
  if (!images.length) return text;
  return [{ type: 'text', text }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))];
}

/** A saved reply as the model wrote it: its text in order, with each Python
 *  run and app action summarised where it happened. */
function assistantContent(m: UiMessage): string {
  const runs = m.meta?.runs ?? [];
  const actions = m.meta?.actions ?? [];
  if (!runs.length && !actions.length) return m.content;
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
  const note = (r: PythonRun) => `[ran Python:\n\`\`\`python\n${clip(r.code, 1200)}\n\`\`\`\n→ ${clip(r.output, 600)}]`;
  const steps = m.meta?.steps;
  if (!steps) return `${m.content}\n\n${runs.map(note).join('\n')}`;
  return steps
    .map((st) => {
      if (st.type === 'text') return st.text;
      if (st.type === 'action') {
        const a = actions.find((x) => x.id === st.id);
        return a ? `[did in the app: ${a.label}${a.ok ? '' : ' (failed)'}]` : '';
      }
      return note(runs.find((r) => r.id === st.id) ?? runs[0]);
    })
    .filter(Boolean)
    .join('\n\n');
}

/** Where a click on a citation chip goes (the notebook opens the source there). */
const CiteContext = createContext<((sourceId: number, unit: number) => void) | undefined>(undefined);

/** What the runtime is doing right now, shown while the reply is still empty. */
export type RunState = { state: ExecState; detail: string };
const RunStateContext = createContext<RunState | null>(null);

/** Plain English for each execution state. Deliberately about the work, not
 *  about the model: none of this exposes what it is reasoning. */
const STATE_LABEL: Record<ExecState, string> = {
  planning: 'planning',
  executing: 'working',
  waiting_tool: 'using a tool',
  waiting_subagent: 'delegating',
  running_python: 'running Python',
  retrieving: 'reading your sources',
  validating: 'checking the result',
  retrying: 'trying again',
  completed: 'done',
  failed: 'failed',
  cancelled: 'stopped',
};
type Part = Exclude<ThreadMessageLike['content'], string>[number];

const PENDING_ID = -1;

/** The answer as it stands, as a message the thread can render. */
const liveMessage = (run: ChatRun): UiMessage => ({
  id: PENDING_ID,
  role: 'assistant',
  content: '',
  meta: { steps: run.steps, runs: run.runs, actions: run.actions, citations: run.citations, cost: run.cost },
  createdAt: run.startedAt,
  pending: true,
});

/** What a stopped turn keeps: the text it had written, and the work it did. */
function liveTextOf(conversationId: number): { text: string; meta: ChatMessage['meta'] } {
  const run = currentRun(conversationId);
  if (!run) return { text: '', meta: null };
  const text = run.steps
    .filter((st) => st.type === 'text')
    .map((st) => (st as { text: string }).text)
    .join('\n\n');
  return { text, meta: { steps: run.steps, runs: run.runs, actions: run.actions, citations: run.citations, cost: run.cost } };
}

const readAsDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });

function toThreadMessage(m: UiMessage): ThreadMessageLike {
  const createdAt = new Date(m.createdAt);
  if (m.role === 'user') {
    return {
      id: String(m.id),
      role: 'user',
      createdAt,
      metadata: { custom: { references: m.meta?.references ?? [] } },
      content: [{ type: 'text', text: m.content }],
      attachments: (m.meta?.attachments ?? []).map((a) => ({
        id: String(a.id),
        type: a.mime.startsWith('image/') ? 'image' : 'document',
        name: a.name,
        contentType: a.mime,
        status: { type: 'complete' },
        content: [],
      })),
    };
  }
  const runs = m.meta?.runs ?? [];
  const error = m.meta?.error;
  const toolPart = (r: PythonRun): Part => ({
    type: 'tool-call' as const,
    toolCallId: r.id,
    toolName: 'run_python',
    args: { code: r.code },
    argsText: r.code,
    result: r.running ? undefined : r,
    isError: !r.running && !r.ok,
  });
  // Replies render in the order they were written: text, then Python, then
  // what the model said about the result. Older replies without steps show
  // their runs first.
  const steps = m.meta?.steps;
  const actionPart = (a: AppAction): Part => ({
    type: 'tool-call' as const,
    toolCallId: a.id,
    toolName: 'app_action',
    args: { name: a.name },
    argsText: a.name,
    result: a.running ? undefined : a,
    isError: !a.running && !a.ok,
  });
  const body = steps
    ? steps.flatMap<Part>((st) => {
      if (st.type === 'text') return [{ type: 'text', text: st.text }];
      if (st.type === 'action') {
        const a = m.meta?.actions?.find((x) => x.id === st.id);
        return a ? [actionPart(a)] : [];
      }
      const r = runs.find((x) => x.id === st.id);
      return r ? [toolPart(r)] : [];
    })
    : [...runs.map(toolPart), ...(m.content ? [{ type: 'text' as const, text: m.content }] : [])] as Part[];
  const reasoning = m.meta?.reasoning;
  const content: Part[] = reasoning ? [{ type: 'reasoning', text: reasoning }, ...body] : body;
  return {
    id: String(m.id),
    role: 'assistant',
    createdAt,
    content,
    metadata: { custom: { citations: m.meta?.citations ?? [], thoughtMs: m.meta?.thoughtMs, cost: m.meta?.cost } },
    status: m.pending
      ? { type: 'running' }
      : error
        ? { type: 'incomplete', reason: error === 'stopped' ? 'cancelled' : 'error', error }
        : { type: 'complete', reason: 'stop' },
  };
}

// ------------------------------------------------------------------ parts

function Figure({ id }: { id: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    studyApi.attachmentData(id).then((u) => { if (alive) setSrc(u); }).catch(() => {});
    return () => { alive = false; };
  }, [id]);
  return src
    ? <a className="chat-figure" href={src} download={`figure-${id}.png`} title="Click to save"><img src={src} alt="Figure from Python" /></a>
    : <div className="chat-figure loading" />;
}

function PythonBlock(props: ToolCallMessagePartProps<{ code: string }, PythonRun>) {
  const [open, setOpen] = useState(false);
  const run = props.result;
  const running = !run;
  const state = running ? 'running' : run.ok ? 'ok' : 'error';
  const firstLine = run?.output.split('\n').find((l) => l.trim() && !l.startsWith('stdout:')) ?? '';
  return (
    <div className={`py-block ${state}`}>
      <button type="button" className="py-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <ChevronRight className={`py-caret${open ? ' open' : ''}`} />
        <span className="py-tag">python</span>
        <span className="py-line">{running ? 'running…' : firstLine.slice(0, 120) || (run.ok ? 'ok' : 'failed')}</span>
        {running && <span className="dots"><i /><i /><i /></span>}
      </button>
      <div className={`collapse${open ? ' open' : ''}`}>
        <div>
          <pre className="py-code"><code className="hljs" dangerouslySetInnerHTML={{ __html: highlight(props.args?.code ?? props.argsText ?? '', 'python').html }} /></pre>
          {run && <pre className="py-out">{run.output}</pre>}
        </div>
      </div>
      {!!run?.figures.length && <div className="chat-figures">{run.figures.map((f) => <Figure key={f} id={f} />)}</div>}
    </div>
  );
}

function Text({ text }: TextMessagePartProps) {
  const citations = useAuiState((s) => (s.message.metadata.custom?.citations as Citation[] | undefined) ?? EMPTY);
  const onCite = useContext(CiteContext);
  const cites: CiteRef[] = useMemo(() => citations.map((c) => ({ n: c.n, title: c.title, label: c.label })), [citations]);
  return (
    <Markdown
      text={text}
      cites={cites.length ? cites : undefined}
      onCite={onCite && citations.length ? (n) => { const c = citations.find((x) => x.n === n); if (c) onCite(c.sourceId, c.unit); } : undefined}
    />
  );
}
const EMPTY: Citation[] = [];
const NO_REFS: Reference[] = [];

/** The sources a reply cited, under it. */
function CitedSources() {
  const citations = useAuiState((s) => (s.message.metadata.custom?.citations as Citation[] | undefined) ?? EMPTY);
  const text = useAuiState((s) => s.message.content.map((p) => (p.type === 'text' ? p.text : '')).join(' '));
  const onCite = useContext(CiteContext);
  const used = useMemo(() => {
    const ns = new Set([...text.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)].flatMap((m) => m[1].split(',').map((x) => Number(x.trim()))));
    return citations.filter((c) => ns.has(c.n));
  }, [citations, text]);
  if (!used.length) return null;
  return (
    <div className="cited">
      {used.map((c) => (
        <button type="button" key={c.n} className="cited-item" onClick={() => onCite?.(c.sourceId, c.unit)} title="Open this source here">
          <span className="cite">{c.n}</span><span className="cited-title">{c.title}</span><span className="muted">{c.label}</span>
        </button>
      ))}
    </div>
  );
}

function AttachmentChip() {
  const a = useAuiState((s) => s.attachment);
  const dbId = Number(a.id);
  const [thumb, setThumb] = useState<string | null>(null);
  const isImage = (a.contentType ?? '').startsWith('image/');
  useEffect(() => {
    if (!isImage) return;
    if (a.file) { readAsDataUrl(a.file).then(setThumb).catch(() => {}); return; }
    if (Number.isFinite(dbId)) studyApi.attachmentData(dbId).then(setThumb).catch(() => {});
  }, [a.file, dbId, isImage]);
  return (
    <AttachmentPrimitive.Root className="att-chip">
      {thumb ? <img src={thumb} alt="" /> : <span className="att-icon">{(a.name.split('.').pop() ?? 'file').slice(0, 4)}</span>}
      <span className="att-name"><AttachmentPrimitive.Name /></span>
      <AttachmentPrimitive.Remove className="att-remove" aria-label="Remove"><X /></AttachmentPrimitive.Remove>
    </AttachmentPrimitive.Root>
  );
}

function UserMessage() {
  const id = useAuiState((s) => s.message.id);
  const references = useAuiState((s) => (s.message.metadata.custom?.references as Reference[] | undefined) ?? NO_REFS);
  return (
    <MessagePrimitive.Root className="msg user" data-anchor={id}>
      {!!references.length && <ReferenceChips references={references} className="msg-refs" />}
      <div className="msg-atts"><MessagePrimitive.Attachments components={{ Attachment: AttachmentChip }} /></div>
      <div className="msg-bubble"><MessagePrimitive.Parts components={{ Text: ({ text }) => <div className="msg-plain">{text}</div> }} /></div>
      <ActionBarPrimitive.Root className="msg-actions user-actions" hideWhenRunning autohide="not-last">
        <ActionBarPrimitive.Copy className="msg-act" title="Copy">
          <AuiIf condition={(s) => s.message.isCopied}><Check /></AuiIf>
          <AuiIf condition={(s) => !s.message.isCopied}><Copy /></AuiIf>
        </ActionBarPrimitive.Copy>
        <ActionBarPrimitive.Edit className="msg-act" title="Edit and resend"><Pencil /></ActionBarPrimitive.Edit>
      </ActionBarPrimitive.Root>
    </MessagePrimitive.Root>
  );
}

/** Editing an earlier question: the reply to it (and what followed) is replaced. */
function EditComposer() {
  return (
    <MessagePrimitive.Root className="msg user editing">
      <ComposerPrimitive.Root className="edit-composer">
        <ComposerPrimitive.Input className="composer-input" submitMode="enter" rows={1} maxRows={12} autoFocus />
        <div className="edit-actions">
          <span className="muted small">Everything after this message is replaced.</span>
          <ComposerPrimitive.Cancel className="btn ghost">Cancel</ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send className="btn primary">Send</ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
    </MessagePrimitive.Root>
  );
}

const fmtThought = (ms: number) => (ms < 1500 ? 'a moment' : ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);

/** Thinking mode: the model's reasoning, folded away once the answer starts. */
function Reasoning({ text }: ReasoningMessagePartProps) {
  const running = useAuiState((s) => s.message.status?.type === 'running');
  const answering = useAuiState((s) => s.message.content.some((p) => p.type !== 'reasoning' && (p.type !== 'text' || !!p.text)));
  const ms = useAuiState((s) => s.message.metadata.custom?.thoughtMs as number | undefined);
  const [open, setOpen] = useState(false);
  const thinking = running && !answering;
  const tail = thinking ? text.trim().split('\n').filter(Boolean).slice(-2).join(' ').slice(-220) : '';
  return (
    <div className={`reasoning${thinking ? ' live' : ''}`}>
      <button type="button" className="reasoning-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Brain />
        <span>{thinking ? 'Thinking' : ms ? `Thought for ${fmtThought(ms)}` : 'Thoughts'}</span>
        {thinking && <span className="dots"><i /><i /><i /></span>}
        <ChevronRight className={`py-caret${open ? ' open' : ''}`} />
      </button>
      {thinking && !open && tail && <div className="reasoning-tail">{tail}</div>}
      <div className={`collapse${open ? ' open' : ''}`}><div><div className="reasoning-body">{text}</div></div></div>
    </div>
  );
}

/** One thing the assistant did in the app, shown where it happened in the reply. */
function ActionBlock(props: ToolCallMessagePartProps<{ name: string }, AppAction>) {
  const a = props.result;
  return (
    <div className={`action-block ${!a ? 'running' : a.ok ? 'ok' : 'error'}`}>
      {!a ? <Loader2 className="spin" /> : a.ok ? <Check /> : <X />}
      <span className="action-label">{a?.label ?? 'Working…'}</span>
      {a?.detail && <span className="action-detail muted">{a.detail}</span>}
    </div>
  );
}

/**
 * What this reply cost, under it: counting up while it is written, then
 * settled. Every chat shows it — the notebook's, the assistant's, the one
 * opened about a card or a question — because every one of them is this.
 */
function ReplyCost() {
  const cost = useAuiState((s) => s.message.metadata.custom?.cost as number | undefined);
  const running = useAuiState((s) => s.message.status?.type === 'running');
  if (!cost) return null;
  return (
    <div className={`reply-cost${running ? ' live' : ''}`} title="What the model calls for this reply cost">
      {formatCost(cost)}
    </div>
  );
}

function AssistantMessage() {
  const status = useAuiState((s) => s.message.status);
  const empty = useAuiState((s) => s.message.content.length === 0);
  const id = useAuiState((s) => s.message.id);
  const runState = useContext(RunStateContext);
  const error = status?.type === 'incomplete' ? status : null;
  return (
    <MessagePrimitive.Root className="msg assistant" data-anchor={id}>
      <div className="msg-body">
        <MessagePrimitive.Parts components={{ Text, Reasoning, tools: { by_name: { run_python: PythonBlock, app_action: ActionBlock } } }} />
        <CitedSources />
        <ReplyCost />
        {status?.type === 'running' && (empty || runState) && (
          <div className="thinking">
            <span className="dots"><i /><i /><i /></span>
            {runState ? (runState.detail || STATE_LABEL[runState.state]) : 'thinking'}
          </div>
        )}
        {error && (
          <div className={`msg-error${error.reason === 'cancelled' ? ' muted' : ''}`}>
            {error.reason === 'cancelled' ? 'Stopped.' : `Something went wrong: ${String(error.error ?? 'unknown error')}`}
          </div>
        )}
      </div>
      <ActionBarPrimitive.Root className="msg-actions" hideWhenRunning>
        <ActionBarPrimitive.Copy className="msg-copy" title="Copy this reply as Markdown">
          <AuiIf condition={(s) => s.message.isCopied}><Check />Copied</AuiIf>
          <AuiIf condition={(s) => !s.message.isCopied}><Copy />Copy</AuiIf>
        </ActionBarPrimitive.Copy>
        <ActionBarPrimitive.Reload className="msg-act" title="Regenerate this reply"><RefreshCw /></ActionBarPrimitive.Reload>
        <AuiIf condition={(s) => s.message.speech == null}>
          <ActionBarPrimitive.Speak className="msg-act" title="Read aloud"><Volume2 /></ActionBarPrimitive.Speak>
        </AuiIf>
        <AuiIf condition={(s) => s.message.speech != null}>
          <ActionBarPrimitive.StopSpeaking className="msg-act on" title="Stop reading"><VolumeX /></ActionBarPrimitive.StopSpeaking>
        </AuiIf>
      </ActionBarPrimitive.Root>
    </MessagePrimitive.Root>
  );
}

// ------------------------------------------------------------------- view

export function ChatView({ threadId, notebookId, system, retrieve, onCite, toolEnv, agent = 'chat', allowTools, sourceIds, tag, references, onReferencesSent, reloadToken = 0, emptyTitle, emptyHint, placeholder, onThreadCreated, onChanged, header, suggestions }: {
  /** null until the first message creates the thread. */
  threadId: number | null;
  notebookId: number | null;
  /** The system prompt for this kind of chat (lib/prompts), given whether Python is available. */
  system: (python: boolean) => string;
  /** Notebook chats: find source excerpts for the question (appended to the system prompt). */
  retrieve?: (history: ChatMessage[], question: string) => Promise<{ context: string; citations: Citation[] }>;
  onCite?: (sourceId: number, unit: number) => void;
  /** What the run's tools may reach: the study tree, navigation, the notebook. */
  toolEnv?: ToolEnv;
  /** Which agent shape this chat is. The runtime may still escalate a turn. */
  agent?: AgentKind;
  /** Restrict the run to these tool names (App control off, for instance). */
  allowTools?: string[];
  /** Notebook chats: the sources this chat is allowed to read. */
  sourceIds?: number[];
  /**
   * What this chat was opened from — a quiz question, a flashcard, a note.
   *
   * It is written into the first message the student sends, so the thread
   * still says what it is about when they find it in the chat list later,
   * and so the model can see it too.
   */
  tag?: string;
  /**
   * What the student pointed at, waiting to be sent.
   *
   * It behaves like a file on the composer: it sits there until the message
   * goes, travels with that message, and is then cleared — because what they
   * were pointing at when they asked is part of *that* question, not of
   * everything they ask afterwards.
   */
  references?: Reference[];
  /** Called once the references have gone with a message. */
  onReferencesSent?: () => void;
  /** Bump to reload the thread (after clearing it). */
  reloadToken?: number;
  emptyTitle: string;
  emptyHint: string;
  placeholder: string;
  onThreadCreated?: (t: ChatThread) => void;
  onChanged?: () => void;
  header?: (messages: ChatMessage[]) => React.ReactNode;
  /** Starter prompts shown on an empty chat; clicking one sends it. */
  suggestions?: string[];
}) {
  const { think, memory: memoryOn } = usePersonal();
  const speech = useMemo(() => (typeof speechSynthesis !== 'undefined' ? new WebSpeechSynthesisAdapter() : undefined), []);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  // The answer being written, if one is. It lives outside this component so
  // that leaving the chat does not throw it away.
  const waiting = (references ?? []).filter((r) => !r.briefed);
  const pinned = (references ?? []).filter((r) => r.briefed);
  const live = useChatRun(threadId);
  const running = !!live;
  const runState: RunState | null = live && live.state !== 'completed'
    ? { state: live.state, detail: live.detail }
    : null;
  const [loading, setLoading] = useState(false);
  const [setup, setSetup] = useState<ChatSetup | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const threadRef = useRef<number | null>(threadId);
  /** A thread this view created during a send: its id arriving as a prop must not reload it. */
  const createdHere = useRef<number | null>(null);
  /** Bumped on cancel and on thread switch; a turn only lands if it still matches. */
  const tokenRef = useRef(0);
  const messagesRef = useRef<UiMessage[]>([]);
  messagesRef.current = messages;
  const chatRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    chatSetup().then(setSetup).catch((e) => setSetupError(String(e)));
  }, []);

  /**
   * Pick up an answer that finished elsewhere.
   *
   * A turn outlives the view that started it, so the reply is often saved by
   * a component that has since been unmounted. When the run this view is
   * watching disappears, the answer is in the database: read it back.
   */
  const wasRunning = useRef(false);
  useEffect(() => {
    const had = wasRunning.current;
    wasRunning.current = running;
    if (!had || running || threadId === null) return;
    let alive = true;
    studyApi.chatMessages(threadId)
      .then((m) => { if (alive) setMessages(m.filter((x) => x.role === 'user' || x.role === 'assistant')); })
      .catch(() => {});
    return () => { alive = false; };
  }, [running, threadId]);

  /**
   * Where the student had got to in this chat.
   *
   * Every chat keeps its own position, and it survives switching chats and
   * restarting the app. It is restored after the messages have rendered — the
   * thread view scrolls itself to the bottom first, and Markdown and maths
   * both change the height after the first paint — and it is anchored to the
   * message that was at the top, so a reply arriving below does not move it.
   *
   * A chat that was left at the bottom has nothing stored, which is what lets
   * the usual "follow the newest message" behaviour stand.
   */
  useEffect(() => {
    if (threadId === null || loading || !messages.length || running) return;
    const viewport = chatRef.current?.querySelector<HTMLElement>('.chat-viewport');
    if (!viewport) return;
    const key = `chat-${threadId}`;
    const saved = loadPosition(key);
    const stop = saved ? restoreWhenReady(viewport, saved) : () => {};
    const unwatch = watch(viewport, key);
    return () => { stop(); unwatch(); };
  }, [threadId, loading, messages.length, running]);

  // Load the thread, unless it is the one this view just created mid-send.
  const lastReload = useRef(reloadToken);
  useEffect(() => {
    const forced = lastReload.current !== reloadToken;
    lastReload.current = reloadToken;
    if (!forced && threadId !== null && threadId === createdHere.current) return;
    // Switching chats leaves the answer running. It belongs to the student,
    // not to this view, and it will be here when they come back.
    threadRef.current = threadId;
    tokenRef.current += 1;
    if (threadId === null) { setMessages([]); return; }
    let alive = true;
    setLoading(true);
    studyApi.chatMessages(threadId)
      .then((m) => { if (alive) setMessages(m.filter((x) => x.role === 'user' || x.role === 'assistant')); })
      .catch(() => { if (alive) setMessages([]); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [threadId, reloadToken]);

  const ensureThread = useCallback(async (): Promise<number> => {
    if (threadRef.current !== null) return threadRef.current;
    const t = await studyApi.chatCreate(notebookId);
    markFresh(t.id);
    threadRef.current = t.id;
    createdHere.current = t.id;
    onThreadCreated?.(t);
    return t.id;
  }, [notebookId, onThreadCreated]);

  const attachments: AttachmentAdapter = useMemo(() => ({
    accept: '*',
    async add({ file }) {
      return {
        id: crypto.randomUUID(),
        type: file.type.startsWith('image/') ? 'image' : 'document',
        name: file.name,
        contentType: file.type || 'application/octet-stream',
        file,
        status: { type: 'requires-action', reason: 'composer-send' },
      };
    },
    async send(a) {
      const conversationId = await ensureThread();
      const data = await readAsDataUrl(a.file);
      const info = await studyApi.attachmentAdd({ conversationId, kind: 'upload', name: a.file.name, mime: a.contentType ?? 'application/octet-stream', data });
      const text = await extractText(a.file, info.id, !!setup?.python).catch(() => null);
      if (text) await studyApi.attachmentSetText(info.id, text);
      return { ...a, id: String(info.id), status: { type: 'complete' }, content: [] };
    },
    async remove() { /* nothing is stored until send */ },
  }), [ensureThread, setup?.python]);

  /** Answer the last user message of `history` (already saved) and save the reply. */
  const respond = useCallback(async (conversationId: number, history: UiMessage[]) => {
    if (!setup) return;
    const question = [...history].reverse().find((m) => m.role === 'user');
    const text = question?.content ?? '';
    setMessages(history);
    beginRun(conversationId, text);

    const fileIds = history.flatMap((m) => (m.meta?.attachments ?? []).map((a) => a.id));
    const firstExchange = history.filter((m) => m.role === 'user').length === 1;
    let content = '';
    let meta: ChatMessage['meta'] = null;
    let citations: Citation[] = [];
    try {
      let prompt = system(setup.python);
      const mine = personalPrompt();
      if (mine) prompt += `\n\n${mine}`;
      prompt += `\n\n${nowPrompt()}\n\n${focusPrompt()}`;
      const tree = await studyApi.tree().catch(() => null);
      if (tree) prompt += `\n\n${spacePrompt(tree)}`;
      if (memoryOn) {
        const saved = await studyApi.memories().catch(() => null);
        const block = memoryPrompt(saved?.items ?? [], true);
        if (block) prompt += `\n\n${block}`;
      }
      if (retrieve && text) {
        const found = await retrieve(history, text).catch(() => null);
        if (found?.context) { prompt += `\n\n${found.context}`; citations = found.citations; }
      }
      updateRun(conversationId, { citations });
      const r = await runChatTurn({
        agent,
        system: prompt,
        messages: await salemMessages(history),
        conversationId,
        files: fileIds,
        sources: sourceIds ?? [],
        allow: allowTools,
        thinking: think,
        model: setup.config.flashModel,
        feature: notebookId === null ? 'chat' : 'notebook',
        // One task id per chat, so a long conversation keeps its objective,
        // its constraints and what has already been done.
        taskId: `chat-${conversationId}`,
        objective: text,
        env: { ...(toolEnv ?? emptyEnv), notebookId, sourceIds },
        cancelled: () => isStopped(conversationId),
        onRun: (abort) => updateRun(conversationId, { abort }),
        onCost: (cost) => updateRun(conversationId, { cost }),
        onProgress: ({ steps, runs, actions, state, stateDetail }) => {
          updateRun(conversationId, { steps, runs, actions, state, detail: stateDetail, citations });
        },
      });
      content = r.text;
      meta = {
        ...(r.runs.length || r.actions.length ? { runs: r.runs, actions: r.actions, steps: r.steps } : {}),
        model: setup.config.flashModel,
        ...(citations.length ? { citations } : {}),
        ...(r.cost > 0 ? { cost: r.cost } : {}),
      };
    } catch (e) {
      const message = String(e instanceof Error ? e.message : e);
      if (message === 'stopped') {
        // Keep what was written before Stop; it is usually the useful half.
        const partial = liveTextOf(conversationId);
        content = partial.text;
        meta = { ...partial.meta, error: 'stopped' };
      } else {
        // A failed turn still spent what it spent.
        const spent = currentRun(conversationId)?.cost ?? 0;
        meta = { error: message, ...(spent > 0 ? { cost: spent } : {}) };
      }
    }
    const saved = await studyApi.chatAddMessage(conversationId, 'assistant', content, meta);
    endRun(conversationId);
    if (threadRef.current === conversationId) {
      setMessages((ms) => [...ms.filter((m) => !m.pending), saved]);
    }
    onChanged?.();
    // Name the chat from its first exchange (the first line of the question stands in until then).
    if (firstExchange && content) {
      void generateTitle(text || question?.meta?.attachments?.[0]?.name || '', content)
        .then((title) => (title ? studyApi.chatRename(conversationId, title).then(() => onChanged?.()) : undefined))
        .catch(() => {});
    }
  }, [setup, system, retrieve, toolEnv, agent, allowTools, sourceIds, notebookId, onChanged, think, memoryOn]);

  const onNew = useCallback(async (msg: AppendMessage) => {
    if (!setup) throw new Error(setupError ?? 'The AI settings are still loading.');
    const text = msg.content.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n').trim();
    const ids = (msg.attachments ?? []).map((a) => Number(a.id)).filter(Number.isFinite);
    if (!text && !ids.length) return;
    const conversationId = await ensureThread();
    const infos: AttachmentInfo[] = ids.length ? await studyApi.attachmentsInfo(ids) : [];
    // The tag goes on the first message only: after that the thread speaks
    // for itself, and repeating it would just be noise. Plain brackets, not
    // Markdown — a user message is shown as typed, so any markup would show
    // up as the asterisks it is made of.
    const firstHere = messagesRef.current.filter((m) => m.role === 'user').length === 0;
    const tagged = tag && firstHere && text ? `[${tag}] ${text}` : text;
    const meta = {
      ...(infos.length ? { attachments: infos } : {}),
      ...(waiting.length ? { references: waiting } : {}),
    };
    const user = await studyApi.chatAddMessage(conversationId, 'user', tagged, Object.keys(meta).length ? meta : null);
    if (waiting.length) onReferencesSent?.();
    if (messagesRef.current.filter((m) => m.role === 'user').length === 0) {
      void studyApi.chatRename(conversationId, (text || infos[0]?.name || 'New chat').slice(0, 70)).then(() => onChanged?.());
    }
    await respond(conversationId, [...messagesRef.current.filter((m) => !m.pending), user]);
  }, [setup, setupError, ensureThread, respond, onChanged, tag]);

  // Regenerate: drop the reply (and anything after it) and answer again.
  const onReload = useCallback(async (parentId: string | null) => {
    const conversationId = threadRef.current;
    if (conversationId === null || !setup) return;
    const saved = messagesRef.current.filter((m) => !m.pending);
    const idx = parentId === null ? -1 : saved.findIndex((m) => String(m.id) === parentId);
    if (saved[idx + 1]) await studyApi.chatTruncate(conversationId, saved[idx + 1].id);
    await respond(conversationId, saved.slice(0, idx + 1));
  }, [setup, respond]);

  // Edit an earlier question: it and everything after it is replaced, then answered.
  const onEdit = useCallback(async (msg: AppendMessage) => {
    const conversationId = threadRef.current;
    if (conversationId === null || !setup) return;
    const text = msg.content.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n').trim();
    const saved = messagesRef.current.filter((m) => !m.pending);
    let idx = msg.sourceId ? saved.findIndex((m) => String(m.id) === msg.sourceId) : -1;
    if (idx < 0) idx = msg.parentId === null ? 0 : saved.findIndex((m) => String(m.id) === msg.parentId) + 1;
    const original = saved[idx];
    if (!text && !original?.meta?.attachments?.length) return;
    if (original) await studyApi.chatTruncate(conversationId, original.id);
    const user = await studyApi.chatAddMessage(conversationId, 'user', text, original?.meta?.attachments?.length ? { attachments: original.meta.attachments } : null);
    await respond(conversationId, [...saved.slice(0, idx), user]);
  }, [setup, respond]);

  // Stop: ask the turn to stop and let it save what it had. The turn owns
  // the saving, so a Stop from here and a Stop from the tray do the same.
  const onCancel = useCallback(async () => {
    const conversationId = threadRef.current;
    if (conversationId !== null) stopRun(conversationId);
  }, []);

  // The answer being written is appended here rather than held in state, so
  // arriving mid-turn shows it from wherever it has got to.
  const shown = live ? [...messages.filter((m) => !m.pending), liveMessage(live)] : messages;

  const runtime = useExternalStoreRuntime<UiMessage>({
    messages: shown,
    isRunning: running,
    isLoading: loading,
    isDisabled: !!setupError,
    convertMessage: toThreadMessage,
    onNew,
    onEdit,
    onReload,
    onCancel,
    adapters: { attachments, speech },
  });

  const saved = shown.filter((m) => !m.pending);

  return (
    <CiteContext.Provider value={onCite}>
    <RunStateContext.Provider value={runState}>
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="chat" ref={chatRef}>
        {header?.(saved)}
        <ComposerPrimitive.AttachmentDropzone className="chat-drop">
          <ThreadPrimitive.Root className="chat-thread">
            <ThreadPrimitive.Viewport className="chat-viewport">
              <ThreadPrimitive.Empty>
                <div className="chat-empty">
                  <p className="chat-empty-title">{emptyTitle}</p>
                  <p className="muted">{emptyHint}</p>
                  {setup && !setup.python && <p className="muted small">Python is not set up, so no code or graphs. Settings → Python → Install.</p>}
                  {setup && !setup.config.hasKey && <p className="warn small">No DeepSeek API key yet. Add one in Settings.</p>}
                  {!!suggestions?.length && (
                    <div className="chat-suggest stagger">
                      {suggestions.map((p, i) => (
                        <ThreadPrimitive.Suggestion key={p} prompt={p} send className="suggest-chip" style={{ '--i': i } as React.CSSProperties}>{p}</ThreadPrimitive.Suggestion>
                      ))}
                    </div>
                  )}
                </div>
              </ThreadPrimitive.Empty>
              <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage, UserEditComposer: EditComposer }} />
              <ThreadPrimitive.ViewportFooter className="chat-footer">
                <ThreadPrimitive.ScrollToBottom className="scroll-bottom" aria-label="Scroll to bottom"><ArrowDown /></ThreadPrimitive.ScrollToBottom>
                <ComposerPrimitive.Root className="composer">
                  {(waiting.length > 0 || pinned.length > 0) && (
                    <ReferenceChips references={[...pinned, ...waiting]} />
                  )}
                  <div className="composer-atts"><ComposerPrimitive.Attachments components={{ Attachment: AttachmentChip }} /></div>
                  <div className="composer-row">
                    <ComposerPrimitive.AddAttachment className="icon-btn composer-attach" aria-label="Attach files" title="Attach files (or drop / paste them)"><Paperclip /></ComposerPrimitive.AddAttachment>
                    <ComposerPrimitive.Input className="composer-input" placeholder={placeholder} submitMode="enter" addAttachmentOnPaste rows={1} maxRows={10} autoFocus />
                    <button type="button" className={`think-toggle${think ? ' on' : ''}`} onClick={() => setPersonal({ think: !think })} aria-pressed={think}
                      title={think ? 'Thinking is on: it reasons before answering (slower, better on hard problems)' : 'Think before answering (slower, better on hard problems)'}>
                      <Brain /><span>Think</span>
                    </button>
                    <ThreadPrimitive.If running={false}>
                      <ComposerPrimitive.Send className="icon-btn primary composer-send" aria-label="Send"><ArrowUp /></ComposerPrimitive.Send>
                    </ThreadPrimitive.If>
                    <ThreadPrimitive.If running>
                      <ComposerPrimitive.Cancel className="icon-btn composer-send" aria-label="Stop"><Square /></ComposerPrimitive.Cancel>
                    </ThreadPrimitive.If>
                  </div>
                  {setupError && <div className="form-err">{setupError}</div>}
                </ComposerPrimitive.Root>
              </ThreadPrimitive.ViewportFooter>
            </ThreadPrimitive.Viewport>
          </ThreadPrimitive.Root>
        </ComposerPrimitive.AttachmentDropzone>
      </div>
    </AssistantRuntimeProvider>
    </RunStateContext.Provider>
    </CiteContext.Provider>
  );
}
