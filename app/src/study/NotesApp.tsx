import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Placeholder } from '@tiptap/extensions';
import { Highlight } from '@tiptap/extension-highlight';
import { Mathematics } from '@tiptap/extension-mathematics';
import { Image } from '@tiptap/extension-image';
import type { EditorView } from '@tiptap/pm/view';
import { compactImage } from '../lib/images';
import katex from 'katex';
import {
  Bold, Code, FolderClosed, FolderPlus, Highlighter, ImagePlus, Inbox, Italic, Link2, List, ListChecks, ListOrdered,
  FolderInput, NotebookText, PanelLeft, Pencil, Pin, PinOff, Quote, RotateCcw, Search, Sigma, SquarePen, Strikethrough, Trash, Trash2, Underline, X,
} from 'lucide-react';
import {
  htmlToText, onPadChanged, PAD_SOURCE, padApi,
  type PadNote, type PadNoteMeta, type PadOverview, type PadScope,
} from '../lib/pad';
import { groupNotes, headerDate, rowDate } from '../lib/padDates';
import { ContextMenu, type MenuItem } from '../components/ContextMenu';
import { Modal } from '../components/Dialogs';
import { Select } from '../components/Select';
import { ConfirmDialog, NameDialog } from './dialogs';
import { keys } from '../lib/keys';

type View = { scope: PadScope; folder: number | null };
const VIEW_KEY = 'wa.pad.view';

const loadView = (): View => {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY) || 'null') as View | null;
    if (v && ['all', 'unfiled', 'folder', 'deleted'].includes(v.scope)) return v;
  } catch { }
  return { scope: 'all', folder: null };
};

const FOLDERS_KEY = 'wa.pad.folders';

const loadFoldersShown = (): boolean => {
  try { return localStorage.getItem(FOLDERS_KEY) !== 'hidden'; } catch { return true; }
};

