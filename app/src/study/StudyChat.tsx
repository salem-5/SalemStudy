import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MessageSquare, X } from 'lucide-react';
import { ChatView } from '../components/chat/ChatView';
import { SelectionMenu, type SelectionTarget } from '../components/SelectionMenu';
import type { QuizAnswer } from '../lib/studySession';
import { makeReference, referencedSources, referenceTag, type Reference } from '../lib/reference';
import { resolveAll } from '../lib/referenceContent';
import { studyApi, type Card, type Quiz, type QuizQuestion } from './api';
import { labelAnswers, labelVerdicts } from '../lib/quizRules';

const key = (scope: string) => `wa.askchat.${scope}`;

function rememberThread(scope: string, threadId: number) {
  try { localStorage.setItem(key(scope), String(threadId)); } catch { }
}

function recallThread(scope: string): number | null {
  try {
    const raw = localStorage.getItem(key(scope));
    const id = raw ? Number(raw) : NaN;
    return Number.isFinite(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

function forgetThread(scope: string) {
  try { localStorage.removeItem(key(scope)); } catch { }
}

const label = (q: QuizQuestion, i: number) => (q.type === 'mcq' || q.type === 'multi' ? `${String.fromCharCode(65 + i)}. ` : '');

export function questionBriefing(quiz: Quiz, index: number, answer: QuizAnswer | undefined): string {
  const q = quiz.questions[index];
  const lines: string[] = [
    `The student is revising with a quiz called "${quiz.title}" and has asked about question ${index + 1}.`,
    '',
    `Topic: ${q.topic}${q.difficulty ? ` (${q.difficulty})` : ''}`,
    `Question type: ${q.type}`,
    '',
    'QUESTION',
    q.prompt,
  ];
  if (q.choices?.length) {
    lines.push('', 'CHOICES');
    lines.push(...q.choices.map((c, i) => `${label(q, i)}${c}`));
  }
  lines.push('', 'CORRECT ANSWER');
  if (q.type === 'mcq') lines.push(`${label(q, Number(q.answer))}${q.choices?.[Number(q.answer)] ?? q.answer}`);
  else if (q.type === 'multi') lines.push((q.answers ?? []).map((i) => `${label(q, i)}${q.choices?.[i] ?? ''}`).join('\n'));
  else lines.push(`${q.answer}${q.unit ? ` ${q.unit}` : ''}`);
  if (q.accept?.length) lines.push(`Also accepted: ${q.accept.join(', ')}`);

  lines.push('', 'WHAT THE STUDENT ANSWERED');
  if (!answer || !answer.given) {
    lines.push('They did not answer this one.');
  } else if (q.type === 'mcq') {
    lines.push(`${label(q, Number(answer.given))}${q.choices?.[Number(answer.given)] ?? answer.given} - ${answer.correct ? 'correct' : 'incorrect'}`);
  } else if (q.type === 'label') {
    const results = labelVerdicts(q, answer);
    const given = labelAnswers(answer.given, results.length);
    lines.push(...(q.diagram?.labels ?? []).map((l, i) => {
      const note = (answer.labelNotes?.[i] ?? '').trim();
      const verdict = results[i] ? 'correct' : `incorrect, it is ${l.answer}`;
      return `Label ${i + 1}: "${given[i] || ''}" - ${verdict}${note ? ` (they were told: ${note})` : ''}`;
    }));
  } else if (q.type === 'multi') {
    const chosen = answer.given.split(',').map(Number).filter(Number.isInteger);
    lines.push(`${chosen.map((i) => `${label(q, i)}${q.choices?.[i] ?? ''}`).join('; ') || 'nothing'} - ${answer.correct ? 'correct' : 'incorrect'}`);
  } else {
    lines.push(`"${answer.given}" - ${answer.correct ? 'correct' : 'incorrect'}`);
  }
  if (answer?.hinted) lines.push('They opened the hint before answering.');
  if (answer?.feedback) lines.push('', 'MARKING FEEDBACK ALREADY SHOWN', answer.feedback);
  if (q.explanation) lines.push('', 'EXPLANATION ALREADY SHOWN', q.explanation);
  if (q.hint) lines.push('', 'HINT ALREADY AVAILABLE', q.hint);
  if (q.sources?.length) {
    lines.push('', 'WHERE THIS QUESTION CAME FROM');
    lines.push(...q.sources.map((s) => `- ${s.title}, ${s.label}`));
  }

  lines.push(
    '',
    'HOW TO HELP',
    '- Answer what they actually asked. This is a conversation, not a lecture: short, direct, and follow where they take it.',
    answer && !answer.correct
      ? '- Start from their answer. Say what is reasonable about it and exactly where the reasoning goes wrong, then what the right route is.'
      : '- They got it right. Check they know why, and be ready to go deeper or to the next idea.',
    '- Do not just repeat the explanation above. They have already read it; say it another way, or go further.',
    '- Work out anything numerical in Python before you explain it. Do not restate a number because the quiz said so - derive it, and if it disagrees with the answer key, say so plainly.',
    '- Maths in LaTeX ($...$ inline, $$...$$ displayed).',
    q.sources?.length
      ? '- This question came from the student\'s own sources. Ground the explanation in them and cite where each point came from; say so when you go beyond them.'
      : '- Use the web if the answer depends on something current or checkable.',
    '- Never tell them their quiz answer has been changed. It has not: this conversation does not affect their score.',
  );
  return lines.join('\n');
}

export function cardBriefing(card: Card, deckTitle: string): string {
  const lines = [
    `The student is revising with a flashcard deck called "${deckTitle}" and has asked about one of the cards.`,
    '',
    `Topic: ${card.topic || 'not set'}`,
    '',
    'FRONT OF THE CARD',
    card.front,
    '',
    'BACK OF THE CARD',
    card.back,
  ];
  if (card.reviews) {
    lines.push('', 'HOW THEY HAVE DONE ON IT',
      `Seen ${card.reviews} time${card.reviews === 1 ? '' : 's'}, missed ${card.misses}.` +
      (card.lastCorrect === null ? '' : card.lastCorrect ? ' They got it right last time.' : ' They got it wrong last time.'));
  }
  lines.push(
    '',
    'HOW TO HELP',
    '- Answer what they actually asked. This is a conversation, not a lecture.',
    '- Do not just read the back of the card at them; they have already seen it. Say it another way, or go further.',
    card.misses > 0
      ? '- They have missed this one before, so find the bit that is not sticking rather than restating the fact.'
      : '- Check they understand it rather than just recognise it.',
    '- Work out anything numerical in Python before explaining it.',
    '- Maths in LaTeX ($...$ inline, $$...$$ displayed).',
    '- Their progress on this card does not change because of this conversation; never say it has.',
  );
  return lines.join('\n');
}

export function quizBriefing(quiz: Quiz, index: number | undefined): string {
  const q = index === undefined ? undefined : quiz.questions[index];
  const lines = [
    `The student is part-way through a quiz called "${quiz.title}" in their study app and has opened a chat from it.`,
  ];
  if (q) {
    lines.push('', `They are on question ${index! + 1}, on ${q.topic}:`, q.prompt);
    if (q.choices?.length) lines.push('', 'Its choices:', ...q.choices.map((c, i) => `${label(q, i)}${c}`));
    lines.push('', 'Do not volunteer the answer to it - they have not asked for it, and telling them would spoil the quiz. If they ask directly, help them reason it out first.');
  }
  lines.push('', 'Help with whatever they actually ask. Maths in LaTeX. Work anything numerical out in Python.');
  return lines.join('\n');
}

export function deckBriefing(deckTitle: string, card: Card | undefined): string {
  const lines = [`The student is revising a flashcard deck called "${deckTitle}" and has opened a chat from it.`];
  if (card) {
    lines.push('', 'The card in front of them:', `Front: ${card.front}`, `Back: ${card.back}`);
    lines.push('', 'Do not simply read the back out unless they ask for it.');
  }
  lines.push('', 'Help with whatever they actually ask. Maths in LaTeX. Work anything numerical out in Python.');
  return lines.join('\n');
}

export function noteBriefing(title: string, content: string): string {
  const body = content.trim();
  return [
    `The student is reading their own note "${title || 'untitled'}" and has opened a chat from it.`,
    '',
    'THE NOTE',
    body ? body.slice(0, 30_000) + (body.length > 30_000 ? '\n… [the rest is not shown]' : '') : '(it is empty so far)',
    '',
    'HOW TO HELP',
    '- Answer what they actually ask. They can see the note; do not read it back at them.',
    '- These are their own notes, so if something in them looks wrong, say so plainly and explain why.',
    '- Work anything numerical out in Python before explaining it.',
    '- Maths in LaTeX ($...$ inline, $$...$$ displayed).',
  ].join('\n');
}

const QUIZ_STARTERS = (correct: boolean) => (correct
  ? ['Why is this the right answer?', 'Why are the other options wrong?', 'Show me the solution step by step', 'Give me a harder version of this']
  : ['Why is my answer wrong?', 'Explain this more simply', 'Show me the solution step by step', 'Give me another example like this']);

const CARD_STARTERS = ['Explain this more simply', 'Why is that the answer?', 'Give me an example', 'How do I remember this?'];

export function AskModal({ title, subtitle, scope, briefing, tag, notebookId, sourceIds, starters, chatTitle, backLabel, references, onClose }: {
  title: string;
  subtitle?: string;
  scope: string;
  briefing: string;
  tag?: string;
  notebookId: number | null;
  sourceIds?: number[];
  starters?: string[];
  chatTitle?: string;
  backLabel?: string;
  references?: Reference[];
  onClose: () => void;
}) {
  const [threadId, setThreadId] = useState<number | null>(null);
  const [ready, setReady] = useState(false);
  const [pointed, setPointed] = useState<Reference[]>(references ?? []);
  const [fetching, setFetching] = useState(!!references?.length);

  useEffect(() => {
    if (!references?.length) { setPointed([]); setFetching(false); return; }
    let alive = true;
    setFetching(true);
    resolveAll(references)
      .then((full) => { if (alive) setPointed(full); })
      .finally(() => { if (alive) setFetching(false); });
    return () => { alive = false; };
  }, [JSON.stringify(references ?? [])]);

  useEffect(() => {
    let alive = true;
    const saved = recallThread(scope);
    if (saved === null) { setReady(true); return; }
    studyApi.chatMessages(saved)
      .then(() => { if (alive) { setThreadId(saved); setReady(true); } })
      .catch(() => {
        forgetThread(scope);
        if (alive) setReady(true);
      });
    return () => { alive = false; };
  }, [scope]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const system = useCallback(() => briefing, [briefing]);
  const allowed = [...(sourceIds ?? []), ...referencedSources(pointed)];

  // On the body, not where it was opened: the chat buttons sit in bars that drag the window
  // (data-tauri-drag-region="deep"), which would swallow a click on the backdrop as a drag.
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal quiz-ask" onClick={(e) => e.stopPropagation()}>
        <div className="quiz-ask-head">
          <div>
            <div className="panel-title">{title}</div>
            {subtitle && <div className="muted small">{subtitle}</div>}
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><X /></button>
        </div>
        {(!ready || fetching) && (
          <div className="quiz-ask-wait muted small">Reading what you pointed at…</div>
        )}
        {ready && !fetching && (
          <ChatView
            threadId={threadId}
            references={pointed}
            onReferencesSent={() => setPointed((refs) => refs.filter((r) => r.briefed))}
            notebookId={notebookId}
            system={system}
            tag={tag ?? referenceTag(pointed)}
            agent={allowed.length ? 'notebook' : 'chat'}
            sourceIds={allowed}
            emptyTitle={title}
            emptyHint="Ask anything about it - a simpler explanation, another example, the step-by-step working, or wherever else you want to take it."
            placeholder="Ask about this"
            suggestions={starters}
            onThreadCreated={(t) => {
              setThreadId(t.id);
              rememberThread(scope, t.id);
              if (chatTitle) void studyApi.chatRename(t.id, chatTitle).catch(() => {});
            }}
          />
        )}
        <div className="quiz-ask-foot">
          <button type="button" className="btn primary" onClick={onClose}>{backLabel ?? 'Back'}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function AskableArea({ notebookId, target, title, briefing, starters, className, children }: {
  notebookId: number | null;
  target: SelectionTarget | ((node: Node) => SelectionTarget | undefined);
  title: string;
  briefing?: string;
  starters?: string[];
  className?: string;
  children: React.ReactNode;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [asking, setAsking] = useState<Reference | null>(null);

  return (
    <div ref={host} className={className}>
      {children}
      <SelectionMenu scope={host} target={target} onAsk={setAsking} />
      {asking && (
        <AskModal
          title={title}
          subtitle="What you highlighted goes with your message, along with the rest of what it came from."
          scope={`ref.${asking.kind}.${asking.locator.noteId ?? asking.locator.quizId ?? asking.locator.deckId ?? asking.locator.sourceId ?? 'x'}`}
          briefing={briefing ?? 'The student highlighted something in their study app and asked about it. Answer what they ask.'}
          notebookId={notebookId}
          references={[asking]}
          starters={starters ?? ['Explain this', 'Why is this the case?', 'Give me an example', 'How does this connect to the rest?']}
          chatTitle={asking.label}
          backLabel="Back"
          onClose={() => setAsking(null)}
        />
      )}
    </div>
  );
}

export function AskAboutQuestion({ quiz, index, answer, notebookId, onClose }: {
  quiz: Quiz;
  index: number;
  answer: QuizAnswer | undefined;
  notebookId: number;
  onClose: () => void;
}) {
  const q = quiz.questions[index];
  const pointer: Reference = {
    ...makeReference('quiz', `Question ${index + 1}`, q.prompt, { quizId: quiz.id, questionIndex: index, notebookId }, quiz.title),
    briefed: true,
  };
  return (
    <AskModal
      title={`Question ${index + 1} · ${q.topic}`}
      references={[pointer]}
      subtitle={`${answer?.given ? (answer.correct ? 'You got this right.' : 'You got this wrong.') : 'You skipped this one.'} Your answer and score do not change here.`}
      scope={`quiz.${quiz.id}.${index}`}
      briefing={questionBriefing(quiz, index, answer)}
      tag={`${quiz.title} · Q${index + 1}`}
      notebookId={notebookId}
      sourceIds={q.sources?.map((s) => s.sourceId) ?? []}
      starters={QUIZ_STARTERS(!!answer?.correct)}
      chatTitle={`${quiz.title} · Q${index + 1}`}
      backLabel={`Back to question ${index + 1}`}
      onClose={onClose}
    />
  );
}

export function AskAboutCard({ card, deckTitle, notebookId, onClose }: {
  card: Card;
  deckTitle: string;
  notebookId: number;
  onClose: () => void;
}) {
  const pointer: Reference = {
    ...makeReference('card', card.topic || 'Flashcard', card.front, { deckId: card.deckId, cardId: card.id, notebookId }, deckTitle),
    briefed: true,
  };
  return (
    <AskModal
      title={`Flashcard · ${card.topic || deckTitle}`}
      references={[pointer]}
      subtitle="Your progress on this card does not change here."
      scope={`card.${card.id}`}
      briefing={cardBriefing(card, deckTitle)}
      tag={`${deckTitle} · card`}
      notebookId={notebookId}
      starters={CARD_STARTERS}
      chatTitle={`${deckTitle} · ${(card.front || 'card').replace(/[#*_`$]/g, '').slice(0, 40)}`}
      backLabel="Back to the card"
      onClose={onClose}
    />
  );
}

export function ChatButton({ notebookId, where, briefing, tag }: {
  notebookId: number | null;
  where: string;
  briefing?: string;
  tag?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="icon-btn ghost-icon" onClick={() => setOpen(true)} title={`Ask Salem about ${where}`}>
        <MessageSquare />
      </button>
      {open && (
        <AskModal
          title={`Ask about ${where}`}
          scope={`where.${notebookId ?? 'app'}.${where}`}
          briefing={briefing ?? `The student is looking at ${where} in their study app and has opened a chat from there. Help with whatever they ask.`}
          tag={tag ?? where}
          notebookId={notebookId}
          chatTitle={where}
          backLabel="Back"
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
