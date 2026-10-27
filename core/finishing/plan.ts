/**
 * LTX finishing — the plan of a Tiled Fusion job (LTX-2.5 with the Refine Details and Restore IC-LoRAs).
 *
 * Pure: no host, no network. The geometry of a run is not computed here: the canvas, the tile, the overlap, the
 * temporal window and the Full HD / 4K / 8K sizes come from the LTX pack's own LTXVGetTilingSizes node (see
 * core/finishing/sizes.ts) — wired into every tiled graph, and asked before the run for what a card shows. This file
 * decides what to ask the pack for (from the model cards), the frames (the cards' rule), the passes, and what JustAE
 * Flow adds around them: the delivery at the source's aspect, the preview tile, the verdict for a 16 GB card.
 *
 * Facts from the Lightricks model cards, kept as data (read 25 and 26 Oct 2026):
 *   huggingface.co/Lightricks/LTX-2.5-22b-IC-LoRA-Refine-Details
 *   huggingface.co/Lightricks/LTX-2.5-22b-IC-LoRA-Restore
 *
 *   frames      8n+1; the clip padded by 8 frames at the end and trimmed after (the last frames of an LTX generation
 *               lose about 10 % of their detail)                                        PAD_FRAMES, FRAME_STEP, up8n1
 *   tiles       the IC-LoRA's trained window: Refine 1024×576, Restore 960×544 (portrait swapped)        CARD_TILE
 *   sampler     cfg 1.0, euler, the 8 distilled sigmas ending at 0, blend 0.05                   CFG, SAMPLER, SIGMAS_8
 *   decode      VAEDecodeTiled 1024 px, overlap 128, temporal 256 (the Refine card)                          DECODE
 *   8K          refine to 4K, lanczos to 8K, an optional gentle second pass — never 8K in one pass     'refine-8k'
 *   archive     Restore first, then Refine at twice the size; or both in one pass, Refine at 0.2–0.3   the restore presets
 */

import type { OutputSizeChoice, Size, TileSizeChoice, TilingRequest, TilingSizes } from './sizes.ts';
import { approxTiles } from './sizes.ts';

export type { Size } from './sizes.ts';

/* ─── Facts from the model cards ────────────────────────────────────── */

/** Frames per latent step: lengths are 8n+1 (the cards). */
export const FRAME_STEP = 8;
/** Frames added at the end before encoding and cut on the way back (the Refine card: "pad the clip by 8 frames and trim"). */
export const PAD_FRAMES = 8;
export const BLEND_VAR = 0.05;
/** The sampler's grid cycle: 1, a fixed grid (its default, and the official workflows' value). */
export const GRID_CYCLE = 1;
export const CFG = 1.0;
export const SAMPLER = 'euler';
/** The distilled 8-step schedule from the Refine card. */
export const SIGMAS_8 = '1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0';
/**
 * The 8K second pass starts from the lanczos image, not from noise, so it runs the tail of the schedule only.
 * "medium" is the stage-2 schedule of LTX's own two-stage graphs; "gentle" stops one step earlier. The card says only
 * "optional gentle second pass" — the values are JustAE Flow 2's choice.
 */
export const LIGHT_SIGMAS = {
  gentle: '0.725, 0.421875, 0.0',
  medium: '0.909375, 0.725, 0.421875, 0.0',
} as const;
export type LightPass = keyof typeof LIGHT_SIGMAS;

/** The Refine card's decode. */
export const DECODE = { tileSize: 1024, overlap: 128, temporalSize: 256, temporalOverlap: 32 } as const;
/**
 * JustAE Flow: the decode the official LTX-2.5 example workflows ship — 512 px tiles, overlap 64, 128 frames, temporal
 * overlap 32 — which the pack's README presents as its setting for machines with less VRAM. Used on a 16 GB card, where
 * the card's 1024 / 128 / 256 decode of a long Full HD clip runs out of memory (measured, see core/finishing/estimate.ts).
 */
export const DECODE_LOW_VRAM = { tileSize: 512, overlap: 64, temporalSize: 128, temporalOverlap: 32 } as const;
export type DecodeProfile = 'card' | 'low-vram';

/** The decode a plan asks for (the Refine card's, unless the options ask for the low-VRAM one). */
export function decodeOf(plan: { options: { decode?: DecodeProfile } }): { tileSize: number; overlap: number; temporalSize: number; temporalOverlap: number } {
  return plan.options.decode === 'low-vram' ? DECODE_LOW_VRAM : DECODE;
}

