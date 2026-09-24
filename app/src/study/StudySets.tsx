import { useState, type ReactNode } from 'react';
import { AlertTriangle, ArrowLeft, Check, ChevronRight, Layers, ListChecks, Loader2, MoreHorizontal, Pencil, Play, Plus, Sparkles, Square, Trash, X } from 'lucide-react';
import { ContextMenu, type MenuItem } from '../components/ContextMenu';
import { TaskProgress } from '../components/TaskProgress';
import { dismissTask, holderOf, runInBackground, stopTask, useTasks } from '../lib/salem/tasks';
import { ConfirmDialog, NameDialog } from './dialogs';
import { formatCost, recalledCost, rememberCost, type Meter } from '../lib/meter';
import type { Stop } from '../lib/cancel.ts';

export type SetKind = 'cards' | 'quiz';

const WORDS = {
  cards: { set: 'deck', Set: 'Deck', item: 'card', items: 'cards', run: 'play', runs: 'plays', play: 'Play deck', icon: Layers, tab: 'Cards' },
  quiz: { set: 'quiz', Set: 'Quiz', item: 'question', items: 'questions', run: 'attempt', runs: 'attempts', play: 'Start quiz', icon: ListChecks, tab: 'Quizzes' },
} as const;

export const setWords = (kind: SetKind) => WORDS[kind];

export const setScope = (kind: SetKind, notebookId: number) => `notebook:${notebookId}:${kind === 'cards' ? 'decks' : 'quizzes'}`;

const pct = (v: number | null) => (v === null ? '–' : `${Math.round(v * 100)}%`);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function startSet(
  kind: SetKind,
  notebook: { id: number; name: string },
  walking: boolean,
  make: (progress: (text: string) => void, meter: Meter, stop: Stop) => Promise<{ id: number; note: string }>,
  done: (id: number, note: string, cost: number) => void,
): void {
  const scope = setScope(kind, notebook.id);
  const busy = holderOf(scope);
  if (busy) throw new Error(`Already ${busy.label.toLowerCase()}. Wait for that to finish first.`);
  const w = WORDS[kind];
  let spent: Meter | null = null;
  void runInBackground(
    { label: `Writing a ${w.set} for ${notebook.name}${walking ? ', page by page' : ''}`, scope },
    (progress, meter, stop) => { spent = meter; return make(progress, meter, stop); },
  ).then(({ id, note }) => {
    const cost = spent?.total ?? 0;
    rememberCost(kind === 'cards' ? 'deck' : 'quiz', id, cost);
    done(id, note, cost);
  }).catch(() => {});
}

export function useSetBusy(kind: SetKind, notebookId: number): boolean {
  const scope = setScope(kind, notebookId);
  return useTasks().some((t) => t.scope === scope && !['completed', 'failed', 'cancelled'].includes(t.state));
}

export type SetRow = {
  id: number;
  title: string;
  count: number;
  runs: number;
  best: number | null;
  last: number | null;
  extra?: string;
};

