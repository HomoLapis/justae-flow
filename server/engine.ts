/**
 * The storyboard engine: keeps the cards in step with the host project, runs
 * the generation queue, and puts every result back where it belongs.
 *
 * Precedence when both sides changed (UX.md): the host owns time, position and
 * duration; the storyboard owns prompt, workflow, parameters and versions. The
 * one exception is the marker text, which mirrors the prompt both ways — an
 * edit made in the host wins at the next poll.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { ComfyClient, type ComfyHealth } from '../core/comfy/client.ts';
import type { ObjectInfo, OutputFile } from '../core/comfy/types.ts';
import { getRef, planLength, planSize, resolveModels, setRef } from '../core/workflows/manifest.ts';
import { newCardId, type Card, type CardStatus, type Sidecar, type Version } from '../core/storyboard/types.ts';
import { layerNameFromPrompt, slugFromPrompt } from '../core/lib/filenames.ts';
import { EffectCraftAdapter } from '../hosts/effectcraft/adapter.ts';
import type { HostAdapter, HostSnapshot } from '../hosts/types.ts';
import { HostError } from '../hosts/types.ts';
import { saveSettings, type Settings } from './config.ts';
import type { WorkflowLibrary } from './library.ts';

export interface EngineState {
  host: { ok: boolean; app: string; version?: string; error?: string; project: string | null; unsaved: boolean; comp: HostSnapshot['comp']; time: number; selectedLayers: number[] };
  comfy: ComfyHealth & { url: string };
  cards: CardView[];
  queue: { running: string | null; pending: string[]; paused: boolean; recovered: number; ready: number };
  settings: Settings;
  workflows: ReturnType<WorkflowLibrary['list']>;
  mediaDir: string;
  notice: string | null;
}

export interface CardView extends Card {
  /** Where the card sits on the comp timeline, seconds. */
  at: number;
  /** Slot length the host gives it, seconds (until the next marker, or the layer's length). */
  slotSeconds: number | null;
  previewRev: number;
  label: string;
  /** What a run would produce right now — said before the render, not discovered after. */
  plan: { width?: number; height?: number; sizeNote?: string; seconds?: number; lengthNote?: string };
}

const MAX_MARKER_SLOT = 20;

export class Engine {
  settings: Settings;
  private library: WorkflowLibrary;
  private comfy: ComfyClient;
  private host: HostAdapter;
  private sidecar: Sidecar = { schema: 1, app: 'shiftfield', host: 'effectcraft', project: null, cards: [] };
  private sidecarPath = '';
  mediaDir = '';
  private snap: HostSnapshot | null = null;
  private hostError: string | undefined = 'Not connected yet.';
  private comfyHealth: ComfyHealth = { online: false, message: 'Not checked yet.' };
  private objectInfo: ObjectInfo | null = null;
  private markerIndex = new Map<string, number>();
  private layerOf = new Map<string, { in: number; out: number }>();
  private queue: string[] = [];
  private running: { cardId: string; jobId: string | null; stop: (() => void) | null; cancelled: boolean } | null = null;
  private paused = false;
  private recovered = 0;
  private previewRev = new Map<string, number>();
  private thumbQueue = new Set<string>();
  private listeners = new Set<() => void>();
  private syncing = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private notice: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly clientId = crypto.randomUUID();

  constructor(settings: Settings, library: WorkflowLibrary, host?: HostAdapter) {
    this.settings = settings;
    this.library = library;
    this.comfy = new ComfyClient(settings.comfyUrl);
    this.host = host ?? new EffectCraftAdapter(settings.effectcraftPort);
  }

  /* ─── Lifecycle ────────────────────────────────────────────────────── */

