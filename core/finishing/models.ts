/**
 * Which LTX-2.5 files a server has, read off its own /object_info.
 *
 * Ported from JustAE Flow 2 (client/src/finishing/models.ts): names are matched
 * by pattern, never hard-coded to one file, because a server keeps whatever
 * precision fits its card (NVFP4 / int8 locally, bf16 on a big GPU) and is free to
 * keep files in sub-folders (this machine: models/loras/LTX2.5/). What is missing
 * is reported with where it comes from — every IC-LoRA lives in a gated Hugging
 * Face repo ("Agree and Access"), and JustAE Flow never downloads anything itself.
 *
 * JustAE Flow adds the IC-LoRAs of the LTX-2.5 Creative Lab collection beyond
 * Refine and Restore (file names from each repo's own file list, read 25 Oct 2026).
 */

import type { FinishPlan } from './plan.ts';

/** The part of /object_info this module reads. */
export type NodeCatalog = Record<string, { input?: { required?: Record<string, unknown[]>; optional?: Record<string, unknown[]> }; output?: string[] } | undefined>;

/** Every IC-LoRA JustAE Flow knows the file of. */
export type LoraId = 'refine' | 'restore' | 'deblur' | 'decompression' | 'colorize' | 'cleanplate' | 'alpha' | 'daynight' | 'sdr2hdr';

const HF = 'https://huggingface.co/';

export const LORAS: Record<LoraId, { what: string; file: string; repo: string; patterns: RegExp[] }> = {
  refine: { what: 'IC-LoRA Refine Details', file: 'ltx-2.5-22b-ic-lora-refine-details-1.0.safetensors', repo: 'Lightricks/LTX-2.5-22b-IC-LoRA-Refine-Details', patterns: [/ltx-2\.5.*ic-lora-refine-details/i, /refine-details/i] },
  restore: { what: 'IC-LoRA Restore', file: 'ltx-2.5-22b-ic-lora-restore-1.0.safetensors', repo: 'Lightricks/LTX-2.5-22b-IC-LoRA-Restore', patterns: [/ltx-2\.5.*ic-lora-restore/i, /ic-lora-restore/i] },
  deblur: { what: 'IC-LoRA Deblur', file: 'ltx-2.5-22b-ic-lora-deblur-0.9.safetensors', repo: 'Lightricks/LTX-2.5-22b-IC-LoRA-Deblur', patterns: [/ltx-2\.5.*ic-lora-deblur/i] },
  decompression: { what: 'IC-LoRA Decompression', file: 'ltx-2.5-22b-ic-lora-decompression-0.9.safetensors', repo: 'Lightricks/LTX-2.5-22b-IC-LoRA-Decompression', patterns: [/ltx-2\.5.*ic-lora-decompression/i] },
  colorize: { what: 'IC-LoRA Colorization', file: 'ltx-2.5-22b-ic-lora-colorization-0.9.safetensors', repo: 'Lightricks/LTX-2.5-22b-IC-LoRA-Colorization', patterns: [/ltx-2\.5.*ic-lora-colori[sz]ation/i] },
  cleanplate: { what: 'IC-LoRA Clean Plate', file: 'ltx-2.5-22b-ic-lora-clean-plate-1.0.safetensors', repo: 'Lightricks/LTX-2.5-22b-IC-LoRA-Clean-Plate', patterns: [/ltx-2\.5.*ic-lora-clean-plate/i] },
  alpha: { what: 'IC-LoRA Alpha Gen', file: 'ltx-2.5-22b-ic-lora-alpha-gen-0.9.safetensors', repo: 'Lightricks/LTX-2.5-22b-IC-LoRA-Alpha-Gen', patterns: [/ltx-2\.5.*ic-lora-alpha-gen/i] },
  daynight: { what: 'IC-LoRA Day-To-Night', file: 'ltx-2.5-22b-ic-lora-day-to-night-0.9.safetensors', repo: 'Lightricks/LTX-2.5-22b-IC-LoRA-Day-To-Night', patterns: [/ltx-2\.5.*ic-lora-day-to-night/i] },
  sdr2hdr: { what: 'IC-LoRA SDR-To-HDR', file: 'ltx-2.5-22b-ic-lora-sdr-to-hdr-1.0.safetensors', repo: 'Lightricks/LTX-2.5-22b-IC-LoRA-SDR-To-HDR', patterns: [/ltx-2\.5.*ic-lora-sdr-to-hdr-1/i] },
};

