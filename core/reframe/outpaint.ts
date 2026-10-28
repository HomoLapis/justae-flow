/**
 * Generative reframe: the whole clip stays in the new frame and the model
 * paints the space around it (above and below for 9:16 from 16:9).
 *
 * The workflow gets the clip scaled into the generation frame and padded;
 * the host gets a comp at a delivery size where the generated video fills the
 * frame and the original clip sits on top, untouched, with a soft edge — the
 * model's version of the middle is only there to be blended into.
 */

import type { WorkflowJson } from '../comfy/types.ts';

/** The formats a reframe offers, in the order the UI lists them. 21:9 is 7:3 (2.33:1), as 2520×1080 states it. */
export const REFRAME_ASPECTS = ['9:16', '4:5', '1:1', '16:9', '21:9', '4:3'] as const;

/** Width over height of an aspect name ("21:9" → 7/3). */
export function aspectRatio(name: string): number {
  const m = /^(\d+):(\d+)$/.exec(name);
  return m ? Number(m[1]) / Number(m[2]) : NaN;
}

/**
 * Delivery sizes for the new comp: 1080 on the short side, the exact aspect
 * (9:16 1080×1920, 4:5 1080×1350, 1:1 1080×1080, 16:9 1920×1080, 21:9 2520×1080, 4:3 1440×1080).
 */
export const DELIVERY: Record<string, [number, number]> = Object.fromEntries(REFRAME_ASPECTS.map((a) => {
  const r = aspectRatio(a);
  return [a, r >= 1 ? [Math.round(1080 * r), 1080] : [1080, Math.round(1080 / r)]];
}));

/**
 * The frame Wan 2.1 VACE generates in, per aspect. The model is made for two
 * frames — 1280×720 (the 14B, "720p") and 832×480 (the 1.3B, "480p"), the
 * sizes of the official outpainting template and of Wan 2.1's own examples —
 * and WanVaceToVideo takes width and height in steps of 16 (its object_info).
 * So: the model's own frame where the aspect is its own (16:9 and 9:16), else
 * the size with exactly the aspect, both sides multiples of 16, whose pixel
 * count is closest to that frame's. This reproduces every size the reframe
 * shipped with and gives the two added ones:
 *
 *   14B   9:16 720×1280 · 4:5 832×1040 · 1:1 960×960 · 16:9 1280×720 · 21:9 1456×624 · 4:3 1088×816
 *   1.3B  9:16 480×832  · 4:5 576×720  · 1:1 624×624 · 16:9 832×480  · 21:9 1008×432 · 4:3 704×528
 */
export function vaceGenSize(aspect: string, model: '14b' | '1.3b', step = 16): [number, number] {
  const native: [number, number] = model === '14b' ? [1280, 720] : [832, 480];
  if (aspect === '16:9') return native;
  if (aspect === '9:16') return [native[1], native[0]];
  const m = /^(\d+):(\d+)$/.exec(aspect);
  if (!m) throw new Error(`Not an aspect: ${aspect}`);
  const gcd = (x: number, y: number): number => (y ? gcd(y, x % y) : x);
  let a = Number(m[1]);
  let b = Number(m[2]);
  const d = gcd(a, b);
  a /= d; b /= d;
  // The smallest multiplier that puts both sides on the 16-pixel grid.
  const ua = step / gcd(step, a);
  const ub = step / gcd(step, b);
  const unit = (ua * ub) / gcd(ua, ub);
  const budget = native[0] * native[1];
  let best: [number, number] = [a * unit, b * unit];
  for (let t = unit; a * t <= 8192 && b * t <= 8192; t += unit) {
    if (Math.abs(a * t * b * t - budget) < Math.abs(best[0] * best[1] - budget)) best = [a * t, b * t];
  }
  return best;
}

