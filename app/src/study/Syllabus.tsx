import { useRef, useState } from 'react';
import { CalendarPlus, FileText, RefreshCw, Trash, Upload } from 'lucide-react';
import { Modal } from '../components/Dialogs';
import { Markdown } from '../lib/markdown';
import { addSyllabusEvents, analyzeSyllabus, readSyllabus, SYLLABUS_ACCEPT, type SyllabusEvent } from '../lib/syllabus';
import { studyApi, type SubjectNode } from './api';
import { KINDS } from './Schedule';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const fmtDay = (d: string) => {
  const t = new Date(`${d}T00:00`);
  return t.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', ...(t.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
};

type Step =
  | { kind: 'pick' }
  | { kind: 'working'; text: string }
  | { kind: 'review'; file: { attachmentId: number; name: string; text: string } | null; summary: string; events: SyllabusEvent[] }
  | { kind: 'done'; added: number }
  | { kind: 'error'; message: string };

/**
 * Upload a syllabus (or re-read the saved one): the summary is saved with the
 * subject and the dates it finds can be added to Schedule after a review.
 * With `subject` null (from Schedule), the student picks the subject first.
 */
export function SyllabusDialog({ subject: initial, tree, rescan, onClose, onDone }: {
  subject: SubjectNode | null;
  tree: SubjectNode[];
  /** Re-read the saved syllabus for its dates instead of uploading a new one. */
  rescan?: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [subjectId, setSubjectId] = useState<number | null>(initial?.id ?? tree[0]?.id ?? null);
  const subject = tree.find((s) => s.id === subjectId) ?? initial;
  const [step, setStep] = useState<Step>({ kind: 'pick' });
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // Extra instructions for reading it, remembered per subject for the next time.
  const notesKey = (id: number | null | undefined) => `wa.syllabus.notes.${id ?? 0}`;
  const [notes, setNotes] = useState(() => { try { return localStorage.getItem(notesKey(initial?.id ?? tree[0]?.id)) ?? ''; } catch { return ''; } });
  const remember = () => { try { localStorage.setItem(notesKey(subject?.id), notes); } catch { /* ignore */ } };

  const review = (file: Extract<Step, { kind: 'review' }>['file'], summary: string, events: SyllabusEvent[]) => {
    const today = new Date().toLocaleDateString('en-CA');
    setPicked(new Set(events.map((e, i) => (e.date >= today ? i : -1)).filter((i) => i >= 0)));
    setStep({ kind: 'review', file, summary, events });
  };

  const upload = async (file: File) => {
    if (!subject) return;
    try {
      const read = await readSyllabus(file, (t) => setStep({ kind: 'working', text: t }));
      setStep({ kind: 'working', text: 'finding the course details and dates' });
      remember();
      const { summary, events } = await analyzeSyllabus(subject.name, read.text, notes);
      review({ attachmentId: read.attachmentId, name: file.name, text: read.text }, summary, events);
    } catch (e) { setStep({ kind: 'error', message: errText(e) }); }
  };

  const reread = async () => {
    if (!subject) return;
    try {
      setStep({ kind: 'working', text: 'reading the saved syllabus again' });
      remember();
      const text = await studyApi.syllabusText(subject.id);
      const { summary, events } = await analyzeSyllabus(subject.name, text, notes);
      review(null, summary, events);
    } catch (e) { setStep({ kind: 'error', message: errText(e) }); }
  };

  const save = async () => {
    if (step.kind !== 'review' || !subject) return;
    setStep({ kind: 'working', text: 'saving' });
    try {
      if (step.file) await studyApi.setSyllabus(subject.id, { file: step.file.attachmentId, name: step.file.name, text: step.file.text, summary: step.summary });
      const added = await addSyllabusEvents(subject, step.events.filter((_, i) => picked.has(i)));
      onDone();
      setStep({ kind: 'done', added });
    } catch (e) { setStep({ kind: 'error', message: errText(e) }); }
  };

  const busy = step.kind === 'working';
  return (
    <Modal title={rescan ? 'Dates from the syllabus' : 'Add a syllabus'} onClose={busy ? () => {} : onClose} wide={step.kind === 'review'}>
      {step.kind === 'pick' && (
        <div className="form">
          {!initial && (
            <label className="field">
              <span>Subject</span>
              <select className="select" value={subjectId ?? ''} onChange={(e) => {
                const id = Number(e.target.value);
                setSubjectId(id);
                try { setNotes(localStorage.getItem(notesKey(id)) ?? ''); } catch { /* ignore */ }
              }}>
                {tree.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
          )}
          <label className="field">
            <span>Instructions for reading it <i className="muted">optional</i></span>
            <textarea
              className="textarea"
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. I'm in lecture section 002 and lab B3. Skip the weekly quizzes. The term starts Sept 3. Add the final to the calendar even if it's only 'TBA in December'."
            />
          </label>
          {!tree.length && !initial ? (
            <p className="muted">Create a subject in Study first; the syllabus belongs to a course.</p>
          ) : rescan ? (
            <p className="muted small">Reads the saved syllabus ({subject?.syllabusName}) again and lists the dates it finds, so you can pick which to add.</p>
          ) : (
            <button
              type="button"
              className={`syllabus-drop${dragging ? ' on' : ''}`}
              onClick={() => input.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) void upload(f); }}
            >
              <Upload />
              <b>Choose or drop the syllabus</b>
              <span className="muted">PDF, Word, slides, a photo or text. It is kept with {subject?.name ?? 'the subject'}: the AI tutor in its notebooks reads the summary, and exam and due dates can go straight into Schedule.</span>
            </button>
          )}
          <input ref={input} type="file" hidden accept={SYLLABUS_ACCEPT} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void upload(f); }} />
        </div>
      )}

      {step.kind === 'working' && <div className="gen-status syllabus-working"><span className="dots"><i /><i /><i /></span>{step.text}…</div>}

      {step.kind === 'review' && (
        <div className="syllabus-review">
          {step.file && (
            <section>
              <div className="panel-title">What the tutor will know</div>
              {step.summary ? <div className="syllabus-summary"><Markdown text={step.summary} /></div> : <p className="muted">No course details were found.</p>}
            </section>
          )}
          <section>
            <div className="panel-title-row">
              <span className="panel-title">Dates found <span className="muted">{step.events.length}</span></span>
              {step.events.length > 0 && (
                <button type="button" className="link" onClick={() => setPicked(picked.size === step.events.length ? new Set() : new Set(step.events.map((_, i) => i)))}>
                  {picked.size === step.events.length ? 'select none' : 'select all'}
                </button>
              )}
            </div>
            {!step.events.length && <p className="muted">No dated exams or deadlines were found in the syllabus.</p>}
            <ul className="syllabus-events">
              {step.events.map((e, i) => (
                <li key={i}>
                  <label className={`syllabus-event${picked.has(i) ? '' : ' off'}`}>
                    <input type="checkbox" checked={picked.has(i)} onChange={() => setPicked((p) => { const n = new Set(p); if (n.has(i)) n.delete(i); else n.add(i); return n; })} />
                    <span className={`kind-dot ${e.kind}`} />
                    <span className="syllabus-event-date">{fmtDay(e.date)}{e.start ? ` · ${e.start}${e.end ? `–${e.end}` : ''}` : ''}</span>
                    <span className="syllabus-event-title">{e.title}{e.notes && <span className="muted"> — {e.notes}</span>}</span>
                    <span className="muted small">{KINDS.find((k) => k.kind === e.kind)?.label}</span>
                  </label>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}

      {step.kind === 'done' && (
        <p>{rescan ? '' : `The syllabus is saved with ${subject?.name}. `}{step.added ? `${step.added} date${step.added === 1 ? ' was' : 's were'} added to Schedule.` : 'No dates were added.'}</p>
      )}
      {step.kind === 'error' && <div className="form-err">{step.message}</div>}

      <div className="modal-actions">
        {step.kind === 'review' ? (
          <>
            <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
            <button type="button" className="btn primary" onClick={() => void save()}>
              {step.file ? (picked.size ? `Save and add ${picked.size} date${picked.size === 1 ? '' : 's'}` : 'Save syllabus') : `Add ${picked.size} date${picked.size === 1 ? '' : 's'}`}
            </button>
          </>
        ) : step.kind === 'error' ? (
          <>
            <button type="button" className="btn ghost" onClick={onClose}>Close</button>
            <button type="button" className="btn primary" onClick={() => setStep({ kind: 'pick' })}>Try again</button>
          </>
        ) : step.kind === 'pick' && rescan ? (
          <>
            <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
            <button type="button" className="btn primary" onClick={() => void reread()}>Find dates</button>
          </>
        ) : (
          <button type="button" className="btn ghost" disabled={busy} onClick={onClose}>{step.kind === 'done' ? 'Done' : 'Cancel'}</button>
        )}
      </div>
    </Modal>
  );
}

/** The subject page's syllabus section. */
export function SyllabusPanel({ subject, onChanged }: { subject: SubjectNode; onChanged: () => void }) {
  const [dialog, setDialog] = useState<'upload' | 'rescan' | null>(null);
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const has = !!subject.syllabusName;
  return (
    <section className="page-section">
      <h2 className="section-title">Syllabus</h2>
      {!has ? (
        <button type="button" className="syllabus-empty" onClick={() => setDialog('upload')}>
          <Upload />
          <span><b>Add the course syllabus</b><span className="muted">The notebooks' AI tutor learns the grading, exam format and topics, and exam and due dates go into Schedule.</span></span>
        </button>
      ) : (
        <div className="syllabus-card">
          <div className="syllabus-head">
            <FileText />
            <span className="syllabus-name">{subject.syllabusName}</span>
            <span className="muted small">added {new Date(subject.syllabusAt).toLocaleDateString()}</span>
            <span className="spacer" />
            <button type="button" className="btn ghost" onClick={() => setDialog('rescan')} title="Find exam and due dates in it and add them to Schedule"><CalendarPlus /><span className="btn-label">Add dates</span></button>
            <button type="button" className="icon-btn" onClick={() => setDialog('upload')} title="Replace with a new file"><RefreshCw /></button>
            {confirm ? (
              <>
                <button type="button" className="btn ghost danger" onClick={async () => { await studyApi.clearSyllabus(subject.id); setConfirm(false); onChanged(); }}>Remove</button>
                <button type="button" className="btn ghost" onClick={() => setConfirm(false)}>Keep</button>
              </>
            ) : <button type="button" className="icon-btn" onClick={() => setConfirm(true)} title="Remove the syllabus"><Trash /></button>}
          </div>
          {subject.syllabusSummary && (
            <div className={`syllabus-summary${open ? ' open' : ''}`}>
              <Markdown text={subject.syllabusSummary} />
              {!open && <button type="button" className="syllabus-more" onClick={() => setOpen(true)}>Show all</button>}
            </div>
          )}
        </div>
      )}
      {dialog && (
        <SyllabusDialog subject={subject} tree={[subject]} rescan={dialog === 'rescan'} onClose={() => setDialog(null)} onDone={onChanged} />
      )}
    </section>
  );
}
