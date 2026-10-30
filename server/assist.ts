/**
 * The prompt assistant: a language model turns a few words into a prompt a
 * video or image model can use, or tightens one the user wrote. It runs where
 * the user says — a local model through Ollama or LM Studio, or Claude with
 * the user's own API key. Nothing is sent until the user presses Improve.
 *
 * The key is kept in the user folder (anthropic-api-key.txt), sent to
 * api.anthropic.com only; the window sees its last four characters at most.
 */

import Anthropic from '@anthropic-ai/sdk';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { tokenOk } from './bridge.ts';
import { configDir, type Settings } from './config.ts';
import type { Engine } from './engine.ts';

export type AssistProvider = 'off' | 'ollama' | 'lmstudio' | 'claude';

/** Where each provider listens by default. */
export const ASSIST_URLS: Record<AssistProvider, string> = {
  off: '', ollama: 'http://127.0.0.1:11434', lmstudio: 'http://127.0.0.1:1234', claude: 'https://api.anthropic.com',
};
/** The current Claude models, newest first; the field takes any model id. */
export const CLAUDE_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
export const KEY_FILE = 'anthropic-api-key.txt';

export interface AssistContext {
  kind?: 'video' | 'image';
  seconds?: number;
  workflow?: string;
  width?: number;
  height?: number;
}

export const ASSIST_SYSTEM = `You write prompts for AI video and image generation models (LTX-2.5, MiniMax H3, Wan 2.2, Z-Image) for a motion designer working on a timeline in a compositing app.

Rewrite the user's text as one prompt the model can use:
- Keep their intent, subject, names and every specific they gave; add nothing they did not ask for, no new characters or events.
- One paragraph in plain English, present tense, concrete and visual: the subject and what it does, the setting, the camera (shot size, angle, movement), the light and the palette, the mood.
- For a video, describe the motion across the clip's length: one continuous action, no cuts or scene changes unless asked. The video models make sound too: end with a short clause on the sound (ambience, voice, music), unless the user wants silence.
- No lists, headings, quotes or labels, no negative prompt, no camera brands or lens numbers unless given, no words about quality ("4K", "masterpiece").
- Length: 50 to 120 words for a video, 30 to 80 for an image.
Reply with the prompt text only.`;

const isProvider = (v: unknown): v is AssistProvider => v === 'off' || v === 'ollama' || v === 'lmstudio' || v === 'claude';

function userMessage(text: string, c: AssistContext): string {
  const shot = [
    c.kind === 'image' ? 'an image' : 'a video',
    c.kind !== 'image' && c.seconds ? `${c.seconds.toFixed(1)} s long` : null,
    c.width && c.height ? `${c.width}×${c.height}` : null,
    c.workflow ? `made with "${c.workflow}"` : null,
  ].filter(Boolean).join(', ');
  return `The shot: ${shot}.\n\nThe text to rewrite:\n${text.trim()}`;
}

/** The model's answer as a bare prompt: no fences, no "Prompt:" label, no wrapping quotes. */
function clean(answer: string): string {
  // A thinking model's reasoning (Qwen3 through an older Ollama), then fences, labels and quotes.
  let s = answer.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  s = s.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, '').trim();
  s = s.replace(/^(?:prompt|rewritten prompt|improved prompt)\s*:\s*/i, '');
  if (/^["“].*["”]$/s.test(s)) s = s.slice(1, -1);
  return s.trim();
}

async function viaOllama(url: string, model: string, system: string, user: string): Promise<string> {
  const r = await fetch(`${url}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], stream: false, options: { temperature: 0.7 } }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!r.ok) throw new Error(`Ollama answered HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json() as { message?: { content?: string }; error?: string };
  if (d.error) throw new Error(`Ollama: ${d.error}`);
  return d.message?.content ?? '';
}

async function viaLmStudio(url: string, model: string, system: string, user: string): Promise<string> {
  const r = await fetch(`${url}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0.7, max_tokens: 800, stream: false }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!r.ok) throw new Error(`LM Studio answered HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json() as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } | string };
  if (d.error) throw new Error(`LM Studio: ${typeof d.error === 'string' ? d.error : d.error.message ?? 'error'}`);
  return d.choices?.[0]?.message?.content ?? '';
}

async function viaClaude(apiKey: string, model: string, system: string, user: string): Promise<string> {
  const client = new Anthropic({ apiKey });
  const params = {
    model, max_tokens: 2000, system,
    messages: [{ role: 'user' as const, content: user }],
    // A rewrite is a small job: the lowest effort keeps it quick.
    output_config: { effort: 'low' as const },
  };
  // On a safety decline the API re-runs the request on a fallback model (Opus and Sonnet; Haiku has none).
  const r = /^claude-(opus|sonnet|fable)/.test(model)
    ? await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
    : await client.messages.create(params);
  if (r.stop_reason === 'refusal') throw new Error('Claude declined to rewrite this prompt.');
  return r.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('\n');
}