export interface OutpaintPlan {
  /** Generation frame, model pixels. */
  gen: [number, number];
  /** The clip scaled into it… */
  scaled: [number, number];
  /**
   * …of which the model is shown all but this margin on each side that meets new space (left, top, right,
   * bottom; 0 where the clip meets the frame's own edge)…
   */
  inset: [number, number, number, number];
  /** …and the space it fills around what it is shown: left, top, right, bottom (the margin included). */
  pad: [number, number, number, number];
  /** One run per segment; each later run starts from the last frames the one before made. */
  segments: Segment[];
  /** Seconds of the clip the reframe covers. */
  seconds: number;
  /** The clip runs longer than the runs allowed cover. */
  cut: boolean;
  delivery: [number, number];
  /** In the delivery comp: the generated video's scale (%), and the clip's place (comp px) and scale (%). */
  bgScale: number;
  clipCentre: [number, number];
  clipScale: number;
  /** Soft edge of the clip, layer pixels, and the mask that keeps it inside the clip on the sides that meet new space. */
  feather: number;
  mask: [number, number, number, number];
}

export interface Segment {
  /** First source frame, and how many source frames go in. */
  start: number;
  take: number;
  /** Frames the model makes (its lattice: 4k + 1)… */
  frames: number;
  /** …the first of which repeat the end of the run before, to carry it on. */
  overlap: number;
}

/** Frames carried from one run into the next. */
export const OVERLAP = 8;

/**
 * How far past the clip's soft edge the model's own edge is kept, generation pixels. Measured on the 21:9 draft
 * of 25 Oct (1008×432, clip 785×432 at x 111–895): the model drew a bright line 1–2 px wide at x 899–900, just
 * outside the edge it was given, where the original never covers it (the left edge, at x 111, stayed clean).
 * On the 9:16 draft of 28 Oct (480×832, its edge at y 528) the line filled the next latent row and spilled past it,
 * y 530–537, and showed through the original's soft edge: two latent rows (16 px), so whatever the model does at its
 * edge happens under the opaque part of the original.
 */
export const SEAM_GUARD = 16;

export function planSegments(total: number, maxFrames: number, maxSegments: number, overlap = OVERLAP): Segment[] {
  const lattice = (n: number): number => 4 * Math.ceil((Math.max(1, n) - 1) / 4) + 1;
  const cap = 4 * Math.floor((maxFrames - 1) / 4) + 1;
  const first = Math.min(total, cap);
  const segments: Segment[] = [{ start: 0, take: first, frames: lattice(first), overlap: 0 }];
  let next = first;
  while (next < total && segments.length < maxSegments) {
    const take = Math.min(total - next, cap - overlap);
    segments.push({ start: next, take, frames: Math.min(cap, lattice(overlap + take)), overlap });
    next += take;
  }
  return segments;
}

