/**
 * SDR → HDR: the LTX-2.5 IC-LoRA SDR-To-HDR, single pass, in ComfyUI.
 *
 * Its model card (huggingface.co/Lightricks/LTX-2.5-22b-IC-LoRA-SDR-To-HDR, read 26 Oct 2026) names, for ComfyUI, the
 * pack's dedicated workflow LTX-2.5_ICLoRA_SDR_to_HDR_Distilled.json (ComfyUI-LTXVideo 1.1.0). This file builds that
 * node chain — used as the description of the nodes' interface; no file of the pack is included here:
 *
 *   LoadVideo → GetVideoComponents → ImageColorSpace sRGB → HDR ACEScct (the input transform the card asks for)
 *     → ResizeImageMaskNode "scale to multiple" 32 → GetImageSize → EmptyLTXVLatentVideo
 *   UNETLoader → LTXICLoRALoaderModelOnly (strength 1.0, "fixed" on the card)
 *   VAELoader → LTXVVAEForceFloat32 (the float32 decode)
 *   LTXVLoadConditioning (the scene embedding, "no prompt needed") → positive and negative alike
 *   LTXVConditioning (frame rate ≤ 30, the card: "keeping the transformer's RoPE time base at or below 30")
 *   LTXAddVideoICLoRAGuide (frame 0, strength 1, the loader's factor) → CFGGuider 1 → SamplerCustomAdvanced (euler, the
 *     8 distilled sigmas) → LTXVCropGuides → VAEDecodeTiled 512 / 64 / 64 / 8
 *   → LTXVHDRDecodePostprocess (transfer acescct, save_exr, exr_color_space acescg): the scene-linear ACEScg EXR frames
 *   → ImageColorSpace ACEScct → HDR → CreateVideo (HDR = BT.2020 HLG) → SaveVideo: the HLG check video
 *
 * JustAE Flow adds what its other finishing cards do: the frames padded to 8n+1 with copies of the last one and cut
 * after, and an 8-bit sRGB MP4 of the node's tonemapped preview for the comp (EffectCraft 0.11.1 decodes 8-bit H.264).
 * The official graph's audio branch is left out (the source's sound goes into the MP4 directly), as in the other
 * single-pass graphs. The card's CLI pipeline adds seam keyframes; the ComfyUI workflow it names has none, nor does this.
 */

import { PAD_FRAMES, SIGMAS_8, up8n1, type Size } from './plan.ts';
import type { ApiGraph, PreviewVideo } from './graph.ts';
import type { SingleSource } from './single.ts';

/** The official workflow's decode for this LoRA. */
export const HDR_DECODE = { tileSize: 512, overlap: 64, temporalSize: 64, temporalOverlap: 8 } as const;
/** The card: keep the conditioning frame rate at or below 30. */
export const HDR_MAX_CONDITIONING_FPS = 30;
/** The size measured on a 16 GB card (26 Oct 2026); above it the card warns. */
export const HDR_MEASURED_AREA = 1280 * 736;

export interface HdrPlan {
  source: SingleSource;
  /** The canvas the pack's resize gives (multiple of 32), as far as it can be told before the run. */
  canvas: Size;
  frames: { source: number; total: number; pad: number };
  steps: number;
  conditioningFps: number;
  fixes: string[];
  warnings: string[];
}

function near32(v: number): number {
  return Math.max(32, Math.round(v / 32) * 32);
}

export function planHdr(src: SingleSource): HdrPlan {
  const fixes: string[] = [];
  const warnings: string[] = [];
  const n = Math.max(1, Math.round(src.frames));
  const total = up8n1(n + PAD_FRAMES);
  const pad = total - n;
  fixes.push(`Frames ${n} → ${total} (8n+1): ${pad} copies of the last frame, cut on the way back.`);
  const canvas = { w: near32(src.width), h: near32(src.height) };
  if (canvas.w !== src.width || canvas.h !== src.height) fixes.push(`The guide is resized to a multiple of 32 (about ${canvas.w}×${canvas.h}); the EXR frames come back at that size.`);
  const fps = src.fps || 24;
  const conditioningFps = Math.min(fps, HDR_MAX_CONDITIONING_FPS);
  if (fps > HDR_MAX_CONDITIONING_FPS) fixes.push(`The model is told ${HDR_MAX_CONDITIONING_FPS} fps (the card: at or below 30); the frames keep their ${Math.round(fps * 100) / 100} fps.`);
  if (canvas.w * canvas.h > HDR_MEASURED_AREA * 1.05 || total > 129) {
    warnings.push(`Measured here at 1280×704 and 49 frames; ${canvas.w}×${canvas.h} × ${total} frames is one window in one pass (the card: long or large plates can run out of memory in the decode — shorter trims help).`);
  }
  return { source: src, canvas, frames: { source: n, total, pad }, steps: SIGMAS_8.split(',').length - 1, conditioningFps, fixes, warnings };
}

