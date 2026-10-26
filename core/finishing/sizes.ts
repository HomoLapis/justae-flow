/**
 * The sizes of a Tiled Fusion run come from the LTX pack itself, never from this repository.
 *
 * ComfyUI-LTXVideo (Lightricks, LTX-2 Community License Agreement — installed by the user in their ComfyUI, nothing of
 * it is included here) has a node, LTXVGetTilingSizes, that turns a source size, a frame count and three size choices
 * into the canvas, the tile, the overlap and the temporal window its sampler uses. JustAE Flow uses it in two ways:
 *
 *   1. in every tiled graph (core/finishing/graph.ts), wired as the official example workflows wire it: its outputs feed
 *      the canvas resize, the empty latent, LTXAddVideoICLoRAGuide's tile_frames and LTXVTiledFusionSampler's
 *      tile_width / tile_height / overlap_frac / tile_frames — so the sampler always gets what the pack decides;
 *   2. before a run, for what a card says (output size, tiles, time): a prompt of that one node on the local ComfyUI
 *      (an output node: its `summary` comes back in /history), cached per request (server/tiling.ts).
 *
 * This module only knows the node's public interface — its input names and choices and its outputs, as /object_info
 * and the node's own summary give them (read 26 Oct 2026, ComfyUI-LTXVideo 1.1.0) — not how it computes them.
 */

export type TileSizeChoice = 'qHD' | 'HD' | 'FullHD';
export type OutputSizeChoice = 'FullHD' | '4K' | '8K';

/** What one LTXVGetTilingSizes node is asked: its six required inputs. */
export interface TilingRequest {
  width: number;
  height: number;
  /** frame_count: the frames the sampler gets (after "Fast scene" and the pad). */
  frames: number;
  tileSize: TileSizeChoice;
  initialCanvas: TileSizeChoice;
  outputSize: OutputSizeChoice;
}

export interface Size { w: number; h: number }

/** The node's answer, read off its summary. */
export interface TilingSizes {
  /** initial_canvas_width × initial_canvas_height. */
  canvas: Size;
  tile: Size;
  /** output_width × output_height. */
  output: Size;
  overlapFrac: number;
  tileFrames: number;
  /** The tile grid the pack reports on the output canvas, and on the initial one (equal when the two are the same). */
  gridOutput: { x: number; y: number } | null;
  gridCanvas: { x: number; y: number } | null;
  /** Temporal chunks the pack reports. */
  chunks: number | null;
  /** The summary as the node wrote it. */
  summary: string;
}

/** The node's output slots, in its order (/object_info output_name, 26 Oct 2026). */
export const TILING_OUT = {
  canvasW: 0, canvasH: 1, tileW: 2, tileH: 3, outputW: 4, outputH: 5, overlapFrac: 6, tileFrames: 7, is8k: 8, summary: 9,
} as const;

export const TILING_NODE = 'LTXVGetTilingSizes';

export function tilingKey(r: TilingRequest): string {
  return `${Math.round(r.width)}x${Math.round(r.height)}·${Math.round(r.frames)}f·${r.tileSize}·${r.initialCanvas}·${r.outputSize}`;
}

/** The node's inputs for a request (the image input, when the graph has the frames, is added by the graph). */
export function tilingInputs(r: TilingRequest): Record<string, unknown> {
  return {
    width: Math.round(r.width), height: Math.round(r.height), frame_count: Math.max(1, Math.round(r.frames)),
    tile_size: r.tileSize, initial_canvas_size: r.initialCanvas, output_size: r.outputSize,
  };
}

/** The one-node prompt that asks the pack for a request's sizes. */
export function tilingProbeGraph(r: TilingRequest): Record<string, { class_type: string; inputs: Record<string, unknown> }> {
  return { 1: { class_type: TILING_NODE, inputs: tilingInputs(r) } };
}

const DIM = /(\d+)\s*[×x]\s*(\d+)/;

/**
 * Read the node's summary. It is text meant for people ("canvas 1920×1088 FullHD", "tile 960×544 qHD", "spatial 3×3
 * on canvas, 7×7 on output", "temporal 2 chunks"); null when a line this needs is not there, so a changed format
 * shows as "sizes at run time", never as wrong numbers.
 */
