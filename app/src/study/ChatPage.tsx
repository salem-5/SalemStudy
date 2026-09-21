import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Eraser, Pencil, Search, SquarePen, Trash, X } from 'lucide-react';
import { ChatView } from '../components/chat/ChatView';
import { ViewBar } from '../components/ViewBar';
import { relTime } from '../lib/format';
import { APP_POLICY, chatPrompt } from '../lib/prompts';
import { appTools } from '../lib/assistant';
import { studyApi, type ChatThread, type SubjectNode } from './api';
import { ConfirmDialog } from './dialogs';
import { dropEmpty } from '../lib/chatThreads';
import type { Route } from './pages';

const CHAT_STARTERS = [
  'Explain eigenvalues like I am seeing them for the first time',
  'Plot sin(x) with its Taylor polynomials up to degree 7',
  'Check my working: I got ∫ x·eˣ dx = x·eˣ + C',
  'What is the difference between a p-value and a confidence level?',
];
const CHAT_STARTERS_APP = [
  'Plan my week: I have a Calculus midterm next Friday',
  'Make flashcards on the chain rule in my Calculus notebook',
  'Start a 25 minute focus session with three tasks',
  'Explain eigenvalues like I am seeing them for the first time',
];

/** The standalone assistant: saved threads on the left, the shared chat view on the right. */
export function ChatPage({ threadId, tree, open, refreshTree }: {
  threadId: number | null;
  tree: SubjectNode[];
  open: (r: Route) => void;
  /** Re-read subjects and notebooks; resolves with the new tree. */
  refreshTree: () => Promise<SubjectNode[]>;
}) {
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [removing, setRemoving] = useState<ChatThread | null>(null);
  const [clearing, setClearing] = useState<'one' | 'all' | null>(null);
  const [reload, setReload] = useState(0);
  const [control, setControl] = useState(() => { try { return localStorage.getItem('wa.chat.control') !== '0'; } catch { return true; } });
  useEffect(() => { try { localStorage.setItem('wa.chat.control', control ? '1' : '0'); } catch { /* ignore */ } }, [control]);

  // The assistant's tools read the latest tree, including changes made earlier in the same reply.
  const treeRef = useRef(tree);
  treeRef.current = tree;
  const tools = useMemo(() => appTools({
    tree: () => treeRef.current,
    refresh: async () => { const t = await refreshTree(); treeRef.current = t; return t; },
    open,
  }), [open, refreshTree]);
  const system = useCallback((python: boolean) => {
    const now = new Date();
    const today = `Today is ${now.toLocaleDateString('en-CA')} (${now.toLocaleDateString(undefined, { weekday: 'long' })}), local time ${now.toTimeString().slice(0, 5)}.`;
    return chatPrompt(python) + (control ? `\n\n${APP_POLICY}\n\n${today}` : '');
  }, [control]);

  // Empty chats (a new chat never sent, or one that was cleared) are dropped once
  // you are on another chat; the one on screen is always kept.
  const currentId = useRef(threadId);
  currentId.current = threadId;
  const reload_ = useCallback(() => {
    studyApi.chatList(null).then((ts) => setThreads(dropEmpty(ts, currentId.current))).catch(() => {});
  }, []);
  useEffect(() => { reload_(); }, [reload_, threadId]);

  const current = threads.find((t) => t.id === threadId) ?? null;
  const [filter, setFilter] = useState('');
  const [renaming, setRenaming] = useState<number | null>(null);
  const groups = useMemo(() => groupByDate(threads.filter((t) => !filter.trim() || t.title.toLowerCase().includes(filter.trim().toLowerCase()))), [threads, filter]);

  return (
    <div className="chatw">
      <aside className="chatw-list">
        <div className="pane-head">
          <span>Chats</span><span className="muted">{threads.length}</span>
          <span className="spacer" />
          <button type="button" className="icon-btn" onClick={() => open({ kind: 'chat', id: null })} title="New chat"><SquarePen /></button>
          <button type="button" className="icon-btn" disabled={!threads.length} onClick={() => setClearing('all')} title="Delete all chats"><Trash /></button>
        </div>
        <div className="thread-search">
          <Search />
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search chats" />
        </div>
        <ul className="thread-list">
          <li>
            <button type="button" className={`thread-row${threadId === null ? ' on' : ''}`} onClick={() => open({ kind: 'chat', id: null })}>
              <span className="thread-title with-icon"><SquarePen />New chat</span>
            </button>
          </li>
          {groups.map(([label, items]) => (
            <li key={label} className="thread-group">
              <div className="thread-group-label">{label}</div>
              <ul>
                {items.map((t) => (
                  <li key={t.id} className="thread-item">
                    {renaming === t.id ? (
                      <input
                        className="thread-rename"
                        autoFocus
                        defaultValue={t.title}
                        onFocus={(e) => e.currentTarget.select()}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') e.currentTarget.blur();
                          if (e.key === 'Escape') { e.currentTarget.value = t.title; e.currentTarget.blur(); }
                        }}
                        onBlur={async (e) => {
                          const title = e.currentTarget.value.trim();
                          setRenaming(null);
                          if (title && title !== t.title) { await studyApi.chatRename(t.id, title); reload_(); }
                        }}
                      />
                    ) : (
                      <button type="button" className={`thread-row${t.id === threadId ? ' on' : ''}`} onClick={() => open({ kind: 'chat', id: t.id })} onDoubleClick={() => setRenaming(t.id)}>
                        <span className="thread-title">{t.title || 'Untitled chat'}</span>
                        <span className="thread-meta muted">{relTime(new Date(t.updatedAt))} · {t.messageCount}</span>
                      </button>
                    )}
                    <span className="thread-tools">
                      <button type="button" className="task-x" onClick={() => setRenaming(t.id)} aria-label={`Rename ${t.title || 'chat'}`}><Pencil /></button>
                      <button type="button" className="task-x" onClick={() => setRemoving(t)} aria-label={`Delete ${t.title || 'chat'}`}><X /></button>
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
          {filter && !groups.length && <li className="muted small thread-none">No chats match “{filter}”.</li>}
        </ul>
      </aside>

      <section className="chatw-main">
        <ViewBar actions={<>
          <label className="switch" title="Let the assistant create notes, decks and quizzes, control the timer and open views when you ask it to">
            <input type="checkbox" checked={control} onChange={(e) => setControl(e.target.checked)} />
            <span className="switch-track"><span className="switch-thumb" /></span>
            <Bot /><span className="switch-text">App control</span>
          </label>
          <button type="button" className="icon-btn" disabled={!current?.messageCount} onClick={() => setClearing('one')} title="Clear this chat"><Eraser /></button>
        </>}>
          <span className="viewbar-name">{current?.title || 'New chat'}</span>
        </ViewBar>
        <ChatView
          threadId={threadId}
          notebookId={null}
          system={system}
          appTools={control ? tools : undefined}
          reloadToken={reload}
          emptyTitle="Ask anything"
          emptyHint={control
            ? 'Ask anything, attach files, or ask for graphs. With app control on it can also make notes, decks and quizzes, search your notebooks and run the focus timer, when you ask it to.'
            : 'Attach PDFs, images, CSVs or code. The assistant can run Python for maths, data and graphs. Everything is saved.'}
          placeholder="Message the assistant"
          suggestions={control ? CHAT_STARTERS_APP : CHAT_STARTERS}
          onThreadCreated={(t) => { reload_(); open({ kind: 'chat', id: t.id }); }}
          onChanged={reload_}
        />
      </section>

      {removing && (
        <ConfirmDialog title="Delete chat" confirmLabel="Delete chat" onClose={() => setRemoving(null)}
          onConfirm={async () => {
            await studyApi.chatDelete(removing.id);
            reload_();
            if (removing.id === threadId) open({ kind: 'chat', id: null });
          }}>
          Delete <b>{removing.title || 'this chat'}</b> with its messages, files and figures?
        </ConfirmDialog>
      )}
      {clearing && (
        <ConfirmDialog title={clearing === 'one' ? 'Clear chat' : 'Delete all chats'} confirmLabel={clearing === 'one' ? 'Clear chat' : 'Delete all'} onClose={() => setClearing(null)}
          onConfirm={async () => {
            if (clearing === 'one' && threadId) await studyApi.chatClear(threadId);
            if (clearing === 'all') { await studyApi.chatDeleteAll(null); open({ kind: 'chat', id: null }); }
            setReload((n) => n + 1);
            reload_();
          }}>
          {clearing === 'one' ? 'Remove every message in this chat? The chat itself stays.' : `Delete all ${threads.length} chats with their messages and files?`}
        </ConfirmDialog>
      )}
    </div>
  );
}

/** Chats under Today / Yesterday / Previous 7 days / Previous 30 days / month headings, newest first. */
function groupByDate(threads: ChatThread[]): [string, ChatThread[]][] {
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  const today = day.getTime();
  const label = (t: number) => {
    if (t >= today) return 'Today';
    if (t >= today - 864e5) return 'Yesterday';
    if (t >= today - 7 * 864e5) return 'Previous 7 days';
    if (t >= today - 30 * 864e5) return 'Previous 30 days';
    const d = new Date(t);
    return d.toLocaleDateString(undefined, { month: 'long', ...(d.getFullYear() !== day.getFullYear() ? { year: 'numeric' } : {}) });
  };
  const out: [string, ChatThread[]][] = [];
  for (const t of [...threads].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const l = label(t.updatedAt);
    if (out.length && out[out.length - 1][0] === l) out[out.length - 1][1].push(t); else out.push([l, [t]]);
  }
  return out;
}

