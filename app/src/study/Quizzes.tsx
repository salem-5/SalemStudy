import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Select } from '../components/Select';
import { ArrowLeft, Check, ChevronLeft, ChevronRight, Flag, Lightbulb, MessageCircleQuestion, Play, RotateCcw, ShieldCheck, Sparkles, X } from 'lucide-react';
import { asMath, Markdown } from '../lib/markdown';
import { cardsFromMistakes, gradeLocal, gradeShort, picked, rewriteQuestion, unpick, type GenSource, type StudyContext } from '../lib/studyGen';
import { labelAnswers, labelResults } from '../lib/quizRules';
import {
  clearQuizSession, loadQuizSession, quizSessionFits, saveQuizSession,
  type QuizAnswer,
} from '../lib/studySession';
import { Modal } from '../components/Dialogs';
import { SetItem, SetPage } from './StudySets';
import { GapPrompt, hasGap } from './GapPrompt';
import { AskableArea, AskAboutQuestion, ChatButton, quizBriefing } from './StudyChat';
import { studyApi, type AttemptAnswer, type Note, type Quiz, type QuizQuestion, type QuizSummary } from './api';

function FigureImg({ id }: { id: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => { studyApi.attachmentData(id).then(setSrc).catch(() => {}); }, [id]);
  return src ? <img className="quiz-figure" src={src} alt="Figure for this question" /> : <div className="quiz-figure loading" />;
}

function answerText(q: QuizQuestion): string {
  if (q.type === 'mcq') return asMath(q.choices?.[Number(q.answer)] ?? '');
  if (q.type === 'multi') return (q.answers ?? []).map((i) => asMath(q.choices?.[i] ?? '')).filter(Boolean).join(' · ');
  if (q.type === 'tf') return q.answer === 'true' ? 'True' : 'False';
  return `${asMath(String(q.answer))}${q.unit ? ` ${q.unit}` : ''}`;
}

function givenText(q: QuizQuestion, given: string): string {
  if (!given) return 'nothing';
  if (q.type === 'mcq') return q.choices?.[Number(given)] ?? given;
  if (q.type === 'multi') return picked(given).map((i) => q.choices?.[i] ?? '').filter(Boolean).join(' · ') || 'nothing';
  if (q.type === 'tf') return given === 'true' ? 'True' : 'False';
  if (q.type === 'label') {
    const results = labelResults(q, given);
    return labelAnswers(given, results.length).map((v, i) => `${i + 1}. ${v.trim() || '-'} ${results[i] ? '✓' : '✗'}`).join(' · ');
  }
  return given;
}

type Graded = AttemptAnswer & { feedback?: string };

