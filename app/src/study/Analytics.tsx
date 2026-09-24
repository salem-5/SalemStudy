import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { BarChart, LineChart, MeterList, StatTile } from '../components/charts';
import { studyApi, type Attempt, type DeckRun, type Review } from './api';

const DAY = 864e5;
const startOfDay = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const fmtMin = (ms: number) => { const m = Math.round(ms / 60_000); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`; };
const pct = (v: number | null) => (v === null ? '–' : `${Math.round(v * 100)}%`);
const when = (t: number) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function Analytics({ notebookId, version }: { notebookId: number; version: number }) {
  const [data, setData] = useState<{ reviews: Review[]; runs: DeckRun[]; attempts: Attempt[] } | null>(null);

  useEffect(() => {
    const since = Date.now() - 90 * DAY;
    Promise.all([studyApi.reviews(notebookId, since), studyApi.deckRuns(notebookId, since), studyApi.attempts(notebookId, since)])
      .then(([reviews, runs, attempts]) => setData({ reviews, runs, attempts }))
      .catch(() => setData({ reviews: [], runs: [], attempts: [] }));
  }, [notebookId, version]);

  const a = useMemo(() => {
    if (!data) return null;
    const { reviews, runs, attempts } = data;
    const today = startOfDay(Date.now());
    const from30 = today - 29 * DAY;
    const days = Array.from({ length: 30 }, (_, i) => {
      const from = today - (29 - i) * DAY;
      const rs = reviews.filter((r) => r.reviewedAt >= from && r.reviewedAt < from + DAY);
      const d = new Date(from);
      return {
        label: d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' }),
        title: d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }),
        values: { got: rs.filter((r) => r.correct).length, missed: rs.filter((r) => !r.correct).length },
      };
    });
    const active = new Set([...runs.map((x) => startOfDay(x.finishedAt)), ...attempts.map((x) => startOfDay(x.finishedAt))]);
    let streak = 0;
    for (let d = active.has(today) ? today : today - DAY; active.has(d); d -= DAY) streak++;

    const last30 = reviews.filter((r) => r.reviewedAt >= from30);
    const acc30 = last30.length ? last30.filter((r) => r.correct).length / last30.length : null;
    const studyMs = runs.filter((x) => x.finishedAt >= from30).reduce((s, x) => s + Math.min(x.finishedAt - x.startedAt, 3 * 3600_000), 0)
      + attempts.filter((x) => x.finishedAt >= from30).reduce((s, x) => s + Math.min(x.finishedAt - x.startedAt, 3 * 3600_000), 0);

    const topics = new Map<string, { right: number; total: number }>();
    const bump = (t: string, ok: boolean) => {
      const v = topics.get(t || 'General') ?? { right: 0, total: 0 };
      v.total++;
      if (ok) v.right++;
      topics.set(t || 'General', v);
    };
    for (const r of last30) bump(r.topic, r.correct);
    for (const x of attempts) for (const ans of x.answers) bump(ans.topic, ans.correct);
    const topicRows = [...topics.entries()]
      .filter(([, v]) => v.total >= 2)
      .map(([t, v]) => ({ key: t, label: t, value: v.right / v.total, detail: `${v.right}/${v.total}` }))
      .sort((x, y) => x.value - y.value)
      .slice(0, 10);

    const score = (c: number, t: number) => (t ? c / t : 0);
    return {
      days, streak, acc30, studyMs, topicRows,
      reviews30: last30.length,
      runPoints: runs.map((x) => ({ label: x.deckTitle, title: when(x.finishedAt), y: score(x.correct, x.total) })),
      avgRun: runs.length ? runs.reduce((s, x) => s + score(x.correct, x.total), 0) / runs.length : null,
      quizPoints: attempts.map((x) => ({ label: x.quizTitle, title: when(x.finishedAt), y: score(x.score, x.total) })),
      avgQuiz: attempts.length ? attempts.reduce((s, x) => s + score(x.score, x.total), 0) / attempts.length : null,
    };
  }, [data]);

  if (!a) return <div className="analytics"><div className="pane-empty center"><Loader2 className="spin" /></div></div>;
  const nothing = !a.reviews30 && !a.quizPoints.length && !a.runPoints.length;

  return (
    <div className="analytics">
      <div className="stats-row stagger">
        <StatTile label="Card accuracy, 30 days" value={pct(a.acc30)} sub={`${a.reviews30} cards answered`} />
        <StatTile label="Deck average" value={pct(a.avgRun)} sub={`${a.runPoints.length} play${a.runPoints.length === 1 ? '' : 's'}`} />
        <StatTile label="Quiz average" value={pct(a.avgQuiz)} sub={`${a.quizPoints.length} attempt${a.quizPoints.length === 1 ? '' : 's'}`} />
        <StatTile label="Streak" value={`${a.streak} day${a.streak === 1 ? '' : 's'}`} sub={`${fmtMin(a.studyMs)} studied, 30 days`} />
      </div>

      {nothing && <p className="muted small">Play a deck or take a quiz and your progress shows up here.</p>}

      <div className="card-panel">
        <div className="panel-title">Cards answered per day</div>
        <BarChart
          label="Flashcards answered per day over the last 30 days, split into got it and missed"
          data={a.days}
          series={[{ key: 'got', name: 'Got it', color: 'var(--series-1)' }, { key: 'missed', name: 'Missed', color: 'var(--series-2)' }]}
        />
      </div>

      <div className="analytics-grid">
        <div className="card-panel">
          <div className="panel-title">Deck scores</div>
          {a.runPoints.length ? <LineChart label="Score of each deck play" points={a.runPoints} /> : <p className="muted small">No decks played yet.</p>}
        </div>
        <div className="card-panel">
          <div className="panel-title">Quiz scores</div>
          {a.quizPoints.length ? <LineChart label="Score of each quiz attempt" points={a.quizPoints} /> : <p className="muted small">No quiz attempts yet.</p>}
        </div>
      </div>

      <div className="card-panel">
        <div className="panel-title">Weakest topics <span className="muted">cards and quizzes, 30 days</span></div>
        <MeterList rows={a.topicRows} empty="Not enough answers per topic yet." />
      </div>
    </div>
  );
}
