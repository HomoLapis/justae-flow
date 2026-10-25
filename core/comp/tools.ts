/**
 * The Comp tab's tools: what each one runs, on which sources, and what it will
 * make — said before it runs, from the same numbers the engine then uses.
 *
 * A tool is data: an id, a name, a one-line promise, the sources it accepts, the
 * bundled workflow a set of choices maps to, and a plan. The Flow window lists
 * the tools the server names here, in this order; a tool that is not in this
 * list is not shown. Phase 3 tools (extend, slow motion, social pack) slot in as
 * further entries.
 *
 *   reframe  Wan 2.1 VACE outpainting (14B "Final" / 1.3B "Draft"), or SAM 3
 *            tracking for a crop that follows the subject (nothing generated)
 *   upscale  SeedVR2 ×2; ×4 is two ×2 passes, the second fed with the first's result
 *   matte    SAM 3 subject matte, set as a luma track matte; a ProRes 4444 master
 *            with alpha can be written from it
 */

import { ASPECTS } from '../reframe/plan.ts';
import { DELIVERY, planOutpaint, REFRAME_ASPECTS, aspectRatio } from '../reframe/outpaint.ts';
import type { WorkflowManifest } from '../workflows/manifest.ts';

export type SourceKind = 'workArea' | 'comp' | 'layer';

/** The input a run would get, as the host describes it now. */
export interface SourceInfo {
  kind: SourceKind;
  /** What it is: a video (a clip, or a render of the comp), a still, or nothing with a file (a solid, text). */
  media: 'video' | 'image' | 'none';
  width: number;
  height: number;
  fps: number;
  /** Seconds a run covers: a render of the comp stops at the cap. */
  seconds: number;
  /** Seconds asked for, before the cap. */
  requested: number;
  /** The comp's or the layer's name. */
  name: string;
}

export type ToolOptions = Record<string, string | number | boolean>;

export interface ToolPlan {
  ok: boolean;
  /** Why it cannot run on this source, in words. */
  reason?: string;
  /** The bundled workflow the run uses (routing: its task's row in Settings ▸ Resources). */
  workflowId: string;
  /** The jobs the run submits, as the run history names them, for the estimate (seconds: what each covers). */
  jobs: Array<{ workflowId: string; seconds: number | null }>;
  /** What the run makes, said before it runs. */
  makes: string;
  output?: { width: number; height: number; seconds: number };
  notes: string[];
  warnings: string[];
  /** The primary button. */
  action: string;
  /** The text the workflow needs, if any. */
  prompt?: { label: string; placeholder: string };
  /** Card params (the "@" ones are the app's own settings, not node fields). */
  params: ToolOptions;
  /** One card per tool, variant and source: re-runs of the same thing are its versions. */
  variant: string;
}

export interface ToolDef {
  id: string;
  name: string;
  /** One line under the name. */
  promise: string;
  icon: string;
  sources: SourceKind[];
  /** The defaults of its choices. */
  defaults: ToolOptions;
  plan(src: SourceInfo, options: ToolOptions, manifest: (id: string) => WorkflowManifest | undefined): ToolPlan;
}

/** Long side past which an upscale is not claimed to work: 3840 px (UHD "4K"). */
export const UPSCALE_VERIFIED_LONG_SIDE = 3840;

const fmt = (s: number): string => `${(Math.round(s * 10) / 10).toFixed(1)} s`;
const what = (src: SourceInfo): string => (src.kind === 'layer' ? 'clip' : src.kind === 'workArea' ? 'work area' : 'comp');

function needsVideo(src: SourceInfo): string | undefined {
  if (src.media === 'video') return undefined;
  if (src.media === 'image') return 'This tool works on video: the selected layer is a still. Pick a clip, the work area or the whole comp.';
  return 'The selected layer has no footage file (a solid, text or a shape): pick a clip, the work area or the whole comp.';
}

function opt<T extends string | number | boolean>(o: ToolOptions, k: string, allowed: readonly T[], fallback: T): T {
  const v = o[k] as T;
  return allowed.includes(v) ? v : fallback;
}