  start(): void {
    if (!this.sidecarPath) this.attachProject(null);
    void this.checkComfy();
    this.timer = setInterval(() => void this.sync(), Math.max(500, this.settings.pollSeconds * 1000));
    setInterval(() => void this.checkComfy(), 10_000);
    void this.sync();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.flushSave();
    this.host.close();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(persist = true): void {
    if (persist) this.scheduleSave();
    for (const fn of this.listeners) fn();
  }

  applySettings(patch: Partial<Settings>): void {
    const before = this.settings;
    this.settings = { ...before, ...patch };
    saveSettings(this.settings);
    if (patch.comfyUrl && patch.comfyUrl !== before.comfyUrl) {
      this.comfy = new ComfyClient(patch.comfyUrl);
      this.objectInfo = null;
      void this.checkComfy();
    }
    if (patch.effectcraftPort && patch.effectcraftPort !== before.effectcraftPort) {
      this.host.close();
      this.host = new EffectCraftAdapter(patch.effectcraftPort);
    }
    this.changed(false);
  }

  async checkComfy(): Promise<ComfyHealth> {
    const h = await this.comfy.health();
    const wasOnline = this.comfyHealth.online;
    this.comfyHealth = h;
    if (h.online && (!wasOnline || !this.objectInfo)) {
      try { this.objectInfo = await this.comfy.objectInfo(true); } catch { /* retried next tick */ }
    }
    this.changed(false);
    return h;
  }

  /* ─── Storage ──────────────────────────────────────────────────────── */

  private locate(projectPath: string | null): { sidecar: string; media: string } {
    if (projectPath) {
      const stem = basename(projectPath, extname(projectPath));
      return { sidecar: join(dirname(projectPath), `${stem}.shiftfield.json`), media: join(dirname(projectPath), `${stem}.shiftfield`) };
    }
    const dir = join(homedir(), 'Documents', 'Shiftfield', 'Unsaved project');
    return { sidecar: join(dir, 'storyboard.shiftfield.json'), media: join(dir, 'media') };
  }

  /** Point storage at the project the host has open; move an unsaved storyboard along when it gets a path. */
  private attachProject(projectPath: string | null): void {
    const target = this.locate(projectPath);
    if (target.sidecar === this.sidecarPath) return;
    const previous = { sidecar: this.sidecarPath, media: this.mediaDir, project: this.sidecar.project };
    this.flushSave();
    mkdirSync(target.media, { recursive: true });
    if (existsSync(target.sidecar)) {
      try {
        this.sidecar = JSON.parse(readFileSync(target.sidecar, 'utf8')) as Sidecar;
      } catch {
        this.notice = `The storyboard file next to the project could not be read; a fresh one was started (the old one is untouched: ${target.sidecar}).`;
        this.sidecar = { schema: 1, app: 'shiftfield', host: 'effectcraft', project: projectPath, cards: [] };
      }
    } else if (previous.sidecar && previous.project === null && projectPath && this.sidecar.cards.length > 0) {
      // The unsaved project was just saved: bring its storyboard and media along,
      // and point the project's footage at the copies so the folder travels as one.
      try { cpSync(previous.media, target.media, { recursive: true }); } catch { /* best effort */ }
      this.sidecar = { ...this.sidecar, project: projectPath };
      const moves = this.sidecar.cards.flatMap((c) => {
        const v = c.versions.find((x) => x.n === c.activeVersion);
        return c.placed && v ? [{ itemId: c.placed.itemId, path: join(target.media, v.file) }] : [];
      });
      void (async () => {
        let ok = 0;
        for (const mv of moves) { try { await this.host.relink(mv.itemId, mv.path); ok++; } catch { /* reported below */ } }
        this.notice = `The project was saved: its storyboard and ${ok} generated clip${ok === 1 ? '' : 's'} moved next to it`
          + (moves.length ? ' and the project now points there — save once more in EffectCraft to keep that.' : '.')
          + (ok < moves.length ? ` ${moves.length - ok} could not be relinked; File ▸ Dependencies ▸ Relink Missing Footage… can find them in ${target.media}.` : '');
        this.changed(false);
      })();
    } else {
      this.sidecar = { schema: 1, app: 'shiftfield', host: 'effectcraft', project: projectPath, cards: [] };
    }
    this.sidecarPath = target.sidecar;
    this.mediaDir = target.media;
    this.queue = [];
    // A job that was queued or running when the app last stopped waits for the user.
    let interrupted = 0;
    for (const c of this.sidecar.cards) {
      if (c.status === 'queued' || c.status === 'running') {
        c.status = 'queued';
        c.progress = undefined;
        this.queue.push(c.id);
        interrupted++;
      }
    }
    this.recovered = interrupted;
    this.paused = interrupted > 0;
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (!this.sidecarPath) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flushSave(), 400);
  }

