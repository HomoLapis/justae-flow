/**
 * The prompt assistant, as the window sees it: which provider is on (the
 * server keeps the setting and the key), the provider's model list, and the
 * rewrite itself. Nothing leaves the machine until Improve is pressed, and
 * then only to the provider the user chose.
 */

import { create } from 'zustand';
import { serverJson } from '../bridge/server';

export type AssistProvider = 'off' | 'ollama' | 'lmstudio' | 'claude';

export interface AssistView {
  provider: AssistProvider;
  url: string;
  model: string;
  key: { set: boolean; tail: string | null; file: string };
  urls: Record<AssistProvider, string>;
  claudeModels: string[];
}

export interface AssistContext {
  kind?: 'video' | 'image';
  seconds?: number;
  workflow?: string;
  width?: number;
  height?: number;
}

interface AssistStore {
  view: AssistView | null;
  load: () => Promise<void>;
  save: (patch: { provider?: AssistProvider; url?: string; model?: string; apiKey?: string | null }) => Promise<void>;
  models: () => Promise<{ ok: boolean; models: string[]; error?: string }>;
  improve: (text: string, context: AssistContext) => Promise<string>;
}

export const useAssist = create<AssistStore>((set) => ({
  view: null,
  load: async () => {
    try { set({ view: await serverJson<AssistView>('/api/assist') }); } catch { /* the server is down: the box offers nothing */ }
  },
  save: async (patch) => { set({ view: await serverJson<AssistView>('/api/assist', patch) }); },
  models: () => serverJson<{ ok: boolean; models: string[]; error?: string }>('/api/assist/models'),
  improve: async (text, context) => {
    const r = await serverJson<{ ok: boolean; prompt?: string; error?: string }>('/api/assist/prompt', { text, context });
    if (!r.ok || !r.prompt) throw new Error(r.error ?? 'No answer.');
    return r.prompt;
  },
}));
