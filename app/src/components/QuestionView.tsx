import { Fragment } from 'react';
import type { Box, Draft, Question, SubmitResult } from '../types';
import { BoxCard, focusBox } from './BoxCard';
import { QuestionHtml } from './QuestionHtml';
import { STATUS_LABEL, attemptsLeft } from '../lib/format';

type Props = {
  question: Question;
  draftOf: (box: Box) => Draft;
  setDraft: (box: Box, d: Draft) => void;
  unsavedCount: number;
  busy: 'save' | 'submit' | 'dry' | null;
  result?: SubmitResult;
  onSave: () => void;
  onSubmit: () => void;
  onDryRun: () => void;
  onRevert: () => void;
};

const WA = 'https://www.webassign.net';
const MATH_TYPE_NOISE = /Press Space or Enter to edit this math answer\.?/gi;

function QuestionText({ text, boxes }: { text: string; boxes: Box[] }) {
  const parts = text.split(/(\[\d+\]|\[image: [^\]]+\])/g);
  return (
    <div className="qtext">
      {parts.map((p, i) => {
        const box = /^\[(\d+)\]$/.exec(p);
        if (box) {
          const b = boxes[Number(box[1]) - 1];
          return (
            <button key={i} type="button" className={`chip status-${b?.status ?? 'unanswered'}`} onClick={() => focusBox(Number(box[1]))}>
              {box[1]}
            </button>
          );
        }
        const img = /^\[image: ([^\]]+)\]$/.exec(p);
        if (img) {
          if (/mcorrect|mincorrect|mpartial/i.test(img[1])) return null;
          const src = img[1].startsWith('/') ? WA + img[1] : img[1];
          return <img key={i} className="qimg" src={src} alt="" />;
        }
        const clean = p.replace(MATH_TYPE_NOISE, '');
        if (!clean.trim()) return null;
        return <Fragment key={i}>{clean}</Fragment>;
      })}
    </div>
  );
}

function ResultBanner({ result }: { result: SubmitResult }) {
  const wrong = result.results.filter((r) => r.status === 'incorrect').length;
  const partial = result.results.filter((r) => r.status === 'partial').length;
  const right = result.results.filter((r) => r.status === 'correct').length;
  const tone = result.allCorrect ? 'good' : wrong ? 'bad' : 'mid';
  return (
    <div className={`result ${tone}`}>
      <div className="result-title">
        {result.allCorrect ? '✓ ALL CORRECT' : `✗ ${wrong} WRONG${partial ? ` · ${partial} PARTIAL` : ''} · ${right} CORRECT`}
        <span className="muted"> — last submit</span>
      </div>
      <div className="result-parts">
        {result.results.map((r) => (
          <button type="button" key={r.index} className={`result-part status-${r.status}`} onClick={() => focusBox(r.index)} title={r.message ?? ''}>
            <b>[{r.index}]</b> {STATUS_LABEL[r.status]}
            {r.maxSubmissions != null && <span className="muted"> · {r.submissions}/{r.maxSubmissions}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

export function QuestionView({
  question, draftOf, setDraft, unsavedCount, busy, result, onSave, onSubmit, onDryRun, onRevert,
}: Props) {
  const left = question.boxes.map(attemptsLeft).filter((x): x is number => x != null);
  const noneLeft = left.length > 0 && left.every((x) => x <= 0);
  const richHtml = question.html
    && (!question.boxes.length || /class="wa-(slot|opt|static)"/.test(question.html)) ? question.html : null;

  return (
    <div className="question">
      <div className="question-head">
        <h2>Q{question.number}</h2>
        {question.code && <span className="code">{question.code}</span>}
        <span className="spacer" />
        {question.total != null && (
          <span className="qscore">{question.score ?? '–'}<span className="muted">/{question.total} pts</span></span>
        )}
        {question.submissions && <span className="qsubs" title="Submissions used / allowed">⟳ {question.submissions}</span>}
      </div>

      {result && <ResultBanner result={result} />}

      {richHtml
        ? <div className="qframe"><QuestionHtml html={richHtml} boxes={question.boxes} draftOf={draftOf} setDraft={setDraft} /></div>
        : <QuestionText text={question.text} boxes={question.boxes} />}

      <div className="boxes">
        {question.boxes.map((b) => (
          <BoxCard
            key={b.id}
            box={b}
            draft={draftOf(b)}
            onChange={(d) => setDraft(b, d)}
            onNext={() => focusBox(b.index + 1 > question.boxes.length ? 1 : b.index + 1)}
          />
        ))}
        {!question.boxes.length && <div className="empty">This question has no answer boxes.</div>}
      </div>

      <div className="actionbar">
        <span className={`unsaved-count${unsavedCount ? ' on' : ''}`}>
          {unsavedCount ? `● ${unsavedCount} unsaved` : '✓ all saved'}
        </span>
        {unsavedCount > 0 && <button type="button" className="btn ghost" onClick={onRevert} title="Drop local edits for this question">Revert</button>}
        <span className="spacer" />
        <button type="button" className="btn ghost" onClick={onDryRun} disabled={!!busy} title="Show the exact request without sending it">
          {busy === 'dry' ? '…' : 'Dry run'}
        </button>
        <button type="button" className="btn" onClick={onSave} disabled={!!busy || !unsavedCount} title="Save progress without using a submission (Ctrl+S)">
          {busy === 'save' ? 'Saving…' : 'Save'} <kbd>Ctrl S</kbd>
        </button>
        <button type="button" className="btn primary" onClick={onSubmit} disabled={!!busy || noneLeft} title="Submit for grading (Ctrl+Enter)">
          {busy === 'submit' ? 'Submitting…' : 'Submit'} <kbd>Ctrl ↵</kbd>
        </button>
      </div>
    </div>
  );
}
