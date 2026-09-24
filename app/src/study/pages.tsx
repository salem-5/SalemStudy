import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Select } from '../components/Select';
import { dropEmpty } from '../lib/chatThreads';
import { SyllabusPanel } from './Syllabus';
import { courseContextOf } from '../lib/syllabus';
import { BookOpenText, ChartColumn, Paintbrush, Loader2, Eraser, RefreshCw, MessageSquare, Pencil, Plus, Trash } from 'lucide-react';
import { ChatView } from '../components/chat/ChatView';
import { ActivityHeatmap } from '../components/ActivityHeatmap';
import { ActivityDay } from '../components/ActivityDay';
import { Modal } from '../components/Dialogs';
import { SUBJECT_COLORS, SUBJECT_ICONS, SubjectIcon, guessIcon, subjectColor } from '../components/subjectIcons';
import { usePomodoro } from '../lib/pomodoro';
import { ViewBar } from '../components/ViewBar';
import { type GenSource, type StudyContext, type QuizOptions, type CardOptions } from '../lib/studyGen';
import { makeSet } from '../lib/makeSet';
import { clearQuizSession, loadQuizSession } from '../lib/studySession';
import { notebookPrompt } from '../lib/prompts';
import { retrieve } from '../lib/retrieval';
import {studyApi, type Card, type ChatThread, type Deck, type Note, type NotebookSummary, type StudyEvent, type QuizSummary, type Source, type SubjectNode, type Quiz } from './api';
import { Analytics } from './Analytics';
import { DeckPlayer, DeckView, GenerateDialog, playOrder } from './Flashcards';
import { QuizRunner, QuizView } from './Quizzes';
import { SetsPane, startSet, useSetBusy, type SetKind } from './StudySets';
import { SourcesPane, SourceViewer } from './Sources';
import { NotesPane, NoteView } from './Notes';
import { writeNote } from '../lib/notesGen';
import { overviewStale, writeOverview } from '../lib/overview';
import { Markdown } from '../lib/markdown';
import { relTime } from '../lib/format';
import { ContextMenu } from '../components/ContextMenu';
import { ConfirmDialog, NameDialog } from './dialogs';

export type Route =
  | { kind: 'solver' }
  | { kind: 'study' }
  | { kind: 'chat'; id?: number | null }
  | { kind: 'focus' }
  | { kind: 'subject'; id: number }
  | { kind: 'schedule' }
  | { kind: 'notes'; id?: number | null }
  | { kind: 'notebook'; id: number; open?: NotebookTarget };

export type NotebookTarget =
  | { type: 'source'; id: number; unit?: number }
  | { type: 'note'; id: number }
  | { type: 'deck'; id: number }
  | { type: 'chat'; id: number };

