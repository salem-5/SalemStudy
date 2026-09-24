import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Select } from '../components/Select';
import { ArrowLeft, Check, Zap, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, FileText, MessageCircleQuestion, Play, Plus, RotateCcw, Shuffle, Sparkles, Trash, X } from 'lucide-react';
import { Modal } from '../components/Dialogs';
import { Markdown } from '../lib/markdown';
import { type CardOptions, type CardSize, type GenSource, type QuizOptions } from '../lib/studyGen';
import { AskableArea, AskAboutCard, ChatButton, deckBriefing } from './StudyChat';
import { clearDeckSession, deckSessionFits, loadDeckSession, pruneDeckSession, saveDeckSession } from '../lib/studySession';
import {studyApi, type Card, type CardResult, type ChatThread, type Deck, type Source, type Difficulty, type QuestionType, type Note } from './api';
import { wholeSources } from '../lib/material';
import { applyOrder, CARD_BANDS, QUIZ_COUNT } from '../lib/deckPlan';
import { SetItem, SetPage } from './StudySets';
import { KindIcon } from './Sources';
import { NOTE_PRESETS } from '../lib/prompts';

export function DeckView({ deck, notebookId, onBack, onPlay, onChanged }: {
  deck: Deck;
  notebookId: number;
  onBack: () => void;
  onPlay: (cards: Card[], title: string, practice: boolean) => void;
  onChanged: () => void;
}) {
  const [cards, setCards] = useState<Card[] | null>(null);
  const [editing, setEditing] = useState<Card | 'new' | null>(null);
  const [shuffle, setShuffle] = useState(() => loadPrefs<boolean>(SHUFFLE_KEY, true));
  useEffect(() => { savePrefs(SHUFFLE_KEY, shuffle); }, [shuffle]);

  const load = useCallback(() => { studyApi.deckCards(deck.id).then(setCards).catch(() => setCards([])); }, [deck.id]);
  useEffect(load, [load]);
  const changed = () => { load(); onChanged(); };

  const play = (list: Card[], practice = false) => onPlay(shuffle ? [...list].sort(() => Math.random() - 0.5) : list, deck.title, practice);
  const hard = (cards ?? []).filter((c) => c.lastCorrect === false);

  return (
    <SetPage
      kind="cards"
      id={deck.id}
      title={deck.title}
      count={deck.cardCount}
      best={deck.best}
      last={deck.last}
      runs={deck.runs}
      chat={<ChatButton notebookId={notebookId} where={deck.title} tag={deck.title} briefing={deckBriefing(deck.title, undefined)} />}
      actions={<>
        <label className="toggle small"><input type="checkbox" checked={shuffle} onChange={(e) => setShuffle(e.target.checked)} /><Shuffle />Shuffle</label>
        {!!hard.length && <button type="button" className="btn" onClick={() => play(hard, true)}>Practise {hard.length} missed</button>}
        <button type="button" className="btn primary" disabled={!cards?.length} onClick={() => cards && play(cards)}><Play />Play deck</button>
      </>}
      listAside={<button type="button" className="btn ghost" onClick={() => setEditing('new')}><Plus />Add card</button>}
      onBack={onBack}
      onRename={async (name) => { await studyApi.renameDeck(deck.id, name); onChanged(); }}
      onDelete={async () => { clearDeckSession(deck.id); await studyApi.deleteDeck(deck.id); onChanged(); onBack(); }}
      deleteText={<>Delete <b>{deck.title}</b> with its {deck.cardCount} cards and saved scores?</>}
      empty={cards && !cards.length ? <p className="muted pane-note">This deck is empty. Add cards by hand, or generate a new deck.</p> : undefined}
      dialogs={editing && <CardEditor card={editing === 'new' ? null : editing} deckId={deck.id} onClose={() => setEditing(null)} onSaved={changed} />}
    >
      {(cards ?? []).map((c, i) => (
        <SetItem key={c.id} n={i + 1} index={i} result={c.lastCorrect} onOpen={() => setEditing(c)}>
          <div className="set-card">
            <div className="set-card-front"><Markdown text={c.front} /></div>
            <div className="set-card-back"><Markdown text={c.back} /></div>
          </div>
        </SetItem>
      ))}
    </SetPage>
  );
}