export function planOutpaint(
  src: { width: number; height: number; fps: number; frames: number },
  gen: [number, number],
  delivery: [number, number],
  maxFrames: number,
  maxSegments = 4,
): OutpaintPlan {
  const [gw, gh] = gen;
  const k = Math.min(gw / src.width, gh / src.height);
  const sw = Math.min(gw, Math.round(src.width * k));
  const sh = Math.min(gh, Math.round(src.height * k));
  if (gw - sw < 8 && gh - sh < 8) throw new Error('The clip already has this shape: there is no new space to generate.');
  const left = Math.floor((gw - sw) / 2);
  const top = Math.floor((gh - sh) / 2);
  const around: [number, number, number, number] = [left, top, gw - sw - left, gh - sh - top];

  const total = Math.max(1, Math.round(src.frames));
  const segments = planSegments(total, maxFrames, maxSegments);
  const covered = segments.reduce((n, s) => n + s.take, 0);

  const [dw, dh] = delivery;
  const sx = dw / gw;
  const sy = dh / gh;
  const clipScale = (sw * sx) / src.width;
  const feather = Math.max(4, Math.round(Math.min(src.width, src.height) * 0.03));
  const padX = around[0] + around[2] >= 8;
  const padY = around[1] + around[3] >= 8;
  // The original's edge in the comp is soft: its mask sits feather/2 inside, feathered by `feather` (1.5 × feather
  // of its own pixels until it is opaque, however the feather is spread about the mask's edge). The model's edge
  // goes that far in, and SEAM_GUARD more. Only where the clip meets new space; a side on the frame's edge is whole.
  const margin = Math.ceil(1.5 * feather * k) + SEAM_GUARD;
  const inset: [number, number, number, number] = [
    padX && around[0] > 0 ? margin : 0, padY && around[1] > 0 ? margin : 0,
    padX && around[2] > 0 ? margin : 0, padY && around[3] > 0 ? margin : 0,
  ];
  const pad: [number, number, number, number] = [around[0] + inset[0], around[1] + inset[1], around[2] + inset[2], around[3] + inset[3]];
  const mask: [number, number, number, number] = [
    padX ? feather / 2 : -2 * feather,
    padY ? feather / 2 : -2 * feather,
    padX ? src.width - feather : src.width + 4 * feather,
    padY ? src.height - feather : src.height + 4 * feather,
  ];
  return {
    gen, scaled: [sw, sh], inset, pad, segments, seconds: covered / src.fps, cut: total > covered, delivery,
    bgScale: round3(Math.max(sx, sy) * 100),
    clipCentre: [round3((left + sw / 2) * sx), round3((top + sh / 2) * sy)],
    clipScale: round3(clipScale * 100),
    feather, mask,
  };
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** Where a workflow's padded clip and pad mask come out, and where the model takes its control video and masks. */
export interface ChainRefs {
  start: string;
  padded: [string, number];
  padMask: [string, number];
  controlVideo: string;
  controlMasks: string;
}

/**
 * Turn a reframe graph into the next run of a chain: the control video starts
 * with the last frames the previous run made (kept: mask 0), then the clip's
 * next frames with their new space to fill (mask 1 there). The model carries
 * the generated space on instead of inventing it again.
 */
export function chainGraph(
  api: WorkflowJson,
  refs: ChainRefs,
  run: { previous: unknown; from: number; overlap: number; take: number; size: [number, number] },
): void {
  const set = (ref: string, value: unknown): void => {
    const dot = ref.indexOf('.', ref.lastIndexOf(':') + 1);
    api[ref.slice(0, dot)].inputs[ref.slice(dot + 1)] = value;
  };
  const node = (id: string, class_type: string, inputs: Record<string, unknown>): void => {
    api[id] = { class_type, inputs, _meta: { title: class_type } };
  };
  node('900', 'LoadVideo', { file: run.previous });
  node('901', 'GetVideoComponents', { video: ['900', 0] });
  node('902', 'ImageFromBatch', { image: ['901', 0], batch_index: run.from, length: run.overlap });
  node('903', 'ImageBatch', { image1: ['902', 0], image2: refs.padded });
  node('904', 'SolidMask', { value: 0, width: run.size[0], height: run.size[1] });
  node('905', 'MaskToImage', { mask: ['904', 0] });
  node('906', 'RepeatImageBatch', { image: ['905', 0], amount: run.overlap });
  node('907', 'MaskToImage', { mask: refs.padMask });
  node('908', 'RepeatImageBatch', { image: ['907', 0], amount: run.take });
  node('909', 'ImageBatch', { image1: ['906', 0], image2: ['908', 0] });
  node('910', 'ImageToMask', { image: ['909', 0], channel: 'red' });
  set(refs.controlVideo, ['903', 0]);
  set(refs.controlMasks, ['910', 0]);
}

/** One video from the runs of a chain, each without the frames it repeats. */
export function joinGraph(parts: Array<{ file: unknown; skip: number; take: number }>, fps: number, prefix: string): WorkflowJson {
  const api: WorkflowJson = {};
  let last: [string, number] | null = null;
  parts.forEach((p, i) => {
    const id = 10 * (i + 1);
    api[String(id)] = { class_type: 'LoadVideo', inputs: { file: p.file }, _meta: { title: 'LoadVideo' } };
    api[String(id + 1)] = { class_type: 'GetVideoComponents', inputs: { video: [String(id), 0] }, _meta: { title: 'GetVideoComponents' } };
    api[String(id + 2)] = { class_type: 'ImageFromBatch', inputs: { image: [String(id + 1), 0], batch_index: p.skip, length: p.take }, _meta: { title: 'ImageFromBatch' } };
    if (last) {
      api[String(id + 3)] = { class_type: 'ImageBatch', inputs: { image1: last, image2: [String(id + 2), 0] }, _meta: { title: 'ImageBatch' } };
      last = [String(id + 3), 0];
    } else {
      last = [String(id + 2), 0];
    }
  });
  api['1'] = { class_type: 'CreateVideo', inputs: { images: last!, fps }, _meta: { title: 'CreateVideo' } };
  api['2'] = { class_type: 'SaveVideo', inputs: { video: ['1', 0], filename_prefix: prefix, format: 'auto', 'format.codec': 'auto' }, _meta: { title: 'SaveVideo' } };
  return api;
}
