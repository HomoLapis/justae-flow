/**
 * The reframe's colour match, with ffmpeg: a few frames of the generated frame and of the clip, compared where the
 * model was shown the clip (core/reframe/colour.ts), then the generated frame written again with the fit applied.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { channelStats, fitColour, lutrgbFilter, matchRegions, type ColourFit, type Rect } from '../core/reframe/colour.ts';

/** Every this many frames, up to SAMPLES of them, from the start of both (frame k of one is frame k of the other). */
const EVERY = 8;
const SAMPLES = 12;

function rawFrames(file: string, filters: string): Promise<Uint8Array | null> {
  return new Promise((done) => {
    const p = spawn('ffmpeg', ['-v', 'error', '-i', file, '-vf', `select='not(mod(n\\,${EVERY}))',${filters},format=rgb24`,
      '-fps_mode', 'vfr', '-frames:v', String(SAMPLES), '-f', 'rawvideo', '-'], { windowsHide: true });
    const chunks: Buffer[] = [];
    p.stdout.on('data', (d: Buffer) => chunks.push(d));
    p.on('error', () => done(null));
    p.on('close', (code) => done(code === 0 ? new Uint8Array(Buffer.concat(chunks)) : null));
  });
}

const crop = (r: Rect): string => `crop=${r.width}:${r.height}:${r.x}:${r.y}`;

/**
 * Writes `out` from `generated` with its colours matched to `clip`, and says what it did. Null when ffmpeg is not
 * there or the frames could not be read; a fit with `applied: false` when there was nothing worth changing (no file).
 */
export async function matchReframeColour(
  generated: string, clip: string,
  geometry: { gen: [number, number]; scaled: [number, number]; inset: [number, number, number, number]; pad: [number, number, number, number] },
  out: string,
): Promise<ColourFit | null> {
  const regions = matchRegions(geometry.gen, geometry.scaled, geometry.inset, geometry.pad);
  if (!regions) return null;
  const [g, c] = await Promise.all([
    rawFrames(generated, crop(regions.generated)),
    rawFrames(clip, `scale=${geometry.scaled[0]}:${geometry.scaled[1]}:flags=lanczos,${crop(regions.clip)}`),
  ]);
  if (!g?.length || !c?.length) return null;
  const n = Math.min(g.length, c.length);
  const fit = fitColour(channelStats(g.subarray(0, n)), channelStats(c.subarray(0, n)));
  if (!fit.applied) return fit;
  const ok = await new Promise<boolean>((done) => {
    const p = spawn('ffmpeg', ['-v', 'error', '-y', '-i', generated, '-vf', `format=rgb24,${lutrgbFilter(fit)},format=yuv420p`,
      '-an', '-c:v', 'libx264', '-preset', 'slow', '-crf', '12', out], { windowsHide: true });
    p.on('error', () => done(false));
    p.on('close', (code) => done(code === 0 && existsSync(out)));
  });
  return ok ? fit : null;
}
