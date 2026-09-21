import { useEffect, useMemo, useRef, useState } from 'react';
import { FileText, Layers, Loader2, MessageSquare, NotebookPen, Search } from 'lucide-react';
import { studyApi, type Found, type SubjectNode } from '../study/api';
import type { Route } from '../study/pages';

const KIND_LABEL: Record<Found['kind'], string> = { source: 'Sources', note: 'Notes', card: 'Flashcards', chat: 'Chats' };
const KIND_ICON = { source: FileText, note: NotebookPen, card: Layers, chat: MessageSquare } as const;

/** Where a search result lives, as a route. */
export function routeFor(f: Found): Route {
  if (f.kind === 'chat' && f.notebookId === null) return { kind: 'chat', id: f.id };
  const id = f.notebookId!;
  if (f.kind === 'source') return { kind: 'notebook', id, open: { type: 'source', id: f.id, unit: f.target ?? undefined } };
  if (f.kind === 'note') return { kind: 'notebook', id, open: { type: 'note', id: f.id } };
  if (f.kind === 'card') return { kind: 'notebook', id, open: { type: 'deck', id: f.target ?? 0 } };
  return { kind: 'notebook', id, open: { type: 'chat', id: f.id } };
}

/** ⌘K: one search over every notebook's sources, notes, cards and chats. */
export function SearchPalette({ tree, onClose, open }: { tree: SubjectNode[]; onClose: () => void; open: (r: Route) => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Found[]>([]);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const where = useMemo(() => {
    const m = new Map<number, string>();
    for (const s of tree) for (const n of s.notebooks) m.set(n.id, `${s.name} / ${n.name}`);
    return m;
  }, [tree]);

  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    if (query.trim().length < 2) { setResults([]); return; }
    setBusy(true);
    const t = window.setTimeout(() => {
      studyApi.searchEverything(query).then((r) => { setResults(r); setActive(0); }).catch(() => setResults([])).finally(() => setBusy(false));
    }, 180);
    return () => window.clearTimeout(t);
  }, [query]);

  const go = (f: Found) => { open(routeFor(f)); onClose(); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(results.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === 'Enter' && results[active]) { e.preventDefault(); go(results[active]); }
  };

  // Keep result order, but show a heading where the kind changes.
  let lastKind: string | null = null;
  return (
    <div className="modal-backdrop cmdk-backdrop" onMouseDown={onClose}>
      <div className="cmdk" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <div className="cmdk-input">
          <Search />
          <input ref={input} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search sources, notes, flashcards and chats in every notebook" />
          {busy && <Loader2 className="spin" />}
          <kbd>esc</kbd>
        </div>
        <div className="cmdk-results">
          {query.trim().length >= 2 && !busy && !results.length && <p className="muted cmdk-empty">Nothing found for “{query}”.</p>}
          {query.trim().length < 2 && <p className="muted cmdk-empty">Type at least two characters. Enter opens the highlighted result.</p>}
          {results.map((f, i) => {
            const Icon = KIND_ICON[f.kind];
            const head = f.kind !== lastKind ? KIND_LABEL[f.kind] : null;
            lastKind = f.kind;
            return (
              <div key={`${f.kind}-${f.id}-${i}`}>
                {head && <div className="cmdk-group">{head}</div>}
                <button type="button" className={`cmdk-row${i === active ? ' on' : ''}`} onMouseEnter={() => setActive(i)} onClick={() => go(f)}>
                  <Icon className="cmdk-icon" />
                  <span className="cmdk-text">
                    <span className="cmdk-title">{f.title}{f.detail && <span className="muted"> · {f.detail}</span>}</span>
                    <span className="cmdk-snippet search-hit-text">{renderSnippet(f.snippet)}</span>
                  </span>
                  <span className="cmdk-where muted">{f.notebookId ? where.get(f.notebookId) : 'Chat'}</span>
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Full-text snippets mark matches as [word]; show those highlighted. */
function renderSnippet(s: string) {
  return s.split(/(\[[^\]]+\])/g).map((part, i) => (/^\[[^\]]+\]$/.test(part) ? <mark key={i}>{part.slice(1, -1)}</mark> : part));
}
