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
 * Between measured window lengths the time per tile-step is taken as proportional
 * to the window's latent frames (a 97-frame window holds 13, a 49-frame one 7) and
 * to the tile's area — a first-order rule, said as such; a measured window length
 * always wins. Every estimate carries "≈" and "measured on an RTX 5080".
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
];

/**
 * The rest of a job, from the same run: 124.9 s of execution less 31 s of sampling = 94 s, of which about 24 s
 * decoding and saving 41 frames of 1024×576 (from the progress phases) and the remaining 70 s loading the models
 * and encoding the prompt and the guide (cold: nothing of LTX-2.5 was loaded before).
 */
export const MEASURED_LOAD_SECONDS = 70;
export const MEASURED_SECONDS_PER_MPX_FRAME = 24 / ((1024 * 576 * 41) / 1e6);

const latentFrames = (f: number): number => Math.floor((Math.max(1, f) - 1) / FRAME_STEP) + 1;

/** Seconds per tile-step at this window length and tile area, from the nearest measured window (scaled by latent frames × area). */
export function secondsPerTileStep(frames: number, area: number = TILE.refine.w * TILE.refine.h): { seconds: number; basis: string } {
  const runs = [...MEASURED_STEPS].sort((a, b) => Math.abs(latentFrames(a.frames) - latentFrames(frames)) - Math.abs(latentFrames(b.frames) - latentFrames(frames)));
  const r = runs[0];
  const k = (latentFrames(frames) / latentFrames(r.frames)) * (area / r.area);
  return {
    seconds: r.secondsPerTileStep * k,
    basis: `${r.what}${Math.abs(k - 1) > 0.01 ? `, scaled ×${(Math.round(k * 100) / 100).toFixed(2)} for ${frames}-frame windows${Math.abs(area - r.area) > 1 ? ` and ${Math.round((area / r.area) * 100)} % of its area` : ''}` : ''}`,
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
  const last = plan.passes[plan.passes.length - 1].canvas;
  const out = plan.passes.reduce((s, p) => s + outputSeconds(p.canvas.w, p.canvas.h, plan.frames.total), 0)
    + (plan.previewCrop ? 0 : outputSeconds(last.w, last.h, 0));
  return {
    seconds: MEASURED_LOAD_SECONDS + sampling + out,
    basis: `${first.basis}; plus ~${MEASURED_LOAD_SECONDS} s loading and the decode and save of every frame`,
    tileSteps: plan.load,
  };
}

/** A single pass: its canvas as one tile of its area, one extent of the whole clip, 8 steps. */
export function estimateSingle(plan: SinglePlan): FinishEstimate {
  const area = plan.canvas.w * plan.canvas.h;
  const per = secondsPerTileStep(plan.frames.total, area);
  return {
    seconds: MEASURED_LOAD_SECONDS + per.seconds * plan.steps + outputSeconds(plan.canvas.w, plan.canvas.h, plan.frames.total),
    basis: `${per.basis}; the whole frame as one tile of ${plan.canvas.w}×${plan.canvas.h}`,
    tileSteps: plan.steps,
  };
}

/** "≈ 18 min on this GPU (measured on an RTX 5080: …)". */
export function describeFinishEstimate(e: FinishEstimate): string {
  const s = Math.round(e.seconds);
  const t = s < 90 ? `${s} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${Math.floor(s / 3600)} h ${String(Math.round((s % 3600) / 60)).padStart(2, '0')} min`;
  return `≈ ${t} on this GPU (measured on an ${MEASURED_ON.replace(' 16 GB', '')}: ${e.basis})`;
}
