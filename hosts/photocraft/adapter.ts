/**
 * PhotoCraft through its control channel:
 *
 *   photocraft --control 7878 --control-token-file <file>
 *              --automation-read-root <dir> --automation-write-root <dir>
 *
 * The first frame of every connection is `auth` with the 64-hex token from the
 * token file. Files cross only through the automation roots (`app.open`,
 * `app.save`); the channel refuses every command that takes an ambient path —
 * `file.placeEmbedded` included — so an image is brought in by opening it as a
 * document and copying its layer across (`layer.copyToDocument`).
 *
 * Commands used, checked against the installed app at connect time
 * (`engine.commands`, PhotoCraft 0.12.0) and on a live session:
 *   document.inspect · layer.list · layer.new.layer · edit.fill · select.rect ·
 *   select.saveSelection · select.loadSelection · select.deselect ·
 *   layer.copyToDocument · layer.duplicate · file.close · document.activate ·
 *   edit.transform · layer.layerMask.revealSelection · layer.setLabelColor ·
 *   layer.hideLayers · layer.showLayers · layer.renameLayer · layer.select
 * plus the control methods app.open, app.save, ui.inspect.
 */

import { readFileSync } from 'node:fs';
import { PRODUCT, SLUG } from '../../core/brand.ts';
import type { CardStatus } from '../../core/storyboard/types.ts';
import { JsonLinesClient } from '../jsonlines.ts';
import type { Box, CanvasHost, CanvasPlaceRequest, HostLayer, HostSnapshot } from '../types.ts';
import { HostError } from '../types.ts';

const REQUIRED = [
  'document.inspect', 'layer.list', 'layer.new.layer', 'edit.fill', 'select.rect', 'select.saveSelection',
  'select.loadSelection', 'select.deselect', 'layer.copyToDocument', 'layer.duplicate', 'file.close',
  'document.activate', 'edit.transform', 'layer.layerMask.revealSelection', 'layer.setLabelColor',
  'layer.hideLayers', 'layer.showLayers', 'layer.renameLayer', 'layer.select', 'layer.layerMask.edit',
];

/** Layer label colours for each card state (PhotoCraft's own set). */
export const STATUS_COLOR: Record<CardStatus, string | null> = {
  idle: null, queued: 'yellow', running: 'seafoam', done: 'green', error: 'fuchsia', canceled: 'none',
};

interface Inspect {
  name: string;
  path: string | null;
  width: number;
  height: number;
  hasSelection: boolean;
  selectionBounds?: Box | null;
  selectedLayers?: number[];
  channels?: { alpha?: Array<{ name: string }> };
  layers?: Array<{ id: number; labelColor?: string }>;
}

interface ListedLayer { id: number; name: string; kind: string; visible: boolean; bounds: Box | null; depth: number; parent: number | null }

/** A stable number for a document, from its path (or its name while it has none). */
function docId(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return h >>> 0;
}

export class PhotoCraftAdapter implements CanvasHost {
  readonly id = 'photocraft' as const;
  readonly kind = 'canvas' as const;
  readonly label = 'PhotoCraft';
  readonly root: string;
  private rpc: JsonLinesClient;
  private checked = false;

  constructor(opts: { port: number; tokenFile: string; root: string }) {
    this.root = opts.root;
    this.rpc = new JsonLinesClient({
      port: opts.port,
      label: 'PhotoCraft',
      hello: () => {
        let token = '';
        try { token = readFileSync(opts.tokenFile, 'utf8').trim(); } catch {
          throw new HostError(`PhotoCraft's control token file is not there yet (${opts.tokenFile}). Start PhotoCraft with --control-token-file pointing at it.`, true);
        }
        return { method: 'auth', params: { token } };
      },
    });
  }

  private exec<T = unknown>(command: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    return this.rpc.call<T>('engine.execute', { command, params }, timeoutMs);
  }

