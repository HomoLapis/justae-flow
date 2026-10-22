/**
 * The storyboard engine: keeps the cards in step with the host project, runs
 * the generation queue, and puts every result back where it belongs.
 *
 * Precedence when both sides changed (UX.md): the host owns time, position and
 * size; the storyboard owns prompt, workflow, parameters and versions. The one
 * exception is a marker's text, which mirrors the prompt both ways — an edit
 * made in the host wins at the next poll.
 *
 * Two kinds of host: a timeline (EffectCraft: markers, placeholders, footage
 * layers) and a canvas (PhotoCraft: placeholder layers, saved selections,
 * layers). Queue, storage, versions and the ComfyUI job are shared.
 */

import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, relative } from 'node:path';
import { ComfyClient, type ComfyHealth } from '../core/comfy/client.ts';
import type { ObjectInfo, OutputFile, WorkflowJson } from '../core/comfy/types.ts';
import { getRef, planLength, planSize, resolveModels, setRef, type ModelCheck, type WorkflowManifest } from '../core/workflows/manifest.ts';
import { newCardId, type Box, type Card, type CardStatus, type Sidecar, type Version } from '../core/storyboard/types.ts';
import { layerNameFromPrompt, slugFromPrompt } from '../core/lib/filenames.ts';
import { EffectCraftAdapter } from '../hosts/effectcraft/adapter.ts';
import { PhotoCraftAdapter } from '../hosts/photocraft/adapter.ts';
import type { CanvasHost, HostAdapter, HostSnapshot, TimelineHost } from '../hosts/types.ts';
import { HostError } from '../hosts/types.ts';
import { saveSettings, type Settings } from './config.ts';
import type { LibraryEntry, WorkflowLibrary } from './library.ts';

export interface EngineState {
  host: {
    ok: boolean; id: 'effectcraft' | 'photocraft'; kind: 'timeline' | 'canvas'; app: string; version?: string; error?: string;
    project: string | null; unsaved: boolean; comp: HostSnapshot['comp']; time: number; selectedLayers: number[];
    selection: Box | null; root?: string;
  };
  comfy: ComfyHealth & { url: string };
  cards: CardView[];
  queue: { running: string | null; pending: string[]; paused: boolean; recovered: number; ready: number };
  settings: Settings;
  workflows: WorkflowManifest[];
  mediaDir: string;
  notice: string | null;
}

export interface CardView extends Card {
  /** Where the card sits on the comp timeline, seconds (0 on a canvas). */
  at: number;
  /** Slot length the host gives it, seconds (until the next marker, or the layer's length). */
  slotSeconds: number | null;
  previewRev: number;
  label: string;
  /** What a run would produce right now — said before the render, not discovered after. */
  plan: { width?: number; height?: number; sizeNote?: string; seconds?: number; lengthNote?: string };
}

const MAX_MARKER_SLOT = 20;