  private flushSave(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    if (!this.sidecarPath) return;
    mkdirSync(dirname(this.sidecarPath), { recursive: true });
    const tmp = this.sidecarPath + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.sidecar, null, 2));
    renameSync(tmp, this.sidecarPath);
  }

  /* ─── Sync with the host ──────────────────────────────────────────── */

  async sync(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const snap = await this.host.snapshot();
      this.hostError = undefined;
      this.snap = snap;
      this.attachProject(snap.project.path);
      if (snap.comp) await this.reconcile(snap);
      this.changed(true);
      await this.refreshThumbs();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg !== this.hostError) {
        this.hostError = msg;
        this.changed(false);
      }
    } finally {
      this.syncing = false;
    }
  }

  private async reconcile(snap: HostSnapshot): Promise<void> {
    const comp = snap.comp!;
    const now = new Date().toISOString();
    const cards = this.sidecar.cards;
    const here = cards.filter((c) => c.compId === comp.id);
    const claimed = new Set<string>();
    this.markerIndex.clear();
    const frame = 1 / (comp.fps || 24);

    // Markers this app has tagged carry their card id.
    for (const m of snap.markers) {
      if (!m.cardId) continue;
      let card = cards.find((c) => c.id === m.cardId);
      if (!card) {
        card = this.newMarkerCard(m.cardId, comp.id, m.time, m.comment, now);
        cards.push(card);
      }
      claimed.add(card.id);
      this.syncMarkerCard(card, m.time, m.comment, now);
      this.markerIndex.set(card.id, m.index);
    }
    // Untagged markers: the same text, or the same time, is the same card.
    for (const m of snap.markers) {
      if (m.cardId) continue;
      const pool = here.filter((c) => c.origin.kind === 'marker' && !claimed.has(c.id));
      const match = pool.find((c) => c.origin.kind === 'marker' && Math.abs(c.origin.time - m.time) < frame / 2 && c.origin.comment === m.comment)
        ?? pool.find((c) => c.origin.kind === 'marker' && c.origin.comment === m.comment && m.comment !== '')
        ?? pool.find((c) => c.origin.kind === 'marker' && Math.abs(c.origin.time - m.time) < frame / 2);
      let card = match;
      if (!card) {
        card = this.newMarkerCard(newCardId(), comp.id, m.time, m.comment, now);
        cards.push(card);
        this.thumbQueue.add(card.id);
      }
      claimed.add(card.id);
      this.syncMarkerCard(card, m.time, m.comment, now);
      this.markerIndex.set(card.id, m.index);
    }

    // Layer-based cards follow their layer.
    this.layerOf.clear();
    for (const c of here) {
      if (c.origin.kind === 'marker') continue;
      const layerId = c.origin.layerId;
      const layer = snap.layers.find((l) => l.id === layerId);
      if (layer) {
        claimed.add(c.id);
        this.layerOf.set(c.id, { in: layer.in, out: layer.out });
        if (c.orphan) { c.orphan = false; c.updatedAt = now; }
      }
    }

    for (const c of here) {
      const orphan = !claimed.has(c.id);
      if (orphan !== !!c.orphan) { c.orphan = orphan; c.updatedAt = now; }
    }
  }

  private newMarkerCard(id: string, compId: number, time: number, comment: string, now: string): Card {
    return {
      id, compId, origin: { kind: 'marker', time, comment }, prompt: comment,
      workflowId: this.settings.markerWorkflow, seed: null, params: {}, versions: [], activeVersion: null,
      status: 'idle', createdAt: now, updatedAt: now,
    };
  }

  private syncMarkerCard(card: Card, time: number, comment: string, now: string): void {
    if (card.origin.kind !== 'marker') return;
    if (Math.abs(card.origin.time - time) > 1e-6) {
      card.origin.time = time;
      card.updatedAt = now;
      this.thumbQueue.add(card.id);
    }
    if (card.origin.comment !== comment) {
      // Edited in the host: the host's text becomes the prompt.
      card.origin.comment = comment;
      card.prompt = comment;
      card.updatedAt = now;
    }
    if (card.orphan) { card.orphan = false; card.updatedAt = now; }
  }

  private async refreshThumbs(): Promise<void> {
    if (!this.snap?.comp || this.running) return;
    for (const id of [...this.thumbQueue].slice(0, 2)) {
      this.thumbQueue.delete(id);
      const card = this.card(id);
      if (!card || card.orphan) continue;
      try {
        const rel = join(card.id, 'thumb.png');
        mkdirSync(join(this.mediaDir, card.id), { recursive: true });
        await this.host.frameAt(this.timeOf(card), join(this.mediaDir, rel));
        card.thumb = rel.replace(/\\/g, '/');
        this.previewRev.set(card.id, (this.previewRev.get(card.id) ?? 0) + 1);
        this.changed(true);
      } catch { /* the next move retries */ }
    }
  }

  /* ─── Views ────────────────────────────────────────────────────────── */

  private card(id: string): Card | undefined {
    return this.sidecar.cards.find((c) => c.id === id);
  }

  private timeOf(card: Card): number {
    if (card.origin.kind === 'marker') return card.origin.time;
    return this.layerOf.get(card.id)?.in ?? 0;
  }

  private slotOf(card: Card): { start: number; end: number | null } {
    const start = this.timeOf(card);
    if (card.origin.kind !== 'marker') {
      const l = this.layerOf.get(card.id);
      return { start, end: l ? l.out : null };
    }
    const later = (this.snap?.markers ?? []).map((m) => m.time).filter((t) => t > start + 1e-6).sort((a, b) => a - b);
    const compEnd = this.snap?.comp?.duration ?? null;
    const end = later[0] ?? compEnd;
    return { start, end: end !== null ? Math.min(end, start + MAX_MARKER_SLOT) : null };
  }

  state(): EngineState {
    const comp = this.snap?.comp ?? null;
    const cards: CardView[] = this.sidecar.cards
      .filter((c) => !comp || c.compId === comp.id)
      .map((c) => {
        const slot = this.slotOf(c);
        const slotSeconds = slot.end !== null ? Math.max(0, slot.end - slot.start) : null;
        return {
          ...c,
          at: this.timeOf(c),
          slotSeconds,
          previewRev: this.previewRev.get(c.id) ?? 0,
          label: c.origin.kind === 'marker' ? 'Marker' : c.origin.kind === 'placeholder' ? 'Placeholder' : 'Layer',
          plan: this.planOf(c, slotSeconds),
        };
      })
      .sort((a, b) => Number(!!a.orphan) - Number(!!b.orphan) || a.at - b.at);
    return {
      host: {
        ok: !this.hostError, app: 'EffectCraft', version: this.snap?.version, error: this.hostError,
        project: this.snap?.project.path ?? null, unsaved: !this.snap?.project.path, comp,
        time: this.snap?.time ?? 0, selectedLayers: this.snap?.selectedLayers ?? [],
      },
      comfy: { ...this.comfyHealth, url: this.settings.comfyUrl },
      cards,
      queue: {
        running: this.running?.cardId ?? null, pending: [...this.queue], paused: this.paused, recovered: this.recovered,
        ready: cards.filter((c) => !c.orphan && this.ready(c) && (c.versions.length === 0 || c.status === 'error')
          && c.status !== 'queued' && c.status !== 'running').length,
      },
      settings: this.settings,
      workflows: this.library.list(),
      mediaDir: this.mediaDir,
      notice: this.notice,
    };
  }

  private planOf(card: Card, slotSeconds: number | null): CardView['plan'] {
    const entry = this.library.get(card.workflowId);
    const comp = this.snap?.comp;
    if (!entry || !comp) return {};
    const m = entry.manifest;
    if (m.input === 'video') return { sizeNote: 'from the clip', lengthNote: 'the clip\'s own length' };
    const w = card.origin.kind === 'marker' ? comp.width : card.origin.width ?? comp.width;
    const h = card.origin.kind === 'marker' ? comp.height : card.origin.height ?? comp.height;
    const size = m.bindings.width ? planSize(m, { width: w, height: h }) : null;
    const fps = Number(getRef(entry.api, m.bindings.fps)) || comp.fps || 24;
    const length = m.output === 'video' ? planLength(m, card.seconds ?? slotSeconds ?? undefined, fps) : null;
    return {
      width: size?.width, height: size?.height, sizeNote: size?.note ?? (m.bindings.width ? undefined : 'decided by the workflow'),
      seconds: length?.seconds, lengthNote: length?.note,
    };
  }

  /** The setup wizard's proof that the chain works: one small still, not placed anywhere. */
  async testGenerate(): Promise<{ file: string; seconds: number }> {
    const t0 = Date.now();
    const entry = this.library.get('zimage-t2i');
    if (!entry) throw new Error('The bundled Z-Image workflow is missing from workflows/.');
    const h = await this.checkComfy();
    if (!h.online) throw new Error(h.message ?? 'ComfyUI is not reachable.');
    const api = this.library.graph('zimage-t2i')!;
    const m = entry.manifest;
    setRef(api, m.bindings.prompt, 'a paper boat on a calm lake at dawn, soft mist, photographic');
    setRef(api, m.bindings.seed, Math.floor(Math.random() * 2 ** 31));
    setRef(api, m.bindings.width, 512);
    setRef(api, m.bindings.height, 512);
    const models = resolveModels(api, this.objectInfo ?? await this.comfy.objectInfo(), m.models);
    if (models.missing.length) {
      throw new Error('ComfyUI is missing model files for the test workflow:\n'
        + models.missing.map((x) => `• ${x.wanted} → models/${x.directory ?? '?'}\n  ${x.url ?? ''}`).join('\n'));
    }
    const jobId = await this.comfy.submit(api, this.clientId);
    const outputs = await new Promise<OutputFile[]>((resolve, reject) => {
      let got: OutputFile[] = [];
      const stop = this.comfy.watch(jobId, this.clientId, (ev) => {
        if (ev.kind === 'output') got = got.concat(ev.outputs);
        if (ev.kind === 'done') { stop(); resolve(got); }
        if (ev.kind === 'error') { stop(); reject(new Error(ev.message)); }
      });
    });
    const out = outputs.find((o) => /\.png$/i.test(o.filename));
    if (!out) throw new Error('The test finished without an image.');
    mkdirSync(join(this.mediaDir, '_test'), { recursive: true });
    writeFileSync(join(this.mediaDir, '_test', 'test.png'), await this.comfy.download(out));
    return { file: '_test/test.png', seconds: (Date.now() - t0) / 1000 };
  }

  dismissNotice(): void {
    this.notice = null;
    this.changed(false);
  }

  /* ─── Editing cards ───────────────────────────────────────────────── */

  async updateCards(ids: string[], patch: Partial<Pick<Card, 'prompt' | 'workflowId' | 'seed' | 'seconds' | 'params'>>): Promise<void> {
    const now = new Date().toISOString();
    for (const id of ids) {
      const card = this.card(id);
      if (!card) continue;
      if (patch.workflowId !== undefined && this.library.get(patch.workflowId)) card.workflowId = patch.workflowId;
      if (patch.seed !== undefined) card.seed = patch.seed;
      if (patch.seconds !== undefined) card.seconds = patch.seconds || undefined;
      if (patch.params) card.params = { ...card.params, ...patch.params };
      if (patch.prompt !== undefined && patch.prompt !== card.prompt) {
        card.prompt = patch.prompt;
        // The marker text mirrors the prompt.
        const idx = this.markerIndex.get(card.id);
        if (card.origin.kind === 'marker' && idx !== undefined) {
          try {
            await this.host.setMarkerComment(idx, patch.prompt);
            card.origin.comment = patch.prompt;
          } catch { /* next poll reconciles */ }
        }
      }
      card.updatedAt = now;
    }
    this.changed(true);
  }

  async selectVersion(id: string, n: number): Promise<void> {
    const card = this.card(id);
    const v = card?.versions.find((x) => x.n === n);
    if (!card || !v) throw new Error('No such version.');
    if (card.placed) await this.host.replaceFootage(card.placed.itemId, join(this.mediaDir, v.file), [card.placed.layerId]);
    card.activeVersion = n;
    card.updatedAt = new Date().toISOString();
    this.thumbQueue.add(card.id);
    this.changed(true);
  }

  async addMarkerAtPlayhead(comment: string): Promise<void> {
    await this.host.addMarker(this.snap?.time ?? 0, comment);
    await this.sync();
  }

  async createPlaceholder(): Promise<string> {
    const comp = this.snap?.comp;
    if (!comp) throw new Error('Open a composition in EffectCraft first.');
    const seconds = this.settings.placeholderSeconds;
    const time = this.snap?.time ?? 0;
    const n = this.sidecar.cards.filter((c) => c.origin.kind === 'placeholder').length + 1;
    const name = `SF placeholder ${String(n).padStart(2, '0')}`;
    const { itemId, layerId } = await this.host.createPlaceholder({ name, width: comp.width, height: comp.height, fps: comp.fps, duration: seconds, time });
    const now = new Date().toISOString();
    const card: Card = {
      id: newCardId(), compId: comp.id, origin: { kind: 'placeholder', layerId, itemId, width: comp.width, height: comp.height }, prompt: '',
      workflowId: this.settings.placeholderWorkflow, seed: null, params: {}, versions: [], activeVersion: null,
      placed: { itemId, layerId }, status: 'idle', createdAt: now, updatedAt: now,
    };
    await this.host.setLayerComment(layerId, `shiftfield card=${card.id}`).catch(() => undefined);
    this.sidecar.cards.push(card);
    await this.sync();
    return card.id;
  }

  /** Turn the selected layers into cards whose media is the input (upscale, video-to-video). */
  async adoptSelectedLayers(): Promise<string[]> {
    const comp = this.snap?.comp;
    if (!comp) throw new Error('Open a composition in EffectCraft first.');
    const ids: string[] = [];
    for (const layerId of this.snap?.selectedLayers ?? []) {
      if (this.sidecar.cards.some((c) => c.origin.kind !== 'marker' && c.origin.layerId === layerId)) continue;
      const itemId = await this.host.sourceOfLayer(layerId);
      if (itemId === null) continue;
      const info = await this.host.itemInfo(itemId);
      const now = new Date().toISOString();
      const card: Card = {
        id: newCardId(), compId: comp.id,
        origin: {
          kind: 'layer', layerId, itemId, sourcePath: info?.path ?? null, width: info?.width, height: info?.height,
          labelBefore: this.snap?.layers.find((l) => l.id === layerId)?.label,
        },
        prompt: '', workflowId: info?.kind === 'video' ? 'seedvr2-upscale' : 'birefnet-rmbg', seed: null, params: {},
        versions: [], activeVersion: null, status: 'idle', createdAt: now, updatedAt: now,
      };
      this.sidecar.cards.push(card);
      ids.push(card.id);
    }
    if (ids.length === 0) throw new Error('Select one or more footage layers in EffectCraft first.');
    await this.sync();
    return ids;
  }

  async attach(id: string, bytes: Uint8Array, filename: string): Promise<void> {
    const card = this.card(id);
    if (!card) throw new Error('No such card.');
    const rel = `${card.id}/attachment${extname(filename) || '.png'}`;
    mkdirSync(join(this.mediaDir, card.id), { recursive: true });
    writeFileSync(join(this.mediaDir, rel), bytes);
    card.attachment = rel;
    card.updatedAt = new Date().toISOString();
    this.changed(true);
  }

  /**
   * Forget a card. The project is not touched and its versions stay on disk.
   * A marker card that still has its marker would simply come back at the next
   * poll, so only orphans, placeholders and layer cards can go.
   */
  removeCard(id: string): void {
    const card = this.card(id);
    if (!card) return;
    if (card.origin.kind === 'marker' && !card.orphan) {
      throw new Error('This card follows a marker in the comp: delete the marker in EffectCraft and the card can go.');
    }
    if (this.running?.cardId === id || this.queue.includes(id)) throw new Error('Cancel the card first.');
    this.sidecar.cards = this.sidecar.cards.filter((c) => c.id !== id);
    this.changed(true);
  }

  detach(id: string): void {
    const card = this.card(id);
    if (!card) return;
    card.attachment = undefined;
    this.changed(true);
  }

  /* ─── Queue ────────────────────────────────────────────────────────── */

  /** Cards "Generate all" would run: ready to go and not generated yet (or failed last time). */
  pendingCards(): Card[] {
    return this.state().cards.filter((c) => !c.orphan && this.ready(c) && (c.versions.length === 0 || c.status === 'error'));
  }

  private ready(c: Card): boolean {
    const m = this.library.get(c.workflowId)?.manifest;
    return !!m && (!m.bindings.prompt || c.prompt.trim() !== '');
  }

  enqueue(ids?: string[]): number {
    const pool = this.state().cards.filter((c) => !c.orphan);
    const chosen = ids?.length ? pool.filter((c) => ids.includes(c.id)) : this.pendingCards();
    let n = 0;
    for (const c of chosen) {
      if (this.queue.includes(c.id) || this.running?.cardId === c.id) continue;
      const card = this.card(c.id)!;
      card.status = 'queued';
      card.error = undefined;
      this.queue.push(c.id);
      void this.setHostStatus(card, 'queued');
      n++;
    }
    this.paused = false;
    this.recovered = 0;
    this.changed(true);
    void this.pump();
    return n;
  }

  resume(): void {
    this.paused = false;
    this.recovered = 0;
    this.changed(false);
    void this.pump();
  }

  discardRecovered(): void {
    for (const id of this.queue) {
      const c = this.card(id);
      if (c) c.status = c.versions.length ? 'done' : 'idle';
    }
    this.queue = [];
    this.paused = false;
    this.recovered = 0;
    this.changed(true);
  }

  async cancel(id?: string): Promise<void> {
    const ids = id ? [id] : [...this.queue, ...(this.running ? [this.running.cardId] : [])];
    for (const cid of ids) {
      const card = this.card(cid);
      if (!card) continue;
      if (this.running?.cardId === cid) {
        this.running.cancelled = true;
        this.running.stop?.();
        if (this.running.jobId) await this.comfy.cancel(this.running.jobId).catch(() => undefined);
      }
      this.queue = this.queue.filter((q) => q !== cid);
      card.status = card.versions.length ? 'done' : 'idle';
      card.progress = undefined;
      void this.setHostStatus(card, card.versions.length ? 'done' : 'canceled');
    }
    this.changed(true);
  }

  private async setHostStatus(card: Card, status: CardStatus): Promise<void> {
    try {
      const markerIndex = card.origin.kind === 'marker' ? this.markerIndex.get(card.id) : undefined;
      const layerId = card.placed?.layerId ?? (card.origin.kind !== 'marker' ? card.origin.layerId : undefined);
      await this.host.setStatus({ markerIndex, layerId }, status);
      // A source layer borrowed for the run gets its own label back once a result stands above it.
      if (card.origin.kind === 'layer' && card.placed && card.origin.labelBefore && (status === 'done' || status === 'queued' || status === 'running')) {
        await this.host.setLayerLabel(card.origin.layerId, card.origin.labelBefore);
      }
    } catch { /* status colours are a courtesy, never a failure */ }
  }

  private async pump(): Promise<void> {
    if (this.running || this.paused) return;
    const next = this.queue.shift();
    if (!next) return;
    const card = this.card(next);
    if (!card) return void this.pump();
    this.running = { cardId: next, jobId: null, stop: null, cancelled: false };
    try {
      await this.generate(card);
    } catch (e) {
      if (!this.running?.cancelled) {
        card.status = 'error';
        card.error = e instanceof Error ? e.message : String(e);
        void this.setHostStatus(card, 'error');
      }
    } finally {
      card.progress = undefined;
      card.updatedAt = new Date().toISOString();
      this.running = null;
      this.changed(true);
      void this.pump();
    }
  }

  /* ─── One generation ──────────────────────────────────────────────── */

  private throwIfCancelled(): void {
    if (this.running?.cancelled) throw new Error('Canceled.');
  }

  private phase(card: Card, phase: string, value = 0, max = 1): void {
    card.progress = { value, max, phase, startedAt: card.progress?.startedAt ?? Date.now() };
    this.changed(false);
  }

  private async generate(card: Card): Promise<void> {
    const t0 = Date.now();
    const entry = this.library.get(card.workflowId);
    if (!entry) throw new Error(`Workflow "${card.workflowId}" is not in the library.`);
    const m = entry.manifest;
    const api = this.library.graph(m.id)!;
    if (!this.comfyHealth.online) await this.checkComfy();
    if (!this.comfyHealth.online) throw new Error(this.comfyHealth.message ?? 'ComfyUI is not reachable.');
    const objectInfo = this.objectInfo ?? await this.comfy.objectInfo();
    const comp = this.snap?.comp;
    if (!comp) throw new Error('No composition is open in EffectCraft.');
    if (card.orphan) throw new Error('This card\'s marker or layer is no longer in the project.');

    card.status = 'running';
    card.error = undefined;
    this.phase(card, 'Preparing');
    await this.setHostStatus(card, 'running');

    if (!card.prompt.trim() && m.bindings.prompt) throw new Error('Write a prompt first (in the card, or as the marker text).');
    const slot = this.slotOf(card);
    const dir = join(this.mediaDir, card.id);
    mkdirSync(dir, { recursive: true });

    // Size and length, from the slot.
    let width = comp.width;
    let height = comp.height;
    if (card.origin.kind !== 'marker') {
      if (card.origin.width && card.origin.height) {
        width = card.origin.width;
        height = card.origin.height;
      } else {
        const info = await this.host.itemInfo(card.origin.itemId);
        if (info?.width && info.height) { width = info.width; height = info.height; }
      }
    }
    const size = planSize(m, { width, height });
    if (size) { setRef(api, m.bindings.width, size.width); setRef(api, m.bindings.height, size.height); }
    const fps = Number(getRef(api, m.bindings.fps)) || comp.fps || 24;
    const wantSeconds = card.seconds ?? (slot.end !== null ? slot.end - slot.start : undefined);
    const length = m.output === 'video' ? planLength(m, wantSeconds, fps) : null;
    if (length) {
      setRef(api, m.bindings.seconds, length.seconds);
      if (length.frames) setRef(api, m.bindings.frames, length.frames);
    }

    // Prompt, seed, extra knobs.
    setRef(api, m.bindings.prompt, card.prompt);
    const seed = card.seed ?? Math.floor(Math.random() * 2 ** 47);
    setRef(api, m.bindings.seed, seed);
    for (const [ref, v] of Object.entries(card.params)) setRef(api, ref, v);

    // Inputs.
    if (m.input === 'image') {
      let src: string;
      const layerStill = card.origin.kind === 'layer' && card.origin.sourcePath && /\.(png|jpe?g|webp|tiff?|exr|bmp)$/i.test(card.origin.sourcePath)
        ? card.origin.sourcePath : null;
      if (card.attachment) src = join(this.mediaDir, card.attachment);
      else if (layerStill) src = layerStill;
      else {
        this.phase(card, 'Grabbing the frame');
        src = await this.host.frameAt(slot.start, join(dir, 'input-frame.png'));
      }
      this.phase(card, 'Uploading');
      const name = await this.comfy.upload(readFileSync(src), `sf_${card.id}${extname(src)}`, 'image/png');
      setRef(api, m.bindings.image, name);
    } else if (m.input === 'video') {
      const source = card.origin.kind === 'layer' ? card.origin.sourcePath : null;
      if (!source) throw new Error('This workflow needs a video: select a clip layer in EffectCraft, then press "Use selected layers".');
      this.phase(card, 'Uploading');
      const name = await this.comfy.upload(readFileSync(source), `sf_${card.id}${extname(source)}`, 'video/mp4');
      setRef(api, m.bindings.video, name);
    }

    const models = resolveModels(api, objectInfo, m.models);
    if (models.missing.length) {
      throw new Error('ComfyUI is missing model files for this workflow: '
        + models.missing.map((x) => `${x.wanted}${x.directory ? ` (models/${x.directory}${x.url ? `, ${x.url}` : ''})` : ''}`).join('; '));
    }

    // Submit and follow.
    this.throwIfCancelled();
    this.phase(card, 'Queued in ComfyUI');
    const jobId = await this.comfy.submit(api, this.clientId, { previewMethod: 'auto' });
    if (this.running) this.running.jobId = jobId;
    if (this.running?.cancelled) {
      await this.comfy.cancel(jobId).catch(() => undefined);
      throw new Error('Canceled.');
    }
    const outputs = await new Promise<OutputFile[]>((resolve, reject) => {
      let got: OutputFile[] = [];
      let lastPreview = 0;
      let stage = 0;
      const stop = this.comfy.watch(jobId, this.clientId, (ev) => {
        switch (ev.kind) {
          case 'queued': this.phase(card, 'Starting'); break;
          case 'executing': {
            if (ev.nodeId === null) break;
            const node = api[ev.nodeId];
            const phase = friendlyPhase(node?.class_type ?? '', ++stage);
            if (phase !== card.progress?.phase) this.phase(card, phase, 0, 1);
            break;
          }
          case 'progress': this.phase(card, card.progress?.phase ?? 'Sampling', ev.value, ev.max); break;
          case 'preview': {
            const now = Date.now();
            if (now - lastPreview < 700) break;
            lastPreview = now;
            void ev.blob.arrayBuffer().then((b) => {
              writeFileSync(join(dir, 'preview.jpg'), new Uint8Array(b));
              this.previewRev.set(card.id, (this.previewRev.get(card.id) ?? 0) + 1);
              this.changed(false);
            });
            break;
          }
          case 'output': got = got.concat(ev.outputs); break;
          case 'done': stop(); resolve(got); break;
          case 'error': stop(); reject(new Error(ev.message)); break;
        }
      });
      if (this.running) this.running.stop = () => { stop(); reject(new Error('Canceled.')); };
    });
    if (this.running?.cancelled) return;

    const wanted = m.output === 'video' ? /\.(mp4|mov|webm|mkv)$/i : /\.(png|jpe?g|webp|exr|tiff?)$/i;
    const primary = outputs.filter((o) => o.type === 'output' && wanted.test(o.filename)).pop()
      ?? outputs.filter((o) => wanted.test(o.filename)).pop();
    if (!primary) throw new Error(`The workflow finished without a ${m.output} file.`);
    this.phase(card, 'Downloading');
    const bytes = await this.comfy.download(primary);
    const n = (card.versions.at(-1)?.n ?? 0) + 1;
    // The host names the footage item after the file, so the name is what the user reads in the Project panel.
    const stem = `${slugFromPrompt(card.prompt || m.title, 28)}_v${String(n).padStart(3, '0')}`;
    const rel = `${card.id}/${stem}${extname(primary.filename).toLowerCase()}`;
    const abs = join(this.mediaDir, rel);
    writeFileSync(abs, bytes);

    // Into the project.
    this.phase(card, 'Placing in EffectCraft');
    const comment = `shiftfield card=${card.id} v${n} · ${m.title} · seed ${seed}\n${card.prompt}`;
    if (card.placed) {
      await this.host.replaceFootage(card.placed.itemId, abs, [card.placed.layerId]);
      await this.host.setLayerComment(card.placed.layerId, comment).catch(() => undefined);
    } else {
      // A result made from a layer goes straight above it; anything else on top of the comp.
      const source = card.origin.kind === 'layer' ? this.snap?.layers.find((l) => l.id === (card.origin as { layerId: number }).layerId) : undefined;
      const placed = await this.host.place({
        file: abs, time: slot.start, endTime: m.output === 'video' && slot.end !== null ? slot.end : undefined,
        name: `SF · ${layerNameFromPrompt(card.prompt || m.title, 48)}`, comment,
        index: source ? source.index : 1,
      });
      card.placed = placed;
      if (card.origin.kind === 'marker') await this.host.coverComp(placed.layerId, placed.itemId, comp.width, comp.height).catch(() => undefined);
      if (card.origin.kind === 'layer') {
        await this.host.matchLayer(placed.layerId, placed.itemId, card.origin.layerId, card.origin.itemId).catch(() => undefined);
        // The result stands in for its source: the source is switched off, never deleted.
        await this.host.setLayerVisible(card.origin.layerId, false).catch(() => undefined);
      }
      if (card.origin.kind === 'marker') {
        const idx = this.markerIndex.get(card.id);
        if (idx !== undefined) await this.host.tagMarker(idx, card.id).catch(() => undefined);
      }
    }

    const version: Version = {
      n, file: rel, kind: m.output, workflowId: m.id, prompt: card.prompt, seed,
      width: m.bindings.width ? size?.width : undefined, height: m.bindings.width ? size?.height : undefined,
      seconds: length?.seconds, jobId,
      createdAt: new Date().toISOString(), elapsedMs: Date.now() - t0,
      remaps: models.remaps.map((r) => `${r.wanted} → ${r.using}`),
    };
    writeFileSync(join(this.mediaDir, `${card.id}/${stem}.job.json`), JSON.stringify({
      ...version, card: card.id, host: { app: 'EffectCraft', version: this.snap?.version, comp: comp.name, at: slot.start },
      comfy: { url: this.settings.comfyUrl, version: this.comfyHealth.version },
      workflow: { id: m.id, template: m.source, license: m.license }, notes: { size: size?.note, length: length?.note },
    }, null, 2));
    card.versions.push(version);
    card.activeVersion = n;
    card.status = 'done';
    card.error = undefined;
    await this.setHostStatus(card, 'done');
    this.thumbQueue.add(card.id);
  }
}

/** What a node is doing, in words a card can show. */
function friendlyPhase(classType: string, _stage: number): string {
  if (/Upsampler|Upscale|SeedVR2/i.test(classType)) return 'Upscaling';
  if (/Sampler|KSampler|Guider/i.test(classType)) return 'Sampling';
  if (/VAEEncode/i.test(classType)) return 'Encoding frames';
  if (/Decode/i.test(classType)) return 'Decoding';
  if (/TextEncode|CLIP|TextGenerate/i.test(classType)) return 'Reading the prompt';
  if (/Conditioning/i.test(classType)) return 'Preparing';
  if (/Loader|Load(?!Image|Video)/i.test(classType)) return 'Loading models';
  if (/^Save|CreateVideo|VideoCombine/i.test(classType)) return 'Saving';
  if (/LoadImage|LoadVideo|Resize|Preprocess/i.test(classType)) return 'Preparing the input';
  if (/RemoveBackground|Matting|BiRefNet/i.test(classType)) return 'Cutting out';
  return 'Working';
}

export { HostError };
