/**
 * The Comp tab's tools: what each one runs, on which sources, and what it will
 * make — said before it runs, from the same numbers the engine then uses.
 *
 * A tool is data: an id, a name, a one-line promise, the sources it accepts, the
 * bundled workflow a set of choices maps to, and a plan. The Flow window lists
 * the tools the server names here, in this order; a tool that is not in this
 * list is not shown.
 *
 *   reframe  Wan 2.1 VACE outpainting (14B "Final" / 1.3B "Draft"), or SAM 3
 *            tracking for a crop that follows the subject (nothing generated)
 *   upscale  SeedVR2 ×2; ×4 is two ×2 passes, the second fed with the first's result;
 *            "Keep original colours" = SeedVR2's own colour correction
 *   matte    SAM 3 subject matte, set as a luma track matte; a ProRes 4444 master
 *            with alpha can be written from it
 *   extend   LTX-2.5 image-to-video from the source's last frame: a new layer that
 *            starts at the source's out point
 *   slowmo   frame interpolation (RIFE, FILM, GIMM-VFI): ×2 / ×4 slow motion, or
 *            twice the frame rate, in a new comp
 *   social   several reframes (and their upscales, and masters) queued one after
 *            the other: orchestration of the tools above, no model of its own
 */

import { ASPECTS } from '../reframe/plan.ts';
import { DELIVERY, planOutpaint, REFRAME_ASPECTS, aspectRatio } from '../reframe/outpaint.ts';
import { planSize, type WorkflowManifest } from '../workflows/manifest.ts';

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
  /** Where it sits in the comp, seconds: the work area, the whole comp, or the layer's in and out points. */
  span?: [number, number];
  /** The comp's own length and frame rate (a layer source has its own fps above). */
  compSeconds?: number;
  compFps?: number;
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
  output?: { width: number; height: number; seconds: number; fps?: number };
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
  /** Choices the card offers that come from the workflow itself (a node's own options, from object_info). */
  choices?: Record<string, string[]>;
  /** A pack (the Social pack): the runs it queues, in order, each with its own plan. */
  members?: Array<{ tool: string; options: ToolOptions; plan: ToolPlan }>;
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
  /** false: the source is not rendered (Extend only takes its last frame), so the render cap does not apply. */
  renders?: boolean;
  plan(src: SourceInfo, options: ToolOptions, manifest: (id: string) => WorkflowManifest | undefined): ToolPlan;
}

/** Long side past which an upscale is not claimed to work: 3840 px (UHD "4K"). */
export const UPSCALE_VERIFIED_LONG_SIDE = 3840;

/**
 * "Keep original colours": SeedVR2PostProcessing's colour correction (its choices come from object_info:
 * lab, wavelet, adain, none; the template ships "none"). Measured on 26 Oct, one frame of a 1 s LTX clip,
 * 640×352 → 1280×704, against the original scaled ×2 (Lanczos), both blurred σ 3, CIELAB: none raised
 * contrast (σL 24.40 → 26.75) and chroma (6.88 → 8.18), ΔE 3.85; wavelet kept them (24.50, 6.94), ΔE 1.44;
 * lab 24.38 / 6.54, ΔE 1.56; adain 23.99 / 7.34, ΔE 2.27. Wavelet was closest.
 */
export const KEEP_COLOUR_DEFAULT = 'wavelet';

/** Extend: the lengths offered, seconds. */
export const EXTEND_SECONDS = [2, 4, 5] as const;

/**
 * LTX-2.5 makes 8k + 1 frames. Extend asks for one more frame than it shows — the first, which repeats the
 * source's last frame, is trimmed off — so: the smallest 8k + 1 that is at least seconds × fps + 1.
 */
export function ltxExtendFrames(seconds: number, fps: number): number {
  return 8 * Math.ceil((seconds * fps) / 8) + 1;
}

