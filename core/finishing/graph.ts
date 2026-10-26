/**
 * The tiled finishing graph, in ComfyUI API format, built from a plan.
 *
 * From JustAE Flow 2 (client/src/finishing/graph.ts, the author's own app); JustAE Flow adds the MP4 preview beside the
 * 16-bit frames (the comp shows the preview, the frames are the master) and takes the clip as one video file.
 *
 * One graph per job, every pass inside it, so a job is one prompt id and an 8K job never leaves a half-done 4K on the
 * server.
 *
 * Per pass, the node chain of the official LTX-2.5_V2V_TiledFusion_Upscale workflow (ComfyUI-LTXVideo 1.1.0,
 * example_workflows/2.5 — used as the description of the nodes' interface; none of its files is included here):
 *
 *   LTXVGetTilingSizes ─ canvas ─→ ImageScale lanczos ─────────────┬─ LTXAddVideoICLoRAGuide ──┐
 *         │            └ canvas ─→ EmptyLTXVLatentVideo ────────────┘   (tile_frames ←)         │
 *         └ tile_width, tile_height, overlap_frac, tile_frames ────→ LTXVTiledFusionSampler ←───┘ → VAEDecodeTiled
 *   UNET ─ LTXICLoRALoaderModelOnly 1.0 ─────────────────────────────↗  ManualSigmas, KSamplerSelect euler
 *
 * The geometry is the pack's: every size above comes from that pass's LTXVGetTilingSizes node at run time. The node is
 * given the same numbers the card asked it before the run (the display size, the padded frame count, the size
 * choices), so what the card said is what runs.
 *
 * Around it: the clip in (one video), duplicated for fast motion, padded with copies of the last frame to 8n+1, and on
 * the way out trimmed, de-duplicated, resized to the source's aspect and saved as 16-bit PNG or EXR — never only
 * SaveVideo's MP4 (the card: it "understates the result").
 */

import { BLEND_VAR, CFG, GRID_CYCLE, SAMPLER, decodeOf, passRequest, type FinishPlan } from './plan.ts';
import { TILING_NODE, TILING_OUT, tilingInputs } from './sizes.ts';
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

    // 0. the pack's sizes for this pass (the request the card asked before the run).
    const tiling = add(TILING_NODE, tilingInputs(passRequest(plan.display, frames.total, p.tiling)),
      `${tag} · LTX pack sizes (${p.tiling.canvas === 'initial' ? `${p.tiling.initialCanvas} canvas` : p.tiling.outputSize}, ${p.tiling.tileSize} tiles)`);
    const T = (slot: number): Ref => out(tiling, slot);
    const canvasW = T(p.tiling.canvas === 'initial' ? TILING_OUT.canvasW : TILING_OUT.outputW);
    const canvasH = T(p.tiling.canvas === 'initial' ? TILING_OUT.canvasH : TILING_OUT.outputH);

    // 1. lanczos to the pack's canvas (a preview resizes to the full canvas and then cuts its one tile, so the tile is
    //    1:1 with what the full run makes).
    let image: Ref = out(add('ImageScale', {
      image: cur, upscale_method: 'lanczos', width: canvasW, height: canvasH, crop: 'disabled',
    }, `${tag} · lanczos to the pack's canvas`));
    const crop = i === 0 ? plan.previewCrop : null;
    if (i === 0 && plan.options.preview && !crop) throw new Error('buildFinishGraph: a preview tile needs the LTX pack sizes first (asked before the run).');
    if (crop) {
      image = out(add('ImageCrop', {
        image, width: T(TILING_OUT.tileW), height: T(TILING_OUT.tileH), x: crop.x, y: crop.y,
      }, `${tag} · tile ${crop.w}×${crop.h} at ${crop.x},${crop.y}`));
    }
    const latentW = crop ? T(TILING_OUT.tileW) : canvasW;
    const latentH = crop ? T(TILING_OUT.tileH) : canvasH;

    const latent: Ref = p.fromImage
      ? out(add('VAEEncodeTiled', {
        pixels: image, vae: out(vae), tile_size: DECODE.tileSize, overlap: DECODE.overlap,
        temporal_size: DECODE.temporalSize, temporal_overlap: DECODE.temporalOverlap,
      }, `${tag} · encode`))
      : out(add('EmptyLTXVLatentVideo', { width: latentW, height: latentH, length: frames.total, batch_size: 1 }, `${tag} · latent`));

    // 2. the IC-LoRA guide: factor 1, one fresh encode per temporal window of the pack's length.
    const guide = add('LTXAddVideoICLoRAGuide', {
      positive: out(cond, 0), negative: out(cond, 1), vae: out(vae), latent, image,
      frame_idx: 0, strength: 1.0, latent_downscale_factor: 1, crop: 'disabled',
      use_tiled_encode: false, tile_size: 256, tile_overlap: 64,
      use_streaming: true, tile_frames: T(TILING_OUT.tileFrames),
    }, `${tag} · IC-LoRA guide`);

    // 3. one canvas, overlapping tiles fused after every step — tiles, overlap and window from the pack.
    const sigmas = add('ManualSigmas', { sigmas: p.sigmas }, `${tag} · sigmas (${p.steps} steps)`);
    const sampled = add('LTXVTiledFusionSampler', {
      model, positive: out(guide, 0), negative: out(guide, 1), latents: out(guide, 2),
      sigmas: out(sigmas), sampler: out(sampler), seed, cfg: CFG,
      tile_width: T(TILING_OUT.tileW), tile_height: T(TILING_OUT.tileH), overlap_frac: T(TILING_OUT.overlapFrac), blend_var: BLEND_VAR,
      grid_cycle: GRID_CYCLE, tile_frames: T(TILING_OUT.tileFrames), vae: out(vae), canvas_device: 'auto',
    }, `${tag} · Tiled Fusion${p.grid ? ` ${p.grid.x}×${p.grid.y}` : ''}`);

    // 4. tiled decode.
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
  // The delivery needs the pack's canvas known before the run; without it the frames stay on the pack's canvas.
  if (!plan.previewCrop && plan.delivery && last && (last.w !== plan.delivery.w || last.h !== plan.delivery.h)) {
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