  /** Every command this adapter relies on must exist in the PhotoCraft that is running. */
  private async check(): Promise<void> {
    if (this.checked) return;
    const list = await this.rpc.call<Array<{ id: string }>>('engine.commands', {});
    const have = new Set(list.map((c) => c.id));
    const missing = REQUIRED.filter((c) => !have.has(c));
    if (missing.length) throw new HostError(`This PhotoCraft lacks commands ${PRODUCT} needs: ${missing.join(', ')}. Update PhotoCraft.`);
    this.checked = true;
  }

  async snapshot(): Promise<HostSnapshot> {
    await this.check();
    const snap: HostSnapshot = {
      app: 'photocraft', version: '', project: { path: null, dirty: false }, comp: null,
      markers: [], layers: [], selectedLayers: [], time: 0, selection: null, channels: [],
    };
    let d: Inspect;
    try {
      d = await this.exec<Inspect>('document.inspect');
    } catch (e) {
      if (e instanceof HostError && !e.unreachable) return snap; // no document open
      throw e;
    }
    snap.project.path = d.path;
    snap.comp = { id: docId(d.path ?? `untitled:${d.name}`), name: d.name, width: d.width, height: d.height, fps: 0, duration: 0 };
    snap.selection = d.hasSelection ? d.selectionBounds ?? null : null;
    snap.selectedLayers = d.selectedLayers ?? [];
    snap.channels = (d.channels?.alpha ?? []).map((c) => c.name);
    const labels = new Map((d.layers ?? []).map((l) => [l.id, l.labelColor ?? 'none']));
    const list = await this.exec<{ layers: ListedLayer[] }>('layer.list', { flat: true });
    snap.layers = list.layers.map((l, i): HostLayer => ({
      id: l.id, index: i + 1, name: l.name, in: 0, out: 0, start: 0, label: labels.get(l.id) ?? 'none',
      type: l.kind, bounds: l.bounds, visible: l.visible,
    }));
    return snap;
  }

  private async activeIndex(): Promise<number> {
    const ui = await this.rpc.call<{ session?: { active?: number } }>('ui.inspect', {});
    return ui.session?.active ?? 0;
  }

  async exportComposite(rel: string): Promise<void> {
    await this.rpc.call('app.save', { path: rel }, 120_000);
  }

  async exportLayer(layerId: number, rel: string): Promise<void> {
    const target = await this.activeIndex();
    // The layer alone, on a canvas the size of this one, in a scratch document.
    await this.exec('layer.duplicate', { layer: layerId, document: 'new', documentName: `${SLUG}-export` });
    const temp = await this.activeIndex();
    try {
      await this.rpc.call('app.save', { path: rel }, 120_000);
    } finally {
      await this.exec('file.close', { document: temp }).catch(() => undefined);
      await this.exec('document.activate', { document: target }).catch(() => undefined);
    }
  }

