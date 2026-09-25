import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle, BookOpen, ChevronDown, ExternalLink, File, FileText, Image as ImageIcon, Library, Loader2, MonitorPlay, Pencil,
  Plus, Presentation, RotateCw, Trash, Upload, X,
} from 'lucide-react';
import { ACCEPT, addFiles, addPastedText, addYoutube, ingest, labelSeconds, pastedFile, useIngestJobs } from '../lib/ingest';
import { htmlToMarkdown } from '../lib/pad';
import { Markdown } from '../lib/markdown';
import { ContextMenu, MoreMenu, type MenuItem } from '../components/ContextMenu';
import { SectionHead } from '../components/Section';
import { relTime } from '../lib/format';
import { studyApi, type Source, type SourceImage, type SourceKind, type SourceUnit } from './api';
import { NameDialog, ConfirmDialog } from './dialogs';
import { keys } from '../lib/keys';

export const KindIcon = ({ kind }: { kind: SourceKind }) => {
  const Icon = kind === 'pdf' ? FileText : kind === 'slides' ? Presentation : kind === 'image' ? ImageIcon : kind === 'youtube' ? MonitorPlay : kind === 'text' ? FileText : File;
  return <Icon className={`kind-icon ${kind}`} />;
};

const unitWord = (s: Source) => (s.kind === 'pdf' ? 'page' : s.kind === 'slides' ? 'slide' : s.kind === 'youtube' ? 'part' : 'section');

function readingTrouble(s: Source): string | null {
  const r = s.report;
  if (!r) return null;
  const notes: string[] = [];
  if (r.empty.length) {
    const where = r.empty.slice(0, 3).join(', ');
    notes.push(`${r.empty.length} empty page${r.empty.length === 1 ? '' : 's'} (${where}${r.empty.length > 3 ? '…' : ''})`);
  }
  if (r.duplicated.length) notes.push(`${r.duplicated.length} repeated`);
  if (r.skipped) notes.push(`${r.skipped} figure page${r.skipped === 1 ? '' : 's'} not read`);
  return notes.length ? notes.join(' · ') : null;
}

const ago = (t: number) => relTime(new Date(t));

