/**
 * The Comp tab's LTX finishing tools (PLAN v3 §4.2b): LTX-2.5 with the IC-LoRAs
 * of Lightricks' Creative Lab, each one only where its model card documents how
 * it is driven (read 25 Oct 2026).
 *
 *   Upscale ▸ LTX Refine   Refine Details, Tiled Fusion to Full HD / 4K / 8K (8K always through 4K), or the same size
 *   Archive restore        Restore 100 %, optionally + Refine 30 % in the same pass, or Restore then Refine ×2
 *   Deblur · De-compression · Colorize · Clean plate · Day → Night
 *                          single-pass IC-LoRAs, at the size and in the sentence their cards give
 *   Cut-out ▸ LTX Alpha    Alpha Gen: a luma matte (white = foreground) like SAM 3's
 *   SDR → HDR              the SDR-To-HDR IC-LoRA with its scene embedding: an EXR (ACEScg) master and an HLG video
 *
 * The five rules the cards carry, from the user (PLAN v3 §4.2b): 8K goes through 4K; archive is Restore first, then
 * Refine; "Fast scene" duplicates frames before and removes them after; the prompt is a "Look" — rendering, not
 * subjects — and is checked; delivery is a 16-bit PNG (or EXR) master, the MP4 only a preview.
 *
 * Plans here are what a card says before it runs; the engine plans again with the exact frame count it reads from
 * the file, and checks the local ComfyUI's nodes and files (server/engine.ts, finishingTool). The tiled cards' sizes —
 * canvas, tiles, windows, and so the output size and the time — are the LTX pack's (LTXVGetTilingSizes), asked by the
 * server on the local ComfyUI and passed in as `extra.tiling`; without them the card says they come at run time.
 */

import {
  DEFAULT_OPTIONS, planFinish, type FinishOptions, type FinishPlan, type FinishPresetId,
} from '../finishing/plan.ts';
import { SIZES_AT_RUN_TIME } from '../finishing/sizes.ts';
import { describeIssues, lintPrompt, LINT_EXPLAINED, DEFAULT_PROMPTS } from '../finishing/prompt.ts';
import { planSingle, SINGLE, type SingleLora } from '../finishing/single.ts';
import { HDR_MAX_CONDITIONING_FPS, planHdr } from '../finishing/hdr.ts';
import { describeFinishEstimate, estimateFinish, estimateSingle } from '../finishing/estimate.ts';
import { LTX_LICENCE_LINE, LTX_LICENCE_URL } from '../finishing/licence.ts';
import { fmt, needsVideo, opt, what, type SourceInfo, type ToolDef, type ToolExtra, type ToolOptions, type ToolPlan } from './common.ts';

/** The licence line every LTX finishing card carries. */
export const LTX_CARD_LICENCE = { line: LTX_LICENCE_LINE, url: LTX_LICENCE_URL };
const LICENCE = LTX_CARD_LICENCE;

/**
 * The cards (Restore, Clean Plate) say to put what must not appear in the negative prompt. These graphs run at guidance
 * 1.0, as the cards recommend, and at 1.0 ComfyUI does not evaluate the negative at all (its cfg-1 optimisation,
 * comfy/samplers.py, which LTXVTiledFusionSampler's guider goes through): said on the cards, instead of a field that
 * would do nothing. Measured 26 Oct: a Restore with "lettering" in its negative painted a number on the sail.
 */
const NEGATIVE_NOTE = 'No "must not appear" field: at guidance 1.0 (the card\'s setting) ComfyUI does not evaluate a negative prompt, so the card\'s advice to list prohibitions there has no effect here — describe the period and the light in the Look instead.';

/** "Fast scene": every frame ×2 or ×3 before the model, the copies removed after (Flow 2 verified ×1–×4 in order). */
const FAST = [1, 2, 3] as const;

export const LTX_SIZES = { fhd: 'Full HD', '4k': '4K', '8k': '8K', same: 'same size' } as const;
type LtxSize = keyof typeof LTX_SIZES;
const PRESET_OF: Record<LtxSize, FinishPresetId> = { fhd: 'refine-fhd', '4k': 'refine-4k', '8k': 'refine-8k', same: 'refine-same' };

