/**
 * Segment derivation from AE comp markers.
 *
 * Convention: comp markers are taken in time order and paired sequentially.
 *   (M1, M2) = segment 1 → ends at M2's time, label = `${M1.comment} → ${M2.comment}`.
 * If the user renames a marker in AE (default is empty / auto-numbered),
 * the label updates live.
 *
 * Segment ID stability: for v1 the id is `seg-${index}` based on position
 * in the sorted pair list. Moving a single marker keeps the same id;
 * adding a marker mid-list shifts subsequent ids, dropping their
 * session-only prompt/attachment state. Good enough for a single edit
 * session — future revision can hash the marker times instead.
 */

import type { MarkerInfo, AdjustmentLayerInfo } from '../bridge/extendscript';

export type SegmentSource = 'marker' | 'adj';

export interface Segment {
  id: string;
  index: number;          // 0-based position in the segments list
  startTime: number;
  endTime: number;
  duration: number;
  startMarkerName: string;
  endMarkerName: string;
  label: string;          // e.g. "1 → 2" (markers) or the layer name (storyboard)
  /** Which source produced this segment. Defaults to 'marker'. */
  source?: SegmentSource;
  /** Storyboard only: AE label color index (1-16, 0 = none) of the placeholder. */
  labelColor?: number;
  /** Storyboard only: the adjustment layer's name (used to disable it after place). */
  layerName?: string;
}

/**
 * Pair markers sorted by time → segments. If the count is odd, the last
 * marker is silently dropped (the SegmentsPanel surfaces the warning).
 */
export function deriveSegments(markers: MarkerInfo[]): Segment[] {
  const sorted = [...markers].sort((a, b) => a.time - b.time);
  const out: Segment[] = [];
  for (let i = 0; i + 1 < sorted.length; i += 2) {
    const start = sorted[i];
    const end = sorted[i + 1];
    const startName = start.comment.trim() || String(i + 1);
    const endName = end.comment.trim() || String(i + 2);
    out.push({
      id: `seg-${out.length}`,
      index: out.length,
      startTime: start.time,
      endTime: end.time,
      duration: Math.max(0, end.time - start.time),
      startMarkerName: startName,
      endMarkerName: endName,
      label: `${startName} → ${endName}`,
    });
  }
  return out;
}

/**
 * Storyboard segments from the live set of visible adjustment layers (already
 * sorted by inPoint host-side). IDs are content-stable — derived from the
 * layer's inPoint + name, namespaced "adj-" so they never collide with marker
 * "seg-N" ids in the shared per-segment config maps. Stable ids matter because
 * the panel re-polls every few seconds: a shot keeps its prompt/attachments even
 * as other layers appear, disappear, or toggle visibility around it.
 */
export function deriveStoryboardSegments(layers: AdjustmentLayerInfo[]): Segment[] {
  const seen = new Set<string>();
  return (layers || []).map((l, i) => {
    const slug = (l.name || `shot-${i + 1}`)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'shot';
    const inKey = Math.round((l.inPoint || 0) * 1000); // ms — survives float jitter
    let id = `adj-${inKey}-${slug}`;
    while (seen.has(id)) id += `-${i}`; // guarantee uniqueness on exact duplicates
    seen.add(id);
    return {
      id,
      index: i,
      startTime: l.inPoint,
      endTime: l.outPoint,
      duration: Math.max(0, l.duration),
      startMarkerName: l.name,
      endMarkerName: '',
      label: l.name || `Shot ${i + 1}`,
      source: 'adj' as const,
      labelColor: l.label || 0,
      layerName: l.name,
    };
  });
}

export function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds)) return '—';
  const s = seconds.toFixed(2);
  return `${s}s`;
}

export function formatSegmentRange(seg: Segment): string {
  return `${formatSeconds(seg.startTime)} → ${formatSeconds(seg.endTime)}`;
}
