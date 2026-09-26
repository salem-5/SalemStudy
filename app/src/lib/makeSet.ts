import { generateCards, generateQuiz, type CardOptions, type GenSource, type QuizOptions, type StudyContext } from './studyGen';
import { studyApi } from '../study/api';
import { originOf, refsOf } from './origin';
import { tidyTitle } from './titles';

export type MadeSet = {
  id: number;
  title: string;
  count: number;
  note: string;
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
  const sourceTitles = src.kind === 'sources' ? [...new Set(src.hits.map((h) => h.sourceTitle))] : [];
  if (kind === 'cards') {
    const deck = await generateCards(ctx, src, options, progress);
    const fallback = src.kind === 'sources'
      ? [...new Map(src.hits.map((h) => [h.sourceId, { sourceId: h.sourceId, title: h.sourceTitle }])).values()]
      : null;
    options.stop?.throwIfStopped();
    progress('Saving the deck…');
    deck.title = tidyTitle(deck.title, sourceTitles) || 'Flashcards';
    const origin = originOf(src, deck.read, deck.cards.map((c) => refsOf(c.sourceRefs)));
    id = await studyApi.createDeck(notebookId, deck.title, deck.cards.map((c) => ({ ...c, sourceRefs: c.sourceRefs ?? fallback })), origin);
    ({ title, skipped } = deck);
    count = deck.cards.length;
  } else {
    const quiz = await generateQuiz(ctx, src, notebookId, progress, options);
    options.stop?.throwIfStopped();
    progress('Saving the quiz…');
    quiz.title = tidyTitle(quiz.title, sourceTitles) || 'Practice quiz';
    id = await studyApi.createQuiz(notebookId, quiz.title, quiz.questions, originOf(src, quiz.read, quiz.questions.map((q) => q.sources)));
    ({ title, skipped } = quiz);
    count = quiz.questions.length;
  }
  const one = kind === 'cards' ? 'card' : 'question';
  const note = skipped.length
    ? `${skipped.length === 1 ? 'Part' : `${skipped.length} parts`} of the material could not be written (${skipped.map((s) => s.replace(/^.*?,\s*/, '')).join('; ')}). Generate again to fill ${skipped.length === 1 ? 'it' : 'them'} in.`
    : '';
  return { id, title, count, note, message: `Saved “${title}” with ${count} ${one}${count === 1 ? '' : 's'}.${note ? ` ${note}` : ''}` };
}