export function makeHost(s: Settings): HostAdapter {
  return s.host === 'photocraft'
    ? new PhotoCraftAdapter({ port: s.photocraftPort, tokenFile: s.photocraftTokenFile, root: s.photocraftRoot })
    : new EffectCraftAdapter(s.effectcraftPort);
}

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
  private layerOf = new Map<string, { in: number; out: number; box?: Box | null }>();
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
    this.host = host ?? makeHost(settings);
  }

  private tl(): TimelineHost {
    if (this.host.kind !== 'timeline') throw new Error(`${this.host.label} has no timeline.`);
    return this.host;
  }

  private cv(): CanvasHost {
    if (this.host.kind !== 'canvas') throw new Error(`${this.host.label} has no canvas.`);
    return this.host;
  }

  /* ─── Lifecycle ────────────────────────────────────────────────────── */

  start(): void {
    if (!this.sidecarPath) this.attachProject(null, null);
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
    const hostKeys: Array<keyof Settings> = ['host', 'effectcraftPort', 'photocraftPort', 'photocraftTokenFile', 'photocraftRoot'];
    if (hostKeys.some((k) => patch[k] !== undefined && patch[k] !== before[k])) {
      if (this.running || this.queue.length) throw new Error('Stop the queue before switching the host.');
      this.flushSave();
      this.host.close();
      this.host = makeHost(this.settings);
      this.snap = null;
      this.sidecarPath = '';
      this.hostError = 'Connecting…';
      this.attachProject(null, null);
      void this.sync();
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

  /**
   * Timeline: next to the project. Canvas: inside PhotoCraft's automation
   * root, the only folder it may read results from.
   */
  private locate(projectPath: string | null, docName: string | null): { sidecar: string; media: string } {
    if (this.host.kind === 'canvas') {
      const stem = (projectPath ? basename(projectPath, extname(projectPath)) : (docName ?? 'Untitled')).replace(/[<>:"/\\|?*]+/g, '_');
      return { sidecar: join(this.host.root, `${stem}.shiftfield.json`), media: join(this.host.root, `${stem}.shiftfield`) };
    }
    if (projectPath) {
      const stem = basename(projectPath, extname(projectPath));
      return { sidecar: join(dirname(projectPath), `${stem}.shiftfield.json`), media: join(dirname(projectPath), `${stem}.shiftfield`) };
    }
    const dir = join(homedir(), 'Documents', 'Shiftfield', 'Unsaved project');
    return { sidecar: join(dir, 'storyboard.shiftfield.json'), media: join(dir, 'media') };
  }

  /** Point storage at the project the host has open; move an unsaved storyboard along when it gets a path. */
  private attachProject(projectPath: string | null, docName: string | null, compId?: number): void {
    const target = this.locate(projectPath, docName);
    if (target.sidecar === this.sidecarPath) return;
    const previous = { sidecar: this.sidecarPath, media: this.mediaDir, project: this.sidecar.project, compId: this.snap?.comp?.id };
    this.flushSave();
    mkdirSync(target.media, { recursive: true });
    const fresh = (): Sidecar => ({ schema: 1, app: 'shiftfield', host: this.host.id, project: projectPath, cards: [] });
    if (existsSync(target.sidecar)) {
      try {
        this.sidecar = JSON.parse(readFileSync(target.sidecar, 'utf8')) as Sidecar;
      } catch {
        this.notice = `The storyboard file could not be read; a fresh one was started (the old one is untouched: ${target.sidecar}).`;
        this.sidecar = fresh();
      }
    } else if (previous.sidecar && previous.project === null && projectPath && this.sidecar.cards.length > 0 && this.sidecar.host === this.host.id) {
      // The unsaved project was just saved: bring its storyboard and media along.
      try { cpSync(previous.media, target.media, { recursive: true }); } catch { /* best effort */ }
      this.sidecar = { ...this.sidecar, project: projectPath };
      if (this.host.kind === 'canvas' && compId !== undefined) {
        // A canvas document is identified by its path: the saved one is a new id.
        for (const c of this.sidecar.cards) if (c.compId === previous.compId) c.compId = compId;
        this.notice = 'The document was saved: its storyboard and generated images moved with it.';
      } else {
        this.relinkMoved(target.media);
      }
    } else {
      this.sidecar = fresh();
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

  /** Timeline: point the project's footage at the moved copies so the folder travels as one. */
  private relinkMoved(media: string): void {
    const moves = this.sidecar.cards.flatMap((c) => {
      const v = c.versions.find((x) => x.n === c.activeVersion);
      return c.placed && v ? [{ itemId: c.placed.itemId, path: join(media, v.file) }] : [];
    });
    void (async () => {
      let ok = 0;
      for (const mv of moves) { try { await this.tl().relink(mv.itemId, mv.path); ok++; } catch { /* reported below */ } }
      this.notice = `The project was saved: its storyboard and ${ok} generated clip${ok === 1 ? '' : 's'} moved next to it`
        + (moves.length ? ' and the project now points there — save once more in EffectCraft to keep that.' : '.')
        + (ok < moves.length ? ` ${moves.length - ok} could not be relinked; File ▸ Dependencies ▸ Relink Missing Footage… can find them in ${media}.` : '');
      this.changed(false);
    })();
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
      const previousComp = this.snap?.comp?.id;
      this.snap = snap;
      this.attachProject(snap.project.path, snap.comp?.name ?? null, snap.comp?.id);
      if (snap.comp) {
        if (this.host.kind === 'timeline') this.reconcileTimeline(snap);
        else this.reconcileCanvas(snap);
        if (previousComp !== snap.comp.id) for (const c of this.sidecar.cards) if (c.compId === snap.comp.id && !c.thumb) this.thumbQueue.add(c.id);
      }
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

  private reconcileTimeline(snap: HostSnapshot): void {
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
    this.followLayers(snap, here, claimed, now);
  }

  private reconcileCanvas(snap: HostSnapshot): void {
    const comp = snap.comp!;
    const now = new Date().toISOString();
    const here = this.sidecar.cards.filter((c) => c.compId === comp.id);
    const claimed = new Set<string>();
    // A selection card lives as long as its saved selection (alpha channel) does.
    const channels = new Set(snap.channels ?? []);
    for (const c of here) if (c.origin.kind === 'selection' && channels.has(c.origin.channel)) claimed.add(c.id);
    this.followLayers(snap, here, claimed, now);
  }

  /** Layer-based cards follow their layer (and, on a canvas, its box). */
  private followLayers(snap: HostSnapshot, here: Card[], claimed: Set<string>, now: string): void {
    this.layerOf.clear();
    for (const c of here) {
      if (c.origin.kind !== 'placeholder' && c.origin.kind !== 'layer') continue;
      const layerId = c.origin.layerId;
      const layer = snap.layers.find((l) => l.id === layerId);
      if (!layer) continue;
      claimed.add(c.id);
      this.layerOf.set(c.id, { in: layer.in, out: layer.out, box: layer.bounds });
      if (this.host.kind === 'canvas' && layer.bounds && JSON.stringify(layer.bounds) !== JSON.stringify(c.origin.box)) {
        // The user moved or resized the placeholder: its box is the shot.
        c.origin.box = layer.bounds;
        c.origin.width = layer.bounds[2];
        c.origin.height = layer.bounds[3];
        c.updatedAt = now;
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
    if (!this.snap?.comp || this.running || this.thumbQueue.size === 0) return;
    if (this.host.kind === 'canvas') {
      // One export of the document serves every card waiting for a picture.
      const ids = [...this.thumbQueue];
      this.thumbQueue.clear();
      try {
        const rel = `_composite-${Date.now()}.png`;
        await this.host.exportComposite(this.rootRel(join(this.mediaDir, rel)));
        for (const id of ids) {
          const card = this.card(id);
          if (!card) continue;
          mkdirSync(join(this.mediaDir, card.id), { recursive: true });
          copyFileSync(join(this.mediaDir, rel), join(this.mediaDir, card.id, 'thumb.png'));
          card.thumb = `${card.id}/thumb.png`;
          this.previewRev.set(card.id, (this.previewRev.get(card.id) ?? 0) + 1);
        }
        this.changed(true);
      } catch { /* the next change retries */ }
      return;
    }
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

  /** A path under the canvas host's automation root, as the host wants it: relative, forward slashes. */
  private rootRel(abs: string): string {
    const rel = relative(this.cv().root, abs);
    if (rel.startsWith('..')) throw new Error(`${abs} is outside PhotoCraft's automation folder (${this.cv().root}).`);
    return rel.replace(/\\/g, '/');
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
    if (this.host.kind === 'canvas') return { start: 0, end: null };
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

  private labelOf(c: Card): string {
    switch (c.origin.kind) {
      case 'marker': return 'Marker';
      case 'placeholder': return 'Placeholder';
      case 'selection': return 'Selection';
      default: return 'Layer';
    }
  }

  state(): EngineState {
    const comp = this.snap?.comp ?? null;
    const canvas = this.host.kind === 'canvas';
    const cards: CardView[] = this.sidecar.cards
      .filter((c) => !comp || c.compId === comp.id)
      .map((c) => {
        const slot = this.slotOf(c);
        const slotSeconds = slot.end !== null ? Math.max(0, slot.end - slot.start) : null;
        return {
          ...c, at: this.timeOf(c), slotSeconds, previewRev: this.previewRev.get(c.id) ?? 0, label: this.labelOf(c),
          plan: this.planOf(c, slotSeconds),
        };
      })
      .sort((a, b) => Number(!!a.orphan) - Number(!!b.orphan) || (canvas ? a.createdAt.localeCompare(b.createdAt) : a.at - b.at));
    return {
      host: {
        ok: !this.hostError, id: this.host.id, kind: this.host.kind, app: this.host.label, version: this.snap?.version || undefined,
        error: this.hostError, project: this.snap?.project.path ?? null, unsaved: !this.snap?.project.path, comp,
        time: this.snap?.time ?? 0, selectedLayers: this.snap?.selectedLayers ?? [], selection: this.snap?.selection ?? null,
        root: canvas ? this.cv().root : undefined,
      },
      comfy: { ...this.comfyHealth, url: this.settings.comfyUrl },
      cards,
      queue: {
        running: this.running?.cardId ?? null, pending: [...this.queue], paused: this.paused, recovered: this.recovered,
        ready: cards.filter((c) => !c.orphan && this.ready(c) && (c.versions.length === 0 || c.status === 'error')
          && c.status !== 'queued' && c.status !== 'running').length,
      },
      settings: this.settings,
      workflows: this.library.list().filter((w) => (w.hosts ?? ['effectcraft']).includes(this.host.id)),
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
    if (this.host.kind === 'canvas') {
      if (m.task === 'upscale-image') return { sizeNote: 'the layer enlarged, opened as a new document' };
      if (m.task === 'remove-bg') return { sizeNote: 'the layer\'s own size, cut out on a new layer' };
      if (card.origin.kind === 'selection') return { sizeNote: 'the whole image, edited; only the selection takes the change' };
      const box = card.origin.kind === 'placeholder' ? card.origin.box : undefined;
      const size = box && m.bindings.width ? planSize(m, { width: box[2], height: box[3] }) : null;
      return size ? { width: size.width, height: size.height, sizeNote: `${size.note ? `${size.note}, ` : ''}fitted to the placeholder` } : { sizeNote: 'decided by the workflow' };
    }
    const w = card.origin.kind === 'marker' || card.origin.kind === 'selection' ? comp.width : card.origin.width ?? comp.width;
    const h = card.origin.kind === 'marker' || card.origin.kind === 'selection' ? comp.height : card.origin.height ?? comp.height;
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
    this.checkModels(api, m);
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
        // A marker's text mirrors the prompt.
        const idx = this.markerIndex.get(card.id);
        if (card.origin.kind === 'marker' && idx !== undefined && this.host.kind === 'timeline') {
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
    if (this.host.kind === 'canvas') {
      // Every version is its own layer: show the chosen one, hide the others.
      if (v.layerId === undefined) throw new Error('This version opened as its own document; it has no layer to switch to.');
      for (const x of card.versions) if (x.layerId !== undefined) await this.host.setLayerVisible(x.layerId, x.n === n);
      card.placed = { itemId: 0, layerId: v.layerId };
    } else if (card.placed) {
      await this.host.replaceFootage(card.placed.itemId, join(this.mediaDir, v.file), [card.placed.layerId]);
    }
    card.activeVersion = n;
    card.updatedAt = new Date().toISOString();
    this.thumbQueue.add(card.id);
    this.changed(true);
  }

  async addMarkerAtPlayhead(comment: string): Promise<void> {
    await this.tl().addMarker(this.snap?.time ?? 0, comment);
    await this.sync();
  }

  async createPlaceholder(): Promise<string> {
    const comp = this.snap?.comp;
    if (!comp) throw new Error(this.host.kind === 'canvas' ? 'Open a document in PhotoCraft first.' : 'Open a composition in EffectCraft first.');
    const n = this.sidecar.cards.filter((c) => c.origin.kind === 'placeholder').length + 1;
    const name = `SF placeholder ${String(n).padStart(2, '0')}`;
    const now = new Date().toISOString();
    const base = { id: newCardId(), compId: comp.id, prompt: '', seed: null, params: {}, versions: [], activeVersion: null, status: 'idle' as const, createdAt: now, updatedAt: now };
    let card: Card;
    if (this.host.kind === 'canvas') {
      // The selection's box if there is one, else a box in the middle of the canvas.
      const sel = this.snap?.selection;
      const box: Box = sel ?? [Math.round(comp.width / 4), Math.round(comp.height / 4), Math.round(comp.width / 2), Math.round(comp.height / 2)];
      const layerId = await this.host.createPlaceholderBox(name, box);
      card = { ...base, origin: { kind: 'placeholder', layerId, itemId: 0, width: box[2], height: box[3], box }, workflowId: this.settings.canvasPlaceholderWorkflow };
    } else {
      const { itemId, layerId } = await this.host.createPlaceholder({
        name, width: comp.width, height: comp.height, fps: comp.fps, duration: this.settings.placeholderSeconds, time: this.snap?.time ?? 0,
      });
      card = { ...base, origin: { kind: 'placeholder', layerId, itemId, width: comp.width, height: comp.height }, workflowId: this.settings.placeholderWorkflow, placed: { itemId, layerId } };
      await this.host.setLayerComment(layerId, `shiftfield card=${card.id}`).catch(() => undefined);
    }
    this.sidecar.cards.push(card);
    this.thumbQueue.add(card.id);
    await this.sync();
    return card.id;
  }

  /** Canvas: the active selection becomes a card, kept in the document as an alpha channel. */
  async addSelectionCard(): Promise<string> {
    const host = this.cv();
    const comp = this.snap?.comp;
    if (!comp) throw new Error('Open a document in PhotoCraft first.');
    const id = newCardId();
    const channel = `SF ${id}`;
    const box = await host.saveSelection(channel);
    if (!box) throw new Error('Make a selection in PhotoCraft first: the card edits what you select.');
    const now = new Date().toISOString();
    this.sidecar.cards.push({
      id, compId: comp.id, origin: { kind: 'selection', channel, box }, prompt: '', workflowId: this.settings.selectionWorkflow,
      seed: null, params: {}, versions: [], activeVersion: null, status: 'idle', createdAt: now, updatedAt: now,
    });
    this.thumbQueue.add(id);
    await this.sync();
    return id;
  }

  /** Turn the selected layers into cards whose media is the input (upscale, background removal). */
  async adoptSelectedLayers(): Promise<string[]> {
    const comp = this.snap?.comp;
    if (!comp) throw new Error('Open a composition or document first.');
    const ids: string[] = [];
    for (const layerId of this.snap?.selectedLayers ?? []) {
      // A result of another card may be adopted (cut out a generated image); a layer that already is a card's source may not.
      if (this.sidecar.cards.some((c) => (c.origin.kind === 'placeholder' || c.origin.kind === 'layer') && c.origin.layerId === layerId)) continue;
      const layer = this.snap?.layers.find((l) => l.id === layerId);
      const now = new Date().toISOString();
      let card: Card;
      if (this.host.kind === 'canvas') {
        if (!layer?.bounds) continue;
        card = {
          id: newCardId(), compId: comp.id,
          origin: { kind: 'layer', layerId, itemId: 0, sourcePath: null, width: layer.bounds[2], height: layer.bounds[3], box: layer.bounds, labelBefore: layer.label },
          prompt: '', workflowId: 'birefnet-rmbg', seed: null, params: {}, versions: [], activeVersion: null, status: 'idle', createdAt: now, updatedAt: now,
        };
      } else {
        const itemId = await this.host.sourceOfLayer(layerId);
        if (itemId === null) continue;
        const info = await this.host.itemInfo(itemId);
        card = {
          id: newCardId(), compId: comp.id,
          origin: { kind: 'layer', layerId, itemId, sourcePath: info?.path ?? null, width: info?.width, height: info?.height, labelBefore: layer?.label },
          prompt: '', workflowId: info?.kind === 'video' ? 'seedvr2-upscale' : 'birefnet-rmbg', seed: null, params: {},
          versions: [], activeVersion: null, status: 'idle', createdAt: now, updatedAt: now,
        };
      }
      this.sidecar.cards.push(card);
      this.thumbQueue.add(card.id);
      ids.push(card.id);
    }
    if (ids.length === 0) throw new Error(`Select one or more layers in ${this.host.label} first (layers that are not already a card's source).`);
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
   * poll, so only orphans, placeholders, selections and layer cards can go.
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
      const own = card.origin.kind === 'placeholder' || card.origin.kind === 'layer' ? card.origin.layerId : undefined;
      // Canvas: the placeholder (or source) shows the work in progress; the result layer shows done.
      const layerId = this.host.kind === 'canvas' && status !== 'done' ? own ?? card.placed?.layerId : card.placed?.layerId ?? own;
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

  private checkModels(api: WorkflowJson, m: WorkflowManifest): ModelCheck {
    const models = resolveModels(api, this.objectInfo ?? {}, m.models);
    if (models.missing.length) {
      throw new Error('ComfyUI is missing model files for this workflow: '
        + models.missing.map((x) => `${x.wanted}${x.directory ? ` (models/${x.directory}${x.url ? `, ${x.url}` : ''})` : ''}`).join('; '));
    }
    return models;
  }

  private async generate(card: Card): Promise<void> {
    const entry = this.library.get(card.workflowId);
    if (!entry) throw new Error(`Workflow "${card.workflowId}" is not in the library.`);
    const m = entry.manifest;
    if (!(m.hosts ?? ['effectcraft']).includes(this.host.id)) throw new Error(`${m.title} does not run in ${this.host.label}; pick another workflow for this card.`);
    if (!this.comfyHealth.online) await this.checkComfy();
    if (!this.comfyHealth.online) throw new Error(this.comfyHealth.message ?? 'ComfyUI is not reachable.');
    if (!this.objectInfo) this.objectInfo = await this.comfy.objectInfo();
    if (!this.snap?.comp) throw new Error(`Nothing is open in ${this.host.label}.`);
    if (card.orphan) throw new Error('This card\'s marker, layer or selection is no longer in the project.');
    if (!card.prompt.trim() && m.bindings.prompt) throw new Error('Write a prompt first.');

    card.status = 'running';
    card.error = undefined;
    this.phase(card, 'Preparing');
    await this.setHostStatus(card, 'running');
    mkdirSync(join(this.mediaDir, card.id), { recursive: true });

    if (this.host.kind === 'canvas') await this.generateCanvas(card, entry);
    else await this.generateTimeline(card, entry);
  }

  /** Prompt, seed and the card's own knobs into a fresh copy of the graph. */
  private fill(card: Card, entry: LibraryEntry): { api: WorkflowJson; seed: number } {
    const api = this.library.graph(entry.manifest.id)!;
    setRef(api, entry.manifest.bindings.prompt, card.prompt);
    const seed = card.seed ?? Math.floor(Math.random() * 2 ** 47);
    setRef(api, entry.manifest.bindings.seed, seed);
    for (const [ref, v] of Object.entries(card.params)) setRef(api, ref, v);
    return { api, seed };
  }

  /** Submit, follow with live phases and previews, download the primary output. Returns its bytes and name. */
  private async runJob(card: Card, api: WorkflowJson, m: WorkflowManifest): Promise<{ bytes: Uint8Array; filename: string; jobId: string }> {
    this.throwIfCancelled();
    this.phase(card, 'Queued in ComfyUI');
    const jobId = await this.comfy.submit(api, this.clientId, { previewMethod: 'auto' });
    if (this.running) this.running.jobId = jobId;
    if (this.running?.cancelled) {
      await this.comfy.cancel(jobId).catch(() => undefined);
      throw new Error('Canceled.');
    }
    const dir = join(this.mediaDir, card.id);
    const outputs = await new Promise<OutputFile[]>((resolve, reject) => {
      let got: OutputFile[] = [];
      let lastPreview = 0;
      const stop = this.comfy.watch(jobId, this.clientId, (ev) => {
        switch (ev.kind) {
          case 'queued': this.phase(card, 'Starting'); break;
          case 'executing': {
            if (ev.nodeId === null) break;
            const phase = friendlyPhase(api[ev.nodeId]?.class_type ?? '');
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
    this.throwIfCancelled();
    const wanted = m.output === 'video' ? /\.(mp4|mov|webm|mkv)$/i : /\.(png|jpe?g|webp|exr|tiff?)$/i;
    const primary = outputs.filter((o) => o.type === 'output' && wanted.test(o.filename)).pop()
      ?? outputs.filter((o) => wanted.test(o.filename)).pop();
    if (!primary) throw new Error(`The workflow finished without a ${m.output} file.`);
    this.phase(card, 'Downloading');
    return { bytes: await this.comfy.download(primary), filename: primary.filename, jobId };
  }

  /** Save a result as the card's next version (descriptive name: hosts show it), with its job record. */
  private saveVersion(card: Card, m: WorkflowManifest, result: { bytes: Uint8Array; filename: string }): { n: number; rel: string; abs: string; stem: string } {
    const n = (card.versions.at(-1)?.n ?? 0) + 1;
    const stem = `${slugFromPrompt(card.prompt || m.title, 28)}_v${String(n).padStart(3, '0')}`;
    const rel = `${card.id}/${stem}${extname(result.filename).toLowerCase()}`;
    const abs = join(this.mediaDir, rel);
    writeFileSync(abs, result.bytes);
    return { n, rel, abs, stem };
  }

  private recordVersion(card: Card, m: WorkflowManifest, v: Version, stem: string, extra: Record<string, unknown>): void {
    writeFileSync(join(this.mediaDir, `${card.id}/${stem}.job.json`), JSON.stringify({
      ...v, card: card.id, host: { app: this.host.label, version: this.snap?.version, ...extra },
      comfy: { url: this.settings.comfyUrl, version: this.comfyHealth.version },
      workflow: { id: m.id, template: m.source, license: m.license },
    }, null, 2));
    card.versions.push(v);
    card.activeVersion = v.n;
    card.status = 'done';
    card.error = undefined;
    this.thumbQueue.add(card.id);
  }

  private async generateTimeline(card: Card, entry: LibraryEntry): Promise<void> {
    const host = this.tl();
    const t0 = Date.now();
    const m = entry.manifest;
    const comp = this.snap!.comp!;
    const { api, seed } = this.fill(card, entry);
    const slot = this.slotOf(card);

    // Size and length, from the slot.
    let width = comp.width;
    let height = comp.height;
    if (card.origin.kind === 'placeholder' || card.origin.kind === 'layer') {
      if (card.origin.width && card.origin.height) {
        width = card.origin.width;
        height = card.origin.height;
      } else {
        const info = await host.itemInfo(card.origin.itemId);
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

    // Inputs.
    const dir = join(this.mediaDir, card.id);
    if (m.input === 'image') {
      let src: string;
      const layerStill = card.origin.kind === 'layer' && card.origin.sourcePath && /\.(png|jpe?g|webp|tiff?|exr|bmp)$/i.test(card.origin.sourcePath)
        ? card.origin.sourcePath : null;
      if (card.attachment) src = join(this.mediaDir, card.attachment);
      else if (layerStill) src = layerStill;
      else {
        this.phase(card, 'Grabbing the frame');
        src = await host.frameAt(slot.start, join(dir, 'input-frame.png'));
      }
      this.phase(card, 'Uploading');
      setRef(api, m.bindings.image, await this.comfy.upload(readFileSync(src), `sf_${card.id}${extname(src)}`, 'image/png'));
    } else if (m.input === 'video') {
      const source = card.origin.kind === 'layer' ? card.origin.sourcePath : null;
      if (!source) throw new Error('This workflow needs a video: select a clip layer in EffectCraft, then press "Use selected layers".');
      this.phase(card, 'Uploading');
      setRef(api, m.bindings.video, await this.comfy.upload(readFileSync(source), `sf_${card.id}${extname(source)}`, 'video/mp4'));
    }
    const models = this.checkModels(api, m);

    const result = await this.runJob(card, api, m);
    const { n, rel, abs, stem } = this.saveVersion(card, m, result);

    // Into the project.
    this.phase(card, 'Placing in EffectCraft');
    const comment = `shiftfield card=${card.id} v${n} · ${m.title} · seed ${seed}\n${card.prompt}`;
    if (card.placed) {
      await host.replaceFootage(card.placed.itemId, abs, [card.placed.layerId]);
      await host.setLayerComment(card.placed.layerId, comment).catch(() => undefined);
    } else {
      // A result made from a layer goes straight above it; anything else on top of the comp.
      const source = card.origin.kind === 'layer' ? this.snap?.layers.find((l) => l.id === (card.origin as { layerId: number }).layerId) : undefined;
      const placed = await host.place({
        file: abs, time: slot.start, endTime: m.output === 'video' && slot.end !== null ? slot.end : undefined,
        name: `SF · ${layerNameFromPrompt(card.prompt || m.title, 48)}`, comment, index: source ? source.index : 1,
      });
      card.placed = placed;
      if (card.origin.kind === 'marker') await host.coverComp(placed.layerId, placed.itemId, comp.width, comp.height).catch(() => undefined);
      if (card.origin.kind === 'layer') {
        await host.matchLayer(placed.layerId, placed.itemId, card.origin.layerId, card.origin.itemId).catch(() => undefined);
        // The result stands in for its source: the source is switched off, never deleted.
        await host.setLayerVisible(card.origin.layerId, false).catch(() => undefined);
      }
      if (card.origin.kind === 'marker') {
        const idx = this.markerIndex.get(card.id);
        if (idx !== undefined) await host.tagMarker(idx, card.id).catch(() => undefined);
      }
    }
    this.recordVersion(card, m, {
      n, file: rel, kind: m.output, workflowId: m.id, prompt: card.prompt, seed,
      width: m.bindings.width ? size?.width : undefined, height: m.bindings.width ? size?.height : undefined,
      seconds: length?.seconds, jobId: result.jobId, createdAt: new Date().toISOString(), elapsedMs: Date.now() - t0,
      remaps: models.remaps.map((r) => `${r.wanted} → ${r.using}`),
    }, stem, { comp: comp.name, at: slot.start, notes: { size: size?.note, length: length?.note } });
    await this.setHostStatus(card, 'done');
  }

  private async generateCanvas(card: Card, entry: LibraryEntry): Promise<void> {
    const host = this.cv();
    const t0 = Date.now();
    const m = entry.manifest;
    const doc = this.snap!.comp!;
    const { api, seed } = this.fill(card, entry);
    const full: Box = [0, 0, doc.width, doc.height];
    const liveBox = (this.layerOf.get(card.id)?.box ?? (card.origin.kind !== 'marker' ? card.origin.box : undefined)) ?? full;

    // Size: a placeholder's box decides it when the workflow lets it.
    const size = card.origin.kind === 'placeholder' && m.bindings.width ? planSize(m, { width: liveBox[2], height: liveBox[3] }) : null;
    if (size) { setRef(api, m.bindings.width, size.width); setRef(api, m.bindings.height, size.height); }

    // Input: the layer alone, or the whole visible image.
    if (m.input === 'image') {
      let abs: string;
      if (card.attachment) abs = join(this.mediaDir, card.attachment);
      else {
        abs = join(this.mediaDir, card.id, `input-${Date.now()}.png`);
        this.phase(card, card.origin.kind === 'layer' ? 'Exporting the layer' : 'Exporting the image');
        if (card.origin.kind === 'layer') await host.exportLayer(card.origin.layerId, this.rootRel(abs));
        else await host.exportComposite(this.rootRel(abs));
      }
      this.phase(card, 'Uploading');
      setRef(api, m.bindings.image, await this.comfy.upload(readFileSync(abs), `sf_${card.id}.png`, 'image/png'));
    }
    const models = this.checkModels(api, m);

    const result = await this.runJob(card, api, m);
    const { n, rel, abs, stem } = this.saveVersion(card, m, result);

    this.phase(card, 'Placing in PhotoCraft');
    const name = `SF · ${layerNameFromPrompt(card.prompt || m.title, 40)} v${n}`;
    let layerId: number | undefined;
    if (m.task === 'upscale-image') {
      // A bigger image is a new document, beside the original.
      await host.openDocument(this.rootRel(abs));
    } else if (card.origin.kind === 'placeholder') {
      layerId = await host.placeImage({ rel: this.rootRel(abs), box: liveBox, fit: 'cover', maskBox: liveBox, above: card.origin.layerId, name });
      await host.setLayerVisible(card.origin.layerId, false).catch(() => undefined);
    } else if (card.origin.kind === 'selection') {
      // The edited image back over the whole canvas, masked to the saved selection.
      const [, , sw, sh] = card.origin.box;
      layerId = await host.placeImage({
        rel: this.rootRel(abs), box: full, fit: 'stretch', maskChannel: card.origin.channel, above: this.snap?.layers[0]?.id, name,
        feather: Math.max(4, Math.round(Math.min(sw, sh) * 0.04)),
      });
    } else if (card.origin.kind === 'layer') {
      layerId = await host.placeImage({ rel: this.rootRel(abs), box: full, fit: 'stretch', above: card.origin.layerId, name });
      await host.setLayerVisible(card.origin.layerId, false).catch(() => undefined);
    }
    if (layerId !== undefined) {
      // Earlier versions stay in the document, hidden.
      for (const v of card.versions) if (v.layerId !== undefined) await host.setLayerVisible(v.layerId, false).catch(() => undefined);
      card.placed = { itemId: 0, layerId };
    }
    this.recordVersion(card, m, {
      n, file: rel, kind: m.output, workflowId: m.id, prompt: card.prompt, seed,
      width: size?.width, height: size?.height, jobId: result.jobId, createdAt: new Date().toISOString(), elapsedMs: Date.now() - t0,
      remaps: models.remaps.map((r) => `${r.wanted} → ${r.using}`), layerId,
    }, stem, { document: doc.name, box: liveBox });
    await this.setHostStatus(card, 'done');
  }
}

/** What a node is doing, in words a card can show. */
function friendlyPhase(classType: string): string {
  if (/Upsampler|Upscale|SeedVR2/i.test(classType)) return 'Upscaling';
  if (/Sampler|KSampler|Guider/i.test(classType)) return 'Sampling';
  if (/VAEEncode/i.test(classType)) return 'Encoding';
  if (/Decode/i.test(classType)) return 'Decoding';
  if (/TextEncode|CLIP|TextGenerate/i.test(classType)) return 'Reading the prompt';
  if (/Conditioning/i.test(classType)) return 'Preparing';
  if (/Loader|Load(?!Image|Video)/i.test(classType)) return 'Loading models';
  if (/^Save|CreateVideo|VideoCombine/i.test(classType)) return 'Saving';
  if (/LoadImage|LoadVideo|Resize|Preprocess|Scale/i.test(classType)) return 'Preparing the input';
  if (/RemoveBackground|Matting|BiRefNet/i.test(classType)) return 'Cutting out';
  return 'Working';
}

export { HostError };