export function SetsPane({ kind, rows, notebookId, fresh, onOpen, onPlay, onGenerate, onNew, onRename, onDelete, deleteText }: {
  kind: SetKind;
  rows: SetRow[];
  notebookId: number;
  fresh: Record<number, string>;
  onOpen: (id: number) => void;
  onPlay: (id: number) => void;
  onGenerate: () => void;
  onNew?: () => void;
  onRename: (id: number, title: string) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  deleteText: (row: SetRow) => ReactNode;
}) {
  const w = WORDS[kind];
  const scope = setScope(kind, notebookId);
  const pending = useTasks().filter((t) => t.scope === scope && t.state !== 'completed');
  const [watching, setWatching] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; row: SetRow } | null>(null);
  const [renaming, setRenaming] = useState<SetRow | null>(null);
  const [removing, setRemoving] = useState<SetRow | null>(null);
  const watchedTask = pending.find((t) => t.id === watching) ?? null;
  const Icon = w.icon;
  const made = (id: number) => recalledCost(kind === 'cards' ? 'deck' : 'quiz', id);

  const menuFor = (row: SetRow): MenuItem[] => [
    { kind: 'item', label: row.extra ? 'Carry on' : kind === 'cards' ? 'Play' : 'Start', onClick: () => onPlay(row.id), disabled: !row.count },
    { kind: 'item', label: 'Open', onClick: () => onOpen(row.id) },
    { kind: 'item', label: 'Rename…', onClick: () => setRenaming(row) },
    { kind: 'sep' },
    { kind: 'item', label: `Delete ${w.set}`, danger: true, onClick: () => setRemoving(row) },
  ];

  return (
    <div className="pane-body">
      <div className="pane-actions">
        <button type="button" className="btn primary" onClick={onGenerate}><Sparkles />Generate {w.set}</button>
        {onNew && <button type="button" className="btn ghost" onClick={onNew} title={`An empty ${w.set} you fill yourself`}><Plus />New</button>}
      </div>
      {!rows.length && !pending.length && (
        <p className="muted small pane-note">
          No {w.set === 'quiz' ? 'quizzes' : 'decks'} yet. Generate one from your sources, a topic or a chat — it follows your material page by page, and is saved here to {w.run} as often as you like.
        </p>
      )}
      <ul className="set-list stagger">
        {pending.map((task) => {
          const failed = task.state === 'failed';
          const over = failed || task.state === 'cancelled';
          return (
            <li key={task.id} className={`set-item pending ${task.state}`}>
              <button type="button" className="set-main" onClick={() => setWatching(task.id)} title="See what it is doing">
                <span className="set-icon">{over ? <X /> : <Loader2 className="spin" />}</span>
                <span className="set-text">
                  <span className="set-title">{failed ? `Could not write the ${w.set}` : task.state === 'cancelled' ? `Stopped — nothing was saved` : `Writing a ${w.set}…`}</span>
                  <span className="set-meta">
                    {task.cost > 0 && <span className="set-cost" title="What it has cost so far">{formatCost(task.cost)}</span>}
                    {task.error ?? (task.detail || 'Starting…')}
                  </span>
                </span>
                <ChevronRight className="set-go" aria-hidden />
              </button>
              {over ? (
                <button type="button" className="icon-btn ghost-icon" onClick={() => dismissTask(task.id)} title="Dismiss" aria-label="Dismiss"><X /></button>
              ) : (
                <button type="button" className="btn ghost small set-stop" onClick={() => stopTask(task.id)}
                  title={`Stop writing this ${w.set} — nothing is saved`}><Square />Stop</button>
              )}
            </li>
          );
        })}
        {rows.map((row, i) => {
          const isNew = row.id in fresh;
          const warning = fresh[row.id];
          return (
            <li key={row.id} style={{ '--i': i } as React.CSSProperties} className={`set-item${isNew ? ' fresh' : ''}`}
              onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, row }); }}>
              <button type="button" className="set-main" onClick={() => onOpen(row.id)}>
                <span className="set-icon"><Icon /></span>
                <span className="set-text">
                  <span className="set-title">{row.title}{isNew && <span className="set-new">new</span>}</span>
                  <span className="set-meta">
                    {plural(row.count, w.item, w.items)} · {row.runs ? `best ${pct(row.best)} · last ${pct(row.last)}` : kind === 'cards' ? 'not played yet' : 'not taken yet'}
                    {row.extra ? ` · ${row.extra}` : ''}
                    {made(row.id) !== null && <span title={`What writing this ${w.set} cost`}> · {formatCost(made(row.id))}</span>}
                  </span>
                  {warning && <span className="set-warn" title={warning}><AlertTriangle />{warning}</span>}
                </span>
              </button>
              <button type="button" className="icon-btn set-play" onClick={() => onPlay(row.id)} disabled={!row.count}
                title={row.extra ? 'Carry on' : w.play}><Play /></button>
              <button type="button" className="icon-btn ghost-icon" onClick={(e) => setMenu({ x: e.clientX, y: e.clientY, row })} title="More"><MoreHorizontal /></button>
            </li>
          );
        })}
      </ul>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuFor(menu.row)} onClose={() => setMenu(null)} />}
      {watchedTask && <TaskProgress task={watchedTask} onClose={() => setWatching(null)} />}
      {renaming && (
        <NameDialog title={`Rename ${w.set}`} label="Name" initial={renaming.title} submitLabel="Save" onClose={() => setRenaming(null)}
          onSubmit={(name) => onRename(renaming.id, name)} />
      )}
      {removing && (
        <ConfirmDialog title={`Delete ${w.set}`} confirmLabel={`Delete ${w.set}`} onClose={() => setRemoving(null)}
          onConfirm={() => onDelete(removing.id)}>
          {deleteText(removing)}
        </ConfirmDialog>
      )}
    </div>
  );
}

