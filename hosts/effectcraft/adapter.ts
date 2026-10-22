/**
 * EffectCraft through its control channel (`effectcraft --control 9877`).
 *
 * Every engine command used here was checked against the installed app with
 * `effectcraft-cli commands --json` and on a live session (EffectCraft 0.11.1):
 *
 *   project.summary · comp.info · markers.list · markers.set (label, comment,
 *   cuePoint) · comp.addMarker · file.import · layer.addItem · layer.timing ·
 *   file.replaceFootage · file.importPlaceholder · layer.revealSource ·
 *   item.metadata · edit.label · layer.setComment · layer.rename
 *
 * plus the control method `render.frame`. The channel has no authentication
 * and listens on loopback only; the user turns it on.
 */

import { copyFileSync } from 'node:fs';
import { JsonLinesClient } from '../jsonlines.ts';
import type { CardStatus } from '../../core/storyboard/types.ts';
import type { HostLayer, HostMarker, HostSnapshot, ItemInfo, PlaceRequest, TimelineHost } from '../types.ts';
import { HostError } from '../types.ts';

/** Marker/layer label for each card state. Names are EffectCraft's own (After Effects' label set). */
export const STATUS_LABEL: Record<CardStatus, string | null> = {
  idle: null,
  queued: 'Yellow',
  running: 'Cyan',
  done: 'Green',
  error: 'Fuchsia',
  canceled: 'None',
};

export const CUE_NAME = 'shiftfield';

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

  constructor(port = 9877) {
    this.rpc = new JsonLinesClient({ port, label: 'EffectCraft' });
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
      id: number; name: string; width: number; height: number; frameRate: number; duration: number;
      layers: Array<{ id: number; index: number; name: string; in: number; out: number; start: number; label: string; type: string }>;
    }>('comp.info');
    snap.comp = { id: info.id, name: info.name, width: info.width, height: info.height, fps: info.frameRate, duration: info.duration };
    snap.layers = info.layers.map((l): HostLayer => ({ id: l.id, index: l.index, name: l.name, in: l.in, out: l.out, start: l.start, label: l.label, type: l.type }));
    const markers = await this.exec<RawMarker[]>('markers.list');
    snap.markers = markers.map((m): HostMarker => ({
      index: m.index, time: m.time, duration: m.duration, comment: m.comment, label: m.label,
      cardId: m.cuePoint?.name === CUE_NAME ? (m.cuePoint.params?.find(([k]) => k === 'card')?.[1] ?? null) : null,
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
    const added = await this.exec<{ layer: number }>('layer.addItem', {
      item: itemId, time: req.time, ...(req.position ? { position: req.position } : {}),
      ...(req.index !== undefined ? { index: req.index } : {}),
      ...(req.endTime !== undefined ? { duration: Math.max(0.04, req.endTime - req.time) } : {}),
    });
    const layerId = added.layer;
    if (req.endTime !== undefined) {
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
  async matchLayer(targetLayer: number, targetItem: number, sourceLayer: number, sourceItem: number): Promise<void> {
    const [src, dst] = await Promise.all([this.itemInfo(sourceItem), this.itemInfo(targetItem)]);
    const get = (layer: number, path: string): Promise<number[] | null> =>
      this.exec<{ value: number[] }>('prop.get', { layer, path }).then((r) => r.value, () => null);
    const pos = await get(sourceLayer, 'transform/position');
    const scale = await get(sourceLayer, 'transform/scale');
    const rot = await this.exec<{ value: number }>('prop.get', { layer: sourceLayer, path: 'transform/rotation' }).then((r) => r.value, () => null);
    const k = src?.width && dst?.width ? src.width / dst.width : 1;
    if (pos) await this.exec('prop.set', { layer: targetLayer, path: 'transform/position', value: pos.slice(0, 2) }).catch(() => undefined);
    if (scale) await this.exec('prop.set', { layer: targetLayer, path: 'transform/scale', value: scale.slice(0, 2).map((v) => Math.round(v * k * 1000) / 1000) }).catch(() => undefined);
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

  async createPlaceholder(req: { name: string; width: number; height: number; fps: number; duration: number; time: number }): Promise<{ itemId: number; layerId: number }> {
    const ph = await this.exec<{ item: number }>('file.importPlaceholder', {
      name: req.name, width: req.width, height: req.height, frameRate: req.fps, duration: req.duration,
    });
    const added = await this.exec<{ layer: number }>('layer.addItem', { item: ph.item, time: req.time });
    await this.exec('project.setComment', { items: [ph.item], comment: 'shiftfield placeholder' }).catch(() => undefined);
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

  close(): void {
    this.rpc.close();
  }
}
