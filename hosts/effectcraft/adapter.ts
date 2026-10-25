/**
 * EffectCraft through its control channel (`effectcraft --control 9877`).
 *
 * Every engine command used here was checked against the installed app with
 * `effectcraft-cli commands --json` and on a live session (EffectCraft 0.11.1):
 *
 *   project.summary · comp.info · markers.list · markers.set (label, comment,
 *   cuePoint) · comp.addMarker · file.import · layer.addItem · layer.timing ·
 *   file.replaceFootage · file.importPlaceholder · layer.revealSource ·
 *   item.metadata · edit.label · layer.setComment · layer.rename ·
 *   layer.setTrackMatte · comp.new · comp.open · comp.settings · prop.get · prop.set · prop.addKey ·
 *   layer.addMask · layer.mask.set · layer.setSwitch · footage.relink · script.run
 *   (the work-area render, through the host script's renderWorkAreaToFile)
 *
 * plus the control method `render.frame`. The channel has no authentication
 * and listens on loopback only; the user turns it on.
 */

import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LEGACY_SLUG, PRODUCT, SLUG } from '../../core/brand.ts';
import { JsonLinesClient } from '../jsonlines.ts';
import type { CardStatus } from '../../core/storyboard/types.ts';
import type {
  CompRequest, HostLayer, HostMarker, HostSnapshot, ItemInfo, OutpaintRequest, PlaceRequest, ReframeRequest, RenderRequest, RenderResult, TimelineHost,
} from '../types.ts';
import { HostError } from '../types.ts';

/** The host script the Flow window runs in EffectCraft (After Effects scripting), shared with the work-area render. */
const HOST_SCRIPT = fileURLToPath(new URL('../../extensions/effectcraft/flow-host.jsx', import.meta.url));

/** Marker/layer label for each card state. Names are EffectCraft's own (After Effects' label set). */
export const STATUS_LABEL: Record<CardStatus, string | null> = {
  idle: null,
  queued: 'Yellow',
  running: 'Cyan',
  done: 'Green',
  error: 'Fuchsia',
  canceled: 'None',
};

export const CUE_NAME = SLUG;
/** Markers tagged before the rename are still ours. */
const CUE_NAMES = new Set([SLUG, LEGACY_SLUG]);

interface RawMarker {
  index: number; time: number; duration: number; comment: string; label: string;
  cuePoint: { name?: string; params?: Array<[string, string]> } | null;
}

export class EffectCraftAdapter implements TimelineHost {
  readonly id = 'effectcraft' as const;
  readonly kind = 'timeline' as const;
  readonly label = 'EffectCraft';
  private rpc: JsonLinesClient;
  private version = '';
  private hostScript: string;

  constructor(port = 9877, hostScript = HOST_SCRIPT) {
    this.rpc = new JsonLinesClient({ port, label: 'EffectCraft' });
    this.hostScript = hostScript;
  }

  private exec<T = unknown>(command: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    return this.rpc.call<T>('engine.execute', { command, params }, timeoutMs);
  }

  async snapshot(): Promise<HostSnapshot> {
    if (!this.version) {
      const caps = await this.exec<{ version?: string }>('app.capabilities');
      this.version = caps.version ?? '?';
    }
    const summary = await this.exec<{ activeComp: number | null; path: string | null; dirty: boolean; selectedLayers?: number[]; time?: number }>('project.summary');
    const snap: HostSnapshot = {
      app: 'effectcraft',
      version: this.version,
      project: { path: summary.path, dirty: summary.dirty },
      comp: null,
      markers: [],
      layers: [],
      selectedLayers: summary.selectedLayers ?? [],
      time: summary.time ?? 0,
    };
    if (summary.activeComp == null) return snap;
    const info = await this.exec<{
      id: number; name: string; width: number; height: number; frameRate: number; duration: number; workArea?: [number, number];
      layers: Array<{ id: number; index: number; name: string; in: number; out: number; start: number; label: string; type: string; switches?: { video?: boolean } }>;
    }>('comp.info');
    snap.comp = {
      id: info.id, name: info.name, width: info.width, height: info.height, fps: info.frameRate, duration: info.duration,
      // comp.info reports the work area as [start, end] seconds (measured on 0.11.1).
      workArea: Array.isArray(info.workArea) && info.workArea.length === 2 ? [info.workArea[0], info.workArea[1]] : undefined,
    };
    snap.layers = info.layers.map((l): HostLayer => ({
      id: l.id, index: l.index, name: l.name, in: l.in, out: l.out, start: l.start, label: l.label, type: l.type,
      visible: l.switches?.video,
    }));
    const markers = await this.exec<RawMarker[]>('markers.list');
    snap.markers = markers.map((m): HostMarker => ({
      index: m.index, time: m.time, duration: m.duration, comment: m.comment, label: m.label,
      cardId: CUE_NAMES.has(m.cuePoint?.name ?? '') ? (m.cuePoint?.params?.find(([k]) => k === 'card')?.[1] ?? null) : null,
    }));
    return snap;
  }

