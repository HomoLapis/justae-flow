/**
 * LTX finishing — LTX-2.5 Native Resolution (Tiled Fusion) for a clip or a comp.
 *
 * Pure: no host, no network. Ported from JustAE Flow 2 (client/src/finishing/plan.ts,
 * branch feature/ltx-finishing, 23 Oct 2026) with its logic unchanged; what this
 * repository adds is marked "JustAE Flow:" (two Refine sizes, Restore alone, the
 * local verdict for a 16 GB card — Flow 2 routed big runs to its own cloud, which
 * is not part of this project).
 *
 * Every number below comes from the Lightricks model cards (read again 25 Oct 2026):
 *   huggingface.co/Lightricks/LTX-2.5-22b-IC-LoRA-Refine-Details
 *   huggingface.co/Lightricks/LTX-2.5-22b-IC-LoRA-Restore
 * and from ComfyUI-LTXVideo's own planner (tiled_fusion_plan.py, tiled_fusion_sizes.py,
 * v1.1.0), whose grid this file ports so the tile counts shown before a run are the
 * ones the sampler will actually walk:
 *
 *   canvas          multiple of 32 on both sides
 *   frames          8n+1, the clip padded by at least 8 frames at the end
 *                   (the last frames lose ~10% detail) and trimmed on the way back
 *   tiles           Refine 1024×576, Restore 960×544 (portrait: swapped)
 *   overlap / blend 0.5 / 0.05, grid cycle 1 — never below 0.5
 *   sampler         cfg 1.0, euler, 8 distilled sigmas ending at 0
 *   streaming       always on, tile_frames 97 (the clip itself when shorter)
 *   decode          VAEDecodeTiled 1024 px, overlap 128, temporal 256
 *   8K              refine to 4K, lanczos to 8K, a gentle second pass — never 8K directly
 *
 * The tile grid for 1920×1080 → 1024×576 tiles: Full HD 3×3 = 9, 4K 7×7 = 49,
 * 8K 14×15 = 210 — the counts of the official planner, which is what pins the port.
 */

/* ─── Constants ─────────────────────────────────────────────────────── */

export const SPATIAL_ALIGN = 32;
export const FRAME_STEP = 8;
/** Frames added at the end before encoding and cut on the way back. */
export const PAD_FRAMES = 8;
/** Temporal window of the sampler and the guide node (streaming). */
export const TILE_FRAMES = 97;
export const OVERLAP_FRAC = 0.5;
export const BLEND_VAR = 0.05;
export const GRID_CYCLE = 1;
export const CFG = 1.0;
export const SAMPLER = 'euler';
/** The distilled 8-step schedule from the Refine card. */
export const SIGMAS_8 = '1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0';
/**
 * The 8K second pass starts from the lanczos image, not from noise, so it runs
 * the tail of the schedule only. "medium" is the stage-2 schedule of LTX's own
 * two-stage graphs; "gentle" stops one step earlier. The card says only
 * "optional gentle second pass" — the values are Flow 2's choice.
 */
export const LIGHT_SIGMAS = {
  gentle: '0.725, 0.421875, 0.0',
  medium: '0.909375, 0.725, 0.421875, 0.0',
} as const;
export type LightPass = keyof typeof LIGHT_SIGMAS;

export const DECODE = { tileSize: 1024, overlap: 128, temporalSize: 256, temporalOverlap: 32 } as const;

export const TILE = {
  refine: { w: 1024, h: 576 },
  restore: { w: 960, h: 544 },
} as const;
export type LoraKind = keyof typeof TILE;

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
  {
    id: 'refine-fhd', label: 'Refine Full HD', restore: false,
    hint: 'Detail refine to Full HD in one tiled pass (tiled at every size, as the card says).',
  },
  {
    id: 'refine-4k', label: 'Refine 4K', restore: false,
    hint: 'Detail refine to 4K in one tiled pass. Clean modern footage.',
  },
  {
    id: 'refine-8k', label: '8K progressive', restore: false,
    hint: 'Refine to 4K, lanczos to 8K, then a light refine pass. Never 8K in one go.',
  },
  {
    id: 'refine-same', label: 'Refine (same size)', restore: false,
    hint: 'Rebuilt detail at the source\'s own size: one tiled pass, no upscale.',
  },
  {
    id: 'restore', label: 'Restore', restore: true,
    hint: 'Restore at 1440 (4:3) or 1920×1088 (16:9), one pass: a result on its own, the card says.',
  },
  {
    id: 'restore-refine', label: 'Restore + Refine (1 pass)', restore: true,
    hint: 'Both IC-LoRAs in one pass, Refine at 0.2–0.3. Faster; colour is best sequential.',
  },
  {
    id: 'restore-archive', label: 'Restore archive', restore: true,
    hint: 'Restore at 1440 (4:3) or 1920×1088 (16:9), then lanczos ×2 and Refine.',
  },
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

