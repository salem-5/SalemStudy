import { generateCards, generateQuiz, type CardOptions, type GenSource, type QuizOptions, type StudyContext } from './studyGen';
import { studyApi } from '../study/api';

/**
 * Write a deck or a quiz and save it — the one way either is made, whether
 * the student asked from the generate dialog or the assistant did it for
 * them in a chat.
 *
 * Saved straight away: there is no preview to click through. A set can be
 * read over, edited, rewritten or deleted from its own page like any other,
 * and holding a finished quiz hostage behind a "Save" button only meant a
 * student who looked away lost it.
 */
export type MadeSet = {
  id: number;
  title: string;
  count: number;
  /** What could not be written, if anything, in a sentence. */
  note: string;
  /** One line for whoever asked: "Saved “X” with 40 cards." */
  message: string;
};

export async function makeSet(
  kind: 'cards' | 'quiz',
  ctx: StudyContext,
  notebookId: number,
  src: GenSource,
  progress: (text: string) => void,
  options: QuizOptions & CardOptions & { limit?: number } = {},
): Promise<MadeSet> {
  let id: number;
  let title: string;
  let count: number;
  let skipped: string[];
  if (kind === 'cards') {
    const deck = await generateCards(ctx, src, options, progress);
    // A card that said where it came from keeps that; the rest fall back to
    // the sources the deck as a whole was built from.
    const fallback = src.kind === 'sources'
      ? [...new Map(src.hits.map((h) => [h.sourceId, { sourceId: h.sourceId, title: h.sourceTitle }])).values()]
      : null;
    // Stopped while it was being written: nothing is saved.
    options.stop?.throwIfStopped();
    progress('Saving the deck…');
    id = await studyApi.createDeck(notebookId, deck.title, deck.cards.map((c) => ({ ...c, sourceRefs: c.sourceRefs ?? fallback })));
    ({ title, skipped } = deck);
    count = deck.cards.length;
  } else {
    const quiz = await generateQuiz(ctx, src, notebookId, progress, options);
    options.stop?.throwIfStopped();
    progress('Saving the quiz…');
    id = await studyApi.createQuiz(notebookId, quiz.title, quiz.questions);
    ({ title, skipped } = quiz);
    count = quiz.questions.length;
  }
  const one = kind === 'cards' ? 'card' : 'question';
  const note = skipped.length
    ? `${skipped.length === 1 ? 'Part' : `${skipped.length} parts`} of the material could not be written (${skipped.map((s) => s.replace(/^.*?,\s*/, '')).join('; ')}). Generate again to fill ${skipped.length === 1 ? 'it' : 'them'} in.`
    : '';
  return { id, title, count, note, message: `Saved “${title}” with ${count} ${one}${count === 1 ? '' : 's'}.${note ? ` ${note}` : ''}` };
}