export function SourcesLibrary({ notebookId, sources, selected, onToggle, onToggleAll, onOpen, onChanged }: {
  notebookId: number;
  sources: Source[];
  selected: Set<number>;
  onToggle: (id: number) => void;
  onToggleAll: (on: boolean) => void;
  onOpen: (s: Source) => void;
  onChanged: () => void;
}) {
  const jobs = useIngestJobs();
  const fileInput = useRef<HTMLInputElement>(null);
  const [link, setLink] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const [drag, setDrag] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [renaming, setRenaming] = useState<Source | null>(null);
  const [removing, setRemoving] = useState<Source | null>(null);

  const upload = async (files: File[]) => {
    if (!files.length) return;
    setProblems(await addFiles(notebookId, files, onChanged));
  };
  // Pasting: files and images are added as they are; text becomes a Markdown file of its own,
  // keeping the headings and lists of whatever it was copied from; a YouTube link is a video.
  const paste = useCallback(async (files: File[], text: string, html: string) => {
    if (files.length) {
      const named = files.map((f) => pastedFile(f));
      const plain = named.filter((n) => !n.generic).map((n) => n.file);
      const generic = named.filter((n) => n.generic).map((n) => n.file);
      const found = [
        ...(plain.length ? await addFiles(notebookId, plain, onChanged) : []),
        ...(generic.length ? await addFiles(notebookId, generic, onChanged, { nameFromContent: true }) : []),
      ];
      setProblems(found);
      return;
    }
    const t = text.trim();
    if (/^https?:\/\/\S*youtu\S*$/i.test(t)) { void addYoutube(notebookId, t, onChanged); return; }
    const rich = html ? htmlToMarkdown(html).replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\n{3,}/g, '\n\n').trim() : '';
    const body = rich.length >= t.length * 0.6 ? rich : t;
    if (body) setProblems(await addPastedText(notebookId, body, onChanged));
  }, [notebookId, onChanged]);

  useEffect(() => {
    // Only a paste aimed at the page itself: not one into a field here or in an open dialog.
    const ours = (e: Event) => !(e.target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable="true"]')
      && !document.querySelector('.modal-backdrop');
    // WebKit greys out Paste when nothing editable has focus, unless the page says it will take it.
    const allow = (e: Event) => { if (ours(e)) e.preventDefault(); };
    const onPaste = (e: ClipboardEvent) => {
      if (!ours(e) || !e.clipboardData) return;
      const files = [...e.clipboardData.files];
      const text = e.clipboardData.getData('text/plain');
      if (!files.length && !text.trim()) return;
      e.preventDefault();
      void paste(files, text, e.clipboardData.getData('text/html'));
    };
    document.addEventListener('beforepaste', allow);
    document.addEventListener('paste', onPaste);
    return () => { document.removeEventListener('beforepaste', allow); document.removeEventListener('paste', onPaste); };
  }, [paste]);

  const addLink = () => {
    if (!/youtu/.test(link)) return;
    void addYoutube(notebookId, link, onChanged);
    setLink('');
  };

  const menuFor = (s: Source): MenuItem[] => [
    { kind: 'item', label: 'Open', icon: <BookOpen />, onClick: () => onOpen(s) },
    { kind: 'item', label: 'Rename…', icon: <Pencil />, onClick: () => setRenaming(s) },
    ...(!jobs.has(s.id) ? [{ kind: 'item' as const, label: 'Read it again', icon: <RotateCw />, onClick: () => void ingest(s).then(onChanged) }] : []),
    { kind: 'sep' },
    { kind: 'item', label: 'Delete source…', icon: <Trash />, danger: true, onClick: () => setRemoving(s) },
  ];

  const ready = sources.filter((s) => s.status === 'ready');
  const used = ready.filter((s) => selected.has(s.id)).length;
  const allOn = ready.length > 0 && used === ready.length;

  return (
    <div
      className={`section-page sources-page${drag ? ' dragging' : ''}`}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDrag(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrag(false); }}
      onDrop={(e) => { e.preventDefault(); setDrag(false); void upload([...e.dataTransfer.files]); }}
    >
      <SectionHead
        title="Sources"
        blurb="Your course material. Chat, flashcards, quizzes and notes use the ticked sources, and say which page each point came from."
        actions={<button type="button" className="btn primary" onClick={() => fileInput.current?.click()}><Upload />Add files</button>}
      />
      <input ref={fileInput} type="file" multiple accept={ACCEPT} hidden onChange={(e) => { void upload([...(e.target.files ?? [])]); e.target.value = ''; }} />

      <div className={`source-drop${sources.length ? '' : ' big'}`}>
        <button type="button" className="source-drop-main" onClick={() => fileInput.current?.click()}>
          <span className="source-drop-icon"><Upload /></span>
          <span className="source-drop-text">
            <b>{sources.length ? 'Add more material' : 'Add your course material'}</b>
            <span>Drop lecture PDFs, slides, Word files or photos here, click to choose them, or paste text, images and files with {keys('⌘V')}.</span>
          </span>
        </button>
        <form className="source-link" onSubmit={(e) => { e.preventDefault(); addLink(); }}>
          <MonitorPlay />
          <input className="field-input" value={link} onChange={(e) => setLink(e.target.value)} placeholder="Or paste a YouTube lecture link" />
          <button type="submit" className="btn" disabled={!/youtu/.test(link)}>Add video</button>
        </form>
      </div>

      {!!problems.length && (
        <div className="source-problems">
          {problems.map((p) => <div key={p} className="problem"><AlertCircle />{p}</div>)}
          <button type="button" className="link" onClick={() => setProblems([])}>Dismiss</button>
        </div>
      )}

      {sources.length > 0 && (
        <div className="source-table">
          <label className="source-table-head">
            <input type="checkbox" checked={allOn} ref={(el) => { if (el) el.indeterminate = used > 0 && !allOn; }}
              onChange={(e) => onToggleAll(e.target.checked)} disabled={!ready.length} />
            <span>{used === ready.length ? `Using all ${ready.length}` : `Using ${used} of ${ready.length}`}</span>
            <span className="muted">in chat, flashcards, quizzes and notes</span>
          </label>
          <ul className="source-list stagger">
            {sources.map((s, i) => {
              const stage = jobs.get(s.id);
              const stuck = !stage && s.status === 'processing';
              const trouble = readingTrouble(s);
              return (
                <li key={s.id} style={{ '--i': i } as React.CSSProperties} className={`source-row ${s.status}${selected.has(s.id) ? ' on' : ''}`}
                  onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, items: menuFor(s) }); }}>
                  <input type="checkbox" checked={selected.has(s.id)} disabled={s.status !== 'ready'} onChange={() => onToggle(s.id)}
                    title={selected.has(s.id) ? 'Used - click to leave it out' : 'Left out - click to use it'} aria-label={`Use ${s.title}`} />
                  <button type="button" className="source-main" onClick={() => onOpen(s)} title={s.error ?? `Open ${s.title}`}>
                    <span className={`source-kind ${s.kind}`}><KindIcon kind={s.kind} /></span>
                    <span className="source-text">
                      <span className="source-title">{s.title}</span>
                      <span className="source-meta">
                        {stage ? <span className="source-status"><Loader2 className="spin" />{stage}</span>
                          : stuck ? <span className="bad-text">Reading was interrupted</span>
                          : s.status === 'error' ? <span className="bad-text">{s.error ?? 'Could not be read'}</span>
                            : <>
                              {`${s.unitCount} ${unitWord(s)}${s.unitCount === 1 ? '' : 's'}`} · added {ago(s.createdAt)}
                              {trouble && <span className="bad-text"> · {trouble}</span>}
                            </>}
                      </span>
                    </span>
                  </button>
                  {(s.status === 'error' || stuck) && !stage && (
                    <button type="button" className="btn small" onClick={() => void ingest(s).then(onChanged)}><RotateCw />Read again</button>
                  )}
                  <MoreMenu items={menuFor(s)} title={`More for ${s.title}`} />
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {drag && <div className="drop-overlay"><Upload /><span>Drop to add to this notebook</span></div>}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {renaming && (
        <NameDialog title="Rename source" label="Name" initial={renaming.title} submitLabel="Save" onClose={() => setRenaming(null)}
          onSubmit={async (name) => { await studyApi.renameSource(renaming.id, name); onChanged(); }} />
      )}
      {removing && (
        <ConfirmDialog title="Delete source" confirmLabel="Delete" onClose={() => setRemoving(null)}
          onConfirm={async () => { await studyApi.deleteSource(removing.id); onChanged(); }}>
          Delete <b>{removing.title}</b>? The chat and generators stop using it. Flashcards and quizzes already made from it stay.
        </ConfirmDialog>
      )}
    </div>
  );
}