/** Source frames a preview takes from the start of the clip (M ≤ 49 with the pad). */
export const PREVIEW_FRAMES = 41;

/* ─── Small math ────────────────────────────────────────────────────── */

/** Nearest multiple of 32, ties up, never below 32 — LTX's snap_spatial. */
export function snap32(v: number): number {
  const x = Math.max(SPATIAL_ALIGN, v);
  return Math.max(SPATIAL_ALIGN, Math.floor(x / SPATIAL_ALIGN + 0.5) * SPATIAL_ALIGN);
}

function even(v: number): number {
  return Math.max(2, Math.round(v / 2) * 2);
}

/** Smallest 8n+1 that is ≥ n. */
export function up8n1(n: number): number {
  const k = Math.max(1, Math.ceil(n));
  return Math.ceil((k - 1) / FRAME_STEP) * FRAME_STEP + 1;
}

/**
 * Latent-aligned tile origins covering [0, canvas) with ≥ minOverlap —
 * a line-for-line port of tiled_fusion_plan.plan_grid.
 */
export function planGrid(canvasLat: number, tileLat: number, minOverlap: number): number[] {
  if (canvasLat <= tileLat) return [0];
  const tile = Math.max(1, Math.floor(tileLat));
  const canvas = Math.floor(canvasLat);
  const ov = Math.min(Math.max(0, minOverlap), tile - 1);
  let n = 2;
  while (n < canvas && (n * tile - canvas) / (n - 1) < ov) n += 1;
  const step = (canvas - tile) / (n - 1);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(pyRound(i * step));
  return out;
}

/** Python's round(): halves to even. */
function pyRound(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

export interface TileGrid { x: number; y: number; count: number; tileW: number; tileH: number }

/** Spatial tiles the sampler walks per step (tiled_fusion_sizes.spatial_tile_grid). */
export function tileGrid(canvasW: number, canvasH: number, tileW: number, tileH: number): TileGrid {
  const cw = Math.max(1, Math.floor(canvasW / SPATIAL_ALIGN));
  const ch = Math.max(1, Math.floor(canvasH / SPATIAL_ALIGN));
  const tw = Math.min(Math.max(1, Math.floor(tileW / SPATIAL_ALIGN)), cw);
  const th = Math.min(Math.max(1, Math.floor(tileH / SPATIAL_ALIGN)), ch);
  const x = planGrid(cw, tw, Math.max(2, Math.floor(tw * OVERLAP_FRAC))).length;
  const y = planGrid(ch, th, Math.max(2, Math.floor(th * OVERLAP_FRAC))).length;
  return { x, y, count: x * y, tileW: tw * SPATIAL_ALIGN, tileH: th * SPATIAL_ALIGN };
}

/** Temporal windows for M frames at tile_frames tf (tiled_fusion_plan.temporal_plan). */
export function temporalWindows(frames: number, tileFrames: number): number {
  const nLat = Math.floor((Math.max(1, frames) - 1) / FRAME_STEP) + 1;
  const tfLat = Math.min(nLat, Math.floor((Math.max(1, tileFrames) - 1) / FRAME_STEP) + 1);
  return planGrid(nLat, tfLat, Math.max(0, Math.floor(tfLat * OVERLAP_FRAC))).length;
}

/** The tile for a LoRA, turned for portrait canvases. */
export function tileFor(kind: LoraKind, canvasW: number, canvasH: number): { w: number; h: number } {
  const t = TILE[kind];
  return canvasH > canvasW ? { w: t.h, h: t.w } : { w: t.w, h: t.h };
}

/* ─── The plan ──────────────────────────────────────────────────────── */

export interface Size { w: number; h: number }

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
  tileFrames: number;
  windows: number;
}

