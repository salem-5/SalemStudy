import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export type PythonPackage = { name: string; version: string | null };

export type PythonStatus = {
  ready: boolean;
  source: 'venv' | 'custom' | 'none';
  interpreter: string | null;
  version: string | null;
  packages: PythonPackage[];
  missing: string[];
  error: string | null;
  help: string;
  canInstall: boolean;
  ocrReady?: boolean;
  ocrSizeMb?: number;
};

export type PythonResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  result: string | null;
  error: string | null;
  timed_out?: boolean;
  truncated?: boolean;
  duration_ms?: number;
  exitCode?: number | null;
  loaded?: string[];
  missing?: string[];
  figures?: { name: string; dataUrl: string }[];
};

export const pythonStatus = () => invoke<PythonStatus>('python_status');
export const pythonSetup = (repair = false) => invoke<PythonStatus>('python_setup', { repair });
export const installOcr = () => invoke<PythonStatus>('python_install_ocr');
export const runPython = (code: string, timeout?: number, files?: number[], extra?: { sources?: number[]; maxOutput?: number; maxFigures?: number }) =>
  invoke<PythonResult>('run_python', {
    code,
    timeout: timeout ?? null,
    files: files ?? null,
    sources: extra?.sources ?? null,
    maxOutput: extra?.maxOutput ?? null,
    maxFigures: extra?.maxFigures ?? null,
  });

export type PythonProgress = { stage: 'stage' | 'log' | 'done'; line: string };

export const onPythonProgress = (fn: (p: PythonProgress) => void) =>
  listen<PythonProgress>('python://progress', (e) => fn(e.payload));

const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max)}\n… [cut]`);

export function formatResult(r: PythonResult): string {
  const parts: string[] = [];
  if (r.stdout.trim()) parts.push(`stdout:\n${clip(r.stdout.trimEnd(), 6000)}`);
  if (r.result) parts.push(`value of the last expression: ${clip(r.result, 2000)}`);
  if (r.stderr.trim()) parts.push(`stderr:\n${clip(r.stderr.trimEnd(), 2000)}`);
  if (r.error) parts.push(`error:\n${clip(r.error, 3000)}`);
  if (r.figures?.length) parts.push(`${r.figures.length} figure(s) were captured and are shown to the user: ${r.figures.map((f) => f.name).join(', ')}.`);
  if (!parts.length) parts.push('The code ran but printed nothing. Print the values you need.');
  if (r.timed_out) parts.push('Tip: it was stopped on time. Use a faster method (nsolve/nsimplify, fewer digits).');
  return parts.join('\n\n');
}

export function summarize(r: PythonResult): string {
  if (r.error) return r.timed_out ? 'timed out' : r.error.split('\n').slice(-1)[0].slice(0, 120);
  const out = (r.result ?? r.stdout.trim().split('\n').slice(-1)[0] ?? '').trim();
  return out ? out.slice(0, 160) : 'ok';
}

export function sandboxName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[^\p{L}\p{N}._\- ]/gu, '_').trim().replace(/^[._]+/, '');
  return cleaned ? [...cleaned].slice(0, 120).join('') : 'file';
}
