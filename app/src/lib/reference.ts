/**
 * Pointing the assistant at something on screen.
 *
 * A student reading a question, a card or their own notes wants to ask about
 * *that* — not to describe it again in a chat box. A reference is that act of
 * pointing: a short excerpt of what they selected, plus enough of a locator
 * that the assistant can go and fetch the rest of it and what surrounds it.
 *
 * It is deliberately small and serialisable, so it can be carried through the
 * UI, shown as a chip, and written into the briefing the model reads.
 */

export type ReferenceKind = 'note' | 'quiz' | 'card' | 'source' | 'chat';

export type Reference = {
  id: string;
  kind: ReferenceKind;
  /** What to call it on the chip: "Cell structure", "Question 3". */
  label: string;
  /** The second line of the chip: "your note", "Convergence tests". */
  detail?: string;
  /** Exactly what the student selected. Empty when they referenced the whole thing. */
  excerpt: string;
  /**
   * The chat was opened *about* this, and its briefing already spells it out
   * in full. The chip is then only so the student can see what went across;
   * describing it again would send the same question twice.
   */
  briefed?: boolean;
  /** The material itself, fetched before the chat opens (see `resolve`). */
  content?: {
    /** What it is: "Question 3 of \u201cConvergence tests\u201d". */
    title: string;
    /** The whole thing the excerpt came from, and what surrounds it. */
    body: string;
  };
  /** Where it came from, so the assistant can read around it. */
  locator: {
    notebookId?: number | null;
    noteId?: number;
    quizId?: number;
    /** 0-based. */
    questionIndex?: number;
    deckId?: number;
    cardId?: number;
    sourceId?: number;
    unit?: number;
  };
};

const clip = (text: string, n = 1200) => (text.length > n ? `${text.slice(0, n)}…` : text);

export function makeReference(
  kind: ReferenceKind,
  label: string,
  excerpt: string,
  locator: Reference['locator'],
  detail?: string,
): Reference {
  return {
    id: `${kind}-${Math.random().toString(36).slice(2, 9)}`,
    kind,
    label,
    detail,
    excerpt: clip(excerpt.replace(/\s+/g, ' ').trim()),
    locator,
  };
}

const KIND_WORD: Record<ReferenceKind, string> = {
  note: 'a note',
  quiz: 'a quiz question',
  card: 'a flashcard',
  source: 'a source',
  chat: 'an earlier message',
};

/**
 * What the model is told about what was pointed at.
 *
 * The material comes with it. A highlighted line is almost never the whole
 * story, and the first version of this handed over the line plus directions
 * for finding the rest — which cost a tool call, sometimes several, before
 * the assistant could start on the actual question. So the surrounding note,
 * question, card or page is fetched while the sheet opens (`resolve`) and
 * written in here. The directions stay only as a fallback, for a reference
 * whose material could not be read.
 */
export function describeReferences(references: Reference[]): string {
  const describe = references.filter((r) => !r.briefed);
  if (!describe.length) return '';
  const lines = ['## What the student is pointing at', ''];
  for (const [i, ref] of describe.entries()) {
    lines.push(`### ${i + 1}. ${ref.label}${ref.detail ? ` — ${ref.detail}` : ''} (${KIND_WORD[ref.kind]})`);
    if (ref.excerpt) {
      lines.push('They selected:', `> ${ref.excerpt}`, '');
    } else {
      lines.push('They referenced the whole thing rather than a part of it.', '');
    }
    if (ref.content) {
      lines.push(`${ref.content.title}, in full — you already have this, do not go and look it up:`);
      lines.push('', ref.content.body, '');
    } else {
      const how = fetchInstruction(ref);
      if (how) lines.push(`The material itself could not be read from here. ${how}`, '');
    }
  }
  lines.push(
    'Answer about that. It is in front of you above, so start from it rather than fetching it again; go and read further only if the answer genuinely needs something that is not there.',
  );
  return lines.join('\n');
}

/** How to go and read the rest of it, when it could not be fetched here. */
function fetchInstruction(ref: Reference): string {
  const { noteId, quizId, questionIndex, deckId, sourceId, unit } = ref.locator;
  if (noteId !== undefined) return `Read the whole note with read_note(noteId: ${noteId}).`;
  if (quizId !== undefined) {
    return questionIndex === undefined
      ? `Read the quiz with read_quiz(quizId: ${quizId}).`
      : `Read the question in full with read_quiz(quizId: ${quizId}, question: ${questionIndex + 1}), and the rest of the quiz if the context helps.`;
  }
  if (deckId !== undefined) return `Read the deck with read_deck(deckId: ${deckId}).`;
  if (sourceId !== undefined) {
    return unit !== undefined
      ? `Read around it with read_source(sourceId: ${sourceId}, from: ${Math.max(1, unit - 1)}, to: ${unit + 2}).`
      : `Read it with read_source(sourceId: ${sourceId}).`;
  }
  return '';
}

/** A short tag for the first message, so the thread says what it was about. */
export const referenceTag = (references: Reference[]): string | undefined => {
  if (!references.length) return undefined;
  const first = references[0];
  const rest = references.length - 1;
  return `${first.label}${rest > 0 ? ` +${rest}` : ''}`;
};

/** The sources a reference lets the run read, so a notebook stays bounded. */
export const referencedSources = (references: Reference[]): number[] =>
  [...new Set(references.map((r) => r.locator.sourceId).filter((id): id is number => typeof id === 'number'))];
