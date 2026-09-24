import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Select } from '../components/Select';
import { Bot, CalendarDays, Check, ChevronDown, ChevronUp, ClipboardCheck, FileUp, Pencil, Plus, Trash } from 'lucide-react';
import { Modal } from '../components/Dialogs';
import { api } from '../api';
import { ViewBar } from '../components/ViewBar';
import { parseDue } from '../lib/format';
import { describeChanges, loadCache, needsRefresh, reconcile, saveCache, type CachedAssignment } from '../lib/assignmentCache';
import { studyApi, type EventInput, type EventKind, type StudyEvent, type SubjectNode } from './api';
import type { Route } from './pages';
import { SyllabusDialog } from './Syllabus';
import { SubjectIcon, subjectColor } from '../components/subjectIcons';

export const KINDS: { kind: EventKind; label: string }[] = [
  { kind: 'exam', label: 'Exam' },
  { kind: 'deadline', label: 'Deadline' },
  { kind: 'study', label: 'Study session' },
  { kind: 'class', label: 'Class' },
  { kind: 'other', label: 'Other' },
];

const DAY = 864e5;
const NO_COURSE = '#7d858c';
const startOfDay = (t: number | Date) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d; };
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const fmtTime = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

type Due = {
  id: number;
  title: string;
  at: number;
  stale?: boolean;
  moved?: boolean;
};

function monthCells(month: Date): (Date | null)[] {
  const offset = (new Date(month.getFullYear(), month.getMonth(), 1).getDay() + 6) % 7;
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells = [...Array<null>(offset).fill(null), ...Array.from({ length: days }, (_, i) => new Date(month.getFullYear(), month.getMonth(), i + 1))];
  return [...cells, ...Array<null>((7 - (cells.length % 7)) % 7).fill(null)];
}

const monthOf = (base: Date, n: number) => new Date(base.getFullYear(), base.getMonth() + n, 1);
const monthId = (d: Date) => `cal-${d.getFullYear()}-${d.getMonth()}`;
const CHUNK = 6;

