import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';

export type SelectOption = {
  value: string;
  label: ReactNode;
  text?: string;
  disabled?: boolean;
  hint?: ReactNode;
};

export const POPOVER_OPEN = 'data-select-open';

export function Select({ value, onChange, options, className = 'select', disabled, title, placeholder, ariaLabel, width }: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  className?: string;
  disabled?: boolean;
  title?: string;
  placeholder?: string;
  ariaLabel?: string;
  width?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<{ left: number; top: number; width: number; up: boolean; max: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: '', at: 0 });
  const id = useId();

  const current = options.find((o) => o.value === value);
  const textOf = (o: SelectOption) => o.text ?? (typeof o.label === 'string' ? o.label : String(o.value));

  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  }, []);

  const pick = (o: SelectOption | undefined) => {
    if (!o || o.disabled) return;
    if (o.value !== value) onChange(o.value);
    close();
  };

  const openList = () => {
    if (disabled || !options.length) return;
    const at = options.findIndex((o) => o.value === value);
    setActive(at >= 0 ? at : Math.max(0, options.findIndex((o) => !o.disabled)));
    setOpen(true);
  };

  const measure = useCallback(() => {
    const b = trigger.current?.getBoundingClientRect();
    if (!b) return;
    const below = window.innerHeight - b.bottom - 8;
    const above = b.top - 8;
    const want = Math.min(320, options.length * 32 + 10);
    const up = below < Math.min(want, 180) && above > below;
    setPlace({
      left: Math.max(8, Math.min(b.left, window.innerWidth - Math.max(b.width, 160) - 8)),
      top: up ? b.top - 4 : b.bottom + 4,
      width: b.width,
      up,
      max: Math.max(120, Math.min(320, up ? above : below)),
    });
  }, [options.length]);

  useLayoutEffect(() => { if (open) measure(); }, [open, measure]);

  useEffect(() => {
    if (!open) return;
    document.documentElement.setAttribute(POPOVER_OPEN, '');
    const outside = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!list.current?.contains(t) && !trigger.current?.contains(t)) close(false);
    };
    const reflow = (e: Event) => { if (!list.current?.contains(e.target as Node)) measure(); };
    const blur = () => close(false);
    window.addEventListener('mousedown', outside, true);
    window.addEventListener('scroll', reflow, true);
    window.addEventListener('resize', measure);
    window.addEventListener('blur', blur);
    return () => {
      document.documentElement.removeAttribute(POPOVER_OPEN);
      window.removeEventListener('mousedown', outside, true);
      window.removeEventListener('scroll', reflow, true);
      window.removeEventListener('resize', measure);
      window.removeEventListener('blur', blur);
    };
  }, [open, close, measure]);

  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const step = (from: number, by: 1 | -1) => {
    for (let i = 1; i <= options.length; i++) {
      const next = (from + by * i + options.length * 2) % options.length;
      if (!options[next].disabled) return next;
    }
    return from;
  };

  const jump = (key: string) => {
    const now = Date.now();
    typed.current = { text: now - typed.current.at < 700 ? typed.current.text + key.toLowerCase() : key.toLowerCase(), at: now };
    const q = typed.current.text;
    const start = open ? active : Math.max(0, options.findIndex((o) => o.value === value));
    for (let i = 0; i < options.length; i++) {
      const n = (start + (q.length === 1 ? 1 : 0) + i) % options.length;
      if (!options[n].disabled && textOf(options[n]).toLowerCase().startsWith(q)) return n;
    }
    return -1;
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); openList(); return; }
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const n = jump(e.key);
        if (n >= 0) { e.preventDefault(); onChange(options[n].value); }
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); setActive((a) => step(a, 1)); return;
      case 'ArrowUp': e.preventDefault(); setActive((a) => step(a, -1)); return;
      case 'Home': e.preventDefault(); setActive(step(-1, 1)); return;
      case 'End': e.preventDefault(); setActive(step(options.length, -1)); return;
      case 'Enter': case ' ': e.preventDefault(); pick(options[active]); return;
      case 'Escape': e.preventDefault(); e.stopPropagation(); close(); return;
      case 'Tab': close(false); return;
      default:
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          const n = jump(e.key);
          if (n >= 0) setActive(n);
        }
    }
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`${className} select-trigger${open ? ' open' : ''}`}
        style={width ? { width } : undefined}
        disabled={disabled}
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => (open ? close() : openList())}
        onKeyDown={onKeyDown}
      >
        <span className={`select-value${current ? '' : ' muted'}`}>{current ? current.label : placeholder ?? 'Choose…'}</span>
        <ChevronDown className="select-caret" aria-hidden />
      </button>
      {open && place && createPortal(
        <div
          ref={list}
          id={id}
          role="listbox"
          className={`select-pop${place.up ? ' up' : ''}`}
          style={{
            left: place.left,
            minWidth: place.width,
            maxHeight: place.max,
            ...(place.up ? { bottom: window.innerHeight - place.top } : { top: place.top }),
          }}
          onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onKeyDown={onKeyDown}
        >
          {options.map((o, i) => (
            <div
              key={o.value}
              data-index={i}
              role="option"
              aria-selected={o.value === value}
              aria-disabled={o.disabled || undefined}
              className={`select-option${i === active ? ' active' : ''}${o.value === value ? ' chosen' : ''}${o.disabled ? ' disabled' : ''}`}
              onMouseEnter={() => { if (!o.disabled) setActive(i); }}
              onClick={() => pick(o)}
            >
              <span className="select-option-text">
                <span>{o.label}</span>
                {o.hint && <span className="select-option-hint">{o.hint}</span>}
              </span>
              {o.value === value && <Check className="select-check" aria-hidden />}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