/**
 * The chat's own view of the sources: which ones answers are drawn from, changed in place,
 * without leaving the conversation. Adding and managing sources lives in the Sources section.
 */
export function SourcePicker({ sources, selected, onToggle, onToggleAll, onManage }: {
  sources: Source[];
  selected: Set<number>;
  onToggle: (id: number) => void;
  onToggleAll: (on: boolean) => void;
  onManage: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', onKey); };
  }, [open]);

  const ready = sources.filter((s) => s.status === 'ready');
  const used = ready.filter((s) => selected.has(s.id)).length;
  if (!sources.length) {
    return <button type="button" className="source-chip empty" onClick={onManage}><Plus />Add sources to chat about</button>;
  }
  return (
    <div className="source-picker" ref={wrap}>
      <button type="button" className={`source-chip${open ? ' open' : ''}`} onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="dialog">
        <Library />
        {used === ready.length ? `Using all ${ready.length} source${ready.length === 1 ? '' : 's'}` : `Using ${used} of ${ready.length} sources`}
        <ChevronDown className="source-chip-caret" />
      </button>
      {open && (
        <div className="source-pop" role="dialog" aria-label="Sources used in this chat">
          <label className="source-pop-all">
            <input type="checkbox" checked={used === ready.length && ready.length > 0} ref={(el) => { if (el) el.indeterminate = used > 0 && used < ready.length; }}
              onChange={(e) => onToggleAll(e.target.checked)} />
            <span>Use all sources</span>
          </label>
          <ul>
            {sources.map((s) => (
              <li key={s.id}>
                <label className={s.status !== 'ready' ? 'off' : ''}>
                  <input type="checkbox" checked={selected.has(s.id)} disabled={s.status !== 'ready'} onChange={() => onToggle(s.id)} />
                  <span className={`source-kind ${s.kind}`}><KindIcon kind={s.kind} /></span>
                  <span className="source-pop-title">{s.title}</span>
                  {s.status === 'processing' && <Loader2 className="spin" />}
                </label>
              </li>
            ))}
          </ul>
          <button type="button" className="source-pop-manage" onClick={() => { setOpen(false); onManage(); }}>
            <Plus />Add or manage sources
          </button>
        </div>
      )}
    </div>
  );
}

