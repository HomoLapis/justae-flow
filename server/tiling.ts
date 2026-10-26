/**
 * The LTX pack's tiling sizes, asked before a run: one LTXVGetTilingSizes node as a prompt of its own on the local
 * ComfyUI (an output node — its summary comes back in /history), the answer cached per request.
 *
 * A finished answer is kept for the life of the server (the same inputs give the same sizes). When ComfyUI is busy with
 * another job the one-node prompt waits behind it: the caller gets null after its own wait ("sizes from the LTX pack at
 * run time") and the answer is still collected in the background, so the next plan of the same card has it.
 */

import { ComfyClient } from '../core/comfy/client.ts';
import type { WorkflowJson } from '../core/comfy/types.ts';
import {
  parseTilingSummary, summaryFromHistory, tilingKey, tilingProbeGraph, type TilingRequest, type TilingSizes,
} from '../core/finishing/sizes.ts';

const CLIENT_ID = 'justae-flow-tiling';
/** How long a busy ComfyUI is followed in the background for an answer nobody waited for. */
const BACKGROUND_MS = 30 * 60_000;

const done = new Map<string, TilingSizes>();
const pending = new Map<string, Promise<TilingSizes | null>>();
const failed = new Map<string, { at: number; why: string }>();

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** The cached answer for a request on this ComfyUI, if there is one. */
export function cachedTiling(base: string, r: TilingRequest): TilingSizes | null {
  return done.get(`${base}|${tilingKey(r)}`) ?? null;
}

/** Why the last ask of this request failed (the node missing, an error), for a card's note. */
export function tilingFailure(base: string, r: TilingRequest): string | null {
  return failed.get(`${base}|${tilingKey(r)}`)?.why ?? null;
}

async function ask(client: ComfyClient, key: string, r: TilingRequest): Promise<TilingSizes | null> {
  const id = await client.submit(tilingProbeGraph(r) as unknown as WorkflowJson, CLIENT_ID, { previewMethod: 'none' });
  const t0 = Date.now();
  let delay = 120;
  while (Date.now() - t0 < BACKGROUND_MS) {
    await sleep(delay);
    delay = Math.min(delay * 2, 5000);
    let job;
    try { job = await client.history(id); } catch { continue; }
    if (!job) continue;
    if (job.status?.status_str === 'error') throw new Error('LTXVGetTilingSizes refused the request');
    const text = summaryFromHistory(job);
    if (text) {
      const s = parseTilingSummary(text);
      if (!s) throw new Error('the LTX pack\'s summary could not be read');
      done.set(key, s);
      failed.delete(key);
      return s;
    }
    if (job.status?.status_str === 'success') throw new Error('LTXVGetTilingSizes gave no summary');
  }
  return null;
}

/**
 * The pack's sizes for a request: cached, or asked now and waited for up to `waitMs`. Null when the answer is not
 * there in time (it may still arrive in the background) or the node is not installed.
 */
export async function tilingFor(client: ComfyClient, r: TilingRequest, waitMs: number): Promise<TilingSizes | null> {
  const key = `${client.base}|${tilingKey(r)}`;
  const hit = done.get(key);
  if (hit) return hit;
  const f = failed.get(key);
  if (f && Date.now() - f.at < 60_000) return null;
  let p = pending.get(key);
  if (!p) {
    p = ask(client, key, r)
      .catch((e: unknown) => {
        failed.set(key, { at: Date.now(), why: e instanceof Error ? e.message : String(e) });
        return null;
      })
      .finally(() => pending.delete(key));
    pending.set(key, p);
  }
  return Promise.race([p, sleep(waitMs).then(() => null)]);
}

/** Every request of a plan, asked at once; a lookup the pure planner can use. */
export async function tilingLookup(client: ComfyClient, reqs: TilingRequest[], waitMs: number): Promise<(r: TilingRequest) => TilingSizes | null> {
  await Promise.all(reqs.map((r) => tilingFor(client, r, waitMs)));
  return (r) => done.get(`${client.base}|${tilingKey(r)}`) ?? null;
}
