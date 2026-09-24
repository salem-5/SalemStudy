import { useSyncExternalStore } from 'react';
import { inTabMode } from './tabClient.ts';

export const RELEASES_URL = 'https://github.com/salem-5/SalemStudy/releases';
const RELEASE_API = 'https://api.github.com/repos/salem-5/SalemStudy/releases/tags/';

const AUTO_KEY = 'salem.update.auto';
const PENDING_KEY = 'salem.update.pending';
const SEEN_KEY = 'salem.update.seen';
const NOTES_KEY = 'salem.update.notes';

const RECHECK_MS = 15 * 60 * 1000;
const FIRST_CHECK_MS = 1_500;

const CLOSES_TO_INSTALL = typeof navigator !== 'undefined' && /windows/i.test(navigator.userAgent);

export type Changelog = { version: string; notes: string };

export type UpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'current'; checkedAt: number }
  | { status: 'available'; version: string; notes: string }
  | { status: 'downloading'; version: string; done: number; total: number | null }
  | { status: 'ready'; version: string; notes: string }
  | { status: 'error'; message: string };

type UpdateHandle = {
  version: string;
  body?: string;
  downloadAndInstall: (onEvent?: (e: { event: string; data?: { contentLength?: number; chunkLength?: number } }) => void) => Promise<void>;
  download: (onEvent?: (e: { event: string; data?: { contentLength?: number; chunkLength?: number } }) => void) => Promise<void>;
  install: () => Promise<void>;
};

const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { } },
  del: (k: string) => { try { localStorage.removeItem(k); } catch { } },
};

const readJson = <T,>(k: string): T | null => {
  try { return JSON.parse(store.get(k) || 'null') as T | null; } catch { return null; }
};

let state: UpdateState = { status: 'idle' };
let found: UpdateHandle | null = null;
let waiting: UpdateHandle | null = null;
const listeners = new Set<() => void>();
const set = (next: UpdateState) => { state = next; listeners.forEach((l) => l()); };

export function useUpdateState(): UpdateState {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => state);
}

export const canUpdate = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window && !inTabMode();

export const autoUpdates = () => store.get(AUTO_KEY) !== '0';
export const setAutoUpdates = (on: boolean) => store.set(AUTO_KEY, on ? '1' : '0');

export async function appVersion(): Promise<string> {
  const { getVersion } = await import('@tauri-apps/api/app');
  return getVersion();
}

const errorText = (e: unknown) => String(e instanceof Error ? e.message : e).slice(0, 300);

let busy = false;

export async function checkForUpdates({ install, quiet = false, later = false }: { install: boolean; quiet?: boolean; later?: boolean }): Promise<void> {
  if (busy || state.status === 'downloading' || state.status === 'ready') return;
  busy = true;
  if (!quiet) set({ status: 'checking' });
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = (await check()) as UpdateHandle | null;
    if (!update) {
      found = null;
      set({ status: 'current', checkedAt: Date.now() });
      return;
    }
    found = update;
    if (install) await installFound(later);
    else set({ status: 'available', version: update.version, notes: update.body ?? '' });
  } catch (e) {
    set(quiet ? { status: 'idle' } : { status: 'error', message: errorText(e) });
  } finally {
    busy = false;
  }
}

export async function installFound(later = false): Promise<void> {
  const update = found;
  if (!update) return;
  const notes = update.body ?? '';
  store.set(PENDING_KEY, JSON.stringify({ version: update.version, notes } satisfies Changelog));
  let done = 0;
  let total: number | null = null;
  set({ status: 'downloading', version: update.version, done, total });
  try {
    const onEvent = (e: { event: string; data?: { contentLength?: number; chunkLength?: number } }) => {
      if (e.event === 'Started') total = e.data?.contentLength ?? null;
      if (e.event === 'Progress') done += e.data?.chunkLength ?? 0;
      set({ status: 'downloading', version: update.version, done, total });
    };
    if (later && CLOSES_TO_INSTALL) {
      await update.download(onEvent);
      waiting = update;
    } else {
      await update.downloadAndInstall(onEvent);
    }
    set({ status: 'ready', version: update.version, notes });
  } catch (e) {
    store.del(PENDING_KEY);
    set({ status: 'error', message: errorText(e) });
  }
}

export async function restartNow(): Promise<void> {
  if (waiting) {
    await waiting.install();
    return;
  }
  const { relaunch } = await import('@tauri-apps/plugin-process');
  await relaunch();
}

let started = false;

export function startAutoUpdates(): void {
  if (started || !canUpdate() || import.meta.env.DEV) return;
  started = true;
  const tick = (later: boolean) => { if (autoUpdates()) void checkForUpdates({ install: true, quiet: true, later }); };
  window.setTimeout(() => tick(false), FIRST_CHECK_MS);
  window.setInterval(() => tick(true), RECHECK_MS);
}

export type ChangelogPlan = { show: Changelog } | { fetch: string } | null;

export function changelogPlan(current: string, pending: Changelog | null, seen: string | null): ChangelogPlan {
  if (pending?.version === current) return { show: pending };
  if (seen && seen !== current) return { fetch: current };
  return null;
}

export async function releaseNotes(version: string): Promise<string> {
  const res = await fetch(`${RELEASE_API}v${encodeURIComponent(version)}`, { headers: { Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const body = (await res.json()) as { body?: string };
  return (body.body ?? '').trim();
}

let afterUpdate: Promise<Changelog | null> | null = null;

export function changelogAfterUpdate(): Promise<Changelog | null> {
  afterUpdate ??= readAfterUpdate();
  return afterUpdate;
}

async function readAfterUpdate(): Promise<Changelog | null> {
  if (!canUpdate()) return null;
  const current = await appVersion();
  const plan = changelogPlan(current, readJson<Changelog>(PENDING_KEY), store.get(SEEN_KEY));
  store.del(PENDING_KEY);
  store.set(SEEN_KEY, current);
  if (!plan) return null;
  const log = 'show' in plan ? plan.show : { version: current, notes: await releaseNotes(current).catch(() => '') };
  if (!log.notes.trim()) return null;
  store.set(NOTES_KEY, JSON.stringify(log));
  return log;
}

export async function currentChangelog(): Promise<Changelog> {
  const current = await appVersion();
  const kept = readJson<Changelog>(NOTES_KEY);
  if (kept?.version === current && kept.notes.trim()) return kept;
  const notes = await releaseNotes(current);
  const log = { version: current, notes };
  if (notes) store.set(NOTES_KEY, JSON.stringify(log));
  return log;
}
