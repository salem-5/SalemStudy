import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Markdown } from '../lib/markdown';

const GAP = /_{2,}|\[ ?\.{3} ?\]|…/;
const MARK = 'QZGAPQZ';

export const hasGap = (text: string) => GAP.test(text);

export function GapPrompt({ text, className, children }: { text: string; className?: string; children: ReactNode }) {
  const host = useRef<HTMLDivElement>(null);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
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
      return () => { span.replaceWith(document.createTextNode(MARK)); setSlot(null); };
    }
    setSlot(null);
    setLost(true);
    return undefined;
  }, [marked]);

  return (
    <div className={className} ref={host}>
      <Markdown text={lost ? text : marked} />
      {slot ? createPortal(children, slot) : lost ? <div className="gap-fallback">{children}</div> : null}
    </div>
  );
}
