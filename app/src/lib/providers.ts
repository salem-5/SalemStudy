import { invoke } from '@tauri-apps/api/core';

/**
 * The providers and models the app can use.
 *
 * The online ones come from models.dev (fetched and cached by the Rust side,
 * trimmed to what the settings page shows); Ollama is added here as the
 * local one, with whatever models are installed on this machine.
 */

export type CatalogModel = {
  id: string;
  name: string;
  reasoning: boolean;
  /** Takes a `reasoning_effort`. */
  effort: boolean;
  tools: boolean;
  vision: boolean;
  /** USD per million tokens. */
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
  /** Its OpenAI-compatible endpoint; null when the app cannot talk to it. */
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

/** models.dev's logo for a provider (monochrome SVG, drawn as a mask). */
export const logoUrl = (id: string) => `https://models.dev/logos/${encodeURIComponent(id)}.svg`;

/** The ones most students will want, first; the rest follow by name. */
const FEATURED = ['deepseek', 'openai', 'anthropic', 'google', 'openrouter', 'xai', 'groq', 'mistral'];

/** Every provider the app can talk to, local first, featured next. */
export function orderedProviders(catalog: Record<string, CatalogProvider>): CatalogProvider[] {
  const usable = Object.values(catalog).filter((p) => p.base && p.models.length && p.id !== OLLAMA);
  const rank = (p: CatalogProvider) => {
    const i = FEATURED.indexOf(p.id);
    return i < 0 ? FEATURED.length : i;
  };
  return usable.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** The local provider, with the models installed in Ollama. */
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
    // Most current local models take tools; the ones that do not simply
    // answer without them.
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

/** What the Rust side keeps about a chosen model. */
export const infoOf = (m: CatalogModel) => ({
  input: m.input,
  output: m.output,
  cacheRead: m.cacheRead,
  effort: m.effort,
  maxOutput: m.maxOutput,
  vision: m.vision,
  tools: m.tools,
});

/** "$0.15 / $0.60" per million in and out, or "free". */
export function priceLabel(m: CatalogModel): string {
  if (!m.input && !m.output) return 'free';
  const f = (n: number) => (n >= 10 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toFixed(2).replace(/0$/, ''));
  return `$${f(m.input)} / $${f(m.output)}`;
}

export const contextLabel = (n: number) => (!n ? '' : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M` : `${Math.round(n / 1000)}k`);

/** Newest, non-deprecated, tool-capable first: the ones worth picking. */
export function orderedModels(models: CatalogModel[]): CatalogModel[] {
  const score = (m: CatalogModel) => (m.status === 'deprecated' ? 2 : 0) + (m.tools ? 0 : 1);
  return [...models].sort((a, b) => score(a) - score(b) || b.released.localeCompare(a.released) || a.name.localeCompare(b.name));
}
