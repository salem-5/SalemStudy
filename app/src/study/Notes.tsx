import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft, ArrowUpRight, Check, FileDown, Loader2, Maximize2, Minimize2, NotebookPen, Pencil, Sparkles, Square, Trash, Wand2, X,
} from 'lucide-react';
import { api, errorText } from '../api';
import { ContextMenu, MoreMenu, type MenuItem } from '../components/ContextMenu';
import { EmptyState, SectionHead } from '../components/Section';
import { Markdown } from '../lib/markdown';
import { markdownToPrintHtml } from '../lib/mdPrint';
import { refineNote, stopNote, useNoteJobs } from '../lib/notesGen';
import { formatCost, recalledCost } from '../lib/meter';
import { relTime } from '../lib/format';
import { restoreWhenReady, loadPosition, tagAnchors, watch } from '../lib/scrollMemory';
import { NOTE_PRESETS } from '../lib/prompts';
import { studyApi, type Note } from './api';
import { AskableArea, ChatButton, noteBriefing } from './StudyChat';
import { ConfirmDialog, NameDialog } from './dialogs';

/** The preset a note was written with, as its short name, or nothing for custom instructions. */
const presetOf = (instructions: string | null | undefined) => NOTE_PRESETS.find((p) => p.text === instructions?.trim())?.label ?? null;

export function NotesPane({ notes, onOpen, onGenerate, onChanged }: {
  notes: Note[];
  onOpen: (n: Note) => void;
  onGenerate: () => void;
  onChanged: () => void;
}) {
  const jobs = useNoteJobs();
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [renaming, setRenaming] = useState<Note | null>(null);
  const [removing, setRemoving] = useState<Note | null>(null);
  const menuFor = (n: Note): MenuItem[] => [
    { kind: 'item', label: 'Open', icon: <ArrowUpRight />, onClick: () => onOpen(n) },
    { kind: 'item', label: 'Rename…', icon: <Pencil />, onClick: () => setRenaming(n) },
    { kind: 'sep' },
    { kind: 'item', label: 'Delete note…', icon: <Trash />, danger: true, onClick: () => setRemoving(n) },
  ];
  return (
    <div className="section-page">
      <SectionHead
        title="Notes"
        blurb="Study notes for this notebook - written for you from your sources in the style you ask for, or written yourself."
        actions={<>
          <button type="button" className="btn primary" onClick={onGenerate}><Sparkles />Write notes</button>
        </>}
      />
      {!notes.length ? (
        <EmptyState icon={<NotebookPen />} title="No notes yet"
          action={<button type="button" className="btn primary large" onClick={onGenerate}><Sparkles />Write notes from my sources</button>}>
          Have study notes, a summary, a cheat sheet or a formula sheet written from your sources, a topic or one of your chats.
        </EmptyState>
      ) : (
        <ul className="note-grid stagger">
          {notes.map((n, i) => (
            <li key={n.id} className="note-card" style={{ '--i': i } as React.CSSProperties}
              onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, items: menuFor(n) }); }}>
              <button type="button" className="note-card-main" onClick={() => onOpen(n)}>
                <span className="note-card-top">
                  <span className="set-card-icon">{jobs.has(n.id) ? <Loader2 className="spin" /> : <NotebookPen />}</span>
                  {presetOf(n.instructions) && <span className="note-card-kind">{presetOf(n.instructions)}</span>}
                </span>
                <span className="note-card-title">{n.title}</span>
                <span className="note-card-meta">{jobs.has(n.id) ? 'Writing…' : `Edited ${relTime(new Date(n.updatedAt))}`}</span>
              </button>
              <MoreMenu items={menuFor(n)} title={`More for ${n.title}`} className="note-card-more" />
            </li>
          ))}
        </ul>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {renaming && (
        <NameDialog title="Rename note" label="Title" initial={renaming.title} submitLabel="Save" onClose={() => setRenaming(null)}
          onSubmit={async (title) => { await studyApi.updateNote(renaming.id, { title }); onChanged(); }} />
      )}
      {removing && (
        <ConfirmDialog title="Delete note" confirmLabel="Delete note" onClose={() => setRemoving(null)}
          onConfirm={async () => { await studyApi.deleteNote(removing.id); onChanged(); }}>
          Delete <b>{removing.title}</b>?
        </ConfirmDialog>
      )}
    </div>
  );
}

