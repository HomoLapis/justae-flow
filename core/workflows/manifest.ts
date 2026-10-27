/**
 * What a bundled workflow promises, written down instead of guessed.
 *
 * The inspector can find a prompt or a seed in most graphs, but a shipped
 * workflow should not depend on a guess: the manifest names the exact node
 * field for each thing the host fills in. A workflow the user drops into their
 * own library has no manifest, and falls back to the inspector.
 */

import type { ObjectInfo, WorkflowJson } from '../comfy/types.ts';
import { snapFramesUp } from './form.ts';

export type Task = 't2v' | 'i2v' | 'v2v' | 't2i' | 'i2i' | 'upscale-video' | 'upscale-image' | 'remove-bg' | 'matte-video' | 'reframe' | 'outpaint-video' | 'interpolate-video'
  | 'extend-video' | 'describe'
  /** LTX finishing (Refine, Restore and the other IC-LoRAs of the Creative Lab): the graph is built from a plan at run time (core/finishing). */
  | 'finish-video';
/** 'text': a workflow that answers in words (the Comp tab's "Describe the clip"). */
export type MediaKind = 'image' | 'video' | 'text';

/** "nodeId.field" — the node id may itself contain colons (subgraph paths). */
export type FieldRef = string;

export interface ModelFile {
  name: string;
  directory: string;
  url: string;
  /**
   * Not used by the bundled graph: an alternative some users want, with who it is for ("for GPUs with 32 GB or more" —
   * the bf16 pair of LTX finishing). Listed and downloadable, never counted as missing.
   */
  optional?: string;
}

export interface WorkflowManifest {
  id: string;
  title: string;
  /** One line shown under the title in the picker. */
  description: string;
  task: Task;
  /** The host apps the workflow makes sense in. */
  hosts: Array<'effectcraft' | 'photocraft'>;
  output: MediaKind;
  /** What the workflow needs as input, if anything. */
  input?: MediaKind;
  /** The API-format graph, relative to the manifest. */
  api: string;
  bindings: {
    prompt?: FieldRef;
    negative?: FieldRef;
    image?: FieldRef;
    video?: FieldRef;
    seed?: FieldRef;
    width?: FieldRef;
    height?: FieldRef;
    seconds?: FieldRef;
    frames?: FieldRef;
    fps?: FieldRef;
  };
  /** Width/height are rounded to this. LTX's two-stage graphs need 64. */
  sizeMultiple?: number;
  /** Frames are min + k·step (LTX: 9 + 8k). */
  frameLattice?: { min: number; step: number };
  /** Longest side the workflow is comfortable with; the host size is scaled down to it. */
  maxLongSide?: number;
  defaults?: { seconds?: number; width?: number; height?: number };
  /**
   * A few knobs worth showing on the card, beyond the bound ones. A ref that
   * starts with "@" is the app's own setting, not a node field.
   */
  params?: Array<{ ref: FieldRef; label: string; options?: string[] }>;
  /**
   * Generative reframe: the fields that place the clip in the generation frame,
   * the frame sizes the model is made for (per aspect), and how many frames one
   * run holds.
   */
  outpaint?: {
    take: FieldRef;
    start: FieldRef;
    scale: [FieldRef, FieldRef];
    pad: [FieldRef, FieldRef, FieldRef, FieldRef];
    sizes: Record<string, [number, number]>;
    maxFrames: number;
    /** The part of the scaled clip the model is shown (absent in manifests made before 26 Oct: the whole clip). */
    crop?: { x: FieldRef; y: FieldRef; width: FieldRef; height: FieldRef };
    /** For a clip longer than one run: where the padded clip and its mask come out, where the model takes its control. */
    chain: { padded: [string, number]; padMask: [string, number]; controlVideo: FieldRef; controlMasks: FieldRef };
  };
  /**
   * Frame interpolation (the template utility_video_frame_interpolation): the multiplier, the switch that
   * multiplies the frame rate too (off: the same rate, so the clip lasts ×N — slow motion), and the audio
   * input of its CreateVideo (dropped for slow motion: the sound would not stretch with the picture).
   */
  interpolate?: { multiplier: FieldRef; multiplyFps: FieldRef; audio: FieldRef };
  /**
   * Extend with a video guide (from the official template video_ltx2_5_flf2v): the ImageFromBatch that takes the
   * last frames of the uploaded tail (start: a negative index, counted from the end; take: how many), and the guide
   * lengths the workflow takes — 8n + 1, LTXVAddGuide's rule — longest first.
   */
  guide?: { start: FieldRef; take: FieldRef; frames: number[] };
  /** A workflow that answers in words: the node whose UI output carries the text (PreviewAny). */
  text?: { node: string };
  models: ModelFile[];
  source: { template: string; package: string; version: string };
  license: { weights: string; openWeights: boolean; note?: string };
}

