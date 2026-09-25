import { runPython, sandboxName } from './python';
import { generateQuick } from './salem/generate';
import type { Meter } from './meter';
import { isStop, type Stop } from './cancel.ts';
import { studyApi, type DiagramLabel, type QuizQuestion, type Source } from '../study/api';
import { evidenceFor, isTaught, repeats, toLabels, withoutPictures, type Found, type Page as DiagramPage, type Picked } from './diagramLabels.ts';

const KINDS: Record<string, 'pdf' | 'slides' | 'image'> = { pdf: 'pdf', slides: 'slides', image: 'image' };

const script = (file: string, kind: string) => `import io, json
import numpy as np
from PIL import Image
from rapidocr import RapidOCR

SOURCE = ${JSON.stringify(file)}
KIND = ${JSON.stringify(kind)}
engine = RapidOCR(params={"Global.log_level": "critical"})
found = []
prints = []

def fingerprint(img):
    small = np.asarray(img.convert("L").resize((16, 16)), dtype=float)
    return (small > small.mean()).flatten()

def seen_before(img):
    mark = fingerprint(img)
    if any(int((mark != other).sum()) <= 12 for other in prints):
        return True
    prints.append(mark)
    return False

def lines_of(arr):
    h, w = arr.shape[:2]
    res = engine(arr)
    out = []
    if res.boxes is None:
        return out
    for box, txt, score in zip(res.boxes, res.txts, res.scores):
        t = txt.strip()
        if score < 0.6 or not t:
            continue
        xs = [float(p[0]) for p in box]
        ys = [float(p[1]) for p in box]
        out.append({"t": t, "b": [round(min(xs) / w, 4), round(min(ys) / h, 4), round(max(xs) / w, 4), round(max(ys) / h, 4)]})
    return out

def labelled(lines):
    short = [l for l in lines if len(l["t"].split()) <= 5]
    area = sum((l["b"][2] - l["b"][0]) * (l["b"][3] - l["b"][1]) for l in lines)
    return len(short) >= 3 and len(short) >= 0.6 * len(lines) and area <= 0.35

def on_white(img):
    # A transparent picture is laid on white, as it would sit on a slide or a page. Converting it
    # straight to RGB keeps whatever colour hides under the transparency, usually black.
    if img.mode in ("RGBA", "LA", "PA") or (img.mode == "P" and "transparency" in img.info):
        rgba = img.convert("RGBA")
        return Image.alpha_composite(Image.new("RGBA", rgba.size, (255, 255, 255, 255)), rgba).convert("RGB")
    return img.convert("RGB")

def consider(data, where):
    if len(found) >= 24:
        return
    try:
        img = on_white(Image.open(io.BytesIO(data)))
    except Exception:
        return
    w, h = img.size
    if min(w, h) < 180 or w * h < 90000:
        return
    if seen_before(img):
        return
    lines = lines_of(np.array(img))
    if not labelled(lines):
        return
    scale = min(1.0, 1400 / max(w, h))
    if scale < 1:
        img = img.resize((round(w * scale), round(h * scale)))
    name = f"diagram-{len(found):03d}.png"
    img.save(name)
    found.append({"name": name, "where": where, "lines": lines})

if KIND == "pdf":
    doc = pymupdf.open(SOURCE)
    seen = set()
    for pno, page in enumerate(doc):
        for info in page.get_images(full=True):
            xref, smask = info[0], info[1]
            if xref in seen:
                continue
            seen.add(xref)
            try:
                pix = pymupdf.Pixmap(doc, xref)
                if pix.n - pix.alpha >= 4:
                    pix = pymupdf.Pixmap(pymupdf.csRGB, pix)
                # A PDF keeps an image's transparency in a separate soft mask: put it back on, so
                # consider() can lay the picture on white instead of on the black beneath it.
                if smask and not pix.alpha:
                    try:
                        mask = pymupdf.Pixmap(doc, smask)
                        if (mask.width, mask.height) == (pix.width, pix.height):
                            pix = pymupdf.Pixmap(pix, mask)
                    except Exception:
                        pass
                consider(pix.tobytes("png"), pno)
            except Exception:
                continue
elif KIND == "slides":
    from pptx import Presentation
    from pptx.enum.shapes import MSO_SHAPE_TYPE
    def pictures(shapes):
        for sh in shapes:
            if sh.shape_type == MSO_SHAPE_TYPE.GROUP:
                yield from pictures(sh.shapes)
            elif sh.shape_type == MSO_SHAPE_TYPE.PICTURE:
                yield sh
    for n, slide in enumerate(Presentation(SOURCE).slides):
        for pic in pictures(slide.shapes):
            try:
                consider(pic.image.blob, n)
            except Exception:
                pass
elif KIND == "image":
    consider(open(SOURCE, "rb").read(), 0)
print(json.dumps(found))
`;

