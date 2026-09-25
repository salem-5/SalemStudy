import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpenText, ChartColumn, ChevronRight, Eraser, Layers, Library, ListChecks, Loader2, MessageSquare, NotebookPen,
  Pencil, Plus, RefreshCw, Sparkles, Trash, Upload,
} from 'lucide-react';
import { Select } from '../components/Select';
import { dropEmpty } from '../lib/chatThreads';
import { courseContextOf } from '../lib/syllabus';
import { suitsDiagrams } from '../lib/subjects';
import { ChatView } from '../components/chat/ChatView';
import { ViewBar } from '../components/ViewBar';
import { ContextMenu, MoreMenu } from '../components/ContextMenu';
import { SubjectIcon, subjectColor } from '../components/subjectIcons';
import { type GenSource, type StudyContext, type QuizOptions, type CardOptions } from '../lib/studyGen';
import { makeSet } from '../lib/makeSet';
import { morph } from '../lib/morph';
import { clearQuizSession, loadQuizSession } from '../lib/studySession';
import { notebookPrompt } from '../lib/prompts';
import { retrieve } from '../lib/retrieval';
import { studyApi, type Card, type ChatThread, type Deck, type Note, type NotebookSummary, type QuizSummary, type Source, type SubjectNode, type Quiz } from './api';
import { Analytics } from './Analytics';
import { DeckPlayer, DeckView, GenerateDialog, playOrder } from './Flashcards';
import { QuizRunner, QuizView } from './Quizzes';
import { SetsPane, startSet, useSetBusy, type SetKind } from './StudySets';
import { SourcePicker, SourcesLibrary, SourceViewer } from './Sources';
import { NotesPane, NoteView } from './Notes';
import { writeNote } from '../lib/notesGen';
import { overviewStale, writeOverview } from '../lib/overview';
import { Markdown } from '../lib/markdown';
import { relTime } from '../lib/format';
import { ConfirmDialog } from './dialogs';
import type { NotebookTarget, StudyActions } from './pages';

type Section = 'overview' | 'chat' | 'cards' | 'quizzes' | 'notes' | 'sources' | 'progress';

type Center =
  | { kind: 'overview' }
  | { kind: 'chat' }
  | { kind: 'cards' }
  | { kind: 'quizzes' }
  | { kind: 'notes' }
  | { kind: 'sources' }
  | { kind: 'progress' }
  | { kind: 'deck'; id: number }
  | { kind: 'play'; deckId: number; cards: Card[]; title: string; practice: boolean }
  | { kind: 'quiz'; id: number }
  | { kind: 'quizrun'; id: number; only?: number[]; startAt?: number }
  | { kind: 'source'; id: number; unit?: number }
  | { kind: 'note'; id: number };

const isImmersive = (c: Center) => c.kind === 'play' || c.kind === 'quizrun';

const sectionOf = (c: Center): Section => {
  switch (c.kind) {
    case 'deck': case 'play': return 'cards';
    case 'quiz': case 'quizrun': return 'quizzes';
    case 'note': return 'notes';
    case 'source': return 'sources';
    default: return c.kind;
  }
};

const SECTIONS: { id: Section; label: string; icon: React.ReactNode }[] = [
  { id: 'overview', label: 'Overview', icon: <BookOpenText /> },
  { id: 'chat', label: 'Chat', icon: <MessageSquare /> },
  { id: 'cards', label: 'Flashcards', icon: <Layers /> },
  { id: 'quizzes', label: 'Quizzes', icon: <ListChecks /> },
  { id: 'notes', label: 'Notes', icon: <NotebookPen /> },
  { id: 'sources', label: 'Sources', icon: <Library /> },
  { id: 'progress', label: 'Progress', icon: <ChartColumn /> },
];

const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { } },
};
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const isSection = (v: string | null): v is Section => !!v && SECTIONS.some((s) => s.id === v);