export function CardEditor({ card, deckId, onClose, onSaved }: { card: Card | null; deckId: number; onClose: () => void; onSaved: () => void }) {
  const [front, setFront] = useState(card?.front ?? '');
  const [back, setBack] = useState(card?.back ?? '');
  const [topic, setTopic] = useState(card?.topic ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      if (card) await studyApi.updateCard(card.id, front, back, topic);
      else await studyApi.addCards(deckId, [{ front, back, topic }]);
      onSaved();
      onClose();
    } catch (e) { setError(String(e)); setBusy(false); }
  };

  return (
    <Modal title={card ? 'Edit card' : 'New card'} onClose={onClose} wide>
      <div className="card-editor">
        <div className="form">
          <label className="field"><span>Front</span><textarea className="textarea" rows={3} value={front} onChange={(e) => setFront(e.target.value)} autoFocus /></label>
          <label className="field"><span>Back</span><textarea className="textarea" rows={4} value={back} onChange={(e) => setBack(e.target.value)} /></label>
          <label className="field"><span>Topic</span><input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="e.g. Lines in space" /></label>
          <p className="muted small">Markdown and LaTeX: <code>$\vec r = \vec r_0 + t\vec v$</code>.</p>
        </div>
        <div className="card-preview">
          <div className="card-face mini"><Markdown text={front || '_front_'} /></div>
          <div className="card-face mini back"><Markdown text={back || '_back_'} /></div>
        </div>
      </div>
      {error && <div className="form-err">{error}</div>}
      <div className="modal-actions">
        {card && (
          <button type="button" className="btn ghost danger" style={{ marginRight: 'auto' }} onClick={async () => { await studyApi.deleteCard(card.id); onSaved(); onClose(); }}>
            <Trash />Delete
          </button>
        )}
        <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={busy || !front.trim() || !back.trim()} onClick={save}>{card ? 'Save' : 'Add card'}</button>
      </div>
    </Modal>
  );
}

type GenMode = 'sources' | 'topic' | 'chat';

type GenPrefs = {
  mode: GenMode;
  off: number[];
  focus: string;
  count?: number;
  instructions: string;
  size?: CardSize;
  order?: number[];
  difficulty?: Difficulty | 'mixed';
  types?: QuestionType[];
  notesOff?: number[];
  fast?: boolean;
};

const QUIZ_TYPES: { type: QuestionType; label: string }[] = [
  { type: 'mcq', label: 'Multiple choice' },
  { type: 'multi', label: 'Select all' },
  { type: 'tf', label: 'True/false' },
  { type: 'blank', label: 'Fill the gap' },
  { type: 'numeric', label: 'Numeric' },
  { type: 'short', label: 'Written' },
];

const DIFFICULTIES = [
  { value: 'mixed', label: 'Mixed' },
  { value: 'easy', label: 'Easy' },
  { value: 'medium', label: 'Medium' },
  { value: 'hard', label: 'Hard' },
];

const SHUFFLE_KEY = 'wa.decks.shuffle';

export const playOrder = <T,>(cards: T[]): T[] =>
  (loadPrefs<boolean>(SHUFFLE_KEY, true) ? [...cards].sort(() => Math.random() - 0.5) : cards);

export function loadPrefs<T>(key: string, fallback: T): T {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || 'null');
    if (saved === null || saved === undefined) return fallback;
    if (typeof fallback !== 'object' || fallback === null) return typeof saved === typeof fallback ? saved : fallback;
    return { ...fallback, ...saved };
  } catch { return fallback; }
}
export function savePrefs(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { }
}

const sizeNote = (size: CardSize, one: 'card' | 'question') => {
  const [lo, hi] = CARD_BANDS[size];
  const range = one === 'card' ? `${size === 'fewer' ? `up to ${hi}` : `${lo}–${hi}`} cards, by how long your material is` : `exactly ${QUIZ_COUNT[size]} questions`;
  return size === 'fewer'
    ? `Page by page, only what you have to know - the definitions, the key numbers, the classic features. ${range[0].toUpperCase()}${range.slice(1)}.`
    : size === 'standard'
      ? `The points worth knowing, page by page in the order of your material. ${range[0].toUpperCase()}${range.slice(1)}.`
      : `Everything Standard covers, plus ${one}s that compare, connect and apply, still in page order. ${range[0].toUpperCase()}${range.slice(1)}.`;
};