export function QuizRunner({ quizId, onlyIndexes, startAt, onClose, onFinished, notebookId }: {
  quizId: number;
  onlyIndexes?: number[];
  startAt?: number;
  notebookId: number;
  onClose: () => void;
  onFinished: () => void;
}) {
  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pos, setPos] = useState(0);
  const [answers, setAnswers] = useState<Record<number, QuizAnswer>>({});
  const [flash, setFlash] = useState<{ kind: 'good' | 'bad'; n: number } | null>(null);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [only, setOnly] = useState<number[] | undefined>(onlyIndexes);
  const [reviewing, setReviewing] = useState(false);
  const [checking, setChecking] = useState(false);
  const [hintFor, setHintFor] = useState<number | null>(null);
  const [asking, setAsking] = useState<number | null>(null);
  const [cardsMade, setCardsMade] = useState<number | null>(null);
  const [resumed, setResumed] = useState(false);
  const started = useRef(Date.now());
  const shownAt = useRef(Date.now());
  const savedAttempt = useRef(false);

  useEffect(() => {
    let alive = true;
    studyApi.quiz(quizId)
      .then((q) => {
        if (!alive) return;
        setQuiz(q);
        const saved = onlyIndexes ? null : loadQuizSession(quizId);
        if (quizSessionFits(saved, q.questions.length)) {
          setAnswers(saved.answers);
          setDrafts(saved.drafts ?? {});
          setOnly(saved.only);
          setReviewing(!!saved.reviewing);
          started.current = saved.startedAt;
          setResumed(Object.keys(saved.answers).length > 0);
          const order = saved.only ?? q.questions.map((_, i) => i);
          const asked = startAt === undefined ? -1 : order.indexOf(startAt);
          setPos(asked >= 0 ? asked : Math.min(saved.pos, order.length - 1));
        } else if (startAt !== undefined) {
          const order = onlyIndexes ?? q.questions.map((_, i) => i);
          setPos(Math.max(0, order.indexOf(startAt)));
        }
      })
      .catch((e) => alive && setError(String(e)));
    return () => { alive = false; };
  }, [quizId, onlyIndexes, startAt]);

  const order = useMemo(() => (quiz ? (only ?? quiz.questions.map((_, i) => i)) : []), [quiz, only]);
  const index = order[pos];
  const q = quiz && index !== undefined ? quiz.questions[index] : null;
  const current = index === undefined ? undefined : answers[index];
  const answeredCount = order.filter((i) => answers[i] !== undefined).length;
  const right = order.filter((i) => answers[i]?.correct).length;
  const given = index === undefined ? '' : drafts[index] ?? current?.given ?? '';

  useEffect(() => {
    if (!quiz) return;
    saveQuizSession({ quizId, startedAt: started.current, pos, only, answers, drafts, reviewing });
  }, [quiz, quizId, pos, only, answers, drafts, reviewing]);

  const setGiven = useCallback((value: string) => {
    if (index === undefined) return;
    setDrafts((d) => ({ ...d, [index]: value }));
  }, [index]);

  const check = useCallback(async () => {
    if (!q || index === undefined || checking) return;
    const value = given.trim();
    if (!value) return;
    setChecking(true);
    let correct = false;
    let feedback: string | undefined;
    try {
      if (q.type === 'short') ({ correct, feedback } = await gradeShort(q, value));
      else if (q.type === 'label') {
        const results = labelResults(q, value);
        correct = results.length > 0 && results.every(Boolean);
        feedback = `${results.filter(Boolean).length} of ${results.length} labels right.`;
      } else correct = gradeLocal(q, value);
    } catch (e) {
      feedback = `Could not mark this automatically (${String(e)}). Compare with the answer below.`;
    }
    setAnswers((a) => ({
      ...a,
      [index]: { given: value, correct, ms: Date.now() - shownAt.current, hinted: hintFor === index || a[index]?.hinted, feedback },
    }));
    setFlash((f) => ({ kind: correct ? 'good' : 'bad', n: (f?.n ?? 0) + 1 }));
    setChecking(false);
  }, [q, index, given, checking, hintFor]);

  const skip = () => {
    if (index === undefined || !q) return;
    setAnswers((a) => ({ ...a, [index]: { given: '', correct: false, ms: Date.now() - shownAt.current, hinted: hintFor === index } }));
  };

  const goTo = useCallback((next: number) => {
    setPos(Math.max(0, Math.min(order.length - 1, next)));
    setHintFor(null);
    shownAt.current = Date.now();
  }, [order.length]);

  const reopen = () => {
    if (index === undefined) return;
    setAnswers(({ [index]: _gone, ...rest }) => rest);
    setDrafts((d) => ({ ...d, [index]: '' }));
    shownAt.current = Date.now();
  };

  const finish = useCallback(() => {
    if (!quiz || savedAttempt.current) { setReviewing(true); return; }
    savedAttempt.current = true;
    const graded: Graded[] = order
      .filter((i) => answers[i] !== undefined)
      .map((i) => ({
        index: i,
        given: answers[i].given,
        correct: answers[i].correct,
        topic: quiz.questions[i].topic,
        ms: answers[i].ms,
        hinted: answers[i].hinted,
      }));
    void studyApi
      .addAttempt(quiz.id, started.current, graded.filter((g) => g.correct).length, graded.length, graded)
      .then(onFinished)
      .catch(() => {});
    setReviewing(true);
    setPos(0);
  }, [quiz, order, answers, onFinished]);

  const restart = (subset: number[] | null) => {
    savedAttempt.current = false;
    started.current = Date.now();
    shownAt.current = Date.now();
    setAnswers({});
    setDrafts({});
    setOnly(subset ?? undefined);
    setReviewing(false);
    setPos(0);
    setCardsMade(null);
    setResumed(false);
    clearQuizSession(quizId);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (asking !== null) return;
      if (e.key === 'Escape') { onClose(); return; }
      if (!q) return;
      const typing = !!(e.target as HTMLElement).closest('input, textarea');
      if (e.key === 'ArrowLeft' && !typing) { e.preventDefault(); goTo(pos - 1); return; }
      if (e.key === 'ArrowRight' && !typing) { e.preventDefault(); goTo(pos + 1); return; }
      if (e.key === 'Enter' && !e.shiftKey && (!typing || (q.type !== 'short' && q.type !== 'label') || e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (reviewing || current) goTo(pos + 1);
        else void check();
        return;
      }
      if (typing || current || reviewing) return;
      if ((q.type === 'mcq' || q.type === 'multi') && /^[1-9]$/.test(e.key) && Number(e.key) <= (q.choices?.length ?? 0)) {
        const choice = Number(e.key) - 1;
        if (q.type === 'mcq') setGiven(String(choice));
        else {
          const now = picked(given);
          setGiven(unpick(now.includes(choice) ? now.filter((n) => n !== choice) : [...now, choice]));
        }
      }
      if (q.type === 'tf' && (e.key === 't' || e.key === 'f')) setGiven(e.key === 't' ? 'true' : 'false');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (error) return <div className="stage"><div className="pane-empty center"><p className="form-err">{error}</p><button type="button" className="btn" onClick={onClose}>Back</button></div></div>;
  if (!quiz) return <div className="stage"><div className="pane-empty center"><span className="dots"><i /><i /><i /></span></div></div>;

  const hintText = q?.hint && hintFor === index ? q.hint : '';
  const showAnswer = reviewing || !!current;

  return (
    <div className="stage quiz-stage">
      <div className="stage-head">
        <button type="button" className="link" onClick={onClose}><ArrowLeft />back</button>
        <span className="stage-title">{quiz.title}{only ? ' · retry' : ''}{reviewing ? ' · review' : ''}</span>
        <span className="spacer" />
        <span className="stage-count mono">{pos + 1} / {order.length} · {answeredCount} answered · {right} right</span>
        {resumed && !reviewing && (
          <button type="button" className="btn ghost small" onClick={() => restart(null)} title="Clear your answers and take it from the top">
            <RotateCcw />Start again
          </button>
        )}
        <ChatButton notebookId={notebookId} where={quiz.title} tag={quiz.title} briefing={quizBriefing(quiz, index)} />
      </div>

      <div className="progress" title={`Question ${pos + 1} of ${order.length}`}>
        <i style={{ width: `${((pos + 1) / Math.max(1, order.length)) * 100}%` }} />
      </div>

      {q && index !== undefined && (
        <AskableArea
          className="question-askable"
          notebookId={notebookId}
          title={`Question ${pos + 1}`}
          briefing={quizBriefing(quiz, index)}
          target={{
            kind: 'quiz',
            label: `${quiz.title} · Q${index + 1}`,
            detail: q.topic,
            locator: { notebookId, quizId: quiz.id, questionIndex: index },
          }}
        >
        <div className="glow-wrap q-glow">
        <span key={flash?.n ?? 0} className={`study-glow${flash ? ` flash-${flash.kind}` : ''}`} aria-hidden />
        <div className="question-card" key={index}>
          <div className="q-meta muted">
            <span>{q.topic}{q.difficulty ? ` · ${q.difficulty}` : ''}</span>
            <span className={`q-verify${q.verified ? ' ok' : ''}`} title={q.verified ? 'The answer was re-derived in Python' : 'Not checked by Python (conceptual, or Python unavailable)'}>
              {q.verified ? <><ShieldCheck />checked in Python</> : 'unverified'}
            </span>
          </div>
          {q.type === 'blank' ? (
            <GapPrompt text={q.prompt} className="q-prompt">
              <GapInput
                given={given}
                locked={showAnswer}
                verdict={current ? current.correct : undefined}
                autoFocus={!reviewing}
                onChange={setGiven}
              />
            </GapPrompt>
          ) : (
            <div className="q-prompt"><Markdown text={q.prompt} /></div>
          )}
          {q.figure && <FigureImg id={q.figure} />}

          <AnswerInput
            q={q}
            given={given}
            locked={showAnswer}
            reviewing={reviewing}
            onChange={setGiven}
          />

          {!showAnswer && q.hint && (
            hintText
              ? <div className="quiz-hint"><Lightbulb /><Markdown text={hintText} /></div>
              : <button type="button" className="btn ghost quiz-hint-btn" onClick={() => setHintFor(index)}><Lightbulb />Hint</button>
          )}

          {showAnswer ? (
            <Feedback
              q={q}
              answer={current}
              reviewing={reviewing}
              onAsk={() => setAsking(index)}
              onChange={reopen}
              onNext={() => goTo(pos + 1)}
              last={pos + 1 >= order.length}
            />
          ) : (
            <div className="modal-actions">
              <button type="button" className="btn ghost" onClick={skip}>I don't know</button>
              <button type="button" className="btn primary" onClick={() => void check()} disabled={!given.trim() || checking}>
                {checking ? 'Checking…' : 'Check'} <kbd>↵</kbd>
              </button>
            </div>
          )}
        </div>
        </div>
        </AskableArea>
      )}

      <div className="quiz-footer">
        <button type="button" className="btn ghost nav-prev" onClick={() => goTo(pos - 1)} disabled={pos === 0}>
          <ChevronLeft />Previous
        </button>
        <span className="spacer" />
        {reviewing ? (
          <Results
            quiz={quiz}
            order={order}
            answers={answers}
            notebookId={notebookId}
            cardsMade={cardsMade}
            onCardsMade={(n) => { setCardsMade(n); onFinished(); }}
            onRetryMissed={(missed) => restart(missed)}
            onRestart={() => restart(null)}
            onDone={() => { clearQuizSession(quizId); onClose(); }}
          />
        ) : (
          <button type="button" className="btn primary quiz-finish" onClick={finish} disabled={!answeredCount}>
            <Flag />
            {answeredCount < order.length ? `Finish · ${order.length - answeredCount} unanswered` : 'Finish'}
          </button>
        )}
        <span className="spacer" />
        <button type="button" className="btn ghost nav-next" onClick={() => goTo(pos + 1)} disabled={pos + 1 >= order.length}>
          Next<ChevronRight />
        </button>
      </div>

      {asking !== null && quiz.questions[asking] && (
        <AskAboutQuestion
          quiz={quiz}
          index={asking}
          answer={answers[asking]}
          notebookId={notebookId}
          onClose={() => setAsking(null)}
        />
      )}
    </div>
  );
}

const PROOF = /\b(prove|proof|disprove|justify|counter-?example|show that)\b/i;

function DiagramInput({ q, given, locked, autoFocus, onChange }: {
  q: QuizQuestion;
  given: string;
  locked: boolean;
  autoFocus: boolean;
  onChange: (value: string) => void;
}) {
  const labels = q.diagram?.labels ?? [];
  const values = labelAnswers(given, labels.length);
  const results = locked ? labelResults(q, given) : null;
  const [src, setSrc] = useState<string | null>(null);
  const [original, setOriginal] = useState<string | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const [aspect, setAspect] = useState<number | null>(null);
  const boxes = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    let alive = true;
    setSrc(null);
    setShowOriginal(false);
    if (q.diagram?.image) studyApi.attachmentData(q.diagram.image).then((d) => { if (alive) setSrc(d); }).catch(() => {});
    return () => { alive = false; };
  }, [q.diagram?.image]);

  useEffect(() => {
    if (!showOriginal || original || !q.diagram?.original) return;
    studyApi.attachmentData(q.diagram.original).then(setOriginal).catch(() => setShowOriginal(false));
  }, [showOriginal, original, q.diagram?.original]);

  const set = (i: number, v: string) => {
    const next = [...values];
    next[i] = v;
    onChange(next.some((x) => x.trim()) ? JSON.stringify(next) : '');
  };

  const revealing = showOriginal && !!original;
  return (
    <div className="diagram">
      <div className="diagram-stage" style={{ width: aspect ? `min(100%, ${Math.round(62 * aspect)}vh)` : '100%' }}>
        {src ? (
          <img src={revealing ? original! : src} alt="Diagram to label" draggable={false}
            onLoad={(e) => { const i = e.currentTarget; if (i.naturalHeight) setAspect(i.naturalWidth / i.naturalHeight); }} />
        ) : <div className="quiz-figure loading" />}
        {src && !revealing && labels.map((l, i) => {
          const [x0, y0, x1, y1] = l.box;
          const verdict = results ? (results[i] ? ' ok' : ' bad') : '';
          return (
            <div key={i} className={`diagram-slot${verdict}`}
              style={{ left: `${x0 * 100}%`, top: `${y0 * 100}%`, width: `${(x1 - x0) * 100}%`, height: `${(y1 - y0) * 100}%` }}>
              <input ref={(el) => { boxes.current[i] = el; }} value={values[i]} disabled={locked} spellCheck={false}
                placeholder={String(i + 1)} aria-label={`Label ${i + 1}`} autoFocus={autoFocus && i === 0}
                onChange={(e) => set(i, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' || e.metaKey || e.ctrlKey || e.shiftKey) return;
                  e.preventDefault();
                  e.stopPropagation();
                  boxes.current[i + 1]?.focus();
                }} />
              {results && !results[i] && <span className="diagram-fix">{l.answer}</span>}
            </div>
          );
        })}
      </div>
      <div className="diagram-foot muted small">
        {locked
          ? q.diagram?.original && (
            <button type="button" className="link" onClick={() => setShowOriginal((v) => !v)}>
              {showOriginal ? 'Back to your labels' : 'Show the original diagram'}
            </button>
          )
          : <>Type each label in its box. <kbd>↵</kbd> next box · <kbd>⌘</kbd>+<kbd>↵</kbd> check</>}
      </div>
    </div>
  );
}