export function NotesApp({ initialNote, onNoteChange }: { initialNote?: number | null; onNoteChange?: (id: number | null) => void }) {
  const [overview, setOverview] = useState<PadOverview | null>(null);
  const [view, setView] = useState<View>(loadView);
  const [list, setList] = useState<PadNoteMeta[]>([]);
  const [query, setQuery] = useState('');
  const [listFor, setListFor] = useState('');
  const viewKey = query.trim() ? `search:${query.trim()}` : `${view.scope}:${view.folder ?? ''}`;
  const [openId, setOpenId] = useState<number | null>(initialNote ?? null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [naming, setNaming] = useState<{ id?: number; name: string } | null>(null);
  const [removingFolder, setRemovingFolder] = useState<{ id: number; name: string } | null>(null);
  const [moving, setMoving] = useState<PadNoteMeta | null>(null);
  const [emptying, setEmptying] = useState(false);
  const [foldersShown, setFoldersShown] = useState(loadFoldersShown);

  useEffect(() => { try { localStorage.setItem(VIEW_KEY, JSON.stringify(view)); } catch { } }, [view]);
  useEffect(() => { try { localStorage.setItem(FOLDERS_KEY, foldersShown ? 'shown' : 'hidden'); } catch { } }, [foldersShown]);
  useEffect(() => { onNoteChange?.(openId); }, [openId, onNoteChange]);
  useEffect(() => { if (initialNote) setOpenId(initialNote); }, [initialNote]);

  const current = useRef(viewKey);
  current.current = viewKey;
  const reload = useCallback(async () => {
    const key = query.trim() ? `search:${query.trim()}` : `${view.scope}:${view.folder ?? ''}`;
    const [o, l] = await Promise.all([
      padApi.overview(),
      query.trim() ? padApi.search(query) : padApi.notes(view.scope, view.folder),
    ]);
    setOverview(o);
    if (key !== current.current) return;
    setList(l);
    setListFor(key);
  }, [view, query]);
  useEffect(() => { void reload(); }, [reload]);
  const latestReload = useRef(reload);
  latestReload.current = reload;

  useEffect(() => {
    const off = onPadChanged(() => { void reload(); });
    return () => { void off.then((f) => f()); };
  }, [reload]);

  useEffect(() => {
    if (listFor !== viewKey) return;
    if (openId !== null && list.some((n) => n.id === openId)) return;
    if (openId !== null && !query.trim()) {
      return;
    }
    if (openId === null && list.length) setOpenId(list[0].id);
  }, [list, listFor, viewKey, openId, query]);

  const folderName = (id: number | null) => (id === null ? 'Notes' : overview?.folders.find((f) => f.id === id)?.name ?? 'Notes');
  const viewTitle = query.trim() ? 'Search'
    : view.scope === 'all' ? 'All Notes' : view.scope === 'unfiled' ? 'Notes' : view.scope === 'deleted' ? 'Recently Deleted' : folderName(view.folder);

  const newNote = async () => {
    const folder = view.scope === 'folder' ? view.folder : null;
    if (view.scope === 'deleted') setView({ scope: 'all', folder: null });
    setQuery('');
    const n = await padApi.create(folder, '', '', PAD_SOURCE);
    await reload();
    setOpenId(n.id);
  };

  const leave = useCallback(async (id: number | null) => {
    if (id === null) return;
    const n = await padApi.note(id).catch(() => null);
    if (n && !n.deletedAt && !n.text.trim()) {
      await padApi.remove(id, false, PAD_SOURCE).catch(() => {});
      await padApi.remove(id, true, PAD_SOURCE).catch(() => {});
    }
  }, []);

  const open = (id: number) => {
    if (id === openId) return;
    void leave(openId).then(reload);
    setOpenId(id);
  };

  const noteMenu = (n: PadNoteMeta): MenuItem[] => n.deletedAt
    ? [
      { kind: 'item', label: 'Recover', icon: <RotateCcw />, onClick: () => void padApi.restore(n.id, PAD_SOURCE).then(reload) },
      { kind: 'sep' },
      { kind: 'item', label: 'Delete now', icon: <Trash2 />, danger: true, onClick: () => void padApi.remove(n.id, true, PAD_SOURCE).then(() => { if (openId === n.id) setOpenId(null); return reload(); }) },
    ]
    : [
      { kind: 'item', label: n.pinned ? 'Unpin note' : 'Pin note', icon: n.pinned ? <PinOff /> : <Pin />, onClick: () => void padApi.pin(n.id, !n.pinned, PAD_SOURCE).then(reload) },
      { kind: 'item', label: 'Move to…', icon: <FolderInput />, onClick: () => setMoving(n) },
      { kind: 'sep' },
      { kind: 'item', label: 'Delete', icon: <Trash />, danger: true, onClick: () => void padApi.remove(n.id, false, PAD_SOURCE).then(() => { if (openId === n.id) setOpenId(null); return reload(); }) },
    ];

  const folderMenu = (id: number, name: string): MenuItem[] => [
    { kind: 'item', label: 'Rename…', icon: <Pencil />, onClick: () => setNaming({ id, name }) },
    { kind: 'sep' },
    { kind: 'item', label: 'Delete folder', icon: <Trash />, danger: true, onClick: () => setRemovingFolder({ id, name }) },
  ];

  const groups = useMemo(() => groupNotes(list), [list]);
  const choose = (v: View) => {
    void leave(openId).then(() => latestReload.current());
    setQuery(''); setView(v); setOpenId(null);
  };

  return (
    <div className={`pad${foldersShown ? '' : ' no-folders'}`}>
      <aside className="pad-folders" inert={!foldersShown}>
        <div className="pad-col-head" data-tauri-drag-region="deep"><span>Folders</span></div>
        <div className="pad-folder-list">
          <FolderRow icon={<NotebookText />} name="All Notes" count={overview?.all} on={!query && view.scope === 'all'} onClick={() => choose({ scope: 'all', folder: null })} />
          <FolderRow icon={<Inbox />} name="Notes" count={overview?.unfiled} on={!query && view.scope === 'unfiled'} onClick={() => choose({ scope: 'unfiled', folder: null })} />
          {overview?.folders.length ? <div className="pad-folder-sep" /> : null}
          {overview?.folders.map((f) => (
            <FolderRow key={f.id} icon={<FolderClosed />} name={f.name} count={f.count}
              on={!query && view.scope === 'folder' && view.folder === f.id}
              onClick={() => choose({ scope: 'folder', folder: f.id })}
              onMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, items: folderMenu(f.id, f.name) }); }}
              onDoubleClick={() => setNaming({ id: f.id, name: f.name })} />
          ))}
          <div className="pad-folder-sep" />
          <FolderRow icon={<Trash2 />} name="Recently Deleted" count={overview?.deleted} on={!query && view.scope === 'deleted'} onClick={() => choose({ scope: 'deleted', folder: null })} />
        </div>
        <button type="button" className="pad-new-folder" onClick={() => setNaming({ name: '' })}><FolderPlus />New Folder</button>
      </aside>

      <section className="pad-list">
        <div className="pad-col-head" data-tauri-drag-region="deep">
          <Tool on={foldersShown} title={foldersShown ? 'Hide folders' : 'Show folders'} onClick={() => setFoldersShown((v) => !v)}><PanelLeft /></Tool>
          <span className="pad-list-title">{viewTitle}<span className="muted">{list.length}</span></span>
          <span className="spacer" />
          {view.scope === 'deleted' && !query ? (
            <button type="button" className="btn ghost small" disabled={!list.length} onClick={() => setEmptying(true)}>Empty</button>
          ) : (
            <button type="button" className="icon-btn" onClick={() => void newNote()} title="New note"><SquarePen /></button>
          )}
        </div>
        <label className="pad-search">
          <Search />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search all notes" spellCheck={false} />
          {query && <button type="button" className="pad-search-clear" onClick={() => setQuery('')} aria-label="Clear search"><X /></button>}
        </label>
        <div className="pad-notes">
          {!list.length && (
            <p className="pad-empty muted">
              {query.trim() ? `No notes match “${query.trim()}”.` : view.scope === 'deleted' ? 'Nothing here. Deleted notes wait here until you empty it.' : 'No notes yet.'}
            </p>
          )}
          {groups.map((g) => (
            <div key={g.label} className="pad-group">
              <div className="pad-group-label">{g.label === 'Pinned' ? <><Pin />Pinned</> : g.label}</div>
              {g.notes.map((n) => (
                <button key={n.id} type="button" className={`pad-note-row${n.id === openId ? ' on' : ''}`}
                  onClick={() => open(n.id)}
                  onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, items: noteMenu(n) }); }}>
                  <span className="pad-note-title">{n.title || 'New Note'}</span>
                  <span className="pad-note-meta">
                    <span className="pad-note-date">{rowDate(n.updatedAt)}</span>
                    <span className="pad-note-snippet">{n.snippet || 'No additional text'}</span>
                  </span>
                  {(view.scope === 'all' || query) && (
                    <span className="pad-note-folder"><FolderClosed />{folderName(n.folderId)}</span>
                  )}
                </button>
              ))}
            </div>
          ))}
        </div>
      </section>

      <section className="pad-editor-col">
        {openId !== null
          ? <NoteEditor key={openId} id={openId} folders={overview?.folders ?? []} onChanged={reload}
            onDeleted={() => { setOpenId(null); void reload(); }} onNew={() => void newNote()} />
          : (
            <div className="pad-blank">
              <NotebookText />
              <p>{list.length ? 'Choose a note' : 'Nothing here yet'}</p>
              <button type="button" className="btn" onClick={() => void newNote()}><SquarePen />New note</button>
            </div>
          )}
      </section>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {naming && (
        <NameDialog title={naming.id ? 'Rename folder' : 'New folder'} label="Name" initial={naming.name} submitLabel={naming.id ? 'Save' : 'Create'}
          onClose={() => setNaming(null)}
          onSubmit={async (name) => {
            if (naming.id) await padApi.renameFolder(naming.id, name, PAD_SOURCE);
            else { const f = await padApi.createFolder(name, PAD_SOURCE); choose({ scope: 'folder', folder: f.id }); }
            await reload();
          }} />
      )}
      {removingFolder && (
        <ConfirmDialog title="Delete folder" confirmLabel="Delete folder" onClose={() => setRemovingFolder(null)}
          onConfirm={async () => {
            await padApi.deleteFolder(removingFolder.id, PAD_SOURCE);
            if (view.folder === removingFolder.id) choose({ scope: 'all', folder: null });
            await reload();
          }}>
          Delete <b>{removingFolder.name}</b>? Its notes move to Recently Deleted, where you can recover them.
        </ConfirmDialog>
      )}
      {moving && (
        <MoveDialog note={moving} folders={overview?.folders ?? []} onClose={() => setMoving(null)}
          onMove={async (folder) => { await padApi.move(moving.id, folder, PAD_SOURCE); await reload(); }} />
      )}
      {emptying && (
        <ConfirmDialog title="Empty Recently Deleted" confirmLabel="Delete all" onClose={() => setEmptying(false)}
          onConfirm={async () => { await padApi.emptyDeleted(PAD_SOURCE); setOpenId(null); await reload(); }}>
          Delete the {list.length} note{list.length === 1 ? '' : 's'} in Recently Deleted for good? This cannot be undone.
        </ConfirmDialog>
      )}
    </div>
  );
}