  async frameAt(time: number, outPath: string): Promise<string> {
    // render.frame writes a temp PNG of the active comp, exactly as the viewer composites it.
    const r = await this.rpc.call<{ path: string }>('render.frame', { time }, 120_000);
    copyFileSync(r.path, outPath);
    return outPath;
  }

  async tagMarker(index: number, cardId: string): Promise<void> {
    await this.exec('markers.set', { index, cuePoint: { name: CUE_NAME, params: [['card', cardId]] } });
  }

  async setMarkerComment(index: number, comment: string): Promise<void> {
    await this.exec('markers.set', { index, comment });
  }

  async setStatus(target: { markerIndex?: number; layerId?: number }, status: CardStatus): Promise<void> {
    const label = STATUS_LABEL[status];
    if (!label) return;
    if (target.markerIndex !== undefined) await this.exec('markers.set', { index: target.markerIndex, label });
    if (target.layerId !== undefined) await this.exec('edit.label', { label, layers: [target.layerId] });
  }

  async place(req: PlaceRequest): Promise<{ itemId: number; layerId: number }> {
    const imp = await this.exec<{ items: number[]; errors: unknown[] }>('file.import', { paths: [req.file] }, 120_000);
    const itemId = imp.items?.[0];
    if (itemId === undefined) throw new HostError(`EffectCraft could not import ${req.file}: ${JSON.stringify(imp.errors)}`);
    const frameForFrame = req.sourceStart !== undefined;
    const added = await this.exec<{ layer: number }>('layer.addItem', {
      item: itemId, time: frameForFrame ? req.sourceStart : req.time, ...(req.position ? { position: req.position } : {}),
      ...(req.index !== undefined ? { index: req.index } : {}),
      ...(req.endTime !== undefined && !frameForFrame ? { duration: Math.max(0.04, req.endTime - req.time) } : {}),
    });
    const layerId = added.layer;
    if (frameForFrame) {
      await this.exec('layer.timing', { layers: [layerId], in: req.time, ...(req.endTime !== undefined ? { out: req.endTime } : {}) }).catch(() => undefined);
    } else if (req.endTime !== undefined) {
      await this.exec('layer.timing', { layers: [layerId], out: req.endTime }).catch(() => undefined);
    }
    await this.exec('layer.rename', { layer: layerId, name: req.name });
    if (req.comment) await this.exec('layer.setComment', { layers: [layerId], comment: req.comment });
    return { itemId, layerId };
  }

  /**
   * Swap the file under an item, keeping the box each layer shows on screen.
   *
   * file.replaceFootage keeps every layer's transform, timing and name — but a
   * result rarely has the placeholder's exact pixel size (LTX works in steps of
   * 64), so the scale is corrected by the size change: the user's framing stays.
   */
  async replaceFootage(itemId: number, file: string, layerIds: number[] = []): Promise<void> {
    const before = layerIds.length ? await this.itemInfo(itemId) : null;
    await this.exec('file.replaceFootage', { item: itemId, path: file }, 120_000);
    if (!before?.width || !before.height) return;
    const after = await this.itemInfo(itemId);
    if (!after?.width || !after.height || (after.width === before.width && after.height === before.height)) return;
    const k = Math.max(before.width / after.width, before.height / after.height);
    for (const layer of layerIds) {
      const cur = await this.exec<{ value: number[] }>('prop.get', { layer, path: 'transform/scale' }).catch(() => null);
      if (!cur) continue;
      await this.exec('prop.set', { layer, path: 'transform/scale', value: cur.value.slice(0, 2).map((v) => Math.round(v * k * 1000) / 1000) }).catch(() => undefined);
    }
  }