export interface PassPlan {
  name: string;
  lora: LoraKind;
  /** A second LoRA loaded into the same pass (Restore + Refine), with its strength. */
  extraLora: { kind: LoraKind; strength: number } | null;
  canvas: Size;
  tile: Size;
  grid: TileGrid;
  sigmas: string;
  steps: number;
  /** True when the pass starts from the encoded previous result (the 8K light pass). */
  fromImage: boolean;
  /** Tile-steps: tiles per step × windows × steps. */
  load: number;
}

export interface FinishPlan {
  options: FinishOptions;
  source: FinishSource;
  frames: FramePlan;
  passes: PassPlan[];
  /** What comes back: the canvas resized (lanczos) to the source's own aspect. */
  delivery: Size;
  /** Where the preview tile sits on the first pass's canvas (preview only). */
  previewCrop: { x: number; y: number; w: number; h: number; canvas: Size } | null;
  /** Fps the model is told (fps × duplicate: the clip as encoded). */
  conditioningFps: number;
  /** Σ pass loads. */
  load: number;
  /** Per pass: tiles/step × windows(97) × steps. */
  loadFormula: string;
  /** Every constraint the plan had to correct, in plain words. */
  fixes: string[];
  warnings: string[];
}

function displaySize(src: FinishSource): Size {
  const par = src.pixelAspect > 0 ? src.pixelAspect : 1;
  return { w: src.width * par, h: src.height };
}

/**
 * The largest size with the source's aspect that fits the UHD box (4K =
 * 3840×2160, 8K = 7680×4320), turned for portrait sources: a 16:9 clip lands
 * on 3840×2160, a 4:3 scan on 2880×2160 — never stretched to fill the box.
 */
function fitBox(d: Size, box: Size): Size {
  const b = d.h > d.w ? { w: box.h, h: box.w } : box;
  const k = Math.min(b.w / d.w, b.h / d.h);
  return { w: even(d.w * k), h: even(d.h * k) };
}

const UHD_4K: Size = { w: 3840, h: 2160 };
/** JustAE Flow: the Full HD box, by the same rule as the 4K one. */
const FULL_HD: Size = { w: 1920, h: 1080 };

function snapSize(s: Size): Size {
  return { w: snap32(s.w), h: snap32(s.h) };
}

/**
 * Archive working size: 1440 wide for 4:3, 1920 for 16:9 (the card: "Do not
 * stretch a 4:3 scan to 16:9"). The aspect decides; portrait mirrors it.
 */
function archiveDelivery(d: Size): Size {
  const portrait = d.h > d.w;
  const aspect = portrait ? d.h / d.w : d.w / d.h;
  const long = aspect < 1.55 ? 1440 : 1920;
  const short = even(long / aspect);
  return portrait ? { w: short, h: long } : { w: long, h: short };
}

export function framePlan(n: number, duplicate: number): FramePlan {
  const source = Math.max(1, Math.round(n));
  const d = Math.max(1, Math.min(4, Math.round(duplicate)));
  const content = source * d;
  const total = up8n1(content + PAD_FRAMES);
  const tileFrames = Math.min(total, TILE_FRAMES);
  return {
    source, duplicate: d, content, total, pad: total - content, tileFrames,
    windows: temporalWindows(total, tileFrames),
  };
}

function pass(
  name: string, lora: LoraKind, canvas: Size, frames: FramePlan,
  opts: { sigmas?: string; fromImage?: boolean; extra?: PassPlan['extraLora']; tileKind?: LoraKind } = {},
): PassPlan {
  const t = tileFor(opts.tileKind ?? lora, canvas.w, canvas.h);
  const grid = tileGrid(canvas.w, canvas.h, t.w, t.h);
  const sigmas = opts.sigmas ?? SIGMAS_8;
  const steps = sigmas.split(',').length - 1;
  return {
    name, lora, extraLora: opts.extra ?? null, canvas, tile: { w: grid.tileW, h: grid.tileH }, grid,
    sigmas, steps, fromImage: !!opts.fromImage, load: grid.count * frames.windows * steps,
  };
}

/**
 * Turn a source and the chosen options into the exact work: canvases, tiles,
 * frames, passes, and every correction made on the way.
 */
