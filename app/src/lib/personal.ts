import { useSyncExternalStore } from 'react';
import { fmtClock, pomodoroState, remainingOf } from './pomodoro';
import type { SubjectNode } from '../study/api';

export type Tone = 'default' | 'concise' | 'detailed' | 'tutor' | 'friendly';

export type Personal = {
  about: string;
  instructions: string;
  tone: Tone;
  think: boolean;
  memory: boolean;
};

export const TONES: { tone: Tone; label: string; hint: string; prompt: string }[] = [
  { tone: 'default', label: 'Default', hint: 'Balanced, adapts to the question', prompt: '' },
  { tone: 'concise', label: 'Concise', hint: 'Short and to the point', prompt: 'The student prefers short answers: give the answer and only the explanation needed to trust it. No extra sections.' },
  { tone: 'detailed', label: 'Detailed', hint: 'Thorough explanations', prompt: 'The student prefers thorough answers: explain the reasoning fully, include the intuition, a worked example and common pitfalls.' },
  { tone: 'tutor', label: 'Tutor', hint: 'Guides you to the answer', prompt: 'Act as a Socratic tutor for problems the student is solving: give hints and ask one guiding question at a time instead of the full solution, unless they ask for the answer outright. Direct factual questions still get direct answers.' },
  { tone: 'friendly', label: 'Friendly', hint: 'Warm and encouraging', prompt: 'Be warm and encouraging, like a friendly older student; keep the explanations just as correct.' },
];

const KEY = 'wa.chat.personal';
const DEFAULTS: Personal = { about: '', instructions: '', tone: 'default', think: false, memory: true };
const listeners = new Set<() => void>();
let cache: Personal | null = null;

export function personal(): Personal {
  if (cache) return cache;
  try { cache = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { cache = { ...DEFAULTS }; }
  return cache!;
}

export function setPersonal(patch: Partial<Personal>) {
  cache = { ...personal(), ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { }
  listeners.forEach((l) => l());
}

const onShared = (keys: string[], fn: () => void) => {
  if (typeof window === 'undefined') return;
  window.addEventListener('wa:prefs', (e) => {
    if (keys.includes((e as CustomEvent<{ key: string }>).detail?.key)) fn();
  });
};
onShared([KEY], () => { cache = null; listeners.forEach((l) => l()); });

export const usePersonal = () => useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, personal);

export function personalPrompt(p: Personal = personal()): string {
  const parts: string[] = [];
  if (p.about.trim()) parts.push(`## About the student\n${p.about.trim()}`);
  const tone = TONES.find((t) => t.tone === p.tone)?.prompt;
  const how = [tone, p.instructions.trim()].filter(Boolean).join('\n');
  if (how) parts.push(`## How they want you to respond\nFollow this over the defaults above:\n${how}`);
  return parts.join('\n\n');
}

export function memoryPrompt(items: { id: number; text: string }[], canSave: boolean): string {
  const known = items.length
    ? `## What you remember about the student\nFacts from earlier conversations (and ones they added). Use them naturally to personalise answers: their courses, level, goals and preferences. Don't recite them or say "I remember that…" unless it matters.\n${items.map((m) => `- [${m.id}] ${m.text}`).join('\n')}`
    : '';
  if (!canSave) return known;
  return `${known ? `${known}\n\n` : ''}## Remembering
You have a long-term memory of the student, like a good tutor who gets to know them. Use save_memory when they share something that will still matter in future conversations:
- who they are: program, year, school, courses this term, career goals;
- how they learn: what confuses them, what helps, the level they are at, preferred explanation style, units or notation;
- lasting preferences and plans: exam dates, study habits, what they are working towards.
Rules:
- One short, self-contained fact per call, written in the third person ("Is in 2nd-year mechanical engineering", "Finds integration by parts confusing").
- Don't save trivia, one-off requests, things already in memory, or anything sensitive (health, finances, passwords, other people's details) unless they explicitly ask you to remember it.
- If a saved fact is now wrong, call save_memory with replaces set to its id. If they ask you to forget something, use forget_memory.
- Save quietly alongside your answer; don't ask permission. When they explicitly say "remember…", save it and confirm in a few words.`;
}

export function nowPrompt(d = new Date()): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const date = d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const os = /Mac/i.test(navigator.userAgent) ? 'macOS' : /Win/i.test(navigator.userAgent) ? 'Windows' : 'Linux';
  return `## Current context\nToday is ${date} (${d.toLocaleDateString('en-CA')}); the local time is ${time} (${tz}). The student's language setting is ${navigator.language}; they use SalemStudy on ${os}. Use this for anything about dates, deadlines, "today", "tomorrow" or how long until something.`;
}

export function focusPrompt(): string {
  const p = pomodoroState();
  const open = p.tasks.filter((t) => !t.done).map((t) => t.text);
  const done = p.tasks.filter((t) => t.done).length;
  const phase = p.phase === 'focus' ? 'a focus session' : p.phase === 'short' ? 'a short break' : 'a long break';
  const timer = p.status === 'running' ? `running: ${phase}, ${fmtClock(remainingOf(p))} left`
    : p.status === 'paused' ? `paused in ${phase}, ${fmtClock(remainingOf(p))} left` : 'not running';
  return `## Focus timer
The Pomodoro timer is ${timer}. Tasks: ${open.length ? open.map((t, i) => `${i === 0 ? '(current) ' : ''}${t}`).join('; ') : 'none planned'}${done ? ` (${done} done)` : ''}.${p.status === 'running' && p.phase === 'focus' ? ' They are mid-session: keep answers focused on the task and brief unless asked for more.' : ''}`;
}

export function spacePrompt(tree: SubjectNode[]): string {
  if (!tree.length) return '## Study space\nNo subjects yet.';
  const lines = tree.map((s) => `- ${s.name}${s.syllabusName ? ' (syllabus added)' : ''}: ${s.notebooks.length ? s.notebooks.map((n) => `${n.name} [${n.sourceCount} sources, ${n.deckCount} decks, ${n.quizCount} quizzes, ${n.noteCount} notes]`).join('; ') : 'no notebooks'}`);
  return `## Study space
The student's courses (subjects) and their notebooks in SalemStudy:
${lines.join('\n')}`;
}
