import { useEffect, useRef, useState } from 'react';
import {
  AlertCircle, ExternalLink, File, FileText, Image as ImageIcon, Link2, Loader2, MoreHorizontal, PanelLeftClose, PanelLeftOpen,
  Plus, Presentation, RotateCw, Upload, MonitorPlay, X,
} from 'lucide-react';
import { ACCEPT, addFiles, addYoutube, ingest, labelSeconds, useIngestJobs } from '../lib/ingest';
import { Markdown } from '../lib/markdown';
import { ContextMenu, type MenuItem } from '../components/ContextMenu';
import { studyApi, type Source, type SourceImage, type SourceKind, type SourceUnit } from './api';
import { NameDialog, ConfirmDialog } from './dialogs';

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

export function SourcesPane({ notebookId, sources, selected, onToggle, onToggleAll, collapsed, onCollapse, onOpen, onChanged }: {
  notebookId: number;
  sources: Source[];
  selected: Set<number>;
  onToggle: (id: number) => void;
  onToggleAll: (on: boolean) => void;
  collapsed: boolean;
  onCollapse: (c: boolean) => void;
  onOpen: (s: Source) => void;
  onChanged: () => void;
}) {
  const jobs = useIngestJobs();
  const fileInput = useRef<HTMLInputElement>(null);
  const [adding, setAdding] = useState(false);
  const [link, setLink] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const [drag, setDrag] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [renaming, setRenaming] = useState<Source | null>(null);
  const [removing, setRemoving] = useState<Source | null>(null);

  const upload = async (files: File[]) => {
    if (!files.length) return;
    setAdding(false);
    setProblems(await addFiles(notebookId, files, onChanged));
  };

  const menuFor = (s: Source): MenuItem[] => [
    { kind: 'item', label: 'Open', onClick: () => onOpen(s) },
    { kind: 'item', label: 'Rename…', onClick: () => setRenaming(s) },
    ...(!jobs.has(s.id) ? [{ kind: 'item' as const, label: 'Read again', onClick: () => void ingest(s).then(onChanged) }] : []),
    { kind: 'sep' },
    { kind: 'item', label: 'Delete', danger: true, onClick: () => setRemoving(s) },
  ];

  const ready = sources.filter((s) => s.status === 'ready');
  const allOn = ready.length > 0 && ready.every((s) => selected.has(s.id));

  if (collapsed) {
    return (
      <aside className="nbw-pane nbw-sources collapsed">
        <button type="button" className="rail-btn" onClick={() => onCollapse(false)} title="Show sources"><PanelLeftOpen /></button>
        <button type="button" className="rail-btn" onClick={() => { onCollapse(false); setAdding(true); }} title="Add sources"><Plus /></button>
        <div className="rail-count" title={`${sources.length} sources`}><FileText />{sources.length}</div>
      </aside>
    );
  }

  return (
    <aside
      className={`nbw-pane nbw-sources${drag ? ' dragging' : ''}`}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDrag(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrag(false); }}
      onDrop={(e) => { e.preventDefault(); setDrag(false); void upload([...e.dataTransfer.files]); }}
    >
      <div className="pane-head">
        <span>Sources</span><span className="muted">{sources.length}</span>
        <span className="spacer" />
        <button type="button" className="icon-btn" onClick={() => setAdding((a) => !a)} title="Add sources"><Plus /></button>
        <button type="button" className="icon-btn" onClick={() => onCollapse(true)} title="Hide sources"><PanelLeftClose /></button>
      </div>

      <div className={`collapse${adding ? ' open' : ''}`}>
        <div>
          <div className="add-sources">
            <button type="button" className="drop-zone" onClick={() => fileInput.current?.click()}>
              <Upload />
              <span>Upload files</span>
              <span className="muted small">PDF, slides (PPTX), Word, images, text — or drop them here</span>
            </button>
            <form className="link-row" onSubmit={(e) => { e.preventDefault(); if (link.trim()) { void addYoutube(notebookId, link, onChanged); setLink(''); setAdding(false); } }}>
              <Link2 />
              <input className="field-input" value={link} onChange={(e) => setLink(e.target.value)} placeholder="YouTube link" />
              <button type="submit" className="btn" disabled={!/youtu/.test(link)}>Add</button>
            </form>
          </div>
        </div>
      </div>
      <input ref={fileInput} type="file" multiple accept={ACCEPT} hidden onChange={(e) => { void upload([...(e.target.files ?? [])]); e.target.value = ''; }} />

      {!!problems.length && (
        <div className="pane-problems">
          {problems.map((p) => <div key={p} className="problem"><AlertCircle />{p}</div>)}
          <button type="button" className="link" onClick={() => setProblems([])}>dismiss</button>
        </div>
      )}

      {sources.length > 0 && (
        <label className="select-all">
          <input type="checkbox" checked={allOn} onChange={(e) => onToggleAll(e.target.checked)} disabled={!ready.length} />
          <span>Use all sources</span>
        </label>
      )}

      <ul className="source-list stagger">
        {sources.map((s, i) => {
          const stage = jobs.get(s.id);
          const stuck = !stage && s.status === 'processing';
          return (
            <li key={s.id} style={{ '--i': i } as React.CSSProperties} className={`source-row ${s.status}`}
              onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, items: menuFor(s) }); }}>
              <input type="checkbox" checked={selected.has(s.id)} disabled={s.status !== 'ready'} onChange={() => onToggle(s.id)} title="Use in chat and generation" />
              <button type="button" className="source-main" onClick={() => onOpen(s)} title={s.error ?? s.title}>
                <KindIcon kind={s.kind} />
                <span className="source-text">
                  <span className="source-title">{s.title}</span>
                  <span className="source-meta">
                    {stage ? <><Loader2 className="spin" />{stage}</>
                      : stuck ? <span className="bad-text">interrupted — read it again</span>
                      : s.status === 'error' ? <span className="bad-text">{s.error ?? 'could not be read'}</span>
                        : <>
                          {`${s.unitCount} ${unitWord(s)}${s.unitCount === 1 ? '' : 's'}`}
                          {readingTrouble(s) && <span className="bad-text"> · {readingTrouble(s)}</span>}
                        </>}
                  </span>
                </span>
              </button>
              {(s.status === 'error' || stuck) && !stage && (
                <button type="button" className="icon-btn ghost-icon" onClick={() => void ingest(s).then(onChanged)} title="Try again"><RotateCw /></button>
              )}
              <button type="button" className="icon-btn ghost-icon row-more" onClick={(e) => setMenu({ x: e.clientX, y: e.clientY, items: menuFor(s) })} title="More"><MoreHorizontal /></button>
            </li>
          );
        })}
      </ul>

      {!sources.length && !adding && (
        <button type="button" className="pane-empty sources-empty" onClick={() => setAdding(true)}>
          <Upload />
          <p>Add your course material</p>
          <p className="muted">Lecture PDFs, slides, notes, photos of handwriting, YouTube lectures. Chat, flashcards and quizzes then use them and cite where each answer came from.</p>
        </button>
      )}

      {drag && <div className="drop-overlay"><Upload /><span>Drop to add</span></div>}
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
    </aside>
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
      <div className="stage-head">
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