function AnswerInput({ q, given, locked, reviewing, onChange }: {
  q: QuizQuestion;
  given: string;
  locked: boolean;
  reviewing: boolean;
  onChange: (value: string) => void;
}) {
  const chosen = picked(given);
  const correctSet = new Set(q.answers ?? []);

  if (q.type === 'label') return <DiagramInput q={q} given={given} locked={locked} autoFocus={!reviewing} onChange={onChange} />;

  if (q.type === 'mcq' || q.type === 'multi') {
    const multi = q.type === 'multi';
    return (
      <>
        {multi && <p className="muted small">Select every answer that applies.</p>}
        <div className="choices-list">
          {q.choices?.map((c, i) => {
            const isChosen = multi ? chosen.includes(i) : String(i) === given;
            const isRight = multi ? correctSet.has(i) : i === Number(q.answer);
            const state = locked
              ? isRight ? 'right' : isChosen ? 'wrong' : ''
              : isChosen ? 'picked' : '';
            return (
              <button
                type="button"
                key={i}
                className={`choice ${state}`}
                aria-pressed={multi ? isChosen : undefined}
                disabled={locked}
                onClick={() => {
                  if (multi) onChange(unpick(chosen.includes(i) ? chosen.filter((n) => n !== i) : [...chosen, i]));
                  else onChange(String(i));
                }}
              >
                <kbd>{i + 1}</kbd><Markdown text={asMath(c)} />
              </button>
            );
          })}
        </div>
      </>
    );
  }
  if (q.type === 'tf') {
    return (
      <div className="choices-list row">
        {['true', 'false'].map((v) => {
          const state = locked ? (v === q.answer ? 'right' : v === given ? 'wrong' : '') : v === given ? 'picked' : '';
          return <button type="button" key={v} className={`choice ${state}`} disabled={locked} onClick={() => onChange(v)}><kbd>{v[0]}</kbd>{v === 'true' ? 'True' : 'False'}</button>;
        })}
      </div>
    );
  }
  if (q.type === 'numeric') {
    return (
      <div className="numeric-row">
        <input className="field-input mono" value={given} onChange={(e) => onChange(e.target.value)} disabled={locked} placeholder="Your answer" autoFocus={!reviewing} inputMode="decimal" />
        {q.unit && <span className="muted">{q.unit}</span>}
      </div>
    );
  }
  if (q.type === 'blank') return null;
  const proof = PROOF.test(q.prompt);
  return <textarea className="textarea" rows={proof ? 10 : 4} value={given} onChange={(e) => onChange(e.target.value)} disabled={locked}
    placeholder={proof ? 'Your answer, then the proof or counterexample (Ctrl+Enter to check)' : 'Explain in a sentence or two (Ctrl+Enter to check)'} autoFocus={!reviewing} />;
}