const reframe: ToolDef = {
  id: 'reframe',
  name: 'Reframe',
  promise: 'Another format: the space it needs is generated, nothing is cropped.',
  icon: '▣',
  sources: ['workArea', 'comp', 'layer'],
  defaults: { aspect: '9:16', quality: 'draft', mode: 'generate', smooth: 'gentle' },
  plan(src, o, manifest) {
    const aspect = opt(o, 'aspect', REFRAME_ASPECTS, '9:16');
    const mode = opt(o, 'mode', ['generate', 'crop'] as const, 'generate');
    const quality = opt(o, 'quality', ['draft', 'final'] as const, 'draft');
    const smooth = opt(o, 'smooth', ['gentle', 'steady', 'locked'] as const, 'gentle');
    const base = { notes: [] as string[], warnings: [] as string[], params: { '@aspect': aspect } as ToolOptions };
    if (mode === 'crop') {
      const workflowId = 'sam3-reframe';
      const plan: ToolPlan = {
        ...base, ok: true, workflowId, jobs: [{ workflowId, seconds: src.seconds }], makes: '', action: `Crop to ${aspect}`,
        prompt: { label: 'Subject', placeholder: 'What the frame follows, in a word: boat, surfer, car' },
        params: { '@aspect': aspect, '@smooth': smooth }, variant: `crop:${aspect}`,
      };
      const bad = needsVideo(src);
      if (bad) return { ...plan, ok: false, reason: bad };
      const target = ASPECTS[aspect];
      const srcAspect = src.width / src.height;
      const even = (v: number): number => Math.max(2, Math.round(v / 2) * 2);
      const w = target <= srcAspect ? Math.min(src.width, even(src.height * target)) : src.width;
      const h = target <= srcAspect ? src.height : Math.min(src.height, even(src.width / target));
      if (Math.abs(w - src.width) < 8 && Math.abs(h - src.height) < 8) return { ...plan, ok: false, reason: `The ${what(src)} is already ${aspect}: there is nothing to crop.` };
      plan.makes = `A new ${aspect} comp at ${w}×${h}: the ${what(src)} at 100%, framed by Position keyframes that follow the subject. Nothing is generated.`;
      plan.output = { width: w, height: h, seconds: src.seconds };
      plan.notes.push('SAM 3 tracks the subject; the keyframes are few enough to edit by hand.');
      return plan;
    }
    const workflowId = quality === 'final' ? 'vace-reframe' : 'vace-reframe-draft';
    const m = manifest(workflowId);
    const plan: ToolPlan = {
      ...base, ok: true, workflowId, jobs: [], makes: '', action: `Reframe to ${aspect}`,
      prompt: { label: 'Scene', placeholder: 'Describe the whole scene, with what the new space shows: sky, water, the street…' },
      variant: `${quality}:${aspect}`,
    };
    const bad = needsVideo(src);
    if (bad) return { ...plan, ok: false, reason: bad };
    if (!m?.outpaint) return { ...plan, ok: false, reason: `The workflow ${workflowId} is missing from workflows/.` };
    // Within 3.5 % of the format already: the model's frame (832×480 is 1.73:1, not 16:9) would only add slivers.
    if (Math.abs(Math.log(src.width / src.height / aspectRatio(aspect))) < 0.035) {
      return { ...plan, ok: false, reason: `The ${what(src)} is already ${aspect}: there is no new space to generate.` };
    }
    const gen = m.outpaint.sizes[aspect];
    if (!gen) return { ...plan, ok: false, reason: `${m.title} has no size for ${aspect}.` };
    const delivery = DELIVERY[aspect];
    let p;
    try {
      p = planOutpaint({ width: src.width, height: src.height, fps: src.fps, frames: src.seconds * src.fps }, gen, delivery, m.outpaint.maxFrames);
    } catch {
      return { ...plan, ok: false, reason: `The ${what(src)} is already ${aspect}: there is no new space to generate.` };
    }
    const sides = p.pad[0] + p.pad[2] > p.pad[1] + p.pad[3] ? 'left and right' : 'above and below';
    plan.makes = `A new ${aspect} comp, ${delivery[0]}×${delivery[1]}: your ${what(src)} in the middle, untouched; the space ${sides} generated at ${gen[0]}×${gen[1]} (${quality === 'final' ? 'VACE 14B' : 'VACE 1.3B draft'}).`;
    plan.output = { width: delivery[0], height: delivery[1], seconds: p.seconds };
    plan.jobs = p.segments.map((s) => ({ workflowId, seconds: s.frames / src.fps }));
    if (p.segments.length > 1) {
      plan.jobs.push({ workflowId: `${workflowId}:join`, seconds: p.seconds });
      plan.notes.push(`${p.segments.length} runs of up to ${((4 * Math.floor((m.outpaint.maxFrames - 1) / 4) + 1) / src.fps).toFixed(1)} s, each carrying on from the last.`);
    } else {
      plan.notes.push(`${fmt(p.seconds)} in one run (${p.segments[0].frames} frames).`);
    }
    if (p.cut) plan.warnings.push(`Only the first ${fmt(p.seconds)} are reframed: ${p.segments.length} runs is the most one card makes.`);
    if (quality === 'draft') plan.notes.push('Draft: the new space is 480p, softer than the middle. Final (14B) makes it at 720p.');
    else plan.notes.push('Final: VACE 14B with the lightx2v 4-step LoRA; on a 16 GB card it takes minutes per step.');
    return plan;
  },
};