/** The base model files, where the official example workflows download them from (their "Model Links" notes). */
export const BASE_FILES = {
  transformer: { file: 'ltx-2.5-22b-distilled-transformer-bf16.safetensors', directory: 'diffusion_models', url: `${HF}Lightricks/LTX-2.5/blob/main/diffusion_models/ltx-2.5-22b-distilled-transformer-bf16.safetensors` },
  textEncoder: { file: 'gemma4-12b-with-proj-ltx-2.5-bf16.safetensors', directory: 'text_encoders', url: `${HF}Lightricks/LTX-2.5/blob/main/text_encoders/gemma4-12b-with-proj-ltx-2.5-bf16.safetensors` },
  vae: { file: 'ltx-2.5-video-vae-bf16.safetensors', directory: 'vae', url: `${HF}Lightricks/LTX-2.5/blob/main/vae/ltx-2.5-video-vae-bf16.safetensors` },
} as const;

export interface FinishModels {
  transformer: string;
  textEncoder: string;
  vae: string;
  loras: Partial<Record<LoraId, string>>;
}

export interface ModelCheck {
  models: FinishModels | null;
  missing: Array<{ what: string; file: string; repo: string; folder: string }>;
  /** Custom node types the graph needs and the server does not have. */
  missingNodes: string[];
  notes: string[];
}

/** Combo options of one input, in either object_info shape (["a","b"] or ["COMBO",{options}]). */
export function comboOptions(oi: NodeCatalog, node: string, input: string): string[] {
  const n = oi[node];
  const spec = n?.input?.required?.[input] ?? n?.input?.optional?.[input];
  if (!spec) return [];
  const head = spec[0];
  if (Array.isArray(head)) return head.map(String);
  const opts = (spec[1] as { options?: unknown[] } | undefined)?.options;
  return Array.isArray(opts) ? opts.map(String) : [];
}

function pick(options: string[], patterns: RegExp[]): string | null {
  for (const re of patterns) {
    const hit = options.find((o) => re.test(o));
    if (hit) return hit;
  }
  return null;
}

/**
 * Nodes every tiled finishing graph uses. `input`: the frames come from a folder of PNGs (Flow 2, VHS_LoadImages)
 * or from one video file (JustAE Flow, LoadVideo); `preview`: an MP4 is written beside the 16-bit frames.
 */
export function requiredNodes(plan: FinishPlan, input: 'frames' | 'video' = 'frames', preview = false): string[] {
  const core = [
    'UNETLoader', 'CLIPLoader', 'VAELoader', 'CLIPTextEncode', 'ImageScale', 'ImageFromBatch',
    'RepeatImageBatch', 'EmptyLTXVLatentVideo', 'LTXVConditioning', 'ManualSigmas', 'KSamplerSelect',
    'VAEDecodeTiled', 'SaveImageAdvanced',
    // ComfyUI-LTXVideo (the user's install): the sizes, the IC-LoRA loader and guide, the sampler
    'LTXVGetTilingSizes', 'LTXICLoRALoaderModelOnly', 'LTXAddVideoICLoRAGuide', 'LTXVTiledFusionSampler',
    // VideoHelperSuite: batches joined (the pad)
    'VHS_MergeImages',
  ];
  core.push(...(input === 'frames' ? ['VHS_LoadImages'] : ['LoadVideo', 'GetVideoComponents']));
  if (preview) core.push('CreateVideo', 'SaveVideo');
  if (plan.previewCrop) core.push('ImageCrop');
  if (plan.passes.some((p) => p.fromImage)) core.push('VAEEncodeTiled');
  if (plan.frames.duplicate > 1) core.push('ImageBatchRepeatInterleaving', 'VHS_SelectEveryNthImage');
  return core;
}

/**
 * Pick the base files and the IC-LoRAs `needs` on this server.
 *
 * local: NVFP4 (Blackwell) before int8 before bf16 — a 16 GB card cannot hold
 * the bf16 transformer. cloud: bf16 first; NVFP4 needs a Blackwell GPU and is
 * the last resort there.
 */
