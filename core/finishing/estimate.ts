/**
 * How long a finishing run takes on this machine, before it runs — from the
 * plan's own tile count and runs measured on the GPU it was tested on.
 *
 * The planner knows exactly what the sampler walks: tiles per step × temporal
 * windows × steps (tile-steps). What it does not know is how long one tile-step
 * takes, nor the rest of a job (loading the models, encoding the guide, decoding
 * and saving every frame), so those come from runs measured on an RTX 5080 16 GB
 * (ComfyUI 0.38.0 in WSL, NVFP4 transformer, Gemma-4 int8, DiffVAE bf16):
 *
 *   seconds ≈ load + tile-steps × s/tile-step(window) + output megapixel-frames × s/Mpx-frame
 *
 * Between measured window lengths the time per tile-step is interpolated in latent
 * frames (a 97-frame window holds 13, a 49-frame one 7) and scaled by the tile's
 * area; past the measured ones it is scaled in proportion — a first-order rule,
 * said as such. Every estimate carries "≈" and "measured on an RTX 5080".
 */

import { FRAME_STEP, TILE, type FinishPlan } from './plan.ts';
import type { SinglePlan } from './single.ts';

export const MEASURED_ON = 'RTX 5080 16 GB';

/**
 * Sampling, per tile-step, measured from ComfyUI's own step progress (the time between the first and the last of
 * the sampler's steps), by window length.
 */
export const MEASURED_STEPS: Array<{ what: string; frames: number; area: number; secondsPerTileStep: number }> = [
  // JustAE Flow, Comp tab, 25 Oct 2026 23:17: Refine preview tile, 41 → 49 frames, 8 steps in 31 s (execution 124.9 s).
  { what: 'a 1024×576 Refine tile of 49 frames: 8 steps in 31 s', frames: 49, area: 1024 * 576, secondsPerTileStep: 31 / 8 },
  // JustAE Flow, Comp tab, 26 Oct 2026 00:27 and 01:36: Refine Full HD of a 121-frame clip, 9 tiles × 2 windows of 97 ×
  // 8 steps = 144 tile-steps, sampled in 664 s and 672 s.
  { what: 'Refine Full HD of a 121-frame clip: 144 tile-steps (9 tiles × 2 windows of 97 frames × 8 steps) in 664–672 s', frames: 97, area: 1024 * 576, secondsPerTileStep: 668 / 144 },
];

/** Loading the models and encoding the prompt and the guide: 70 s cold (the preview tile), 42 s with LTX-2.5 loaded before. */
export const MEASURED_LOAD_SECONDS = 60;
/**
 * Decoding (the low-VRAM decode, 512 / 64 / 128 / 32) and saving 16-bit PNG + MP4, per output megapixel-frame: 46 s
 * and 111 s for 121 frames of 1920×1056 (26 Oct 01:36) — 0.6 s per Mpx-frame. With the Refine card's 1024 / 128 / 256
 * decode the same clip took 1631 s to decode on 16 GB (26 Oct 00:27): that decode is used only above 16 GB, unmeasured.
 */
export const MEASURED_SECONDS_PER_MPX_FRAME = (46 + 111) / ((1920 * 1056 * 121) / 1e6);

const latentFrames = (f: number): number => Math.floor((Math.max(1, f) - 1) / FRAME_STEP) + 1;

/** Seconds per tile-step at this window length and tile area: interpolated between measured windows, scaled by area. */
export function secondsPerTileStep(frames: number, area: number = TILE.refine.w * TILE.refine.h): { seconds: number; basis: string } {
  const runs = [...MEASURED_STEPS].sort((a, b) => latentFrames(a.frames) - latentFrames(b.frames));
  const lf = latentFrames(frames);
  const lo = [...runs].reverse().find((r) => latentFrames(r.frames) <= lf) ?? runs[0];
  const hi = runs.find((r) => latentFrames(r.frames) >= lf) ?? runs[runs.length - 1];
  let per: number;
  if (lo === hi) per = lo.secondsPerTileStep * (lf / latentFrames(lo.frames));
  else {
    const t = (lf - latentFrames(lo.frames)) / (latentFrames(hi.frames) - latentFrames(lo.frames));
    per = lo.secondsPerTileStep + t * (hi.secondsPerTileStep - lo.secondsPerTileStep);
  }
  const k = area / TILE.refine.w / TILE.refine.h;
  const near = Math.abs(latentFrames(lo.frames) - lf) <= Math.abs(latentFrames(hi.frames) - lf) ? lo : hi;
  return {
    seconds: per * k,
    basis: `${near.what}${latentFrames(near.frames) !== lf ? ` (${frames}-frame windows: interpolated)` : ''}${Math.abs(k - 1) > 0.01 ? `, tiles of ${Math.round(k * 100)} % that area` : ''}`,
  };
}

export interface FinishEstimate {
  seconds: number;
  /** What the number rests on, in words. */
  basis: string;
  tileSteps: number;
}

function outputSeconds(w: number, h: number, frames: number): number {
  return ((w * h * frames) / 1e6) * MEASURED_SECONDS_PER_MPX_FRAME;
}

/** A tiled plan: load + Σ passes (tile-steps × seconds per tile-step) + decoding and saving the frames. */
export function estimateFinish(plan: FinishPlan): FinishEstimate {
  const first = secondsPerTileStep(plan.frames.tileFrames, plan.passes[0].tile.w * plan.passes[0].tile.h);
  let sampling = 0;
  for (const p of plan.passes) sampling += p.load * secondsPerTileStep(plan.frames.tileFrames, p.tile.w * p.tile.h).seconds;
  // Each pass decodes its canvas.
  const out = plan.passes.reduce((s, p) => s + outputSeconds(p.canvas.w, p.canvas.h, plan.frames.total), 0);
  return {
    seconds: MEASURED_LOAD_SECONDS + sampling + out,
    basis: `${first.basis}; plus ~1 min loading and the decode and save of every frame`,
    tileSteps: plan.load,
  };
}

/** A single pass: its canvas as one tile of its area, one extent of the whole clip, 8 steps. */
export function estimateSingle(plan: SinglePlan): FinishEstimate {
  const area = plan.canvas.w * plan.canvas.h;
  const per = secondsPerTileStep(plan.frames.total, area);
  return {
    seconds: MEASURED_LOAD_SECONDS + per.seconds * plan.steps + outputSeconds(plan.canvas.w, plan.canvas.h, plan.frames.total),
    basis: `${per.basis}; the whole frame as one tile of ${plan.canvas.w}×${plan.canvas.h} — single-pass runs are less measured`,
    tileSteps: plan.steps,
  };
}

/** "≈ 18 min on this GPU (measured on an RTX 5080: …)". */
export function describeFinishEstimate(e: FinishEstimate): string {
  const s = Math.round(e.seconds);
  const t = s < 90 ? `${s} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${Math.floor(s / 3600)} h ${String(Math.round((s % 3600) / 60)).padStart(2, '0')} min`;
  return `≈ ${t} on this GPU (measured on an ${MEASURED_ON.replace(' 16 GB', '')}: ${e.basis})`;
}
