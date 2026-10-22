/** Generate a UUID v4. Uses crypto.randomUUID where available, falls back to Math.random. */
export function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  const hex = (n: number, l: number): string => n.toString(16).padStart(l, '0');
  const r = (): number => Math.floor(Math.random() * 0x10000);
  return `${hex(r(), 4)}${hex(r(), 4)}-${hex(r(), 4)}-${hex(0x4000 | (r() & 0x0fff), 4)}-${hex(0x8000 | (r() & 0x3fff), 4)}-${hex(r(), 4)}${hex(r(), 4)}${hex(r(), 4)}`;
}

export function timestamp(): string {
  const d = new Date();
  const p = (n: number, l = 2): string => String(n).padStart(l, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Format AE seconds as a frame-accurate, filename-safe timecode HH-MM-SS-ff. */
export function timecode(seconds: number, fps: number): string {
  const safeFps = fps > 0 ? fps : 30;
  const totalFrames = Math.round(seconds * safeFps);
  const ff = totalFrames % safeFps;
  const totalSeconds = Math.floor(totalFrames / safeFps);
  const ss = totalSeconds % 60;
  const mm = Math.floor(totalSeconds / 60) % 60;
  const hh = Math.floor(totalSeconds / 3600);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(hh)}-${p(mm)}-${p(ss)}-${p(ff)}`;
}

/**
 * Professional name for an AE-captured frame, e.g.
 *   "MyComp"  @ 4.2s, 30fps  →  MyComp_frame_00-00-04-06_20260518-143022.png
 */
export function captureFrameName(compName: string, seconds: number, fps: number, ext = 'png'): string {
  const base = slugFromPrompt(compName, 40);
  return `${base}_frame_${timecode(seconds, fps)}_${timestamp()}.${ext.replace(/^\./, '')}`;
}

/** Professional name for an AE work-area render used as a reference clip. */
export function captureWorkAreaName(compName: string, ext = 'mp4'): string {
  const base = slugFromPrompt(compName, 40);
  return `${base}_workarea_${timestamp()}.${ext.replace(/^\./, '')}`;
}

/** Build a filesystem-safe name from a prompt (≤ 40 chars, words only). */
export function slugFromPrompt(prompt: string, maxLen = 40): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen);
  return slug || 'shot';
}

/**
 * Output filename — content-first, timestamp as version suffix.
 * Examples:
 *   "Neon city at night" + mp4              →  neon-city-at-night_20260518-143022.mp4
 *   "Portrait test"      + png + suffix=02  →  portrait-test_20260518-143200_02.png
 */
export function defaultOutputName(prompt: string, ext: string, suffix?: string): string {
  const sfx = suffix ? `_${suffix}` : '';
  return `${slugFromPrompt(prompt)}_${timestamp()}${sfx}.${ext.replace(/^\./, '')}`;
}

/**
 * Human-readable layer name shown in the AE timeline.
 * Keeps the original casing and spacing of the prompt, just trimmed to
 * a sensible length. No brand prefix — AE will already track the source
 * file in the project panel; the layer label is for the operator's eye.
 */
export function layerNameFromPrompt(prompt: string, maxLen = 60): string {
  const trimmed = prompt.trim().replace(/\s+/g, ' ');
  if (!trimmed) return 'Generated shot';
  if (trimmed.length <= maxLen) return trimmed;
  return trimmed.slice(0, maxLen - 1).replace(/[\s,.;:!?-]+$/, '') + '…';
}
