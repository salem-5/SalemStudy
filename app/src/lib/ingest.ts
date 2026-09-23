import { useSyncExternalStore } from 'react';
import { toSupportedImage } from './ai';
import { generateVision } from './salem/generate';
import { pythonStatus, runPython, sandboxName } from './python';
import { studyApi, type Source, type SourceKind } from '../study/api';

/**
 * Turning an uploaded source into text units (pages, slides, time spans).
 * Files are stored first, then read here: PDFs and slides with Python in the
 * sandbox, images and scanned pages with the Flash vision model, YouTube with
 * yt-dlp captions. The job store lets the Sources pane show live progress.
 */

type Unit = { label: string; text: string };

// ------------------------------------------------------------ job store

const jobs = new Map<number, string>();
const listeners = new Set<() => void>();
let snapshot: ReadonlyMap<number, string> = new Map();
const emit = () => { snapshot = new Map(jobs); listeners.forEach((l) => l()); };
const setStage = (id: number, stage: string | null) => { if (stage === null) jobs.delete(id); else jobs.set(id, stage); emit(); };

/** Source id → what it is doing right now. */
export function useIngestJobs(): ReadonlyMap<number, string> {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => snapshot);
}

// -------------------------------------------------------------- kinds

const TEXT_EXT = /\.(txt|md|markdown|tex|csv|tsv|json|py|js|ts|tsx|rs|c|cc|cpp|h|hpp|java|kt|m|r|sql|yaml|yml|xml|html|htm|css|ipynb|rst|org)$/i;

export function kindOf(file: File): SourceKind | 'docx' | null {
  const name = file.name.toLowerCase();
  if (file.type === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if (name.endsWith('.pptx')) return 'slides';
  if (name.endsWith('.docx')) return 'docx';
  if (file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|heic|bmp)$/.test(name)) return 'image';
  if (file.type.startsWith('text/') || TEXT_EXT.test(name)) return 'text';
  return null;
}

export const ACCEPT = '.pdf,.pptx,.docx,image/*,.txt,.md,.markdown,.tex,.csv,.tsv,.json,.py,.js,.ts,.rs,.c,.cpp,.h,.java,.m,.r,.sql,.yaml,.yml,.xml,.html,.ipynb,.rst';

const readDataUrl = (file: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result));
  r.onerror = () => reject(r.error);
  r.readAsDataURL(file);
});

const stem = (name: string) => name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || name;

// ------------------------------------------------------------ extractors

async function python(code: string, sourceId: number, extra: { maxOutput?: number; maxFigures?: number } = {}) {
  const r = await runPython(code, 120, undefined, { sources: [sourceId], maxOutput: extra.maxOutput ?? 6_000_000, maxFigures: extra.maxFigures });
  if (!r.ok) throw new Error((r.error ?? r.stderr ?? 'Python failed').split('\n').slice(-3).join(' '));
  return r;
}

const fileArg = (s: Source) => JSON.stringify(sandboxName(s.filename ?? s.title));

const VISION_PROMPT = `Transcribe this page of course material for a study index.
- Copy all text in reading order. Write every formula in LaTeX ($...$ inline, $$...$$ display).
- Tables as Markdown tables.
- For each figure, graph or diagram, one or two sentences: what it shows, axes, labels and key values.
- Handwriting: transcribe it as best you can; mark unreadable parts [illegible].
Output only the transcription, no preamble.`;

const FIGURE_PROMPT = `Describe the figures, graphs, diagrams, tables and pictures in this image of course material, for a study index.
- Say what each shows: axes, labels, units, key values, relationships, the conclusion it illustrates.
- Write any formula in LaTeX.
- Skip plain paragraph text and decorative logos. If there is nothing but text or decoration, reply with just: none
Output only the description.`;

async function vision(dataUrl: string, prompt: string): Promise<string> {
  const url = await toSupportedImage(dataUrl);
  if (!url) throw new Error('This image format cannot be read.');
  return generateVision({ feature: 'sources', prompt, image: url });
}

export const transcribe = (dataUrl: string) => vision(dataUrl, VISION_PROMPT);
const describeFigure = (dataUrl: string) => vision(dataUrl, FIGURE_PROMPT).then((t) => (/^none\.?$/i.test(t) ? '' : t));

/** Run `fn` over items, a few at a time (vision calls are slow but independent). */
async function pool<T>(items: T[], limit: number, fn: (item: T, i: number) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; await fn(items[i], i); }
  }));
}

const mimeOf = (dataUrl: string) => dataUrl.slice(5, dataUrl.indexOf(';')) || 'image/png';
const MAX_VISUAL_PAGES = 40;

