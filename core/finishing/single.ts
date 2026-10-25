/**
 * Single-pass IC-LoRAs of the LTX-2.5 Creative Lab: Deblur, Decompression,
 * Colorization, Clean Plate, Alpha Gen, Day-To-Night.
 *
 * Their model cards (read 25 Oct 2026) all point to the same official workflow,
 * ComfyUI-LTXVideo's LTX-2.5_V2V_ICLoRA_Single_Stage_Distilled.json: the source
 * resized to the generation size, LTXAddVideoICLoRAGuide at frame 0 (factor 1,
 * no streaming), the distilled 8-step sigmas with euler_ancestral and CFGGuider
 * at cfg 1, LTXVCropGuides, VAEDecodeTiled. This file builds that chain — the
 * video half of it: the official graph also encodes the source's sound and holds
 * it frozen through sampling, which JustAE Flow carries over to the preview from
 * the source itself (GetVideoComponents), as its tiled graph does.
 *
 * What each card documents, and what this file does with it:
 *
 *   deblur         960×544 bucket, 121 f @ 24; "generates well at native 1920×1088" → default: the source size (≤ 1920×1088)
 *   decompression  960×544 bucket; "start at or near" it                              → default: the bucket
 *   colorize       960×544 bucket; "start at or near" it                              → default: the bucket
 *   cleanplate     trained 1024×576 @ 49 f / 25 fps, validated 1920×1088              → default: the source size (≤ 1920×1088)
 *   alpha          up to 1920×1088 and 145 frames, empty prompt, white = foreground    → the source size, always
 *   daynight       trained 768×448, 97 f @ 24 fps, "best at the trained resolutions"   → default: the bucket
 *
 * Strength 1.0 everywhere (every card). The frames are padded to 8n+1 with at
 * least 8 copies of the last frame and trimmed after (the Refine card: "the last
 * one or two frames of any LTX generation lose about 10% detail … pad the clip by
 * 8 frames and trim") — except where that would push Alpha Gen past 145 frames.
 */

import { PAD_FRAMES, SIGMAS_8, snap32, up8n1, type Size } from './plan.ts';
import { addPreview, type ApiGraph, type PreviewVideo } from './graph.ts';
import type { FinishModels, LoraId } from './models.ts';

export type SingleLora = 'deblur' | 'decompression' | 'colorize' | 'cleanplate' | 'alpha' | 'daynight';

export const SINGLE = {
  deblur: { bucket: { w: 960, h: 544 }, defaultSize: 'source', maxFrames: null, bestFrames: 121, fps: 24 },
  decompression: { bucket: { w: 960, h: 544 }, defaultSize: 'bucket', maxFrames: null, bestFrames: 121, fps: 24 },
  colorize: { bucket: { w: 960, h: 544 }, defaultSize: 'bucket', maxFrames: null, bestFrames: 121, fps: 24 },
  cleanplate: { bucket: { w: 1024, h: 576 }, defaultSize: 'source', maxFrames: null, bestFrames: 49, fps: 25 },
  alpha: { bucket: null, defaultSize: 'source', maxFrames: 145, bestFrames: 145, fps: null },
  daynight: { bucket: { w: 768, h: 448 }, defaultSize: 'bucket', maxFrames: null, bestFrames: 97, fps: 24 },
} as const satisfies Record<SingleLora, { bucket: Size | null; defaultSize: 'source' | 'bucket'; maxFrames: number | null; bestFrames: number; fps: number | null }>;

/** The official single-stage workflow's own settings (its converted graph, ComfyUI-LTXVideo 1.1.0). */
export const SINGLE_SAMPLER = 'euler_ancestral';
export const SINGLE_DECODE = { tileSize: 512, overlap: 64, temporalSize: 128, temporalOverlap: 32 } as const;
/** Largest generation size the cards name (Alpha Gen: "up to 1920×1088"; Deblur and Clean Plate: 1920×1088). */
export const SINGLE_MAX: Size = { w: 1920, h: 1088 };

export interface SingleSource { width: number; height: number; frames: number; fps: number }

export interface SinglePlan {
  lora: SingleLora;
  size: 'source' | 'bucket';
  source: SingleSource;
  /** The generation size: multiples of 32. */
  canvas: Size;
  /** What comes back: the source's own aspect, even sides (Alpha Gen: exactly the source size, so the matte lines up). */
  delivery: Size;
  frames: { source: number; total: number; pad: number };
  steps: number;
  conditioningFps: number;
  fixes: string[];
  warnings: string[];
  /** Refused: why. */
  reason?: string;
}

function even(v: number): number {
  return Math.max(2, Math.round(v / 2) * 2);
}