export function splitRef(ref: FieldRef): { nodeId: string; field: string } {
  // The field never contains a colon; the node id may ("398:376"). Fields may
  // contain dots ("sampling_mode.seed"), so split at the first dot after the
  // last colon-delimited segment's start.
  const lastColon = ref.lastIndexOf(':');
  const dot = ref.indexOf('.', lastColon + 1);
  return { nodeId: ref.slice(0, dot), field: ref.slice(dot + 1) };
}

export function setRef(api: WorkflowJson, ref: FieldRef | undefined, value: unknown): boolean {
  if (!ref || ref.startsWith('@')) return false;
  const { nodeId, field } = splitRef(ref);
  const node = api[nodeId];
  if (!node) return false;
  node.inputs[field] = value;
  return true;
}

export function getRef(api: WorkflowJson, ref: FieldRef | undefined): unknown {
  if (!ref) return undefined;
  const { nodeId, field } = splitRef(ref);
  return api[nodeId]?.inputs[field];
}

/* ─── Sizes and lengths ─────────────────────────────────────────────── */

export interface SlotSpec {
  width?: number;
  height?: number;
  seconds?: number;
  fps?: number;
}

export interface PlannedSize {
  width: number;
  height: number;
  /** Said on the card when the size differs from what the host asked for. */
  note?: string;
}

export function planSize(m: WorkflowManifest, slot: SlotSpec): PlannedSize | null {
  let w = slot.width ?? m.defaults?.width;
  let h = slot.height ?? m.defaults?.height;
  if (!w || !h) return null;
  const notes: string[] = [];
  const cap = m.maxLongSide;
  if (cap && Math.max(w, h) > cap) {
    const k = cap / Math.max(w, h);
    notes.push(`scaled from ${w}×${h} to fit ${cap}px`);
    w = w * k;
    h = h * k;
  }
  const mult = m.sizeMultiple ?? 32;
  const sw = Math.max(mult, Math.round(w / mult) * mult);
  const sh = Math.max(mult, Math.round(h / mult) * mult);
  if (sw !== Math.round(w) || sh !== Math.round(h)) notes.push(`rounded to multiples of ${mult}`);
  return { width: sw, height: sh, note: notes.length ? notes.join(', ') : undefined };
}

export interface PlannedLength {
  seconds: number;
  frames?: number;
  note?: string;
}

/** Up, never down: a clip a little long is trimmed on the timeline, one too short leaves a hole. */
export function planLength(m: WorkflowManifest, seconds: number | undefined, fps: number): PlannedLength | null {
  const s = seconds ?? m.defaults?.seconds;
  if (!s || s <= 0) return null;
  if (m.bindings.frames) {
    const lat = m.frameLattice ?? { min: 1, step: 1 };
    const frames = snapFramesUp(s * fps, lat.min, lat.step);
    return { seconds: frames / fps, frames, note: frames !== Math.round(s * fps) ? `${frames} frames (the model's lattice)` : undefined };
  }
  if (m.bindings.seconds) {
    const whole = Math.max(1, Math.ceil(s - 0.001));
    return { seconds: whole, note: whole !== s ? `${whole}s (whole seconds), trimmed to the slot` : undefined };
  }
  return null;
}

