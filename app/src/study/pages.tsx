import { useEffect, useMemo, useState } from 'react';
import { SyllabusPanel } from './Syllabus';
import { BookOpen, ChevronRight, Flame, GraduationCap, Layers, Library, ListChecks, NotebookPen, Paintbrush, Pencil, Play, Plus, Trash } from 'lucide-react';
import { ActivityHeatmap, streakOf } from '../components/ActivityHeatmap';
import { MoreMenu } from '../components/ContextMenu';
import { deckMarkedCount, loadDeckSession, loadQuizSession } from '../lib/studySession';
import { ActivityDay } from '../components/ActivityDay';
import { Modal } from '../components/Dialogs';
import { SUBJECT_COLORS, SUBJECT_ICONS, SubjectIcon, guessIcon, subjectColor } from '../components/subjectIcons';
import { usePomodoro } from '../lib/pomodoro';
import { ViewBar } from '../components/ViewBar';
import { studyApi, type NotebookSummary, type StudyEvent, type SubjectNode } from './api';

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
  | { type: 'deck'; id: number; play?: boolean }
  | { type: 'quiz'; id: number; run?: boolean }
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
          {i > 0 && <span className="crumb-sep" aria-hidden><ChevronRight /></span>}
          {it.onClick ? <button type="button" className="link" onClick={it.onClick}>{it.label}</button> : <span className="crumb-here">{it.label}</span>}
        </span>
      ))}
    </div>
  );
}