export function SchedulePage({ tree, open, refreshTree, reload = 0 }: {
  tree: SubjectNode[];
  open: (r: Route) => void;
  refreshTree?: () => void;
  reload?: number;
}) {
  const [selected, setSelected] = useState(() => startOfDay(new Date()));
  const [events, setEvents] = useState<StudyEvent[]>([]);
  const [dues, setDues] = useState<Due[]>([]);
  const [dueNote, setDueNote] = useState<string | null>(null);
  const [editing, setEditing] = useState<StudyEvent | 'new' | null>(null);
  const [importing, setImporting] = useState(false);
  const [range, setRange] = useState({ from: -2, to: 10 });
  const [visible, setVisible] = useState(() => monthOf(new Date(), 0));
  const scroller = useRef<HTMLDivElement>(null);
  const prepend = useRef<number | null>(null);

  const now = useMemo(() => monthOf(new Date(), 0), []);
  const months = useMemo(() => Array.from({ length: range.to - range.from + 1 }, (_, i) => monthOf(now, range.from + i)), [now, range]);
  const load = useCallback(() => {
    const from = months[0].getTime();
    const to = monthOf(months[months.length - 1], 1).getTime();
    studyApi.events(from, to).then(setEvents).catch(() => setEvents([]));
  }, [months, reload]);
  useEffect(load, [load]);

  useEffect(() => {
    let alive = true;
    const show = (list: CachedAssignment[]) => {
      if (!alive) return;
      setDues(list.filter((a) => a.due !== null).map((a) => ({
        id: a.id, title: a.title, at: a.due as number, stale: a.missingSince !== undefined, moved: a.movedFrom !== undefined,
      })));
    };
    const cached = loadCache();
    show(cached);
    if (!needsRefresh(cached)) return () => { alive = false; };
    api.assignments()
      .then((l) => {
        const incoming = [...l.current, ...l.past].map((a) => {
          const at = parseDue(a.due).getTime();
          return { id: a.id, title: a.name, due: Number.isFinite(at) ? at : null, dueText: String(a.due ?? '') };
        });
        const result = reconcile(cached, incoming);
        saveCache(result.assignments);
        show(result.assignments);
        if (alive) setDueNote(describeChanges(result));
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const jumpTo = useCallback((d: Date, smooth = true) => {
    const target = monthOf(d, 0);
    const n = (target.getFullYear() - now.getFullYear()) * 12 + target.getMonth() - now.getMonth();
    setRange((r) => (r.from <= n - 1 && r.to >= n + 2 ? r : { from: Math.min(r.from, n - 1), to: Math.max(r.to, n + 2) }));
    requestAnimationFrame(() => {
      const el = scroller.current?.querySelector<HTMLElement>(`#${monthId(target)}`);
      if (el && scroller.current) scroller.current.scrollTo({ top: el.offsetTop - 27, behavior: smooth ? 'smooth' : 'auto' });
    });
  }, [now]);

  useLayoutEffect(() => { jumpTo(now, false); }, [jumpTo, now]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && prepend.current !== null) { el.scrollTop += el.scrollHeight - prepend.current; prepend.current = null; }
  }, [range.from]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    if (el.scrollTop < 400 && prepend.current === null) { prepend.current = el.scrollHeight; setRange((r) => ({ ...r, from: r.from - CHUNK })); }
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 600) setRange((r) => ({ ...r, to: r.to + CHUNK }));
    const probe = el.scrollTop + 70;
    let current: Date | null = null;
    for (const sec of el.querySelectorAll<HTMLElement>('.cal-month')) {
      if (sec.offsetTop <= probe) current = new Date(Number(sec.dataset.t)); else break;
    }
    if (current && current.getTime() !== visible.getTime()) setVisible(current);
  };

  const byDay = useMemo(() => {
    const m = new Map<string, StudyEvent[]>();
    for (const e of events) {
      for (let d = startOfDay(e.startAt); d.getTime() <= (e.endAt ?? e.startAt); d = new Date(d.getTime() + DAY)) {
        m.set(dayKey(d), [...(m.get(dayKey(d)) ?? []), e]);
        if (!e.endAt) break;
      }
    }
    return m;
  }, [events]);
  const duesByDay = useMemo(() => {
    const m = new Map<string, Due[]>();
    for (const d of dues) m.set(dayKey(new Date(d.at)), [...(m.get(dayKey(new Date(d.at))) ?? []), d]);
    return m;
  }, [dues]);

  const today = startOfDay(new Date());
  const dayEvents = byDay.get(dayKey(selected)) ?? [];
  const dayDues = duesByDay.get(dayKey(selected)) ?? [];
  const notebooks = tree.flatMap((s) => s.notebooks.map((n) => ({ id: n.id, subjectId: s.id, label: `${s.name} / ${n.name}` })));
  const courseOf = (e: StudyEvent) => tree.find((s) => s.id === e.subjectId) ?? null;
  const tint = (e: StudyEvent) => ({ '--k': courseOf(e) ? subjectColor(courseOf(e)!) : NO_COURSE } as React.CSSProperties);
  const upcoming = events.filter((e) => e.startAt >= today.getTime() && !e.done).slice(0, 6);

  return (
    <div className="view schedule">
      <ViewBar actions={<>
        <button type="button" className="btn ghost" onClick={() => setImporting(true)} title="Read a course syllabus and add its exam and due dates"><FileUp /><span className="btn-label">Import syllabus</span></button>
        <button type="button" className="btn" onClick={() => setEditing('new')}><Plus /><span className="btn-label">Add event</span></button>
      </>}>
        <span className="viewbar-name">Schedule</span>
      </ViewBar>
      <div className="schedule-body">
        <section className="calendar">
          <div className="cal-head">
            <button type="button" className="icon-btn" onClick={() => jumpTo(monthOf(visible, -1))} aria-label="Previous month"><ChevronUp /></button>
            <button type="button" className="icon-btn" onClick={() => jumpTo(monthOf(visible, 1))} aria-label="Next month"><ChevronDown /></button>
            <span className="cal-title">{visible.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</span>
            <span className="spacer" />
            <button type="button" className="btn ghost" onClick={() => { jumpTo(today); setSelected(today); }}>Today</button>
          </div>
          <div className="cal-scroll" ref={scroller} onScroll={onScroll}>
            <div className="cal-dows">{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d} className="cal-dow">{d}</div>)}</div>
            {months.map((m) => (
              <section key={m.getTime()} id={monthId(m)} data-t={m.getTime()} className={`cal-month${m.getTime() === now.getTime() ? ' now' : ''}`}>
                <h3 className="cal-month-name">
                  {m.toLocaleDateString(undefined, { month: 'long' })}
                  {m.getFullYear() !== now.getFullYear() && <span className="muted"> {m.getFullYear()}</span>}
                </h3>
                <div className="cal-grid">
                  {monthCells(m).map((d, i) => {
                    if (!d) return <div key={`b${i}`} className="cal-blank" />;
                    const evs = byDay.get(dayKey(d)) ?? [];
                    const ds = duesByDay.get(dayKey(d)) ?? [];
                    const items = [
                      ...evs.map((e) => ({ key: `e${e.id}`, kind: e.kind, title: e.title, done: e.done, style: tint(e), course: courseOf(e)?.name })),
                      ...ds.map((x) => ({ key: `d${x.id}`, kind: 'webassign', title: x.title, done: x.at < Date.now(), style: undefined, course: undefined })),
                    ];
                    const weekend = d.getDay() === 0 || d.getDay() === 6;
                    return (
                      <button
                        type="button"
                        key={d.getTime()}
                        className={`cal-day${weekend ? ' weekend' : ''}${d < today ? ' past' : ''}${sameDay(d, today) ? ' today' : ''}${sameDay(d, selected) ? ' on' : ''}`}
                        onClick={() => setSelected(d)}
                        onDoubleClick={() => { setSelected(d); setEditing('new'); }}
                      >
                        <span className="cal-num">{d.getDate()}</span>
                        {items.slice(0, 3).map((it) => <span key={it.key} className={`cal-pill ${it.kind}${it.done ? ' done' : ''}`} style={it.style} title={it.course ? `${it.course} · ${it.title}` : it.title}>{it.title}</span>)}
                        {items.length > 3 && <span className="cal-more">+{items.length - 3} more</span>}
                      </button>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        </section>

        <aside className="day-panel">
          <div className="day-title">
            <CalendarDays />
            <span>{selected.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</span>
          </div>
          <button type="button" className="btn primary" onClick={() => setEditing('new')}><Plus />Add to this day</button>
          {dueNote && (
            <p className="muted small due-note">
              WebAssign: {dueNote}
              <button type="button" className="link" onClick={() => setDueNote(null)}>dismiss</button>
            </p>
          )}
          {!dayEvents.length && !dayDues.length && <p className="muted small">Nothing planned. Double-click a day to add something quickly.</p>}
          <ul className="day-list stagger">
            {dayEvents.map((e, i) => (
              <li key={e.id} className={`day-event ${e.kind}${e.done ? ' done' : ''}`} style={{ '--i': i, ...tint(e) } as React.CSSProperties}>
                <button type="button" className="check-btn" onClick={async () => { await studyApi.updateEvent(e.id, { ...e, done: !e.done }); load(); }} title={e.done ? 'Mark not done' : 'Mark done'}>
                  {e.done ? <Check /> : null}
                </button>
                <div className="day-event-main">
                  {courseOf(e) ? (
                    <button type="button" className="event-course" onClick={() => open({ kind: 'subject', id: e.subjectId! })} title={`Open ${courseOf(e)!.name}`}>
                      <SubjectIcon icon={courseOf(e)!.icon} name={courseOf(e)!.name} />{courseOf(e)!.name}
                    </button>
                  ) : <span className="event-course none">No course</span>}
                  <div className="day-event-title">{e.title}</div>
                  <div className="day-event-meta">
                    {KINDS.find((k) => k.kind === e.kind)?.label}
                    {!e.allDay && ` · ${fmtTime(e.startAt)}${e.endAt ? `–${fmtTime(e.endAt)}` : ''}`}
                    {e.notebookId && notebooks.find((n) => n.id === e.notebookId) && (
                      <> · <button type="button" className="link" onClick={() => open({ kind: 'notebook', id: e.notebookId! })}>{notebooks.find((n) => n.id === e.notebookId)!.label.split(' / ').pop()}</button></>
                    )}
                  </div>
                  {e.notes && <div className="event-notes">{e.notes}</div>}
                </div>
                <button type="button" className="icon-btn ghost-icon" onClick={() => setEditing(e)} title="Edit"><Pencil /></button>
              </li>
            ))}
            {dayDues.map((d) => (
              <li key={`d${d.id}`} className={`day-event webassign${d.stale ? ' stale' : ''}`}>
                <span className="check-btn static"><ClipboardCheck /></span>
                <div className="day-event-main">
                  <div className="day-event-title">{d.title}</div>
                  <div className="day-event-meta">
                    WebAssign · due {fmtTime(d.at)}
                    {d.moved && <span className="tag moved" title="The due date changed since the last check"> moved</span>}
                    {d.stale && <span className="tag stale" title="No longer listed in WebAssign - kept in case it comes back"> not listed any more</span>}
                  </div>
                </div>
                <button type="button" className="link" onClick={() => open({ kind: 'solver' })}>open</button>
              </li>
            ))}
          </ul>
          {!!upcoming.length && (
            <div className="upcoming">
              <div className="panel-title">Coming up</div>
              {upcoming.map((e) => (
                <button type="button" key={e.id} className="upcoming-row" onClick={() => { jumpTo(startOfDay(e.startAt)); setSelected(startOfDay(e.startAt)); }}>
                  <span className="kind-dot" style={tint(e)} />
                  <span className="upcoming-title">{courseOf(e) && <span className="muted">{courseOf(e)!.name} · </span>}{e.title}</span>
                  <span className="muted">{new Date(e.startAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
                </button>
              ))}
            </div>
          )}
          <p className="schedule-tip">
            <Bot />
            <span>
              You can also manage dates from the <button type="button" className="link" onClick={() => open({ kind: 'chat', id: null })}>Chat</button> with
              app control on, e.g. “move my midterm to Thursday at 2pm” or “add study sessions before each exam”.
            </span>
          </p>
        </aside>
      </div>

      {importing && <SyllabusDialog subject={null} tree={tree} onClose={() => setImporting(false)} onDone={() => { load(); refreshTree?.(); }} />}
      {editing && (
        <EventEditor
          event={editing === 'new' ? null : editing}
          day={selected}
          notebooks={notebooks}
          courses={tree}
          onClose={() => setEditing(null)}
          onSaved={load}
        />
      )}
    </div>
  );
}

const toLocalInput = (t: number, withTime: boolean) => {
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return withTime ? `${date}T${pad(d.getHours())}:${pad(d.getMinutes())}` : date;
};

function EventEditor({ event, day, notebooks, courses, onClose, onSaved }: {
  event: StudyEvent | null;
  day: Date;
  notebooks: { id: number; subjectId: number; label: string }[];
  courses: SubjectNode[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const base = new Date(day);
  base.setHours(9, 0, 0, 0);
  const [title, setTitle] = useState(event?.title ?? '');
  const [kind, setKind] = useState<EventKind>(event?.kind ?? 'study');
  const [allDay, setAllDay] = useState(event?.allDay ?? false);
  const [start, setStart] = useState(event ? event.startAt : base.getTime());
  const [end, setEnd] = useState<number | null>(event ? event.endAt : base.getTime() + 3600_000);
  const [notebookId, setNotebookId] = useState<number | null>(event?.notebookId ?? null);
  const [subjectId, setSubjectId] = useState<number | null>(event?.subjectId ?? null);
  const course = courses.find((c) => c.id === subjectId) ?? null;
  const [notes, setNotes] = useState(event?.notes ?? '');
  const [error, setError] = useState<string | null>(null);

  const parse = (v: string) => (v ? new Date(v).getTime() : NaN);
  const save = async () => {
    const input: EventInput = {
      title, kind, allDay, notes, notebookId, subjectId, done: event?.done ?? false,
      startAt: allDay ? startOfDay(start).getTime() : start,
      endAt: allDay ? null : end,
    };
    try {
      if (event) await studyApi.updateEvent(event.id, input); else await studyApi.addEvent(input);
      onSaved();
      onClose();
    } catch (e) { setError(String(e)); }
  };

  return (
    <Modal title={event ? 'Edit event' : 'New event'} onClose={onClose}>
          <div className="form">
            <label className="field"><span>Title</span><input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Calculus II midterm" /></label>
            <div className="chips">
              {KINDS.map((k) => <button type="button" key={k.kind} className={`chip-btn kind-${k.kind}${kind === k.kind ? ' on' : ''}`} onClick={() => setKind(k.kind)}><span className={`kind-dot ${k.kind}`} />{k.label}</button>)}
            </div>
            <label className="toggle"><input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} /> All day</label>
            <div className="ai-settings-row">
              <label className="field"><span>{allDay ? 'Day' : 'Starts'}</span>
                <input type={allDay ? 'date' : 'datetime-local'} value={toLocalInput(start, !allDay)} onChange={(e) => { const t = parse(e.target.value); if (Number.isFinite(t)) setStart(t); }} />
              </label>
              {!allDay && (
                <label className="field"><span>Ends</span>
                  <input type="datetime-local" value={end ? toLocalInput(end, true) : ''} onChange={(e) => { const t = parse(e.target.value); setEnd(Number.isFinite(t) ? t : null); }} />
                </label>
              )}
            </div>
            <div className="ai-settings-row">
              <label className="field"><span>Course</span>
                <span className="course-select" style={{ '--k': course ? subjectColor(course) : NO_COURSE } as React.CSSProperties}>
                  <span className="kind-dot" />
                  <Select className="select" value={String(subjectId ?? '')} onChange={(v) => { setSubjectId(v ? Number(v) : null); setNotebookId(null); }}
                    options={[
                      { value: '', label: 'No course' },
                      ...courses.map((c) => ({ value: String(c.id), text: c.name, label: <span className="opt-dotted"><i style={{ background: subjectColor(c) }} />{c.name}</span> })),
                    ]} />
                </span>
              </label>
              <label className="field"><span>Notebook <i className="muted">optional</i></span>
                <Select className="select" value={String(notebookId ?? '')} disabled={!course} onChange={(v) => setNotebookId(v ? Number(v) : null)}
                  options={[
                    { value: '', label: course ? 'None' : 'Pick a course first' },
                    ...notebooks.filter((n) => n.subjectId === subjectId).map((n) => ({ value: String(n.id), label: n.label.split(' / ').pop() ?? n.label })),
                  ]} />
              </label>
            </div>
            <label className="field"><span>Notes</span><textarea className="textarea" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
            {error && <div className="form-err">{error}</div>}
          </div>
          <div className="modal-actions">
            {event && <button type="button" className="btn ghost danger" style={{ marginRight: 'auto' }} onClick={async () => { await studyApi.deleteEvent(event.id); onSaved(); onClose(); }}><Trash />Delete</button>}
            <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
            <button type="button" className="btn primary" disabled={!title.trim()} onClick={() => void save()}>{event ? 'Save' : 'Add event'}</button>
          </div>
    </Modal>
  );
}