/* ─── Model files ───────────────────────────────────────────────────── */

const QUANT_TOKENS = /(^|[-_.])(comfy|int8|int4|convrot|fp8|fp16|bf16|fp32|nvfp4|mxfp8|e4m3fn|e5m2|scaled|mixed|awq|gguf|q[0-9]_[a-z0-9_]+)(?=$|[-_.])/gi;

/** The model's identity without its precision: "ltx-2.5-22b-distilled-transformer". */
export function modelFamily(file: string): string {
  // Separators are spelled freely ("Qwen-Image-Edit-2511-FP8" vs "qwen_image_edit_2511_int8"): normalise them first.
  const base = file.split('/').pop()!.replace(/\.(safetensors|ckpt|pt|pth|bin|gguf)$/i, '').toLowerCase().replace(/[-_.]+/g, '-');
  let prev = '';
  let cur = base;
  while (cur !== prev) { prev = cur; cur = cur.replace(QUANT_TOKENS, ''); }
  return cur.replace(/[-_.]+$/, '');
}

export interface ModelRemap {
  nodeId: string;
  field: string;
  wanted: string;
  using: string;
}

export interface ModelCheck {
  remaps: ModelRemap[];
  /** Files the graph needs that this server has in no precision at all. */
  missing: Array<{ nodeId: string; field: string; wanted: string; directory?: string; url?: string }>;
}

/**
 * Point every model-file input at a file this server actually has.
 *
 * The official templates name one precision of each model (int8 for LTX-2.5);
 * a server often has another (nvfp4, fp8) of the very same weights. Those are
 * swapped in, and said; anything with no variant at all is reported as missing,
 * with the download URL the template itself gives.
 */
export function resolveModels(api: WorkflowJson, objectInfo: ObjectInfo, known: ModelFile[] = []): ModelCheck {
  const remaps: ModelRemap[] = [];
  const missing: ModelCheck['missing'] = [];
  for (const [nodeId, node] of Object.entries(api)) {
    const info = objectInfo[node.class_type];
    if (!info?.input) continue;
    const specs = { ...(info.input.required ?? {}), ...(info.input.optional ?? {}) } as Record<string, unknown[]>;
    for (const [field, value] of Object.entries(node.inputs)) {
      if (typeof value !== 'string' || !/\.(safetensors|ckpt|pt|pth|bin|gguf|onnx)$/i.test(value)) continue;
      const spec = specs[field];
      const options = comboOptions(spec);
      if (!options || options.includes(value)) continue;
      const sameName = options.find((o) => o.split('/').pop() === value.split('/').pop());
      const family = modelFamily(value);
      const variant = sameName ?? options.find((o) => modelFamily(o) === family);
      if (variant) {
        node.inputs[field] = variant;
        remaps.push({ nodeId, field, wanted: value, using: variant });
      } else {
        const k = known.find((m) => m.name === value);
        missing.push({ nodeId, field, wanted: value, directory: k?.directory, url: k?.url });
      }
    }
  }
  return { remaps, missing };
}

function comboOptions(spec: unknown[] | undefined): string[] | null {
  if (!Array.isArray(spec)) return null;
  if (Array.isArray(spec[0])) return (spec[0] as unknown[]).filter((x): x is string => typeof x === 'string');
  const opts = (spec[1] as { options?: unknown[] } | undefined)?.options;
  if (spec[0] === 'COMBO' && Array.isArray(opts)) return opts.filter((x): x is string => typeof x === 'string');
  return null;
}

/** Every node class the graph uses that the server does not have. */
export function missingNodes(api: WorkflowJson, objectInfo: ObjectInfo): string[] {
  return [...new Set(Object.values(api).map((n) => n.class_type).filter((t) => !objectInfo[t]))];
}

export { snapFramesUp };
