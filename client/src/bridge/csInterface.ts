/**
 * The host call, without CEP.
 *
 * In After Effects the panel ran inside the host and called ExtendScript with
 * CSInterface.evalScript. Here the page runs in the browser and the JustAE
 * Flow server runs the same host functions inside EffectCraft, whose scripting
 * follows After Effects scripting: `evalScript` sends the call to the server,
 * the server sends the host file plus the call to EffectCraft's control
 * channel (script.run), and the JSON string the function returns comes back.
 */

import { serverJson } from './server';

/** "Inside the host" means the server answers; everything that was gated on CEP is gated on that. */
export const isInCEP = (): boolean => typeof window !== 'undefined';

/** Promise wrapper: resolves the raw string the host function returned. */
export async function evalScript(script: string): Promise<string> {
  try {
    const r = await serverJson<{ result: string }>('/api/host/eval', { script });
    return r.result ?? '';
  } catch (e) {
    return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
  }
}

/** Eval a host expression and parse the JSON envelope it returns. */
export async function evalJson<T = unknown>(script: string): Promise<T | { error: string }> {
  const raw = await evalScript(script);
  if (!raw || raw === 'undefined' || raw === 'null') {
    return { error: 'No response from EffectCraft.' };
  }
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    return { error: `Failed to parse the host response: ${String(e)}. Raw: ${raw.slice(0, 200)}` };
  }
}

/** Open a URL in a new browser tab (the ComfyUI editor, a docs page). */
export function openInBrowser(url: string): void {
  window.open(url, '_blank', 'noopener');
}

/** Escape a string for embedding inside a host-script double-quoted literal. */
export function esEscape(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, '\\n');
}