/** The window each IC-LoRA was trained on (its card). Shown next to the pack's tile; the sampler gets the pack's. */
export const CARD_TILE = {
  refine: { w: 1024, h: 576 },
  restore: { w: 960, h: 544 },
} as const;
export type LoraKind = keyof typeof CARD_TILE;

/**
 * Which of the pack's tile sizes a LoRA asks for. LTXVGetTilingSizes offers qHD, HD and FullHD (960, 1280 and 1920 on
 * the long edge, its tooltip); qHD is the nearest to both trained windows — the Restore card's 960×544 itself on a
 * 16:9 frame, the Refine card's 1024×576 at 89 % of its area (HD would be 160 %). The official Upscale workflow ships HD.
 */
export const TILE_CHOICE: Record<LoraKind, TileSizeChoice> = { refine: 'qHD', restore: 'qHD' };

/* ─── Presets ───────────────────────────────────────────────────────── */

export type FinishPresetId = 'refine-fhd' | 'refine-4k' | 'refine-8k' | 'refine-same' | 'restore' | 'restore-refine' | 'restore-archive';

export interface FinishPreset {
  id: FinishPresetId;
  label: string;
  hint: string;
  /** True when the preset starts with Restore (archive material). */
  restore: boolean;
}

export const FINISH_PRESETS: FinishPreset[] = [
  { id: 'refine-fhd', label: 'Refine Full HD', restore: false, hint: 'Detail refine to the pack\'s Full HD canvas in one tiled pass (tiled at every size, as the card says).' },
  { id: 'refine-4k', label: 'Refine 4K', restore: false, hint: 'Detail refine to the pack\'s 4K canvas in one tiled pass. Clean modern footage.' },
  { id: 'refine-8k', label: '8K progressive', restore: false, hint: 'Refine to 4K, lanczos to 8K, then a light refine pass. Never 8K in one go.' },
  { id: 'refine-same', label: 'Refine (same size)', restore: false, hint: 'Rebuilt detail on the pack\'s canvas nearest the source: one tiled pass, delivered at the source\'s size.' },
  { id: 'restore', label: 'Restore', restore: true, hint: 'Restore on the pack\'s Full HD canvas, one pass: a result on its own, the card says.' },
  { id: 'restore-refine', label: 'Restore + Refine (1 pass)', restore: true, hint: 'Both IC-LoRAs in one pass, Refine at 0.2–0.3. Faster; colour is best sequential.' },
  { id: 'restore-archive', label: 'Restore archive', restore: true, hint: 'Restore on the Full HD canvas, then Refine on the 4K one (twice the size).' },
];

export function presetById(id: FinishPresetId): FinishPreset {
  return FINISH_PRESETS.find((p) => p.id === id) ?? FINISH_PRESETS[0];
}

/* ─── Inputs ────────────────────────────────────────────────────────── */

export interface FinishSource {
  /** Pixels as stored. */
  width: number;
  height: number;
  /** Footage pixel aspect (DV 0.9091, square 1). */
  pixelAspect: number;
  /** Frames of the visible range, N. */
  frames: number;
  fps: number;
}

export type OutputFormat = 'png16' | 'exr16';
export type Deinterlace = 'none' | 'tff' | 'bff' | 'ivtc';

export interface FinishOptions {
  preset: FinishPresetId;
  /** One tile at 1:1 of the first pass, short — a look before the full run. */
  preview: boolean;
  /** Fast motion: every frame repeated d times before encode, every d-th kept after decode. */
  duplicate: 1 | 2 | 3 | 4;
  /** Refine strength in the single-pass Restore + Refine (card: 0.2 to 0.3). */
  refineInRestore: 0.2 | 0.3;
  lightPass: LightPass;
  format: OutputFormat;
  /** Archive only: applied with ffmpeg before upload. */
  deinterlace: Deinterlace;
  /** JustAE Flow: the decode profile (absent: the Refine card's 1024 / 128 / 256). */
  decode?: DecodeProfile;
}

export const DEFAULT_OPTIONS: FinishOptions = {
  preset: 'refine-4k',
  preview: true,
  duplicate: 1,
  refineInRestore: 0.2,
  lightPass: 'gentle',
  format: 'png16',
  deinterlace: 'none',
};

