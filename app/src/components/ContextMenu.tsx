import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { MoreHorizontal } from 'lucide-react';

export type MenuItem =
  | { kind: 'sep' }
  | { kind: 'item'; label: string; hint?: string; icon?: ReactNode; onClick: () => void; disabled?: boolean; danger?: boolean };

export function ContextMenu({ x, y, items, onClose, align = 'left' }: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
  /** 'right' lines the menu's right edge up with x, for menus opened from a button at the end of a row. */
  align?: 'left' | 'right';
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number; origin: string } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // offsetWidth/Height, not the bounding box: the pop-in animation scales the menu while this runs.
    const r = { width: el.offsetWidth, height: el.offsetHeight };
    const wantX = align === 'right' ? x - r.width : x;
    const left = Math.max(8, Math.min(wantX, window.innerWidth - r.width - 8));
    const flipUp = y + r.height > window.innerHeight - 8 && y - r.height > 8;
    const top = flipUp ? y - r.height : Math.min(y, window.innerHeight - r.height - 8);
    setPos({ x: left, y: top, origin: `${flipUp ? 'bottom' : 'top'} ${align === 'right' ? 'right' : 'left'}` });
  }, [x, y, items, align]);

  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', close);
    };
  }, [onClose]);

  // Portalled to the body, so a hovered card that lifts with a transform cannot become the
  // box the menu's fixed position is measured from and carry it off somewhere else.
  return createPortal(
    <div
      ref={ref}
      className="ctx-menu"
      role="menu"
      style={{ left: pos?.x ?? x, top: pos?.y ?? y, transformOrigin: pos?.origin, visibility: pos ? 'visible' : 'hidden' }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) => it.kind === 'sep'
        ? <div key={i} className="ctx-sep" role="separator" />
        : (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={`ctx-item${it.danger ? ' danger' : ''}`}
            disabled={it.disabled}
            onClick={() => { onClose(); it.onClick(); }}
          >
            <span className="ctx-label">{it.icon && <span className="ctx-icon">{it.icon}</span>}{it.label}</span>
            {it.hint && <kbd>{it.hint}</kbd>}
          </button>
        ))}
    </div>,
    document.body,
  );
}

/** A "…" button that opens a menu below itself, right-aligned. For actions that do not need to be one click away. */
export function MoreMenu({ items, title = 'More', className = '' }: { items: MenuItem[]; title?: string; className?: string }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  return (
    <>
      <button
        type="button"
        className={`icon-btn${at ? ' on' : ''} ${className}`}
        title={title}
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={!!at}
        onMouseDown={(e) => { if (at) e.stopPropagation(); }}
        onClick={(e) => {
          if (at) { setAt(null); return; }
          const r = e.currentTarget.getBoundingClientRect();
          setAt({ x: r.right, y: r.bottom + 6 });
        }}
      >
        <MoreHorizontal />
      </button>
      {at && <ContextMenu x={at.x} y={at.y} items={items} align="right" onClose={() => setAt(null)} />}
    </>
  );
}