/** The prompt, rewritten by the configured provider. */
export async function improvePrompt(s: Settings, apiKey: string, text: string, context: AssistContext): Promise<string> {
  if (!text.trim()) throw new Error('Write a few words first.');
  const url = (s.assistUrl || ASSIST_URLS[s.assistProvider]).replace(/\/+$/, '');
  const user = userMessage(text, context);
  let out: string;
  switch (s.assistProvider) {
    case 'ollama':
      if (!s.assistModel) throw new Error('Pick a model in Settings ▸ Prompt assistant (ollama pull <model> lists one).');
      out = await viaOllama(url, s.assistModel, ASSIST_SYSTEM, user);
      break;
    case 'lmstudio':
      out = await viaLmStudio(url, s.assistModel, ASSIST_SYSTEM, user);
      break;
    case 'claude':
      if (!apiKey) throw new Error('Paste an Anthropic API key in Settings ▸ Prompt assistant.');
      out = await viaClaude(apiKey, s.assistModel || CLAUDE_MODELS[0], ASSIST_SYSTEM, user);
      break;
    default:
      throw new Error('The prompt assistant is off: turn it on in Settings ▸ Prompt assistant.');
  }
  const prompt = clean(out);
  if (!prompt) throw new Error('The model answered with nothing.');
  return prompt;
}

/** The models the provider offers; Claude's list is fixed. */
export async function listModels(s: Settings): Promise<string[]> {
  const url = (s.assistUrl || ASSIST_URLS[s.assistProvider]).replace(/\/+$/, '');
  if (s.assistProvider === 'claude') return CLAUDE_MODELS;
  if (s.assistProvider === 'ollama') {
    const r = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`Ollama answered HTTP ${r.status}`);
    const d = await r.json() as { models?: Array<{ name: string }> };
    return (d.models ?? []).map((m) => m.name);
  }
  if (s.assistProvider === 'lmstudio') {
    const r = await fetch(`${url}/v1/models`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`LM Studio answered HTTP ${r.status}`);
    const d = await r.json() as { data?: Array<{ id: string }> };
    return (d.data ?? []).map((m) => m.id);
  }
  return [];
}

/* ─── Routes ───────────────────────────────────────────────────────────── */

type Handler = (req: IncomingMessage, res: ServerResponse, m: RegExpExecArray, url: URL) => Promise<void> | void;

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function json<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 256 * 1024) throw new Error('Request too large.');
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return (text ? JSON.parse(text) : {}) as T;
}

/** The server routes: the setting, the provider's models, and the rewrite. Only `settings` and `applySettings` of the engine are used. */
export function assistRoutes(engine: Pick<Engine, 'settings' | 'applySettings'>, dir = configDir()): Array<[string, RegExp, Handler]> {
  const keyFile = join(dir, KEY_FILE);
  const key = (): string => (existsSync(keyFile) ? readFileSync(keyFile, 'utf8').trim() : '') || (process.env.ANTHROPIC_API_KEY?.trim() ?? '');
  const view = (): unknown => {
    const s = engine.settings;
    const k = key();
    return {
      provider: s.assistProvider,
      url: s.assistUrl || ASSIST_URLS[s.assistProvider],
      model: s.assistModel || (s.assistProvider === 'claude' ? CLAUDE_MODELS[0] : ''),
      key: { set: !!k, tail: k ? k.slice(-4) : null, file: keyFile },
      urls: ASSIST_URLS,
      claudeModels: CLAUDE_MODELS,
    };
  };
  return [
    ['GET', /^\/api\/assist$/, (_q, res) => send(res, 200, view())],
    ['POST', /^\/api\/assist$/, async (req, res, _m, url) => {
      if (!tokenOk(req, url)) return send(res, 403, { error: 'Not from this app.' });
      const p = await json<{ provider?: unknown; url?: string; model?: string; apiKey?: string | null }>(req);
      const patch: Partial<Settings> = {};
      if (isProvider(p.provider)) patch.assistProvider = p.provider;
      if (typeof p.url === 'string') patch.assistUrl = p.url.trim().replace(/\/+$/, '');
      if (typeof p.model === 'string') patch.assistModel = p.model.trim();
      if (Object.keys(patch).length) engine.applySettings(patch);
      if (p.apiKey !== undefined) {
        if (p.apiKey) writeFileSync(keyFile, p.apiKey.trim() + '\n', { mode: 0o600 });
        else rmSync(keyFile, { force: true });
      }
      send(res, 200, view());
    }],
    ['GET', /^\/api\/assist\/models$/, async (_q, res) => {
      try { send(res, 200, { ok: true, models: await listModels(engine.settings) }); } catch (e) {
        send(res, 200, { ok: false, models: [], error: e instanceof Error ? e.message : String(e) });
      }
    }],
    ['POST', /^\/api\/assist\/prompt$/, async (req, res, _m, url) => {
      if (!tokenOk(req, url)) return send(res, 403, { error: 'Not from this app.' });
      const { text, context } = await json<{ text?: string; context?: AssistContext }>(req);
      try { send(res, 200, { ok: true, prompt: await improvePrompt(engine.settings, key(), text ?? '', context ?? {}) }); } catch (e) {
        send(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }],
  ];
}
