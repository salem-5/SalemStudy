import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, Check, Layers, MoreHorizontal, Pencil, Play, Plus, RotateCcw, Shuffle, Sparkles, Trash, X,
} from 'lucide-react';
import { Modal } from '../components/Dialogs';
import { ContextMenu, type MenuItem } from '../components/ContextMenu';
import { Markdown } from '../lib/markdown';
import { generateCards, type GenSource, type StudyContext } from '../lib/studyGen';
import { studyApi, type Card, type CardResult, type ChatThread, type Deck, type Source } from './api';
import { ConfirmDialog, NameDialog } from './dialogs';
import { KindIcon } from './Sources';
import { NOTE_PRESETS } from '../lib/prompts';

const pct = (v: number | null) => (v === null ? '–' : `${Math.round(v * 100)}%`);

// ----------------------------------------------------------------- pane

/** The notebook's decks: each a named set you replay for a score. */
export function DecksPane({ decks, onOpen, onPlay, onGenerate, onNew, onChanged }: {
  decks: Deck[];
  onOpen: (d: Deck) => void;
  onPlay: (d: Deck) => void;
  onGenerate: () => void;
  onNew: () => void;
  onChanged: () => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [renaming, setRenaming] = useState<Deck | null>(null);
  const [removing, setRemoving] = useState<Deck | null>(null);
  const menuFor = (d: Deck): MenuItem[] => [
    { kind: 'item', label: 'Play', onClick: () => onPlay(d), disabled: !d.cardCount },
    { kind: 'item', label: 'Open', onClick: () => onOpen(d) },
    { kind: 'item', label: 'Rename…', onClick: () => setRenaming(d) },
    { kind: 'sep' },
    { kind: 'item', label: 'Delete deck', danger: true, onClick: () => setRemoving(d) },
  ];

  return (
    <div className="pane-body">
      <div className="pane-actions">
        <button type="button" className="btn primary" onClick={onGenerate}><Sparkles />Generate deck</button>
        <button type="button" className="btn ghost" onClick={onNew} title="Empty deck you fill yourself"><Plus />New</button>
      </div>
      {!decks.length && <p className="muted small pane-note">No decks yet. Generate one from your sources, a topic or a chat; it is saved here to replay as often as you like.</p>}
      <ul className="deck-list stagger">
        {decks.map((d, i) => (
          <li key={d.id} style={{ '--i': i } as React.CSSProperties} className="deck-item"
            onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, items: menuFor(d) }); }}>
            <button type="button" className="deck-main" onClick={() => onOpen(d)}>
              <span className="deck-icon"><Layers /></span>
              <span className="deck-text">
                <span className="deck-title">{d.title}</span>
                <span className="deck-meta">{d.cardCount} card{d.cardCount === 1 ? '' : 's'} · {d.runs ? `best ${pct(d.best)} · last ${pct(d.last)}` : 'not played yet'}</span>
              </span>
            </button>
            <button type="button" className="icon-btn deck-play" onClick={() => onPlay(d)} disabled={!d.cardCount} title="Play"><Play /></button>
            <button type="button" className="icon-btn ghost-icon" onClick={(e) => setMenu({ x: e.clientX, y: e.clientY, items: menuFor(d) })} title="More"><MoreHorizontal /></button>
          </li>
        ))}
      </ul>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {renaming && (
        <NameDialog title="Rename deck" label="Name" initial={renaming.title} submitLabel="Save" onClose={() => setRenaming(null)}
          onSubmit={async (name) => { await studyApi.renameDeck(renaming.id, name); onChanged(); }} />
      )}
      {removing && (
        <ConfirmDialog title="Delete deck" confirmLabel="Delete deck" onClose={() => setRemoving(null)}
          onConfirm={async () => { await studyApi.deleteDeck(removing.id); onChanged(); }}>
          Delete <b>{removing.title}</b> with its {removing.cardCount} cards and {removing.runs} saved scores?
        </ConfirmDialog>
      )}
    </div>
  );
}

// ------------------------------------------------------------ deck view