function GapInput({ given, locked, verdict, autoFocus, onChange }: {
  given: string;
  locked: boolean;
  verdict?: boolean;
  autoFocus: boolean;
  onChange: (value: string) => void;
}) {
  const state = verdict === undefined ? '' : verdict ? ' right' : ' wrong';
  return (
    <input
      className={`gap-input${state}`}
      value={given}
      onChange={(e) => onChange(e.target.value)}
      disabled={locked}
      placeholder={locked ? '-' : 'answer'}
      aria-label="Fill the gap"
      autoFocus={autoFocus}
      autoComplete="off"
      spellCheck={false}
      style={{ width: `${Math.max(7, Math.min(40, given.length + 2))}ch` }}
    />
  );
}

const QuestionText = ({ q }: { q: QuizQuestion }) => (
  q.type === 'blank' && hasGap(q.prompt)
    ? <GapPrompt text={q.prompt} className="quiz-question-prompt"><span className="gap-view" /></GapPrompt>
    : <div className="quiz-question-prompt"><Markdown text={q.prompt} /></div>
);

const TYPE_BADGE: Record<QuizQuestion['type'], string> = {
  mcq: 'choice', multi: 'select all', tf: 'true/false', numeric: 'numeric', short: 'written', blank: 'fill the gap', label: 'diagram',
};