export function SetPage({ kind, id, title, count, best, last, runs, chat, actions, listAside, onBack, onRename, onDelete, deleteText, children, empty, dialogs }: {
  kind: SetKind;
  id: number;
  title: string;
  count: number;
  best: number | null;
  last: number | null;
  runs: number;
  chat: ReactNode;
  actions: ReactNode;
  listAside?: ReactNode;
  onBack: () => void;
  onRename: (title: string) => Promise<void>;
  onDelete: () => Promise<void>;
  deleteText: ReactNode;
  children: ReactNode;
  empty?: ReactNode;
  dialogs?: ReactNode;
}) {
  const w = WORDS[kind];
  const made = recalledCost(kind === 'cards' ? 'deck' : 'quiz', id);
  const [renaming, setRenaming] = useState(false);
  const [removing, setRemoving] = useState(false);
  return (
    <div className="stage set-page">
      <div className="stage-head">
        <button type="button" className="link" onClick={onBack}><ArrowLeft />back</button>
        <span className="stage-title">{title}</span>
        <button type="button" className="icon-btn ghost-icon" onClick={() => setRenaming(true)} title="Rename"><Pencil /></button>
        <span className="spacer" />
        {chat}
        <button type="button" className="icon-btn ghost-icon danger" onClick={() => setRemoving(true)} title={`Delete ${w.set}`}><Trash /></button>
      </div>
      <div className="set-body">
        <div className="set-hero">
          <div className="set-scores">
            <div><span className="set-num">{count}</span><span className="muted">{w.items}</span></div>
            <div><span className="set-num">{pct(best)}</span><span className="muted">best</span></div>
            <div><span className="set-num">{pct(last)}</span><span className="muted">last · {plural(runs, w.run, w.runs)}</span></div>
            {made !== null && <div title={`What writing this ${w.set} cost`}><span className="set-num">{formatCost(made)}</span><span className="muted">to make</span></div>}
          </div>
          <div className="set-actions">{actions}</div>
        </div>
        <div className="set-list-head">
          <span className="panel-title">{w.items[0].toUpperCase() + w.items.slice(1)}</span>
          <span className="spacer" />
          {listAside}
        </div>
        {empty ?? <ul className="set-items stagger">{children}</ul>}
      </div>
      {dialogs}
      {renaming && (
        <NameDialog title={`Rename ${w.set}`} label="Name" initial={title} submitLabel="Save" onClose={() => setRenaming(false)}
          onSubmit={onRename} />
      )}
      {removing && (
        <ConfirmDialog title={`Delete ${w.set}`} confirmLabel={`Delete ${w.set}`} onClose={() => setRemoving(false)} onConfirm={onDelete}>
          {deleteText}
        </ConfirmDialog>
      )}
    </div>
  );
}

export function SetItem({ n, result, onOpen, side, children, index }: {
  n: number;
  result: boolean | null | undefined;
  onOpen: () => void;
  side?: ReactNode;
  children: ReactNode;
  index: number;
}) {
  return (
    <li className="set-entry" style={{ '--i': index } as React.CSSProperties}>
      <span className="set-entry-n mono">{n}</span>
      <div role="button" tabIndex={0} className="set-entry-main" onClick={onOpen}
        onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }} title="Edit">
        {children}
      </div>
      <span className={`set-entry-stat${result === false ? ' bad' : result ? ' good' : ''}`}
        title={result === undefined || result === null ? 'Not answered yet' : result ? 'Right last time' : 'Wrong last time'}>
        {result === false ? <X /> : result ? <Check /> : null}
      </span>
      {side && <div className="set-entry-side">{side}</div>}
    </li>
  );
}