/** One deck: play it, see its scores, and edit its cards. */
export function DeckView({ deck, onBack, onPlay, onChanged }: {
  deck: Deck;
  onBack: () => void;
  /** `practice` runs (missed cards only) are not saved as scores. */
  onPlay: (cards: Card[], title: string, practice: boolean) => void;
  onChanged: () => void;
}) {
  const [cards, setCards] = useState<Card[] | null>(null);
  const [editing, setEditing] = useState<Card | 'new' | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [shuffle, setShuffle] = useState(true);

  const load = useCallback(() => { studyApi.deckCards(deck.id).then(setCards).catch(() => setCards([])); }, [deck.id]);
  useEffect(load, [load]);
  const changed = () => { load(); onChanged(); };

  const play = (list: Card[], practice = false) => onPlay(shuffle ? [...list].sort(() => Math.random() - 0.5) : list, deck.title, practice);
  const hard = (cards ?? []).filter((c) => c.lastCorrect === false);

  return (
    <div className="stage deck-view">
      <div className="stage-head">
        <button type="button" className="link" onClick={onBack}><ArrowLeft />back</button>
        <span className="stage-title">{deck.title}</span>
        <button type="button" className="icon-btn ghost-icon" onClick={() => setRenaming(true)} title="Rename"><Pencil /></button>
        <span className="spacer" />
        <button type="button" className="icon-btn ghost-icon danger" onClick={() => setRemoving(true)} title="Delete deck"><Trash /></button>
      </div>
      <div className="deck-body">
        <div className="deck-hero">
          <div className="deck-scores">
            <div><span className="deck-num">{deck.cardCount}</span><span className="muted">cards</span></div>
            <div><span className="deck-num">{pct(deck.best)}</span><span className="muted">best</span></div>
            <div><span className="deck-num">{pct(deck.last)}</span><span className="muted">last · {deck.runs} play{deck.runs === 1 ? '' : 's'}</span></div>
          </div>
          <div className="deck-actions">
            <label className="toggle small"><input type="checkbox" checked={shuffle} onChange={(e) => setShuffle(e.target.checked)} /><Shuffle />Shuffle</label>
            {!!hard.length && <button type="button" className="btn" onClick={() => play(hard, true)}>Practise {hard.length} missed</button>}
            <button type="button" className="btn primary" disabled={!cards?.length} onClick={() => cards && play(cards)}><Play />Play deck</button>
          </div>
        </div>
        <div className="deck-cards-head">
          <span className="panel-title">Cards</span>
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={() => setEditing('new')}><Plus />Add card</button>
        </div>
        <ul className="deck-cards stagger">
          {(cards ?? []).map((c, i) => (
            <li key={c.id} className="deck-card" style={{ '--i': i } as React.CSSProperties}>
              <div role="button" tabIndex={0} className="deck-card-main" onClick={() => setEditing(c)}
                onKeyDown={(e) => { if (e.key === 'Enter') setEditing(c); }} title="Edit card">
                <div className="deck-card-front"><Markdown text={c.front} /></div>
                <div className="deck-card-back"><Markdown text={c.back} /></div>
              </div>
              <span className={`deck-card-stat${c.lastCorrect === false ? ' bad' : c.lastCorrect ? ' good' : ''}`} title={`${c.reviews} answered, ${c.misses} missed`}>
                {c.lastCorrect === null ? '' : c.lastCorrect ? <Check /> : <X />}
              </span>
            </li>
          ))}
        </ul>
        {cards && !cards.length && <p className="muted pane-note">This deck is empty. Add cards by hand, or generate a new deck.</p>}
      </div>
      {editing && <CardEditor card={editing === 'new' ? null : editing} deckId={deck.id} onClose={() => setEditing(null)} onSaved={changed} />}
      {renaming && (
        <NameDialog title="Rename deck" label="Name" initial={deck.title} submitLabel="Save" onClose={() => setRenaming(false)}
          onSubmit={async (name) => { await studyApi.renameDeck(deck.id, name); onChanged(); }} />
      )}
      {removing && (
        <ConfirmDialog title="Delete deck" confirmLabel="Delete deck" onClose={() => setRemoving(false)}
          onConfirm={async () => { await studyApi.deleteDeck(deck.id); onChanged(); onBack(); }}>
          Delete <b>{deck.title}</b> with its cards and saved scores?
        </ConfirmDialog>
      )}
    </div>
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

// -------------------------------------------------------------- generate

type GenMode = 'sources' | 'topic' | 'chat';

/** What the dialog remembers per notebook and kind. Sources are stored as the
 *  ones switched off, so every source (including new ones) starts ticked. */
type GenPrefs = { mode: GenMode; off: number[]; focus: string; count: number; instructions: string };

export function loadPrefs<T>(key: string, fallback: T): T {
  try { return { ...fallback, ...(JSON.parse(localStorage.getItem(key) || 'null') ?? {}) }; } catch { return fallback; }
}
export function savePrefs(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}

/** Shared by decks, quizzes and notes: pick what to build from, and how many items (or, for notes, how). */
export function GenerateDialog({ kind, notebookId, sources, onClose, run, initialThread }: {
  kind: 'cards' | 'quiz' | 'notes';
  notebookId: number;
  sources: Source[];
  onClose: () => void;
  run: (src: GenSource, count: number, progress: (t: string) => void, instructions: string) => Promise<string>;
  initialThread?: number | null;
}) {
  const ready = sources.filter((s) => s.status === 'ready');
  const key = `wa.nb.${notebookId}.gen.${kind}`;
  const [prefs] = useState(() => loadPrefs<GenPrefs>(key, { mode: 'sources', off: [], focus: '', count: kind === 'cards' ? 15 : 8, instructions: NOTE_PRESETS[0].text }));
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
  const [count, setCount] = useState(prefs.count);

  // Remember the choices for next time (not the chat mode opened from a chat).
  useEffect(() => {
    if (initialThread) return;
    savePrefs(key, { mode, off: ready.filter((s) => !picked.has(s.id)).map((s) => s.id), focus: mode === 'sources' ? prompt : prefs.focus, count, instructions });
  }, [key, mode, picked, prompt, count, instructions]); // eslint-disable-line react-hooks/exhaustive-deps
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    studyApi.chatList(notebookId).then((t) => { setThreads(t); setThread((cur) => cur ?? t[0]?.id ?? null); }).catch(() => {});
  }, [notebookId]);

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      let src: GenSource;
      if (mode === 'sources') {
        setStatus('Reading your sources…');
        const hits = prompt.trim()
          ? await studyApi.searchSources([...picked], prompt, 24).then(async (h) => (h.length ? h : studyApi.sampleSources([...picked], 50_000)))
          : await studyApi.sampleSources([...picked], 50_000);
        if (!hits.length) throw new Error('Those sources have no readable text yet.');
        src = { kind: 'sources', hits, focus: prompt };
      } else if (mode === 'topic') src = { kind: 'topic', prompt };
      else {
        if (!thread) throw new Error('Pick a chat.');
        src = { kind: 'chat', messages: await studyApi.chatMessages(thread) };
      }
      setStatus(await run(src, count, setStatus, instructions));
      setTimeout(onClose, 700);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus(null);
      setBusy(false);
    }
  };

  const modes: GenMode[] = ['sources', 'topic', 'chat'];
  const can = mode === 'sources' ? picked.size > 0 : mode === 'topic' ? !!prompt.trim() : !!thread;
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
            <div className="pick-list">
              {ready.map((s) => (
                <label key={s.id} className="pick">
                  <input type="checkbox" checked={picked.has(s.id)} disabled={busy}
                    onChange={() => setPicked((p) => { const n = new Set(p); if (n.has(s.id)) n.delete(s.id); else n.add(s.id); return n; })} />
                  <KindIcon kind={s.kind} /><span>{s.title}</span>
                </label>
              ))}
            </div>
            <label className="field">
              <span>Focus on <i className="muted">optional</i></span>
              <input value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="e.g. vector and symmetric equations of lines" disabled={busy} />
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
            <select className="select" value={thread ?? ''} onChange={(e) => setThread(Number(e.target.value))} disabled={busy}>
              {threads.map((t) => <option key={t.id} value={t.id}>{t.title || 'Untitled chat'} · {t.messageCount} messages</option>)}
            </select>
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
          <label className="field narrow">
            <span>How many {kind === 'cards' ? 'cards' : 'questions'}</span>
            <input type="number" min={1} max={40} value={count} onChange={(e) => setCount(Math.max(1, Math.min(40, Number(e.target.value) || 1)))} disabled={busy} />
          </label>
        )}
        {kind === 'quiz' && <p className="muted small">Calculation questions are re-solved in Python; any whose check disagrees is thrown away and rewritten.</p>}
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