/** Interpolation: frames out of n frames in, with N − 1 new frames between each pair (RIFE VFI, GIMM-VFI). */
export function interpolatedFrames(n: number, multiplier: number): number {
  return Math.max(1, (Math.max(1, n) - 1) * multiplier + 1);
}

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
    plan.output = { width: delivery[0], height: delivery[1], seconds: p.seconds, fps: src.fps };
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
  defaults: { scale: 2, colour: 'keep', method: KEEP_COLOUR_DEFAULT },
  plan(src, o, manifest) {
    const scale = opt(o, 'scale', [2, 4] as const, 2);
    const workflowId = 'seedvr2-upscale';
    const m = manifest(workflowId);
    const ref = m?.params?.find((x) => x.label === 'Scale')?.ref;
    const colourParam = m?.params?.find((x) => x.label === 'Colour');
    // The node's own choices (object_info, at build time); "none" is "the model's colours".
    const methods = (colourParam?.options ?? []).filter((x) => x !== 'none');
    const keep = o.colour !== 'model';
    const method = keep ? (methods.includes(String(o.method)) ? String(o.method) : methods.includes(KEEP_COLOUR_DEFAULT) ? KEEP_COLOUR_DEFAULT : methods[0] ?? 'none') : 'none';
    const params: ToolOptions = ref ? { [ref]: 2 } : {};
    if (colourParam) params[colourParam.ref] = method;
    const plan: ToolPlan = {
      ok: true, workflowId, jobs: [], makes: '', notes: [], warnings: [], action: `Upscale ×${scale}`,
      params, variant: `x${scale}`, choices: { method: methods },
    };
    const bad = needsVideo(src);
    if (bad) return { ...plan, ok: false, reason: bad };
    if (!m || !ref) return { ...plan, ok: false, reason: 'The SeedVR2 workflow (or its Scale field) is missing from workflows/.' };
    const w = src.width * scale;
    const h = src.height * scale;
    plan.output = { width: w, height: h, seconds: src.seconds, fps: src.fps };
    plan.makes = `A new comp at ${w}×${h}: the upscaled ${what(src)}, with your original under it, switched off.`;
    plan.jobs = scale === 4
      ? [{ workflowId, seconds: src.seconds }, { workflowId: `${workflowId}:pass2`, seconds: src.seconds }]
      : [{ workflowId, seconds: src.seconds }];
    plan.notes.push(scale === 4
      ? `Two passes of SeedVR2 3B ×2: ${src.width}×${src.height} → ${src.width * 2}×${src.height * 2} → ${w}×${h}.`
      : `SeedVR2 3B, one pass: ${src.width}×${src.height} → ${w}×${h}.`);
    plan.notes.push(colourParam
      ? (keep ? `Colours kept: SeedVR2's own colour correction ("${method}") matches the result to your ${what(src)}.`
        : 'The model\'s colours (the template\'s "none"): SeedVR2 raises contrast and saturation.')
      : 'This SeedVR2 workflow has no colour correction to set.');
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

const extend: ToolDef = {
  id: 'extend',
  name: 'Extend',
  promise: '+2, 4 or 5 s after the end: what happens next, from the last frame.',
  icon: '⟶',
  sources: ['workArea', 'comp', 'layer'],
  defaults: { seconds: 2 },
  renders: false,
  plan(src, o, manifest) {
    const seconds = opt(o, 'seconds', EXTEND_SECONDS, 2);
    const workflowId = 'ltx25-i2v';
    const m = manifest(workflowId);
    const plan: ToolPlan = {
      ok: true, workflowId, jobs: [], makes: '', notes: [], warnings: [], action: `Extend by ${seconds} s`,
      prompt: { label: 'What happens next', placeholder: 'Describe the next seconds as one shot: what moves, how the camera moves, the sound.' },
      params: { '@seconds': seconds }, variant: `+${seconds}`,
    };
    if (src.media === 'none') return { ...plan, ok: false, reason: 'The selected layer has no footage file (a solid, text or a shape): pick a clip, the work area or the whole comp.' };
    if (!m) return { ...plan, ok: false, reason: 'The LTX-2.5 image-to-video workflow is missing from workflows/.' };
    const fps = src.kind === 'layer' ? src.fps : src.compFps ?? src.fps;
    const [, out] = src.span ?? [0, src.seconds];
    const size = planSize(m, { width: src.width, height: src.height });
    if (!size) return { ...plan, ok: false, reason: 'The source has no size.' };
    const frames = ltxExtendFrames(seconds, fps);
    const lengthened = src.compSeconds !== undefined && out + seconds > src.compSeconds + 1e-3;
    plan.output = { width: size.width, height: size.height, seconds, fps };
    plan.jobs = [{ workflowId, seconds: frames / fps }];
    plan.makes = `A new layer at ${fmt(out)} — the ${what(src)}'s out point — for ${seconds} s: LTX-2.5 carries on from the frame at ${Math.max(0, out - 1 / fps).toFixed(2)} s, `
      + `at ${size.width}×${size.height}, ${Math.round(fps * 100) / 100} fps, ${src.kind === 'layer' ? 'laid over the clip\'s own size' : 'scaled to cover the comp'}. Your ${what(src)} is untouched.`;
    plan.notes.push(`${frames} frames (LTX makes 8k + 1); the first repeats your last frame and is trimmed off, the layer ends after ${seconds} s.`);
    if (lengthened) plan.notes.push(`The comp gets longer to hold it: ${fmt(src.compSeconds!)} → ${fmt(out + seconds)}.`);
    if (src.media === 'image') plan.notes.push('A still: the new clip starts from the still itself.');
    plan.notes.push('LTX-2.5 makes sound too: the new layer has its own audio track.');
    return plan;
  },
};

const slowmo: ToolDef = {
  id: 'slowmo',
  name: 'Slow motion / fps',
  promise: '×2 or ×4 slow motion, or twice the frame rate: new frames in between.',
  icon: '◔',
  sources: ['workArea', 'comp', 'layer'],
  defaults: { mode: 'slow2', engine: 'rife' },
  plan(src, o, manifest) {
    const mode = opt(o, 'mode', ['slow2', 'slow4', 'fps2'] as const, 'slow2');
    const engine = opt(o, 'engine', ['rife', 'film', 'gimm'] as const, 'rife');
    const workflowId = `interp-${engine}`;
    const m = manifest(workflowId);
    const k = mode === 'slow4' ? 4 : 2;
    const fpsOut = mode === 'fps2' ? src.fps * 2 : src.fps;
    const plan: ToolPlan = {
      ok: true, workflowId, jobs: [{ workflowId, seconds: src.seconds }], makes: '', notes: [], warnings: [],
      action: mode === 'fps2' ? `${Math.round(src.fps * 100) / 100} → ${Math.round(fpsOut * 100) / 100} fps` : `Slow down ×${k}`,
      params: {}, variant: mode,
    };
    const bad = needsVideo(src);
    if (bad) return { ...plan, ok: false, reason: bad };
    if (!m?.interpolate) return { ...plan, ok: false, reason: `The workflow ${workflowId} is missing from workflows/.` };
    // CreateVideo takes up to 120 fps (its object_info).
    if (fpsOut > 120) return { ...plan, ok: false, reason: `${Math.round(fpsOut)} fps is more than CreateVideo writes (120).` };
    plan.params = { [m.interpolate.multiplier]: k, [m.interpolate.multiplyFps]: mode === 'fps2', '@audio': mode === 'fps2' };
    const n = Math.max(1, Math.round(src.seconds * src.fps));
    const out = interpolatedFrames(n, k);
    const seconds = out / fpsOut;
    plan.output = { width: src.width, height: src.height, seconds, fps: fpsOut };
    const by = engine === 'rife' ? 'RIFE' : engine === 'film' ? 'FILM' : 'GIMM-VFI';
    plan.makes = mode === 'fps2'
      ? `A new comp at ${Math.round(fpsOut * 100) / 100} fps, ${src.width}×${src.height}: the same ${fmt(seconds)}, ${out} frames, every other one made by ${by}. The sound is kept.`
      : `A new comp, ${src.width}×${src.height} at ${Math.round(src.fps * 100) / 100} fps, ${fmt(seconds)} long (×${k}): ${out} frames, ${k - 1} of every ${k} made by ${by}. The sound is left out: it would not slow down with the picture.`;
    plan.notes.push(`${n} frames in → ${out} out ((n − 1) × ${k} + 1); your original goes into the comp too, switched off.`);
    if (engine === 'gimm') plan.warnings.push('GIMM-VFI\'s licence (S-Lab License 1.0) allows non-commercial use only.');
    if (engine === 'film') plan.notes.push('FILM: the official template as it ships (ComfyUI core nodes).');
    return plan;
  },
};

/** The formats a Social pack offers, in the order the card lists them. */
export const SOCIAL_FORMATS = REFRAME_ASPECTS;

const social: ToolDef = {
  id: 'social',
  name: 'Social pack',
  promise: 'Several formats in one go: the reframes (and their upscales) one after the other.',
  icon: '☰',
  sources: ['workArea', 'comp', 'layer'],
  defaults: { formats: '9:16,1:1', quality: 'draft', upscale: false, masters: 'none' },
  plan(src, o, manifest) {
    const quality = opt(o, 'quality', ['draft', 'final'] as const, 'draft');
    const masters = opt(o, 'masters', ['none', 'prores4444', 'png16'] as const, 'none');
    const withUpscale = o.upscale === true;
    const formats = SOCIAL_FORMATS.filter((a) => String(o.formats ?? '').split(',').map((x) => x.trim()).includes(a));
    const plan: ToolPlan = {
      ok: true, workflowId: quality === 'final' ? 'vace-reframe' : 'vace-reframe-draft', jobs: [], makes: '', notes: [], warnings: [],
      action: 'Make the pack', prompt: { label: 'Scene', placeholder: 'Describe the whole scene, with what the new space shows: sky, water, the street…' },
      params: {}, variant: 'pack', members: [],
    };
    if (formats.length === 0) return { ...plan, ok: false, reason: 'Pick at least one format.' };
    const bad = needsVideo(src);
    if (bad) return { ...plan, ok: false, reason: bad };
    const skipped: string[] = [];
    for (const aspect of formats) {
      const options = { aspect, quality, mode: 'generate' };
      const rp = reframe.plan(src, options, manifest);
      if (!rp.ok) { skipped.push(`${aspect}: ${rp.reason}`); continue; }
      plan.members!.push({ tool: 'reframe', options, plan: rp });
      plan.jobs.push(...rp.jobs);
      if (withUpscale && rp.output) {
        const upSrc: SourceInfo = { kind: 'comp', media: 'video', width: rp.output.width, height: rp.output.height, fps: src.fps, seconds: rp.output.seconds, requested: rp.output.seconds, name: `${src.name} · ${aspect}` };
        const uo = { scale: 2, colour: 'keep', method: KEEP_COLOUR_DEFAULT };
        const up = upscale.plan(upSrc, uo, manifest);
        if (up.ok) {
          plan.members!.push({ tool: 'upscale', options: uo, plan: up });
          plan.jobs.push(...up.jobs);
          for (const w of up.warnings) plan.warnings.push(`${aspect} ×2: ${w}`);
        }
      }
    }
    if (!plan.members!.length) return { ...plan, ok: false, reason: skipped.join(' ') || 'No format can be made from this source.' };
    const made = plan.members!.filter((x) => x.tool === 'reframe').map((x) => `${x.options.aspect} (${x.plan.output!.width}×${x.plan.output!.height})`);
    const n = plan.members!.length;
    plan.makes = `${made.length} new comp${made.length === 1 ? '' : 's'}, one per format: ${made.join(', ')}`
      + `${withUpscale ? ', each upscaled ×2 into a comp of its own' : ''}${masters !== 'none' ? `, each written as a ${masters === 'prores4444' ? 'ProRes 4444 .mov' : 'PNG 16-bit sequence'} master` : ''}. `
      + `${n} run${n === 1 ? '' : 's'}, queued one after the other; one result groups them.`;
    plan.notes.push(`${quality === 'final' ? 'Final: VACE 14B at 720p' : 'Draft: VACE 1.3B at 480p'}, the same scene text for every format.`);
    if (skipped.length) plan.notes.push(`Left out — ${skipped.join(' ')}`);
    if (masters !== 'none') plan.notes.push('Masters: EffectCraft renders each final comp (ProRes 422 HQ), ffmpeg writes the master next to the project.');
    return plan;
  },
};

/** The tools the Comp tab shows, in order. Only tools that work are listed. */
export const COMP_TOOLS: ToolDef[] = [reframe, upscale, matte, extend, slowmo, social];

export function toolById(id: string): ToolDef | undefined {
  return COMP_TOOLS.find((t) => t.id === id);
}

/** The name of a result: "<Comp> · 9:16", "<Comp> · ×2", "<Comp> · cut-out", "<Comp> · +2 s", "<Comp> · ×2 slow", "<Comp> · 48 fps". */
export function resultName(base: string, tool: string, options: ToolOptions, plan?: Pick<ToolPlan, 'output'>): string {
  const clean = base.replace(/\.[a-z0-9]{2,4}$/i, '');
  if (tool === 'reframe') return `${clean} · ${String(options.aspect ?? '9:16')}${options.mode === 'crop' ? ' crop' : ''}`;
  if (tool === 'upscale') return `${clean} · ×${Number(options.scale) === 4 ? 4 : 2}`;
  if (tool === 'matte') return `${clean} · cut-out`;
  if (tool === 'extend') return `${clean} · +${Number(options.seconds) || 2} s`;
  if (tool === 'slowmo') {
    if (options.mode === 'fps2') return `${clean} · ${plan?.output?.fps ? Math.round(plan.output.fps * 100) / 100 : '2×'} fps`;
    return `${clean} · ×${options.mode === 'slow4' ? 4 : 2} slow`;
  }
  if (tool === 'social') return `${clean} · social pack`;
  return `${clean} · ${tool}`;
}

/** The aspect a source has, as the nearest named one (for the preview's "from" frame). */
export function nearestAspect(width: number, height: number): string {
  const r = width / height;
  return [...REFRAME_ASPECTS].sort((a, b) => Math.abs(Math.log(aspectRatio(a) / r)) - Math.abs(Math.log(aspectRatio(b) / r)))[0];
}