export const RESTORE_MODES = { restore: 'Restore', 'restore-refine': 'Restore + Refine 30 %', archive: 'Restore, then Refine ×2' } as const;
type RestoreMode = keyof typeof RESTORE_MODES;
const RESTORE_PRESET: Record<RestoreMode, FinishPresetId> = { restore: 'restore', 'restore-refine': 'restore-refine', archive: 'restore-archive' };

/** What the engine needs to plan a run again: the tiled preset and options, or the single-pass LoRA and size. */
export type FinishSpec =
  | { kind: 'tiled'; workflowId: string; options: FinishOptions; look: 'refine' | 'restore' }
  | { kind: 'single'; workflowId: string; lora: SingleLora; size: 'source' | 'bucket'; master: 'png16' | 'exr16' | 'none' }
  | { kind: 'hdr'; workflowId: string };

/** The finishing spec of a Comp tab run, or null when the tool and its options are not LTX finishing. */
export function finishSpec(toolId: string, o: ToolOptions): FinishSpec | null {
  const fast = opt(o, 'fast', FAST, 1);
  const format = opt(o, 'master', ['png16', 'exr16'] as const, 'png16');
  const preview = o.preview === true;
  if (toolId === 'upscale' && o.engine === 'ltx') {
    const size = opt(o, 'size', Object.keys(LTX_SIZES) as LtxSize[], 'fhd');
    return { kind: 'tiled', workflowId: 'ltx25-refine', look: 'refine', options: { ...DEFAULT_OPTIONS, preset: PRESET_OF[size], preview, duplicate: fast, format } };
  }
  if (toolId === 'restore') {
    const mode = opt(o, 'mode', Object.keys(RESTORE_MODES) as RestoreMode[], 'restore');
    return { kind: 'tiled', workflowId: 'ltx25-restore', look: 'restore', options: { ...DEFAULT_OPTIONS, preset: RESTORE_PRESET[mode], preview, duplicate: fast, format, refineInRestore: 0.3 } };
  }
  if (toolId === 'matte' && o.engine === 'ltx') return { kind: 'single', workflowId: 'ltx25-alpha', lora: 'alpha', size: 'source', master: 'none' };
  if (toolId === 'sdr2hdr') return { kind: 'hdr', workflowId: 'ltx25-sdr2hdr' };
  const s = SINGLE_TOOLS.find((t) => t.id === toolId);
  if (s) {
    const size = opt(o, 'size', ['source', 'bucket'] as const, SINGLE[s.lora].defaultSize);
    return { kind: 'single', workflowId: s.workflowId, lora: s.lora, size, master: format };
  }
  return null;
}

/** Source frames of a plan before the run reads the file: its seconds at its frame rate. */
function framesOf(src: SourceInfo): number {
  return Math.max(1, Math.round(src.seconds * (src.fps || 24)));
}

