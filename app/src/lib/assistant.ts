import { pomodoro, type Phase } from './pomodoro';
import { courseContextOf } from './syllabus';
import { solverEnabled } from './features';
import { type GenSource } from './studyGen';
import { writeNote } from './notesGen';
import { makeSet } from './makeSet';
import { studyApi, type EventKind, type NotebookSummary, type SubjectNode } from '../study/api';
import { notebookMaterial } from './material';
import type { Route } from '../study/pages';

/**
 * What each app tool does. The declarations here and in `lib/salem/tools`
 * together make the registry the runtime is given; this file is the part that
 * actually acts on the student's study space.
 */
export type AppTools = {
  defs: unknown[];
  run: (name: string, args: Record<string, unknown>) => Promise<{ ok: boolean; label: string; detail?: string; result: unknown }>;
};

/**
 * The standalone chat's app tools: with them the assistant can organise the
 * user's study space (subjects, notebooks, notes, decks, quizzes), search a
 * notebook, drive the focus timer and open views. It only acts when asked
 * (see APP_POLICY in prompts); every action shows up in the reply.
 */

const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
});

const NOTEBOOK = { type: 'string', description: 'Notebook name as the user says it; "Subject / Notebook" if the name is ambiguous.' };

export const APP_TOOL_DEFS = [
  fn('list_study', 'List the subjects and notebooks with what is in each (sources, decks, quizzes, notes). Use it before acting on a notebook you are unsure about.', {}),
  fn('read_syllabus', "Read a subject's syllabus summary (grading, exams, topics, policies) and your own course notes for it.", { subject: { type: 'string' } }, ['subject']),
  fn('list_notebook', 'List the sources, flashcard decks, quizzes and notes of one notebook.', { notebook: NOTEBOOK }, ['notebook']),
  fn('search_notebook', "Search a notebook's sources (lecture PDFs, slides, notes) and return matching excerpts.", { notebook: NOTEBOOK, query: { type: 'string' } }, ['notebook', 'query']),
  fn('create_subject', 'Create a subject (a course).', { name: { type: 'string' } }, ['name']),
  fn('create_notebook', 'Create a notebook in a subject.', { subject: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' } }, ['subject', 'name']),
  fn('write_notes', "Have organised study notes written into a notebook, from its sources (default) or from a topic. Takes a while; the notes appear in the notebook.", {
    notebook: NOTEBOOK,
    instructions: { type: 'string', description: 'Style, length and focus the user asked for.' },
    topic: { type: 'string', description: 'What to cover. Leave empty to use the notebook sources.' },
  }, ['notebook']),
  fn('save_note', 'Save a note you wrote yourself (Markdown with LaTeX maths) into a notebook, e.g. a summary of this conversation.', {
    notebook: NOTEBOOK, title: { type: 'string' }, content: { type: 'string', description: 'The note in Markdown.' },
  }, ['notebook', 'title', 'content']),
  fn('make_flashcards', 'Generate a flashcard deck in a notebook. From its sources (the default) it walks every page in reading order and writes as many cards as the material needs; or from a topic.', {
    notebook: NOTEBOOK, topic: { type: 'string', description: 'Leave empty to use the notebook sources.' },
    count: { type: 'number', description: 'Only when the student asked for a particular number; it caps the deck. Leave it out otherwise.' },
  }, ['notebook']),
  fn('make_quiz', 'Generate a checked practice quiz in a notebook. From its sources (the default) it walks every page in reading order and writes as many questions as the material needs; or from a topic.', {
    notebook: NOTEBOOK, topic: { type: 'string', description: 'Leave empty to use the notebook sources.' },
    count: { type: 'number', description: 'Only when the student asked for a particular number; it caps the quiz. Leave it out otherwise.' },
  }, ['notebook']),
  fn('timer', 'Control the focus (Pomodoro) timer.', {
    action: { type: 'string', enum: ['start', 'pause', 'reset', 'skip', 'status'] },
    phase: { type: 'string', enum: ['focus', 'short', 'long'], description: 'Switch to this phase first.' },
    minutes: { type: 'number', description: 'Set the length of that phase in minutes.' },
  }, ['action']),
  fn('add_tasks', "Add tasks to the focus timer's task list.", { tasks: { type: 'array', items: { type: 'string' } } }, ['tasks']),
  fn('list_events', 'List calendar events between two dates (inclusive).', {
    from: { type: 'string', description: 'YYYY-MM-DD' }, to: { type: 'string', description: 'YYYY-MM-DD' },
  }, ['from', 'to']),
  fn('add_event', 'Add an event to the study calendar (exam, deadline, study session, class…).', {
    title: { type: 'string' },
    date: { type: 'string', description: 'YYYY-MM-DD' },
    time: { type: 'string', description: 'HH:MM, 24h. Leave out for an all-day event.' },
    end_time: { type: 'string', description: 'HH:MM, 24h, optional.' },
    kind: { type: 'string', enum: ['exam', 'deadline', 'study', 'class', 'other'] },
    course: { type: 'string', description: 'The course (subject) it belongs to, e.g. "Calculus 2". Leave out only for personal events with no course.' },
    notebook: { type: 'string', description: 'Optional notebook it belongs to (its course is used).' },
    notes: { type: 'string' },
  }, ['title', 'date']),
  fn('update_event', 'Change an event found with list_events (only the fields given change).', {
    id: { type: 'number' }, title: { type: 'string' }, date: { type: 'string' }, time: { type: 'string' }, end_time: { type: 'string' },
    kind: { type: 'string', enum: ['exam', 'deadline', 'study', 'class', 'other'] }, notes: { type: 'string' }, done: { type: 'boolean' },
    course: { type: 'string', description: 'Move it to this course; "none" for no course.' },
  }, ['id']),
  fn('delete_event', 'Delete an event found with list_events.', { id: { type: 'number' } }, ['id']),
  fn('open', 'Show a view in the app.', {
    view: { type: 'string', enum: ['notebook', 'subject', 'focus', 'study', 'solver', 'schedule'] },
    name: { type: 'string', description: 'Notebook or subject name, for those views.' },
  }, ['view']),
];

type Env = {
  tree: () => SubjectNode[];
  refresh: () => Promise<SubjectNode[]>;
  open: (r: Route) => void;
};

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function findSubject(tree: SubjectNode[], name: string): SubjectNode {
  const q = norm(name);
  const hits = tree.filter((s) => norm(s.name) === q);
  const loose = hits.length ? hits : tree.filter((s) => norm(s.name).includes(q) || q.includes(norm(s.name)));
  if (loose.length === 1) return loose[0];
  if (!loose.length) throw new Error(`No subject called "${name}". Subjects: ${tree.map((s) => s.name).join(', ') || 'none yet'}.`);
  throw new Error(`"${name}" matches several subjects: ${loose.map((s) => s.name).join(', ')}.`);
}

function findNotebook(tree: SubjectNode[], name: string): { notebook: NotebookSummary; subject: SubjectNode } {
  const all = tree.flatMap((s) => s.notebooks.map((n) => ({ notebook: n, subject: s })));
  const [sub, nb] = name.includes('/') ? name.split('/').map((x) => norm(x)) : [null, norm(name)];
  const scoped = sub ? all.filter((x) => norm(x.subject.name).includes(sub)) : all;
  const exact = scoped.filter((x) => norm(x.notebook.name) === nb);
  const hits = exact.length ? exact : scoped.filter((x) => norm(x.notebook.name).includes(nb!) || nb!.includes(norm(x.notebook.name)));
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw new Error(`No notebook called "${name}". Notebooks: ${all.map((x) => `${x.subject.name} / ${x.notebook.name}`).join(', ') || 'none yet'}.`);
  throw new Error(`"${name}" matches several notebooks: ${hits.map((x) => `${x.subject.name} / ${x.notebook.name}`).join(', ')}. Say which.`);
}

/**
 * What to build from. A deck or quiz walks every page of the notebook's
 * sources in reading order; notes are written from a sample, since they are
 * written in one go.
 */
async function sourceMaterial(notebookId: number, topic: string, walk = false): Promise<GenSource> {
  if (topic.trim()) return { kind: 'topic', prompt: topic };
  const ready = (await studyApi.sources(notebookId)).filter((s) => s.status === 'ready');
  if (!ready.length) throw new Error('That notebook has no sources yet; give a topic instead.');
  const hits = walk ? await notebookMaterial(notebookId) : await studyApi.sampleSources(ready.map((s) => s.id), 50_000);
  return { kind: 'sources', hits, focus: '' };
}

/** A number of items the assistant was asked for, if it was asked for one. */
const countOf = (value: unknown): number | undefined => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.min(128, n) : undefined;
};

export function appTools(env: Env): AppTools {
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  return {
    defs: APP_TOOL_DEFS,
    async run(name, a) {
      const tree = env.tree();
      switch (name) {
        case 'list_study': {
          const result = tree.map((s) => ({
            subject: s.name,
            ...(s.syllabusName ? { syllabus: true } : {}),
            notebooks: s.notebooks.map((n) => ({ name: n.name, sources: n.sourceCount, decks: n.deckCount, quizzes: n.quizCount })),
          }));
          return { ok: true, label: 'Looked through your study space', result };
        }
        case 'read_syllabus': {
          const s = findSubject(tree, str(a.subject));
          const context = courseContextOf(s);
          return {
            ok: true,
            label: `Read the ${s.name} syllabus`,
            result: context ? { subject: s.name, context } : { subject: s.name, note: 'No syllabus or course notes were added for this subject (Study → subject → Syllabus).' },
          };
        }
        case 'list_notebook': {
          const { notebook, subject } = findNotebook(tree, str(a.notebook));
          const [sources, decks, quizzes, notes] = await Promise.all([
            studyApi.sources(notebook.id), studyApi.decks(notebook.id), studyApi.quizzes(notebook.id), studyApi.notes(notebook.id),
          ]);
          return {
            ok: true,
            label: `Looked inside ${subject.name} / ${notebook.name}`,
            result: {
              sources: sources.map((s) => `${s.title} (${s.kind}, ${s.status})`),
              decks: decks.map((d) => `${d.title} (${d.cardCount} cards)`),
              quizzes: quizzes.map((q) => `${q.title} (${q.questionCount} questions)`),
              notes: notes.map((n) => n.title),
            },
          };
        }
        case 'search_notebook': {
          const { notebook } = findNotebook(tree, str(a.notebook));
          const ready = (await studyApi.sources(notebook.id)).filter((s) => s.status === 'ready').map((s) => s.id);
          const hits = await studyApi.searchSources(ready, str(a.query), 6);
          return {
            ok: true,
            label: `Searched ${notebook.name} for “${str(a.query)}”`,
            detail: `${hits.length} excerpt${hits.length === 1 ? '' : 's'}`,
            result: hits.map((h) => ({ source: h.sourceTitle, where: h.label, text: h.text.slice(0, 1500) })),
          };
        }
        case 'create_subject': {
          const id = await studyApi.createSubject(str(a.name));
          await env.refresh();
          return { ok: true, label: `Created subject ${str(a.name)}`, result: { id } };
        }
        case 'create_notebook': {
          const subject = findSubject(tree, str(a.subject));
          const id = await studyApi.createNotebook(subject.id, str(a.name), str(a.description));
          await env.refresh();
          return { ok: true, label: `Created notebook ${str(a.name)} in ${subject.name}`, result: { id } };
        }
        case 'save_note': {
          const { notebook } = findNotebook(tree, str(a.notebook));
          const n = await studyApi.createNote(notebook.id, str(a.title), str(a.content));
          await env.refresh();
          return { ok: true, label: `Saved note “${n.title}” in ${notebook.name}`, result: { id: n.id } };
        }
        case 'write_notes': {
          const { notebook, subject } = findNotebook(tree, str(a.notebook));
          const src = await sourceMaterial(notebook.id, str(a.topic));
          const ctx = { subject: subject.name, notebook: notebook.name, courseContext: courseContextOf(subject) };
          const n = await writeNote(ctx, notebook.id, src, str(a.instructions), () => {});
          await env.refresh();
          return { ok: true, label: `Wrote notes “${n.title}” in ${notebook.name}`, result: { title: n.title, length: n.content.length } };
        }
        case 'make_flashcards': {
          const { notebook, subject } = findNotebook(tree, str(a.notebook));
          const src = await sourceMaterial(notebook.id, str(a.topic), true);
          const ctx = { subject: subject.name, notebook: notebook.name, courseContext: courseContextOf(subject) };
          const { message } = await makeSet('cards', ctx, notebook.id, src, () => {}, { limit: countOf(a.count) });
          await env.refresh();
          return { ok: true, label: `${message.replace(/\.$/, '')} in ${notebook.name}`, result: { message } };
        }
        case 'make_quiz': {
          const { notebook, subject } = findNotebook(tree, str(a.notebook));
          const src = await sourceMaterial(notebook.id, str(a.topic), true);
          const ctx = { subject: subject.name, notebook: notebook.name, courseContext: courseContextOf(subject) };
          const q = await makeSet('quiz', ctx, notebook.id, src, () => {}, { limit: countOf(a.count) });
          await env.refresh();
          return { ok: true, label: `Made the quiz “${q.title}” (${q.count} questions) in ${notebook.name}`, result: { title: q.title, questions: q.count, note: q.note } };
        }
        case 'timer': {
          const phase = str(a.phase) as Phase;
          if (['focus', 'short', 'long'].includes(phase)) pomodoro.setPhase(phase);
          const minutes = Number(a.minutes);
          if (minutes > 0 && ['focus', 'short', 'long'].includes(phase)) pomodoro.updateSettings({ [phase]: Math.min(180, Math.round(minutes)) });
          const action = str(a.action);
          if (action === 'start') pomodoro.start();
          else if (action === 'pause') pomodoro.pause();
          else if (action === 'reset') pomodoro.reset();
          else if (action === 'skip') pomodoro.skip();
          const label = action === 'status' ? 'Checked the timer' : `Timer: ${action}${phase ? ` (${phase}${minutes > 0 ? `, ${minutes} min` : ''})` : ''}`;
          return { ok: true, label, result: { ok: true } };
        }
        case 'add_tasks': {
          const tasks = Array.isArray(a.tasks) ? a.tasks.map(String).filter((t) => t.trim()) : [];
          tasks.forEach((t) => pomodoro.addTask(t));
          return { ok: true, label: `Added ${tasks.length} task${tasks.length === 1 ? '' : 's'} to the focus list`, result: { added: tasks } };
        }
        case 'list_events': {
          const from = parseDay(str(a.from));
          const to = parseDay(str(a.to)) + 864e5;
          const events = await studyApi.events(from, to);
          return {
            ok: true,
            label: `Checked the calendar (${str(a.from)} to ${str(a.to)})`,
            detail: `${events.length} event${events.length === 1 ? '' : 's'}`,
            result: events.map((e) => ({ id: e.id, title: e.title, course: tree.find((s) => s.id === e.subjectId)?.name ?? null, kind: e.kind, when: describeWhen(e.startAt, e.endAt, e.allDay), done: e.done, notes: e.notes })),
          };
        }
        case 'add_event': {
          const { startAt, endAt, allDay } = when(str(a.date), str(a.time), str(a.end_time));
          const nb = str(a.notebook) ? findNotebook(tree, str(a.notebook)).notebook.id : null;
          const kind = (['exam', 'deadline', 'study', 'class', 'other'].includes(str(a.kind)) ? str(a.kind) : 'other') as EventKind;
          const course = str(a.course) ? findSubject(tree, str(a.course)).id : null;
          const e = await studyApi.addEvent({ title: str(a.title), notes: str(a.notes), kind, startAt, endAt, allDay, notebookId: nb, subjectId: course, done: false });
          return { ok: true, label: `Added “${e.title}” on ${describeWhen(e.startAt, e.endAt, e.allDay)}`, result: { id: e.id } };
        }
        case 'update_event': {
          const id = Number(a.id);
          const current = (await studyApi.events(0, 8.64e15)).find((e) => e.id === id);
          if (!current) throw new Error(`No event with id ${id}.`);
          let { startAt, endAt, allDay } = current;
          if (str(a.date) || str(a.time)) {
            // en-CA formats as YYYY-MM-DD in local time (toISOString would use UTC and can shift the day).
            const d = str(a.date) || new Date(current.startAt).toLocaleDateString('en-CA');
            ({ startAt, endAt, allDay } = when(d, str(a.time), str(a.end_time)));
          }
          const e = await studyApi.updateEvent(id, {
            ...current, startAt, endAt, allDay,
            title: str(a.title) || current.title,
            notes: typeof a.notes === 'string' ? a.notes : current.notes,
            kind: (str(a.kind) || current.kind) as EventKind,
            done: typeof a.done === 'boolean' ? a.done : current.done,
            ...(str(a.course) ? (/^none$/i.test(str(a.course)) ? { subjectId: null, notebookId: null } : { subjectId: findSubject(tree, str(a.course)).id }) : {}),
          });
          return { ok: true, label: `Updated “${e.title}”`, result: { id: e.id } };
        }
        case 'delete_event': {
          await studyApi.deleteEvent(Number(a.id));
          return { ok: true, label: 'Deleted the event', result: { ok: true } };
        }
        case 'open': {
          const view = str(a.view);
          if (view === 'notebook') { const { notebook } = findNotebook(tree, str(a.name)); env.open({ kind: 'notebook', id: notebook.id }); return { ok: true, label: `Opened ${notebook.name}`, result: { ok: true } }; }
          if (view === 'subject') { const s = findSubject(tree, str(a.name)); env.open({ kind: 'subject', id: s.id }); return { ok: true, label: `Opened ${s.name}`, result: { ok: true } }; }
          if (view === 'solver' && !solverEnabled()) throw new Error('The Assignment Solver is turned off (Settings → Features).');
          const route: Route = view === 'focus' ? { kind: 'focus' } : view === 'solver' ? { kind: 'solver' } : view === 'schedule' ? { kind: 'schedule' } : { kind: 'study' };
          env.open(route);
          return { ok: true, label: `Opened ${view}`, result: { ok: true } };
        }
        default:
          throw new Error(`Unknown action ${name}`);
      }
    },
  };
}

// ---------------------------------------------------------------- dates

/** Local midnight of a YYYY-MM-DD date. */
function parseDay(d: string): number {
  const m = d.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) throw new Error(`"${d}" is not a date (use YYYY-MM-DD).`);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
}

function atTime(day: number, hhmm: string): number {
  const m = hhmm.match(/^(\d{1,2}):(\d{2})/);
  if (!m) throw new Error(`"${hhmm}" is not a time (use HH:MM).`);
  return day + (Number(m[1]) * 60 + Number(m[2])) * 60_000;
}

function when(date: string, time: string, end: string): { startAt: number; endAt: number | null; allDay: boolean } {
  const day = parseDay(date);
  if (!time) return { startAt: day, endAt: null, allDay: true };
  const startAt = atTime(day, time);
  return { startAt, endAt: end ? atTime(day, end) : null, allDay: false };
}

function describeWhen(start: number, end: number | null, allDay: boolean): string {
  const d = new Date(start).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  if (allDay) return d;
  const t = (x: number) => new Date(x).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `${d} ${t(start)}${end ? `–${t(end)}` : ''}`;
}