async function extractPdf(s: Source, stage: (t: string) => void): Promise<Unit[]> {
  stage('reading pages');
  const r = await python(`import json
doc = pymupdf.open(${fileArg(s)})
out = []
for page in doc:
    text = page.get_text("text").strip()
    pictures = [i for i in page.get_images() if i[2] * i[3] > 40000]
    drawings = len(page.get_drawings())
    visual = len(pictures) > 0 or drawings > 20
    out.append({"text": text, "scan": len(text) < 80 and visual, "figure": visual and len(text) >= 80})
print(json.dumps(out))`, s.id);
  const pages = JSON.parse(r.stdout.trim().split('\n').pop() ?? '[]') as { text: string; scan: boolean; figure: boolean }[];
  if (!pages.length) throw new Error('The PDF has no pages.');
  // Pages that are scans, or that carry figures, are rendered and looked at:
  // scans are transcribed in full, figure pages get their figures described.
  const visual = pages.map((p, i) => (p.scan || p.figure ? i : -1)).filter((i) => i >= 0).slice(0, MAX_VISUAL_PAGES);
  let done = 0;
  for (let b = 0; b < visual.length; b += 8) {
    const batch = visual.slice(b, b + 8);
    stage(`looking at pages with figures (${done}/${visual.length})`);
    const rendered = await python(`doc = pymupdf.open(${fileArg(s)})
for i in ${JSON.stringify(batch)}:
    doc[i].get_pixmap(dpi=110).save(f"page-{i:04d}.png")`, s.id, { maxFigures: 8, maxOutput: 2000 });
    await pool(rendered.figures ?? [], 3, async (f) => {
      const i = Number(f.name.match(/page-(\d+)/)?.[1]);
      if (!Number.isFinite(i)) return;
      const p = pages[i];
      if (p.scan) {
        p.text = await transcribe(f.dataUrl).catch(() => p.text);
        await studyApi.addSourceImage(s.id, i, mimeOf(f.dataUrl), f.dataUrl, 'Scanned page').catch(() => {});
      } else {
        const d = await describeFigure(f.dataUrl).catch(() => '');
        if (d) {
          p.text += `\n\n[Figures on this page]\n${d}`;
          await studyApi.addSourceImage(s.id, i, mimeOf(f.dataUrl), f.dataUrl, d).catch(() => {});
        }
      }
      done++;
      stage(`looking at pages with figures (${done}/${visual.length})`);
    });
  }
  const units = pages.map((p, i) => ({ label: `Page ${i + 1}`, text: p.text }));
  await saveReport(s.id, units, {
    transcribed: visual.filter((i) => pages[i].scan).length,
    described: visual.filter((i) => pages[i].figure).length,
    skipped: Math.max(0, pages.filter((p) => p.scan || p.figure).length - visual.length),
  });
  return units;
}

/**
 * What reading this source was actually like.
 *
 * A page that came back empty looks exactly like a page that was blank, and a
 * scan whose transcription failed looks like a page with nothing on it. That
 * silence is the failure mode worth catching: the report says which pages are
 * empty, which had to be looked at, and whether two pages came back identical
 * — the sign of an extractor repeating itself.
 */
async function saveReport(
  sourceId: number,
  units: Unit[],
  extra: { transcribed?: number; described?: number; skipped?: number } = {},
): Promise<void> {
  const empty: number[] = [];
  const seen = new Map<string, number>();
  const duplicated: number[] = [];
  units.forEach((u, i) => {
    const text = u.text.trim();
    if (!text) {
      empty.push(i + 1);
      return;
    }
    // Identical long pages are the extractor stuttering, not the document.
    if (text.length > 200) {
      const first = seen.get(text);
      if (first !== undefined) duplicated.push(i + 1);
      else seen.set(text, i + 1);
    }
  });
  const report = {
    pages: units.length,
    characters: units.reduce((n, u) => n + u.text.length, 0),
    empty,
    duplicated,
    ...extra,
    at: Date.now(),
  };
  await studyApi.setSourceReport(sourceId, report).catch(() => {});
}