  /**
   * Lay a result exactly over its source layer: same position, rotation and
   * anchor, scale compensated for the new pixel size (an ×2 upscale lands at
   * half the scale), placed just above it. The source is left as it was.
   */
  async matchLayer(targetLayer: number, targetItem: number, sourceLayer: number, sourceItem: number, perAxis = false): Promise<void> {
    const [src, dst] = await Promise.all([this.itemInfo(sourceItem), this.itemInfo(targetItem)]);
    const get = (layer: number, path: string): Promise<number[] | null> =>
      this.exec<{ value: number[] }>('prop.get', { layer, path }).then((r) => r.value, () => null);
    const pos = await get(sourceLayer, 'transform/position');
    const scale = await get(sourceLayer, 'transform/scale');
    const rot = await this.exec<{ value: number }>('prop.get', { layer: sourceLayer, path: 'transform/rotation' }).then((r) => r.value, () => null);
    const k = src?.width && dst?.width ? src.width / dst.width : 1;
    const ky = perAxis && src?.height && dst?.height ? src.height / dst.height : k;
    if (pos) await this.exec('prop.set', { layer: targetLayer, path: 'transform/position', value: pos.slice(0, 2) }).catch(() => undefined);
    if (scale) await this.exec('prop.set', { layer: targetLayer, path: 'transform/scale', value: [Math.round(scale[0] * k * 1000) / 1000, Math.round(scale[1] * ky * 1000) / 1000] }).catch(() => undefined);
    if (typeof rot === 'number' && rot !== 0) await this.exec('prop.set', { layer: targetLayer, path: 'transform/rotation', value: rot }).catch(() => undefined);
  }

  /** Scale a freshly placed layer so its media covers the comp frame (no bars). */
  async coverComp(layerId: number, itemId: number, compW: number, compH: number): Promise<void> {
    const info = await this.itemInfo(itemId);
    if (!info?.width || !info.height) return;
    const k = Math.max(compW / info.width, compH / info.height);
    if (Math.abs(k - 1) < 1e-3) return;
    await this.exec('prop.set', { layer: layerId, path: 'transform/scale', value: [Math.round(k * 100000) / 1000, Math.round(k * 100000) / 1000] });
  }

  async fitComp(layerId: number, itemId: number, compW: number, compH: number): Promise<void> {
    const info = await this.itemInfo(itemId);
    if (!info?.width || !info.height) return;
    const kx = compW / info.width;
    const ky = compH / info.height;
    if (Math.abs(kx - 1) < 1e-3 && Math.abs(ky - 1) < 1e-3) return;
    await this.exec('prop.set', { layer: layerId, path: 'transform/scale', value: [Math.round(kx * 100000) / 1000, Math.round(ky * 100000) / 1000] });
  }

  async createPlaceholder(req: { name: string; width: number; height: number; fps: number; duration: number; time: number }): Promise<{ itemId: number; layerId: number }> {
    const ph = await this.exec<{ item: number }>('file.importPlaceholder', {
      name: req.name, width: req.width, height: req.height, frameRate: req.fps, duration: req.duration,
    });
    const added = await this.exec<{ layer: number }>('layer.addItem', { item: ph.item, time: req.time });
    await this.exec('project.setComment', { items: [ph.item], comment: `${PRODUCT} placeholder` }).catch(() => undefined);
    return { itemId: ph.item, layerId: added.layer };
  }

  async sourceOfLayer(layerId: number): Promise<number | null> {
    try {
      const r = await this.exec<{ item?: number }>('layer.revealSource', { layer: layerId });
      return typeof r.item === 'number' ? r.item : null;
    } catch {
      return null;
    }
  }

