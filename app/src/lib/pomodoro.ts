import { useSyncExternalStore } from 'react';
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { studyApi } from '../study/api';

export type Phase = 'focus' | 'short' | 'long';
export type Task = { id: string; text: string; done: boolean; doneAt: number | null; createdAt: number };
export type Session = { phase: Phase; start: number; end: number; completed: boolean; tasksDone: string[] };
export type Settings = { focus: number; short: number; long: number; every: number; autoStart: boolean; sound: boolean; volume: number };

export type PomodoroState = {
  phase: Phase;
  status: 'idle' | 'running' | 'paused';
  endsAt: number | null;
  remaining: number;
  startedAt: number | null;
  streak: number;
  settings: Settings;
  tasks: Task[];
  history: Session[];
  alarm: { ended: Phase; next: Phase } | null;
};

const KEY = 'wa.pomodoro.v1';
const DEFAULTS: Settings = { focus: 25, short: 5, long: 15, every: 4, autoStart: false, sound: true, volume: 0.6 };

export const PHASE_LABEL: Record<Phase, string> = { focus: 'Focus', short: 'Short break', long: 'Long break' };

const minutes = (s: Settings, p: Phase) => (p === 'focus' ? s.focus : p === 'short' ? s.short : s.long) * 60_000;

function initial(): PomodoroState {
  const base: PomodoroState = {
    phase: 'focus', status: 'idle', endsAt: null, remaining: DEFAULTS.focus * 60_000, startedAt: null,
    streak: 0, settings: DEFAULTS, tasks: [], history: [], alarm: null,
  };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null') as Partial<PomodoroState> | null;
    if (saved) return { ...base, ...saved, settings: { ...DEFAULTS, ...saved.settings }, alarm: null };
  } catch { }
  return base;
}

let state: PomodoroState = initial();
const listeners = new Set<() => void>();
let ticker: number | null = null;

const onShared = (keys: string[], fn: () => void) => {
  if (typeof window === 'undefined') return;
  window.addEventListener('wa:prefs', (e) => {
    if (keys.includes((e as CustomEvent<{ key: string }>).detail?.key)) fn();
  });
};
onShared([KEY], () => { state = initial(); listeners.forEach((l) => l()); syncTicker(); });

function persist() {
  try { localStorage.setItem(KEY, JSON.stringify({ ...state, alarm: null, history: state.history.slice(-500) })); } catch { }
}

function set(patch: Partial<PomodoroState>) {
  state = { ...state, ...patch };
  persist();
  listeners.forEach((l) => l());
  syncTicker();
}

function syncTicker() {
  if (state.status === 'running' && ticker === null) {
    ticker = window.setInterval(tick, 250);
  } else if (state.status !== 'running' && ticker !== null) {
    window.clearInterval(ticker);
    ticker = null;
  }
}

export const remainingOf = (s: PomodoroState, now = Date.now()) =>
  s.status === 'running' && s.endsAt ? Math.max(0, s.endsAt - now) : s.remaining;

let lastSecond = -1;
function tick() {
  if (document.documentElement.hasAttribute('data-tab-locked')) return;
  const left = remainingOf(state);
  if (left <= 0) { finish(true); return; }
  const sec = Math.ceil(left / 1000);
  if (sec !== lastSecond) {
    lastSecond = sec;
    state = { ...state };
    listeners.forEach((l) => l());
  }
}

function nextPhase(ended: Phase, streak: number, s: Settings): Phase {
  if (ended !== 'focus') return 'focus';
  return streak > 0 && streak % s.every === 0 ? 'long' : 'short';
}

function finish(completed: boolean) {
  const now = Date.now();
  const ended = state.phase;
  const doneIds = state.tasks.filter((t) => t.doneAt && state.startedAt && t.doneAt >= state.startedAt).map((t) => t.id);
  const history = state.startedAt
    ? [...state.history, { phase: ended, start: state.startedAt, end: now, completed, tasksDone: doneIds }]
    : state.history;
  const streak = ended === 'focus' && completed ? state.streak + 1 : ended === 'long' ? 0 : state.streak;
  const next = nextPhase(ended, streak, state.settings);
  const auto = completed && state.settings.autoStart;
  set({
    phase: next,
    status: auto ? 'running' : 'idle',
    endsAt: auto ? now + minutes(state.settings, next) : null,
    startedAt: auto ? now : null,
    remaining: minutes(state.settings, next),
    streak,
    history,
    alarm: completed ? { ended, next } : null,
  });
  if (completed) ring();
  if (completed && ended === 'focus' && state.startedAt) {
    void studyApi
      .addFocusSession(ended, state.startedAt, now, doneIds.length)
      .catch(() => { });
  }
}

