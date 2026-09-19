import { useCallback, useEffect, useState } from 'react';
import type { Box, Draft } from '../types';
import { canonical, canonicalMathML, mathValueText } from './render';

const KEY = 'wa.drafts.v1';

export const draftKey = (dep: number, q: number, box: number) => `${dep}:${q}:${box}`;

const isEmptyMath = (mathml: string) => !mathml || /^<math[^>]*\/>$/.test(mathml.trim()) || mathValueText(mathml) === '';

/** The draft that represents what WebAssign currently has saved for a box. */
export function serverDraft(box: Box): Draft {
  switch (box.kind) {
    case 'math':
      // `box.text` can hold a recovered static answer; fall back to the value's
      // visible text when the parser can't produce pad syntax.
      return isEmptyMath(box.value) ? (box.text || '') : (box.text || mathValueText(box.value));
    case 'checkboxes':
      return box.value ? box.value.split(',') : [];
    case 'multiselect':
      return box.value.split(',');
    default:
      return box.value;
  }
}

/** True when the draft is what the server already has. */
export function matchesServer(box: Box, draft: Draft): boolean {
  if (box.kind === 'math') {
    const d = canonical(String(draft));
    if (d === null) return false;
    if (isEmptyMath(box.value)) return d === '' || (!!box.text && d === canonical(box.text));
    const serverText = mathValueText(box.value);
    const server = canonicalMathML(box.value) || canonical(serverText);
    return server ? d === server : String(draft).trim() === serverText;
  }
  if (Array.isArray(draft)) {
    const server = serverDraft(box) as string[];
    return box.kind === 'checkboxes'
      ? [...draft].sort().join(',') === [...server].sort().join(',')
      : draft.join(',') === server.join(',');
  }
  return String(draft).trim() === String(box.value).trim();
}

export const isEmptyDraft = (d: Draft) => (Array.isArray(d) ? d.every((x) => !x) : !d.trim());

function load(): Record<string, Draft> {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch {
    return {};
  }
}

/** Local drafts survive restarts; they are dropped once they match the server. */
export function useDrafts() {
  const [map, setMap] = useState<Record<string, Draft>>(load);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(map));
    } catch {
      /* storage full or blocked: drafts stay in memory */
    }
  }, [map]);

  const set = useCallback((key: string, value: Draft) => setMap((m) => ({ ...m, [key]: value })), []);
  const clear = useCallback((keys: string[]) => setMap((m) => {
    const next = { ...m };
    keys.forEach((k) => delete next[k]);
    return next;
  }), []);

  return { map, set, clear };
}

const HISTORY_KEY = 'wa.mathHistory.v1';

export function loadHistory(): string[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  } catch {
    return [];
  }
}

export function pushHistory(exprs: string[]) {
  const list = [...exprs.filter((e) => e.trim()), ...loadHistory()];
  const unique = list.filter((e, i) => list.indexOf(e) === i).slice(0, 60);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(unique));
  } catch {
    /* ignore */
  }
}