export function QuizView({ quiz, summary, notebookId, ctx, onBack, onPlay, onChanged }: {
  quiz: Quiz;
  summary: QuizSummary | undefined;
  notebookId: number;
  ctx: StudyContext;
  onBack: () => void;
  onPlay: (only?: number[], startAt?: number) => void;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState<number | null>(null);
  const [questions, setQuestions] = useState<QuizQuestion[]>(quiz.questions);
  const session = loadQuizSession(quiz.id);
  const answered = session && !session.reviewing ? Object.keys(session.answers).length : 0;

  const save = async (next: QuizQuestion[]) => {
    setQuestions(next);
    await studyApi.updateQuiz(quiz.id, next);
    onChanged();
  };

  const materialFor = useCallback(async (q: QuizQuestion): Promise<GenSource> => {
    const cited = q.sources?.map((x) => x.sourceId) ?? [];
    const ids = cited.length
      ? cited
      : (await studyApi.sources(notebookId)).filter((x) => x.status === 'ready').map((x) => x.id);
    const hits = ids.length ? await studyApi.sampleSources(ids, 40_000) : [];
    const notes = await studyApi.notes(notebookId)
      .then((list) => Promise.all(list.slice(0, 6).map((n) => studyApi.note(n.id).catch(() => null))))
      .catch(() => []);
    const written = (notes as (Note | null)[])
      .filter((n): n is Note => !!n && !!n.content.trim())
      .map((n) => ({ id: n.id, title: n.title, content: n.content }));
    if (!hits.length && !written.length) return { kind: 'topic', prompt: q.topic || quiz.title };
    return { kind: 'sources', hits, notes: written, focus: q.topic };
  }, [notebookId, quiz.title]);

  const missed = session
    ? Object.entries(session.answers).filter(([, a]) => !a.correct).map(([i]) => Number(i))
    : [];

  return (
    <SetPage
      kind="quiz"
      id={quiz.id}
      title={quiz.title}
      count={questions.length}
      best={summary?.best ?? null}
      last={summary?.last ?? null}
      runs={summary?.attempts ?? 0}
      chat={<ChatButton notebookId={notebookId} where={quiz.title} tag={quiz.title} briefing={quizBriefing(quiz, undefined)} />}
      actions={<>
        {!!missed.length && <button type="button" className="btn" onClick={() => onPlay(missed)}>Retry {missed.length} missed</button>}
        <button type="button" className="btn primary" disabled={!questions.length} onClick={() => onPlay()}>
          <Play />{answered ? `Carry on (${answered} answered)` : 'Start quiz'}
        </button>
      </>}
      listAside={<span className="muted small">Click a question to edit it, or go straight to it.</span>}
      onBack={onBack}
      onRename={async (title) => { await studyApi.renameQuiz(quiz.id, title); onChanged(); }}
      onDelete={async () => { clearQuizSession(quiz.id); await studyApi.deleteQuiz(quiz.id); onChanged(); onBack(); }}
      deleteText={<>Delete <b>{quiz.title}</b> and its {questions.length} questions? Past attempts go too.</>}
      dialogs={editing !== null && questions[editing] && (
        <QuestionEditor
          question={questions[editing]}
          index={editing}
          onClose={() => setEditing(null)}
          onSave={async (next) => {
            await save(questions.map((q, i) => (i === editing ? next : q)));
            setEditing(null);
          }}
          onDelete={questions.length > 1 ? async () => {
            await save(questions.filter((_, i) => i !== editing));
            setEditing(null);
          } : undefined}
          onRewrite={async (progress) => {
            const q = questions[editing];
            return rewriteQuestion(ctx, q, notebookId, await materialFor(q), progress);
          }}
        />
      )}
    >
      {questions.map((q, i) => (
        <SetItem key={i} n={i + 1} index={i} result={session?.answers[i]?.correct} onOpen={() => setEditing(i)}
          side={<button type="button" className="link" onClick={() => onPlay(undefined, i)} title="Open the quiz on this question">go to</button>}>
          <div className="set-question">
            <div className="quiz-question-tags muted">
              <span className="tag">{TYPE_BADGE[q.type]}</span>
              <span>{q.topic}</span>
              {q.difficulty && <span>· {q.difficulty}</span>}
              {q.verified && <span className="q-verify ok"><ShieldCheck />checked</span>}
            </div>
            <QuestionText q={q} />
            <div className="quiz-question-answer muted">
              <span>Answer:</span><Markdown text={answerText(q)} className="tight inline" />
            </div>
          </div>
        </SetItem>
      ))}
    </SetPage>
  );
}

function QuestionEditor({ question, index, onClose, onSave, onDelete, onRewrite }: {
  question: QuizQuestion;
  index: number;
  onClose: () => void;
  onSave: (q: QuizQuestion) => Promise<void>;
  onDelete?: () => Promise<void>;
  onRewrite?: (progress: (text: string) => void) => Promise<QuizQuestion>;
}) {
  const [draft, setDraft] = useState<QuizQuestion>(question);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<QuizQuestion>) => setDraft((d) => ({ ...d, ...patch }));
  const choices = draft.choices ?? [];
  const multi = draft.type === 'multi';

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!draft.prompt.trim()) throw new Error('A question needs something to ask.');
      if ((draft.type === 'mcq' || multi) && choices.filter((c) => c.trim()).length < 2) {
        throw new Error('A choice question needs at least two choices.');
      }
      if (multi && !(draft.answers ?? []).length) throw new Error('Tick which choices are correct.');
      await onSave({ ...draft, verified: false });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Modal title={`Question ${index + 1}`} onClose={busy ? () => {} : onClose}>
      <div className="form">
        <label className="field">
          <span>Question</span>
          <textarea className="textarea" rows={3} value={draft.prompt} onChange={(e) => set({ prompt: e.target.value })} disabled={busy} />
        </label>

        {(draft.type === 'mcq' || multi) && (
          <div className="field">
            <span className="field-label">Choices - {multi ? 'tick every correct one' : 'tick the correct one'}</span>
            {choices.map((c, i) => (
              <div className="numeric-row" key={i}>
                <input
                  type={multi ? 'checkbox' : 'radio'}
                  name={`answer-${index}`}
                  checked={multi ? (draft.answers ?? []).includes(i) : Number(draft.answer) === i}
                  disabled={busy}
                  onChange={() => set(multi
                    ? { answers: (draft.answers ?? []).includes(i) ? (draft.answers ?? []).filter((n) => n !== i) : [...(draft.answers ?? []), i].sort((a, b) => a - b) }
                    : { answer: i })}
                />
                <input className="field-input" value={c} disabled={busy}
                  onChange={(e) => set({ choices: choices.map((x, j) => (j === i ? e.target.value : x)) })} />
                {choices.length > 2 && (
                  <button type="button" className="task-x" disabled={busy} aria-label={`Remove choice ${i + 1}`}
                    onClick={() => set({ choices: choices.filter((_, j) => j !== i) })}><X /></button>
                )}
              </div>
            ))}
            <button type="button" className="btn ghost" disabled={busy} onClick={() => set({ choices: [...choices, ''] })}>Add choice</button>
          </div>
        )}

        {draft.type === 'tf' && (
          <label className="field narrow">
            <span>Answer</span>
            <Select className="field-input" value={String(draft.answer)} disabled={busy} onChange={(v) => set({ answer: v })}
              options={[{ value: 'true', label: 'True' }, { value: 'false', label: 'False' }]} />
          </label>
        )}

        {draft.type === 'label' && draft.diagram && (
          <div className="field">
            <span className="field-label">Labels <i className="muted">in the order of their boxes</i></span>
            <div className="diagram-edit">
              {draft.diagram.labels.map((l, i) => (
                <label key={i} className="diagram-edit-row">
                  <span className="mono muted">{i + 1}</span>
                  <input className="field-input" value={l.answer} disabled={busy}
                    onChange={(e) => {
                      const labels = draft.diagram!.labels.map((x, j) => (j === i ? { ...x, answer: e.target.value } : x));
                      set({ diagram: { ...draft.diagram!, labels }, answer: labels.map((x) => x.answer).join(' · ') });
                    }} />
                </label>
              ))}
            </div>
          </div>
        )}

        {(draft.type === 'numeric' || draft.type === 'short' || draft.type === 'blank') && (
          <label className="field">
            <span>{draft.type === 'short' ? 'Model answer' : 'Answer'}</span>
            <input className="field-input" value={String(draft.answer)} disabled={busy}
              onChange={(e) => set({ answer: draft.type === 'numeric' ? Number(e.target.value) || 0 : e.target.value })} />
          </label>
        )}

        <label className="field">
          <span>Hint <i className="muted">shown only if they ask; must not give the answer away</i></span>
          <input className="field-input" value={draft.hint ?? ''} disabled={busy} onChange={(e) => set({ hint: e.target.value })} />
        </label>
        <label className="field">
          <span>Explanation <i className="muted">shown after answering</i></span>
          <textarea className="textarea" rows={3} value={draft.explanation} disabled={busy} onChange={(e) => set({ explanation: e.target.value })} />
        </label>
        <div className="form-row">
          <label className="field narrow">
            <span>Topic</span>
            <input className="field-input" value={draft.topic} disabled={busy} onChange={(e) => set({ topic: e.target.value })} />
          </label>
          <label className="field narrow">
            <span>Difficulty</span>
            <Select className="field-input" value={draft.difficulty ?? ''} disabled={busy}
              onChange={(v) => set({ difficulty: (v || undefined) as QuizQuestion['difficulty'] })}
              options={[
                { value: '', label: 'Not set' },
                { value: 'easy', label: 'Easy' },
                { value: 'medium', label: 'Medium' },
                { value: 'hard', label: 'Hard' },
              ]} />
          </label>
        </div>
        {status && <div className="gen-status"><span className="dots"><i /><i /><i /></span>{status}</div>}
        {error && <div className="form-err">{error}</div>}
      </div>
      <div className="modal-actions">
        {onDelete && <button type="button" className="btn ghost danger" disabled={busy} onClick={() => void onDelete()}>Delete question</button>}
        <span className="spacer" />
        {onRewrite && draft.type !== 'label' && (
          <button
            type="button"
            className="btn ghost"
            disabled={busy}
            title="Have the AI write a different question on the same idea"
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                setDraft(await onRewrite(setStatus));
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              }
              setStatus(null);
              setBusy(false);
            }}
          >
            <Sparkles />Rewrite with AI
          </button>
        )}
        <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="btn primary" onClick={() => void submit()} disabled={busy}>Save</button>
      </div>
    </Modal>
  );
}

