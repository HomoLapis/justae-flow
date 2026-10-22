/**
 * Reading ComfyUI's `/history` into something the panel can use.
 *
 * Kept apart from the provider because this is the one piece of the capture
 * feature that depends on an undocumented shape — what the server happens to
 * store, not what an API promises — and that makes it exactly the piece that
 * has to be testable without a server in the room.
 *
 * The shape, measured against ComfyUI 0.33.0:
 *
 *   { "<promptId>": {
 *       prompt:  [queueIndex, promptId, apiGraph, extraData, outputsToExecute],
 *       outputs: {...}, status: {...}, meta: {...}
 *   } }
 *
 * with `extraData` carrying `client_id`, `create_time` (epoch milliseconds) and
 * `extra_pnginfo.workflow` — the editor graph the run came from.
 *
 * Every field is optional as far as this parser is concerned. A history entry
 * the panel cannot read is one it skips; the Workflow tab then says there is no
 * run to offer, which is recoverable. Throwing here would take the whole tab
 * down over one odd row from an older ComfyUI.
 */

import type { RecentRun, WorkflowJson } from './types';

export function parseHistory(data: unknown): RecentRun[] {
  if (!data || typeof data !== 'object') return [];

  const runs: RecentRun[] = [];
  for (const entry of Object.values(data as Record<string, unknown>)) {
    const prompt = (entry as { prompt?: unknown } | null)?.prompt;
    if (!Array.isArray(prompt) || prompt.length < 4) continue;

    const [queueIndex, promptId, api, extra] = prompt as [unknown, unknown, unknown, unknown];
    if (typeof promptId !== 'string' || !api || typeof api !== 'object' || Array.isArray(api)) continue;

    const ex = (extra && typeof extra === 'object' ? extra : {}) as {
      client_id?: unknown;
      create_time?: unknown;
      comfy_usage_source?: unknown;
      extra_pnginfo?: { workflow?: unknown } | null;
    };

    runs.push({
      promptId,
      queueIndex: typeof queueIndex === 'number' ? queueIndex : 0,
      api: api as WorkflowJson,
      ui: ex.extra_pnginfo?.workflow ?? null,
      usageSource: typeof ex.comfy_usage_source === 'string' ? ex.comfy_usage_source : null,
      clientId: typeof ex.client_id === 'string' ? ex.client_id : null,
      createdAt: typeof ex.create_time === 'number' ? ex.create_time : null,
    });
  }

  // `max_items` hands back the most recent N in ascending queue order, so the
  // caller would otherwise get the oldest of the recent ones first.
  return runs.sort((a, b) => b.queueIndex - a.queueIndex);
}
