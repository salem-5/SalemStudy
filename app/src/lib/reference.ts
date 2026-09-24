export type ReferenceKind = 'note' | 'quiz' | 'card' | 'source' | 'chat';

export type Reference = {
  id: string;
  kind: ReferenceKind;
  label: string;
  detail?: string;
  excerpt: string;
  briefed?: boolean;
  content?: {
    title: string;
    body: string;
  };
  locator: {
    notebookId?: number | null;
    noteId?: number;
    quizId?: number;
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

export function describeReferences(references: Reference[]): string {
  const describe = references.filter((r) => !r.briefed);
  if (!describe.length) return '';
  const lines = ['## What the student is pointing at', ''];
  for (const [i, ref] of describe.entries()) {
    lines.push(`### ${i + 1}. ${ref.label}${ref.detail ? ` - ${ref.detail}` : ''} (${KIND_WORD[ref.kind]})`);
    if (ref.excerpt) {
      lines.push('They selected:', `> ${ref.excerpt}`, '');
    } else {
      lines.push('They referenced the whole thing rather than a part of it.', '');
    }
    if (ref.content) {
      lines.push(`${ref.content.title}, in full - you already have this, do not go and look it up:`);
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

export const referenceTag = (references: Reference[]): string | undefined => {
  if (!references.length) return undefined;
  const first = references[0];
  const rest = references.length - 1;
  return `${first.label}${rest > 0 ? ` +${rest}` : ''}`;
};

export const referencedSources = (references: Reference[]): number[] =>
  [...new Set(references.map((r) => r.locator.sourceId).filter((id): id is number => typeof id === 'number'))];