function NotebookCard({ nb, i, onOpen }: { nb: NotebookSummary; i: number; onOpen: () => void }) {
  const blurb = nb.description || nb.overview.replace(/^#+.*$/gm, '').replace(/[*$#-]/g, '').split('\n').find((l) => l.trim())?.trim();
  return (
    <button type="button" className="nb-card" onClick={onOpen} style={{ '--i': i } as React.CSSProperties}>
      <span className="nb-card-name">{nb.name}</span>
      <span className="nb-card-desc">{blurb || (nb.sourceCount ? 'Open it to see what it covers.' : 'Empty - add lecture material to get started.')}</span>
      <span className="nb-card-stats">
        <span title="Sources"><Library />{nb.sourceCount}</span>
        <span title="Flashcard decks"><Layers />{nb.deckCount}</span>
        <span title="Quizzes"><ListChecks />{nb.quizCount}</span>
        <span title="Notes"><NotebookPen />{nb.noteCount}</span>
      </span>
    </button>
  );
}

const greeting = () => { const h = new Date().getHours(); return h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; };

const DAY = 864e5;
const startOfDay = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
function whenLabel(t: number): string {
  const days = Math.round((startOfDay(t) - startOfDay(Date.now())) / DAY);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days < 7) return new Date(t).toLocaleDateString(undefined, { weekday: 'long' });
  return new Date(t).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
const inDays = (t: number) => Math.round((startOfDay(t) - startOfDay(Date.now())) / DAY);

/** A quiz or deck that is started or new but not finished, and how to get straight back into it. */
type Resume = {
  key: string;
  kind: 'quiz' | 'deck';
  id: number;
  notebookId: number;
  title: string;
  where: string;
  detail: string;
  action: string;
  color: string;
  progress: number | null;
  rank: number;
};

const RESUME_LIMIT = 3;

/**
 * The few quizzes and decks you touched last and have not finished: one you are part way through
 * first, by when you last answered in it, then any made recently that you have not opened yet.
 * Finished ones never show here, however they went.
 */
function useResumable(tree: SubjectNode[]): Resume[] | null {
  const [items, setItems] = useState<Resume[] | null>(null);
  const shape = tree.map((s) => s.notebooks.map((n) => `${n.id}:${n.quizCount}:${n.deckCount}`).join(',')).join('|');
  useEffect(() => {
    let alive = true;
    const nbs = tree.flatMap((s) => s.notebooks.map((n) => ({ n, s })));
    Promise.all(nbs.map(async ({ n, s }) => {
      const out: Resume[] = [];
      const where = `${s.name} · ${n.name}`;
      const color = subjectColor(s);
      if (n.quizCount) {
        for (const q of await studyApi.quizzes(n.id).catch(() => [])) {
          const session = loadQuizSession(q.id);
          const answered = session && !session.reviewing ? Object.keys(session.answers).length : 0;
          if (answered && answered < q.questionCount) {
            out.push({ key: `q${q.id}`, kind: 'quiz', id: q.id, notebookId: n.id, title: q.title, where, color,
              detail: `${answered} of ${q.questionCount} answered`, action: 'Continue', progress: answered / q.questionCount, rank: 1e13 + (session?.updatedAt ?? 0) });
          } else if (!q.attempts && !answered && Date.now() - q.createdAt < 14 * DAY) {
            out.push({ key: `q${q.id}`, kind: 'quiz', id: q.id, notebookId: n.id, title: q.title, where, color,
              detail: `${plural(q.questionCount, 'question')} · not started`, action: 'Start', progress: null, rank: q.createdAt });
          }
        }
      }
      if (n.deckCount) {
        for (const d of await studyApi.decks(n.id).catch(() => [])) {
          const session = loadDeckSession(d.id);
          const seen = session ? deckMarkedCount(session) : 0;
          if (session && seen > 0 && seen < session.order.length) {
            out.push({ key: `d${d.id}`, kind: 'deck', id: d.id, notebookId: n.id, title: d.title, where, color,
              detail: `${seen} of ${session.order.length} cards seen`, action: 'Continue', progress: seen / session.order.length, rank: 1e13 + session.updatedAt });
          } else if (!d.runs && !seen && Date.now() - d.createdAt < 14 * DAY) {
            out.push({ key: `d${d.id}`, kind: 'deck', id: d.id, notebookId: n.id, title: d.title, where, color,
              detail: `${plural(d.cardCount, 'card')} · not played`, action: 'Play', progress: null, rank: d.createdAt });
          }
        }
      }
      return out;
    })).then((all) => { if (alive) setItems(all.flat().sort((a, b) => b.rank - a.rank).slice(0, RESUME_LIMIT)); }).catch(() => { if (alive) setItems([]); });
    return () => { alive = false; };
    // Only the notebooks and their counts decide what there is to load.
  }, [shape]);
  return items;
}

export function StudyHome({ tree, actions }: { tree: SubjectNode[]; actions: StudyActions }) {
  const [times, setTimes] = useState<number[]>([]);
  const [upcoming, setUpcoming] = useState<StudyEvent[]>([]);
  const [styling, setStyling] = useState<SubjectNode | null>(null);
  const [pickedDay, setPickedDay] = useState<number | null>(null);
  const pomo = usePomodoro();
  const resume = useResumable(tree);

  useEffect(() => {
    const since = Date.now() - 371 * DAY;
    studyApi.activity(since).then(setTimes).catch(() => setTimes([]));
    studyApi.events(Date.now() - DAY, Date.now() + 30 * DAY)
      .then((e) => setUpcoming(e.filter((x) => !x.done && (x.endAt ?? x.startAt) >= Date.now() - 3600_000).slice(0, 6)))
      .catch(() => setUpcoming([]));
  }, []);

  const allTimes = useMemo(() => [...times, ...pomo.history.filter((h) => h.phase === 'focus' && h.completed).map((h) => h.end)], [times, pomo.history]);
  const streak = useMemo(() => streakOf(allTimes), [allTimes]);
  const nbs = tree.flatMap((s) => s.notebooks);
  const sum = (k: keyof NotebookSummary) => nbs.reduce((a, n) => a + (n[k] as number), 0);
  const exam = upcoming.find((e) => e.kind === 'exam');
  const headline = !tree.length
    ? 'Start by adding a subject for each course you take.'
    : exam
      ? `${exam.title} ${inDays(exam.startAt) <= 0 ? 'is today' : inDays(exam.startAt) === 1 ? 'is tomorrow' : `is in ${inDays(exam.startAt)} days`}.`
      : resume?.length
        ? 'Pick a subject, or carry on where you left off.'
        : `${plural(tree.length, 'subject')} and ${plural(nbs.length, 'notebook')}.`;

  const subjectMenu = (s: SubjectNode) => [
    { kind: 'item' as const, label: 'New notebook…', icon: <Plus />, onClick: () => actions.newNotebook(s.id) },
    { kind: 'item' as const, label: 'Icon and colour…', icon: <Paintbrush />, onClick: () => setStyling(s) },
    { kind: 'item' as const, label: 'Rename…', icon: <Pencil />, onClick: () => actions.renameSubject(s) },
    { kind: 'sep' as const },
    { kind: 'item' as const, label: 'Delete subject…', icon: <Trash />, danger: true, onClick: () => actions.deleteSubject(s) },
  ];

  return (
    <div className="view">
      <ViewBar actions={<button type="button" className="btn" onClick={actions.newSubject}><Plus />New subject</button>}>
        <span className="viewbar-name">Home</span>
      </ViewBar>
      <div className="page home">
        <header className="home-hero">
          <div className="home-hero-text">
            <span className="eyebrow">{new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</span>
            <h1 className="h-display">{greeting()}</h1>
            <p>{headline}</p>
          </div>
          {streak > 0 && (
            <div className="home-streak" title="Days in a row you have studied">
              <Flame /><span><b>{streak}</b> day{streak === 1 ? '' : 's'} in a row</span>
            </div>
          )}
        </header>

        {pickedDay !== null && (
          <ActivityDay day={pickedDay} onClose={() => setPickedDay(null)} onOpenNotebook={(id) => actions.open({ kind: 'notebook', id })} />
        )}

        <div className="home-grid">
          <div className="home-main">
            <section className="page-section">
              <h2 className="section-title">Subjects</h2>
              {tree.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-icon"><GraduationCap /></div>
                  <h3>Add your first subject</h3>
                  <p>A subject is one of your courses, like Calculus II. Inside it, notebooks hold the material, chats, notes, flashcards and quizzes for each topic or exam.</p>
                  <div className="empty-actions"><button type="button" className="btn primary large" onClick={actions.newSubject}><Plus />Add a subject</button></div>
                </div>
              ) : (
                <div className="subject-grid stagger">
                  {tree.map((s, i) => {
                    const sources = s.notebooks.reduce((a, n) => a + n.sourceCount, 0);
                    return (
                      <article key={s.id} className="subject-card" style={{ '--i': i, '--subject': subjectColor(s) } as React.CSSProperties}>
                        <button type="button" className="subject-card-main" onClick={() => actions.open({ kind: 'subject', id: s.id })}>
                          <span className="subject-badge"><SubjectIcon icon={s.icon} name={s.name} /></span>
                          <span className="subject-name">{s.name}</span>
                          <span className="subject-meta">{plural(s.notebooks.length, 'notebook')} · {plural(sources, 'source')}</span>
                        </button>
                        <div className="subject-notebooks">
                          {s.notebooks.slice(0, 4).map((n) => (
                            <button type="button" key={n.id} className="nb-chip" onClick={() => actions.open({ kind: 'notebook', id: n.id })}>{n.name}</button>
                          ))}
                          {s.notebooks.length > 4 && <button type="button" className="nb-chip more" onClick={() => actions.open({ kind: 'subject', id: s.id })}>+{s.notebooks.length - 4} more</button>}
                          {!s.notebooks.length && <button type="button" className="nb-chip add" onClick={() => actions.newNotebook(s.id)}><Plus />Add a notebook</button>}
                        </div>
                        <MoreMenu items={subjectMenu(s)} title={`More for ${s.name}`} className="subject-more" />
                      </article>
                    );
                  })}
                  <button type="button" className="subject-card add" onClick={actions.newSubject} style={{ '--i': tree.length } as React.CSSProperties}><Plus />New subject</button>
                </div>
              )}
            </section>
            {!!resume?.length && (
              <section className="page-section">
                <h2 className="section-title">Continue studying</h2>
                <div className="resume-grid stagger">
                  {resume.map((r, i) => (
                    <button key={r.key} type="button" className="resume-card" style={{ '--i': i, '--subject': r.color } as React.CSSProperties}
                      onClick={() => actions.open({ kind: 'notebook', id: r.notebookId, open: r.kind === 'quiz' ? { type: 'quiz', id: r.id, run: true } : { type: 'deck', id: r.id, play: true } })}>
                      <span className="resume-head">
                        <span className="resume-icon">{r.kind === 'quiz' ? <ListChecks /> : <Layers />}</span>
                        <span className="resume-kind">{r.kind === 'quiz' ? 'Quiz' : 'Flashcards'}</span>
                        <span className="resume-go"><Play />{r.action}</span>
                      </span>
                      <span className="resume-title" title={r.title}>{r.title}</span>
                      <span className="resume-where" title={r.where}>{r.where}</span>
                      <span className="resume-foot">
                        <span className="resume-detail">{r.detail}</span>
                        {r.progress !== null && <span className="resume-bar"><i style={{ width: `${Math.round(r.progress * 100)}%` }} /></span>}
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            )}
          </div>

          <aside className="home-side">
            <section className="card-panel home-upcoming">
              <div className="panel-title-row">
                <h2 className="panel-title">Coming up</h2>
                <button type="button" className="link accent" onClick={() => actions.open({ kind: 'schedule' })}>Schedule<ChevronRight /></button>
              </div>
              {!upcoming.length ? (
                <p className="muted small">Nothing in the next 30 days. Add exams and deadlines in Schedule, or ask the assistant to.</p>
              ) : (
                <ul className="upcoming-list">
                  {upcoming.map((e) => (
                    <li key={e.id}>
                      <button type="button" className="upcoming-row" onClick={() => actions.open({ kind: 'schedule' })}>
                        <span className={`kind-dot ${e.kind}`} />
                        <span className="upcoming-text">
                          <span className="upcoming-title">{e.title}</span>
                          <span className="upcoming-when">{whenLabel(e.startAt)}{!e.allDay && ` · ${new Date(e.startAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`}</span>
                        </span>
                        {e.kind === 'exam' && inDays(e.startAt) > 1 && <span className="upcoming-count">{inDays(e.startAt)}d</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="card-panel home-activity">
              <h2 className="panel-title">Your activity</h2>
              <ActivityHeatmap times={allTimes} onPickDay={setPickedDay} />
            </section>

            <section className="card-panel home-totals">
              {([
                [<Library key="i" />, 'Sources', sum('sourceCount')],
                [<Layers key="i" />, 'Flashcards', sum('cardCount')],
                [<ListChecks key="i" />, 'Quizzes', sum('quizCount')],
                [<NotebookPen key="i" />, 'Notes', sum('noteCount')],
              ] as const).map(([icon, label, n]) => (
                <div key={label} className="home-total">{icon}<span>{label}</span><b>{n}</b></div>
              ))}
            </section>
          </aside>
        </div>
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
  const [events, setEvents] = useState<StudyEvent[]>([]);
  useEffect(() => { setContext(subject.context); setSaved('idle'); }, [subject.id, subject.context]);
  useEffect(() => {
    studyApi.events(Date.now() - DAY, Date.now() + 60 * DAY)
      .then((all) => setEvents(all.filter((e) => e.subjectId === subject.id && !e.done).slice(0, 5)))
      .catch(() => setEvents([]));
  }, [subject.id]);

  const saveContext = async () => {
    if (context === subject.context) return;
    setSaved('saving');
    try { await actions.saveSubjectContext(subject.id, context); setSaved('saved'); } catch { setSaved('error'); }
  };
  const sources = subject.notebooks.reduce((a, n) => a + n.sourceCount, 0);
  const cards = subject.notebooks.reduce((a, n) => a + n.cardCount, 0);

  return (
    <div className="view" style={{ '--subject': subjectColor(subject) } as React.CSSProperties}>
      <ViewBar actions={<>
        <button type="button" className="btn" onClick={() => actions.newNotebook(subject.id)}><Plus />New notebook</button>
        <MoreMenu title="Subject options" items={[
          { kind: 'item', label: 'Icon and colour…', icon: <Paintbrush />, onClick: () => setStyling(true) },
          { kind: 'item', label: 'Rename…', icon: <Pencil />, onClick: () => actions.renameSubject(subject) },
          { kind: 'sep' },
          { kind: 'item', label: 'Delete subject…', icon: <Trash />, danger: true, onClick: () => actions.deleteSubject(subject) },
        ]} />
      </>}>
        <Crumbs items={[{ label: 'Home', onClick: () => actions.open({ kind: 'study' }) }, { label: subject.name }]} />
      </ViewBar>
      <div className="page">
        <header className="subject-hero">
          <button type="button" className="subject-badge big" onClick={() => setStyling(true)} title="Change the icon and colour">
            <SubjectIcon icon={subject.icon} name={subject.name} />
          </button>
          <div>
            <h1 className="h-display">{subject.name}</h1>
            <p>{plural(subject.notebooks.length, 'notebook')} · {plural(sources, 'source')} · {plural(cards, 'flashcard')}</p>
          </div>
        </header>

        <div className="subject-layout">
          <section className="subject-main">
            <h2 className="section-title">Notebooks</h2>
            {!subject.notebooks.length ? (
              <div className="empty-state compact">
                <div className="empty-icon"><BookOpen /></div>
                <h3>No notebooks yet</h3>
                <p>A notebook holds one topic or exam: its lecture material, a chat about it, notes, flashcards and quizzes.</p>
                <div className="empty-actions"><button type="button" className="btn primary" onClick={() => actions.newNotebook(subject.id)}><Plus />Add a notebook</button></div>
              </div>
            ) : (
              <div className="nb-grid stagger">
                {subject.notebooks.map((nb, i) => (
                  <NotebookCard key={nb.id} nb={nb} i={i} onOpen={() => actions.open({ kind: 'notebook', id: nb.id })} />
                ))}
                <button type="button" className="nb-card add" onClick={() => actions.newNotebook(subject.id)} style={{ '--i': subject.notebooks.length } as React.CSSProperties}><Plus />New notebook</button>
              </div>
            )}
          </section>

          <aside className="subject-side">
            <section className="card-panel">
              <div className="panel-title-row">
                <h2 className="panel-title">Coming up</h2>
                <button type="button" className="link accent" onClick={() => actions.open({ kind: 'schedule' })}>Schedule<ChevronRight /></button>
              </div>
              {!events.length ? <p className="muted small">No exams or deadlines for {subject.name} yet. Add the syllabus and its dates are found for you.</p> : (
                <ul className="upcoming-list">
                  {events.map((e) => (
                    <li key={e.id}>
                      <button type="button" className="upcoming-row" onClick={() => actions.open({ kind: 'schedule' })}>
                        <span className={`kind-dot ${e.kind}`} />
                        <span className="upcoming-text">
                          <span className="upcoming-title">{e.title}</span>
                          <span className="upcoming-when">{whenLabel(e.startAt)}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <SyllabusPanel subject={subject} onChanged={actions.refresh} />

            <section className="card-panel">
              <h2 className="panel-title">Notes for the tutor</h2>
              <p className="muted small context-help">How your professor writes things and what the exam is like. Every notebook's chat, flashcards and quizzes follow it.</p>
              <textarea
                className="textarea"
                rows={5}
                value={context}
                placeholder="e.g. Vectors are written in bold and ln means natural log. Midterm: 5 problems, no calculator."
                onChange={(e) => { setContext(e.target.value); setSaved('idle'); }}
                onBlur={saveContext}
              />
              <div className="field-status">
                {saved === 'saving' ? 'Saving…' : saved === 'saved' ? 'Saved' : saved === 'error' ? <span className="warn">Could not save</span> : context !== subject.context ? 'Saves when you click away' : ''}
              </div>
            </section>
          </aside>
        </div>
      </div>
      {styling && <SubjectStyleDialog subject={subject} onClose={() => setStyling(false)} onSaved={actions.refresh} />}
    </div>
  );
}

export { NotebookPage } from './Notebook';
