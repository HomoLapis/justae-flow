/**
 * Delivery masters made locally from what ComfyUI saved: ProRes 4444 or a
 * 16-bit PNG sequence, from the workflow's lossless save (FFV1 or PNG 16-bit).
 * The JustAE Flow server runs ffmpeg (it has to be on the PATH); transcoding a
 * compressed source would only re-wrap the damage, so that is refused with the
 * reason rather than done quietly.
 */

import { serverJson } from '../bridge/server';

const LOSSLESS = /\.(mkv|png|tiff?|exr)$/i;

export interface MasterResult {
  ok: boolean;
  path?: string;
  reason?: string;
}

/** Is this file a lossless source we can master from? */
export function isLosslessSource(path: string): boolean {
  return LOSSLESS.test(path);
}

export async function makeProRes4444(src: string, fps: number): Promise<MasterResult> {
  if (!isLosslessSource(src)) {
    return {
      ok: false,
      reason: `The workflow saved a compressed file (${src.split(/[\\/]/).pop()}). A ProRes made from it would not be a master — set the output profile so the workflow saves FFV1 or PNG 16-bit.`,
    };
  }
  return serverJson<MasterResult>('/api/fs/master', { kind: 'prores4444', src, fps }).catch((e) => ({ ok: false, reason: String(e) }));
}

/** A PNG 16-bit sequence from a lossless video; returns the FIRST frame's path (imported as a sequence). */
export async function makePng16Sequence(src: string): Promise<MasterResult> {
  if (!/\.(mkv|mov)$/i.test(src)) {
    return { ok: false, reason: `Not a lossless video to extract from (${src.split(/[\\/]/).pop()}).` };
  }
  return serverJson<MasterResult>('/api/fs/master', { kind: 'png16', src }).catch((e) => ({ ok: false, reason: String(e) }));
}
