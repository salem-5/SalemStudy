import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, MessageCircleQuestion } from 'lucide-react';
import { makeReference, type Reference, type ReferenceKind } from '../lib/reference';

export type SelectionTarget = {
  kind: ReferenceKind;
  label: string;
  detail?: string;
  locator: Reference['locator'];
};

type Menu = { x: number; y: number; text: string };

export function SelectionMenu({ scope, target, onAsk }: {
  scope: React.RefObject<HTMLElement | null>;
  target?: SelectionTarget | ((node: Node) => SelectionTarget | undefined);
  onAsk?: (reference: Reference) => void;
}) {
  const [menu, setMenu] = useState<Menu | null>(null);
  const [copied, setCopied] = useState(false);
  const pending = useRef<SelectionTarget | undefined>(undefined);

  const close = useCallback(() => { setMenu(null); setCopied(false); }, []);

  useEffect(() => {
    const host = scope.current;
    if (!host) return;

    const onContext = (e: MouseEvent) => {
      const selection = window.getSelection();
      const text = selection?.toString().trim() ?? '';
      if (!text || !selection?.anchorNode || !host.contains(selection.anchorNode)) return;
      e.preventDefault();
      e.stopPropagation();
      pending.current = typeof target === 'function' ? target(selection.anchorNode) : target;
      setCopied(false);
      setMenu({ x: e.clientX, y: e.clientY, text });
    };

    host.addEventListener('contextmenu', onContext);
    return () => host.removeEventListener('contextmenu', onContext);
  }, [scope, target]);

  useEffect(() => {
    if (!menu) return;
    const dismiss = (e: Event) => {
      if (e.target instanceof HTMLElement && e.target.closest('.selection-menu')) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('pointerdown', dismiss, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('pointerdown', dismiss, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
    };
  }, [menu, close]);

  if (!menu) return null;

  const slot = pending.current;
  const x = Math.min(menu.x, window.innerWidth - 230);
  const y = Math.min(menu.y, window.innerHeight - 110);

  return (
    <div className="selection-menu" style={{ left: x, top: y }} role="menu">
      <div className="selection-quote">“{menu.text.length > 90 ? `${menu.text.slice(0, 90)}…` : menu.text}”</div>
      <button
        type="button"
        className="selection-item"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(menu.text);
            setCopied(true);
            window.setTimeout(close, 700);
          } catch {
            close();
          }
        }}
      >
        {copied ? <Check /> : <Copy />}{copied ? 'Copied' : 'Copy'}
      </button>
      {slot && onAsk && (
        <button
          type="button"
          className="selection-item"
          onClick={() => {
            onAsk(makeReference(slot.kind, slot.label, menu.text, slot.locator, slot.detail));
            window.getSelection()?.removeAllRanges();
            close();
          }}
        >
          <MessageCircleQuestion />Ask AI about this
        </button>
      )}
    </div>
  );
}