const REFINE_PRESETS = ['Make it shorter', 'Add more worked examples', 'Add a summary table', 'Simpler language', 'Add common mistakes', 'Turn it into a cheat sheet'];

async function exportPdf(note: Note): Promise<string> {
  const html = markdownToPrintHtml(note.content);
  const res = await api.exportPdf(note.title, html, [], '', note.title);
  if (!res.pdf) throw new Error('No PDF was produced.');
  await api.openPath(res.pdf).catch(() => {});
  return res.pdf;
}

export function NoteView({ noteId, notebookId, onBack, onChanged }: { noteId: number; notebookId: number; onBack: () => void; onChanged: () => void }) {
  const jobs = useNoteJobs();
  const job = jobs.get(noteId);
  const written = recalledCost('note', noteId);
  const [note, setNote] = useState<Note | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [fullscreen, setFullscreen] = useState(false);
  const [refining, setRefining] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [status, setStatus] = useState<{ kind: 'ok' | 'err' | 'busy'; text: string } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const saveTimer = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const paperRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const scroller = scrollRef.current;
    const paper = paperRef.current;
    if (!scroller || !paper || !draft) return;
    tagAnchors(paper);
    const key = `note-${noteId}`;
    const saved = loadPosition(key);
    const stop = saved && !job ? restoreWhenReady(scroller, saved) : () => {};
    const unwatch = watch(scroller, key);
    return () => { stop(); unwatch(); };
  }, [noteId, draft, job, editing, fullscreen]);

  const load = () => studyApi.note(noteId).then((n) => { setNote(n); setDraft(n.content); }).catch(() => setNote(null));
  const writing = !!job;
  useEffect(() => { void load(); }, [noteId, writing]);

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); setFullscreen(false); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [fullscreen]);

  const edit = (text: string) => {
    setDraft(text);
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      const n = await studyApi.updateNote(noteId, { content: text }).catch(() => null);
      if (n) { setNote(n); onChanged(); }
    }, 700);
  };
  useEffect(() => () => { if (saveTimer.current) window.clearTimeout(saveTimer.current); }, []);

  const refine = async (text: string) => {
    if (!note || !text.trim()) return;
    setRefining(false);
    setInstruction('');
    setEditing(false);
    try { const n = await refineNote(note, text); setNote(n); setDraft(n.content); onChanged(); }
    catch (e) { setStatus({ kind: 'err', text: e instanceof Error ? e.message : String(e) }); }
  };

  const doExport = async () => {
    if (!note) return;
    setStatus({ kind: 'busy', text: 'Typesetting the PDF…' });
    try { const path = await exportPdf({ ...note, content: draft }); setStatus({ kind: 'ok', text: `Saved ${path.split(/[\\/]/).pop()} in Documents` }); }
    catch (e) { setStatus({ kind: 'err', text: `Export failed: ${errorText(e)}` }); }
  };

  if (!note) return <div className="stage"><div className="pane-empty center"><Loader2 className="spin" /></div></div>;
  const body = job ? job.text : draft;

  const toolbar = (
    <>
      {job ? (
        <button type="button" className="btn" onClick={() => stopNote(noteId)}><Square />Stop</button>
      ) : (
        <>
          <button type="button" className={`btn ghost${editing ? ' on' : ''}`} onClick={() => setEditing((e) => !e)} title="Edit the Markdown">
            {editing ? <><Check /><span className="btn-label">Done</span></> : <><Pencil /><span className="btn-label">Edit</span></>}
          </button>
          <button type="button" className="btn ghost" onClick={() => setRefining((r) => !r)} title="Rewrite with an instruction"><Wand2 /><span className="btn-label">Rewrite</span></button>
          <button type="button" className="btn ghost" onClick={doExport} disabled={status?.kind === 'busy' || !draft.trim()} title="Export as PDF"><FileDown /><span className="btn-label">PDF</span></button>
        </>
      )}
      <ChatButton
        notebookId={notebookId}
        where={note?.title || 'this note'}
        tag={note?.title || 'note'}
        briefing={noteBriefing(note?.title ?? '', draft)}
      />
      <button type="button" className="icon-btn ghost-icon" onClick={() => setFullscreen((f) => !f)} title={fullscreen ? 'Exit full screen (Esc)' : 'Full screen'}>
        {fullscreen ? <Minimize2 /> : <Maximize2 />}
      </button>
    </>
  );

  const content = (
    <>
      <div className={`collapse${refining && !job ? ' open' : ''}`}>
        <div>
          <form className="refine-bar" onSubmit={(e) => { e.preventDefault(); void refine(instruction); }}>
            <input className="field-input" value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="How should the notes change? e.g. add an example for each test" autoFocus={refining} />
            <button type="submit" className="btn primary" disabled={!instruction.trim()}><Wand2 />Rewrite</button>
            <div className="chips">
              {REFINE_PRESETS.map((p) => <button type="button" key={p} className="chip-btn" onClick={() => void refine(p)}>{p}</button>)}
            </div>
          </form>
        </div>
      </div>
      {status && (
        <div className={`note-status ${status.kind}`}>
          {status.kind === 'busy' ? <Loader2 className="spin" /> : status.kind === 'ok' ? <Check /> : <X />}
          <span>{status.text}</span>
          {status.kind !== 'busy' && <button type="button" className="link" onClick={() => setStatus(null)}>dismiss</button>}
        </div>
      )}
      {editing && !job ? (
        <div className="note-edit">
          <textarea className="note-source" value={draft} onChange={(e) => edit(e.target.value)} spellCheck={false} autoFocus />
          <div className="note-paper"><Markdown text={draft} /></div>
        </div>
      ) : (
        <AskableArea
          className="note-askable"
          notebookId={notebookId}
          title={note?.title || 'This note'}
          briefing={noteBriefing(note?.title ?? '', draft)}
          target={{
            kind: 'note',
            label: note?.title || 'Note',
            detail: 'your note',
            locator: { notebookId, noteId },
          }}
        >
          <div ref={scrollRef} className="note-scroll">
            <article className={`note-paper${job ? ' writing' : ''}`} ref={paperRef}>
              {body ? <Markdown text={body} /> : <p className="muted">{job ? 'Starting…' : 'Empty note. Press Edit to write, or Rewrite to have it written.'}</p>}
              {job && <span className="caret" />}
            </article>
          </div>
        </AskableArea>
      )}
    </>
  );

  return (
    <>
      <div className="stage note-view">
        <div className="stage-head" data-tauri-drag-region="deep">
          <button type="button" className="btn ghost small" onClick={onBack}><ArrowLeft />All notes</button>
          <button type="button" className="stage-title as-button" onClick={() => setRenaming(true)} title="Rename">{note.title}</button>
          {job && <span className="muted small"><Loader2 className="spin" /> writing{job.cost > 0 ? ` · ${formatCost(job.cost)}` : ''}</span>}
          {!job && written !== null && <span className="note-cost muted small" title="What having this note written cost">{formatCost(written)}</span>}
          <span className="spacer" />
          {toolbar}
          <button type="button" className="icon-btn ghost-icon danger" onClick={() => setRemoving(true)} title="Delete note" disabled={!!job}><Trash /></button>
        </div>
        {!fullscreen && content}
      </div>
      {fullscreen && (
        <div className="note-fullscreen">
          <div className="note-fullscreen-bar">
            <span className="stage-title">{note.title}</span>
            <span className="spacer" />
            {toolbar}
          </div>
          {content}
        </div>
      )}
      {renaming && (
        <NameDialog title="Rename note" label="Title" initial={note.title} submitLabel="Save" onClose={() => setRenaming(false)}
          onSubmit={async (title) => { setNote(await studyApi.updateNote(noteId, { title })); onChanged(); }} />
      )}
      {removing && (
        <ConfirmDialog title="Delete note" confirmLabel="Delete note" onClose={() => setRemoving(false)}
          onConfirm={async () => { await studyApi.deleteNote(noteId); onChanged(); onBack(); }}>
          Delete <b>{note.title}</b>?
        </ConfirmDialog>
      )}
    </>
  );
}