function FolderRow({ icon, name, count, on, onClick, onMenu, onDoubleClick }: {
  icon: React.ReactNode; name: string; count?: number; on: boolean;
  onClick: () => void; onMenu?: (e: React.MouseEvent) => void; onDoubleClick?: () => void;
}) {
  return (
    <button type="button" className={`pad-folder${on ? ' on' : ''}`} onClick={onClick} onContextMenu={onMenu} onDoubleClick={onDoubleClick}>
      <span className="pad-folder-icon">{icon}</span>
      <span className="pad-folder-name">{name}</span>
      <span className="pad-folder-count">{count ?? ''}</span>
    </button>
  );
}

function MoveDialog({ note, folders, onClose, onMove }: {
  note: PadNoteMeta; folders: { id: number; name: string }[]; onClose: () => void; onMove: (folder: number | null) => Promise<void>;
}) {
  const [to, setTo] = useState(String(note.folderId ?? ''));
  return (
    <Modal title="Move note" onClose={onClose}>
      <div className="form">
        <label className="field">
          <span>Move “{note.title || 'New Note'}” to</span>
          <Select className="field-input" value={to} onChange={setTo}
            options={[{ value: '', label: 'Notes' }, ...folders.map((f) => ({ value: String(f.id), label: f.name }))]} />
        </label>
      </div>
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" onClick={async () => { await onMove(to ? Number(to) : null); onClose(); }}>Move</button>
      </div>
    </Modal>
  );
}