/** Source frames a preview takes from the start of the clip (49 with the pad: one short window). */
export const PREVIEW_FRAMES = 41;

/* ─── Frames: the cards' rule ───────────────────────────────────────── */

/** Smallest 8n+1 that is ≥ n. */
export function up8n1(n: number): number {
  const k = Math.max(1, Math.ceil(n));
  return Math.ceil((k - 1) / FRAME_STEP) * FRAME_STEP + 1;
}

function even(v: number): number {
  return Math.max(2, Math.round(v / 2) * 2);
}

export interface FramePlan {
  /** Frames of the source range (N). */
  source: number;
  duplicate: number;
  /** N × d: what the model sees before the pad. */
  content: number;
  /** M = 8n+1 ≥ content + 8. */
  total: number;
  /** M − content, ≥ 8: copies of the last frame, cut after decode. */
  pad: number;
}

export function framePlan(n: number, duplicate: number): FramePlan {
  const source = Math.max(1, Math.round(n));
  const d = Math.max(1, Math.min(4, Math.round(duplicate)));
  const content = source * d;
  const total = up8n1(content + PAD_FRAMES);
  return { source, duplicate: d, content, total, pad: total - content };
}

/* ─── The plan ──────────────────────────────────────────────────────── */

/** What one pass asks LTXVGetTilingSizes for, and which of its canvases the pass runs on. */
export interface PassTiling {
  tileSize: TileSizeChoice;
  initialCanvas: TileSizeChoice;
  outputSize: OutputSizeChoice;
  /** 'output': the node's output_width × output_height (the single-stage workflows' canvas); 'initial': its initial canvas. */
  canvas: 'output' | 'initial';
}

export interface PassPlan {
  name: string;
  lora: LoraKind;
  /** A second LoRA loaded into the same pass (Restore + Refine), with its strength. */
  extraLora: { kind: LoraKind; strength: number } | null;
  tiling: PassTiling;
  /** The pack's answer for this pass, when it was asked before the run; null: the sizes come at run time. */
  sizes: TilingSizes | null;
  /** The canvas the pass runs on (the pack's), or null without sizes. For a preview tile: the tile. */
  canvas: Size | null;
  /** The pack's tile, or null without sizes. */
  tile: Size | null;
  /** The tile grid the pack reports for that canvas (its summary), or null. */
  grid: { x: number; y: number } | null;
  /** JustAE Flow's clean-room count for the time estimate (core/finishing/sizes.ts), or null without sizes. */
  approx: { x: number; y: number; spatial: number; temporal: number } | null;
  sigmas: string;
  steps: number;
  /** True when the pass starts from the encoded previous result (the 8K light pass). */
  fromImage: boolean;
  /** Tile-steps for the estimate: approx.spatial × approx.temporal × steps (null without sizes). */
  load: number | null;
}

export interface FinishPlan {
  options: FinishOptions;
  source: FinishSource;
  frames: FramePlan;
  passes: PassPlan[];
  /** The source's display size: what the pack is asked about. */
  display: Size;
  /** True when every pass has the pack's sizes. */
  sized: boolean;
  /** What comes back: the source's aspect, fitted inside the last canvas (lanczos); null without sizes. */
  delivery: Size | null;
  /** Where the preview tile sits on the first pass's canvas (preview only, with sizes). */
  previewCrop: { x: number; y: number; w: number; h: number; canvas: Size } | null;
  /** Fps the model is told (fps × duplicate: the clip as encoded). */
  conditioningFps: number;
  /** Σ pass loads (the estimate's count), or null without sizes. */
  load: number | null;
  loadFormula: string;
  /** Every constraint the plan had to correct, in plain words. */
  fixes: string[];
  warnings: string[];
  /** Model-card facts set beside the pack's sizes (tile trained on, canvas the card names). */
  notes: string[];
}

function displaySize(src: FinishSource): Size {
  const par = src.pixelAspect > 0 ? src.pixelAspect : 1;
  return { w: Math.round(src.width * par), h: src.height };
}

/** The source's aspect inside a canvas: the largest even size that fits it (JustAE Flow's delivery). */
function fitInside(d: Size, c: Size): Size {
  const k = Math.min(c.w / d.w, c.h / d.h);
  return { w: Math.min(c.w, even(d.w * k)), h: Math.min(c.h, even(d.h * k)) };
}

