import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Markdown } from '../lib/markdown';

/**
 * A fill-the-gap sentence with something real where the gap is.
 *
 * The question is written as Markdown with `_____` for the gap — it can hold
 * maths, bold, a term in italics — so it cannot simply be split around the
 * gap and rendered in halves. Instead the gap is swapped for a marker, the
 * whole sentence is rendered as it would be anyway, and the marker is
 * replaced by a slot the box is portalled into. Whatever the Markdown did to
 * the rest of the sentence, the box sits exactly where the gap was.
 */

/** The same gaps the generator accepts: underscores, "[...]" or an ellipsis. */
const GAP = /_{2,}|\[ ?\.{3} ?\]|…/;
const MARK = 'QZGAPQZ';

export const hasGap = (text: string) => GAP.test(text);

export function GapPrompt({ text, className, children }: { text: string; className?: string; children: ReactNode }) {
  const host = useRef<HTMLDivElement>(null);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  /** The marker did not survive the rendering (it sat inside maths, say). */
  const [lost, setLost] = useState(false);
  const marked = text.replace(GAP, MARK);

  useLayoutEffect(() => {
    const root = host.current;
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent?.indexOf(MARK) ?? -1;
      if (at < 0) continue;
      const rest = (node as Text).splitText(at);
      rest.textContent = rest.textContent!.slice(MARK.length);
      const span = document.createElement('span');
      span.className = 'gap-slot';
      rest.parentNode!.insertBefore(span, rest);
      setSlot(span);
      setLost(false);
      // Put the marker back, so a second run over the same render (React
      // does one in development) finds it again.
      return () => { span.replaceWith(document.createTextNode(MARK)); setSlot(null); };
    }
    setSlot(null);
    setLost(true);
    return undefined;
  }, [marked]);

  return (
    <div className={className} ref={host}>
      <Markdown text={lost ? text : marked} />
      {/* A sentence the marker did not survive still gets its box — under
          the sentence rather than nowhere. */}
      {slot ? createPortal(children, slot) : lost ? <div className="gap-fallback">{children}</div> : null}
    </div>
  );
}