  async itemInfo(itemId: number): Promise<ItemInfo | null> {
    try {
      const r = await this.exec<{ item: { id: number; name: string; path: string | null; kind: string; width: number; height: number; duration: number; frameRate: number; comment: string } }>('item.metadata', { item: itemId });
      const i = r.item;
      return { id: i.id, name: i.name, path: i.path, kind: i.kind, width: i.width, height: i.height, duration: i.duration, frameRate: i.frameRate, comment: i.comment };
    } catch {
      return null;
    }
  }

  async addMarker(time: number, comment: string): Promise<void> {
    await this.exec('comp.addMarker', { time, comment });
  }

  async setLayerComment(layerId: number, comment: string): Promise<void> {
    await this.exec('layer.setComment', { layers: [layerId], comment });
  }

  /** Point a footage item at its file's new location, keeping its interpretation. */
  async relink(itemId: number, path: string): Promise<void> {
    await this.exec('footage.relink', { item: itemId, path });
  }

  async setLayerVisible(layerId: number, visible: boolean): Promise<void> {
    await this.exec('layer.setSwitch', { layers: [layerId], switch: 'video', value: visible });
  }

  async setLayerLabel(layerId: number, label: string): Promise<void> {
    await this.exec('edit.label', { label, layers: [layerId] });
  }

  async renameLayer(layerId: number, name: string): Promise<void> {
    await this.exec('layer.rename', { layer: layerId, name });
  }

  /** EffectCraft switches the matte layer's video off itself, as After Effects does; `matte: null` takes it off. */
  async setTrackMatte(layerId: number, matteLayerId: number | null, kind: 'luma' | 'alpha'): Promise<void> {
    await this.exec('layer.setTrackMatte', matteLayerId === null ? { layer: layerId, matte: null } : { layer: layerId, matte: matteLayerId, kind });
  }

  async buildReframe(req: ReframeRequest): Promise<{ compId: number; layerId: number }> {
    const made = await this.exec<{ comp: number }>('comp.new', {
      name: req.name, width: req.width, height: req.height, frameRate: req.fps, duration: req.duration, open: true,
    });
    const added = await this.exec<{ layer: number }>('layer.addItem', { item: req.itemId, time: 0 });
    await this.exec('layer.rename', { layer: added.layer, name: req.layerName });
    await this.exec('layer.setComment', { layers: [added.layer], comment: req.comment }).catch(() => undefined);
    if (req.keys.length === 1) {
      const k = req.keys[0];
      await this.exec('prop.set', { layer: added.layer, path: 'transform/position', value: [k.x, k.y] });
    } else {
      for (const k of req.keys) {
        await this.exec('prop.addKey', { layer: added.layer, path: 'transform/position', time: k.t, value: [k.x, k.y] });
      }
    }
    return { compId: made.comp, layerId: added.layer };
  }

  async buildOutpaint(req: OutpaintRequest): Promise<{ compId: number; fillLayer: number; fillItem: number; clipLayer: number }> {
    const imp = await this.exec<{ items: number[]; errors: unknown[] }>('file.import', { paths: [req.file] }, 120_000);
    const fillItem = imp.items?.[0];
    if (fillItem === undefined) throw new HostError(`EffectCraft could not import ${req.file}: ${JSON.stringify(imp.errors)}`);
    const made = await this.exec<{ comp: number }>('comp.new', {
      name: req.name, width: req.width, height: req.height, frameRate: req.fps, duration: req.duration, open: true,
    });
    const fill = await this.exec<{ layer: number }>('layer.addItem', { item: fillItem, time: 0 });
    await this.exec('prop.set', { layer: fill.layer, path: 'transform/scale', value: [req.fillScale, req.fillScale] });
    await this.exec('layer.rename', { layer: fill.layer, name: req.fillName });
    await this.exec('layer.setComment', { layers: [fill.layer], comment: req.comment }).catch(() => undefined);
    const clip = await this.exec<{ layer: number }>('layer.addItem', { item: req.itemId, time: 0, index: 1 });
    await this.exec('prop.set', { layer: clip.layer, path: 'transform/scale', value: [req.clipScale, req.clipScale] });
    await this.exec('prop.set', { layer: clip.layer, path: 'transform/position', value: req.clipCentre });
    await this.exec('layer.rename', { layer: clip.layer, name: req.clipName });
    // The clip's own pixels, softened only where they meet the generated space.
    await this.exec('layer.addMask', { layer: clip.layer, shape: 'rect', rect: req.mask });
    await this.exec('layer.mask.set', { layer: clip.layer, mask: 1, field: 'feather', value: req.feather });
    return { compId: made.comp, fillLayer: fill.layer, fillItem, clipLayer: clip.layer };
  }

