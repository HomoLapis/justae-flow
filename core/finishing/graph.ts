/**
 * The tiled finishing graph, in ComfyUI API format, built from a plan.
 *
 * Ported from JustAE Flow 2 (client/src/finishing/graph.ts) unchanged in its
 * chain; JustAE Flow adds the MP4 preview beside the 16-bit frames (the comp
 * shows the preview, the frames are the master) and uses the video input that
 * Flow 2 kept for Comfy API v2 (the Comp tab uploads one file, as its other tools).
 *
 * One graph per job, every pass inside it, so a job is one prompt id and an 8K
 * job never leaves a half-done 4K on the server.
 *
 * Per pass, the chain of the official LTX-2.5_V2V_TiledFusion_* workflows
 * (ComfyUI-LTXVideo 1.1.0, example_workflows/2.5):
 *
 *   frames ─ ImageScale lanczos → canvas ─┬────────────── LTXAddVideoICLoRAGuide ─┐
 *   UNET ─ LTXICLoRALoaderModelOnly 1.0 ──┼─ (latent: EmptyLTXVLatentVideo,         │
 *   text ─ CLIPTextEncode ─ LTXVConditioning   or the encoded image for a light pass) │
 *                                                                                   ▼
 *          ManualSigmas + KSamplerSelect euler → LTXVTiledFusionSampler → VAEDecodeTiled
 *
 * Around it: frames in (a folder of PNGs, or one video), duplicated for fast
 * motion, padded with copies of the last frame to 8n+1, and on the way out
 * trimmed, de-duplicated, resized back to the source aspect and saved as 16-bit
 * PNG or EXR — never only SaveVideo's MP4 (the card: it "understates the result").
 */

import {
  BLEND_VAR, CFG, GRID_CYCLE, OVERLAP_FRAC, SAMPLER, decodeOf, type FinishPlan,
} from './plan.ts';
import type { FinishModels } from './models.ts';

export interface ApiNode {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title?: string };
}
export type ApiGraph = Record<string, ApiNode>;

export interface FinishPrompts {
  /** Refine passes: look only — sharpness, texture, grain, light. */
  positive: string;
  negative: string;
  /** Restore passes: period, place, light, materials, clothing. */
  restorePositive: string;
  /** Restore: what must not be invented — modern objects, logos, lettering… */
  restoreNegative: string;
}

export interface FinishGraphInput {
  /** A top-level folder in ComfyUI's input/ holding the frames (VHS_LoadImages). */
  framesDir?: string;
  /** Or one video file for LoadVideo — a filename, or a Comfy API v2 asset reference. */
  video?: unknown;
}

export interface PreviewVideo {
  /** filename_prefix of the SaveVideo node. */
  prefix: string;
  fps: number;
  /** The source's sound into the preview (video input only: GetVideoComponents' audio, as the SeedVR2 template does). */
  audio: boolean;
}

export interface FinishGraphArgs {
  plan: FinishPlan;
  models: FinishModels;
  input: FinishGraphInput;
  prompts: FinishPrompts;
  seed: number;
  /** filename_prefix of the save node, e.g. "JustAE/finish/<id>/frame". */
  outputPrefix: string;
  /** JustAE Flow: an 8-bit H.264 MP4 of the same frames, for the comp. */
  preview?: PreviewVideo;
}

export interface FinishGraph {
  workflow: ApiGraph;
  /** The node whose outputs are the finished frames. */
  saveNode: string;
  /** The SaveVideo of the preview, when asked for. */
  previewNode?: string;
}

type Ref = [string, number];