function Feedback({ q, answer, reviewing, onAsk, onChange, onNext, last }: {
  q: QuizQuestion;
  answer: QuizAnswer | undefined;
  reviewing: boolean;
  onAsk: () => void;
  onChange: () => void;
  onNext: () => void;
  last: boolean;
}) {
  const correct = !!answer?.correct;
  return (
    <div className={`feedback ${answer ? (correct ? 'right' : 'wrong') : 'muted'}`}>
      <div className="feedback-head">
        <span className="feedback-icon">{correct ? <Check /> : <X />}</span>
        <b>{!answer ? 'Not answered' : correct ? 'Correct' : 'Not quite'}</b>
        {answer && (
          <span className="muted feedback-said">· you said: <Markdown text={givenText(q, answer.given)} className="tight inline" /></span>
        )}
        {!correct && (
          <span className="muted feedback-said">· answer: <Markdown text={answerText(q)} className="tight inline" /></span>
        )}
      </div>
      {answer?.feedback && <p className="feedback-note">{answer.feedback}</p>}
      {q.explanation && <Markdown text={q.explanation} className="feedback-explain" />}
      {q.hint && (
        <div className="muted small feedback-hint">
          <Lightbulb />
          <span className="feedback-hint-label">Hint was:</span>
          <Markdown text={q.hint} className="tight" />
        </div>
      )}
      {!!q.sources?.length && (
        <p className="muted small">From {q.sources.map((s) => `${s.title} (${s.label})`).join('; ')}</p>
      )}
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={onAsk}><MessageCircleQuestion />Ask AI</button>
        {!reviewing && <button type="button" className="btn ghost" onClick={onChange}>Change my answer</button>}
        {!last && <button type="button" className="btn primary" onClick={onNext}>Next <kbd>↵</kbd></button>}
      </div>
    </div>
  );
}