function Crumbs({ items }: { items: { label: string; onClick?: () => void }[] }) {
  return (
    <div className="page-crumbs">
      {items.map((it, i) => (
        <span key={i} className="crumb">
          {i > 0 && <span className="crumb-sep" aria-hidden><ChevronRight /></span>}
          {it.onClick ? <button type="button" className="link" onClick={it.onClick}>{it.label}</button> : <span className="crumb-here">{it.label}</span>}
        </span>
      ))}
    </div>
  );
}

/** The row of sections under the toolbar. The indicator slides to the chosen one rather than jumping. */
function SectionBar({ value, onChange, counts, busy }: {
  value: Section;
  onChange: (s: Section) => void;
  counts: Partial<Record<Section, number>>;
  busy: Partial<Record<Section, boolean>>;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const [mark, setMark] = useState<{ x: number; w: number } | null>(null);
  useLayoutEffect(() => {
    const el = bar.current?.querySelector<HTMLElement>(`[data-section="${value}"]`);
    if (el) setMark({ x: el.offsetLeft, w: el.offsetWidth });
  }, [value, counts, busy]);
  return (
    <div className="section-bar" role="tablist" aria-label="Notebook sections" ref={bar} data-tauri-drag-region="deep">
      {SECTIONS.map((s) => (
        <button key={s.id} type="button" role="tab" data-section={s.id} aria-selected={value === s.id}
          className={`section-tab${value === s.id ? ' on' : ''}`} onClick={() => onChange(s.id)}>
          {s.icon}<span>{s.label}</span>
          {busy[s.id] ? <Loader2 className="spin section-busy" /> : !!counts[s.id] && <span className="tab-count">{counts[s.id]}</span>}
        </button>
      ))}
      {mark && <span className="section-mark" style={{ transform: `translateX(${mark.x}px)`, width: mark.w }} aria-hidden />}
    </div>
  );
}

export function NotebookPage({ notebook, subject, actions, target }: { notebook: NotebookSummary; subject: SubjectNode; actions: StudyActions; target?: NotebookTarget }) {
  const sectionKey = `wa.nb.${notebook.id}.section`;
  const [center, setCenterNow] = useState<Center>(() => {
    if (target?.type === 'source') return { kind: 'source', id: target.id, unit: target.unit };
    if (target?.type === 'note') return { kind: 'note', id: target.id };
    if (target?.type === 'deck') return { kind: 'deck', id: target.id };
    if (target?.type === 'quiz') return target.run ? { kind: 'quizrun', id: target.id } : { kind: 'quiz', id: target.id };
    if (target?.type === 'chat') return { kind: 'chat' };
    const last = store.get(sectionKey);
    if (isSection(last)) return { kind: last };
    return { kind: notebook.sourceCount ? 'chat' : 'overview' };
  });
  const section = sectionOf(center);
  useEffect(() => { store.set(sectionKey, section); }, [section, sectionKey]);
  // Going into a deck or quiz, or back out of one, is animated as one move (lib/morph.ts); every
  // other change of view is instant.
  const centerRef = useRef(center);
  centerRef.current = center;
  const setCenter = useCallback((next: Center) => {
    if (isImmersive(next) !== isImmersive(centerRef.current)) morph(() => setCenterNow(next));
    else setCenterNow(next);
  }, []);

  const [decks, setDecks] = useState<Deck[]>([]);
  const [quizzes, setQuizzes] = useState<QuizSummary[]>([]);
  const [fresh, setFresh] = useState<Record<SetKind, Record<number, string>>>({ cards: {}, quiz: {} });
  const seen = useCallback((kind: SetKind, id: number) => setFresh((f) => {
    if (!(id in f[kind])) return f;
    const next = { ...f[kind] };
    delete next[id];
    return { ...f, [kind]: next };
  }), []);
  const [sources, setSources] = useState<Source[]>([]);
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [thread, setThread] = useState<number | null>(null);
  const threadRef = useRef(thread);
  threadRef.current = thread;
  const [threadsLoaded, setThreadsLoaded] = useState(false);
  const firstThreads = useRef(true);
  const [generating, setGenerating] = useState<{ kind: 'cards' | 'quiz' | 'notes'; thread?: number | null } | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const writingDeck = useSetBusy('cards', notebook.id);
  const writingQuiz = useSetBusy('quiz', notebook.id);
  const [chatReload, setChatReload] = useState(0);
  const [clearing, setClearing] = useState<'one' | 'all' | null>(null);
  const [clearMenu, setClearMenu] = useState<{ x: number; y: number } | null>(null);
  const [version, setVersion] = useState(0);
  const [sheet, setSheet] = useState<{ id: number; unit?: number } | null>(null);
  const offKey = `wa.nb.${notebook.id}.sourcesOff`;
  const [off, setOff] = useState<Set<number>>(() => { try { return new Set(JSON.parse(store.get(offKey) || '[]')); } catch { return new Set(); } });

  useEffect(() => { store.set(offKey, JSON.stringify([...off])); }, [off, offKey]);

  const ctx: StudyContext = useMemo(() => ({ subject: subject.name, notebook: notebook.name, courseContext: courseContextOf(subject) }), [subject, notebook.name]);
  const selected = useMemo(() => new Set(sources.filter((s) => s.status === 'ready' && !off.has(s.id)).map((s) => s.id)), [sources, off]);

  const reloadDecks = useCallback(() => { studyApi.decks(notebook.id).then(setDecks).catch(() => {}); }, [notebook.id]);
  const reloadQuizzes = useCallback(() => { studyApi.quizzes(notebook.id).then(setQuizzes).catch(() => {}); }, [notebook.id]);
  const reloadNotes = useCallback(() => { studyApi.notes(notebook.id).then(setNotes).catch(() => {}); }, [notebook.id]);
  const reloadSources = useCallback(() => { studyApi.sources(notebook.id).then(setSources).catch(() => {}); }, [notebook.id]);
  const reloadThreads = useCallback(() => {
    studyApi.chatList(notebook.id).then((all) => {
      const t = dropEmpty(all, firstThreads.current ? (target?.type === 'chat' ? target.id : null) : threadRef.current);
      setThreads(t);
      if (firstThreads.current) { firstThreads.current = false; setThread(target?.type === 'chat' ? target.id : t[0]?.id ?? null); }
      setThreadsLoaded(true);
    }).catch(() => setThreadsLoaded(true));
  }, [notebook.id]);

  useEffect(() => { reloadDecks(); reloadQuizzes(); reloadSources(); reloadThreads(); reloadNotes(); }, [reloadDecks, reloadQuizzes, reloadSources, reloadThreads, reloadNotes]);
  const lastThread = useRef(thread);
  useEffect(() => {
    if (lastThread.current !== thread) { lastThread.current = thread; if (!firstThreads.current) reloadThreads(); }
  }, [thread, reloadThreads]);

  const changed = useCallback(() => {
    reloadDecks();
    reloadQuizzes();
    setVersion((v) => v + 1);
    actions.refresh();
  }, [reloadDecks, reloadQuizzes, actions]);
  const sourcesChanged = useCallback(() => { reloadSources(); actions.refresh(); }, [reloadSources, actions]);

  const runGeneration = async (kind: 'cards' | 'quiz' | 'notes', src: GenSource, instructions: string, options: QuizOptions & CardOptions) => {
    if (kind === 'notes') {
      setCenter({ kind: 'notes' });
      void writeNote(ctx, notebook.id, src, instructions, (n) => { reloadNotes(); setCenter({ kind: 'note', id: n.id }); })
        .catch(() => {})
        .finally(reloadNotes);
      return 'Writing your notes…';
    }
    const setKind: SetKind = kind === 'cards' ? 'cards' : 'quiz';
    startSet(
      setKind,
      notebook,
      src.kind === 'sources',
      async (report, meter, stop) => {
        const made = await makeSet(setKind, ctx, notebook.id, src, report, { ...options, meter, stop });
        return { id: made.id, note: made.note };
      },
      (id, note) => {
        setFresh((f) => ({ ...f, [setKind]: { ...f[setKind], [id]: note } }));
        changed();
      },
    );
    setCenter({ kind: setKind === 'cards' ? 'cards' : 'quizzes' });
    return '';
  };

  const readySelected = useMemo(() => sources.filter((s) => selected.has(s.id)), [sources, selected]);
  const system = useCallback((python: boolean) => notebookPrompt(ctx, python, readySelected.length), [ctx, readySelected.length]);
  const retriever = useCallback(
    (history: Parameters<typeof retrieve>[1], question: string) => retrieve(readySelected, history, question),
    [readySelected],
  );
  const toggleSource = (id: number) => setOff((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleAll = (on: boolean) => setOff(on ? new Set() : new Set(sources.map((s) => s.id)));

  const openCitation = useCallback((sourceId: number, unit: number) => setSheet({ id: sourceId, unit }), []);
  const deck = center.kind === 'deck' ? decks.find((d) => d.id === center.id) : undefined;
  useEffect(() => {
    if (center.kind === 'deck' || center.kind === 'play') seen('cards', center.kind === 'deck' ? center.id : center.deckId);
    if (center.kind === 'quiz' || center.kind === 'quizrun') seen('quiz', center.id);
  }, [center, seen]);
  const [openQuiz, setOpenQuiz] = useState<Quiz | null>(null);
  const quizId = center.kind === 'quiz' ? center.id : null;
  const reloadQuiz = useCallback(() => {
    if (quizId === null) { setOpenQuiz(null); return; }
    studyApi.quiz(quizId).then(setOpenQuiz).catch(() => setOpenQuiz(null));
  }, [quizId]);
  useEffect(reloadQuiz, [reloadQuiz]);
  const source = center.kind === 'source' ? sources.find((s) => s.id === center.id) : undefined;
  const sheetSource = sheet ? sources.find((s) => s.id === sheet.id) : undefined;

  // Playing a deck or taking a quiz takes over the window: the sidebar and the notebook's own chrome step aside.
  const immersive = isImmersive(center);
  // A layout effect, so the page is already in its new shape when a view transition pictures it.
  useLayoutEffect(() => {
    const root = document.documentElement;
    if (immersive) root.dataset.immersive = '';
    else delete root.dataset.immersive;
    return () => { delete root.dataset.immersive; };
  }, [immersive]);

  // Arriving from Home with "carry on": go straight back into the deck, where the player picks up its saved place.
  useEffect(() => {
    if (target?.type !== 'deck' || !target.play) return;
    let alive = true;
    Promise.all([studyApi.deckCards(target.id), studyApi.decks(notebook.id)]).then(([cards, all]) => {
      const d = all.find((x) => x.id === target.id);
      if (alive && d && cards.length) setCenter({ kind: 'play', deckId: d.id, cards: playOrder(cards), title: d.title, practice: false });
    }).catch(() => {});
    return () => { alive = false; };
    // Only on arrival: the target is a one-off instruction, not state to follow.
  }, []);

  const playDeck = async (id: number) => {
    const d = decks.find((x) => x.id === id);
    const cards = await studyApi.deckCards(id);
    if (d && cards.length) setCenter({ kind: 'play', deckId: id, cards: playOrder(cards), title: d.title, practice: false });
  };

  let body: React.ReactNode;
  if (center.kind === 'play') {
    body = <DeckPlayer key={`${center.deckId}-${center.cards.length}`} deckId={center.deckId} cards={center.cards} title={center.title} notebookId={notebook.id} practice={center.practice} onClose={() => setCenter({ kind: 'deck', id: center.deckId })} onFinished={changed} />;
  } else if (center.kind === 'deck' && deck) {
    body = <DeckView key={deck.id} deck={deck} notebookId={notebook.id} onBack={() => setCenter({ kind: 'cards' })} onChanged={changed} onPlay={(cards, title, practice) => setCenter({ kind: 'play', deckId: deck.id, cards, title, practice })} />;
  } else if (center.kind === 'quiz' && openQuiz?.id !== center.id) {
    body = <div className="stage"><div className="pane-empty center"><span className="dots"><i /><i /><i /></span></div></div>;
  } else if (center.kind === 'quiz' && openQuiz) {
    body = (
      <QuizView
        key={openQuiz.id}
        quiz={openQuiz}
        summary={quizzes.find((q) => q.id === openQuiz.id)}
        notebookId={notebook.id}
        ctx={ctx}
        onBack={() => setCenter({ kind: 'quizzes' })}
        onChanged={() => { changed(); reloadQuiz(); }}
        onPlay={(only, startAt) => setCenter({ kind: 'quizrun', id: openQuiz.id, only, startAt })}
      />
    );
  } else if (center.kind === 'quizrun') {
    body = (
      <QuizRunner
        key={`${center.id}-${center.only?.join(',') ?? 'all'}`}
        quizId={center.id}
        notebookId={notebook.id}
        onlyIndexes={center.only}
        startAt={center.startAt}
        onClose={() => setCenter({ kind: 'quiz', id: center.id })}
        onFinished={changed}
      />
    );
  } else if (center.kind === 'note') {
    body = <NoteView key={center.id} noteId={center.id} notebookId={notebook.id} onBack={() => setCenter({ kind: 'notes' })} onChanged={reloadNotes} />;
  } else if (center.kind === 'source' && source) {
    body = <SourceViewer key={`${source.id}-${center.unit ?? ''}`} source={source} unit={center.unit} onClose={() => setCenter({ kind: 'sources' })} />;
  } else if (section === 'overview') {
    body = (
      <NotebookOverview
        notebook={notebook}
        subject={subject}
        sources={sources}
        decks={decks}
        quizzes={quizzes}
        notes={notes}
        onChanged={actions.refresh}
        go={(s) => setCenter({ kind: s })}
        make={(kind) => setGenerating({ kind })}
      />
    );
  } else if (section === 'cards') {
    body = (
      <SetsPane
        kind="cards"
        rows={decks.map((d) => ({ id: d.id, title: d.title, count: d.cardCount, runs: d.runs, best: d.best, last: d.last }))}
        notebookId={notebook.id}
        fresh={fresh.cards}
        onOpen={(id) => setCenter({ kind: 'deck', id })}
        onPlay={(id) => void playDeck(id)}
        onGenerate={() => setGenerating({ kind: 'cards' })}
        onRename={async (id, name) => { await studyApi.renameDeck(id, name); changed(); }}
        onDelete={async (id) => { await studyApi.deleteDeck(id); changed(); }}
        deleteText={(r) => <>Delete <b>{r.title}</b> with its {plural(r.count, 'card')} and {plural(r.runs, 'saved score')}?</>}
      />
    );
  } else if (section === 'quizzes') {
    body = (
      <SetsPane
        kind="quiz"
        rows={quizzes.map((q) => {
          const session = loadQuizSession(q.id);
          const answered = session && !session.reviewing ? Object.keys(session.answers).length : 0;
          return { id: q.id, title: q.title, count: q.questionCount, runs: q.attempts, best: q.best, last: q.last, extra: answered ? `${answered} answered so far` : undefined };
        })}
        notebookId={notebook.id}
        fresh={fresh.quiz}
        onOpen={(id) => setCenter({ kind: 'quiz', id })}
        onPlay={(id) => setCenter({ kind: 'quizrun', id })}
        onGenerate={() => setGenerating({ kind: 'quiz' })}
        onRename={async (id, title) => { await studyApi.renameQuiz(id, title); changed(); if (quizId === id) reloadQuiz(); }}
        onDelete={async (id) => { clearQuizSession(id); await studyApi.deleteQuiz(id); changed(); }}
        deleteText={(r) => <>Delete <b>{r.title}</b> and its {plural(r.runs, 'attempt')}? Its results leave the analytics too.</>}
      />
    );
  } else if (section === 'notes') {
    body = (
      <NotesPane
        notes={notes}
        onOpen={(n) => setCenter({ kind: 'note', id: n.id })}
        onGenerate={() => setGenerating({ kind: 'notes' })}
        onChanged={reloadNotes}
      />
    );
  } else if (section === 'sources') {
    body = (
      <SourcesLibrary
        notebookId={notebook.id}
        sources={sources}
        selected={selected}
        onToggle={toggleSource}
        onToggleAll={toggleAll}
        onOpen={(s) => setCenter({ kind: 'source', id: s.id })}
        onChanged={sourcesChanged}
      />
    );
  } else if (section === 'progress') {
    body = <div className="section-page"><Analytics notebookId={notebook.id} version={version} /></div>;
  } else {
    body = (
      <div className="chat-section">
        <div className="chat-bar" role="toolbar" aria-label="Chat controls">
          <div className="chat-bar-group">
            <MessageSquare className="chat-bar-glyph" aria-hidden />
            <Select className="select thread-select" value={String(thread ?? '')} onChange={(v) => setThread(v ? Number(v) : null)} title="Chats in this notebook"
              options={[{ value: '', label: 'New chat' }, ...threads.map((t) => ({ value: String(t.id), label: t.title || 'Untitled chat', hint: relTime(new Date(t.updatedAt)) }))]} />
            <span className="chat-bar-sep" aria-hidden />
            <button type="button" className="icon-btn" onClick={() => setThread(null)} title="Start a new chat" aria-label="Start a new chat"><Plus /></button>
            <button type="button" className="icon-btn" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setClearMenu({ x: r.left, y: r.bottom + 6 }); }} title="Clear chats…" aria-label="Clear chats"><Eraser /></button>
          </div>
          <span className="spacer" />
          <SourcePicker sources={sources} selected={selected} onToggle={toggleSource} onToggleAll={toggleAll} onManage={() => setCenter({ kind: 'sources' })} />
        </div>
        {threadsLoaded ? (
          <ChatView
            threadId={thread}
            notebookId={notebook.id}
            system={system}
            retrieve={readySelected.length ? retriever : undefined}
            agent="notebook"
            sourceIds={readySelected.map((s) => s.id)}
            onCite={openCitation}
            reloadToken={chatReload}
            emptyTitle={`Ask about ${notebook.name}`}
            emptyHint={readySelected.length
              ? `Answers come from your ${readySelected.length} source${readySelected.length === 1 ? '' : 's'}, and say which page each point came from.`
              : 'Add sources and answers will come from them, with the page each point came from. You can also attach files or ask for a graph.'}
            placeholder={`Ask anything about ${notebook.name}`}
            suggestions={readySelected.length ? [
              'Summarise the key ideas in these sources',
              'What is most likely to come up on the exam?',
              'Explain the hardest concept here in simple terms',
              'Give me a practice problem with a full solution',
            ] : undefined}
            onThreadCreated={(t) => { setThread(t.id); reloadThreads(); }}
            onChanged={reloadThreads}
          />
        ) : null}
        {sheetSource && (
          <aside className="source-sheet" aria-label={sheetSource.title}>
            <SourceViewer key={`${sheetSource.id}-${sheet?.unit ?? ''}`} source={sheetSource} unit={sheet?.unit} onClose={() => setSheet(null)} />
          </aside>
        )}
      </div>
    );
  }

  const detail = !immersive && center.kind !== section;
  // How the body arrives: a new section slides in from the side of the tab it came from, one of
  // its decks, quizzes or notes rises in on top, and coming back out of one just fades.
  const order = SECTIONS.findIndex((x) => x.id === section);
  const came = useRef({ order, detail });
  const entry = useRef<'next' | 'prev' | 'deeper' | 'back'>('back');
  if (came.current.order !== order) entry.current = order > came.current.order ? 'next' : 'prev';
  else if (came.current.detail !== detail) entry.current = detail ? 'deeper' : 'back';
  came.current = { order, detail };

  return (
    <div className={`nb${immersive ? ' immersive' : ''}${detail ? ' detail' : ''}`} style={{ '--subject': subjectColor(subject) } as React.CSSProperties}>
      {!immersive && (
        <header className="nb-top">
          <ViewBar actions={
            <MoreMenu title="Notebook options" items={[
              { kind: 'item', label: 'Rename or describe…', icon: <Pencil />, onClick: () => actions.editNotebook(notebook) },
              { kind: 'sep' },
              { kind: 'item', label: 'Delete notebook…', icon: <Trash />, danger: true, onClick: () => actions.deleteNotebook(notebook) },
            ]} />
          }>
            <Crumbs items={[
              { label: 'Home', onClick: () => actions.open({ kind: 'study' }) },
              { label: subject.name, onClick: () => actions.open({ kind: 'subject', id: subject.id }) },
              { label: notebook.name },
            ]} />
          </ViewBar>
          <SectionBar
            value={section}
            onChange={(s) => setCenter({ kind: s })}
            counts={{ cards: decks.length, quizzes: quizzes.length, notes: notes.length, sources: sources.length }}
            busy={{ cards: writingDeck, quizzes: writingQuiz }}
          />
        </header>
      )}
      <main className={`nb-body section-${section}`} data-entry={entry.current} key={immersive ? 'immersive' : `${section}:${center.kind}`}>{body}</main>

      {generating && (
        <GenerateDialog
          kind={generating.kind}
          notebookId={notebook.id}
          sources={sources}
          initialThread={generating.thread}
          diagramSubject={suitsDiagrams(ctx)}
          onClose={() => setGenerating(null)}
          run={(src, _progress, instructions, options) => runGeneration(generating.kind, src, instructions, options)}
        />
      )}
      {clearMenu && (
        <ContextMenu x={clearMenu.x} y={clearMenu.y} onClose={() => setClearMenu(null)} items={[
          { kind: 'item', label: 'Clear this chat', icon: <Eraser />, disabled: !thread, onClick: () => setClearing('one') },
          { kind: 'item', label: 'Delete all chats in this notebook…', icon: <Trash />, danger: true, disabled: !threads.length, onClick: () => setClearing('all') },
        ]} />
      )}
      {clearing && (
        <ConfirmDialog title={clearing === 'one' ? 'Clear chat' : 'Delete all chats'} confirmLabel={clearing === 'one' ? 'Clear chat' : 'Delete all'} onClose={() => setClearing(null)}
          onConfirm={async () => {
            if (clearing === 'one' && thread) await studyApi.chatClear(thread);
            else { await studyApi.chatDeleteAll(notebook.id); setThread(null); }
            setChatReload((n) => n + 1);
            reloadThreads();
          }}>
          {clearing === 'one' ? 'Remove every message in this chat? The chat itself stays.' : `Delete all ${threads.length} chats in ${notebook.name}, with their messages and files?`}
        </ConfirmDialog>
      )}
    </div>
  );
}

/**
 * The notebook's front page: what it is, what it covers, and what to do next. With no sources
 * yet it is a three-step path; after that the summary, the quick actions and where things stand.
 */
function NotebookOverview({ notebook, subject, sources, decks, quizzes, notes, onChanged, go, make }: {
  notebook: NotebookSummary;
  subject: SubjectNode;
  sources: Source[];
  decks: Deck[];
  quizzes: QuizSummary[];
  notes: Note[];
  onChanged: () => void;
  go: (s: Section) => void;
  make: (kind: 'cards' | 'quiz' | 'notes') => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stale = overviewStale(notebook, sources);
  const reading = sources.some((s) => s.status === 'processing');
  const ready = sources.filter((s) => s.status === 'ready');
  const tried = useRef(false);

  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    try { await writeOverview(notebook, subject.name); onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }, [notebook, subject.name, onChanged]);

  useEffect(() => {
    if (stale && !reading && !busy && !tried.current) { tried.current = true; void run(); }
  }, [stale, reading, busy, run]);

  const steps = [
    { done: sources.length > 0, title: 'Add your course material', text: 'Lecture PDFs, slides, notes, photos of handwriting or a YouTube lecture.', action: <button type="button" className="btn primary" onClick={() => go('sources')}><Upload />Add sources</button> },
    { done: false, title: 'Ask questions about it', text: 'Every answer says which page it came from, so you can check it.', action: <button type="button" className="btn" onClick={() => go('chat')}><MessageSquare />Open chat</button> },
    { done: decks.length > 0 || quizzes.length > 0, title: 'Test yourself', text: 'Make flashcards and quizzes from the material, then play them until they stick.', action: <button type="button" className="btn" onClick={() => make('cards')}><Sparkles />Make flashcards</button> },
  ];

  return (
    <div className="section-page overview-page">
      <header className="nb-hero">
        <span className="subject-badge big"><SubjectIcon icon={subject.icon} name={subject.name} /></span>
        <div className="nb-hero-text">
          <span className="eyebrow">{subject.name}</span>
          <h1 className="h-display">{notebook.name}</h1>
          {notebook.description && <p>{notebook.description}</p>}
        </div>
      </header>

      {!sources.length ? (
        <ol className="get-started stagger">
          {steps.map((s, i) => (
            <li key={s.title} className={`step${s.done ? ' done' : ''}`} style={{ '--i': i } as React.CSSProperties}>
              <span className="step-n">{i + 1}</span>
              <div className="step-text"><b>{s.title}</b><span>{s.text}</span></div>
              {s.action}
            </li>
          ))}
        </ol>
      ) : (
        <div className="overview-grid">
          <section className="card-panel overview-summary">
            <div className="panel-title-row">
              <h2 className="panel-title">What this notebook covers</h2>
              <div className="overview-tools">
                {notebook.overviewAt > 0 && <span className="muted small">Written {relTime(new Date(notebook.overviewAt))}</span>}
                <button type="button" className="icon-btn small" onClick={() => void run()} disabled={busy} title="Write it again from the current sources">
                  <RefreshCw className={busy ? 'spin' : ''} />
                </button>
              </div>
            </div>
            {error && <div className="form-err">{error}</div>}
            {notebook.overview ? (
              <div className={`overview-body${busy ? ' dim' : ''}`}><Markdown text={notebook.overview} /></div>
            ) : busy ? (
              <div className="overview-waiting"><Loader2 className="spin" />Reading your sources…</div>
            ) : (
              <div className="overview-waiting">{ready.length ? 'No summary yet. Press refresh to have one written.' : 'A summary of the topics is written here once your sources are read.'}</div>
            )}
            {stale && notebook.overview && !busy && <p className="muted small">New sources were added since this was written.</p>}
          </section>

          <aside className="overview-side">
            <section className="card-panel quick">
              <h2 className="panel-title">Study this notebook</h2>
              <button type="button" className="quick-row" onClick={() => go('chat')}><span className="quick-icon"><MessageSquare /></span><span><b>Ask a question</b><small>Answers cite your sources</small></span></button>
              <button type="button" className="quick-row" onClick={() => make('cards')}><span className="quick-icon"><Layers /></span><span><b>Make flashcards</b><small>A deck from your material</small></span></button>
              <button type="button" className="quick-row" onClick={() => make('quiz')}><span className="quick-icon"><ListChecks /></span><span><b>Make a quiz</b><small>Practice questions, marked</small></span></button>
              <button type="button" className="quick-row" onClick={() => make('notes')}><span className="quick-icon"><NotebookPen /></span><span><b>Write notes</b><small>Summaries and cheat sheets</small></span></button>
            </section>
            <section className="card-panel tallies">
              {([
                ['sources', 'Sources', sources.length],
                ['cards', 'Decks', decks.length],
                ['quizzes', 'Quizzes', quizzes.length],
                ['notes', 'Notes', notes.length],
              ] as const).map(([s, label, n]) => (
                <button key={s} type="button" className="tally" onClick={() => go(s)}>
                  <span className="tally-num">{n}</span><span className="tally-label">{label}</span>
                </button>
              ))}
            </section>
          </aside>
        </div>
      )}
    </div>
  );
}