export function parseTilingSummary(text: string): TilingSizes | null {
  const line = (key: string): string | null => {
    const m = new RegExp(`^\\s*${key}\\s+(.+)$`, 'mi').exec(text);
    return m ? m[1].trim() : null;
  };
  const size = (key: string): Size | null => {
    const m = DIM.exec(line(key) ?? '');
    return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
  };
  const canvas = size('canvas');
  const tile = size('tile');
  const output = size('output');
  const overlap = Number((line('overlap') ?? '').split(/\s+/)[0]);
  const tileFrames = Number((line('tile_frames') ?? '').split(/\s+/)[0]);
  if (!canvas || !tile || !output || !Number.isFinite(overlap) || overlap <= 0 || !Number.isInteger(tileFrames) || tileFrames <= 0) return null;
  const spatial = line('spatial') ?? '';
  const grid = (re: RegExp): { x: number; y: number } | null => {
    const m = re.exec(spatial);
    return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
  };
  const both = grid(/(\d+)\s*[×x]\s*(\d+)\s+tiles/i);
  const gridCanvas = both ?? grid(/(\d+)\s*[×x]\s*(\d+)\s+on canvas/i);
  const gridOutput = both ?? grid(/(\d+)\s*[×x]\s*(\d+)\s+on output/i);
  const ch = /(\d+)\s+chunks?/i.exec(line('temporal') ?? '');
  return { canvas, tile, output, overlapFrac: overlap, tileFrames, gridCanvas, gridOutput, chunks: ch ? Number(ch[1]) : null, summary: text.trim() };
}

/**
 * The summary of a finished one-node prompt, from its /history entry (the node's UI output: {text: [summary]}).
 */
export function summaryFromHistory(entry: unknown): string | null {
  const outs = (entry as { outputs?: Record<string, { text?: unknown }> } | undefined)?.outputs;
  if (!outs) return null;
  for (const o of Object.values(outs)) {
    const t = Array.isArray(o?.text) ? o.text.find((x) => typeof x === 'string') : typeof o?.text === 'string' ? o.text : null;
    if (typeof t === 'string' && /tile_frames/.test(t)) return t;
  }
  return null;
}

/* ─── A clean-room count, for the time estimate only ────────────────── */

/**
 * How many windows of `win` cover `len` when neighbours share `frac` of a window: 1 when one window is enough,
 * otherwise 1 + ceil(rest / stride) with stride = win × (1 − frac).
 *
 * Written for JustAE Flow from the node's public outputs only (tile size, overlap, tile_frames, output size), before
 * and without reading the pack's code. It is an APPROXIMATION used for the time estimate; it is not the sampler's
 * plan — the sampler takes its tiles from LTXVGetTilingSizes in the graph, and the tile counts a card shows are the
 * ones the pack reports in its summary.
 */
export function windowsToCover(len: number, win: number, frac: number): number {
  const L = Math.max(1, len);
  const W = Math.max(1, win);
  if (W >= L) return 1;
  const stride = Math.max(1, W * (1 - Math.min(Math.max(frac, 0), 0.95)));
  return 1 + Math.ceil((L - W) / stride);
}

/** The estimate's count for a canvas: spatial windows × temporal windows (the clean-room approximation above). */
export function approxTiles(canvas: Size, s: TilingSizes, frames: number): { x: number; y: number; spatial: number; temporal: number } {
  const x = windowsToCover(canvas.w, s.tile.w, s.overlapFrac);
  const y = windowsToCover(canvas.h, s.tile.h, s.overlapFrac);
  const temporal = windowsToCover(frames, s.tileFrames, s.overlapFrac);
  return { x, y, spatial: x * y, temporal };
}

/** What a card says when the pack has not been asked yet (no local ComfyUI, or it is busy). */
export const SIZES_AT_RUN_TIME = 'Sizes from the LTX pack at run time: its LTXVGetTilingSizes node sets the canvas, the tiles and the windows (the local ComfyUI could not be asked now).';