export const DIAGRAM_SYSTEM = `You turn labelled diagrams from a student's lecture into label-the-diagram quiz questions. You get what the lecture covers - an outline of its pages, and the text of the pages around each picture - and, for each picture, the text found on it line by line, each line with where it sits: x and y from 0 to 1, left to right and top to bottom.

For each picture decide three things, strictly.

1. Is it a labelled diagram? A drawing, scheme, micrograph, X-ray or photo with names placed on or around it, usually with lines pointing at parts. A slide of text or bullet points, a table, a chart, or a flow of sentences is not. If not, set use to false.

2. Is it about what this lecture teaches? Lecturers add pictures that are only loosely related: a diagram from a neighbouring topic, an overview borrowed from another course, decoration. Use a diagram only when what it shows is the subject of the pages around it. If it is only loosely related, set use to false.

3. Which labels does the lecture teach? Hide only labels for things the lecture's own text names and teaches. Lecturers often use a picture of a whole organ, system or region to show one part of it; then hide only the labels for that part and leave every other label on the picture. Never hide a label just because it is on the picture. Leave out titles, headings (including ones that only group other labels, like "External callus:"), figure numbers, credits and website names. One hidden label is fine; never more than 12.

A label can span several lines; give every one of its line numbers. Write each answer as the label reads, without stray marks the reading picked up from a pointer line ("-Periosteum" is "Periosteum"). In accept, give other names a student could rightly write, and the words the lecture itself uses for it when they differ. Write a short prompt saying what the diagram shows and what to label, e.g. "Label the stages and tissues of fracture healing.", and a short topic.`;

const SCHEMA = {
  type: 'object',
  required: ['diagrams'],
  properties: {
    diagrams: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'use'],
        properties: {
          name: { type: 'string' },
          use: { type: 'boolean' },
          prompt: { type: 'string' },
          topic: { type: 'string' },
          labels: {
            type: 'array',
            items: {
              type: 'object',
              required: ['lines', 'answer'],
              properties: {
                lines: { type: 'array', items: { type: 'integer' } },
                answer: { type: 'string' },
                accept: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  },
};

const CHOSEN_NOTE = 'The student picked every one of these pictures themselves to be quizzed on. Set use to true for each and choose its labels as above; set it to false only for a picture with no labels on it at all.';

const unlessStopped = (e: unknown): null => {
  if (isStop(e)) throw e;
  return null;
};

export type Lecture = { texts: DiagramPage[]; notes: string[]; pages: Map<number, Map<number, string>> };

const clip = (t: string, max: number) => (t.length > max ? `${t.slice(0, max)}…` : t);

const firstLine = (t: string) => withoutPictures(t).split('\n').map((l) => l.trim()).find(Boolean) ?? '';

function outline(source: Source, lecture: Lecture): string {
  const pages = [...(lecture.pages.get(source.id) ?? new Map<number, string>()).entries()].sort((a, b) => a[0] - b[0]);
  return clip(pages.map(([n, t]) => `${whereLabel(source, n)}: ${clip(firstLine(t), 110)}`).join('\n'), 6000);
}

function around(source: Source, lecture: Lecture, where: number): string {
  const pages = lecture.pages.get(source.id);
  if (!pages) return '';
  return [where - 1, where, where + 1]
    .filter((n) => pages.has(n))
    .map((n) => `${whereLabel(source, n)}: ${clip(withoutPictures(pages.get(n) ?? '').replace(/\s+/g, ' ').trim(), 900)}`)
    .join('\n');
}

const describe = (f: Found, source: Source, lecture: Lecture) => [
  `### ${f.name} (${whereLabel(source, f.where)})`,
  `The lecture around it:\n${around(source, lecture, f.where) || '(no text on these pages)'}`,
  'Text on the picture:',
  ...f.lines.map((l, i) => `${i}: ${JSON.stringify(l.t)} x ${l.b[0].toFixed(2)}-${l.b[2].toFixed(2)}, y ${l.b[1].toFixed(2)}-${l.b[3].toFixed(2)}`),
].join('\n');

const loadImage = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error('The picture could not be read.'));
  img.src = src;
});

