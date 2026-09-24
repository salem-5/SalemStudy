import { useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { Choice } from '../types';

type Props = {
  choices: Choice[];
  value: string;
  onChange: (v: string) => void;
  inline?: boolean;
  status?: string;
  label?: string;
};

export function Combo({ choices, value, onChange, inline, status, label }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const selected = choices.find((c) => c.value === value);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return choices;
    const starts = choices.filter((c) => c.label.toLowerCase().startsWith(q));
    const words = choices.filter((c) => !starts.includes(c) && c.label.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)));
    const rest = choices.filter((c) => !starts.includes(c) && !words.includes(c) && c.label.toLowerCase().includes(q));
    return [...starts, ...words, ...rest];
  }, [choices, query]);

  const width = Math.max(8, ...choices.map((c) => c.label.length)) + 3;
  const digitsPick = !choices.some((c) => /^\d/.test(c.label)) && choices.length < 10;

  const pick = (c: Choice | undefined) => {
    if (c) onChange(c.value);
    setOpen(false);
    setQuery('');
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { setOpen(true); setActive(Math.max(0, filtered.findIndex((c) => c.value === value))); return; }
      const n = filtered.length || 1;
      setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : -1) + n) % n);
      return;
    }
    if (open && (e.key === 'Enter' || (e.key === 'Tab' && query))) {
      if (e.key === 'Enter') e.preventDefault();
      pick(filtered[active]);
      return;
    }
    if (e.key === 'Escape' && open) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      setQuery('');
      return;
    }
    if (!query && digitsPick && /^[1-9]$/.test(e.key) && Number(e.key) <= choices.length) {
      e.preventDefault();
      pick(choices[Number(e.key) - 1]);
      return;
    }
    if ((e.key === 'Backspace' || e.key === 'Delete') && !query && !open && value) {
      e.preventDefault();
      onChange('');
    }
  };

  return (
    <span className={`combo${inline ? ' inline' : ''}${open ? ' open' : ''} status-${status ?? 'none'}`}>
      <input
        ref={input}
        className="combo-input"
        size={width}
        spellCheck={false}
        aria-label={label ?? 'choice'}
        placeholder={selected ? selected.label : '- select -'}
        value={open ? query : selected?.label ?? ''}
        onFocus={() => { setOpen(true); setQuery(''); setActive(Math.max(0, choices.findIndex((c) => c.value === value))); }}
        onBlur={() => setTimeout(() => { setOpen(false); setQuery(''); }, 120)}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); setActive(0); }}
        onKeyDown={onKeyDown}
      />
      <ChevronDown className="combo-caret" aria-hidden />
      {open && (
        <ul className="combo-list" role="listbox">
          {filtered.map((c, i) => (
            <li
              key={c.value}
              role="option"
              aria-selected={c.value === value}
              className={`${i === active ? 'active' : ''}${c.value === value ? ' chosen' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); pick(c); }}
              onMouseEnter={() => setActive(i)}
            >
              {digitsPick && !query && <kbd>{choices.indexOf(c) + 1}</kbd>}
              {c.label}
            </li>
          ))}
          {!filtered.length && <li className="none">no match</li>}
        </ul>
      )}
    </span>
  );
}