async function extractSlides(s: Source, stage: (t: string) => void): Promise<Unit[]> {
  stage('reading slides');
  // Text, tables and speaker notes per slide; every sizeable picture is saved
  // as slide-NNN-K.ext so it can be looked at and shown with its slide.
  const r = await python(`import json
from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE
prs = Presentation(${fileArg(s)})
out = []
saved = 0
def pictures(shapes):
    # Pictures, picture placeholders, and pictures inside groups.
    for sh in shapes:
        if sh.shape_type == MSO_SHAPE_TYPE.GROUP:
            yield from pictures(sh.shapes)
            continue
        try:
            yield sh.image
        except Exception:
            pass
for n, slide in enumerate(prs.slides):
    parts = []
    for shape in slide.shapes:
        if shape.has_text_frame:
            t = "\\n".join(p.text for p in shape.text_frame.paragraphs if p.text.strip())
            if t.strip(): parts.append(t)
        if getattr(shape, "has_table", False) and shape.has_table:
            parts.append("\\n".join(" | ".join(c.text for c in row.cells) for row in shape.table.rows))
    if slide.has_notes_slide and slide.notes_slide.notes_text_frame is not None:
        notes = slide.notes_slide.notes_text_frame.text.strip()
        if notes: parts.append("Speaker notes: " + notes)
    k = 0
    for img in pictures(slide.shapes):
        ext = (img.ext or "").lower()
        if ext not in ("png", "jpg", "jpeg", "gif") or len(img.blob) < 6000 or saved >= 40:
            continue
        open(f"slide-{n:03d}-{k}.{ext}", "wb").write(img.blob)
        k += 1
        saved += 1
    out.append("\\n\\n".join(parts))
print(json.dumps(out))`, s.id, { maxFigures: 40 });
  const slides = JSON.parse(r.stdout.trim().split('\n').pop() ?? '[]') as string[];
  const figures = r.figures ?? [];
  let done = 0;
  if (figures.length) stage(`looking at ${figures.length} slide pictures`);
  await pool(figures, 3, async (f) => {
    const n = Number(f.name.match(/slide-(\d+)/)?.[1]);
    if (!Number.isFinite(n) || n >= slides.length) return;
    const d = await describeFigure(f.dataUrl).catch(() => '');
    if (d) slides[n] += `\n\n[Picture on this slide]\n${d}`;
    await studyApi.addSourceImage(s.id, n, mimeOf(f.dataUrl), f.dataUrl, d).catch(() => {});
    done++;
    stage(`looking at slide pictures (${done}/${figures.length})`);
  });
  return slides.map((t, i) => ({ label: `Slide ${i + 1}`, text: t }));
}

async function extractDocx(s: Source, stage: (t: string) => void): Promise<Unit[]> {
  stage('reading document');
  // A .docx is a zip of XML; the standard library is enough for the text.
  const r = await python(`import zipfile, re, json, html
xml = zipfile.ZipFile(${fileArg(s)}).read("word/document.xml").decode("utf8")
paras = []
for p in re.findall(r"<w:p[ >].*?</w:p>", xml, re.S):
    t = "".join(re.findall(r"<w:t[^>]*>(.*?)</w:t>", p, re.S))
    heading = re.search(r'<w:pStyle w:val="(Heading|Title)', p)
    if t.strip(): paras.append(("# " if heading else "") + html.unescape(t))
print(json.dumps(paras))`, s.id);
  const paras = JSON.parse(r.stdout.trim().split('\n').pop() ?? '[]') as string[];
  return splitText(paras.join('\n\n'));
}

/** Markdown/LaTeX headings start a new unit; otherwise about 60 lines each. */
export function splitText(text: string): Unit[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const units: Unit[] = [];
  let buf: string[] = [];
  let start = 1;
  let heading: string | null = null;
  const flush = (end: number) => {
    const t = buf.join('\n').trim();
    if (t) units.push({ label: heading ?? `Lines ${start}–${end}`, text: t });
    buf = [];
  };
  lines.forEach((line, i) => {
    const h = line.match(/^#{1,3}\s+(.+)/) ?? line.match(/^\\(?:sub)*section\*?\{(.+?)\}/);
    if ((h && buf.join('').trim()) || buf.length >= 60) { flush(i); start = i + 1; heading = null; }
    if (h) heading = h[1].trim().slice(0, 80);
    buf.push(line);
  });
  flush(lines.length);
  return units;
}

const fmtTime = (sec: number) => {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};

/** Seconds from a unit label like "12:30–14:30". */
export const labelSeconds = (label: string): number | null => {
  const m = label.match(/^(?:(\d+):)?(\d+):(\d{2})/);
  return m ? (Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3])) : null;
};