const SAVE_AFTER = 500;

function NoteEditor({ id, folders, onChanged, onDeleted, onNew }: {
  id: number;
  folders: { id: number; name: string }[];
  onChanged: () => void;
  onDeleted: () => void;
  onNew: () => void;
}) {
  const [note, setNote] = useState<PadNote | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [math, setMath] = useState<{ latex: string; pos?: number; block: boolean } | null>(null);
  const [linking, setLinking] = useState(false);
  const timer = useRef<number | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const dirty = useRef(false);
  const baseline = useRef<string | null>(null);
  const deleted = !!note?.deletedAt;

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: { openOnClick: false, autolink: true } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Highlight,
      Placeholder.configure({ placeholder: ({ pos }) => (pos === 0 ? 'Title' : 'Start writing…'), showOnlyCurrent: true }),
      Image.configure({
        allowBase64: true,
        resize: { enabled: true, directions: ['left', 'right', 'bottom-left', 'bottom-right'], minWidth: 80, alwaysPreserveAspectRatio: true },
      }),
      Mathematics.configure({
        katexOptions: { throwOnError: false },
        inlineOptions: { onClick: (node, pos) => setMath({ latex: String(node.attrs.latex ?? ''), pos, block: false }) },
        blockOptions: { onClick: (node, pos) => setMath({ latex: String(node.attrs.latex ?? ''), pos, block: true }) },
      }),
    ],
    editorProps: {
      attributes: { class: 'pad-prose', spellcheck: 'true' },
      handlePaste: (view, event) => {
        const files = imagesIn(event.clipboardData?.files);
        if (!files.length) return false;
        event.preventDefault();
        void placeImages(view, files);
        return true;
      },
      handleDrop: (view, event, _slice, moved) => {
        const files = moved ? [] : imagesIn(event.dataTransfer?.files);
        if (!files.length) return false;
        event.preventDefault();
        void placeImages(view, files, view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos);
        return true;
      },
    },
    onUpdate: () => {
      dirty.current = true;
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void save(), SAVE_AFTER);
    },
  });

  const save = useCallback(async () => {
    if (!editor || !dirty.current) return;
    dirty.current = false;
    const html = editor.getHTML();
    if (html === baseline.current) return;
    baseline.current = html;
    const t = await padApi.save(id, html, htmlToText(html), PAD_SOURCE).catch(() => null);
    if (t) { setSavedAt(t); onChanged(); }
  }, [editor, id, onChanged]);

  useEffect(() => {
    let alive = true;
    padApi.note(id).then((n) => {
      if (!alive) return;
      setNote(n);
      setSavedAt(n.updatedAt);
      editor?.commands.setContent(n.html || '', { emitUpdate: false });
      baseline.current = editor?.getHTML() ?? null;
      editor?.setEditable(!n.deletedAt);
      if (!n.text.trim()) editor?.commands.focus('end');
    }).catch(() => onDeleted());
    return () => {
      alive = false;
      if (timer.current) window.clearTimeout(timer.current);
      void save();
    };
  }, [id, editor]);

  useEffect(() => {
    const off = onPadChanged((c) => {
      if (c.what !== 'note' || c.id !== id || c.by === PAD_SOURCE) return;
      void padApi.note(id).then((n) => {
        setNote(n);
        setSavedAt(n.updatedAt);
        if (editor && n.html !== editor.getHTML()) {
          editor.commands.setContent(n.html || '', { emitUpdate: false });
          baseline.current = editor.getHTML();
        }
        editor?.setEditable(!n.deletedAt);
      }).catch(() => onDeleted());
    });
    return () => { void off.then((f) => f()); };
  }, [id, editor, onDeleted]);

  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => e ? ({
      bold: e.isActive('bold'), italic: e.isActive('italic'), underline: e.isActive('underline'), strike: e.isActive('strike'),
      highlight: e.isActive('highlight'), code: e.isActive('code'), link: e.isActive('link'),
      task: e.isActive('taskList'), bullet: e.isActive('bulletList'), ordered: e.isActive('orderedList'), quote: e.isActive('blockquote'),
      style: e.isActive('heading', { level: 1 }) ? 'title' : e.isActive('heading', { level: 2 }) ? 'heading'
        : e.isActive('heading', { level: 3 }) ? 'subheading' : e.isActive('codeBlock') ? 'mono' : 'body',
    }) : null,
  });

  if (!note || !editor) return <div className="pad-blank"><span className="dots"><i /><i /><i /></span></div>;

  const setStyle = (v: string) => {
    const c = editor.chain().focus();
    if (v === 'title') c.setHeading({ level: 1 }).run();
    else if (v === 'heading') c.setHeading({ level: 2 }).run();
    else if (v === 'subheading') c.setHeading({ level: 3 }).run();
    else if (v === 'mono') c.setCodeBlock().run();
    else c.setParagraph().run();
  };

  return (
    <div className="pad-editor">
      <div className="pad-toolbar">
        {deleted ? (
          <div className="pad-deleted-bar">
            <span>This note is in Recently Deleted.</span>
            <button type="button" className="btn small" onClick={() => void padApi.restore(id, PAD_SOURCE).then(() => { onChanged(); })}><RotateCcw />Recover</button>
            <button type="button" className="btn ghost small danger" onClick={() => void padApi.remove(id, true, PAD_SOURCE).then(onDeleted)}>Delete now</button>
          </div>
        ) : (
          <>
            <div className="pad-tool-group">
              <Select className="select pad-style" value={state?.style ?? 'body'} onChange={setStyle} title="Paragraph style"
                options={[
                  { value: 'title', label: 'Title' }, { value: 'heading', label: 'Heading' }, { value: 'subheading', label: 'Subheading' },
                  { value: 'body', label: 'Body' }, { value: 'mono', label: 'Monospaced' },
                ]} />
            </div>
            <span className="pad-tool-sep" />
            <div className="pad-tool-group">
              <Tool on={state?.bold} title={`Bold (${keys('⌘B')})`} onClick={() => editor.chain().focus().toggleBold().run()}><Bold /></Tool>
              <Tool on={state?.italic} title={`Italic (${keys('⌘I')})`} onClick={() => editor.chain().focus().toggleItalic().run()}><Italic /></Tool>
              <Tool on={state?.underline} title={`Underline (${keys('⌘U')})`} onClick={() => editor.chain().focus().toggleUnderline().run()}><Underline /></Tool>
              <Tool on={state?.strike} title="Strikethrough" onClick={() => editor.chain().focus().toggleStrike().run()}><Strikethrough /></Tool>
              <Tool on={state?.highlight} title="Highlight" onClick={() => editor.chain().focus().toggleHighlight().run()}><Highlighter /></Tool>
            </div>
            <span className="pad-tool-sep" />
            <div className="pad-tool-group">
              <Tool on={state?.task} title="Checklist" onClick={() => editor.chain().focus().toggleTaskList().run()}><ListChecks /></Tool>
              <Tool on={state?.bullet} title="Bulleted list" onClick={() => editor.chain().focus().toggleBulletList().run()}><List /></Tool>
              <Tool on={state?.ordered} title="Numbered list" onClick={() => editor.chain().focus().toggleOrderedList().run()}><ListOrdered /></Tool>
              <Tool on={state?.quote} title="Quote" onClick={() => editor.chain().focus().toggleBlockquote().run()}><Quote /></Tool>
            </div>
            <span className="pad-tool-sep" />
            <div className="pad-tool-group">
              <Tool on={state?.code} title="Code" onClick={() => editor.chain().focus().toggleCode().run()}><Code /></Tool>
              <Tool title="Maths" onClick={() => setMath({ latex: '', block: false })}><Sigma /></Tool>
              <Tool on={state?.link} title="Link" onClick={() => (state?.link ? editor.chain().focus().unsetLink().run() : setLinking(true))}><Link2 /></Tool>
              <Tool title="Add a picture" onClick={() => picker.current?.click()}><ImagePlus /></Tool>
              <input ref={picker} type="file" accept="image/*" multiple hidden
                onChange={(e) => { const files = imagesIn(e.target.files); e.target.value = ''; if (files.length) void placeImages(editor.view, files); }} />
            </div>
            <span className="spacer" />
            <div className="pad-tool-group">
              <Tool on={note.pinned} title={note.pinned ? 'Unpin' : 'Pin'} onClick={() => void padApi.pin(id, !note.pinned, PAD_SOURCE).then(() => { setNote({ ...note, pinned: !note.pinned }); onChanged(); })}>
                {note.pinned ? <PinOff /> : <Pin />}
              </Tool>
              <Select className="select pad-move" value={String(note.folderId ?? '')} title="Folder"
                onChange={(v) => void padApi.move(id, v ? Number(v) : null, PAD_SOURCE).then(() => { setNote({ ...note, folderId: v ? Number(v) : null }); onChanged(); })}
                options={[{ value: '', label: 'Notes' }, ...folders.map((f) => ({ value: String(f.id), label: f.name }))]} />
              <Tool title="Delete note" onClick={() => void padApi.remove(id, false, PAD_SOURCE).then(onDeleted)}><Trash /></Tool>
              <Tool title="New note" onClick={onNew}><SquarePen /></Tool>
            </div>
          </>
        )}
      </div>
      <div className="pad-page" onClick={(e) => { if (e.target === e.currentTarget) editor.commands.focus('end'); }}>
        <div className="pad-date">{headerDate(savedAt ?? note.updatedAt)}</div>
        <EditorContent editor={editor} />
      </div>
      {math && (
        <MathDialog initial={math.latex} block={math.block} editing={math.pos !== undefined}
          onClose={() => setMath(null)}
          onRemove={() => {
            if (math.pos === undefined) return;
            const c = editor.chain().focus();
            (math.block ? c.deleteBlockMath({ pos: math.pos }) : c.deleteInlineMath({ pos: math.pos })).run();
          }}
          onSave={(latex, block) => {
            const c = editor.chain().focus();
            if (math.pos !== undefined) {
              (math.block ? c.updateBlockMath({ latex, pos: math.pos }) : c.updateInlineMath({ latex, pos: math.pos })).run();
            } else {
              (block ? c.insertBlockMath({ latex }) : c.insertInlineMath({ latex })).run();
            }
          }} />
      )}
      {linking && <LinkDialog editor={editor} onClose={() => setLinking(false)} />}
    </div>
  );
}

