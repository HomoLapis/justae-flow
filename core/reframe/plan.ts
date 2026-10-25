/**
 * Reframing a clip to another aspect ratio around a tracked subject.
 *
 * The workflow only says where the subject is, frame by frame (a small mask
 * per frame). The framing itself is done in the host, on the original footage:
 * a new comp at the new aspect, the clip at 100% (no resampling), and Position
 * keyframes that follow the subject — few enough to be edited by hand.
 */

import type { GreyImage } from '../lib/png.ts';

/** Where the subject is in one frame, as fractions of the frame (0–1). */
export interface SubjectFrame {
  found: boolean;
  cx: number;
  cy: number;
  /** Bounding box: left, top, right, bottom. */
  box: [number, number, number, number];
}

export type Smoothing = 'gentle' | 'steady' | 'locked';

/** Width over height; 21:9 is 7:3 (2.33:1), the same shape as the generative reframe's 2520×1080. */
export const ASPECTS: Record<string, number> = { '9:16': 9 / 16, '4:5': 4 / 5, '1:1': 1, '16:9': 16 / 9, '21:9': 21 / 9, '4:3': 4 / 3 };

export function subjectOf(img: GreyImage, threshold = 128): SubjectFrame {
  let n = 0, sx = 0, sy = 0;
  let l = img.width, t = img.height, r = -1, b = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[y * img.width + x] < threshold) continue;
      n++; sx += x; sy += y;
      if (x < l) l = x;
      if (x > r) r = x;
      if (y < t) t = y;
      if (y > b) b = y;
    }
  }
  if (n === 0) return { found: false, cx: 0.5, cy: 0.5, box: [0, 0, 1, 1] };
  const w = img.width, h = img.height;
  return { found: true, cx: (sx / n + 0.5) / w, cy: (sy / n + 0.5) / h, box: [l / w, t / h, (r + 1) / w, (b + 1) / h] };
}

export interface ReframePlan {
  /** The new comp, in source pixels: the clip is used at 100%. */
  width: number;
  height: number;
  /** Which way the frame moves: across (a narrower target) or up and down (a wider one). */
  axis: 'x' | 'y';
  /** Position keyframes for the clip layer: layer time (s) and comp-space position. */
  keys: Array<{ t: number; x: number; y: number }>;
  /** Frames where the subject was found. */
  found: number;
  frames: number;
}

export function planReframe(frames: SubjectFrame[], src: { width: number; height: number; fps: number }, aspect: number, smoothing: Smoothing): ReframePlan {
  const found = frames.filter((f) => f.found).length;
  if (found === 0) throw new Error('The subject was not found in any frame.');
  const srcAspect = src.width / src.height;
  const axis: 'x' | 'y' = aspect <= srcAspect ? 'x' : 'y';
  const even = (v: number): number => Math.max(2, Math.round(v / 2) * 2);
  const width = axis === 'x' ? Math.min(src.width, even(src.height * aspect)) : src.width;
  const height = axis === 'x' ? src.height : Math.min(src.height, even(src.width / aspect));

  // Wanted centre of the crop, in source pixels, along the moving axis.
  const span = axis === 'x' ? src.width : src.height;
  const crop = axis === 'x' ? width : height;
  const want = frames.map((f) => {
    if (!f.found) return NaN;
    const c = (axis === 'x' ? f.cx : f.cy) * span;
    // Keep the whole subject in frame when it fits; else centre on its mass.
    const lo = (axis === 'x' ? f.box[2] : f.box[3]) * span - crop / 2;
    const hi = (axis === 'x' ? f.box[0] : f.box[1]) * span + crop / 2;
    return lo <= hi ? Math.min(Math.max(c, lo), hi) : c;
  });
  fillGaps(want);

  let centre: number[];
  if (smoothing === 'locked') {
    const sorted = want.slice().sort((a, b) => a - b);
    centre = want.map(() => sorted[Math.floor(sorted.length / 2)]);
  } else {
    centre = gaussian(want, (smoothing === 'steady' ? 0.6 : 0.2) * src.fps);
  }
  const clamp = (v: number): number => Math.min(Math.max(v, crop / 2), span - crop / 2);
  centre = centre.map(clamp);

  // Layer position that puts the crop centre in the middle of the comp (anchor = footage centre).
  const pos = centre.map((c) => crop / 2 + (span / 2 - c));
  const tolerance = Math.max(1.5, crop * 0.006);
  const keep = smoothing === 'locked' ? [0] : simplify(pos, tolerance);
  const keys = keep.map((i) => {
    const p = Math.round(pos[i] * 100) / 100;
    return { t: i / src.fps, x: axis === 'x' ? p : width / 2, y: axis === 'y' ? p : height / 2 };
  });
  return { width, height, axis, keys, found, frames: frames.length };
}

/** Frames with no subject hold the nearest known position. */
function fillGaps(v: number[]): void {
  const first = v.findIndex((x) => !Number.isNaN(x));
  for (let i = 0; i < first; i++) v[i] = v[first];
  for (let i = first + 1; i < v.length; i++) if (Number.isNaN(v[i])) v[i] = v[i - 1];
}

function gaussian(v: number[], sigma: number): number[] {
  if (sigma < 0.5) return v.slice();
  const r = Math.ceil(sigma * 3);
  const w = Array.from({ length: 2 * r + 1 }, (_, k) => Math.exp(-((k - r) ** 2) / (2 * sigma * sigma)));
  return v.map((_, i) => {
    let s = 0, ws = 0;
    for (let k = -r; k <= r; k++) {
      const j = Math.min(Math.max(i + k, 0), v.length - 1);
      s += v[j] * w[k + r];
      ws += w[k + r];
    }
    return s / ws;
  });
}

/** Ramer–Douglas–Peucker on (frame, value): the frames to key so linear keys stay within `tol`. */
export function simplify(v: number[], tol: number): number[] {
  if (v.length <= 2) return v.map((_, i) => i);
  const keep = new Set([0, v.length - 1]);
  const stack: Array<[number, number]> = [[0, v.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = -1, dist = tol;
    for (let i = a + 1; i < b; i++) {
      const lin = v[a] + (v[b] - v[a]) * ((i - a) / (b - a));
      const d = Math.abs(v[i] - lin);
      if (d > dist) { dist = d; worst = i; }
    }
    if (worst >= 0) {
      keep.add(worst);
      stack.push([a, worst], [worst, b]);
    }
  }
  return [...keep].sort((x, y) => x - y);
}