/**
 * "Same size": the pack's canvas nearest the source. Up to about Full HD its initial canvas (qHD 960, HD 1280, FullHD
 * 1920 on the long edge — the pack keeps a source close to one of them as it is); above, its 4K or 8K output.
 */
function sameTiling(d: Size, tileSize: TileSizeChoice): PassTiling {
  const long = Math.max(d.w, d.h);
  if (long <= 1120) return { tileSize, initialCanvas: 'qHD', outputSize: 'FullHD', canvas: 'initial' };
  if (long <= 1600) return { tileSize, initialCanvas: 'HD', outputSize: 'FullHD', canvas: 'initial' };
  if (long <= 2880) return { tileSize, initialCanvas: 'FullHD', outputSize: 'FullHD', canvas: 'initial' };
  return { tileSize, initialCanvas: 'FullHD', outputSize: long <= 5760 ? '4K' : '8K', canvas: 'output' };
}

const at = (outputSize: OutputSizeChoice, tileSize: TileSizeChoice): PassTiling => ({ tileSize, initialCanvas: 'FullHD', outputSize, canvas: 'output' });

interface PassSpec { name: string; lora: LoraKind; extra?: PassPlan['extraLora']; tiling: PassTiling; sigmas?: string; fromImage?: boolean }

function passSpecs(preset: FinishPresetId, d: Size, o: FinishOptions): PassSpec[] {
  const R = TILE_CHOICE.refine;
  const S = TILE_CHOICE.restore;
  switch (preset) {
    case 'refine-fhd': return [{ name: 'Refine Full HD', lora: 'refine', tiling: at('FullHD', R) }];
    case 'refine-4k': return [{ name: 'Refine 4K', lora: 'refine', tiling: at('4K', R) }];
    case 'refine-same': return [{ name: 'Refine', lora: 'refine', tiling: sameTiling(d, R) }];
    // The card: refine to 4K, lanczos to 8K, a gentle second pass — the 8K canvas is the pack's.
    case 'refine-8k': return [
      { name: 'Refine 4K', lora: 'refine', tiling: at('4K', R) },
      { name: 'Light pass 8K', lora: 'refine', tiling: at('8K', R), sigmas: LIGHT_SIGMAS[o.lightPass], fromImage: true },
    ];
    case 'restore': return [{ name: 'Restore', lora: 'restore', tiling: at('FullHD', S) }];
    // The card: Restore, then Refine at twice the size — the pack's 4K is twice its Full HD step (its tooltip).
    case 'restore-archive': return [
      { name: 'Restore', lora: 'restore', tiling: at('FullHD', S) },
      { name: 'Refine ×2', lora: 'refine', tiling: at('4K', R) },
    ];
    case 'restore-refine': return [{ name: 'Restore + Refine', lora: 'restore', extra: { kind: 'refine', strength: o.refineInRestore }, tiling: at('FullHD', S) }];
  }
}

/** The LTXVGetTilingSizes requests a plan needs, one per pass (deduplicated). */
export function tilingRequests(src: FinishSource, options: FinishOptions): TilingRequest[] {
  const d = displaySize(src);
  const n = options.preview ? Math.min(src.frames, PREVIEW_FRAMES) : src.frames;
  const frames = framePlan(n, options.duplicate);
  const seen = new Set<string>();
  const out: TilingRequest[] = [];
  const specs = passSpecs(presetById(options.preset).id, d, options);
  for (const s of options.preview ? specs.slice(0, 1) : specs) {
    const r = passRequest(d, frames.total, s.tiling);
    const k = JSON.stringify(r);
    if (!seen.has(k)) { seen.add(k); out.push(r); }
  }
  return out;
}

/** The LTXVGetTilingSizes request of one pass. */
export function passRequest(display: Size, frames: number, t: PassTiling): TilingRequest {
  return { width: display.w, height: display.h, frames, tileSize: t.tileSize, initialCanvas: t.initialCanvas, outputSize: t.outputSize };
}

function canvasOf(s: TilingSizes, t: PassTiling): Size {
  return t.canvas === 'initial' ? s.canvas : s.output;
}

function gridOf(s: TilingSizes, t: PassTiling): { x: number; y: number } | null {
  return t.canvas === 'initial' ? s.gridCanvas : s.gridOutput;
}

const turned = (t: { w: number; h: number }, portrait: boolean): Size => (portrait ? { w: t.h, h: t.w } : { w: t.w, h: t.h });

