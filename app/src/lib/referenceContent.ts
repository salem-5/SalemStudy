/**
 * Fetching what a reference points at, before the chat opens.
 *
 * A reference carries a highlighted line and a locator. That is enough for
 * the assistant to go and find the rest — but going and finding it costs a
 * tool call or three before it can start on the actual question, and the
 * student is sitting there watching it look up something they had open in
 * front of them.
 *
 * So it is fetched here instead, while the sheet is opening, and handed over
 * with the question. Nothing here throws: a reference whose material cannot
 * be read still works, it just falls back to telling the assistant where to
 * look.
 */
import { studyApi, type Quiz, type QuizQuestion } from '../study/api';
import type { Reference } from './reference';

const CONTEXT_UNITS = 2;
const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n)}…` : text);

const choiceLabel = (q: QuizQuestion, i: number) =>
  (q.type === 'mcq' || q.type === 'multi' ? `${String.fromCharCode(65 + i)}. ` : '');

/** One quiz question, written out the way the model should read it. */
function questionText(quiz: Quiz, index: number): string {
  const q = quiz.questions[index];
  if (!q) return '';
  const lines = [`Question ${index + 1} of ${quiz.questions.length} — ${q.topic}${q.difficulty ? ` (${q.difficulty})` : ''}`, '', q.prompt];
  if (q.choices?.length) {
    lines.push('', ...q.choices.map((c, i) => `${choiceLabel(q, i)}${c}`));
  }
  lines.push('', 'Correct answer:');
  if (q.type === 'mcq') lines.push(`${choiceLabel(q, Number(q.answer))}${q.choices?.[Number(q.answer)] ?? q.answer}`);
  else if (q.type === 'multi') lines.push((q.answers ?? []).map((i) => `${choiceLabel(q, i)}${q.choices?.[i] ?? ''}`).join('; '));
  else lines.push(`${q.answer}${q.unit ? ` ${q.unit}` : ''}`);
  if (q.hint) lines.push('', `Hint: ${q.hint}`);
  if (q.explanation) lines.push('', `Explanation: ${q.explanation}`);
  if (q.sources?.length) lines.push('', `From: ${q.sources.map((x) => `${x.title}, ${x.label}`).join('; ')}`);
  return lines.join('\n');
}

async function fetchContent(ref: Reference): Promise<Reference['content']> {
  const { noteId, quizId, questionIndex, deckId, cardId, sourceId, unit } = ref.locator;

  if (noteId !== undefined) {
    const note = await studyApi.note(noteId);
    return { title: `The note “${note.title}”`, body: clip(note.content, 24_000) };
  }

  if (quizId !== undefined) {
    const quiz = await studyApi.quiz(quizId);
    if (questionIndex === undefined) {
      const body = quiz.questions.map((_, i) => questionText(quiz, i)).join('\n\n---\n\n');
      return { title: `The quiz “${quiz.title}”`, body: clip(body, 24_000) };
    }
    return {
      title: `Question ${questionIndex + 1} of the quiz “${quiz.title}”`,
      body: questionText(quiz, questionIndex),
    };
  }

  if (deckId !== undefined) {
    const cards = await studyApi.deckCards(deckId);
    const one = cardId === undefined ? undefined : cards.find((c) => c.id === cardId);
    if (one) {
      const where = cards.findIndex((c) => c.id === one.id) + 1;
      return {
        title: `Card ${where} of ${cards.length}${one.topic ? ` — ${one.topic}` : ''}`,
        body: `Front:\n${one.front}\n\nBack:\n${one.back}`,
      };
    }
    const body = cards.map((c, i) => `Card ${i + 1}${c.topic ? ` — ${c.topic}` : ''}\nFront: ${c.front}\nBack: ${c.back}`).join('\n\n');
    return { title: 'The deck', body: clip(body, 24_000) };
  }

  if (sourceId !== undefined) {
    const units = await studyApi.sourceUnits(sourceId);
    if (!units.length) return undefined;
    // A page on its own reads as a fragment; the ones either side are what
    // make it make sense.
    const around = unit === undefined
      ? units.slice(0, 6)
      : units.filter((u) => u.ord >= unit - CONTEXT_UNITS && u.ord <= unit + CONTEXT_UNITS);
    const chosen = around.length ? around : units.slice(0, 3);
    const body = chosen
      .sort((a, b) => a.ord - b.ord)
      .map((u) => `[${u.label}]\n${clip(u.text, 4000)}`)
      .join('\n\n');
    const span = unit === undefined ? 'the opening pages' : `the pages around ${unit}`;
    return { title: `The source, ${span}`, body: clip(body, 24_000) };
  }

  return undefined;
}

/**
 * The same reference, with its material attached.
 *
 * Returns the reference unchanged when the material cannot be read, so a
 * failure here costs a tool call rather than the whole conversation.
 */
export async function resolve(ref: Reference): Promise<Reference> {
  // Already spelled out in the briefing: nothing to fetch, nothing to add.
  if (ref.briefed) return ref;
  try {
    const content = await fetchContent(ref);
    return content ? { ...ref, content } : ref;
  } catch {
    return ref;
  }
}

export const resolveAll = (refs: Reference[]): Promise<Reference[]> => Promise.all(refs.map(resolve));
