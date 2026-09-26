import { useState, type ReactNode } from 'react';
import { AlertTriangle, ArrowLeft, Check, ChevronRight, Layers, ListChecks, Loader2, Pencil, Play, Sparkles, Square, Trash, X } from 'lucide-react';
import { ContextMenu, MoreMenu, type MenuItem } from '../components/ContextMenu';
import { EmptyState, SectionHead } from '../components/Section';
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

export function SetsPane({ kind, rows, notebookId, fresh, onOpen, onPlay, onGenerate, onRename, onDelete, deleteText }: {
  kind: SetKind;
  rows: SetRow[];
  notebookId: number;
  fresh: Record<number, string>;
  onOpen: (id: number) => void;
  onPlay: (id: number) => void;
  onGenerate: () => void;
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
  const busy = pending.some((t) => !['failed', 'cancelled'].includes(t.state));

  const menuFor = (row: SetRow): MenuItem[] => [
    { kind: 'item', label: 'Open', icon: <ChevronRight />, onClick: () => onOpen(row.id) },
    { kind: 'item', label: 'Rename…', icon: <Pencil />, onClick: () => setRenaming(row) },
    { kind: 'sep' },
    { kind: 'item', label: `Delete ${w.set}…`, icon: <Trash />, danger: true, onClick: () => setRemoving(row) },
  ];

  return (
    <div className="section-page">
      <SectionHead
        title={kind === 'cards' ? 'Flashcards' : 'Quizzes'}
        blurb={kind === 'cards'
          ? 'Decks made from your sources. Flip through one to test yourself; the cards you miss are the ones to practise.'
          : 'Practice questions made from your sources, marked as you answer, with an explanation for each.'}
        actions={<>
          <button type="button" className="btn primary" onClick={onGenerate} disabled={busy} title={busy ? `Already writing a ${w.set}` : undefined}>
            <Sparkles />{kind === 'cards' ? 'Make flashcards' : 'Make a quiz'}
          </button>
        </>}
      />

      {!rows.length && !pending.length ? (
        <EmptyState
          icon={<Icon />}
          title={kind === 'cards' ? 'No flashcards yet' : 'No quizzes yet'}
          action={<button type="button" className="btn primary large" onClick={onGenerate}><Sparkles />{kind === 'cards' ? 'Make your first deck' : 'Make your first quiz'}</button>}
        >
          {kind === 'cards'
            ? 'Make a deck from your sources, a topic, or one of your chats. It follows your material page by page and is saved here to play as often as you like.'
            : 'Make a quiz from your sources, a topic, or one of your chats. Every question is marked with an explanation, and you can retry the ones you missed.'}
        </EmptyState>
      ) : (
        <ul className="set-grid stagger">
          {pending.map((task, i) => {
            const failed = task.state === 'failed';
            const over = failed || task.state === 'cancelled';
            return (
              <li key={task.id} className={`set-card pending ${task.state}`} style={{ '--i': i } as React.CSSProperties}>
                <button type="button" className="set-card-main" onClick={() => setWatching(task.id)} title="See what it is doing">
                  <span className="set-card-icon">{over ? <X /> : <Loader2 className="spin" />}</span>
                  <span className="set-card-title">{failed ? `Could not make the ${w.set}` : task.state === 'cancelled' ? 'Stopped - nothing was saved' : `Making a ${w.set}…`}</span>
                  <span className="set-card-meta">{task.error ?? (task.detail || 'Starting…')}</span>
                </button>
                <div className="set-card-foot">
                  {task.cost > 0 && <span className="set-cost" title="What it has cost so far">{formatCost(task.cost)}</span>}
                  <span className="spacer" />
                  {over ? (
                    <button type="button" className="btn small ghost" onClick={() => dismissTask(task.id)}>Dismiss</button>
                  ) : (
                    <button type="button" className="btn small ghost danger" onClick={() => stopTask(task.id)} title={`Stop making this ${w.set} - nothing is saved`}><Square />Stop</button>
                  )}
                </div>
              </li>
            );
          })}
          {rows.map((row, i) => {
            const isNew = row.id in fresh;
            const warning = fresh[row.id];
            const best = row.best === null ? null : Math.round(row.best * 100);
            return (
              <li key={row.id} style={{ '--i': i + pending.length } as React.CSSProperties} className={`set-card${isNew ? ' fresh' : ''}`}
                onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, row }); }}>
                <button type="button" className="set-card-main" onClick={() => onOpen(row.id)}>
                  <span className="set-card-top">
                    <span className="set-card-icon"><Icon /></span>
                    {isNew && <span className="set-new">New</span>}
                    {row.extra && <span className="set-card-extra">{row.extra}</span>}
                  </span>
                  <span className="set-card-title">{row.title}</span>
                  <span className="set-card-meta">
                    {plural(row.count, w.item, w.items)}
                    {made(row.id) !== null && <span title={`What making this ${w.set} cost`}> · {formatCost(made(row.id))}</span>}
                  </span>
                  {warning && <span className="set-warn" title={warning}><AlertTriangle />{warning}</span>}
                </button>
                <div className="set-card-score" title={row.runs ? `Best ${pct(row.best)}, last ${pct(row.last)}` : undefined}>
                  <span className="set-score-track"><i style={{ width: `${best ?? 0}%` }} /></span>
                  <span className="set-score-text">
                    {row.runs ? <>Best <b>{pct(row.best)}</b> · last {pct(row.last)}</> : kind === 'cards' ? 'Not played yet' : 'Not taken yet'}
                  </span>
                </div>
                <div className="set-card-foot">
                  <button type="button" className="btn small primary" onClick={() => onPlay(row.id)} disabled={!row.count}>
                    <Play />{row.extra ? 'Continue' : kind === 'cards' ? 'Play' : 'Start'}
                  </button>
                  <button type="button" className="btn small ghost" onClick={() => onOpen(row.id)}>{kind === 'cards' ? 'See cards' : 'See questions'}</button>
                  <span className="spacer" />
                  <MoreMenu items={menuFor(row)} title={`More for ${row.title}`} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
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

export function SetPage({ kind, id, title, count, best, last, runs, chat, from, actions, listAside, onBack, onRename, onDelete, deleteText, children, empty, dialogs }: {
  kind: SetKind;
  id: number;
  title: string;
  count: number;
  best: number | null;
  last: number | null;
  runs: number;
  chat: ReactNode;
  /** What the set was made from, under its name. */
  from?: ReactNode;
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
  const Icon = w.icon;
  return (
    <div className="stage set-page">
      <div className="set-page-top" data-tauri-drag-region="deep">
        <button type="button" className="btn ghost small" onClick={onBack}><ArrowLeft />{kind === 'cards' ? 'All flashcards' : 'All quizzes'}</button>
        <span className="spacer" />
        {chat}
        <MoreMenu title={`${w.Set} options`} items={[
          { kind: 'item', label: 'Rename…', icon: <Pencil />, onClick: () => setRenaming(true) },
          { kind: 'sep' },
          { kind: 'item', label: `Delete ${w.set}…`, icon: <Trash />, danger: true, onClick: () => setRemoving(true) },
        ]} />
      </div>
      <div className="set-body">
        <header className="set-hero">
          <span className="set-card-icon big"><Icon /></span>
          <div className="set-hero-text">
            <h1 className="h-display">{title}</h1>
            <p>
              {plural(count, w.item, w.items)} · {runs ? plural(runs, w.run, w.runs) : kind === 'cards' ? 'not played yet' : 'not taken yet'}
              {made !== null && <span title={`What making this ${w.set} cost`}> · made for {formatCost(made)}</span>}
            </p>
            {from}
          </div>
          {runs > 0 && (
            <div className="set-scores">
              <div><span className="set-num">{pct(best)}</span><span>best</span></div>
              <div><span className="set-num">{pct(last)}</span><span>last time</span></div>
            </div>
          )}
        </header>
        <div className="set-actions">{actions}</div>
        <div className="set-list-head">
          <h2 className="section-title">{w.items[0].toUpperCase() + w.items.slice(1)} <span className="muted">{count}</span></h2>
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

/**
 * The bar across the top of a deck being played or a quiz being taken: what this is, where you
 * are, and the way out in the far corner, where it stays clear of the window's own controls.
 */
export function PlayerBar({ title, sub, onClose, children }: { title: string; sub: ReactNode; onClose: () => void; children?: ReactNode }) {
  return (
    <header className="player-bar" data-tauri-drag-region="deep">
      <div className="player-title">
        <span className="player-name">{title}</span>
        <span className="player-sub">{sub}</span>
      </div>
      <div className="player-tools">
        {children}
        <button type="button" className="icon-btn player-exit" onClick={onClose} title="Close (Esc) - your progress is kept" aria-label="Close"><X /></button>
      </div>
    </header>
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
