import { useSyncExternalStore } from 'react';
import { cancelRun } from './salem/runtime';
import { generateText } from './salem/generate';
import { createMeter, recalledCost, rememberCost, type Meter } from './meter';
import { NOTES_REFINE_SYSTEM, NOTES_SYSTEM } from './prompts';
import type { GenSource, StudyContext } from './studyGen';
import { studyApi, type Note } from '../study/api';

/**
 * Writing and rewriting notes. The model's text streams into a job store keyed
 * by note id, so the note view shows it growing (and keeps doing so if the
 * user looks elsewhere); when it finishes the note is saved.
 */

type Job = { text: string; streamId: string | null; error: string | null; /** USD so far. */ cost: number };

const jobs = new Map<number, Job>();
const listeners = new Set<() => void>();
let snapshot: ReadonlyMap<number, Job> = new Map();
const emit = () => { snapshot = new Map(jobs); listeners.forEach((l) => l()); };
/** Tokens arrive far faster than a long note can be re-rendered (Markdown +
 *  KaTeX for the whole text), so the view is refreshed at most ~10×/second. */
let queued: number | null = null;
const emitSoon = () => { if (queued === null) queued = window.setTimeout(() => { queued = null; emit(); }, 100); };

export function useNoteJobs(): ReadonlyMap<number, Job> {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => snapshot);
}

/** "# Title" from the first line, if the model wrote one. */
export const titleOf = (md: string): string | null => md.match(/^\s*#\s+(.+)$/m)?.[1]?.trim().slice(0, 120) ?? null;

function describe(src: GenSource): string {
  if (src.kind === 'topic') return `Write notes on:\n${src.prompt}`;
  if (src.kind === 'chat') {
    const transcript = src.messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => `${m.role === 'user' ? 'Student' : 'Tutor'}: ${m.content}`)
      .join('\n\n');
    return `Turn this tutoring conversation into notes (the tutor's explanations are the reference):\n\n${transcript.slice(-60_000)}`;
  }
  if (src.kind === 'sources') {
    const blocks = src.hits.map((h) => `<excerpt source="${h.sourceTitle}" where="${h.label}">\n${h.text}\n</excerpt>`).join('\n\n');
    return `Write notes from these excerpts of the student's course material. Cover the important ideas across all of them.${src.focus.trim() ? `\nFocus on: ${src.focus.trim()}` : ''}\n\n${blocks}`;
  }
  return '';
}

async function stream(noteId: number, system: string, user: string): Promise<string> {
  const id = crypto.randomUUID();
  const job: Job = { text: '', streamId: id, error: null, cost: 0 };
  jobs.set(noteId, job);
  emit();
  // What the note costs, kept with it afterwards — added to what earlier
  // writes of the same note cost, so a refined note shows its whole price.
  const before = recalledCost('note', noteId) ?? 0;
  const meter = createMeter((usd) => { job.cost = usd; emitSoon(); });
  try {
    return await streamInto(job, meter, system, user, id);
  } finally {
    if (meter.total > 0) rememberCost('note', noteId, before + meter.total);
  }
}

async function streamInto(job: Job, meter: Meter, system: string, user: string, id: string): Promise<string> {
  const text = await generateText({
    feature: 'notes',
    system,
    instruction: user,
    run: id,
    meter,
    // The note streams into the job store as it is written, so the page
    // shows it growing.
    onEvent: (event) => {
      if (event.kind === 'text') { job.text += event.text; emitSoon(); }
    },
  });
  return (text || job.text).trim();
}

async function run(
  note: Note,
  system: string,
  user: string,
  patch: (text: string) => Partial<Pick<Note, 'title' | 'instructions'>>,
): Promise<Note> {
  try {
    const text = await stream(note.id, system, user);
    if (!text) throw new Error('The model returned nothing. Try again.');
    return await studyApi.updateNote(note.id, { content: text, ...patch(text) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const job = jobs.get(note.id);
    // A stopped note keeps what was written so far.
    if (msg === 'stopped' && job?.text.trim()) return studyApi.updateNote(note.id, { content: job.text.trim() });
    throw e;
  } finally {
    jobs.delete(note.id);
    emit();
  }
}

/** Create a note and write it; resolves when it is finished. */
export async function writeNote(ctx: StudyContext, notebookId: number, src: GenSource, instructions: string, onCreated: (n: Note) => void): Promise<Note> {
  const note = await studyApi.createNote(notebookId, 'Writing…', '', instructions);
  onCreated(note);
  const user = `Course: ${ctx.subject}\nNotebook: ${ctx.notebook}${ctx.courseContext.trim() ? `\nCourse notes (follow this notation):\n${ctx.courseContext.trim()}` : ''}\n\n${instructions.trim() ? `The student's instructions for these notes:\n${instructions.trim()}\n\n` : ''}${describe(src)}`;
  try {
    return await run(note, NOTES_SYSTEM, user, (text) => ({ title: titleOf(text) ?? 'Notes' }));
  } catch (e) {
    await studyApi.updateNote(note.id, { title: 'Notes (failed)', content: `_Writing these notes failed: ${e instanceof Error ? e.message : String(e)}_` }).catch(() => {});
    throw e;
  }
}

/** Rewrite a note following an extra instruction ("shorter", "add examples", …). */
export async function refineNote(note: Note, instruction: string): Promise<Note> {
  const user = `The change to make:\n${instruction.trim()}\n\nThe current notes:\n\n${note.content}`;
  return run(note, NOTES_REFINE_SYSTEM, user, (text) => ({
    title: titleOf(text) ?? note.title,
    instructions: [note.instructions, instruction.trim()].filter(Boolean).join('\n'),
  }));
}

export function stopNote(noteId: number) {
  const id = jobs.get(noteId)?.streamId;
  if (id) void cancelRun(id);
}