const upscale: ToolDef = {
  id: 'upscale',
  name: 'Upscale',
  promise: '×2, or ×4 in two passes: restored detail at the new size.',
  icon: '⤢',
  sources: ['workArea', 'comp', 'layer'],
  defaults: { scale: 2 },
  plan(src, o, manifest) {
    const scale = opt(o, 'scale', [2, 4] as const, 2);
    const workflowId = 'seedvr2-upscale';
    const m = manifest(workflowId);
    const ref = m?.params?.find((x) => x.label === 'Scale')?.ref;
    const plan: ToolPlan = {
      ok: true, workflowId, jobs: [], makes: '', notes: [], warnings: [], action: `Upscale ×${scale}`,
      params: ref ? { [ref]: 2 } : {}, variant: `x${scale}`,
    };
    const bad = needsVideo(src);
    if (bad) return { ...plan, ok: false, reason: bad };
    if (!m || !ref) return { ...plan, ok: false, reason: 'The SeedVR2 workflow (or its Scale field) is missing from workflows/.' };
    const w = src.width * scale;
    const h = src.height * scale;
    plan.output = { width: w, height: h, seconds: src.seconds };
    plan.makes = `A new comp at ${w}×${h}: the upscaled ${what(src)}, with your original under it, switched off.`;
    plan.jobs = scale === 4
      ? [{ workflowId, seconds: src.seconds }, { workflowId: `${workflowId}:pass2`, seconds: src.seconds }]
      : [{ workflowId, seconds: src.seconds }];
    plan.notes.push(scale === 4
      ? `Two passes of SeedVR2 3B ×2: ${src.width}×${src.height} → ${src.width * 2}×${src.height * 2} → ${w}×${h}.`
      : `SeedVR2 3B, one pass: ${src.width}×${src.height} → ${w}×${h}.`);
    if (Math.max(w, h) > UPSCALE_VERIFIED_LONG_SIDE) {
      plan.warnings.push(`${w}×${h} is beyond 4K (${UPSCALE_VERIFIED_LONG_SIDE} px): not verified on this machine — it may run out of GPU memory or take very long.`);
    }
    return plan;
  },
};

const matte: ToolDef = {
  id: 'matte',
  name: 'Cut-out',
  promise: 'The subject as a luma track matte; a ProRes 4444 master with alpha from it.',
  icon: '◐',
  sources: ['workArea', 'comp', 'layer'],
  defaults: {},
  plan(src) {
    const workflowId = 'sam3-matte';
    const plan: ToolPlan = {
      ok: true, workflowId, jobs: [{ workflowId, seconds: src.seconds }], makes: '', notes: [], warnings: [], action: 'Cut out',
      prompt: { label: 'Subject', placeholder: 'What to keep, in a word: boat, woman, dog, car' }, params: {}, variant: 'matte',
    };
    const bad = needsVideo(src);
    if (bad) return { ...plan, ok: false, reason: bad };
    plan.output = { width: src.width, height: src.height, seconds: src.seconds };
    plan.makes = src.kind === 'layer'
      ? `A matte of the subject above "${src.name}", set as its luma track matte. The clip itself is untouched.`
      : `A new comp "${src.name} · cut-out": the render of the ${what(src)} with its matte as a luma track matte.`;
    plan.notes.push('SAM 3 tracks the subject through every frame; edges are hard. "Export with alpha" then writes a ProRes 4444 .mov.');
    return plan;
  },
};

/** The tools the Comp tab shows, in order. Only tools that work are listed. */
export const COMP_TOOLS: ToolDef[] = [reframe, upscale, matte];

export function toolById(id: string): ToolDef | undefined {
  return COMP_TOOLS.find((t) => t.id === id);
}

/** The name of a result: "<Comp> · 9:16", "<Comp> · ×2", "<Comp> · cut-out". */
export function resultName(base: string, tool: string, options: ToolOptions): string {
  const clean = base.replace(/\.[a-z0-9]{2,4}$/i, '');
  if (tool === 'reframe') return `${clean} · ${String(options.aspect ?? '9:16')}${options.mode === 'crop' ? ' crop' : ''}`;
  if (tool === 'upscale') return `${clean} · ×${Number(options.scale) === 4 ? 4 : 2}`;
  if (tool === 'matte') return `${clean} · cut-out`;
  return `${clean} · ${tool}`;
}

/** The aspect a source has, as the nearest named one (for the preview's "from" frame). */
export function nearestAspect(width: number, height: number): string {
  const r = width / height;
  return [...REFRAME_ASPECTS].sort((a, b) => Math.abs(Math.log(aspectRatio(a) / r)) - Math.abs(Math.log(aspectRatio(b) / r)))[0];
}