export interface HdrModels {
  transformer: string;
  vae: string;
  lora: string;
  /** The scene embedding, as LTXVLoadConditioning lists it (models/embeddings). */
  embedding: string;
}

export interface HdrGraphArgs {
  plan: HdrPlan;
  models: HdrModels;
  video: unknown;
  seed: number;
  /** Where LTXVHDRDecodePostprocess writes the EXR frames, relative to ComfyUI's output folder, and their name. */
  exrDir: string;
  exrPrefix: string;
  /** The 8-bit sRGB MP4 for the comp (the tonemapped preview). */
  preview: PreviewVideo;
  /** filename_prefix of the HLG check video. */
  hlgPrefix: string;
}

export function buildHdrGraph(args: HdrGraphArgs): { workflow: ApiGraph; exrNode: string; previewNode: string; hlgNode: string } {
  const { plan, models } = args;
  const g: ApiGraph = {};
  let next = 0;
  const add = (class_type: string, inputs: Record<string, unknown>, title: string): string => {
    const id = String(++next);
    g[id] = { class_type, inputs, _meta: { title } };
    return id;
  };
  type Ref = [string, number];
  const out = (id: string, slot = 0): Ref => [id, slot];
  const { frames } = plan;

  const v = add('LoadVideo', { file: args.video }, 'Source video (SDR)');
  const parts = add('GetVideoComponents', { video: out(v) }, 'Frames');
  let src: Ref = out(add('ImageFromBatch', { image: out(parts), batch_index: 0, length: frames.source }, 'Source range'));
  if (frames.pad > 0) {
    const last = add('ImageFromBatch', { image: src, batch_index: frames.source - 1, length: 1 }, 'Last frame');
    const pad = add('RepeatImageBatch', { image: out(last), amount: frames.pad }, `Pad ×${frames.pad}`);
    src = out(add('VHS_MergeImages', { images_A: src, images_B: out(pad), merge_strategy: 'match A', scale_method: 'bicubic', crop: 'disabled' }, `Frames → ${frames.total} (8n+1)`));
  }
  const acescct = add('ImageColorSpace', { image: src, source: 'sRGB', destination: 'HDR ACEScct' }, 'SDR → ACEScct (input transform)');
  const guideImage = add('ResizeImageMaskNode', {
    input: out(acescct), resize_type: 'scale to multiple', 'resize_type.multiple': 32, scale_method: 'lanczos',
  }, 'Guide to a multiple of 32');
  const size = add('GetImageSize', { image: out(guideImage) }, 'Guide size');

  const unet = add('UNETLoader', { unet_name: models.transformer, weight_dtype: 'default' }, 'LTX-2.5 distilled');
  const lora = add('LTXICLoRALoaderModelOnly', { model: out(unet), lora_name: models.lora, strength_model: 1.0 }, 'IC-LoRA SDR-To-HDR 1.0');
  const vae0 = add('VAELoader', { vae_name: models.vae }, 'LTX-2.5 video VAE');
  const vae = add('LTXVVAEForceFloat32', { vae: out(vae0) }, 'VAE float32 (HDR)');
  const emb = add('LTXVLoadConditioning', { file_name: models.embedding, device: 'cpu' }, 'Scene embedding (no prompt)');
  const cond = add('LTXVConditioning', { positive: out(emb), negative: out(emb), frame_rate: plan.conditioningFps }, `conditioning (${plan.conditioningFps} fps)`);
  const latent = add('EmptyLTXVLatentVideo', { width: out(size, 0), height: out(size, 1), length: frames.total, batch_size: 1 }, 'latent');
  const guide = add('LTXAddVideoICLoRAGuide', {
    positive: out(cond, 0), negative: out(cond, 1), vae: out(vae), latent: out(latent), image: out(guideImage),
    frame_idx: 0, strength: 1.0, latent_downscale_factor: out(lora, 1), crop: 'disabled',
    use_tiled_encode: false, tile_size: 256, tile_overlap: 64, use_streaming: false, tile_frames: 97,
  }, 'IC-LoRA guide (the SDR clip)');

  const noise = add('RandomNoise', { noise_seed: args.seed }, 'noise');
  const guider = add('CFGGuider', { model: out(lora, 0), positive: out(guide, 0), negative: out(guide, 1), cfg: 1 }, 'CFG 1');
  const sampler = add('KSamplerSelect', { sampler_name: 'euler' }, 'euler');
  const sigmas = add('ManualSigmas', { sigmas: SIGMAS_8 }, `sigmas (${plan.steps} steps)`);
  const sampled = add('SamplerCustomAdvanced', { noise: out(noise), guider: out(guider), sampler: out(sampler), sigmas: out(sigmas), latent_image: out(guide, 2) }, 'sample');
  const cropped = add('LTXVCropGuides', { positive: out(guide, 0), negative: out(guide, 1), latent: out(sampled, 0) }, 'crop the guide frames');
  const decoded = add('VAEDecodeTiled', {
    samples: out(cropped, 2), vae: out(vae), tile_size: HDR_DECODE.tileSize, overlap: HDR_DECODE.overlap,
    temporal_size: HDR_DECODE.temporalSize, temporal_overlap: HDR_DECODE.temporalOverlap,
  }, 'decode (float32, ACEScct)');
  const cut = add('ImageFromBatch', { image: out(decoded), batch_index: 0, length: frames.source }, 'Cut the pad');

  const exr = add('LTXVHDRDecodePostprocess', {
    image: out(cut), transfer: 'acescct', exposure: 0, save_exr: true, exr_color_space: 'acescg',
    output_dir: args.exrDir, filename_prefix: args.exrPrefix, half_precision: true,
  }, 'EXR ACEScg (scene-linear)');

  const hlgImages = add('ImageColorSpace', { image: out(cut), source: 'HDR ACEScct', destination: 'HDR' }, 'ACEScct → HDR (HLG)');
  const hlgVideo = add('CreateVideo', { images: out(hlgImages), fps: args.preview.fps, color_space: 'HDR', bit_depth: 'auto', codec: 'none', ...(args.preview.audio ? { audio: [parts, 1] as Ref } : {}) }, 'HLG video (BT.2020)');
  const hlg = add('SaveVideo', { video: out(hlgVideo), filename_prefix: args.hlgPrefix, format: 'auto', 'format.codec': 'auto' }, 'HLG check video');

  const prevVideo = add('CreateVideo', { images: out(exr, 0), fps: args.preview.fps, bit_depth: 8, ...(args.preview.audio ? { audio: [parts, 1] as Ref } : {}) }, 'Preview video (8-bit, tonemapped)');
  const preview = add('SaveVideo', { video: out(prevVideo), filename_prefix: args.preview.prefix, format: 'auto', 'format.codec': 'auto' }, 'Preview MP4');
  return { workflow: g, exrNode: exr, previewNode: preview, hlgNode: hlg };
}

/** Nodes the SDR → HDR graph uses. */
export function hdrNodes(): string[] {
  return [
    'LoadVideo', 'GetVideoComponents', 'ImageFromBatch', 'RepeatImageBatch', 'VHS_MergeImages', 'ImageColorSpace',
    'ResizeImageMaskNode', 'GetImageSize', 'UNETLoader', 'LTXICLoRALoaderModelOnly', 'VAELoader', 'LTXVVAEForceFloat32',
    'LTXVLoadConditioning', 'LTXVConditioning', 'EmptyLTXVLatentVideo', 'LTXAddVideoICLoRAGuide', 'RandomNoise',
    'CFGGuider', 'KSamplerSelect', 'ManualSigmas', 'SamplerCustomAdvanced', 'LTXVCropGuides', 'VAEDecodeTiled',
    'LTXVHDRDecodePostprocess', 'CreateVideo', 'SaveVideo',
  ];
}