  async placeImage(req: CanvasPlaceRequest): Promise<number> {
    const target = await this.activeIndex();
    if (req.above !== undefined) await this.exec('layer.select', { layer: req.above }).catch(() => undefined);
    const [bx, by, bw, bh] = req.box;
    await this.rpc.call('app.open', { path: req.rel }, 120_000);
    const temp = await this.activeIndex();
    let layerId: number;
    let iw: number;
    let ih: number;
    try {
      // The image's frame is its canvas, not its layer's bounds: those are the opaque pixels
      // only, and a cut-out with transparent margins would otherwise be stretched.
      const src = await this.exec<Inspect>('document.inspect');
      iw = src.width;
      ih = src.height;
      const list = await this.exec<{ layers: ListedLayer[] }>('layer.list', { flat: true });
      const top = list.layers[0];
      if (!top) throw new HostError(`PhotoCraft opened ${req.rel} without a layer.`);
      // offset [0,0]: the copy keeps its place relative to the canvas origin.
      const copied = await this.exec<{ layers: number[] }>('layer.copyToDocument', {
        document: target, source: temp, layers: [top.id], offset: [0, 0], name: req.name,
      });
      layerId = copied.layers[0];
    } finally {
      await this.exec('file.close', { document: temp }).catch(() => undefined);
      await this.exec('document.activate', { document: target }).catch(() => undefined);
    }
    // Map the image's frame [0,0,iw,ih] onto the box. With no selection active,
    // edit.transform takes the given rect as the source frame for the whole layer.
    await this.exec('select.deselect').catch(() => undefined);
    const k = req.fit === 'cover' ? Math.max(bw / iw, bh / ih) : 1;
    const tw = req.fit === 'cover' ? iw * k : bw;
    const th = req.fit === 'cover' ? ih * k : bh;
    const tx = bx + (bw - tw) / 2;
    const ty = by + (bh - th) / 2;
    if (Math.abs(tw - iw) > 0.5 || Math.abs(th - ih) > 0.5 || Math.abs(tx) > 0.5 || Math.abs(ty) > 0.5) {
      await this.exec('edit.transform', {
        layer: layerId, rect: [0, 0, iw, ih],
        quad: [[tx, ty], [tx + tw, ty], [tx + tw, ty + th], [tx, ty + th]],
      });
    }
    if (req.maskChannel || req.maskBox) {
      if (req.maskChannel) await this.exec('select.loadSelection', { channel: req.maskChannel });
      else {
        const [mx, my, mw, mh] = req.maskBox!;
        await this.exec('select.rect', { x: Math.round(mx), y: Math.round(my), width: Math.round(mw), height: Math.round(mh) });
      }
      await this.exec('layer.layerMask.revealSelection', { layer: layerId });
      await this.exec('select.deselect').catch(() => undefined);
      if (req.feather && req.feather > 0) {
        // The mask's own Feather (Properties panel): non-destructive, the user can change it later.
        await this.exec('layer.layerMask.edit', { layer: layerId, feather: Math.round(req.feather) }).catch(() => undefined);
      }
    }
    return layerId;
  }

  /** Open beside the current document, then come back to it: the storyboard stays where the user works. */
  async openDocument(rel: string): Promise<void> {
    const back = await this.activeIndex();
    await this.rpc.call('app.open', { path: rel }, 120_000);
    await this.exec('document.activate', { document: back }).catch(() => undefined);
  }

  async saveSelection(name: string): Promise<Box | null> {
    const before = await this.exec<Inspect>('document.inspect');
    if (!before.hasSelection) return null;
    await this.exec('select.saveSelection', { name });
    return before.selectionBounds ?? null;
  }

  async createPlaceholderBox(name: string, box: Box): Promise<number> {
    const [x, y, w, h] = box.map((v) => Math.round(v));
    await this.exec('select.rect', { x, y, width: w, height: h });
    const made = await this.exec<{ layer: number }>('layer.new.layer', { name, color: 'blue' });
    await this.exec('edit.fill', { contents: 'color', color: '#6b7c99' });
    await this.exec('select.deselect').catch(() => undefined);
    return made.layer;
  }

  async setStatus(target: { layerId?: number }, status: CardStatus): Promise<void> {
    const color = STATUS_COLOR[status];
    if (color && target.layerId !== undefined) await this.exec('layer.setLabelColor', { color, layer: target.layerId });
  }

  async setLayerVisible(layerId: number, visible: boolean): Promise<void> {
    // layer.hideLayers toggles when the layer is already hidden, so ask first.
    const l = (await this.exec<{ layers: ListedLayer[] }>('layer.list', { flat: true })).layers.find((x) => x.id === layerId);
    if (!l || l.visible === visible) return;
    await this.exec(visible ? 'layer.showLayers' : 'layer.hideLayers', { layer: layerId });
  }

  async setLayerLabel(layerId: number, label: string): Promise<void> {
    await this.exec('layer.setLabelColor', { color: label, layer: layerId });
  }

  async renameLayer(layerId: number, name: string): Promise<void> {
    await this.exec('layer.renameLayer', { layer: layerId, name });
  }

  close(): void {
    this.rpc.close();
  }
}