const imagesIn = (files: FileList | null | undefined): File[] => [...(files ?? [])].filter((f) => f.type.startsWith('image/'));

async function placeImages(view: EditorView, files: File[], at?: number) {
  const image = view.state.schema.nodes.image;
  if (!image) return;
  let pos = at;
  for (const file of files) {
    const src = await compactImage(file).catch(() => null);
    if (!src) continue;
    const node = image.create({ src, alt: file.name.replace(/\.[^.]+$/, '') });
    const tr = pos === undefined ? view.state.tr.replaceSelectionWith(node) : view.state.tr.insert(Math.min(pos, view.state.doc.content.size), node);
    view.dispatch(tr.scrollIntoView());
    if (pos !== undefined) pos += node.nodeSize;
  }
  view.focus();
}

function Tool({ on, title, onClick, children }: { on?: boolean; title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" className={`pad-tool${on ? ' on' : ''}`} title={title} aria-label={title} aria-pressed={on}
      onMouseDown={(e) => e.preventDefault()} onClick={onClick}>{children}</button>
  );
}

function MathDialog({ initial, block: startBlock, editing, onSave, onRemove, onClose }: {
  initial: string; block: boolean; editing: boolean;
  onSave: (latex: string, block: boolean) => void; onRemove: () => void; onClose: () => void;
}) {
  const [latex, setLatex] = useState(initial);
  const [block, setBlock] = useState(startBlock);
  const preview = useMemo(() => {
    try { return katex.renderToString(latex || '\\;', { throwOnError: true, displayMode: block }); } catch { return null; }
  }, [latex, block]);
  return (
    <Modal title={editing ? 'Edit maths' : 'Insert maths'} onClose={onClose}>
      <div className="form">
        <label className="field">
          <span>LaTeX</span>
          <textarea className="textarea mono" rows={3} autoFocus value={latex} onChange={(e) => setLatex(e.target.value)}
            placeholder="\frac{a}{b}, \int_0^1 x^2\,dx, v = u + at"
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && latex.trim()) { onSave(latex.trim(), block); onClose(); } }} />
        </label>
        <div className={`pad-math-preview${preview ? '' : ' bad'}`}>
          {preview ? <span dangerouslySetInnerHTML={{ __html: preview }} /> : 'This does not typeset yet.'}
        </div>
        {!editing && (
          <label className="toggle"><input type="checkbox" checked={block} onChange={(e) => setBlock(e.target.checked)} />On its own line</label>
        )}
      </div>
      <div className="modal-actions">
        {editing && <button type="button" className="btn ghost danger" style={{ marginRight: 'auto' }} onClick={() => { onRemove(); onClose(); }}>Remove</button>}
        <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={!latex.trim()} onClick={() => { onSave(latex.trim(), block); onClose(); }}>{editing ? 'Save' : 'Insert'}</button>
      </div>
    </Modal>
  );
}

function LinkDialog({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const [url, setUrl] = useState(String(editor.getAttributes('link').href ?? ''));
  const apply = () => {
    const href = url.trim();
    if (href) editor.chain().focus().extendMarkRange('link').setLink({ href: /^[a-z]+:/i.test(href) ? href : `https://${href}` }).run();
    onClose();
  };
  return (
    <Modal title="Link" onClose={onClose}>
      <div className="form">
        <label className="field">
          <span>Address</span>
          <input className="field-input" autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…"
            onKeyDown={(e) => { if (e.key === 'Enter') apply(); }} />
        </label>
      </div>
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={!url.trim()} onClick={apply}>Link</button>
      </div>
    </Modal>
  );
}
