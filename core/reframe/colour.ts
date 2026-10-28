/**
 * Colour match of a reframe's generated frame to the clip it surrounds.
 *
 * The model gives the clip's own pixels back (the part of its frame under the clip) with a shift of its own, and the
 * new space around carries the same shift: measured on the 9:16 Final of 28 Oct (VACE 14B, 720×1280), its copy of the
 * clip was about 4 levels brighter and 5 % more contrasted on every channel — a step where the clip's soft edge meets
 * the generated space. The generated frame is brought onto the clip with a gain and an offset per channel that give
 * its copy of the clip the clip's own mean and spread; the clip itself is never touched.
 */

export type RGB = [number, number, number];
export interface ChannelStats { mean: RGB; std: RGB; samples: number }
export interface ColourFit { gain: RGB; offset: RGB; generated: ChannelStats; clip: ChannelStats; applied: boolean }
export interface Rect { x: number; y: number; width: number; height: number }

/** A gain outside this range means the two images are not the same picture: nothing is changed then. */
export const GAIN_RANGE: [number, number] = [0.8, 1.25];
/** Less than this (levels of 255, anywhere on the range) is left alone: re-encoding would cost more than it gives. */
export const MIN_CHANGE = 0.75;

/** Mean and standard deviation per channel of interleaved 8-bit RGB. */
export function channelStats(rgb: Uint8Array): ChannelStats {
  const n = Math.floor(rgb.length / 3);
  const sum = [0, 0, 0];
  const sq = [0, 0, 0];
  for (let i = 0; i < n * 3; i += 3) {
    for (let c = 0; c < 3; c++) { const v = rgb[i + c]; sum[c] += v; sq[c] += v * v; }
  }
  const mean = sum.map((s) => (n ? s / n : 0)) as RGB;
  const std = sq.map((s, c) => (n ? Math.sqrt(Math.max(0, s / n - mean[c] * mean[c])) : 0)) as RGB;
  return { mean, std, samples: n };
}

/** The gain and offset per channel that take the generated copy's mean and spread onto the clip's. */
export function fitColour(generated: ChannelStats, clip: ChannelStats): ColourFit {
  const gain = [0, 1, 2].map((c) => (generated.std[c] > 1 ? clip.std[c] / generated.std[c] : 1)) as RGB;
  const offset = [0, 1, 2].map((c) => clip.mean[c] - gain[c] * generated.mean[c]) as RGB;
  const sane = gain.every((g) => g >= GAIN_RANGE[0] && g <= GAIN_RANGE[1]) && generated.samples > 0 && clip.samples > 0;
  // The largest change the mapping makes, at black, mid grey and white.
  const change = Math.max(...[0, 128, 255].flatMap((v) => gain.map((g, c) => Math.abs(g * v + offset[c] - v))));
  return { gain, offset, generated, clip, applied: sane && change >= MIN_CHANGE };
}

/** ffmpeg's lutrgb for a fit (quoted, so the commas stay inside the expressions). */
export function lutrgbFilter(fit: ColourFit): string {
  const ch = (c: number): string => `'clip(val*${fit.gain[c].toFixed(5)}+${fit.offset[c].toFixed(4)},0,255)'`;
  return `lutrgb=r=${ch(0)}:g=${ch(1)}:b=${ch(2)}`;
}

/**
 * Where to compare: the clip as the model was shown it (scaled, less its inset) in the generated frame, and the same
 * pixels in the clip scaled to that size — each less `edge` on the sides that meet new space, where the template's
 * own soft pad lets the model repaint the clip.
 */
export function matchRegions(
  gen: [number, number], scaled: [number, number], inset: [number, number, number, number],
  pad: [number, number, number, number], edge = 24,
): { generated: Rect; clip: Rect } | null {
  const w = scaled[0] - inset[0] - inset[2];
  const h = scaled[1] - inset[1] - inset[3];
  const e = [0, 1, 2, 3].map((i) => (pad[i] > 0 ? edge : 0));
  const width = w - e[0] - e[2];
  const height = h - e[1] - e[3];
  if (width < 16 || height < 16 || gen[0] - pad[0] - pad[2] !== w || gen[1] - pad[1] - pad[3] !== h) return null;
  return {
    generated: { x: pad[0] + e[0], y: pad[1] + e[1], width, height },
    clip: { x: inset[0] + e[0], y: inset[1] + e[1], width, height },
  };
}