async function extractYoutube(url: string, stage: (t: string) => void): Promise<{ title: string | null; units: Unit[] }> {
  stage('fetching captions');
  const t = await studyApi.youtubeTranscript(url);
  if (!t.segments.length) throw new Error('This video has no captions, so it cannot be read yet.');
  // Two-minute windows, or chapters when the video has them.
  const cuts = t.chapters.length > 1 ? t.chapters.map((c) => c.start) : [];
  const units: Unit[] = [];
  let cur: string[] = [];
  let from = t.segments[0].start;
  const flush = (to: number) => {
    const text = cur.join(' ').replace(/\s+/g, ' ').trim();
    const chapter = t.chapters.find((c) => Math.abs(c.start - from) < 1);
    if (text) units.push({ label: `${fmtTime(from)}–${fmtTime(to)}${chapter ? ` · ${chapter.title}` : ''}`, text });
    cur = [];
  };
  for (const seg of t.segments) {
    const boundary = cuts.length ? cuts.some((c) => c > from && seg.start >= c) : seg.start - from >= 120;
    if (boundary && cur.length) { flush(seg.start); from = seg.start; }
    cur.push(seg.text);
  }
  flush(t.segments[t.segments.length - 1].start);
  return { title: t.title, units };
}

// ---------------------------------------------------------------- driver

const running = new Set<number>();

/** Read a stored source into units and index it. Safe to call again to retry. */
export async function ingest(s: Source, file?: File): Promise<Source> {
  if (running.has(s.id)) return s;
  running.add(s.id);
  const stage = (t: string) => setStage(s.id, t);
  try {
    stage('starting');
    await studyApi.setSourceStatus(s.id, 'processing');
    await studyApi.clearSourceImages(s.id).catch(() => {});
    const needsPython = s.kind === 'pdf' || s.kind === 'slides' || s.filename?.toLowerCase().endsWith('.docx');
    if (needsPython) {
      const st = await pythonStatus().catch(() => null);
      if (!st?.ready) throw new Error('Reading this file needs Python. Settings → Python → Install.');
    }
    let units: Unit[] = [];
    if (s.kind === 'pdf') units = await extractPdf(s, stage);
    else if (s.kind === 'slides') units = await extractSlides(s, stage);
    else if (s.filename?.toLowerCase().endsWith('.docx')) units = await extractDocx(s, stage);
    else if (s.kind === 'image') {
      stage('reading the image');
      units = [{ label: 'Image', text: await transcribe(file ? await readDataUrl(file) : await studyApi.sourceData(s.id)) }];
    } else if (s.kind === 'text') {
      stage('reading text');
      const b64 = file ? '' : (await studyApi.sourceData(s.id)).split(',')[1] ?? '';
      const text = file ? await file.text() : new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
      units = splitText(text);
    } else if (s.kind === 'youtube' && s.url) {
      const yt = await extractYoutube(s.url, stage);
      units = yt.units;
      if (yt.title && (s.title === s.url || !s.title)) await studyApi.renameSource(s.id, yt.title.slice(0, 200));
    } else throw new Error('This file type cannot be read.');
    if (!units.some((u) => u.text.trim())) throw new Error('No text could be read from this source.');
    // Anything that did not write its own report gets the basic one, so every
    // source can say how its reading went.
    if (s.kind !== 'pdf') await saveReport(s.id, units);
    stage('indexing');
    return await studyApi.setSourceContent(s.id, units);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await studyApi.setSourceStatus(s.id, 'error', msg).catch(() => {});
    return { ...s, status: 'error', error: msg };
  } finally {
    running.delete(s.id);
    setStage(s.id, null);
  }
}

/** Store the files, then read each one. Unsupported files are reported, not stored. */
export async function addFiles(notebookId: number, files: File[], onAdded: () => void): Promise<string[]> {
  const problems: string[] = [];
  for (const file of files) {
    const k = kindOf(file);
    if (!k) { problems.push(`${file.name}: this file type is not supported (use PDF, PPTX, DOCX, images or text).`); continue; }
    if (file.size > 200 * 1024 * 1024) { problems.push(`${file.name} is larger than 200 MB.`); continue; }
    const s = await studyApi.addSource({
      notebookId, kind: k === 'docx' ? 'text' : k, title: stem(file.name), filename: file.name,
      mime: file.type || 'application/octet-stream', data: await readDataUrl(file),
    });
    onAdded();
    // .docx is stored as text-kind but read with Python.
    void ingest(s, k === 'docx' ? undefined : file).then(onAdded);
  }
  return problems;
}

export async function addYoutube(notebookId: number, url: string, onAdded: () => void): Promise<void> {
  const s = await studyApi.addSource({ notebookId, kind: 'youtube', title: url.trim(), url: url.trim() });
  onAdded();
  void ingest(s).then(onAdded);
}
