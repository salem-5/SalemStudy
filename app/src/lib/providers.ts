import { invoke } from '@tauri-apps/api/core';

export type CatalogModel = {
  id: string;
  name: string;
  reasoning: boolean;
  effort: boolean;
  tools: boolean;
  vision: boolean;
  input: number;
  output: number;
  cacheRead: number;
  context: number;
  maxOutput: number;
  status: string;
  released: string;
};

export type CatalogProvider = {
  id: string;
  name: string;
  base: string | null;
  doc: string;
  env: string[];
  models: CatalogModel[];
};

export type OllamaModel = { id: string; size: number | null; family: string | null; parameters: string | null };
export type OllamaStatus = {
  installed: boolean;
  running: boolean;
  version: string | null;
  models: OllamaModel[];
  loaded: { id: string; vram: number | null }[];
};

export const OLLAMA = 'ollama';

export const providersCatalog = (refresh = false) => invoke<Record<string, CatalogProvider>>('providers_catalog', { refresh });
export const ollamaStatus = () => invoke<OllamaStatus>('ollama_status');
export const ollamaStart = () => invoke<OllamaStatus>('ollama_start');
export const ollamaStop = () => invoke<{ unloaded: string[] }>('ollama_stop');

export const logoUrl = (id: string) => `https://models.dev/logos/${encodeURIComponent(id)}.svg`;

const FEATURED = ['deepseek', 'openai', 'anthropic', 'google', 'openrouter', 'xai', 'groq', 'mistral'];

export function orderedProviders(catalog: Record<string, CatalogProvider>): CatalogProvider[] {
  const usable = Object.values(catalog).filter((p) => p.base && p.models.length && p.id !== OLLAMA);
  const rank = (p: CatalogProvider) => {
    const i = FEATURED.indexOf(p.id);
    return i < 0 ? FEATURED.length : i;
  };
  return usable.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

export const ollamaProvider = (status: OllamaStatus | null): CatalogProvider => ({
  id: OLLAMA,
  name: 'Ollama',
  base: 'http://127.0.0.1:11434/v1',
  doc: 'https://ollama.com/library',
  env: [],
  models: (status?.models ?? []).map((m) => ({
    id: m.id,
    name: m.id,
    reasoning: false,
    effort: false,
    tools: true,
    vision: false,
    input: 0,
    output: 0,
    cacheRead: 0,
    context: 0,
    maxOutput: 0,
    status: '',
    released: '',
  })),
});

export const infoOf = (m: CatalogModel) => ({
  input: m.input,
  output: m.output,
  cacheRead: m.cacheRead,
  effort: m.effort,
  maxOutput: m.maxOutput,
  vision: m.vision,
  tools: m.tools,
});

export function priceLabel(m: CatalogModel): string {
  if (!m.input && !m.output) return 'free';
  const f = (n: number) => (n >= 10 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toFixed(2).replace(/0$/, ''));
  return `$${f(m.input)} / $${f(m.output)}`;
}

export const contextLabel = (n: number) => (!n ? '' : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M` : `${Math.round(n / 1000)}k`);

export function orderedModels(models: CatalogModel[]): CatalogModel[] {
  const score = (m: CatalogModel) => (m.status === 'deprecated' ? 2 : 0) + (m.tools ? 0 : 1);
  return [...models].sort((a, b) => score(a) - score(b) || b.released.localeCompare(a.released) || a.name.localeCompare(b.name));
}