export function planFinish(src: FinishSource, options: FinishOptions): FinishPlan {
  const fixes: string[] = [];
  const warnings: string[] = [];
  const d = displaySize(src);
  const preset = presetById(options.preset);

  if (Math.abs((src.pixelAspect || 1) - 1) > 0.001) {
    fixes.push(`Pixel aspect ${src.pixelAspect.toFixed(4)}: the canvas follows the DISPLAY aspect (${Math.round(d.w)}×${d.h}).`);
  }

  const n = options.preview ? Math.min(src.frames, PREVIEW_FRAMES) : src.frames;
  if (options.preview && src.frames > PREVIEW_FRAMES) {
    fixes.push(`Preview: the first ${PREVIEW_FRAMES} of ${src.frames} frames.`);
  }
  const frames = framePlan(n, options.duplicate);
  if (frames.duplicate > 1) {
    fixes.push(`Fast motion: every frame ×${frames.duplicate} before encode (${frames.source} → ${frames.content}), every ${frames.duplicate}th kept after decode.`);
  }
  fixes.push(`Frames ${frames.content} → ${frames.total} (8n+1): ${frames.pad} copies of the last frame added at the end, cut on the way back.`);
  if (frames.windows > 1) {
    fixes.push(`Long clip: streaming in ${frames.windows} temporal windows of ${frames.tileFrames} frames.`);
  }

  const passes: PassPlan[] = [];
  let delivery: Size;

  switch (preset.id) {
    case 'refine-fhd': {
      // JustAE Flow: the 4K rule with the Full HD box.
      delivery = fitBox(d, FULL_HD);
      passes.push(pass('Refine Full HD', 'refine', snapSize(delivery), frames));
      break;
    }
    case 'refine-same': {
      // JustAE Flow: the source's own size — detail rebuilt, nothing upscaled.
      delivery = { w: even(d.w), h: even(d.h) };
      passes.push(pass('Refine', 'refine', snapSize(delivery), frames));
      break;
    }
    case 'refine-4k': {
      delivery = fitBox(d, UHD_4K);
      passes.push(pass('Refine 4K', 'refine', snapSize(delivery), frames));
      break;
    }
    case 'refine-8k': {
      const d4 = fitBox(d, UHD_4K);
      const c4 = snapSize(d4);
      passes.push(pass('Refine 4K', 'refine', c4, frames));
      delivery = { w: d4.w * 2, h: d4.h * 2 };
      // Lanczos ×2 of the 4K canvas: the 8K canvas is exactly twice the 4K one,
      // so the second pass resamples nothing but scale.
      passes.push(pass('Light pass 8K', 'refine', { w: c4.w * 2, h: c4.h * 2 }, frames, {
        sigmas: LIGHT_SIGMAS[options.lightPass], fromImage: true,
      }));
      break;
    }
    case 'restore': {
      // JustAE Flow: the card's stage 1 alone ("a legitimate result on its own").
      const dr = archiveDelivery(d);
      delivery = dr;
      passes.push(pass('Restore', 'restore', snapSize(dr), frames));
      break;
    }
    case 'restore-archive': {
      const dr = archiveDelivery(d);
      const cr = snapSize(dr);
      passes.push(pass('Restore', 'restore', cr, frames));
      delivery = { w: dr.w * 2, h: dr.h * 2 };
      passes.push(pass('Refine ×2', 'refine', { w: cr.w * 2, h: cr.h * 2 }, frames));
      break;
    }
    case 'restore-refine': {
      const dr = archiveDelivery(d);
      delivery = dr;
      passes.push(pass('Restore + Refine', 'restore', snapSize(dr), frames, {
        extra: { kind: 'refine', strength: options.refineInRestore },
      }));
      break;
    }
  }

  const first = passes[0];
  let previewCrop: FinishPlan['previewCrop'] = null;
  if (options.preview) {
    // One tile, 1:1, from the middle of the first pass's canvas — what that
    // pass will make of the centre of the frame, in minutes instead of hours.
    const t = first.tile;
    const x = Math.max(0, Math.floor((first.canvas.w - t.w) / 2 / SPATIAL_ALIGN) * SPATIAL_ALIGN);
    const y = Math.max(0, Math.floor((first.canvas.h - t.h) / 2 / SPATIAL_ALIGN) * SPATIAL_ALIGN);
    previewCrop = { x, y, w: t.w, h: t.h, canvas: first.canvas };
    const only = pass(`${first.name} — preview tile`, first.lora, { w: t.w, h: t.h }, frames, {
      sigmas: first.sigmas, extra: first.extraLora, tileKind: first.lora,
    });
    passes.length = 0;
    passes.push(only);
    if (preset.id === 'refine-8k') warnings.push('The preview shows the 4K refine; the 8K light pass is not previewed.');
    if (preset.id === 'restore-archive') warnings.push('The preview shows the Restore pass; the Refine ×2 after it is not previewed.');
  }

  for (const p of passes) {
    if (p.canvas.w !== Math.round(p.canvas.w) || p.canvas.w % SPATIAL_ALIGN || p.canvas.h % SPATIAL_ALIGN) {
      warnings.push(`${p.name}: canvas ${p.canvas.w}×${p.canvas.h} is not a multiple of 32.`);
    }
  }
  const lastCanvas = passes[passes.length - 1].canvas;
  if (!options.preview && (lastCanvas.w !== delivery.w || lastCanvas.h !== delivery.h)) {
    fixes.push(`Canvas ${lastCanvas.w}×${lastCanvas.h} (multiple of 32) → delivered at ${delivery.w}×${delivery.h}, the source's own aspect (lanczos).`);
  }
  if (options.preview) delivery = { w: first.tile.w, h: first.tile.h };

  if (src.width * (src.pixelAspect || 1) > delivery.w && !options.preview && preset.id !== 'refine-same') {
    warnings.push('The source is already larger than this preset\'s output.');
  }

  const load = passes.reduce((s, p) => s + p.load, 0);
  const loadFormula = passes.map((p) => `${p.name}: ${p.grid.count} tiles/step × ${frames.windows} window${frames.windows === 1 ? '' : 's'} × ${p.steps} steps = ${p.load}`).join(' · ');

  return {
    options, source: src, frames, passes, delivery, previewCrop,
    conditioningFps: src.fps * frames.duplicate,
    load, loadFormula, fixes, warnings,
  };
}