export function checkFiles(oi: NodeCatalog, needs: LoraId[], where: 'local' | 'cloud'): Omit<ModelCheck, 'missingNodes'> {
  const missing: ModelCheck['missing'] = [];
  const notes: string[] = [];

  const unets = comboOptions(oi, 'UNETLoader', 'unet_name');
  const clips = comboOptions(oi, 'CLIPLoader', 'clip_name');
  const vaes = comboOptions(oi, 'VAELoader', 'vae_name');
  const loras = comboOptions(oi, 'LTXICLoRALoaderModelOnly', 'lora_name');

  const T = /ltx-2\.5.*distilled.*transformer/i;
  const transformer = where === 'local'
    ? pick(unets, [/ltx-2\.5.*distilled.*nvfp4/i, /ltx-2\.5.*distilled.*int8/i, T])
    : pick(unets, [/ltx-2\.5.*distilled.*bf16/i, /ltx-2\.5.*distilled.*int8/i, T]);
  if (!transformer) {
    missing.push({ what: 'LTX-2.5 distilled transformer', file: `${BASE_FILES.transformer.file} (or -comfy-int8-convrot / -nvfp4)`, repo: `${HF}Lightricks/LTX-2.5`, folder: 'models/diffusion_models' });
  } else if (where === 'cloud' && /nvfp4/i.test(transformer)) {
    notes.push(`Only the NVFP4 transformer is on this server (${transformer}): it needs a Blackwell GPU.`);
  }

  const textEncoder = where === 'local'
    ? pick(clips, [/gemma4-12b.*ltx-2\.5.*int8/i, /gemma4-12b.*ltx-2\.5/i])
    : pick(clips, [/gemma4-12b.*ltx-2\.5.*bf16/i, /gemma4-12b.*ltx-2\.5/i]);
  if (!textEncoder) {
    missing.push({ what: 'Gemma-4 12B text encoder for LTX-2.5', file: `${BASE_FILES.textEncoder.file} (or -comfy-int8-convrot)`, repo: `${HF}Lightricks/LTX-2.5`, folder: 'models/text_encoders' });
  }

  // DiffVAE first ("best quality" in the official Model Links); the conv VAE only when it is all there is.
  const vae = pick(vaes, [/ltx-2\.5-video-vae-bf16/i, /ltx-2\.5-video-vae/i]);
  if (!vae) {
    missing.push({ what: 'LTX-2.5 video VAE', file: BASE_FILES.vae.file, repo: `${HF}Lightricks/LTX-2.5`, folder: 'models/vae' });
  } else if (/conv/i.test(vae)) {
    notes.push('Only the conv VAE is on this server: lighter, slightly less detail than the DiffVAE.');
  }

  const found: Partial<Record<LoraId, string>> = {};
  for (const id of [...new Set(needs)]) {
    const l = LORAS[id];
    const f = pick(loras, l.patterns);
    if (f) found[id] = f;
    else missing.push({ what: l.what, file: l.file, repo: HF + l.repo, folder: 'models/loras' });
  }

  const complete = transformer && textEncoder && vae && missing.length === 0;
  return { models: complete ? { transformer, textEncoder, vae, loras: found } : null, missing, notes };
}

/** The IC-LoRAs a tiled plan loads. */
export function lorasOf(plan: FinishPlan): LoraId[] {
  const needs = new Set<LoraId>();
  for (const p of plan.passes) {
    needs.add(p.lora);
    if (p.extraLora) needs.add(p.extraLora.kind);
  }
  return [...needs];
}

/** Flow 2's check for a tiled plan: its nodes, the base files, the IC-LoRAs of its passes. */
export function checkModels(oi: NodeCatalog, plan: FinishPlan, where: 'local' | 'cloud', input: 'frames' | 'video' = 'frames', preview = false): ModelCheck {
  const missingNodes = requiredNodes(plan, input, preview).filter((n) => !oi[n]);
  return { ...checkFiles(oi, lorasOf(plan), where), missingNodes };
}

/** True when a transformer a 16 GB card can hold is on the server (NVFP4 or int8). */
export function hasQuantizedTransformer(oi: NodeCatalog): boolean {
  return comboOptions(oi, 'UNETLoader', 'unet_name').some((o) => /ltx-2\.5.*distilled.*(nvfp4|int8)/i.test(o));
}