  async openComp(compId: number): Promise<void> {
    await this.exec('comp.open', { comp: compId });
  }

  /** comp.settings {duration} (Composition Settings…), on the active comp. */
  async setCompDuration(seconds: number): Promise<void> {
    await this.exec('comp.settings', { duration: seconds });
  }

  /**
   * The host script's renderWorkAreaToFile (extensions/effectcraft/flow-host.jsx), run
   * through script.run like the Flow window's own calls: EffectCraft's render queue,
   * its H.264 or ProRes output module, the other queued items left alone. It renders
   * the active comp; the caller opens the right one first.
   */
  async renderRange(req: RenderRequest): Promise<RenderResult> {
    mkdirSync(req.dir, { recursive: true });
    const call = `renderWorkAreaToFile(${Number(req.cap) || 15}, ${JSON.stringify(req.dir)}, ${Number(req.start)}, ${Number(req.duration)}, ${JSON.stringify(req.name)}, ${JSON.stringify(req.format ?? 'h264')})`;
    const r = await this.exec<{ ok: boolean; result: unknown; error: { message: string } | null }>(
      'script.run', { code: `${readFileSync(this.hostScript, 'utf8')}\n${call}`, name: `${PRODUCT} render` }, 600_000,
    );
    if (!r.ok || r.error) throw new HostError(`EffectCraft could not render the comp: ${r.error?.message ?? 'the script failed'}`);
    let out: { success?: boolean; error?: string; path?: string; duration?: number; workAreaStart?: number; capped?: boolean };
    try { out = JSON.parse(String(r.result)); } catch { throw new HostError(`EffectCraft's render answered something unreadable: ${String(r.result).slice(0, 200)}`); }
    if (!out.success || !out.path) throw new HostError(`EffectCraft could not render the comp: ${out.error ?? 'no file'}`);
    return { path: out.path, start: out.workAreaStart ?? req.start, duration: out.duration ?? req.duration, capped: !!out.capped };
  }

  async importFile(path: string): Promise<number> {
    const imp = await this.exec<{ items: number[]; errors: unknown[] }>('file.import', { paths: [path] }, 120_000);
    const itemId = imp.items?.[0];
    if (itemId === undefined) throw new HostError(`EffectCraft could not import ${path}: ${JSON.stringify(imp.errors)}`);
    return itemId;
  }

  async buildComp(req: CompRequest): Promise<{ compId: number; layers: number[] }> {
    const made = await this.exec<{ comp: number }>('comp.new', {
      name: req.name, width: req.width, height: req.height, frameRate: req.fps, duration: req.duration, open: true,
    });
    // Added bottom first, each new one on top: the stack ends as listed.
    const ids: number[] = new Array(req.layers.length);
    for (let i = req.layers.length - 1; i >= 0; i--) {
      const l = req.layers[i];
      const added = await this.exec<{ layer: number }>('layer.addItem', { item: l.itemId, time: 0, index: 1 });
      ids[i] = added.layer;
      await this.exec('layer.rename', { layer: added.layer, name: l.name });
      if (l.comment) await this.exec('layer.setComment', { layers: [added.layer], comment: l.comment }).catch(() => undefined);
      if (l.scale !== undefined && Math.abs(l.scale - 100) > 1e-3) await this.exec('prop.set', { layer: added.layer, path: 'transform/scale', value: [l.scale, l.scale] });
      if (l.position) await this.exec('prop.set', { layer: added.layer, path: 'transform/position', value: l.position });
      if (l.visible === false) await this.setLayerVisible(added.layer, false);
    }
    return { compId: made.comp, layers: ids };
  }

  close(): void {
    this.rpc.close();
  }
}