/** One line for a card: how heavy this is, in tile-steps. */
export function describeLoad(plan: FinishPlan): string {
  const tiles = plan.passes.map((p) => `${p.grid.count}`).join(' + ');
  return `${plan.load.toLocaleString('en-US')} tile-steps (${tiles} tiles/step, ${plan.frames.windows} window${plan.frames.windows === 1 ? '' : 's'}${plan.frames.duplicate > 1 ? `, frames ×${plan.frames.duplicate}` : ''})`;
}

/* ─── Where it runs (JustAE Flow) ───────────────────────────────────── */

/** Canvas area above which a 16 GB card is said to be "hours" (Full HD and below are minutes to an hour). */
export const LOCAL_COMFORT_AREA = 1920 * 1088;

/**
 * What a 16 GB card (the RTX 5080 this was measured on) can be asked to do. Lightricks state a 32 GB minimum for
 * LTX-2.5; Flow 2 measured a 1024×576 tile on 16 GB with the NVFP4 transformer and the int8 text encoder, and so
 * did JustAE Flow (core/finishing/estimate.ts). Full HD is the size this machine is tested at; 4K and 8K are allowed,
 * with the estimate and the reason said, never blocked: there is no other place with LTX-2.5 to send them.
 */
export function localVerdict(plan: FinishPlan, quantizedLocal: boolean): { ok: boolean; warnings: string[] } {
  const warnings: string[] = [];
  if (!quantizedLocal) {
    return {
      ok: false,
      warnings: ['The local ComfyUI has no quantized LTX-2.5 transformer (NVFP4 or int8): the bf16 one does not fit a 16 GB card.'],
    };
  }
  const maxArea = Math.max(...plan.passes.map((p) => p.canvas.w * p.canvas.h));
  if (!plan.options.preview && maxArea > LOCAL_COMFORT_AREA) {
    warnings.push('Above Full HD on a 16 GB card this takes hours (the estimate says how many): run it when the machine can be left alone. Lightricks state a 32 GB minimum for LTX-2.5.');
  }
  return { ok: true, warnings };
}
