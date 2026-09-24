import { generate } from './salem/generate';
import { transcribe } from './ingest';
import { pythonStatus, runPython, sandboxName } from './python';
import { studyApi, type EventKind, type SubjectNode } from '../study/api';

export function courseContextOf(s: Pick<SubjectNode, 'context' | 'syllabusSummary'>): string {
  const summary = s.syllabusSummary?.trim();
  return [s.context.trim(), summary ? `Course syllabus (summary):\n${summary}` : ''].filter(Boolean).join('\n\n');
}

export const SYLLABUS_ACCEPT = '.pdf,.docx,.pptx,image/*,.txt,.md,.markdown,.html,.htm,.rtf';

const readDataUrl = (file: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result));
  r.onerror = () => reject(r.error);
  r.readAsDataURL(file);
});

const SCAN_CHARS = 80;
const MAX_SCAN_PAGES = 8;

async function py(code: string, attachmentId: number) {
  const st = await pythonStatus().catch(() => null);
  if (!st?.ready) throw new Error('Reading this file needs Python. Settings → Python → Install.');
  const r = await runPython(code, 120, [attachmentId], { maxOutput: 4_000_000 });
  if (!r.ok) throw new Error((r.error ?? r.stderr ?? 'Python failed').split('\n').slice(-3).join(' '));
  return JSON.parse(r.stdout.trim().split('\n').pop() ?? 'null');
}

export async function readSyllabus(file: File, stage: (t: string) => void): Promise<{ attachmentId: number; text: string }> {
  if (file.size > 60 * 1024 * 1024) throw new Error('That file is larger than 60 MB.');
  stage('saving the file');
  const data = await readDataUrl(file);
  const info = await studyApi.attachmentAdd({ kind: 'syllabus', name: file.name, mime: file.type || 'application/octet-stream', data });
  const name = file.name.toLowerCase();
  const arg = JSON.stringify(sandboxName(file.name));
  let text = '';
  if (file.type === 'application/pdf' || name.endsWith('.pdf')) {
    stage('reading pages');
    const out = await py(`import json, base64
doc = pymupdf.open(${arg})
pages, scans = [], []
for i, page in enumerate(doc):
    t = page.get_text("text").strip()
    pages.append(t)
    if len(t) < ${SCAN_CHARS} and len(scans) < ${MAX_SCAN_PAGES}:
        scans.append([i, "data:image/png;base64," + base64.b64encode(page.get_pixmap(dpi=110).tobytes("png")).decode()])
print(json.dumps({"pages": pages, "scans": scans}))`, info.id) as { pages: string[]; scans: [number, string][] };
    for (const [n, [i, url]] of out.scans.entries()) {
      stage(`reading scanned page ${n + 1} of ${out.scans.length}`);
      out.pages[i] = await transcribe(url).catch(() => out.pages[i]);
    }
    text = out.pages.map((t, i) => `--- page ${i + 1} ---\n${t}`).join('\n\n');
  } else if (name.endsWith('.docx')) {
    stage('reading the document');
    const paras = await py(`import zipfile, re, json, html
xml = zipfile.ZipFile(${arg}).read("word/document.xml").decode("utf8")
out = []
for p in re.findall(r"<w:p[ >].*?</w:p>", xml, re.S):
    cells = "".join(re.findall(r"<w:t[^>]*>(.*?)</w:t>", p, re.S))
    if cells.strip(): out.append(html.unescape(cells))
print(json.dumps(out))`, info.id) as string[];
    text = paras.join('\n');
  } else if (name.endsWith('.pptx')) {
    stage('reading the slides');
    const slides = await py(`import json
from pptx import Presentation
out = []
for s in Presentation(${arg}).slides:
    out.append("\\n".join(sh.text_frame.text for sh in s.shapes if sh.has_text_frame))
print(json.dumps(out))`, info.id) as string[];
    text = slides.map((t, i) => `--- slide ${i + 1} ---\n${t}`).join('\n\n');
  } else if (file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|heic)$/.test(name)) {
    stage('reading the image');
    text = await transcribe(data);
  } else {
    stage('reading the text');
    text = await file.text();
    if (/\.html?$/.test(name)) text = new DOMParser().parseFromString(text, 'text/html').body.innerText;
  }
  if (!text.replace(/--- (page|slide) \d+ ---/g, '').trim()) throw new Error('No text could be read from this file.');
  return { attachmentId: info.id, text };
}

export type SyllabusEvent = {
  title: string;
  kind: EventKind;
  date: string;
  start: string | null;
  end: string | null;
  notes: string;
};