/**
 * Turn a source and the chosen options into the work: the passes, what each asks the LTX pack for, the frames, and —
 * when `sizes` has the pack's answers (asked before the run) — the canvases, tiles, delivery and the estimate's count.
 */
export function planFinish(src: FinishSource, options: FinishOptions, sizes?: (r: TilingRequest) => TilingSizes | null): FinishPlan {
  const fixes: string[] = [];
  const warnings: string[] = [];
  const notes: string[] = [];
  const d = displaySize(src);
  const preset = presetById(options.preset);

  if (Math.abs((src.pixelAspect || 1) - 1) > 0.001) {
    fixes.push(`Pixel aspect ${src.pixelAspect.toFixed(4)}: the pack is asked about the DISPLAY size (${d.w}×${d.h}).`);
  }
  const n = options.preview ? Math.min(src.frames, PREVIEW_FRAMES) : src.frames;
  if (options.preview && src.frames > PREVIEW_FRAMES) fixes.push(`Preview: the first ${PREVIEW_FRAMES} of ${src.frames} frames.`);
  const frames = framePlan(n, options.duplicate);
  if (frames.duplicate > 1) {
    fixes.push(`Fast motion: every frame ×${frames.duplicate} before encode (${frames.source} → ${frames.content}), every ${frames.duplicate}th kept after decode.`);
  }
  fixes.push(`Frames ${frames.content} → ${frames.total} (8n+1): ${frames.pad} copies of the last frame added at the end, cut on the way back.`);

  const portrait = d.h > d.w;
  let specs = passSpecs(preset.id, d, options);
  if (options.preview) specs = specs.slice(0, 1);
  const passes: PassPlan[] = specs.map((s) => {
    const sz = sizes?.(passRequest(d, frames.total, s.tiling)) ?? null;
    const sigmas = s.sigmas ?? SIGMAS_8;
    const steps = sigmas.split(',').length - 1;
    const canvas = sz ? canvasOf(sz, s.tiling) : null;
    const approx = sz && canvas ? approxTiles(canvas, sz, frames.total) : null;
    return {
      name: s.name, lora: s.lora, extraLora: s.extra ?? null, tiling: s.tiling, sizes: sz, canvas, tile: sz?.tile ?? null,
      grid: sz ? gridOf(sz, s.tiling) : null, approx, sigmas, steps, fromImage: !!s.fromImage,
      load: approx ? approx.spatial * approx.temporal * steps : null,
    };
  });
  const sized = passes.every((p) => p.sizes);

  // The cards' facts beside the pack's sizes.
  for (const p of passes) {
    if (!p.tile) continue;
    const card = turned(CARD_TILE[p.lora], portrait);
    if (p.tile.w !== card.w || p.tile.h !== card.h) {
      notes.push(`${p.name}: the LTX pack's ${p.tiling.tileSize} tile here is ${p.tile.w}×${p.tile.h}; the ${p.lora === 'refine' ? 'Refine' : 'Restore'} card trained on ${card.w}×${card.h}.`);
      if (Math.abs(p.tile.w / p.tile.h - card.w / card.h) > 0.15 * (card.w / card.h)) {
        warnings.push(`${p.name}: on this frame the pack's tile (${p.tile.w}×${p.tile.h}) has another shape than the ${card.w}×${card.h} its IC-LoRA trained on (it follows the source's aspect).`);
      }
    }
  }
  if (preset.restore && passes[0].canvas) {
    const aspect = d.w / d.h;
    if (aspect > 1.2 && aspect < 1.5) {
      notes.push(`The Restore card works a 4:3 source at 1440 wide (1440×1056 or 1440×1088); the LTX pack's Full HD canvas for it is ${passes[0].canvas.w}×${passes[0].canvas.h}.`);
    }
  }

  let previewCrop: FinishPlan['previewCrop'] = null;
  if (options.preview) {
    if (preset.id === 'refine-8k') warnings.push('The preview shows the 4K refine; the 8K light pass is not previewed.');
    if (preset.id === 'restore-archive') warnings.push('The preview shows the Restore pass; the Refine ×2 after it is not previewed.');
    const first = passes[0];
    if (first.canvas && first.tile) {
      // One tile, 1:1, from the middle of the first pass's canvas (on the 32-pixel grid of the model's latent).
      const c = first.canvas;
      const t = first.tile;
      const x = Math.max(0, Math.floor((c.w - t.w) / 2 / 32) * 32);
      const y = Math.max(0, Math.floor((c.h - t.h) / 2 / 32) * 32);
      previewCrop = { x, y, w: t.w, h: t.h, canvas: c };
      first.name = `${first.name} — preview tile`;
      first.canvas = { w: t.w, h: t.h };
      first.grid = { x: 1, y: 1 };
      first.approx = { x: 1, y: 1, spatial: 1, temporal: first.approx?.temporal ?? 1 };
      first.load = first.approx.temporal * first.steps;
    }
  }

  let delivery: Size | null = null;
  const last = passes[passes.length - 1];
  if (options.preview) delivery = previewCrop ? { w: previewCrop.w, h: previewCrop.h } : null;
  else if (last.canvas) {
    delivery = preset.id === 'refine-same' ? { w: even(d.w), h: even(d.h) } : fitInside(d, last.canvas);
    if (delivery.w !== last.canvas.w || delivery.h !== last.canvas.h) {
      fixes.push(`Canvas ${last.canvas.w}×${last.canvas.h} (the LTX pack's) → delivered at ${delivery.w}×${delivery.h}, the source's own aspect (lanczos).`);
    }
  }
  const chunks = passes[0].sizes?.chunks ?? null;
  if (chunks && chunks > 1) fixes.push(`Long clip: the pack streams it in ${chunks} temporal windows of ${passes[0].sizes!.tileFrames} frames.`);
  if (delivery && !options.preview && d.w > delivery.w && preset.id !== 'refine-same') {
    warnings.push('The source is already larger than this preset\'s output.');
  }

  const load = sized ? passes.reduce((s, p) => s + (p.load ?? 0), 0) : null;
  const loadFormula = sized
    ? passes.map((p) => `${p.name}: ≈ ${p.approx!.spatial} tiles × ${p.approx!.temporal} window${p.approx!.temporal === 1 ? '' : 's'} × ${p.steps} steps = ${p.load}`).join(' · ')
    : '';

  return {
    options, source: src, frames, passes, display: d, sized, delivery, previewCrop,
    conditioningFps: src.fps * frames.duplicate, load, loadFormula, fixes, warnings, notes,
  };
}