function Results({ quiz, order, answers, notebookId, cardsMade, onCardsMade, onRetryMissed, onRestart, onDone }: {
  quiz: Quiz;
  order: number[];
  answers: Record<number, QuizAnswer>;
  notebookId: number;
  cardsMade: number | null;
  onCardsMade: (n: number) => void;
  onRetryMissed: (missed: number[]) => void;
  onRestart: () => void;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const answered = order.filter((i) => answers[i] !== undefined);
  const right = answered.filter((i) => answers[i].correct);
  const missed = answered.filter((i) => !answers[i].correct);

  const byTopic = new Map<string, { right: number; total: number }>();
  for (const i of answered) {
    const topic = quiz.questions[i].topic;
    const t = byTopic.get(topic) ?? { right: 0, total: 0 };
    t.total += 1;
    if (answers[i].correct) t.right += 1;
    byTopic.set(topic, t);
  }

  return (
    <>
      <button type="button" className="btn primary" onClick={() => setOpen(true)}>
        Results · {answered.length ? Math.round((right.length / answered.length) * 100) : 0}%
      </button>
      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div className="modal summary" onClick={(e) => e.stopPropagation()}>
            <div className="summary-score">
              <span className="summary-num">{answered.length ? Math.round((right.length / answered.length) * 100) : 0}%</span>
              <span className="muted">{right.length} of {answered.length} right</span>
            </div>
            <div className="panel-title">By topic</div>
            <div className="meters">
              {[...byTopic.entries()].sort((a, b) => a[1].right / a[1].total - b[1].right / b[1].total).map(([t, v]) => (
                <div className="meter" key={t}>
                  <span className="meter-label">{t}</span>
                  <span className="meter-track"><i style={{ width: `${(v.right / v.total) * 100}%` }} /></span>
                  <span className="meter-value">{v.right}/{v.total}</span>
                </div>
              ))}
            </div>
            <p className="muted small">Close this to look back through every question - your answer, the right one and why.</p>
            <div className="modal-actions">
              {!!missed.length && (
                <button
                  type="button"
                  className="btn ghost"
                  disabled={cardsMade !== null}
                  onClick={async () => {
                    const cards = cardsFromMistakes(missed.map((i) => {
                      const mq = quiz.questions[i];
                      return { prompt: mq.prompt, answer: answerText(mq), explanation: mq.explanation, topic: mq.topic };
                    }));
                    await studyApi.addCards(notebookId, cards);
                    onCardsMade(cards.length);
                  }}
                >
                  {cardsMade !== null ? `${cardsMade} card${cardsMade === 1 ? '' : 's'} added` : 'Flashcards from mistakes'}
                </button>
              )}
              {!!missed.length && <button type="button" className="btn" onClick={() => { setOpen(false); onRetryMissed(missed); }}>Retry missed</button>}
              <button type="button" className="btn" onClick={() => { setOpen(false); onRestart(); }}>Take again</button>
              <button type="button" className="btn primary" onClick={onDone}>Done</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
