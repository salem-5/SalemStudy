import { useContext, useEffect, useState, type ReactNode } from 'react';
import { MessageSquare, NotebookPen, PenLine, RotateCcw } from 'lucide-react';
import { asOrigin, citeCounts, citedOrigin, coverage, type OriginSource } from '../lib/origin';
import { studyApi, type QuestionSource, type Source } from './api';
import { KindIcon, OpenSourceContext } from './Sources';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const clip = (text: string, max = 140) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/**
 * What a deck, quiz or note was made from: each source with the pages that were read, the notes
 * it was given, or the topic or chat it came from. One saved before that was kept falls back to
 * the sources its cards or questions cite.
 */
export function MadeFrom({ origin, cited = [], notebookId, items, className = '' }: {
  origin: unknown;
  cited?: (QuestionSource[] | null | undefined)[];
  notebookId: number;
  /** What the items are called, to say how many come from each source; left out for a note. */
  items?: [one: string, many: string];
  className?: string;
}) {
  const open = useContext(OpenSourceContext);
  const [live, setLive] = useState<Source[] | null>(null);
  useEffect(() => {
    let alive = true;
    studyApi.sources(notebookId).then((s) => { if (alive) setLive(s); }).catch(() => { if (alive) setLive([]); });
    return () => { alive = false; };
  }, [notebookId]);

  const recorded = asOrigin(origin);
  const shown = recorded ?? citedOrigin(cited);
  if (!shown) return null;
  if (shown.kind === 'sources' && !shown.sources.length && !shown.notes.length) return null;
  const counts = items ? citeCounts(cited) : null;

  const sourceChip = (o: OriginSource) => {
    const now = live?.find((s) => s.id === o.sourceId);
    const gone = live !== null && !now;
    const kind = now?.kind ?? o.kind;
    const n = counts?.get(o.sourceId) ?? 0;
    const meta = [
      coverage(o.units, kind, now?.unitCount),
      items && n ? plural(n, items[0], items[1]) : '',
      gone ? 'removed from the notebook' : '',
    ].filter(Boolean).join(' · ');
    return (
      <button type="button" key={o.sourceId} className="made-chip" disabled={!open || gone}
        title={gone ? 'This source has since been removed' : 'Open this source beside you'}
        onClick={() => open?.(o.sourceId, o.units[0]?.[0] ?? 0)}>
        <span className={`source-kind ${kind}`}><KindIcon kind={kind} /></span>
        <span className="made-chip-text">
          <span className="made-chip-title">{now?.title ?? o.title}</span>
          {meta && <span className="made-chip-meta">{meta}</span>}
        </span>
      </button>
    );
  };

  const plain = (key: string, icon: ReactNode, title: string, meta?: string) => (
    <span key={key} className="made-chip static">
      <span className="source-kind">{icon}</span>
      <span className="made-chip-text">
        <span className="made-chip-title">{title}</span>
        {meta && <span className="made-chip-meta">{meta}</span>}
      </span>
    </span>
  );

  return (
    <section className={`made-from ${className}`} aria-label={recorded ? 'Made from' : 'Sources cited'}>
      <span className="made-from-label" title={recorded ? undefined : 'Made before the app kept a record of this, so these are the sources its items cite'}>
        {recorded ? 'Made from' : 'Cites'}
      </span>
      <div className="made-chips">
        {shown.kind === 'sources' && <>
          {shown.sources.map(sourceChip)}
          {shown.notes.map((n) => {
            const k = counts?.get(-n.id) ?? 0;
            return plain(`note-${n.id}`, <NotebookPen />, n.title || 'Untitled note', ['your note', items && k ? plural(k, items[0], items[1]) : ''].filter(Boolean).join(' · '));
          })}
        </>}
        {shown.kind === 'topic' && plain('topic', <PenLine />, clip(shown.prompt) || 'A topic you described', 'a topic you described, no sources')}
        {shown.kind === 'chat' && plain('chat', <MessageSquare />, shown.title || 'A chat', plural(shown.messages, 'message', 'messages'))}
        {shown.kind === 'mistakes' && plain('mistakes', <RotateCcw />, plural(shown.count, 'question you got wrong', 'questions you got wrong'), shown.quiz ? `in ${shown.quiz}` : undefined)}
      </div>
      {shown.kind === 'sources' && shown.focus && <p className="made-from-focus">Your instructions: “{clip(shown.focus, 240)}”</p>}
    </section>
  );
}