/** The words every tiled plan says: the pack's sizes when the server has them, else that they come at run time. */
function tiledNotes(fp: FinishPlan): string[] {
  const notes: string[] = [];
  const extra = (p: FinishPlan['passes'][number]): string => (p.extraLora ? `, + ${p.extraLora.kind === 'refine' ? 'Refine' : p.extraLora.kind} ${Math.round(p.extraLora.strength * 100)} % in the same pass` : '');
  const frames = `Frames ${fp.frames.source}${fp.frames.duplicate > 1 ? ` ×${fp.frames.duplicate} = ${fp.frames.content}` : ''} → ${fp.frames.total} (8n+1, ${fp.frames.pad} copies of the last frame, cut after)`;
  if (!fp.sized) {
    notes.push(SIZES_AT_RUN_TIME);
    notes.push(`${fp.passes.map((p) => `${p.name}: the pack's ${p.tiling.canvas === 'initial' ? `${p.tiling.initialCanvas} canvas` : `${p.tiling.outputSize} output`}, ${p.tiling.tileSize} tiles${extra(p)}, ${p.steps} steps`).join(' → ')}. ${frames}.`);
    return notes;
  }
  notes.push(fp.passes.map((p) => `${p.name}: ${p.canvas!.w}×${p.canvas!.h}, ${p.grid ? `${p.grid.x}×${p.grid.y} = ${p.grid.x * p.grid.y}` : `≈ ${p.approx!.spatial}`} tiles of ${p.tile!.w}×${p.tile!.h}${extra(p)}, ${p.steps} steps`).join(' → ')
    + ' — sizes and tiles from the LTX pack (LTXVGetTilingSizes).');
  const chunks = fp.passes[0].sizes?.chunks;
  notes.push(`${frames}${chunks && chunks > 1 ? `, in ${chunks} temporal windows of ${fp.passes[0].sizes!.tileFrames}` : ''}.`);
  notes.push(...fp.notes);
  return notes;
}

function deliveryNote(format: 'png16' | 'exr16'): string {
  return format === 'exr16'
    ? 'Master: an EXR 16-bit float sequence, scene-linear (whether EffectCraft reads it back is not verified), next to the project; in the comp, an 8-bit MP4 preview of the same frames.'
    : 'Master: a PNG 16-bit sequence next to the project; in the comp, an 8-bit MP4 preview of the same frames (EffectCraft decodes 8-bit H.264).';
}

function lookCheck(text: string | undefined, mode: 'refine' | 'restore'): string | null {
  const issues = text?.trim() ? lintPrompt(text, mode) : [];
  return issues.length ? `${describeIssues(issues, mode)} (${LINT_EXPLAINED})` : null;
}

/* ─── Upscale ▸ LTX Refine ──────────────────────────────────────────── */

export function ltxRefinePlan(src: SourceInfo, o: ToolOptions, manifest: (id: string) => unknown, extra?: ToolExtra): ToolPlan {
  const spec = finishSpec('upscale', { ...o, engine: 'ltx' }) as Extract<FinishSpec, { kind: 'tiled' }>;
  const size = opt(o, 'size', Object.keys(LTX_SIZES) as LtxSize[], 'fhd');
  const fast = spec.options.duplicate;
  const preview = spec.options.preview;
  const plan: ToolPlan = {
    ok: true, workflowId: spec.workflowId, jobs: [], makes: '', notes: [], warnings: [],
    action: preview ? 'Preview one tile' : size === 'same' ? 'Refine (same size)' : `Refine to ${LTX_SIZES[size]}`,
    prompt: { label: 'Look', placeholder: 'sharpness, grain, light — not the subjects', optional: true, fallback: DEFAULT_PROMPTS.positive, lint: 'refine' },
    params: {}, variant: `ltx:${size}${fast > 1 ? `·f${fast}` : ''}${preview ? '·tile' : ''}`,
  };
  const bad = needsVideo(src);
  if (bad) return { ...plan, ok: false, reason: bad };
  if (!manifest(spec.workflowId)) return { ...plan, ok: false, reason: `The workflow ${spec.workflowId} is missing from workflows/.` };
  const fp = planFinish({ width: src.width, height: src.height, pixelAspect: 1, frames: framesOf(src), fps: src.fps || 24 }, spec.options, extra?.tiling);
  const seconds = fp.frames.source / (src.fps || 24);
  if (fp.delivery) plan.output = { width: fp.delivery.w, height: fp.delivery.h, seconds, fps: src.fps };
  // The run history keeps each size, "fast scene" and tile apart (a preview tile says nothing about a full run).
  plan.jobs = [{ workflowId: `${spec.workflowId}:${plan.variant}`, seconds }];
  const at = fp.delivery ? ` at ${fp.delivery.w}×${fp.delivery.h}` : ' at the size the LTX pack sets';
  plan.makes = preview
    ? `A new comp${at}: one tile of the ${LTX_SIZES[size]} result, from the middle of the frame, the first ${fmt(seconds)} — to judge the look before the full run. Your ${what(src)} sits under it, matched, switched off.`
    : `A new comp${at}: your ${what(src)} refined by LTX-2.5 (Refine Details IC-LoRA)${size === 'same' ? ' at its own size' : ` to ${LTX_SIZES[size]}`}, with the original under it, switched off.`;
  if (size === '8k') plan.notes.push('8K always goes through 4K: Refine to 4K, lanczos ×2, then a light 2-step refine — never 8K in one pass (the Refine card: "8K in one pass invents detail").');
  plan.notes.push(...tiledNotes(fp));
  if (fast > 1) plan.notes.push(`Fast scene: every frame ×${fast} before the model, the copies removed after.`);
  plan.notes.push(deliveryNote(spec.options.format));
  const est = estimateFinish(fp);
  if (est) plan.estimate = { seconds: est.seconds, line: describeFinishEstimate(est) };
  plan.warnings.push(...fp.warnings);
  if (fp.delivery && src.width >= fp.delivery.w && src.height >= fp.delivery.h && size !== 'same' && !preview) plan.warnings.push(`The ${what(src)} is already ${src.width}×${src.height}: "${LTX_SIZES[size]}" adds no pixels — "Same size" refines without upscaling.`);
  const lint = lookCheck(extra?.prompt, 'refine');
  if (lint) plan.warnings.push(lint);
  return plan;
}

/* ─── Archive restore ───────────────────────────────────────────────── */

const restore: ToolDef = {
  id: 'restore',
  name: 'Archive restore',
  promise: 'Old, soft or damaged footage restored (and coloured from its content), then refined if you like.',
  icon: '⟲',
  sources: ['workArea', 'comp', 'layer'],
  family: 'ltx',
  loras: ['restore'],
  licence: LICENCE,
  defaults: { mode: 'restore', fast: 1, master: 'png16', preview: false },
  plan(src, o, manifest, extra) {
    const spec = finishSpec('restore', o) as Extract<FinishSpec, { kind: 'tiled' }>;
    const mode = opt(o, 'mode', Object.keys(RESTORE_MODES) as RestoreMode[], 'restore');
    const preview = spec.options.preview;
    const plan: ToolPlan = {
      ok: true, workflowId: spec.workflowId, jobs: [], makes: '', notes: [], warnings: [],
      action: preview ? 'Preview one tile' : mode === 'archive' ? 'Restore, then refine' : 'Restore',
      prompt: { label: 'Look', placeholder: 'period, place, light, materials — not the subjects', optional: true, fallback: DEFAULT_PROMPTS.restorePositive, lint: 'restore' },
      params: {}, variant: `${mode}${spec.options.duplicate > 1 ? `·f${spec.options.duplicate}` : ''}${preview ? '·tile' : ''}`,
    };
    const bad = needsVideo(src);
    if (bad) return { ...plan, ok: false, reason: bad };
    if (!manifest(spec.workflowId)) return { ...plan, ok: false, reason: `The workflow ${spec.workflowId} is missing from workflows/.` };
    const fp = planFinish({ width: src.width, height: src.height, pixelAspect: 1, frames: framesOf(src), fps: src.fps || 24 }, spec.options, extra?.tiling);
    const seconds = fp.frames.source / (src.fps || 24);
    if (fp.delivery) plan.output = { width: fp.delivery.w, height: fp.delivery.h, seconds, fps: src.fps };
    plan.jobs = [{ workflowId: `${spec.workflowId}:${plan.variant}`, seconds }];
    const at = fp.delivery ? ` at ${fp.delivery.w}×${fp.delivery.h}` : ' at the size the LTX pack sets';
    plan.makes = preview
      ? `A new comp${at}: one tile of the Restore pass, from the middle of the frame, the first ${fmt(seconds)}.`
      : `A new comp${at}: your ${what(src)} restored by LTX-2.5 (Restore IC-LoRA at 100 %)`
        + `${mode === 'restore-refine' ? ' with Refine Details at 30 % in the same pass' : mode === 'archive' ? ', then lanczos ×2 and refined (Refine Details)' : ''}, the original under it, switched off.`;
    plan.notes.push(mode === 'archive'
      ? 'Archive order, as the Restore card says: Restore first, then Refine — refining first sharpens the damage and desaturates the colour.'
      : mode === 'restore-refine' ? 'Both IC-LoRAs in one pass (Refine at 0.3, the card\'s 0.2–0.3): faster; colour fidelity is best sequential (Restore, then Refine).'
        : 'Restore alone: the card\'s stage 1, "a legitimate result on its own", on the LTX pack\'s Full HD canvas.');
    plan.notes.push('Restore colours monochrome and tinted sources from their content (its card); the Colorization IC-LoRA is a separate tool — its card does not document combining it with Restore.');
    plan.notes.push(...tiledNotes(fp));
    if (spec.options.duplicate > 1) plan.notes.push(`Fast scene: every frame ×${spec.options.duplicate} before the model, the copies removed after.`);
    plan.notes.push(deliveryNote(spec.options.format));
    plan.notes.push('Interlaced sources: deinterlace before restoring (the card) — not done here.');
    plan.notes.push(NEGATIVE_NOTE);
    const est = estimateFinish(fp);
    if (est) plan.estimate = { seconds: est.seconds, line: describeFinishEstimate(est) };
    plan.warnings.push(...fp.warnings.filter((w) => !/already larger/.test(w)));
    const lint = lookCheck(extra?.prompt, 'restore');
    if (lint) plan.warnings.push(lint);
    return plan;
  },
};

/* ─── Single-pass IC-LoRAs ──────────────────────────────────────────── */

interface SingleToolSpec {
  id: string;
  workflowId: string;
  lora: Exclude<SingleLora, 'alpha'>;
  name: string;
  promise: string;
  icon: string;
  action: string;
  prompt: NonNullable<ToolPlan['prompt']>;
  field?: { key: string; label: string; placeholder: string };
  /** What the card is for and not for, in one line (its "Out of scope"). */
  scope: string;
}

export const SINGLE_TOOLS: SingleToolSpec[] = [
  {
    id: 'deblur', workflowId: 'ltx25-deblur', lora: 'deblur', name: 'Deblur', icon: '◎', action: 'Deblur',
    promise: 'Out-of-focus footage back in focus: framing and subjects kept.',
    prompt: { label: 'Scene', placeholder: 'What the shot shows, plainly: a sailboat on a misty lake at dawn' },
    scope: 'Defocus only: its card says motion blur is out of scope, and a blur that destroyed the content is invented, not recovered.',
  },
  {
    id: 'decompress', workflowId: 'ltx25-decompression', lora: 'decompression', name: 'De-compression', icon: '▦', action: 'Remove the artefacts',
    promise: 'Macroblocking, chroma bleed, ringing and banding of a low-bitrate clip, removed.',
    prompt: { label: 'Scene', placeholder: 'What the shot shows, plainly: a sailboat on a misty lake at dawn' },
    scope: 'Compression artefacts only: not blur, noise, upscaling or colour (its card).',
  },
  {
    id: 'colorize', workflowId: 'ltx25-colorize', lora: 'colorize', name: 'Colorize', icon: '◑', action: 'Colorize',
    promise: 'Natural colour for black-and-white or faded footage; framing and geometry kept.',
    prompt: { label: 'Scene', placeholder: 'What the shot shows: a harbour with fishing boats at noon' },
    field: { key: 'colours', label: 'Colours', placeholder: 'the colours to give it: red hulls, deep blue sea, white houses' },
    scope: 'Colour only — not a restorer: for damaged archive footage, Archive restore restores and colours in one.',
  },
  {
    id: 'cleanplate', workflowId: 'ltx25-cleanplate', lora: 'cleanplate', name: 'Clean plate', icon: '▭', action: 'Make the clean plate',
    promise: 'People and vehicles removed, the empty background rebuilt.',
    prompt: { label: 'The empty place', placeholder: 'What remains when nobody is there: a lake shore with a wooden jetty and pines' },
    field: { key: 'remove', label: 'Also remove', placeholder: 'objects that must go too, comma-separated: bicycle, umbrella' },
    scope: 'Works when the subject leaves background around it; a subject that fills the frame is out of scope (its card). "Also remove" goes into the sentence ("no bicycle anywhere in the frame") — the card also puts it in the negative, which ComfyUI does not evaluate at guidance 1.0.',
  },
  {
    id: 'daynight', workflowId: 'ltx25-daynight', lora: 'daynight', name: 'Day → Night', icon: '☾', action: 'Make it night',
    promise: 'The same shot at night: composition, camera and motion kept, only the light changes.',
    prompt: { label: 'Night look', placeholder: 'A realistic nighttime scene, photorealistic moonlight, deep natural shadows', optional: true, fallback: 'A realistic nighttime scene, photorealistic moonlight, deep natural shadows' },
    scope: 'Its card trained on 97 frames at 24 fps (about 4 s); longer clips may drift. Its 30-step, guidance 3–4 settings are for the full model: here it runs on the distilled one, 8 steps, guidance 1, as the official single-stage workflow does.',
  },
];

function singleTool(t: SingleToolSpec): ToolDef {
  const card = SINGLE[t.lora];
  return {
    id: t.id, name: t.name, promise: t.promise, icon: t.icon, sources: ['workArea', 'comp', 'layer'], family: 'ltx', loras: [t.lora], licence: LICENCE,
    defaults: { size: card.defaultSize, master: 'png16', ...(t.field ? { [t.field.key]: '' } : {}) },
    plan(src, o) {
      const spec = finishSpec(t.id, o) as Extract<FinishSpec, { kind: 'single' }>;
      const plan: ToolPlan = {
        ok: true, workflowId: t.workflowId, jobs: [], makes: '', notes: [], warnings: [], action: t.action,
        prompt: t.prompt, fields: t.field ? [t.field] : undefined, params: {}, variant: spec.size,
      };
      const bad = needsVideo(src);
      if (bad) return { ...plan, ok: false, reason: bad };
      const sp = planSingle(t.lora, { width: src.width, height: src.height, frames: framesOf(src), fps: src.fps || 24 }, spec.size);
      if (sp.reason) return { ...plan, ok: false, reason: sp.reason };
      const seconds = sp.frames.source / (src.fps || 24);
      plan.output = { width: sp.delivery.w, height: sp.delivery.h, seconds, fps: src.fps };
      plan.jobs = [{ workflowId: `${t.workflowId}:${plan.variant}`, seconds }];
      plan.makes = `A new comp at ${sp.delivery.w}×${sp.delivery.h}: your ${what(src)} through LTX-2.5 with the ${t.name} IC-LoRA (strength 1.0), the original under it, switched off.`;
      plan.notes.push(`One pass at ${sp.canvas.w}×${sp.canvas.h}${sp.size === 'bucket' && card.bucket ? ` — near the card's ${card.bucket.w}×${card.bucket.h} training size` : ' — the source size'}, ${sp.frames.source} → ${sp.frames.total} frames, 8 distilled steps (the official single-stage workflow: euler_ancestral, guidance 1).`);
      plan.notes.push(`The prompt follows the sentence the card trained on; you write the ${t.prompt.label.toLowerCase()}.`);
      plan.notes.push(t.scope);
      plan.notes.push(deliveryNote(spec.master === 'exr16' ? 'exr16' : 'png16'));
      plan.warnings.push(...sp.warnings);
      const est = estimateSingle(sp);
      plan.estimate = { seconds: est.seconds, line: describeFinishEstimate(est) };
      return plan;
    },
  };
}

/* ─── Cut-out ▸ LTX Alpha ───────────────────────────────────────────── */

export function ltxAlphaPlan(src: SourceInfo, o: ToolOptions, manifest: (id: string) => unknown): ToolPlan {
  const workflowId = 'ltx25-alpha';
  const plan: ToolPlan = {
    ok: true, workflowId, jobs: [], makes: '', notes: [], warnings: [], action: 'Cut out (LTX Alpha)', params: {}, variant: 'ltx-alpha',
  };
  void o;
  const bad = needsVideo(src);
  if (bad) return { ...plan, ok: false, reason: bad };
  if (!manifest(workflowId)) return { ...plan, ok: false, reason: `The workflow ${workflowId} is missing from workflows/.` };
  const sp = planSingle('alpha', { width: src.width, height: src.height, frames: framesOf(src), fps: src.fps || 24 });
  if (sp.reason) return { ...plan, ok: false, reason: sp.reason };
  const seconds = sp.frames.source / (src.fps || 24);
  plan.output = { width: src.width, height: src.height, seconds };
  plan.jobs = [{ workflowId, seconds }];
  plan.makes = src.kind === 'layer'
    ? `A matte above "${src.name}", set as its luma track matte — soft edges for hair, smoke, glass. The clip itself is untouched.`
    : `A new comp "${src.name} · LTX cut-out": the render of the ${what(src)} with its matte as a luma track matte.`;
  plan.notes.push('LTX Alpha Gen decides the foreground on its own: no prompt, no subject to name (its card). White = foreground, as SAM 3\'s matte.');
  plan.notes.push(`One pass at ${sp.canvas.w}×${sp.canvas.h}, ${sp.frames.source} → ${sp.frames.total} frames (the card: up to 1920×1088 and 145 frames).`);
  plan.warnings.push(...sp.warnings);
  const est = estimateSingle(sp);
  plan.estimate = { seconds: est.seconds, line: describeFinishEstimate(est) };
  return plan;
}

/* ─── SDR → HDR ─────────────────────────────────────────────────────── */

const sdr2hdr: ToolDef = {
  id: 'sdr2hdr',
  name: 'SDR → HDR',
  promise: 'An HDR master from SDR footage: EXR frames in ACEScg (scene-linear) and an HLG check video.',
  icon: '☀',
  sources: ['workArea', 'comp', 'layer'],
  family: 'ltx',
  loras: ['sdr2hdr'],
  licence: LICENCE,
  defaults: {},
  plan(src, _o, manifest) {
    const workflowId = 'ltx25-sdr2hdr';
    const plan: ToolPlan = {
      ok: true, workflowId, jobs: [], makes: '', notes: [], warnings: [], action: 'Make the HDR master', params: {}, variant: 'sdr2hdr',
    };
    const bad = needsVideo(src);
    if (bad) return { ...plan, ok: false, reason: bad };
    if (!manifest(workflowId)) return { ...plan, ok: false, reason: `The workflow ${workflowId} is missing from workflows/.` };
    const hp = planHdr({ width: src.width, height: src.height, frames: framesOf(src), fps: src.fps || 24 });
    const seconds = hp.frames.source / (src.fps || 24);
    plan.output = { width: hp.canvas.w, height: hp.canvas.h, seconds, fps: src.fps };
    plan.jobs = [{ workflowId, seconds }];
    plan.makes = `A new comp at ${hp.canvas.w}×${hp.canvas.h}: your ${what(src)} converted to HDR by LTX-2.5 (SDR-To-HDR IC-LoRA). `
      + 'The master next to the project: an EXR sequence in ACEScg (scene-linear, half float) and an HLG BT.2020 10-bit video; '
      + 'the comp shows an 8-bit tonemapped preview, the original under it, switched off.';
    plan.notes.push(`One pass of the pack's SDR-to-HDR chain: the clip through an ACEScct input transform, ${hp.frames.source} → ${hp.frames.total} frames, 8 distilled steps, a float32 decode (its card).`);
    plan.notes.push(`No prompt: its card drives it with a fixed scene embedding; the model is told ${hp.conditioningFps} fps (the card: ${HDR_MAX_CONDITIONING_FPS} at most).`);
    plan.notes.push('EffectCraft 0.11.1 imports the EXR sequence but not as ACEScg (it shows it as sRGB, highlights above 1.0 clipped, at 30 fps until reinterpreted): grade the EXR in an ACES-managed tool.');
    plan.notes.push(...hp.fixes);
    plan.warnings.push(...hp.warnings);
    const est = estimateSingle(hp);
    plan.estimate = { seconds: est.seconds, line: describeFinishEstimate(est) };
    return plan;
  },
};

/** The LTX finishing family, in the order the Comp tab lists it (after the other tools). */
export const FINISHING_TOOLS: ToolDef[] = [restore, ...SINGLE_TOOLS.map(singleTool), sdr2hdr];