export function GenerateDialog({ kind, notebookId, sources, onClose, run, initialThread }: {
  kind: 'cards' | 'quiz' | 'notes';
  notebookId: number;
  sources: Source[];
  onClose: () => void;
  run: (src: GenSource, progress: (t: string) => void, instructions: string, options: QuizOptions & CardOptions) => Promise<unknown>;
  initialThread?: number | null;
}) {
  const key = `wa.nb.${notebookId}.gen.${kind}`;
  const [prefs] = useState(() => loadPrefs<GenPrefs>(key, { mode: 'sources', off: [], focus: '', instructions: NOTE_PRESETS[0].text }));
  const [order, setOrder] = useState<number[] | undefined>(prefs.order);
  const ready = useMemo(() => applyOrder(sources.filter((s) => s.status === 'ready'), order), [sources, order]);
  const move = (id: number, by: -1 | 1) => {
    const ids = ready.map((s) => s.id);
    const at = ids.indexOf(id);
    const to = at + by;
    if (at < 0 || to < 0 || to >= ids.length) return;
    [ids[at], ids[to]] = [ids[to], ids[at]];
    setOrder(ids);
  };
  const [instructions, setInstructions] = useState(prefs.instructions);
  const [mode, setMode] = useState<GenMode>(() => {
    if (initialThread) return 'chat';
    if (prefs.mode === 'sources' && !ready.length) return 'topic';
    return prefs.mode;
  });
  const [picked, setPicked] = useState<Set<number>>(() => new Set(ready.filter((s) => !prefs.off.includes(s.id)).map((s) => s.id)));
  const [prompt, setPrompt] = useState(prefs.mode === 'sources' ? prefs.focus : '');
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [thread, setThread] = useState<number | null>(initialThread ?? null);
  const [difficulty, setDifficulty] = useState<Difficulty | 'mixed'>(prefs.difficulty ?? 'mixed');
  const [types, setTypes] = useState<QuestionType[]>(prefs.types?.length ? prefs.types : QUIZ_TYPES.map((t) => t.type));
  const [fast, setFast] = useState(prefs.fast ?? true);
  const [size, setSize] = useState<CardSize>(prefs.size ?? 'standard');
  const [notes, setNotes] = useState<Note[]>([]);
  const [pickedNotes, setPickedNotes] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (initialThread) return;
    savePrefs(key, {
      mode, off: ready.filter((s) => !picked.has(s.id)).map((s) => s.id),
      focus: mode === 'sources' ? prompt : prefs.focus, instructions, difficulty, types, size, order, fast,
      notesOff: notes.filter((n) => !pickedNotes.has(n.id)).map((n) => n.id),
    });
  }, [key, mode, picked, prompt, instructions, difficulty, types, size, order, fast, notes, pickedNotes]);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    studyApi.chatList(notebookId).then((t) => { setThreads(t); setThread((cur) => cur ?? t[0]?.id ?? null); }).catch(() => {});
    studyApi.notes(notebookId)
      .then((list) => {
        setNotes(list);
        setPickedNotes(new Set(list.filter((n) => !(prefs.notesOff ?? []).includes(n.id)).map((n) => n.id)));
      })
      .catch(() => {});
  }, [notebookId]);

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      let src: GenSource;
      if (mode === 'sources') {
        setStatus('Reading your material…');
        const chosen = ready.filter((x) => picked.has(x.id));
        const hits = !picked.size
          ? []
          : kind !== 'notes'
            ? await wholeSources(chosen)
            : prompt.trim()
              ? await studyApi.searchSources([...picked], prompt, 24).then(async (h) => (h.length ? h : studyApi.sampleSources([...picked], 50_000)))
              : await studyApi.sampleSources([...picked], 50_000);
        const chosenNotes = await Promise.all(
          notes.filter((n) => pickedNotes.has(n.id)).map((n) => studyApi.note(n.id).catch(() => null)),
        );
        const material = chosenNotes
          .filter((n): n is Note => !!n && !!n.content.trim())
          .map((n) => ({ id: n.id, title: n.title, content: n.content }));
        if (!hits.length && !material.length) {
          throw new Error('Nothing to build from: those sources have no readable text yet, and no notes are ticked.');
        }
        src = { kind: 'sources', hits, notes: material, focus: prompt };
      } else if (mode === 'topic') src = { kind: 'topic', prompt };
      else {
        if (!thread) throw new Error('Pick a chat.');
        src = { kind: 'chat', messages: await studyApi.chatMessages(thread) };
      }
      await run(src, setStatus, instructions, { difficulty, types, size, fast });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus(null);
      setBusy(false);
    }
  };

  const modes: GenMode[] = ['sources', 'topic', 'chat'];
  const can = mode === 'sources' ? picked.size + pickedNotes.size > 0 : mode === 'topic' ? !!prompt.trim() : !!thread;
  return (
    <Modal title={kind === 'cards' ? 'Generate a flashcard deck' : kind === 'quiz' ? 'Generate a quiz' : 'Write notes'} onClose={busy ? () => {} : onClose}>
      <div className="form">
        <div className="seg" style={{ '--n': 3 } as React.CSSProperties}>
          {modes.map((m) => (
            <button type="button" key={m} className={`seg-item${mode === m ? ' on' : ''}`} onClick={() => setMode(m)}
              disabled={busy || (m === 'sources' && !ready.length) || (m === 'chat' && !threads.length)}>
              {m === 'sources' ? 'From sources' : m === 'topic' ? 'From a topic' : 'From a chat'}
            </button>
          ))}
          <span className="seg-glider" style={{ transform: `translateX(${modes.indexOf(mode) * 100}%)` }} />
        </div>

        {mode === 'sources' && (
          <>
            <label className="pick all">
              <input type="checkbox" checked={picked.size === ready.length} disabled={busy}
                onChange={(e) => setPicked(e.target.checked ? new Set(ready.map((s) => s.id)) : new Set())} />
              <span>All sources ({ready.length})</span>
            </label>
            <div className="pick-list ordered">
              {ready.map((s, i) => (
                <div key={s.id} className="pick-row">
                  <label className="pick">
                    <input type="checkbox" checked={picked.has(s.id)} disabled={busy}
                      onChange={() => setPicked((p) => { const n = new Set(p); if (n.has(s.id)) n.delete(s.id); else n.add(s.id); return n; })} />
                    {kind !== 'notes' && <span className="pick-ord mono">{i + 1}</span>}
                    <KindIcon kind={s.kind} /><span>{s.title}</span>
                  </label>
                  {kind !== 'notes' && ready.length > 1 && (
                    <span className="pick-move">
                      <button type="button" className="icon-btn ghost-icon" disabled={busy || i === 0} onClick={() => move(s.id, -1)} title="Read this earlier" aria-label={`Move ${s.title} up`}><ChevronUp /></button>
                      <button type="button" className="icon-btn ghost-icon" disabled={busy || i === ready.length - 1} onClick={() => move(s.id, 1)} title="Read this later" aria-label={`Move ${s.title} down`}><ChevronDown /></button>
                    </span>
                  )}
                </div>
              ))}
            </div>
            {kind !== 'notes' && ready.length > 1 && (
              <span className="muted small">Read in this order - by the numbers in the titles, unless you move them.</span>
            )}
            {!!notes.length && (
              <>
                <label className="pick all">
                  <input type="checkbox" checked={pickedNotes.size === notes.length} disabled={busy}
                    onChange={(e) => setPickedNotes(e.target.checked ? new Set(notes.map((n) => n.id)) : new Set())} />
                  <span>Your notes ({notes.length})</span>
                </label>
                <div className="pick-list">
                  {notes.map((n) => (
                    <label key={n.id} className="pick">
                      <input type="checkbox" checked={pickedNotes.has(n.id)} disabled={busy}
                        onChange={() => setPickedNotes((p) => { const next = new Set(p); if (next.has(n.id)) next.delete(n.id); else next.add(n.id); return next; })} />
                      <FileText /><span>{n.title}</span>
                    </label>
                  ))}
                </div>
              </>
            )}
            <label className="field">
              <span>{kind === 'notes' ? 'Focus on' : 'Instructions'} <i className="muted">optional</i></span>
              {kind === 'notes'
                ? <input value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="e.g. vector and symmetric equations of lines" disabled={busy} />
                : <textarea className="textarea" rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} disabled={busy}
                    placeholder={kind === 'quiz'
                      ? 'e.g. only the true/false questions on the last page of each past paper, with the full proofs'
                      : 'e.g. only lecture 3, one card per theorem with its proof'} />}
              {kind !== 'notes' && <span className="muted small">Followed exactly: which sources and pages to use, what kind of {kind === 'cards' ? 'cards' : 'questions'}, what the answers must include.</span>}
            </label>
          </>
        )}
        {mode === 'topic' && (
          <label className="field">
            <span>What should it cover?</span>
            <textarea className="textarea" rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} autoFocus disabled={busy}
              placeholder="e.g. Lines and planes in 3D: vector, parametric and symmetric equations; angle between planes." />
          </label>
        )}
        {mode === 'chat' && (
          <label className="field">
            <span>Chat</span>
            <Select className="field-input" value={String(thread ?? '')} onChange={(v) => setThread(Number(v))} disabled={busy}
              options={threads.map((t) => ({ value: String(t.id), label: t.title || 'Untitled chat', text: t.title || 'Untitled chat', hint: `${t.messageCount} messages` }))} />
          </label>
        )}
        {kind === 'notes' ? (
          <label className="field">
            <span>How should the notes be written?</span>
            <div className="chips">
              {NOTE_PRESETS.map((p) => (
                <button type="button" key={p.label} className={`chip-btn${instructions === p.text ? ' on' : ''}`} onClick={() => setInstructions(p.text)} disabled={busy}>{p.label}</button>
              ))}
            </div>
            <textarea className="textarea" rows={3} value={instructions} onChange={(e) => setInstructions(e.target.value)} disabled={busy}
              placeholder="e.g. one page, focus on when to use each test, include a comparison table" />
          </label>
        ) : (
          <div className="field">
            <span className="field-label">How much to cover</span>
            <div className="seg" style={{ '--n': 3 } as React.CSSProperties}>
              {(['fewer', 'standard', 'more'] as CardSize[]).map((v) => (
                <button type="button" key={v} className={`seg-item${size === v ? ' on' : ''}`} onClick={() => setSize(v)} disabled={busy}>
                  {v === 'fewer' ? 'Fewer' : v === 'standard' ? 'Standard' : 'More'}
                </button>
              ))}
              <span className="seg-glider" style={{ transform: `translateX(${['fewer', 'standard', 'more'].indexOf(size) * 100}%)` }} />
            </div>
            <span className="muted small">
              {sizeNote(size, kind === 'cards' ? 'card' : 'question')}
            </span>
          </div>
        )}
        {kind !== 'notes' && (
          <label className="toggle gen-fast">
            <input type="checkbox" checked={fast} disabled={busy} onChange={(e) => setFast(e.target.checked)} />
            <Zap />
            <span>
              Fast mode
              <span className="muted small">
                {fast
                  ? ' - bigger passes run side by side, each reading its own pages and an outline of the rest. Quicker, and a fraction of the tokens.'
                  : ' - every pass reads all of your material. Slower and several times the tokens; best when distant pages depend on each other.'}
              </span>
            </span>
          </label>
        )}
        {kind === 'cards' && (
          <label className="field narrow">
            <span>Difficulty</span>
            <Select className="field-input" value={difficulty} disabled={busy}
              onChange={(v) => setDifficulty(v as Difficulty | 'mixed')}
              options={DIFFICULTIES} />
          </label>
        )}
        {kind === 'quiz' && (
          <>
            <label className="field narrow">
              <span>Difficulty</span>
              <Select className="field-input" value={difficulty} disabled={busy}
                onChange={(v) => setDifficulty(v as Difficulty | 'mixed')}
                options={DIFFICULTIES} />
            </label>
            <div className="field">
              <span className="field-label">Question types</span>
              <div className="chips">
                {QUIZ_TYPES.map((t) => (
                  <button
                    type="button"
                    key={t.type}
                    className={`chip-btn${types.includes(t.type) ? ' on' : ''}`}
                    disabled={busy}
                    onClick={() => setTypes((cur) => (cur.includes(t.type) ? (cur.length > 1 ? cur.filter((x) => x !== t.type) : cur) : [...cur, t.type]))}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              <span className="muted small">{types.length === QUIZ_TYPES.length ? 'All of them, whichever suits each point.' : 'Only these types.'}</span>
            </div>
            <p className="muted small">Calculation questions are re-solved in Python; any whose check disagrees is thrown away and rewritten.</p>
          </>
        )}
        {status && <div className="gen-status">{busy && <span className="dots"><i /><i /><i /></span>}{status}</div>}
        {error && <div className="form-err">{error}</div>}
      </div>
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="btn primary" onClick={go} disabled={busy || !can}><Sparkles />{kind === 'notes' ? 'Write notes' : 'Generate'}</button>
      </div>
    </Modal>
  );
}

export function DeckPlayer({ deckId, cards, title, notebookId, practice: startPractice = false, onClose, onFinished }: {
  deckId: number;
  cards: Card[];
  title: string;
  notebookId: number;
  practice?: boolean;
  onClose: () => void;
  onFinished: () => void;
}) {
  const resumed = useMemo(() => {
    if (startPractice) return null;
    const saved = loadDeckSession(deckId);
    const ids = cards.map((c) => c.id);
    if (!deckSessionFits(saved, ids)) return null;
    const pruned = pruneDeckSession(saved, ids);
    const byId = new Map(cards.map((c) => [c.id, c]));
    const order = pruned.order.map((id) => byId.get(id)).filter((c): c is Card => !!c);
    return order.length ? { ...pruned, cards: order } : null;
  }, [deckId, cards, startPractice]);

  const [round, setRound] = useState<Card[]>(resumed?.cards ?? cards);
  const [practice, setPractice] = useState(startPractice);
  const [pos, setPos] = useState(resumed?.pos ?? 0);
  const [flipped, setFlipped] = useState(false);
  const [leaving, setLeaving] = useState<'left' | 'right' | null>(null);
  const [results, setResults] = useState<CardResult[]>(
    resumed ? Object.entries(resumed.results).map(([id, r]) => ({ cardId: Number(id), correct: r.correct, elapsedMs: r.elapsedMs })) : [],
  );
  const [wasResumed, setWasResumed] = useState(!!resumed && (resumed.pos > 0));
  const [asking, setAsking] = useState<Card | null>(null);
  const started = useRef(resumed?.startedAt ?? Date.now());
  const shownAt = useRef(Date.now());
  const saved = useRef(false);
  const card = round[pos];
  const done = !card;

  useEffect(() => {
    if (practice || done) return;
    saveDeckSession({
      deckId,
      startedAt: started.current,
      pos,
      order: round.map((c) => c.id),
      results: Object.fromEntries(results.map((r) => [r.cardId, { correct: r.correct, elapsedMs: r.elapsedMs }])),
    });
  }, [deckId, practice, done, pos, round, results]);

  useEffect(() => {
    if (!done || saved.current || practice || !results.length) return;
    saved.current = true;
    clearDeckSession(deckId);
    void studyApi.addDeckRun(deckId, started.current, results).then(onFinished).catch(() => {});
  }, [done, practice, results, deckId, onFinished]);

  const grade = useCallback((correct: boolean) => {
    if (!card || !flipped || leaving) return;
    setResults((r) => [...r, { cardId: card.id, correct, elapsedMs: Date.now() - shownAt.current }]);
    setLeaving(correct ? 'right' : 'left');
    window.setTimeout(() => {
      setLeaving(null);
      setFlipped(false);
      setPos((p) => p + 1);
      shownAt.current = Date.now();
    }, 240);
  }, [card, flipped, leaving]);

  const goTo = useCallback((next: number) => {
    setPos(Math.max(0, Math.min(round.length, next)));
    setFlipped(false);
    setLeaving(null);
    shownAt.current = Date.now();
  }, [round.length]);

  const restart = (list: Card[], isPractice: boolean) => {
    saved.current = false;
    started.current = Date.now();
    shownAt.current = Date.now();
    clearDeckSession(deckId);
    setPractice(isPractice);
    setRound([...list].sort(() => Math.random() - 0.5));
    setResults([]);
    setPos(0);
    setFlipped(false);
    setWasResumed(false);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('.modal')) return;
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (done) return;
      if (e.code === 'Space' || e.key === 'Enter') { e.preventDefault(); setFlipped((f) => !f); return; }
      if (e.shiftKey && e.key === 'ArrowLeft') { e.preventDefault(); goTo(pos - 1); return; }
      if (e.shiftKey && e.key === 'ArrowRight') { e.preventDefault(); goTo(pos + 1); return; }
      if (e.key === '1' || e.key === 'ArrowLeft') grade(false);
      if (e.key === '2' || e.key === 'ArrowRight') grade(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [done, grade, goTo, pos, onClose]);

  const right = results.filter((r) => r.correct).length;
  const missed = useMemo(() => round.filter((c) => results.some((r) => r.cardId === c.id && !r.correct)), [round, results]);

  return (
    <div className="stage">
      <div className="stage-head">
        <button type="button" className="link" onClick={onClose}><ArrowLeft />back</button>
        <span className="stage-title">{title}{practice ? ' · practising missed' : ''}</span>
        <span className="spacer" />
        {!done && <span className="stage-count mono">{pos + 1} / {round.length} · {right} right</span>}
        {wasResumed && !done && (
          <button type="button" className="btn ghost small" onClick={() => restart(cards, false)} title="Start the deck from the first card">
            <RotateCcw />Start again
          </button>
        )}
        <ChatButton notebookId={notebookId} where={title} tag={title} briefing={deckBriefing(title, card)} />
      </div>
      <div className="progress"><i style={{ width: `${(Math.min(pos, round.length) / Math.max(1, round.length)) * 100}%` }} /></div>
      {asking && (
        <AskAboutCard card={asking} deckTitle={title} notebookId={notebookId} onClose={() => setAsking(null)} />
      )}

      {!done ? (
        <AskableArea
          className="review-askable"
          notebookId={notebookId}
          title="This card"
          briefing={deckBriefing(title, card)}
          starters={['Explain this', 'Why is that the answer?', 'Give me an example', 'How do I remember this?']}
          target={{
            kind: 'card',
            label: title,
            detail: card.topic || 'flashcard',
            locator: { notebookId, deckId, cardId: card.id },
          }}
        >
        <div className="review">
          {card.topic && <div className="card-topic muted">{card.topic}</div>}
          <div
            role="button"
            tabIndex={0}
            key={`${card.id}-${pos}`}
            className={`flashcard${flipped ? ' flipped' : ''}${leaving ? ` leave-${leaving}` : ''}`}
            onClick={() => setFlipped((f) => !f)}
            aria-label={flipped ? 'Show the question' : 'Show the answer'}
          >
            <div className="flashcard-inner">
              <div className="card-face front"><Markdown text={card.front} /><span className="card-hint muted">click or press space to see the answer</span></div>
              <div className="card-face back"><Markdown text={card.back} /></div>
            </div>
          </div>
          <div className={`grade${flipped ? ' show' : ''}`}>
            <button type="button" className="grade-btn bad" onClick={() => grade(false)} disabled={!flipped} title="Missed it (1 or ←)">
              <span className="grade-icon"><X /></span><span>Missed it</span>
            </button>
            <button type="button" className="grade-btn good" onClick={() => grade(true)} disabled={!flipped} title="Got it (2 or →)">
              <span className="grade-icon"><Check /></span><span>Got it</span>
            </button>
          </div>
          <div className="card-actions">
            <button type="button" className="btn ghost" onClick={() => setAsking(card)}>
              <MessageCircleQuestion />Ask AI about this card
            </button>
          </div>
          <p className="muted small review-keys">
            <kbd>space</kbd> flip · <kbd>1</kbd> missed · <kbd>2</kbd> got it · <kbd>shift</kbd>+<kbd>←</kbd>/<kbd>→</kbd> move without marking · <kbd>esc</kbd> stop
          </p>
          <div className="quiz-footer">
            <button type="button" className="btn ghost nav-prev" onClick={() => goTo(pos - 1)} disabled={pos === 0}>
              <ChevronLeft />Previous
            </button>
            <span className="spacer" />
            <button type="button" className="btn ghost nav-next" onClick={() => goTo(pos + 1)} disabled={pos + 1 > round.length}>
              {pos + 1 >= round.length ? 'Skip to results' : 'Next'}<ChevronRight />
            </button>
          </div>
        </div>
        </AskableArea>
      ) : (
        <div className="summary">
          <div className="summary-score">
            <span className="summary-num">{results.length ? Math.round((right / results.length) * 100) : 0}%</span>
            <span className="muted">{right} of {results.length} right · {Math.max(1, Math.round((Date.now() - started.current) / 60_000))} min{practice ? ' · practice, not scored' : ''}</span>
          </div>
          {!!missed.length && (
            <div className="summary-missed">
              <div className="panel-title">Missed</div>
              <ul>{missed.map((c) => <li key={c.id}><Markdown text={c.front} /></li>)}</ul>
            </div>
          )}
          <div className="modal-actions">
            {!!missed.length && <button type="button" className="btn" onClick={() => restart(missed, true)}><RotateCcw />Practise missed</button>}
            <button type="button" className="btn" onClick={() => restart(cards, startPractice)}><RotateCcw />{startPractice ? 'Again' : 'Play again'}</button>
            <button type="button" className="btn primary" onClick={onClose} autoFocus>Done</button>
          </div>
        </div>
      )}
    </div>
  );
}