export type StudyActions = {
  open: (r: Route) => void;
  newSubject: () => void;
  newNotebook: (subjectId: number) => void;
  renameSubject: (s: SubjectNode) => void;
  deleteSubject: (s: SubjectNode) => void;
  editNotebook: (n: NotebookSummary) => void;
  deleteNotebook: (n: NotebookSummary) => void;
  saveSubjectContext: (id: number, context: string) => Promise<void>;
  refresh: () => void;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function Crumbs({ items }: { items: { label: string; onClick?: () => void }[] }) {
  return (
    <div className="page-crumbs">
      {items.map((it, i) => (
        <span key={i} className="crumb">
          {i > 0 && <span className="crumb-sep">/</span>}
          {it.onClick ? <button type="button" className="link" onClick={it.onClick}>{it.label}</button> : <span className="crumb-here">{it.label}</span>}
        </span>
      ))}
    </div>
  );
}

function NotebookCard({ nb, i, onOpen }: { nb: NotebookSummary; i: number; onOpen: () => void }) {
  return (
    <button type="button" className="nb-card" onClick={onOpen} style={{ '--i': i } as React.CSSProperties}>
      <span className="nb-card-name">{nb.name}</span>
      {(nb.description || nb.overview) && <span className="nb-card-desc">{nb.description || nb.overview.replace(/^#+.*$/gm, '').replace(/[*$#-]/g, '').split('\n').find((l) => l.trim())?.trim()}</span>}
      <span className="nb-card-stats">
        <span>{plural(nb.sourceCount, 'source')}</span>
        <span>{plural(nb.deckCount, 'deck')}</span>
        <span>{plural(nb.quizCount, 'quiz', 'quizzes')}</span>
      </span>
    </button>
  );
}

const greeting = () => { const h = new Date().getHours(); return h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; };

export function StudyHome({ tree, actions }: { tree: SubjectNode[]; actions: StudyActions }) {
  const [times, setTimes] = useState<number[]>([]);
  const [upcoming, setUpcoming] = useState<StudyEvent[]>([]);
  const [styling, setStyling] = useState<SubjectNode | null>(null);
  const pomo = usePomodoro();

  useEffect(() => {
    const since = Date.now() - 371 * 864e5;
    studyApi.activity(since).then(setTimes).catch(() => setTimes([]));
    studyApi.events(Date.now() - 864e5, Date.now() + 30 * 864e5)
      .then((e) => setUpcoming(e.filter((x) => !x.done && (x.endAt ?? x.startAt) >= Date.now() - 3600_000).slice(0, 5)))
      .catch(() => setUpcoming([]));
  }, []);

  const [pickedDay, setPickedDay] = useState<number | null>(null);

  const allTimes = useMemo(() => [...times, ...pomo.history.filter((h) => h.phase === 'focus' && h.completed).map((h) => h.end)], [times, pomo.history]);
  const nbs = tree.flatMap((s) => s.notebooks);
  const sum = (k: keyof NotebookSummary) => nbs.reduce((a, n) => a + (n[k] as number), 0);

  return (
    <div className="view">
      <ViewBar actions={<button type="button" className="btn" onClick={actions.newSubject}><Plus />New subject</button>}>
        <Crumbs items={[{ label: 'Study' }]} />
      </ViewBar>
      <div className="page home">
        <section className="home-hero">
          <div>
            <h1 className="home-title">{greeting()}</h1>
            <p className="muted">{tree.length ? `${tree.length} subject${tree.length === 1 ? '' : 's'}, ${nbs.length} notebook${nbs.length === 1 ? '' : 's'}.` : 'Start by adding a subject for each course you take.'}</p>
          </div>
          <div className="home-stats stagger">
            {([['Sources', sum('sourceCount')], ['Notes', sum('noteCount')], ['Decks', sum('deckCount')], ['Cards', sum('cardCount')], ['Quizzes', sum('quizCount')]] as const).map(([label, n], i) => (
              <div key={label} className="home-stat" style={{ '--i': i } as React.CSSProperties}><span className="home-stat-num">{n}</span><span className="muted">{label}</span></div>
            ))}
          </div>
        </section>

        {pickedDay !== null && (
          <ActivityDay
            day={pickedDay}
            onClose={() => setPickedDay(null)}
            onOpenNotebook={(id) => actions.open({ kind: 'notebook', id })}
          />
        )}

        <section className="home-grid">
          <div className="card-panel home-activity">
            <div className="panel-title">Activity</div>
            <ActivityHeatmap times={allTimes} onPickDay={setPickedDay} />
          </div>
          <div className="card-panel home-upcoming">
            <div className="panel-title-row">
              <span className="panel-title">Coming up</span>
              <button type="button" className="link" onClick={() => actions.open({ kind: 'schedule' })}>schedule →</button>
            </div>
            {!upcoming.length && <p className="muted small">Nothing in the next 30 days. Add exams and deadlines in Schedule, or ask the assistant to.</p>}
            {upcoming.map((e) => (
              <button type="button" key={e.id} className="upcoming-row" onClick={() => actions.open({ kind: 'schedule' })}>
                <span className={`kind-dot ${e.kind}`} />
                <span className="upcoming-title">{e.title}</span>
                <span className="muted">{new Date(e.startAt).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="page-section">
          <h2 className="section-title">Subjects</h2>
          {tree.length === 0 ? (
            <div className="page-empty">
              <p className="muted">A subject is a course, like Calculus II. Each one holds notebooks, and every notebook has its own sources, chat, notes, flashcards and quizzes.</p>
              <button type="button" className="btn primary" onClick={actions.newSubject}><Plus />Create a subject</button>
            </div>
          ) : (
            <div className="subject-grid stagger">
              {tree.map((s, i) => {
                const color = subjectColor(s);
                return (
                  <article
                    key={s.id}
                    className="subject-card"
                    style={{ '--i': i, '--subject': color } as React.CSSProperties}
                    onClick={(e) => { if (!(e.target as HTMLElement).closest('.nb-chip, .subject-style')) actions.open({ kind: 'subject', id: s.id }); }}
                  >
                    <button type="button" className="subject-card-main">
                      <span className="subject-badge"><SubjectIcon icon={s.icon} name={s.name} /></span>
                      <span className="subject-name">{s.name}</span>
                      <span className="subject-meta">
                        {plural(s.notebooks.length, 'notebook')} · {plural(s.notebooks.reduce((a, n) => a + n.sourceCount, 0), 'source')} · {plural(s.notebooks.reduce((a, n) => a + n.deckCount, 0), 'deck')}
                      </span>
                    </button>
                    <div className="subject-notebooks">
                      {s.notebooks.slice(0, 5).map((n) => (
                        <button type="button" key={n.id} className="nb-chip" onClick={() => actions.open({ kind: 'notebook', id: n.id })}>{n.name}</button>
                      ))}
                      {s.notebooks.length > 5 && <span className="muted small">+{s.notebooks.length - 5}</span>}
                      <button type="button" className="nb-chip add" onClick={() => actions.newNotebook(s.id)}><Plus /></button>
                    </div>
                    <button type="button" className="icon-btn ghost-icon subject-style" onClick={() => setStyling(s)} title="Icon and colour"><Paintbrush /></button>
                  </article>
                );
              })}
              <button type="button" className="subject-card add" onClick={actions.newSubject} style={{ '--i': tree.length } as React.CSSProperties}><Plus />New subject</button>
            </div>
          )}
        </section>
      </div>
      {styling && <SubjectStyleDialog subject={styling} onClose={() => setStyling(null)} onSaved={actions.refresh} />}
    </div>
  );
}

export function SubjectStyleDialog({ subject, onClose, onSaved }: { subject: SubjectNode; onClose: () => void; onSaved: () => void }) {
  const [icon, setIcon] = useState(subject.icon || guessIcon(subject.name));
  const [color, setColor] = useState(subjectColor(subject));
  return (
    <Modal title={`Style ${subject.name}`} onClose={onClose}>
      <div className="form">
        <div className="style-preview" style={{ '--subject': color } as React.CSSProperties}>
          <span className="subject-badge big"><SubjectIcon icon={icon} name={subject.name} /></span>
          <span className="subject-name">{subject.name}</span>
        </div>
        <div className="field"><span>Icon</span>
          <div className="icon-grid">
            {Object.keys(SUBJECT_ICONS).map((k) => (
              <button type="button" key={k} className={`icon-choice${icon === k ? ' on' : ''}`} onClick={() => setIcon(k)} title={k}><SubjectIcon icon={k} name="" /></button>
            ))}
          </div>
        </div>
        <div className="field"><span>Colour</span>
          <div className="swatches">
            {SUBJECT_COLORS.map((c) => <button type="button" key={c} className={`swatch${color === c ? ' on' : ''}`} style={{ background: c }} onClick={() => setColor(c)} aria-label={c} />)}
          </div>
        </div>
      </div>
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" onClick={async () => { await studyApi.updateSubject(subject.id, { icon, color }); onSaved(); onClose(); }}>Save</button>
      </div>
    </Modal>
  );
}

export function SubjectPage({ subject, actions }: { subject: SubjectNode; actions: StudyActions }) {
  const [context, setContext] = useState(subject.context);
  const [saved, setSaved] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [styling, setStyling] = useState(false);
  useEffect(() => { setContext(subject.context); setSaved('idle'); }, [subject.id, subject.context]);

  const saveContext = async () => {
    if (context === subject.context) return;
    setSaved('saving');
    try { await actions.saveSubjectContext(subject.id, context); setSaved('saved'); } catch { setSaved('error'); }
  };

  return (
    <div className="view">
      <ViewBar actions={<>
        <button type="button" className="btn ghost" onClick={() => setStyling(true)}><Paintbrush /><span className="btn-label">Style</span></button>
        <button type="button" className="btn ghost" onClick={() => actions.renameSubject(subject)}><Pencil />Rename</button>
        <button type="button" className="btn ghost danger" onClick={() => actions.deleteSubject(subject)}><Trash />Delete</button>
      </>}>
        <Crumbs items={[{ label: 'Study', onClick: () => actions.open({ kind: 'study' }) }, { label: subject.name }]} />
      </ViewBar>
      <div className="page">
        <header className="subject-head" style={{ '--subject': subjectColor(subject) } as React.CSSProperties}>
          <span className="subject-badge big"><SubjectIcon icon={subject.icon} name={subject.name} /></span>
          <div>
            <h1 className="home-title">{subject.name}</h1>
            <p className="muted">{plural(subject.notebooks.length, 'notebook')} · {plural(subject.notebooks.reduce((a, n) => a + n.sourceCount, 0), 'source')} · {plural(subject.notebooks.reduce((a, n) => a + n.noteCount, 0), 'note')}</p>
          </div>
        </header>
        <section className="page-section">
          <h2 className="section-title">Notebooks <span className="muted">{subject.notebooks.length}</span></h2>
          <div className="nb-grid stagger">
            {subject.notebooks.map((nb, i) => (
              <NotebookCard key={nb.id} nb={nb} i={i} onOpen={() => actions.open({ kind: 'notebook', id: nb.id })} />
            ))}
            <button type="button" className="nb-card add" onClick={() => actions.newNotebook(subject.id)} style={{ '--i': subject.notebooks.length } as React.CSSProperties}><Plus />New notebook</button>
          </div>
        </section>

        <SyllabusPanel subject={subject} onChanged={actions.refresh} />

        <section className="page-section">
          <h2 className="section-title">Course context</h2>
          <p className="muted small">
            Your own notes on notation and the exam format, shared by every notebook in {subject.name} (on top of the syllabus summary).
            Chat, flashcards and quizzes follow it; notebooks still only search their own sources.
          </p>
          <textarea
            className="textarea"
            rows={5}
            value={context}
            placeholder="e.g. The professor writes vectors in bold and uses ln for natural log. Midterm: 5 problems, no calculator."
            onChange={(e) => { setContext(e.target.value); setSaved('idle'); }}
            onBlur={saveContext}
          />
          <div className="field-status muted">
            {saved === 'saving' ? 'saving…' : saved === 'saved' ? 'saved' : saved === 'error' ? <span className="warn">could not save</span> : context !== subject.context ? 'unsaved - click away to save' : ''}
          </div>
        </section>
      </div>
      {styling && <SubjectStyleDialog subject={subject} onClose={() => setStyling(false)} onSaved={actions.refresh} />}
    </div>
  );
}

type RightTab = 'decks' | 'quizzes' | 'notes';
type Center =
  | { kind: 'chat' }
  | { kind: 'stats' }
  | { kind: 'overview' }
  | { kind: 'deck'; id: number }
  | { kind: 'play'; deckId: number; cards: Card[]; title: string; practice: boolean }
  | { kind: 'quiz'; id: number }
  | { kind: 'quizrun'; id: number; only?: number[]; startAt?: number }
  | { kind: 'source'; id: number; unit?: number }
  | { kind: 'note'; id: number };

export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: T[]; value: T; onChange: (t: T) => void; label: (t: T) => React.ReactNode }) {
  const i = Math.max(0, tabs.indexOf(value));
  return (
    <div className="tabs" role="tablist" style={{ '--n': tabs.length } as React.CSSProperties}>
      {tabs.map((t) => (
        <button type="button" role="tab" aria-selected={t === value} key={t} className={`tab${t === value ? ' on' : ''}`} onClick={() => onChange(t)}>{label(t)}</button>
      ))}
      <span className="tabs-glider" style={{ transform: `translateX(${i * 100}%)` }} />
    </div>
  );
}

const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { } },
};

export function NotebookPage({ notebook, subject, actions, target }: { notebook: NotebookSummary; subject: SubjectNode; actions: StudyActions; target?: NotebookTarget }) {
  const [tab, setTab] = useState<RightTab>('decks');
  const [center, setCenter] = useState<Center>(() => {
    if (target?.type === 'source') return { kind: 'source', id: target.id, unit: target.unit };
    if (target?.type === 'note') return { kind: 'note', id: target.id };
    if (target?.type === 'deck') return { kind: 'deck', id: target.id };
    return { kind: 'chat' };
  });
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
  const [newDeck, setNewDeck] = useState(false);
  const [version, setVersion] = useState(0);
  const offKey = `wa.nb.${notebook.id}.sourcesOff`;
  const [off, setOff] = useState<Set<number>>(() => { try { return new Set(JSON.parse(store.get(offKey) || '[]')); } catch { return new Set(); } });
  const [collapsed, setCollapsed] = useState(() => store.get('wa.sources.collapsed') === '1');

  useEffect(() => { store.set(offKey, JSON.stringify([...off])); }, [off, offKey]);
  useEffect(() => { store.set('wa.sources.collapsed', collapsed ? '1' : '0'); }, [collapsed]);

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
      setTab('notes');
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
    setTab(setKind === 'cards' ? 'decks' : 'quizzes');
    return '';
  };

  const readySelected = useMemo(() => sources.filter((s) => selected.has(s.id)), [sources, selected]);
  const system = useCallback((python: boolean) => notebookPrompt(ctx, python, readySelected.length), [ctx, readySelected.length]);
  const retriever = useCallback(
    (history: Parameters<typeof retrieve>[1], question: string) => retrieve(readySelected, history, question),
    [readySelected],
  );

  const openCitation = useCallback((sourceId: number, unit: number) => setCenter({ kind: 'source', id: sourceId, unit }), []);
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

  let body: React.ReactNode;
  if (center.kind === 'play') {
    body = <DeckPlayer key={`${center.deckId}-${center.cards.length}`} deckId={center.deckId} cards={center.cards} title={center.title} notebookId={notebook.id} practice={center.practice} onClose={() => setCenter({ kind: 'deck', id: center.deckId })} onFinished={changed} />;
  } else if (center.kind === 'deck' && deck) {
    body = <DeckView key={deck.id} deck={deck} notebookId={notebook.id} onBack={() => setCenter({ kind: 'chat' })} onChanged={changed} onPlay={(cards, title, practice) => setCenter({ kind: 'play', deckId: deck.id, cards, title, practice })} />;
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
        onBack={() => setCenter({ kind: 'chat' })}
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
    body = <NoteView key={center.id} noteId={center.id} notebookId={notebook.id} onBack={() => setCenter({ kind: 'chat' })} onChanged={reloadNotes} />;
  } else if (center.kind === 'source' && source) {
    body = <SourceViewer key={`${source.id}-${center.unit ?? ''}`} source={source} unit={center.unit} onClose={() => setCenter({ kind: 'chat' })} />;
  } else {
    body = (
      <>
        <div className="center-bar">
          <Tabs<'overview' | 'chat' | 'stats'>
            tabs={['overview', 'chat', 'stats']}
            value={center.kind === 'stats' ? 'stats' : center.kind === 'overview' ? 'overview' : 'chat'}
            onChange={(t) => setCenter({ kind: t })}
            label={(t) => (t === 'chat' ? <><MessageSquare />Chat</> : t === 'overview' ? <><BookOpenText />Overview</> : <><ChartColumn />Analytics</>)}
          />
          <span className="spacer" />
          {center.kind === 'chat' && (
            <>
              <Select className="select thread-select" value={String(thread ?? '')} onChange={(v) => setThread(v ? Number(v) : null)} title="Chats in this notebook"
                options={[{ value: '', label: 'New chat' }, ...threads.map((t) => ({ value: String(t.id), label: t.title || 'Untitled chat' }))]} />
              <button type="button" className="icon-btn" onClick={() => setThread(null)} title="New chat"><Plus /></button>
              <button type="button" className="icon-btn" onClick={(e) => setClearMenu({ x: e.clientX, y: e.clientY })} title="Clear chat…"><Eraser /></button>
            </>
          )}
        </div>
        {center.kind === 'overview' ? (
          <Overview notebook={notebook} subject={subject} sources={sources} onChanged={actions.refresh} />
        ) : center.kind === 'stats' ? (
          <Analytics notebookId={notebook.id} version={version} />
        ) : threadsLoaded ? (
          <ChatView
            threadId={thread}
            notebookId={notebook.id}
            system={system}
            retrieve={readySelected.length ? retriever : undefined}
            agent="notebook"
            sourceIds={readySelected.map((s) => s.id)}
            onCite={openCitation}
            reloadToken={chatReload}
            emptyTitle={`Chat with ${notebook.name}`}
            emptyHint={readySelected.length
              ? `Answers use your ${readySelected.length} selected source${readySelected.length === 1 ? '' : 's'} and cite where each point came from.`
              : 'Add sources on the left and answers will use them, with citations. You can also attach files or ask for a graph.'}
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
      </>
    );
  }

  return (
    <div className={`nbw${collapsed ? ' sources-collapsed' : ''}`}>
      <div className="nbw-head">
        <ViewBar actions={<>
          <button type="button" className="btn ghost" onClick={() => actions.editNotebook(notebook)}><Pencil />Edit</button>
          <button type="button" className="btn ghost danger" onClick={() => actions.deleteNotebook(notebook)}><Trash />Delete</button>
        </>}>
          <Crumbs items={[
            { label: 'Study', onClick: () => actions.open({ kind: 'study' }) },
            { label: subject.name, onClick: () => actions.open({ kind: 'subject', id: subject.id }) },
            { label: notebook.name },
          ]} />
        </ViewBar>
      </div>

      <SourcesPane
        notebookId={notebook.id}
        sources={sources}
        selected={selected}
        onToggle={(id) => setOff((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n; })}
        onToggleAll={(on) => setOff(on ? new Set() : new Set(sources.map((s) => s.id)))}
        collapsed={collapsed}
        onCollapse={setCollapsed}
        onOpen={(s) => setCenter({ kind: 'source', id: s.id })}
        onChanged={sourcesChanged}
      />

      <main className="nbw-center">{body}</main>

      <aside className="nbw-pane nbw-study">
        <Tabs<RightTab>
          tabs={['decks', 'quizzes', 'notes']}
          value={tab}
          onChange={setTab}
          label={(t) => (t === 'decks'
            ? <>Cards{writingDeck ? <Loader2 className="spin tab-busy" /> : decks.length > 0 && <span className="tab-count">{decks.length}</span>}</>
            : t === 'quizzes'
              ? <>Quizzes{writingQuiz ? <Loader2 className="spin tab-busy" /> : quizzes.length > 0 && <span className="tab-count">{quizzes.length}</span>}</>
              : <>Notes{notes.length > 0 && <span className="tab-count">{notes.length}</span>}</>)}
        />
        <div className="tab-panel" key={tab}>
          {tab === 'decks' ? (
            <SetsPane
              kind="cards"
              rows={decks.map((d) => ({ id: d.id, title: d.title, count: d.cardCount, runs: d.runs, best: d.best, last: d.last }))}
              notebookId={notebook.id}
              fresh={fresh.cards}
              onOpen={(id) => setCenter({ kind: 'deck', id })}
              onPlay={async (id) => {
                const d = decks.find((x) => x.id === id);
                const cards = await studyApi.deckCards(id);
                if (d && cards.length) setCenter({ kind: 'play', deckId: id, cards: playOrder(cards), title: d.title, practice: false });
              }}
              onGenerate={() => setGenerating({ kind: 'cards' })}
              onNew={() => setNewDeck(true)}
              onRename={async (id, name) => { await studyApi.renameDeck(id, name); changed(); }}
              onDelete={async (id) => {
                await studyApi.deleteDeck(id);
                if ((center.kind === 'deck' && center.id === id) || (center.kind === 'play' && center.deckId === id)) setCenter({ kind: 'chat' });
                changed();
              }}
              deleteText={(r) => <>Delete <b>{r.title}</b> with its {plural(r.count, 'card')} and {plural(r.runs, 'saved score')}?</>}
            />
          ) : tab === 'quizzes' ? (
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
              onDelete={async (id) => {
                clearQuizSession(id);
                await studyApi.deleteQuiz(id);
                if ((center.kind === 'quiz' || center.kind === 'quizrun') && center.id === id) setCenter({ kind: 'chat' });
                changed();
              }}
              deleteText={(r) => <>Delete <b>{r.title}</b> and its {plural(r.runs, 'attempt')}? Its results leave the analytics too.</>}
            />
          ) : (
            <NotesPane
              notes={notes}
              onOpen={(n) => setCenter({ kind: 'note', id: n.id })}
              onGenerate={() => setGenerating({ kind: 'notes' })}
              onBlank={async () => { const n = await studyApi.createNote(notebook.id, 'Untitled note', ''); reloadNotes(); setCenter({ kind: 'note', id: n.id }); }}
              onChanged={reloadNotes}
            />
          )}
        </div>
      </aside>

      {generating && (
        <GenerateDialog
          kind={generating.kind}
          notebookId={notebook.id}
          sources={sources}
          initialThread={generating.thread}
          onClose={() => setGenerating(null)}
          run={(src, _progress, instructions, options) => runGeneration(generating.kind, src, instructions, options)}
        />
      )}
      {newDeck && (
        <NameDialog title="New deck" label="Name" submitLabel="Create" onClose={() => setNewDeck(false)}
          onSubmit={async (name) => { const id = await studyApi.createDeck(notebook.id, name, []); changed(); setCenter({ kind: 'deck', id }); }} />
      )}
      {clearMenu && (
        <ContextMenu x={clearMenu.x} y={clearMenu.y} onClose={() => setClearMenu(null)} items={[
          { kind: 'item', label: 'Clear this chat', disabled: !thread, onClick: () => setClearing('one') },
          { kind: 'item', label: 'Delete all chats in this notebook…', danger: true, disabled: !threads.length, onClick: () => setClearing('all') },
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

function Overview({ notebook, subject, sources, onChanged }: { notebook: NotebookSummary; subject: SubjectNode; sources: Source[]; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stale = overviewStale(notebook, sources);
  const reading = sources.some((s) => s.status === 'processing');
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

  return (
    <div className="overview">
      <div className="overview-head">
        <span className="panel-title">What this notebook covers</span>
        <span className="spacer" />
        {notebook.overviewAt > 0 && <span className="muted small">{relTime(new Date(notebook.overviewAt))}</span>}
        <button type="button" className="btn ghost" onClick={() => void run()} disabled={busy} title="Write it again from the current sources">
          <RefreshCw className={busy ? 'spin' : ''} /><span className="btn-label">{busy ? 'Writing…' : 'Refresh'}</span>
        </button>
      </div>
      {error && <div className="form-err">{error}</div>}
      {notebook.overview ? (
        <div className={`overview-body${busy ? ' dim' : ''}`}><Markdown text={notebook.overview} /></div>
      ) : busy ? (
        <div className="pane-empty center"><Loader2 className="spin" /><p className="muted">Reading your sources…</p></div>
      ) : (
        <div className="pane-empty center">
          <p>No overview yet.</p>
          <p className="muted">{sources.some((s) => s.status === 'ready') ? 'Press Refresh to have one written.' : 'Add sources and an overview of their topics is written here.'}</p>
        </div>
      )}
      {stale && notebook.overview && !busy && <p className="muted small">New sources were added since this was written.</p>}
      <div className="overview-stats stagger">
        <div className="stat"><div className="stat-label">Sources</div><div className="stat-value">{notebook.sourceCount}</div></div>
        <div className="stat"><div className="stat-label">Notes</div><div className="stat-value">{notebook.noteCount}</div></div>
        <div className="stat"><div className="stat-label">Decks</div><div className="stat-value">{notebook.deckCount}</div><div className="stat-sub">{notebook.cardCount} cards</div></div>
        <div className="stat"><div className="stat-label">Quizzes</div><div className="stat-value">{notebook.quizCount}</div></div>
      </div>
    </div>
  );
}