export function SourceViewer({ source, unit, onClose }: { source: Source; unit?: number; onClose: () => void }) {
  const [units, setUnits] = useState<SourceUnit[] | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [pictures, setPictures] = useState<SourceImage[]>([]);
  const [zoom, setZoom] = useState<string | null>(null);
  const refs = useRef(new Map<number, HTMLElement>());

  useEffect(() => {
    let alive = true;
    studyApi.sourceUnits(source.id).then((u) => { if (alive) setUnits(u); }).catch(() => { if (alive) setUnits([]); });
    if (source.kind === 'image') studyApi.sourceData(source.id).then((d) => { if (alive) setImage(d); }).catch(() => {});
    studyApi.sourceImages(source.id).then((p) => { if (alive) setPictures(p); }).catch(() => {});
    return () => { alive = false; };
  }, [source.id, source.kind]);

  useEffect(() => {
    if (units && unit !== undefined) refs.current.get(unit)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [units, unit]);

  const openAt = (label: string) => {
    if (source.kind !== 'youtube' || !source.url) return;
    const t = labelSeconds(label);
    const u = new URL(source.url);
    if (t !== null) u.searchParams.set('t', `${t}s`);
    void studyApi.openUrl(u.toString());
  };

  return (
    <div className="stage source-viewer">
      <div className="stage-head" data-tauri-drag-region="deep">
        <KindIcon kind={source.kind} />
        <span className="stage-title">{source.title}</span>
        <span className="muted small">{source.unitCount} {unitWord(source)}{source.unitCount === 1 ? '' : 's'}</span>
        <span className="spacer" />
        {source.kind === 'youtube' && source.url && (
          <button type="button" className="btn ghost" onClick={() => void studyApi.openUrl(source.url!)}><ExternalLink /> Open video</button>
        )}
        <button type="button" className="icon-btn" onClick={onClose} title="Close"><X /></button>
      </div>
      <div className="viewer-body">
        {image && <img className="viewer-image" src={image} alt={source.title} />}
        {units === null ? <div className="pane-empty center"><Loader2 className="spin" /></div>
          : !units.length ? <p className="muted pane-empty">{source.status === 'error' ? source.error : 'Nothing has been read from this source yet.'}</p>
            : units.map((u) => (
              <section key={u.ord} className={`viewer-unit${u.ord === unit ? ' hit' : ''}`} ref={(el) => { if (el) refs.current.set(u.ord, el); }}>
                <button type="button" className="viewer-label" onClick={() => openAt(u.label)} disabled={source.kind !== 'youtube'}>
                  {u.label}{source.kind === 'youtube' && <ExternalLink />}
                </button>
                {pictures.some((p) => p.unitOrd === u.ord) && (
                  <div className="viewer-pictures">
                    {pictures.filter((p) => p.unitOrd === u.ord).map((p) => <Picture key={p.id} image={p} onZoom={setZoom} />)}
                  </div>
                )}
                {source.kind === 'text' ? <pre className="viewer-text">{u.text}</pre> : <Markdown text={u.text} />}
              </section>
            ))}
      </div>
      {zoom && (
        <div className="lightbox" onClick={() => setZoom(null)} role="button" tabIndex={0} aria-label="Close">
          <img src={zoom} alt="" />
        </div>
      )}
    </div>
  );
}

function Picture({ image, onZoom }: { image: SourceImage; onZoom: (src: string) => void }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => { studyApi.sourceImageData(image.id).then(setSrc).catch(() => {}); }, [image.id]);
  return (
    <figure className="viewer-picture">
      {src ? <img src={src} alt={image.caption || 'Picture from this source'} onClick={() => onZoom(src)} /> : <div className="viewer-picture-loading" />}
      {image.caption && <figcaption>{image.caption.length > 220 ? `${image.caption.slice(0, 220)}…` : image.caption}</figcaption>}
    </figure>
  );
}