export function buildFinishGraph(args: FinishGraphArgs): FinishGraph {
  const { plan, models, input, prompts, seed, outputPrefix } = args;
  const g: ApiGraph = {};
  let next = 0;
  const add = (class_type: string, inputs: Record<string, unknown>, title: string): string => {
    const id = String(++next);
    g[id] = { class_type, inputs, _meta: { title } };
    return id;
  };
  const out = (id: string, slot = 0): Ref => [id, slot];
  const { frames } = plan;
  const DECODE = decodeOf(plan);

  /* Source frames */
  let src: Ref;
  let parts: string | null = null;
  if (input.framesDir) {
    src = out(add('VHS_LoadImages', {
      directory: input.framesDir,
      image_load_cap: frames.source,
      skip_first_images: 0,
      select_every_nth: 1,
    }, 'Source frames'));
  } else if (input.video !== undefined) {
    const v = add('LoadVideo', { file: input.video }, 'Source video');
    parts = add('GetVideoComponents', { video: out(v) }, 'Frames');
    src = out(add('ImageFromBatch', { image: out(parts), batch_index: 0, length: frames.source }, 'Source range'));
  } else {
    throw new Error('buildFinishGraph: no input (framesDir or video).');
  }

  /* Fast motion: each frame d times, interleaved (a, a, b, b …). */
  if (frames.duplicate > 1) {
    src = out(add('ImageBatchRepeatInterleaving', { images: src, repeats: frames.duplicate }, `Frames ×${frames.duplicate}`));
  }

  /* Pad to 8n+1 with copies of the last frame. */
  if (frames.pad > 0) {
    const last = add('ImageFromBatch', { image: src, batch_index: frames.content - 1, length: 1 }, 'Last frame');
    const pad = add('RepeatImageBatch', { image: out(last), amount: frames.pad }, `Pad ×${frames.pad}`);
    src = out(add('VHS_MergeImages', {
      images_A: src, images_B: out(pad), merge_strategy: 'match A', scale_method: 'bicubic', crop: 'disabled',
    }, `Frames → ${frames.total} (8n+1)`));
  }

  /* Shared loaders */
  const unet = add('UNETLoader', { unet_name: models.transformer, weight_dtype: 'default' }, 'LTX-2.5 distilled');
  const clip = add('CLIPLoader', { clip_name: models.textEncoder, type: 'ltxv', device: 'default' }, 'Gemma-4 12B');
  const vae = add('VAELoader', { vae_name: models.vae }, 'LTX-2.5 video VAE');
  const sampler = add('KSamplerSelect', { sampler_name: SAMPLER }, 'euler');

  let cur: Ref = src;
  plan.passes.forEach((p, i) => {
    const tag = plan.passes.length > 1 ? `${i + 1}. ${p.name}` : p.name;
    const loraFile = models.loras[p.lora];
    if (!loraFile) throw new Error(`No ${p.lora} IC-LoRA file for "${p.name}".`);

    let model: Ref = out(add('LTXICLoRALoaderModelOnly', {
      model: out(unet), lora_name: loraFile, strength_model: 1.0,
    }, `${tag} · IC-LoRA ${p.lora} 1.0`));
    if (p.extraLora) {
      const extra = models.loras[p.extraLora.kind];
      if (!extra) throw new Error(`No ${p.extraLora.kind} IC-LoRA file for "${p.name}".`);
      model = out(add('LTXICLoRALoaderModelOnly', {
        model, lora_name: extra, strength_model: p.extraLora.strength,
      }, `${tag} · IC-LoRA ${p.extraLora.kind} ${p.extraLora.strength}`));
    }

    const restoreText = p.lora === 'restore';
    const pos = add('CLIPTextEncode', { clip: out(clip), text: restoreText ? prompts.restorePositive : prompts.positive }, `${tag} · prompt`);
    const neg = add('CLIPTextEncode', { clip: out(clip), text: restoreText ? prompts.restoreNegative : prompts.negative }, `${tag} · negative`);
    const cond = add('LTXVConditioning', { positive: out(pos), negative: out(neg), frame_rate: plan.conditioningFps }, `${tag} · conditioning`);

    // 1. lanczos to the canvas (the preview resizes to the full canvas and then
    //    cuts its one tile, so the tile is 1:1 with what the full run makes).
    const full = i === 0 && plan.previewCrop ? plan.previewCrop.canvas : p.canvas;
    let image: Ref = out(add('ImageScale', {
      image: cur, upscale_method: 'lanczos', width: full.w, height: full.h, crop: 'disabled',
    }, `${tag} · lanczos ${full.w}×${full.h}`));
    if (i === 0 && plan.previewCrop) {
      const c = plan.previewCrop;
      image = out(add('ImageCrop', { image, width: c.w, height: c.h, x: c.x, y: c.y }, `${tag} · tile ${c.w}×${c.h} at ${c.x},${c.y}`));
    }

    const latent: Ref = p.fromImage
      ? out(add('VAEEncodeTiled', {
        pixels: image, vae: out(vae), tile_size: DECODE.tileSize, overlap: DECODE.overlap,
        temporal_size: DECODE.temporalSize, temporal_overlap: DECODE.temporalOverlap,
      }, `${tag} · encode`))
      : out(add('EmptyLTXVLatentVideo', { width: p.canvas.w, height: p.canvas.h, length: frames.total, batch_size: 1 }, `${tag} · latent`));

    // 2. the IC-LoRA guide: factor 1, one fresh encode per temporal window.
    const guide = add('LTXAddVideoICLoRAGuide', {
      positive: out(cond, 0), negative: out(cond, 1), vae: out(vae), latent, image,
      frame_idx: 0, strength: 1.0, latent_downscale_factor: 1, crop: 'disabled',
      use_tiled_encode: false, tile_size: 256, tile_overlap: 64,
      use_streaming: true, tile_frames: frames.tileFrames,
    }, `${tag} · IC-LoRA guide`);

    // 4. one canvas, overlapping tiles fused after every step.
    const sigmas = add('ManualSigmas', { sigmas: p.sigmas }, `${tag} · sigmas (${p.steps} steps)`);
    const sampled = add('LTXVTiledFusionSampler', {
      model, positive: out(guide, 0), negative: out(guide, 1), latents: out(guide, 2),
      sigmas: out(sigmas), sampler: out(sampler), seed, cfg: CFG,
      tile_width: p.tile.w, tile_height: p.tile.h, overlap_frac: OVERLAP_FRAC, blend_var: BLEND_VAR,
      grid_cycle: GRID_CYCLE, tile_frames: frames.tileFrames, vae: out(vae), canvas_device: 'auto',
    }, `${tag} · Tiled Fusion ${p.grid.x}×${p.grid.y}`);

    // 5. tiled decode.
    cur = out(add('VAEDecodeTiled', {
      samples: out(sampled), vae: out(vae), tile_size: DECODE.tileSize, overlap: DECODE.overlap,
      temporal_size: DECODE.temporalSize, temporal_overlap: DECODE.temporalOverlap,
    }, `${tag} · decode`));
  });

  /* Back to the source's frames and aspect */
  cur = out(add('ImageFromBatch', { image: cur, batch_index: 0, length: frames.content }, 'Cut the pad'));
  if (frames.duplicate > 1) {
    cur = out(add('VHS_SelectEveryNthImage', { images: cur, select_every_nth: frames.duplicate, skip_first_images: 0 }, 'Drop the duplicates'));
  }
  const last = plan.passes[plan.passes.length - 1].canvas;
  if (!plan.previewCrop && (last.w !== plan.delivery.w || last.h !== plan.delivery.h)) {
    cur = out(add('ImageScale', {
      image: cur, upscale_method: 'lanczos', width: plan.delivery.w, height: plan.delivery.h, crop: 'disabled',
    }, `Delivery ${plan.delivery.w}×${plan.delivery.h}`));
  }

  const fmt = plan.options.format === 'exr16'
    ? { format: 'exr', 'format.bit_depth': '16-bit float', 'format.input_color_space': 'sRGB' }
    : { format: 'png', 'format.bit_depth': '16-bit', 'format.input_color_space': 'sRGB' };
  const save = add('SaveImageAdvanced', { images: cur, filename_prefix: outputPrefix, ...fmt },
    plan.options.format === 'exr16' ? 'EXR 16-bit (scene-linear)' : 'PNG 16-bit');

  let previewNode: string | undefined;
  if (args.preview) previewNode = addPreview(add, cur, args.preview, parts);
  return { workflow: g, saveNode: save, previewNode };
}

/**
 * The MP4 of the finished frames: core CreateVideo (8-bit — EffectCraft 0.11.1 decodes 8-bit H.264 only) and
 * SaveVideo, the source's sound carried over from GetVideoComponents as the SeedVR2 template does. Shared with the
 * single-pass graph (core/finishing/single.ts).
 */
export function addPreview(
  add: (class_type: string, inputs: Record<string, unknown>, title: string) => string,
  images: Ref, preview: PreviewVideo, parts: string | null,
): string {
  const video = add('CreateVideo', {
    images, fps: preview.fps, bit_depth: 8,
    ...(preview.audio && parts ? { audio: [parts, 1] as Ref } : {}),
  }, 'Preview video (8-bit)');
  return add('SaveVideo', { video: [video, 0] as Ref, filename_prefix: preview.prefix, format: 'auto', 'format.codec': 'auto' }, 'Preview MP4');
}