export function planSingle(lora: SingleLora, src: SingleSource, size: 'source' | 'bucket' = SINGLE[lora].defaultSize): SinglePlan {
  const spec = SINGLE[lora];
  const fixes: string[] = [];
  const warnings: string[] = [];
  const mode = spec.bucket ? size : 'source';
  const portrait = src.height > src.width;
  let w: number;
  let h: number;
  if (mode === 'bucket' && spec.bucket) {
    // As the official workflow resizes its source: the shorter side to the bucket's.
    const short = portrait ? spec.bucket.w : spec.bucket.h;
    const k = short / Math.min(src.width, src.height);
    w = src.width * k;
    h = src.height * k;
    fixes.push(`Generated near the card's ${spec.bucket.w}×${spec.bucket.h} training size (shorter side ${short}), then resized back.`);
  } else {
    const box = portrait ? { w: SINGLE_MAX.h, h: SINGLE_MAX.w } : SINGLE_MAX;
    const k = Math.min(1, box.w / src.width, box.h / src.height);
    w = src.width * k;
    h = src.height * k;
    if (k < 1) fixes.push(`The source is larger than ${box.w}×${box.h}, the largest size the cards name: generated at ${Math.round(w)}×${Math.round(h)}.`);
  }
  const canvas = { w: snap32(w), h: snap32(h) };
  if (canvas.w !== Math.round(w) || canvas.h !== Math.round(h)) fixes.push(`Canvas ${canvas.w}×${canvas.h} (multiples of 32).`);
  const delivery = lora === 'alpha' ? { w: src.width, h: src.height } : { w: even(w), h: even(h) };

  const n = Math.max(1, Math.round(src.frames));
  let total = up8n1(n + PAD_FRAMES);
  if (spec.maxFrames && total > spec.maxFrames) total = up8n1(n);
  const pad = total - n;
  fixes.push(`Frames ${n} → ${total} (8n+1): ${pad} cop${pad === 1 ? 'y' : 'ies'} of the last frame, cut on the way back.`);
  let reason: string | undefined;
  if (spec.maxFrames && total > spec.maxFrames) {
    reason = `The card's limit is ${spec.maxFrames} frames (above it, RGB content leaks into the matte): this clip has ${n}. Shorten the work area to ${((spec.maxFrames - 8) / (src.fps || 24)).toFixed(1)} s or less.`;
  }
  if (!spec.maxFrames && n > spec.bestFrames) warnings.push(`${n} frames: the card trained on ${spec.bestFrames}; longer clips can drift towards the end.`);
  if (spec.fps && Math.abs((src.fps || spec.fps) - spec.fps) > 0.5) warnings.push(`The card trained at ${spec.fps} fps; this clip is ${Math.round((src.fps || 0) * 100) / 100} fps.`);
  if (mode === 'source' && spec.bucket && canvas.w * canvas.h > 2.2 * spec.bucket.w * spec.bucket.h) {
    warnings.push(`Far above the ${spec.bucket.w}×${spec.bucket.h} training size the card says the effect can weaken; "Model's size" is the card's safer start.`);
  }
  return {
    lora, size: mode, source: src, canvas, delivery, frames: { source: n, total, pad }, steps: SIGMAS_8.split(',').length - 1,
    conditioningFps: src.fps || 24, fixes, warnings, reason,
  };
}

export interface SingleGraphArgs {
  plan: SinglePlan;
  models: FinishModels;
  /** One video file for LoadVideo (a filename, or a v2 asset reference). */
  video: unknown;
  prompt: { positive: string; negative: string };
  seed: number;
  outputPrefix: string;
  /** 16-bit frames as well as the MP4 (an Alpha matte goes into the comp as the MP4 and needs no master). */
  master: 'png16' | 'exr16' | 'none';
  preview: PreviewVideo;
}