export async function maskLabels(dataUrl: string, boxes: DiagramLabel['box'][]): Promise<string> {
  const img = await loadImage(dataUrl);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return dataUrl;
  ctx.drawImage(img, 0, 0);
  const pixels = ctx.getImageData(0, 0, w, h).data;
  for (const [bx0, by0, bx1, by1] of boxes) {
    const x0 = Math.max(0, Math.floor(bx0 * w) - 2);
    const y0 = Math.max(0, Math.floor(by0 * h) - 2);
    const x1 = Math.min(w, Math.ceil(bx1 * w) + 2);
    const y1 = Math.min(h, Math.ceil(by1 * h) + 2);
    const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
    const take = (x: number, y: number) => {
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      const i = (y * w + x) * 4;
      const key = ((pixels[i] >> 4) << 8) | ((pixels[i + 1] >> 4) << 4) | (pixels[i + 2] >> 4);
      const bucket = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
      bucket.n += 1; bucket.r += pixels[i]; bucket.g += pixels[i + 1]; bucket.b += pixels[i + 2];
      buckets.set(key, bucket);
    };
    for (let ring = 3; ring <= 6; ring += 3) {
      for (let x = x0 - ring; x <= x1 + ring; x += 2) { take(x, y0 - ring); take(x, y1 + ring - 1); }
      for (let y = y0 - ring; y <= y1 + ring; y += 2) { take(x0 - ring, y); take(x1 + ring - 1, y); }
    }
    const common = [...buckets.values()].sort((p, q) => q.n - p.n)[0];
    ctx.fillStyle = common ? `rgb(${Math.round(common.r / common.n)}, ${Math.round(common.g / common.n)}, ${Math.round(common.b / common.n)})` : '#fff';
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  }
  return canvas.toDataURL('image/png');
}

async function findIn(source: Source): Promise<{ found: Found[]; images: Map<string, string> }> {
  const kind = KINDS[source.kind];
  const file = source.filename ?? source.title;
  if (!kind || !file) return { found: [], images: new Map() };
  const r = await runPython(script(sandboxName(file), kind), 300, undefined, { sources: [source.id], maxOutput: 3_000_000, maxFigures: 24 });
  if (!r.ok) throw new Error((r.error ?? r.stderr ?? 'Reading the diagrams failed.').split('\n').slice(-2).join(' '));
  const found = JSON.parse((r.stdout || '').trim().split('\n').pop() || '[]') as Found[];
  return { found, images: new Map((r.figures ?? []).map((f) => [f.name, f.dataUrl])) };
}

export const whereLabel = (source: Source, where: number) => (source.kind === 'pdf' ? `Page ${where + 1}` : source.kind === 'slides' ? `Slide ${where + 1}` : source.title);

/** A picture with labels on it, found in a source before any question is written about it. */
export type FoundDiagram = { key: string; source: Source; found: Found; image: string };

/**
 * A diagram offered for a quiz. `matches` when the AI found it is about what the lecture teaches,
 * with `labels` the ones to hide; the rest are only shown when the student asks to see them all.
 */
export type DiagramCandidate = FoundDiagram & { matches: boolean; labels: DiagramLabel[]; choice: Picked | null };

export const canHoldDiagrams = (source: Source) => !!KINDS[source.kind];

// A source's file never changes under the same id, created time and size, so what was found in it
// - and what the AI made of each picture - is kept for the session instead of worked out again.
const sourceKey = (s: Source) => `${s.id}:${s.createdAt}:${s.size}`;
const scans = new Map<string, Promise<FoundDiagram[]>>();
const choices = new Map<string, Picked>();

/** Every labelled picture in a source. Runs locally, no AI, and only once per source. */
export async function findDiagrams(source: Source, stop?: Stop): Promise<FoundDiagram[]> {
  stop?.throwIfStopped();
  const key = sourceKey(source);
  let job = scans.get(key);
  if (!job) {
    job = findIn(source).then(({ found, images }) => found.flatMap((f) => {
      const image = images.get(f.name);
      return image ? [{ key: `${source.id}:${f.name}`, source, found: f, image }] : [];
    }));
    scans.set(key, job);
    job.catch(() => scans.delete(key));
  }
  const list = await job;
  stop?.throwIfStopped();
  return list;
}

/** What the AI makes of each picture: whether to use it, and which labels to hide. Asked once per picture. */
async function chooseIn(source: Source, found: Found[], lecture: Lecture, chosen: boolean, meter?: Meter, stop?: Stop): Promise<Map<string, Picked>> {
  const tag = (f: Found) => `${sourceKey(source)}:${f.name}:${chosen ? 'chosen' : 'auto'}`;
  const ask = found.filter((f) => !choices.has(tag(f)));
  for (let i = 0; i < ask.length; i += 8) {
    const batch = ask.slice(i, i + 8);
    const raw = await generateQuick<{ diagrams?: Picked[] }>({
      feature: 'quiz',
      system: DIAGRAM_SYSTEM,
      instruction: `# What the lecture covers: ${source.title}\n${outline(source, lecture)}\n\n# The pictures\n\n${batch.map((f) => describe(f, source, lecture)).join('\n\n')}${chosen ? `\n\n${CHOSEN_NOTE}` : ''}`,
      schema: SCHEMA,
      meter,
      stop,
    }).catch(unlessStopped);
    for (const p of raw?.diagrams ?? []) {
      const f = batch.find((x) => x.name === p.name);
      if (f) choices.set(tag(f), p);
    }
  }
  return new Map(found.flatMap((f) => { const p = choices.get(tag(f)); return p ? [[f.name, p] as const] : []; }));
}