/** Generate a deck (the model also names it) and save it. Returns the new deck's id. */
export async function generateDeck(ctx: StudyContext, notebookId: number, src: GenSource, count: number, progress: (t: string) => void): Promise<{ id: number; message: string }> {
  progress(`Writing ${count} cards…`);
  const { title, cards } = await generateCards(ctx, src, count, []);
  const refs = src.kind === 'sources' ? [...new Map(src.hits.map((h) => [h.sourceId, { sourceId: h.sourceId, title: h.sourceTitle }])).values()] : null;
  const id = await studyApi.createDeck(notebookId, title, cards.map((c) => ({ ...c, sourceRefs: refs })));
  return { id, message: `Saved “${title}” with ${cards.length} card${cards.length === 1 ? '' : 's'}.` };
}

// ---------------------------------------------------------------- player

/**
 * Play a deck: one card at a time, click or Space flips it, then ✗ / ✓
 * (1 / 2, ← / →). At the end: the score, what was missed, play again.
 */
export function DeckPlayer({ deckId, cards, title, practice: startPractice = false, onClose, onFinished }: {
  deckId: number;
  cards: Card[];
  title: string;
  practice?: boolean;
  onClose: () => void;
  onFinished: () => void;
}) {
  const [round, setRound] = useState<Card[]>(cards);
  const [practice, setPractice] = useState(startPractice);
  const [pos, setPos] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [leaving, setLeaving] = useState<'left' | 'right' | null>(null);
  const [results, setResults] = useState<CardResult[]>([]);
  const started = useRef(Date.now());
  const shownAt = useRef(Date.now());
  const saved = useRef(false);
  const card = round[pos];
  const done = !card;

  useEffect(() => {
    if (!done || saved.current || practice || !results.length) return;
    saved.current = true;
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

  const restart = (list: Card[], isPractice: boolean) => {
    saved.current = false;
    started.current = Date.now();
    shownAt.current = Date.now();
    setPractice(isPractice);
    setRound([...list].sort(() => Math.random() - 0.5));
    setResults([]);
    setPos(0);
    setFlipped(false);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('.modal')) return;
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (done) return;
      if (e.code === 'Space' || e.key === 'Enter') { e.preventDefault(); setFlipped((f) => !f); return; }
      if (e.key === '1' || e.key === 'ArrowLeft') grade(false);
      if (e.key === '2' || e.key === 'ArrowRight') grade(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [done, grade, onClose]);

  const right = results.filter((r) => r.correct).length;
  const missed = useMemo(() => round.filter((c) => results.some((r) => r.cardId === c.id && !r.correct)), [round, results]);

  return (
    <div className="stage">
      <div className="stage-head">
        <button type="button" className="link" onClick={onClose}><ArrowLeft />back</button>
        <span className="stage-title">{title}{practice ? ' · practising missed' : ''}</span>
        <span className="spacer" />
        {!done && <span className="stage-count mono">{pos + 1} / {round.length} · {right} right</span>}
      </div>
      <div className="progress"><i style={{ width: `${(Math.min(pos, round.length) / Math.max(1, round.length)) * 100}%` }} /></div>

      {!done ? (
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
          <p className="muted small review-keys"><kbd>space</kbd> flip · <kbd>1</kbd> missed · <kbd>2</kbd> got it · <kbd>esc</kbd> stop</p>
        </div>
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