/** One line for a card: the tiles the pack reports, the estimate's tile-steps. */
export function describeLoad(plan: FinishPlan): string {
  if (!plan.sized) return 'sizes from the LTX pack at run time';
  const tiles = plan.passes.map((p) => (p.grid ? `${p.grid.x}×${p.grid.y}` : `≈ ${p.approx!.spatial}`)).join(' + ');
  return `${tiles} tiles (the LTX pack), ≈ ${plan.load!.toLocaleString('en-US')} tile-steps${plan.frames.duplicate > 1 ? `, frames ×${plan.frames.duplicate}` : ''}`;
}

/* ─── Where it runs (JustAE Flow) ───────────────────────────────────── */

/**
 * What a 16 GB card (the RTX 5080 this was measured on) can be asked to do. Lightricks state a 32 GB minimum for
 * LTX-2.5; Flow 2 measured a 1024×576 tile on 16 GB with the NVFP4 transformer and the int8 text encoder, and so did
 * JustAE Flow (core/finishing/estimate.ts). Full HD is the size this machine is tested at; 4K and 8K are allowed, with
 * the estimate and the reason said, never blocked: there is no other place with LTX-2.5 to send them.
 */
/** `quantizedLocal`: a transformer this GPU may take is there (models.ts fitsLocally: quantized, or bf16 on 32 GB or more). */
export function localVerdict(plan: FinishPlan, quantizedLocal: boolean): { ok: boolean; warnings: string[] } {
  const warnings: string[] = [];
  if (!quantizedLocal) {
    return {
      ok: false,
      warnings: ['The local ComfyUI has no quantized LTX-2.5 transformer (NVFP4 or int8), and the bf16 one needs a GPU with 32 GB or more.'],
    };
  }
  const big = plan.passes.some((p) => p.tiling.canvas === 'output' && p.tiling.outputSize !== 'FullHD');
  if (!plan.options.preview && big) {
    warnings.push('Above Full HD on a 16 GB card this takes hours (the estimate says how many): run it when the machine can be left alone. Lightricks state a 32 GB minimum for LTX-2.5.');
  }
  return { ok: true, warnings };
}