const taughtLabels = (d: FoundDiagram, choice: Picked, lecture: Lecture) =>
  toLabels(d.found, choice).filter((l) => isTaught(l, evidenceFor(lecture.texts, d.source.id, d.found.where, d.found.lines, lecture.notes))).slice(0, 12);

/** Every labelled diagram in the sources, each marked with whether it matches what they teach. */
export async function diagramCandidates(
  sources: Source[],
  lecture: Lecture,
  progress: (text: string) => void,
  meter?: Meter,
  stop?: Stop,
): Promise<DiagramCandidate[]> {
  const out: DiagramCandidate[] = [];
  const taken: DiagramLabel[][] = [];
  for (const source of sources) {
    if (!canHoldDiagrams(source)) continue;
    progress(`Looking for labelled diagrams in ${source.title}…`);
    const found = await findDiagrams(source, stop).catch((e) => { unlessStopped(e); return [] as FoundDiagram[]; });
    if (!found.length) continue;
    progress(`${source.title}: ${found.length} picture${found.length === 1 ? '' : 's'} with text on them, choosing the diagrams…`);
    const picked = await chooseIn(source, found.map((d) => d.found), lecture, false, meter, stop);
    for (const d of found) {
      const choice = picked.get(d.found.name) ?? null;
      const labels = choice?.use === true ? taughtLabels(d, choice, lecture) : [];
      const matches = labels.length > 0 && !repeats(labels, taken);
      if (matches) taken.push(labels);
      out.push({ ...d, matches, labels: matches ? labels : [], choice });
    }
  }
  return out;
}

/**
 * Label questions from the given diagrams. One the AI passed over (the student chose it from the
 * full list) has its labels read again, told the student wants it; it keeps them even when the
 * pages around it never name them.
 */
export async function questionsFromDiagrams(
  chosen: DiagramCandidate[],
  lecture: Lecture,
  notebookId: number,
  want: number,
  progress: (text: string) => void,
  meter?: Meter,
  stop?: Stop,
): Promise<QuizQuestion[]> {
  const out: QuizQuestion[] = [];
  const extra = chosen.filter((d) => !d.labels.length);
  const reread = new Map<string, Picked>();
  for (const source of [...new Map(extra.map((d) => [d.source.id, d.source])).values()]) {
    const mine = extra.filter((d) => d.source.id === source.id);
    progress(`${source.title}: reading the labels on the ${mine.length} diagram${mine.length === 1 ? '' : 's'} you chose…`);
    const picked = await chooseIn(source, mine.map((d) => d.found), lecture, true, meter, stop);
    for (const d of mine) { const p = picked.get(d.found.name); if (p) reread.set(d.key, p); }
  }
  for (const d of chosen) {
    if (out.length >= want) break;
    const choice = d.labels.length ? d.choice : reread.get(d.key);
    if (!choice) continue;
    let labels = d.labels;
    if (!labels.length) {
      labels = taughtLabels(d, choice, lecture);
      if (!labels.length) labels = toLabels(d.found, choice).slice(0, 12);
    }
    if (!labels.length) continue;
    const { source, found: f } = d;
    stop?.throwIfStopped();
    progress(`Covering the labels on ${whereLabel(source, f.where).toLowerCase()} of ${source.title}…`);
    const masked = await maskLabels(d.image, labels.map((l) => l.box)).catch(() => null);
    if (!masked) continue;
    const [image, original] = await Promise.all([
      studyApi.attachmentAdd({ notebookId, kind: 'figure', name: `${f.name.replace(/\.png$/, '')}-blank.png`, mime: 'image/png', data: masked }),
      studyApi.attachmentAdd({ notebookId, kind: 'figure', name: f.name, mime: 'image/png', data: d.image }),
    ]);
    out.push({
      type: 'label',
      prompt: String(choice.prompt ?? '').trim() || 'Label the diagram.',
      answer: labels.map((l) => l.answer).join(' · '),
      explanation: labels.map((l, i) => `${i + 1}. ${l.answer}`).join('\n'),
      topic: String(choice.topic ?? '').trim() || 'Diagrams',
      diagram: { image: image.id, original: original.id, labels },
      sources: [{ sourceId: source.id, title: source.title, label: whereLabel(source, f.where), unit: f.where }],
      verified: false,
    });
  }
  return out;
}