export function buildSingleGraph(args: SingleGraphArgs): { workflow: ApiGraph; saveNode: string | null; previewNode: string } {
  const { plan, models } = args;
  const lora = models.loras[plan.lora as LoraId];
  if (!lora) throw new Error(`No ${plan.lora} IC-LoRA file.`);
  const g: ApiGraph = {};
  let next = 0;
  const add = (class_type: string, inputs: Record<string, unknown>, title: string): string => {
    const id = String(++next);
    g[id] = { class_type, inputs, _meta: { title } };
    return id;
  };
  type Ref = [string, number];
  const out = (id: string, slot = 0): Ref => [id, slot];
  const { frames, canvas } = plan;

  const v = add('LoadVideo', { file: args.video }, 'Source video');
  const parts = add('GetVideoComponents', { video: out(v) }, 'Frames');
  let src: Ref = out(add('ImageFromBatch', { image: out(parts), batch_index: 0, length: frames.source }, 'Source range'));
  if (frames.pad > 0) {
    const last = add('ImageFromBatch', { image: src, batch_index: frames.source - 1, length: 1 }, 'Last frame');
    const pad = add('RepeatImageBatch', { image: out(last), amount: frames.pad }, `Pad ×${frames.pad}`);
    src = out(add('VHS_MergeImages', { images_A: src, images_B: out(pad), merge_strategy: 'match A', scale_method: 'bicubic', crop: 'disabled' }, `Frames → ${frames.total} (8n+1)`));
  }
  const image: Ref = out(add('ImageScale', { image: src, upscale_method: 'lanczos', width: canvas.w, height: canvas.h, crop: 'disabled' }, `lanczos ${canvas.w}×${canvas.h}`));

  const unet = add('UNETLoader', { unet_name: models.transformer, weight_dtype: 'default' }, 'LTX-2.5 distilled');
  const clip = add('CLIPLoader', { clip_name: models.textEncoder, type: 'ltxv', device: 'default' }, 'Gemma-4 12B');
  const vae = add('VAELoader', { vae_name: models.vae }, 'LTX-2.5 video VAE');
  const loraNode = add('LTXICLoRALoaderModelOnly', { model: out(unet), lora_name: lora, strength_model: 1.0 }, `IC-LoRA ${plan.lora} 1.0`);

  const pos = add('CLIPTextEncode', { clip: out(clip), text: args.prompt.positive }, 'prompt');
  const neg = add('CLIPTextEncode', { clip: out(clip), text: args.prompt.negative }, 'negative');
  const cond = add('LTXVConditioning', { positive: out(pos), negative: out(neg), frame_rate: plan.conditioningFps }, 'conditioning');
  const latent = add('EmptyLTXVLatentVideo', { width: canvas.w, height: canvas.h, length: frames.total, batch_size: 1 }, 'latent');
  // The official graph takes the factor from the loader's second output (the LoRA's own metadata): 1 for these six.
  const guide = add('LTXAddVideoICLoRAGuide', {
    positive: out(cond, 0), negative: out(cond, 1), vae: out(vae), latent: out(latent), image,
    frame_idx: 0, strength: 1.0, latent_downscale_factor: out(loraNode, 1), crop: 'disabled',
    use_tiled_encode: false, tile_size: 256, tile_overlap: 64, use_streaming: false, tile_frames: 97,
  }, 'IC-LoRA guide');

  const noise = add('RandomNoise', { noise_seed: args.seed }, 'noise');
  const guider = add('CFGGuider', { model: out(loraNode, 0), positive: out(guide, 0), negative: out(guide, 1), cfg: 1 }, 'CFG 1');
  const sampler = add('KSamplerSelect', { sampler_name: SINGLE_SAMPLER }, SINGLE_SAMPLER);
  const sigmas = add('ManualSigmas', { sigmas: SIGMAS_8 }, `sigmas (${plan.steps} steps)`);
  const sampled = add('SamplerCustomAdvanced', { noise: out(noise), guider: out(guider), sampler: out(sampler), sigmas: out(sigmas), latent_image: out(guide, 2) }, 'sample');
  const cropped = add('LTXVCropGuides', { positive: out(guide, 0), negative: out(guide, 1), latent: out(sampled, 0) }, 'crop the guide frames');
  let cur: Ref = out(add('VAEDecodeTiled', {
    samples: out(cropped, 2), vae: out(vae), tile_size: SINGLE_DECODE.tileSize, overlap: SINGLE_DECODE.overlap,
    temporal_size: SINGLE_DECODE.temporalSize, temporal_overlap: SINGLE_DECODE.temporalOverlap,
  }, 'decode'));
  cur = out(add('ImageFromBatch', { image: cur, batch_index: 0, length: frames.source }, 'Cut the pad'));
  if (plan.delivery.w !== canvas.w || plan.delivery.h !== canvas.h) {
    cur = out(add('ImageScale', { image: cur, upscale_method: 'lanczos', width: plan.delivery.w, height: plan.delivery.h, crop: 'disabled' }, `Delivery ${plan.delivery.w}×${plan.delivery.h}`));
  }
  let saveNode: string | null = null;
  if (args.master !== 'none') {
    const fmt = args.master === 'exr16'
      ? { format: 'exr', 'format.bit_depth': '16-bit float', 'format.input_color_space': 'sRGB' }
      : { format: 'png', 'format.bit_depth': '16-bit', 'format.input_color_space': 'sRGB' };
    saveNode = add('SaveImageAdvanced', { images: cur, filename_prefix: args.outputPrefix, ...fmt }, args.master === 'exr16' ? 'EXR 16-bit (scene-linear)' : 'PNG 16-bit');
  }
  const previewNode = addPreview(add, cur, args.preview, parts);
  return { workflow: g, saveNode, previewNode };
}

/** Nodes the single-pass graph uses. */
export function singleNodes(master: boolean): string[] {
  return [
    'LoadVideo', 'GetVideoComponents', 'ImageFromBatch', 'RepeatImageBatch', 'VHS_MergeImages', 'ImageScale',
    'UNETLoader', 'CLIPLoader', 'VAELoader', 'LTXICLoRALoaderModelOnly', 'CLIPTextEncode', 'LTXVConditioning',
    'EmptyLTXVLatentVideo', 'LTXAddVideoICLoRAGuide', 'RandomNoise', 'CFGGuider', 'KSamplerSelect', 'ManualSigmas',
    'SamplerCustomAdvanced', 'LTXVCropGuides', 'VAEDecodeTiled', 'CreateVideo', 'SaveVideo',
    ...(master ? ['SaveImageAdvanced'] : []),
  ];
}