const SYLLABUS_SYSTEM = `You read university course syllabuses for a student's study app. Return JSON only:
{"summary": "<markdown>", "events": [{"title": "...", "kind": "exam|deadline|class|other", "date": "YYYY-MM-DD", "start": "HH:MM" or null, "end": "HH:MM" or null, "notes": "..."}]}

summary: a compact Markdown briefing the student's AI tutor will read before every answer (at most ~350 words). Sections, only those the syllabus supports:
### Course - code, title, term, level, textbook.
### Grading - the weight of each component (a short list), grade cut-offs if given.
### Exams - how many, format, what is allowed (formula sheet, calculator), what they cover.
### Topics - the topics in teaching order, grouped by week or unit when given.
### Policies - late work, missed exams, collaboration, in one line each.
Skip contact details, office locations and boilerplate.

events: every dated item the student would put in a calendar: exams and quizzes (kind "exam"), assignment/lab/project/homework due dates (kind "deadline"), and one-off class events like no-class days, reviews or presentations ("class" or "other"). Not the recurring weekly lectures.
- Work out the year from the term named in the syllabus (and today's date below if it is not named). Dates must be real calendar dates.
- Times in 24-hour local time when given, otherwise null. Relative dates ("Week 7 Friday") → resolve them only if the term start date is known; otherwise leave them out.
- title: short, e.g. "Midterm 1", "Lab 3 report due". notes: what it covers or where, one line, or "".
- If the syllabus has no dates, return an empty events list.`;

const SYLLABUS_SCHEMA = {
  type: 'object',
  required: ['summary', 'events'],
  properties: {
    summary: { type: 'string' },
    events: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'kind', 'date'],
        properties: {
          title: { type: 'string' },
          kind: { type: 'string', enum: ['exam', 'deadline', 'class', 'study', 'other'] },
          date: { type: 'string' },
          start: { type: 'string' },
          end: { type: 'string' },
          notes: { type: 'string' },
        },
      },
    },
  },
};

export async function analyzeSyllabus(subject: string, text: string, instructions = ''): Promise<{ summary: string; events: SyllabusEvent[] }> {
  const today = new Date().toLocaleDateString('en-CA');
  const clipped = text.length > 80_000 ? `${text.slice(0, 80_000)}\n[… truncated]` : text;
  const obj = await generate<Record<string, unknown>>({
    feature: 'sources',
    system: SYLLABUS_SYSTEM,
    instruction: `Course in the app: ${subject}\nToday: ${today}${instructions.trim() ? `\n\nThe student's instructions for reading it (follow them; they override the defaults above):\n${instructions.trim()}` : ''}\n\n<syllabus>\n${clipped}\n</syllabus>`,
    schema: SYLLABUS_SCHEMA,
  });
  const kinds: EventKind[] = ['exam', 'deadline', 'class', 'study', 'other'];
  const time = (v: unknown) => (typeof v === 'string' && /^\d{1,2}:\d{2}$/.test(v) ? v.padStart(5, '0') : null);
  const events = (Array.isArray(obj.events) ? obj.events : [])
    .map((e) => e as Record<string, unknown>)
    .filter((e) => typeof e.title === 'string' && typeof e.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e.date) && !Number.isNaN(new Date(`${e.date}T00:00`).getTime()))
    .map((e) => ({
      title: String(e.title).trim().slice(0, 140),
      kind: kinds.includes(e.kind as EventKind) ? (e.kind as EventKind) : 'other',
      date: String(e.date),
      start: time(e.start),
      end: time(e.end),
      notes: typeof e.notes === 'string' ? e.notes.trim() : '',
    }))
    .sort((a, b) => a.date.localeCompare(b.date) || (a.start ?? '').localeCompare(b.start ?? ''));
  return { summary: typeof obj.summary === 'string' ? obj.summary.trim() : '', events };
}

export async function addSyllabusEvents(subject: Pick<SubjectNode, 'id' | 'name'>, events: SyllabusEvent[]): Promise<number> {
  const prefix = `${subject.name}:`.toLowerCase();
  for (const e of events) {
    const at = (t: string) => new Date(`${e.date}T${t}`).getTime();
    const allDay = !e.start;
    const title = e.title.toLowerCase().startsWith(prefix) ? e.title.slice(prefix.length).trim() || e.title : e.title;
    await studyApi.addEvent({
      title,
      kind: e.kind,
      allDay,
      startAt: allDay ? at('00:00') : at(e.start!),
      endAt: allDay || !e.end ? null : at(e.end),
      notes: e.notes,
      notebookId: null,
      subjectId: subject.id,
      done: false,
    });
  }
  return events.length;
}
