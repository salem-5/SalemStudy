import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';

/**
 * Export, import and reset of everything the app keeps (see src-tauri/src/data.rs).
 * The data lives in study.db; the preferences in localStorage (keys "wa.*"),
 * which travel inside the export when settings are included.
 */

export type ExportInfo = {
  exportedAt: number | null;
  hasSettings: boolean;
  subjects: number;
  notebooks: number;
  sources: number;
  notes: number;
  chats: number;
  events: number;
  bytes: number;
};

const EXT = 'salemstudy';
/** Browser-preview fixtures, never exported or cleared. */
const isAppKey = (k: string) => k.startsWith('wa.') && !k.startsWith('wa.study.mock');

function localSnapshot(): string {
  const out: Record<string, string> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      if (isAppKey(k)) out[k] = localStorage.getItem(k) ?? '';
    }
  } catch { /* storage unavailable */ }
  return JSON.stringify(out);
}

function clearLocal(keep: (k: string) => boolean = () => false) {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i)!);
    for (const k of keys) if (isAppKey(k) && !keep(k)) localStorage.removeItem(k);
  } catch { /* storage unavailable */ }
}

export const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`);

/** Ask where to save, then write the export. Null if the user cancelled. */
export async function exportData(includeSettings: boolean): Promise<{ path: string; bytes: number } | null> {
  const day = new Date().toLocaleDateString('en-CA');
  const path = await save({ title: 'Export SalemStudy data', defaultPath: `SalemStudy ${day}.${EXT}`, filters: [{ name: 'SalemStudy export', extensions: [EXT] }] });
  if (!path) return null;
  return invoke('data_export', { path, includeSettings, local: includeSettings ? localSnapshot() : null });
}

/** Ask for an export and read what is in it (nothing changes yet). */
export async function pickImport(): Promise<{ path: string; info: ExportInfo } | null> {
  const picked = await open({ title: 'Import SalemStudy data', multiple: false, directory: false, filters: [{ name: 'SalemStudy export', extensions: [EXT, 'db'] }] });
  const path = typeof picked === 'string' ? picked : null;
  if (!path) return null;
  return { path, info: await invoke<ExportInfo>('data_inspect', { path }) };
}

/** Replace everything with the export, restore its preferences, and restart the UI. */
export async function importData(path: string): Promise<void> {
  const r = await invoke<{ local: string | null; settings: boolean }>('data_import', { path });
  if (r.local) {
    clearLocal();
    try {
      for (const [k, v] of Object.entries(JSON.parse(r.local) as Record<string, string>)) if (isAppKey(k)) localStorage.setItem(k, v);
    } catch { /* keep going with defaults */ }
  } else {
    // Data-only import: keep the preferences, drop what points at the old data.
    clearLocal((k) => !/^wa\.(route|nb\.|chat\.last|syllabus\.notes\.|selected|section|q\.|drafts)/.test(k));
  }
  location.reload();
}

/** Delete all data (and optionally the API key and AI settings), then restart the UI as new. */
export async function resetData(forgetKey: boolean): Promise<void> {
  await invoke('data_reset', { forgetKey });
  clearLocal();
  location.reload();
}