export const pomodoroState = () => state;

export const pomodoro = {
  start() {
    if (state.status === 'running') return;
    unlockAudio();
    void askNotifications();
    const now = Date.now();
    set({ status: 'running', endsAt: now + state.remaining, startedAt: state.startedAt ?? now });
  },
  pause() {
    if (state.status !== 'running') return;
    set({ status: 'paused', remaining: remainingOf(state), endsAt: null });
  },
  toggle() { if (state.status === 'running') pomodoro.pause(); else pomodoro.start(); },
  reset() { set({ status: 'idle', endsAt: null, startedAt: null, remaining: minutes(state.settings, state.phase) }); },
  skip() { finish(false); },
  setPhase(phase: Phase) {
    set({ phase, status: 'idle', endsAt: null, startedAt: null, remaining: minutes(state.settings, phase) });
  },
  updateSettings(patch: Partial<Settings>) {
    const settings = { ...state.settings, ...patch };
    const idle = state.status === 'idle';
    set({ settings, remaining: idle ? minutes(settings, state.phase) : state.remaining });
  },
  dismissAlarm() { set({ alarm: null }); },
  addTask(text: string) {
    const t = text.trim();
    if (!t) return;
    set({ tasks: [...state.tasks, { id: crypto.randomUUID(), text: t, done: false, doneAt: null, createdAt: Date.now() }] });
  },
  toggleTask(id: string) {
    set({ tasks: state.tasks.map((t) => (t.id === id ? { ...t, done: !t.done, doneAt: t.done ? null : Date.now() } : t)) });
  },
  removeTask(id: string) { set({ tasks: state.tasks.filter((t) => t.id !== id) }); },
  clearDone() { set({ tasks: state.tasks.filter((t) => !t.done) }); },
  testSound() { unlockAudio(); chime(); },
};

export function usePomodoro(): PomodoroState {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    () => state,
  );
}

syncTicker();

export const fmtClock = (ms: number) => {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

let audio: AudioContext | null = null;

function unlockAudio() {
  try {
    audio ??= new AudioContext();
    void audio.resume();
  } catch { }
}

let notifyAllowed: boolean | null = null;
async function askNotifications() {
  if (notifyAllowed !== null) return;
  try {
    notifyAllowed = await isPermissionGranted();
    if (!notifyAllowed) notifyAllowed = (await requestPermission()) === 'granted';
  } catch { notifyAllowed = false; }
}

function ring() {
  flashTitle();
  chime();
  const ended = state.alarm?.ended;
  if (notifyAllowed && ended && !document.hasFocus()) {
    try {
      sendNotification({
        title: ended === 'focus' ? 'Focus session done' : 'Break over',
        body: ended === 'focus' ? `Time for a ${state.phase === 'long' ? 'long' : 'short'} break.` : 'Back to focus.',
      });
    } catch { }
  }
}

function chime() {
  if (!state.settings.sound) return;
  try {
    audio ??= new AudioContext();
    const ctx = audio;
    void ctx.resume();
    const notes = [880, 1108.73, 1318.51];
    for (let round = 0; round < 2; round++) {
      notes.forEach((freq, i) => {
        const t = ctx.currentTime + round * 1.1 + i * 0.18;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(0.35 * state.settings.volume, t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 1.2);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 1.25);
      });
    }
  } catch { }
}

let flashing: number | null = null;
function flashTitle() {
  if (flashing !== null) return;
  const original = document.title;
  let on = false;
  let n = 0;
  flashing = window.setInterval(() => {
    on = !on;
    document.title = on ? '⏰ Time is up' : original;
    if (++n >= 12 || document.hasFocus()) {
      window.clearInterval(flashing!);
      flashing = null;
      document.title = original;
    }
  }, 700);
}
