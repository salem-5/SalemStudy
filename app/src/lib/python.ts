import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

/**
 * The sandboxed Python the solver hands to the model (see src-tauri/python.rs).
 * Code runs in a private virtualenv, in a throwaway folder, with no network,
 * no subprocesses and a hard timeout.
 */

export type PythonPackage = { name: string; version: string | null };

export type PythonStatus = {
  ready: boolean;
  /** 'venv' = the app's managed environment, 'custom' = WA_PYTHON or a path in settings. */
  source: 'venv' | 'custom' | 'none';
  interpreter: string | null;
  version: string | null;
  packages: PythonPackage[];
  missing: string[];
  error: string | null;
  help: string;
  /** Whether an interpreter exists that could build the environment. */
  canInstall: boolean;
};

export type PythonResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** Value of a trailing expression, echoed the way a REPL would. */
  result: string | null;
  error: string | null;
  timed_out?: boolean;
  truncated?: boolean;
  duration_ms?: number;
  exitCode?: number | null;
  loaded?: string[];
  missing?: string[];
};

export const pythonStatus = () => invoke<PythonStatus>('python_status');
export const pythonSetup = (repair = false) => invoke<PythonStatus>('python_setup', { repair });
export const runPython = (code: string, timeout?: number) =>
  invoke<PythonResult>('run_python', { code, timeout: timeout ?? null });

export type PythonProgress = { stage: 'stage' | 'log' | 'done'; line: string };

/** Install progress, for the settings dialog. */
export const onPythonProgress = (fn: (p: PythonProgress) => void) =>
  listen<PythonProgress>('python://progress', (e) => fn(e.payload));

const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max)}\n… [cut]`);

/** What the model gets back as the tool result. Plain text reads better to it than JSON. */
export function formatResult(r: PythonResult): string {
  const parts: string[] = [];
  if (r.stdout.trim()) parts.push(`stdout:\n${clip(r.stdout.trimEnd(), 6000)}`);
  if (r.result) parts.push(`value of the last expression: ${clip(r.result, 2000)}`);
  if (r.stderr.trim()) parts.push(`stderr:\n${clip(r.stderr.trimEnd(), 2000)}`);
  if (r.error) parts.push(`error:\n${clip(r.error, 3000)}`);
  if (!parts.length) parts.push('The code ran but printed nothing. Print the values you need.');
  if (r.timed_out) parts.push('Tip: it was stopped on time. Use a faster method (nsolve/nsimplify, fewer digits).');
  return parts.join('\n\n');
}

/** One line for the chat log. */
export function summarize(r: PythonResult): string {
  if (r.error) return r.timed_out ? 'timed out' : r.error.split('\n').slice(-1)[0].slice(0, 120);
  const out = (r.result ?? r.stdout.trim().split('\n').slice(-1)[0] ?? '').trim();
  return out ? out.slice(0, 160) : 'ok';
}
