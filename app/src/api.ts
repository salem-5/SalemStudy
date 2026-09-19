import { invoke } from '@tauri-apps/api/core';
import { normalizeQuestion } from './lib/placeholders';
import type {
  ApiError, Assignment, AssignmentList, BridgeInfo, Course, Draft, DryRun, Question, SaveResult, Status, SubmitResult,
} from './types';

type Answers = Record<string, Draft>;

// 'http' is for `npm run dev` in a browser with ?live: Vite proxies /api to the
// bridge (stripping the Origin header the bridge refuses).
let transport: 'tauri' | 'http' = 'tauri';
export const useHttpTransport = () => { transport = 'http'; };

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  if (transport === 'tauri') return invoke<T>('api', { method, path, body: body ?? null });
  const r = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await r.json().catch(() => null);
  if (!r.ok) throw { status: r.status, error: json?.error ?? `HTTP ${r.status}` } satisfies ApiError;
  return json as T;
}

export const errorText = (e: unknown): string =>
  typeof e === 'object' && e !== null && 'error' in e ? String((e as ApiError).error) : String(e);

export const errorStatus = (e: unknown): number | null =>
  typeof e === 'object' && e !== null && 'status' in e ? Number((e as ApiError).status) : null;

const q = (dep: number, n: number) => `/api/assignments/${dep}/questions/${n}`;

export const api = {
  status: () => call<Status>('GET', '/api/status'),
  courses: () => call<Course[]>('GET', '/api/courses'),
  assignments: (section?: string) =>
    call<AssignmentList>('GET', `/api/assignments${section ? `?section=${encodeURIComponent(section)}` : ''}`),
  assignment: async (dep: number) => {
    const a = await call<Assignment>('GET', `/api/assignments/${dep}?html=1`);
    return { ...a, questions: a.questions.map(normalizeQuestion) };
  },
  question: async (dep: number, n: number) => normalizeQuestion(await call<Question>('GET', `${q(dep, n)}?html=1`)),
  styles: (dep: number) => call<{ css: string; sources: string[] }>('GET', `/api/assignments/${dep}/styles`),
  save: (dep: number, n: number, answers: Answers) => call<SaveResult>('POST', `${q(dep, n)}/save`, { answers }),
  submit: async (dep: number, n: number, answers: Answers) => {
    const r = await call<SubmitResult>('POST', `${q(dep, n)}/submit`, { answers });
    return { ...r, question: normalizeQuestion(r.question) };
  },
  dryRun: (dep: number, n: number, answers: Answers) => call<DryRun>('POST', `${q(dep, n)}/submit?dryRun=1`, { answers }),
  bridgeInfo: () => invoke<BridgeInfo>('bridge_info'),
  restartBridge: () => invoke<BridgeInfo>('restart_bridge'),
};
