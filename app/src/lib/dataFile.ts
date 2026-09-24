import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';

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
const isAppKey = (k: string) => k.startsWith('wa.') && !k.startsWith('wa.study.mock');

function localSnapshot(): string {
  const out: Record<string, string> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      if (isAppKey(k)) out[k] = localStorage.getItem(k) ?? '';
    }
  } catch { }
  return JSON.stringify(out);
}

function clearLocal(keep: (k: string) => boolean = () => false) {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i)!);
    for (const k of keys) if (isAppKey(k) && !keep(k)) localStorage.removeItem(k);
  } catch { }
}

export const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`);

export async function exportData(includeSettings: boolean): Promise<{ path: string; bytes: number } | null> {
  const day = new Date().toLocaleDateString('en-CA');
  const path = await save({ title: 'Export SalemStudy data', defaultPath: `SalemStudy ${day}.${EXT}`, filters: [{ name: 'SalemStudy export', extensions: [EXT] }] });
  if (!path) return null;
  return invoke('data_export', { path, includeSettings, local: includeSettings ? localSnapshot() : null });
}

export async function pickImport(): Promise<{ path: string; info: ExportInfo } | null> {
  const picked = await open({ title: 'Import SalemStudy data', multiple: false, directory: false, filters: [{ name: 'SalemStudy export', extensions: [EXT, 'db'] }] });
  const path = typeof picked === 'string' ? picked : null;
  if (!path) return null;
  return { path, info: await invoke<ExportInfo>('data_inspect', { path }) };
}

export async function importData(path: string): Promise<void> {
  const r = await invoke<{ local: string | null; settings: boolean }>('data_import', { path });
  if (r.local) {
    clearLocal();
    try {
      for (const [k, v] of Object.entries(JSON.parse(r.local) as Record<string, string>)) if (isAppKey(k)) localStorage.setItem(k, v);
    } catch { }
  } else {
    clearLocal((k) => !/^wa\.(route|nb\.|chat\.last|syllabus\.notes\.|selected|section|q\.|drafts)/.test(k));
  }
  location.reload();
}

export async function resetData(forgetKey: boolean): Promise<void> {
  await invoke('data_reset', { forgetKey });
  clearLocal();
  location.reload();
}
