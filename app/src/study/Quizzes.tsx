import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Check, ListChecks, ShieldCheck, Sparkles, X } from 'lucide-react';
import { Markdown } from '../lib/markdown';
import { cardsFromMistakes, gradeLocal, gradeShort } from '../lib/studyGen';
import { studyApi, type AttemptAnswer, type Quiz, type QuizQuestion, type QuizSummary } from './api';

const pct = (v: number | null) => (v === null ? '–' : `${Math.round(v * 100)}%`);

export function QuizzesPane({ quizzes, onStart, onGenerate, onDelete }: {
  quizzes: QuizSummary[];
  onStart: (id: number) => void;
  onGenerate: () => void;
  onDelete: (q: QuizSummary) => void;
}) {
  return (
    <div className="pane-body">
      <div className="pane-actions">
        <button type="button" className="btn primary" onClick={onGenerate}><Sparkles />Generate quiz</button>
      </div>
      {!quizzes.length && <p className="muted small pane-note">No quizzes yet. Make one from a topic or from a chat; calculation questions are checked in Python first.</p>}
      <ul className="quiz-list stagger">
        {quizzes.map((q, i) => (
          <li key={q.id} style={{ '--i': i } as React.CSSProperties}>
            <div className="quiz-row">
              <button type="button" className="quiz-main" onClick={() => onStart(q.id)}>
                <span className="quiz-title"><ListChecks />{q.title}</span>
                <span className="quiz-meta muted">{q.questionCount} questions · {q.attempts ? `best ${pct(q.best)} · last ${pct(q.last)}` : 'not taken yet'}</span>
              </button>
              <button type="button" className="task-x" onClick={() => onDelete(q)} aria-label={`Delete ${q.title}`}><X /></button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FigureImg({ id }: { id: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => { studyApi.attachmentData(id).then(setSrc).catch(() => {}); }, [id]);
  return src ? <img className="quiz-figure" src={src} alt="Figure for this question" /> : <div className="quiz-figure loading" />;
}

const answerText = (q: QuizQuestion) =>
  q.type === 'mcq' ? q.choices?.[Number(q.answer)] ?? '' : q.type === 'tf' ? (q.answer === 'true' ? 'True' : 'False') : `${q.answer}${q.unit ? ` ${q.unit}` : ''}`;

type Graded = AttemptAnswer & { feedback?: string };

/** Take a quiz: one question per screen, instant feedback, results at the end. */
export function QuizRunner({ quizId, onlyIndexes, onClose, onFinished, notebookId }: {
  quizId: number;
  /** Retry just these questions. */
  onlyIndexes?: number[];
  notebookId: number;
  onClose: () => void;
  onFinished: () => void;
}) {
  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pos, setPos] = useState(0);
  const [given, setGiven] = useState('');
  const [graded, setGraded] = useState<Graded[]>([]);
  const [checking, setChecking] = useState(false);
  const [retry, setRetry] = useState<number[] | null>(onlyIndexes ?? null);
  const [cardsMade, setCardsMade] = useState<number | null>(null);
  const started = useRef(Date.now());
  const shownAt = useRef(Date.now());
  const saved = useRef(false);

  useEffect(() => { studyApi.quiz(quizId).then(setQuiz).catch((e) => setError(String(e))); }, [quizId]);

  const order = useMemo(() => (quiz ? (retry ?? quiz.questions.map((_, i) => i)) : []), [quiz, retry]);
  const index = order[pos];
  const q = quiz && index !== undefined ? quiz.questions[index] : null;
  const current = graded.find((g) => g.index === index);
  const finished = !!quiz && pos >= order.length;

  useEffect(() => {
    if (!finished || saved.current || !quiz) return;
    saved.current = true;
    const score = graded.filter((g) => g.correct).length;
    void studyApi.addAttempt(quiz.id, started.current, score, graded.length, graded.map(({ feedback: _f, ...g }) => g)).then(onFinished).catch(() => {});
  }, [finished, graded, quiz, onFinished]);

  const check = async () => {
    if (!q || current || !given.trim() || checking) return;
    setChecking(true);
    let correct = false;
    let feedback: string | undefined;
    try {
      if (q.type === 'short') ({ correct, feedback } = await gradeShort(q, given));
      else correct = gradeLocal(q, given);
    } catch (e) {
      feedback = `Could not grade this automatically (${String(e)}). Compare with the answer below.`;
    }
    setGraded((g) => [...g, { index, given, correct, topic: q.topic, ms: Date.now() - shownAt.current, feedback }]);
    setChecking(false);
  };

  const next = () => {
    setGiven('');
    setPos((p) => p + 1);
    shownAt.current = Date.now();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (!q || finished) return;
      const typing = (e.target as HTMLElement).closest('input, textarea');
      if (e.key === 'Enter' && !e.shiftKey && (!typing || q.type !== 'short' || e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (current) next(); else void check();
        return;
      }
      if (typing || current) return;
      if (q.type === 'mcq' && /^[1-9]$/.test(e.key) && Number(e.key) <= (q.choices?.length ?? 0)) setGiven(String(Number(e.key) - 1));
      if (q.type === 'tf' && (e.key === 't' || e.key === 'f')) setGiven(e.key === 't' ? 'true' : 'false');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (error) return <div className="stage"><div className="pane-empty center"><p className="form-err">{error}</p><button type="button" className="btn" onClick={onClose}>Back</button></div></div>;
  if (!quiz) return <div className="stage"><div className="pane-empty center"><span className="dots"><i /><i /><i /></span></div></div>;

  const right = graded.filter((g) => g.correct).length;

  if (finished) {
    const byTopic = new Map<string, { right: number; total: number }>();
    for (const g of graded) {
      const t = byTopic.get(g.topic) ?? { right: 0, total: 0 };
      t.total += 1;
      if (g.correct) t.right += 1;
      byTopic.set(g.topic, t);
    }
    const missed = graded.filter((g) => !g.correct);
    const restart = (only: number[] | null) => {
      saved.current = false;
      started.current = Date.now();
      setGraded([]);
      setRetry(only);
      setPos(0);
      setGiven('');
      setCardsMade(null);
    };
    return (
      <div className="stage">
        <div className="stage-head">
          <button type="button" className="link" onClick={onClose}><ArrowLeft />back</button>
          <span className="stage-title">{quiz.title}</span>
        </div>
        <div className="summary">
          <div className="summary-score">
            <span className="summary-num">{graded.length ? Math.round((right / graded.length) * 100) : 0}%</span>
            <span className="muted">{right} of {graded.length} right · {Math.max(1, Math.round((Date.now() - started.current) / 60_000))} min</span>
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
          {!!missed.length && (
            <div className="summary-missed">
              <div className="panel-title">Missed</div>
              <ul>
                {missed.map((g) => {
                  const mq = quiz.questions[g.index];
                  return <li key={g.index}><Markdown text={mq.prompt} /><div className="muted small">Answer: {answerText(mq)} · you said: {mq.type === 'mcq' ? mq.choices?.[Number(g.given)] : g.given}</div></li>;
                })}
              </ul>
            </div>
          )}
          <div className="modal-actions">
            {!!missed.length && (
              <button
                type="button"
                className="btn ghost"
                disabled={cardsMade !== null}
                onClick={async () => {
                  const cards = cardsFromMistakes(missed.map((g) => {
                    const mq = quiz.questions[g.index];
                    return { prompt: mq.prompt, answer: answerText(mq), explanation: mq.explanation, topic: mq.topic };
                  }));
                  await studyApi.addCards(notebookId, cards);
                  setCardsMade(cards.length);
                  onFinished();
                }}
              >
                {cardsMade !== null ? `${cardsMade} card${cardsMade === 1 ? '' : 's'} added` : 'Flashcards from mistakes'}
              </button>
            )}
            {!!missed.length && <button type="button" className="btn" onClick={() => restart(missed.map((g) => g.index))}>Retry missed</button>}
            <button type="button" className="btn" onClick={() => restart(null)}>Take again</button>
            <button type="button" className="btn primary" onClick={onClose}>Done</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="stage">
      <div className="stage-head">
        <button type="button" className="link" onClick={onClose}><ArrowLeft />back</button>
        <span className="stage-title">{quiz.title}{retry ? ' · retry' : ''}</span>
        <span className="spacer" />
        <span className="stage-count mono">{pos + 1} / {order.length} · {right} right</span>
      </div>
      <div className="progress"><i style={{ width: `${(pos / order.length) * 100}%` }} /></div>
      {q && (
        <div className="question-card" key={`${index}-${pos}`}>
          <div className="q-meta muted">
            <span>{q.topic}</span>
            <span className={`q-verify${q.verified ? ' ok' : ''}`} title={q.verified ? 'The answer was re-derived in Python' : 'Not checked by Python (conceptual, or Python unavailable)'}>
              {q.verified ? <><ShieldCheck />checked in Python</> : 'unverified'}
            </span>
          </div>
          <div className="q-prompt"><Markdown text={q.prompt} /></div>
          {q.figure && <FigureImg id={q.figure} />}

          {q.type === 'mcq' && (
            <div className="choices-list">
              {q.choices?.map((c, i) => {
                const state = current ? (i === q.answer ? 'right' : String(i) === given ? 'wrong' : '') : String(i) === given ? 'picked' : '';
                return (
                  <button type="button" key={i} className={`choice ${state}`} disabled={!!current} onClick={() => setGiven(String(i))}>
                    <kbd>{i + 1}</kbd><Markdown text={c} />
                  </button>
                );
              })}
            </div>
          )}
          {q.type === 'tf' && (
            <div className="choices-list row">
              {['true', 'false'].map((v) => {
                const state = current ? (v === q.answer ? 'right' : v === given ? 'wrong' : '') : v === given ? 'picked' : '';
                return <button type="button" key={v} className={`choice ${state}`} disabled={!!current} onClick={() => setGiven(v)}><kbd>{v[0]}</kbd>{v === 'true' ? 'True' : 'False'}</button>;
              })}
            </div>
          )}
          {q.type === 'numeric' && (
            <div className="numeric-row">
              <input className="field-input mono" value={given} onChange={(e) => setGiven(e.target.value)} disabled={!!current} placeholder="Your answer" autoFocus inputMode="decimal" />
              {q.unit && <span className="muted">{q.unit}</span>}
            </div>
          )}
          {q.type === 'short' && (
            <textarea className="textarea" rows={4} value={given} onChange={(e) => setGiven(e.target.value)} disabled={!!current} placeholder="Explain in a sentence or two (Ctrl+Enter to check)" autoFocus />
          )}

          {current ? (
            <div className={`feedback ${current.correct ? 'right' : 'wrong'}`}>
              <div className="feedback-head">
                <span className="feedback-icon">{current.correct ? <Check /> : <X />}</span>
                <b>{current.correct ? 'Correct' : 'Not quite'}</b>
                {!current.correct && q.type !== 'mcq' && q.type !== 'tf' && <span className="muted">· answer: {answerText(q)}</span>}
              </div>
              {current.feedback && <p className="feedback-note">{current.feedback}</p>}
              {q.explanation && <Markdown text={q.explanation} className="feedback-explain" />}
              <div className="modal-actions"><button type="button" className="btn primary" onClick={next} autoFocus>{pos + 1 < order.length ? 'Next' : 'See results'} <kbd>↵</kbd></button></div>
            </div>
          ) : (
            <div className="modal-actions">
              <button type="button" className="btn ghost" onClick={() => { setGraded((g) => [...g, { index, given: '', correct: false, topic: q.topic, ms: Date.now() - shownAt.current }]); }}>I don't know</button>
              <button type="button" className="btn primary" onClick={() => void check()} disabled={!given.trim() || checking}>
                {checking ? 'Checking…' : 'Check'} <kbd>↵</kbd>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
