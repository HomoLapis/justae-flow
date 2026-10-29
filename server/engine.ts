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

import { spawn } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, relative } from 'node:path';
import { ComfyClient, type ComfyHealth } from '../core/comfy/client.ts';
import type { ObjectInfo, OutputFile, WorkflowJson } from '../core/comfy/types.ts';
import type { RunRecord } from '../core/cost/estimate.ts';
import { getRef, missingNodes, planLength, planSize, resolveModels, setRef, splitRef, type ModelCheck, type WorkflowManifest } from '../core/workflows/manifest.ts';
import { newCardId, type Box, type Card, type CardStatus, type CompareState, type Sidecar, type Version } from '../core/storyboard/types.ts';
import { layerNameFromPrompt, slugFromPrompt } from '../core/lib/filenames.ts';
import { decodePngGrey } from '../core/lib/png.ts';
import { ASPECTS, planReframe, subjectOf, type ReframePlan, type Smoothing, type SubjectFrame } from '../core/reframe/plan.ts';
import { chainGraph, DELIVERY, joinGraph, planOutpaint } from '../core/reframe/outpaint.ts';
import type { ColourFit } from '../core/reframe/colour.ts';
import { matchReframeColour } from './colourmatch.ts';
import { COMP_TOOLS, ltxExtendFrames, ltxGuidedFrames, resultName, toolById, type SourceInfo, type SourceKind, type ToolDef, type ToolOptions, type ToolPlan } from '../core/comp/tools.ts';
import { finishSpec, SINGLE_TOOLS, type FinishSpec } from '../core/comp/finishing-tools.ts';
import { DEFAULT_PROMPTS, singlePrompt } from '../core/finishing/prompt.ts';
import { localVerdict, planFinish, tilingRequests, type FinishOptions, type FinishPlan } from '../core/finishing/plan.ts';
import type { TilingRequest, TilingSizes } from '../core/finishing/sizes.ts';
import { tilingLookup } from './tiling.ts';
import { checkFiles, comboOptions, fitsLocally, HDR_EMBEDDING, LORAS, lorasOf, NO_QUANTIZED, requiredNodes, type LoraId, type NodeCatalog } from '../core/finishing/models.ts';
import { buildFinishGraph } from '../core/finishing/graph.ts';
import { buildSingleGraph, planSingle, singleNodes, type SinglePlan } from '../core/finishing/single.ts';
import { buildHdrGraph, hdrNodes, planHdr, type HdrPlan } from '../core/finishing/hdr.ts';
import { validateGraph } from '../core/finishing/validate.ts';
import { describeFinishEstimate, estimateFinish, estimateSingle } from '../core/finishing/estimate.ts';
import { EffectCraftAdapter } from '../hosts/effectcraft/adapter.ts';
import { PhotoCraftAdapter } from '../hosts/photocraft/adapter.ts';
import type { CanvasHost, HostAdapter, HostLayer, HostSnapshot, ItemInfo, TimelineHost } from '../hosts/types.ts';
import { HostError } from '../hosts/types.ts';
import { LEGACY_PRODUCT_DIR, LEGACY_SLUG, PRODUCT, SLUG, TAG } from '../core/brand.ts';
import { master } from './bridge.ts';
import { saveSettings, type Settings } from './config.ts';
import type { LibraryEntry, WorkflowLibrary } from './library.ts';
import { taskOf, type Resource } from './resources.ts';
import { LocalRunner, V2Runner, type Runner } from './runner.ts';
import type { Services } from './services.ts';
import type { RunMeta } from './v2run.ts';

export interface EngineState {
  host: {
    ok: boolean; id: 'effectcraft' | 'photocraft'; kind: 'timeline' | 'canvas'; app: string; version?: string; error?: string;
    project: string | null; unsaved: boolean; comp: HostSnapshot['comp']; time: number; selectedLayers: number[];
    selection: Box | null; root?: string;
  };
  /** routed: behind an authenticating router (a cloud), where jobs run on the chosen GPU. */
  comfy: ComfyHealth & { url: string; routed: boolean; gpu: string };
  cards: CardView[];
  queue: { running: string | null; pending: string[]; paused: boolean; recovered: number; ready: number };
  /** The settings, with the router token replaced by whether one is set: it never goes to the browser. */
  settings: Settings & { comfyTokenSet: boolean };
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
  /** Where the next run goes, and why (the card's choice, its task's row in Settings, or Auto). */
  runsOn: { id: string; kind: Resource['kind']; label: string; why: string; metered: boolean } | null;
}

const MAX_MARKER_SLOT = 20;

/** The input of a Comp tab run (or a layer tool's clip): a footage item and its file, as the host has them now. */
interface ClipSource {
  kind: SourceKind;
  itemId: number;
  path: string;
  info: ItemInfo;
  /** The layer's name, or the comp's with the span ("Comp · work area 1.0–4.0 s"). */
  name: string;
  /** A layer source: the layer, as the last snapshot of its comp has it. */
  layer?: HostLayer;
  start?: number;
  end?: number;
}

/** What the Comp tab shows about one of its runs. */
export interface CompRunView {
  id: string;
  tool: string;
  source: SourceKind;
  options: ToolOptions;
  prompt: string;
  /** The result's name (its comp), or what it will be called. */
  label: string;
  /** One card per tool, variant and source (Extend: "+2·g17" guided by 17 frames, "+2" from one frame). */
  variant?: string;
  /** The workflow it runs. */
  workflowId: string;
  status: CardStatus;
  error?: string;
  progress?: Card['progress'];
  runsOn: CardView['runsOn'];
  compId: number;
  activeVersion: number | null;
  versions: Array<Pick<Version, 'n' | 'compId' | 'compName' | 'createdAt' | 'elapsedMs' | 'executionMs' | 'derivedCredits' | 'resource' | 'width' | 'height' | 'seconds' | 'exports'>
    & { thumb: string | null; showing: CompareState['showing'] | null; canExport: boolean; file: string; billedCredits: number | null; billedAsOf: string | null; costBasis: string | null }>;
  /** A run of a pack (the Social pack): Results shows the pack's runs together. */
  group?: { id: string; label: string; at: string };
  updatedAt: string;
}

/** The Comp tab's view of the host: the active comp, its work area, the selected layer, the runs. */
export interface CompView {
  host: { ok: boolean; app: string; error?: string; kind: 'timeline' | 'canvas' };
  comp: (NonNullable<HostSnapshot['comp']> & { workAreaSet: boolean }) | null;
  time: number;
  selected: LayerSourceView | null;
  /**
   * The layer the Comp tab picked as its source (GET /api/comp?layer=<id>), as the project has it now; null when
   * it is not in this comp. A run keeps to it: EffectCraft selects every result it places, so "the selected
   * layer" changes under the user's feet (25 Oct: a reframe ran on the ×2 result instead of the clip).
   */
  picked: LayerSourceView | null;
  /** The active comp is a result of one of the runs: where it came from. */
  resultOf: { cardId: string; compId: number; compName: string | null } | null;
  /** "Describe the clip": whether the local ComfyUI can run it (the model file is there), and with which model. */
  describe: { available: boolean; model?: string; reason?: string };
  tools: Array<{
    id: string; name: string; promise: string; icon: string; sources: SourceKind[]; defaults: ToolOptions;
    /** 'ltx': listed under LTX finishing. */
    family?: 'ltx';
    licence?: { line: string; url: string };
    /** Listed, cannot run: why (to be verified). */
    unavailable?: string;
    /** LTX finishing: IC-LoRA files the local ComfyUI lacks, with where to get them (gated: accept the terms first). */
    missing?: Array<{ what: string; file: string; url: string }>;
  }>;
  runs: CompRunView[];
  queue: EngineState['queue'];
  mediaDir: string;
}

/** A layer as a Comp tab source: its footage, as the project has it, and its span in the comp. */
export interface LayerSourceView { layerId: number; name: string; media: SourceInfo['media']; width: number; height: number; fps: number; seconds: number; path: string | null; in: number; out: number }

/** A plan request from the Comp tab. */
export interface CompPlanRequest {
  tool: string;
  source: SourceKind;
  /** source 'layer': the layer the Comp tab picked (default: the host's selection now). */
  layerId?: number;
  options?: ToolOptions;
  /** The work-area render cap, seconds. */
  cap?: number;
  /** The card's text as typed now (the LTX "Look" is checked on every plan). */
  prompt?: string;
  /** The resource picked on the card ('default' or absent: the task's row), so a plan can say where it would run. */
  resource?: string | null;
}

export function comfyFor(s: Pick<Settings, 'comfyUrl' | 'comfyToken' | 'comfyGpu'>): ComfyClient {
  return new ComfyClient(s.comfyUrl, { token: s.comfyToken, gpu: s.comfyGpu });
}

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
  private sidecar: Sidecar = { schema: 1, app: SLUG, host: 'effectcraft', project: null, cards: [] };
  private sidecarPath = '';
  mediaDir = '';
  private snap: HostSnapshot | null = null;
  private hostError: string | undefined = 'Not connected yet.';
  private comfyHealth: ComfyHealth = { online: false, message: 'Not checked yet.' };
  private objectInfo: ObjectInfo | null = null;
  private checking: Promise<ComfyHealth> | null = null;
  private markerIndex = new Map<string, number>();
  private layerOf = new Map<string, { in: number; out: number; start: number; box?: Box | null }>();
  private queue: string[] = [];
  private running: {
    cardId: string; jobId: string | null; stop: (() => void) | null; cancelled: boolean;
    runner: Runner | null; why: string;
    /** Summed over the generation's jobs (a long reframe is several); the basis of the derived credits, in words. */
    meter: { executionMs: number; credits: number; timed: boolean; billed: boolean; basis: string | null };
    /** Every job this generation submitted: the run history has their derived and (later) billed figures. */
    jobIds: string[];
    /** The graphs this generation submitted, as written next to its versions (relative to the media folder). */
    graphs: string[];
  } | null = null;
  readonly services: Services;
  private paused = false;
  private recovered = 0;
  private previewRev = new Map<string, number>();
  private thumbQueue = new Set<string>();
  private listeners = new Set<() => void>();
  private syncing: Promise<void> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSaveError: string | undefined;
  private notice: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly clientId = crypto.randomUUID();
  /** The comps the run in progress opened in the host (it renders and places only in the active comp). */
  private opened = new Set<number>();
  /**
   * The comp the user is on: the active comp whenever no run is going (the poll), and, during runs, the one they were
   * on before the runs opened theirs — or one they opened themselves meanwhile.
   */
  private userComp: number | undefined;
  private hostBusy = 0;
  private trackedHosts = new WeakMap<TimelineHost, TimelineHost>();

  constructor(settings: Settings, library: WorkflowLibrary, services: Services, host?: HostAdapter) {
    this.settings = settings;
    this.library = library;
    this.services = services;
    this.comfy = comfyFor(settings);
    this.host = host ?? makeHost(settings);
    // The local resource and the ComfyUI address in the settings are one thing.
    services.resources.onChange(() => {
      const url = services.resources.local().url;
      if (url !== this.settings.comfyUrl) {
        this.settings = { ...this.settings, comfyUrl: url };
        saveSettings(this.settings);
        this.comfy = comfyFor(this.settings);
        this.objectInfo = null;
        void this.checkComfy();
      }
      this.changed(false);
    });
  }

  /** A bundled workflow, for the estimate and routing routes. */
  libraryEntry(id: string): LibraryEntry | undefined {
    return this.library.get(id);
  }

  private tl(): TimelineHost {
    if (this.host.kind !== 'timeline') throw new Error(`${this.host.label} has no timeline.`);
    return this.tracked(this.host);
  }

  /**
   * The timeline host, with the calls that bring a comp to the front counted: while a run is going, the comps it
   * opens or builds are its own (settleFocus), and while such a call is under way the poll does not read the active
   * comp as the user's choice.
   */
  private tracked(host: TimelineHost): TimelineHost {
    let t = this.trackedHosts.get(host);
    if (t) return t;
    const opens = new Set(['openComp', 'buildComp', 'buildReframe', 'buildOutpaint']);
    t = new Proxy(host, {
      get: (target, key, receiver) => {
        const v = Reflect.get(target, key, receiver) as unknown;
        if (typeof v !== 'function') return v;
        if (!opens.has(String(key))) return (v as (...a: unknown[]) => unknown).bind(target);
        return async (...args: unknown[]) => {
          this.hostBusy++;
          try {
            const res = await (v as (...a: unknown[]) => Promise<unknown>).apply(target, args);
            const id = key === 'openComp' ? args[0] : (res as { compId?: unknown } | undefined)?.compId;
            if (this.running && typeof id === 'number') this.opened.add(id);
            return res;
          } finally {
            this.hostBusy--;
          }
        };
      },
    });
    this.trackedHosts.set(host, t);
    return t;
  }

  private cv(): CanvasHost {
    if (this.host.kind !== 'canvas') throw new Error(`${this.host.label} has no canvas.`);
    return this.host;
  }

  /* ─── Lifecycle ────────────────────────────────────────────────────── */

  start(): void {
    if (!this.sidecarPath) this.attachProject(null, null);
    void this.checkComfy();
    this.timer = setInterval(() => this.tick(), Math.max(500, this.settings.pollSeconds * 1000));
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
    const comfyKeys: Array<keyof Settings> = ['comfyUrl', 'comfyToken', 'comfyGpu'];
    if (comfyKeys.some((k) => patch[k] !== undefined && patch[k] !== before[k])) {
      this.comfy = comfyFor(this.settings);
      this.objectInfo = null;
      void this.checkComfy();
      if (this.services.resources.local().url !== this.settings.comfyUrl) {
        this.services.resources.update({ resources: [{ id: 'local', url: this.settings.comfyUrl }] });
      }
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
    // A cold router can take a while to answer: one check at a time.
    if (this.checking) return this.checking;
    this.checking = this.comfy.health().finally(() => { this.checking = null; });
    const h = await this.checking;
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
    // A storyboard written under the project's former name stays where it is:
    // the host project's footage points into its media folder.
    const pick = (dir: string, stem: string) => {
      const legacy = { sidecar: join(dir, `${stem}.${LEGACY_SLUG}.json`), media: join(dir, `${stem}.${LEGACY_SLUG}`) };
      const current = { sidecar: join(dir, `${stem}.${SLUG}.json`), media: join(dir, `${stem}.${SLUG}`) };
      return !existsSync(current.sidecar) && existsSync(legacy.sidecar) ? legacy : current;
    };
    if (this.host.kind === 'canvas') {
      const stem = (projectPath ? basename(projectPath, extname(projectPath)) : (docName ?? 'Untitled')).replace(/[<>:"/\\|?*]+/g, '_');
      return pick(this.host.root, stem);
    }
    if (projectPath) return pick(dirname(projectPath), basename(projectPath, extname(projectPath)));
    const legacyDir = join(homedir(), 'Documents', LEGACY_PRODUCT_DIR, 'Unsaved project');
    const legacy = { sidecar: join(legacyDir, `storyboard.${LEGACY_SLUG}.json`), media: join(legacyDir, 'media') };
    const dir = join(homedir(), 'Documents', PRODUCT, 'Unsaved project');
    const current = { sidecar: join(dir, `storyboard.${SLUG}.json`), media: join(dir, 'media') };
    return !existsSync(current.sidecar) && existsSync(legacy.sidecar) ? legacy : current;
  }

  /** Point storage at the project the host has open; move an unsaved storyboard along when it gets a path. */
  private attachProject(projectPath: string | null, docName: string | null, compId?: number): void {
    const target = this.locate(projectPath, docName);
    if (target.sidecar === this.sidecarPath) return;
    const previous = { sidecar: this.sidecarPath, media: this.mediaDir, project: this.sidecar.project, compId: this.snap?.comp?.id };
    this.flushSave();
    mkdirSync(target.media, { recursive: true });
    const fresh = (): Sidecar => ({ schema: 1, app: SLUG, host: this.host.id, project: projectPath, cards: [] });
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
      const out: Array<{ itemId: number; path: string }> = [];
      // The placed item shows the version last placed on it. A reframe version opens a comp of its own and
      // leaves the placed item as it was — relinking that item to the reframe's file swapped a matte for a
      // reframe in the test project of 25 October.
      const shown = c.versions.find((x) => x.n === c.placedVersion)
        ?? [...c.versions].reverse().find((x) => x.compId === undefined && (c.activeVersion === null || x.n <= c.activeVersion))
        ?? [...c.versions].reverse().find((x) => x.compId === undefined);
      if (c.placed && shown) out.push({ itemId: c.placed.itemId, path: join(media, shown.file) });
      // Items a version imported itself: a generated fill, an upscale, a render of the comp.
      for (const v of c.versions) {
        if (v.itemId !== undefined) out.push({ itemId: v.itemId, path: join(media, v.file) });
        if (v.source?.itemId !== undefined && v.source.file && !/^([a-z]:|[\\/])/i.test(v.source.file)) out.push({ itemId: v.source.itemId, path: join(media, v.source.file) });
      }
      return out;
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
    // A save runs from a timer: a folder removed under it (the project moved, a test folder cleaned up) must not
    // take the server down. It is said once; the next change tries again.
    try {
      mkdirSync(dirname(this.sidecarPath), { recursive: true });
      const tmp = this.sidecarPath + '.tmp';
      writeFileSync(tmp, JSON.stringify(this.sidecar, null, 2));
      renameSync(tmp, this.sidecarPath);
    } catch (e) {
      const msg = `Could not save the storyboard to ${this.sidecarPath}: ${e instanceof Error ? e.message : String(e)}`;
      if (msg !== this.lastSaveError) { this.lastSaveError = msg; console.error(msg); }
      return;
    }
    this.lastSaveError = undefined;
  }

  /* ─── Sync with the host ──────────────────────────────────────────── */

  /**
   * Read the host now. A read already under way is waited for and the host is
   * read once more: a caller (a run being queued, a comp just opened) wants what
   * is true now, not what the poll saw a moment ago.
   */
  async sync(): Promise<void> {
    while (this.syncing) await this.syncing.catch(() => undefined);
    this.syncing = this.readHost().finally(() => { this.syncing = null; });
    return this.syncing;
  }

  /** The poll: skipped while a read is under way, so slow answers never pile up. */
  private tick(): void {
    if (!this.syncing) void this.sync();
  }

  private async readHost(): Promise<void> {
    try {
      const snap = await this.host.snapshot();
      this.hostError = undefined;
      const previousComp = this.snap?.comp?.id;
      this.snap = snap;
      // No run going: the active comp is the one the user is on. During a run: a comp the run did not open, seen
      // while the run is not opening one, is one the user went to.
      if (!this.running && !this.queue.length) this.userComp = snap.comp?.id;
      else if (this.running && snap.comp && this.hostBusy === 0 && !this.opened.has(snap.comp.id) && this.card(this.running.cardId)?.compId !== snap.comp.id) {
        this.userComp = snap.comp.id;
      }
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
      // A run on the comp itself lives as long as the comp does.
      if (c.origin.kind === 'comp') { claimed.add(c.id); continue; }
      if (c.origin.kind !== 'placeholder' && c.origin.kind !== 'layer') continue;
      const layerId = c.origin.layerId;
      const layer = snap.layers.find((l) => l.id === layerId);
      if (!layer) continue;
      claimed.add(c.id);
      this.layerOf.set(c.id, { in: layer.in, out: layer.out, start: layer.start, box: layer.bounds });
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
    if (card.origin.kind === 'comp') return card.origin.start;
    return this.layerOf.get(card.id)?.in ?? 0;
  }

  private slotOf(card: Card): { start: number; end: number | null } {
    if (this.host.kind === 'canvas') return { start: 0, end: null };
    if (card.origin.kind === 'comp') return { start: card.origin.start, end: card.origin.end };
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
      case 'comp': return 'Comp';
      default: return 'Layer';
    }
  }

  state(): EngineState {
    const comp = this.snap?.comp ?? null;
    const canvas = this.host.kind === 'canvas';
    const cards: CardView[] = this.sidecar.cards
      // A reframed comp shows the card it came from, so its versions stay at hand.
      .filter((c) => !comp || c.compId === comp.id || c.versions.some((v) => v.compId === comp.id))
      .map((c) => {
        const slot = this.slotOf(c);
        const slotSeconds = slot.end !== null ? Math.max(0, slot.end - slot.start) : null;
        return {
          ...c, at: this.timeOf(c), slotSeconds, previewRev: this.previewRev.get(c.id) ?? 0, label: this.labelOf(c),
          plan: this.planOf(c, slotSeconds), runsOn: this.routeView(c),
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
      comfy: { ...this.comfyHealth, url: this.settings.comfyUrl, routed: this.comfy.routed, gpu: this.settings.comfyGpu },
      cards,
      queue: {
        running: this.running?.cardId ?? null, pending: [...this.queue], paused: this.paused, recovered: this.recovered,
        ready: cards.filter((c) => !c.orphan && !c.tool && this.ready(c) && (c.versions.length === 0 || c.status === 'error')
          && c.status !== 'queued' && c.status !== 'running').length,
      },
      settings: { ...this.settings, comfyToken: '', comfyTokenSet: !!this.settings.comfyToken },
      workflows: this.library.list().filter((w) => (w.hosts ?? ['effectcraft']).includes(this.host.id)),
      mediaDir: this.mediaDir,
      notice: this.notice,
    };
  }

  /** Where a card's next run goes: its own choice, its task's row in Settings ▸ Resources, or Auto. */
  route(card: Card): { resource: Resource; why: string } | null {
    const m = this.library.get(card.workflowId)?.manifest;
    if (!m) return null;
    const { resources, caps } = this.services;
    return resources.resolve(taskOf(m.task, m.id), card.resource, (r) => caps.has(r, m.id));
  }

  private routeView(card: Card): CardView['runsOn'] {
    const r = this.route(card);
    if (!r) return null;
    return { id: r.resource.id, kind: r.resource.kind, label: r.resource.label, why: r.why, metered: this.services.resources.creditsPerHour(r.resource) !== null };
  }

  private runnerFor(r: Resource): Runner {
    return r.kind === 'local'
      ? new LocalRunner(r, this.comfy, this.clientId)
      : new V2Runner(r, this.services.v2, this.services.resources.creditsPerHour(r) !== null);
  }

  private planOf(card: Card, slotSeconds: number | null): CardView['plan'] {
    if (card.tool?.plan) {
      const p = card.tool.plan;
      return { width: p.width, height: p.height, sizeNote: p.makes, seconds: p.seconds, lengthNote: p.note };
    }
    const entry = this.library.get(card.workflowId);
    const comp = this.snap?.comp;
    if (!entry || !comp) return {};
    const m = entry.manifest;
    if (m.task === 'matte-video') return { sizeNote: 'a matte of the clip, set as the layer\'s luma track matte', lengthNote: 'frame for frame' };
    if (m.task === 'reframe') {
      const aspect = String(card.params['@aspect'] ?? '9:16');
      return { sizeNote: `a new ${aspect} comp, the clip at 100%, framed with Position keyframes`, lengthNote: 'the whole clip' };
    }
    if (m.task === 'outpaint-video' && m.outpaint) {
      const aspect = String(card.params['@aspect'] ?? '9:16');
      const [gw, gh] = m.outpaint.sizes[aspect] ?? m.outpaint.sizes['9:16'];
      const [dw, dh] = DELIVERY[aspect] ?? DELIVERY['9:16'];
      const fps = comp.fps || 24;
      return {
        sizeNote: `a new ${aspect} comp (${dw}×${dh}): your clip in the middle, untouched; the new space generated at ${gw}×${gh}`,
        lengthNote: `the whole clip, in runs of up to ${((4 * Math.floor((m.outpaint.maxFrames - 1) / 4) + 1) / fps).toFixed(1)} s that carry on from each other`,
      };
    }
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
  /**
   * A Z-Image still from the local ComfyUI, 512×512 — the Get started card's "Make a test image", and the storyboard
   * page's setup check. With `place`, it goes into the active comp at the playhead for three seconds (or the comp's
   * end), on top, named "Flow · test image"; the file is kept in the project's media folder under _test/.
   */
  async testGenerate(opts: { place?: boolean } = {}): Promise<{ file: string; seconds: number; placed?: { comp: string; layerId: number; at: number } }> {
    const t0 = Date.now();
    const entry = this.library.get('zimage-t2i');
    if (!entry) throw new Error('The bundled Z-Image workflow is missing from workflows/.');
    const h = await this.checkComfy();
    if (!h.online) throw new Error(h.message ?? 'ComfyUI is not reachable.');
    const api = this.library.graph('zimage-t2i')!;
    const m = entry.manifest;
    const prompt = 'a paper boat on a calm lake at dawn, soft mist, photographic';
    const seed = Math.floor(Math.random() * 2 ** 31);
    setRef(api, m.bindings.prompt, prompt);
    setRef(api, m.bindings.seed, seed);
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
    const bytes = await this.comfy.download(out);
    writeFileSync(join(this.mediaDir, '_test', 'test.png'), bytes);
    if (!opts.place) return { file: '_test/test.png', seconds: (Date.now() - t0) / 1000 };
    // Placed: a file of its own, so a later test never swaps the footage under this layer.
    const comp = this.snap?.comp;
    if (this.host.kind !== 'timeline' || !comp) throw new Error('The test image was made (in the project folder under _test/), but no comp is open in EffectCraft to place it in.');
    const rel = `_test/test-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    const abs = join(this.mediaDir, rel);
    writeFileSync(abs, bytes);
    const at = Math.max(0, Math.min(this.snap?.time ?? 0, Math.max(0, comp.duration - 0.5)));
    const placed = await this.tl().place({
      file: abs, time: at, endTime: Math.min(comp.duration, at + 3), index: 1,
      name: `${TAG} · test image`, comment: `${SLUG} test image · ${m.title} · seed ${seed}\n${prompt}`,
    });
    return { file: rel, seconds: (Date.now() - t0) / 1000, placed: { comp: comp.name, layerId: placed.layerId, at } };
  }

  dismissNotice(): void {
    this.notice = null;
    this.changed(false);
  }

  /* ─── Editing cards ───────────────────────────────────────────────── */

  async updateCards(ids: string[], patch: Partial<Pick<Card, 'prompt' | 'workflowId' | 'seed' | 'seconds' | 'params' | 'resource'>>): Promise<void> {
    const now = new Date().toISOString();
    for (const id of ids) {
      const card = this.card(id);
      if (!card) continue;
      if (patch.workflowId !== undefined && this.library.get(patch.workflowId)) card.workflowId = patch.workflowId;
      if (patch.seed !== undefined) card.seed = patch.seed;
      if (patch.seconds !== undefined) card.seconds = patch.seconds || undefined;
      if (patch.resource !== undefined) {
        const r = patch.resource;
        if (r && r !== 'auto' && r !== 'default' && !this.services.resources.get(r)) throw new Error(`No resource "${r}".`);
        card.resource = r && r !== 'default' ? r : undefined;
      }
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
    } else if (v.compId !== undefined) {
      await this.host.openComp(v.compId);
    } else if (card.placed) {
      await this.host.replaceFootage(card.placed.itemId, join(this.mediaDir, v.file), [card.placed.layerId]);
      card.placedVersion = n;
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
    const name = `${TAG} placeholder ${String(n).padStart(2, '0')}`;
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
      await this.host.setLayerComment(layerId, `${SLUG} card=${card.id}`).catch(() => undefined);
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
    const channel = `${TAG} ${id}`;
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
  /** The card of the (first) selected layer — the one it already has, or a new one. */
  async cardForSelectedLayer(): Promise<string> {
    await this.sync();
    const layerId = this.snap?.selectedLayers[0];
    if (layerId === undefined) throw new Error(`Select a layer in ${this.host.label} first.`);
    const existing = this.sidecar.cards.find((c) => (c.origin.kind === 'placeholder' || c.origin.kind === 'layer') && c.origin.layerId === layerId);
    if (existing) return existing.id;
    const [id] = await this.adoptSelectedLayers();
    return id;
  }

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

  /* ─── The Comp tab ─────────────────────────────────────────────────── */

  private selInfo = new Map<number, { at: number; itemId: number | null; info: ItemInfo | null }>();
  private lastFrame: { key: string; at: number; view: { file: string; time: number; compId: number; rev: number } } | null = null;
  private frameRev = 0;

  /** The (first) selected layer, with its footage as the project has it. */
  private async selectedInfo(): Promise<(LayerSourceView & { itemId: number | null; label: string }) | null> {
    return this.layerInfo(this.snap?.selectedLayers[0]);
  }

  /** A layer of the active comp, with its footage as the project has it. Read again every few seconds at most. */
  private async layerInfo(layerId: number | undefined): Promise<(LayerSourceView & { itemId: number | null; label: string }) | null> {
    const snap = this.snap;
    if (!snap?.comp || layerId === undefined || this.host.kind !== 'timeline') return null;
    const layer = snap.layers.find((l) => l.id === layerId);
    // Not in this comp (deleted, or another comp is open): not a source.
    if (!layer) return null;
    let hit = this.selInfo.get(layerId);
    if (!hit || Date.now() - hit.at > 4000) {
      const itemId = await this.host.sourceOfLayer(layerId);
      const info = itemId !== null ? await this.host.itemInfo(itemId) : null;
      hit = { at: Date.now(), itemId, info };
      this.selInfo.set(layerId, hit);
    }
    const info = hit.info;
    // item.metadata says "video" or "still" (measured on EffectCraft 0.11.1); a solid or a comp has no file.
    const media: SourceInfo['media'] = !info?.path ? 'none'
      : info.kind === 'video' ? 'video' : info.kind === 'still' ? 'image'
        : /\.(png|jpe?g|webp|tiff?|exr|bmp|gif)$/i.test(info.path) ? 'image' : 'video';
    return {
      layerId, itemId: hit.itemId, name: layer?.name ?? info?.name ?? `Layer ${layerId}`, label: layer?.label ?? 'None', media,
      width: info?.width ?? 0, height: info?.height ?? 0, fps: info?.frameRate || snap.comp.fps,
      seconds: info?.duration || layer.out - layer.in, path: info?.path ?? null, in: layer.in, out: layer.out,
    };
  }

  /** The input a Comp tab run would get from this source, as the host has it now. */
  private async compSource(kind: SourceKind, cap: number, layerId?: number): Promise<{ info: SourceInfo; range?: [number, number]; layer?: Awaited<ReturnType<Engine['selectedInfo']>> }> {
    const comp = this.snap?.comp;
    if (!comp || this.host.kind !== 'timeline') throw new Error('Open a composition in EffectCraft first.');
    if (kind === 'layer') {
      // The layer the Comp tab picked — never whatever EffectCraft happens to have selected by now.
      const sel = layerId !== undefined ? await this.layerInfo(layerId) : await this.selectedInfo();
      if (!sel) throw new Error(layerId !== undefined ? 'The layer picked as the source is no longer in this comp: pick it again.' : 'Select a layer in EffectCraft first.');
      return {
        info: {
          kind, media: sel.media, width: sel.width, height: sel.height, fps: sel.fps, seconds: sel.seconds, requested: sel.seconds, name: sel.name,
          span: [sel.in, sel.out], compSeconds: comp.duration, compFps: comp.fps,
        },
        layer: sel,
      };
    }
    const [s, e] = kind === 'workArea' ? (comp.workArea ?? [0, comp.duration]) : [0, comp.duration];
    const requested = Math.max(0, e - s);
    return {
      info: {
        kind, media: 'video', width: comp.width, height: comp.height, fps: comp.fps, seconds: Math.min(requested, cap), requested, name: comp.name,
        span: [s, e], compSeconds: comp.duration, compFps: comp.fps,
      },
      range: [s, e],
    };
  }

  /** What a tool would make from a source, said before it runs. */
  async planComp(req: CompPlanRequest): Promise<ToolPlan & { source: SourceInfo; cap: number }> {
    const tool = toolById(req.tool);
    if (!tool) throw new Error(`No Comp tool "${req.tool}".`);
    if (!tool.sources.includes(req.source)) throw new Error(`${tool.name} does not work from that source.`);
    const cap = renderCap(req.cap);
    const { info } = await this.compSource(req.source, cap, req.layerId);
    const options = { ...tool.defaults, ...(req.options ?? {}) };
    // A tiled LTX card's sizes are the LTX pack's: asked on the local ComfyUI (cached), a few seconds at most.
    const tiling = await this.tilingForCard(tool.id, options, info, req.resource);
    const plan = tool.plan(info, options, (id) => this.library.get(id)?.manifest, { prompt: req.prompt, tiling });
    await this.finishingChecks(tool, options, plan, info, req.resource, tiling);
    // Extend takes only the last frame: the render cap does not apply to it.
    if (req.source !== 'layer' && tool.renders !== false && info.requested > cap + 1e-3) {
      plan.warnings.unshift(`The ${req.source === 'workArea' ? 'work area' : 'comp'} lasts ${info.requested.toFixed(1)} s: the render stops at ${cap} s (Work-area render cap).`);
    }
    if (req.source !== 'layer' && info.requested <= 0) return { ...plan, ok: false, reason: 'The work area has no length.', source: info, cap };
    return { ...plan, source: info, cap };
  }

  /**
   * Queue a Comp tab run. One card per tool, variant and source (a second
   * "Reframe 9:16 from the work area" is that card's next version); the queue
   * is the engine's, serial, shared with the layer tools.
   */
  async runCompTool(req: CompPlanRequest & { prompt?: string; resource?: string | null; seed?: number | null }): Promise<{ id: string; queued: number }> {
    if (this.host.kind !== 'timeline') throw new Error('The Comp tab works on an EffectCraft comp.');
    await this.sync();
    const comp = this.snap?.comp;
    if (!comp) throw new Error('Open a composition in EffectCraft first.');
    const tool = toolById(req.tool);
    if (!tool) throw new Error(`No Comp tool "${req.tool}".`);
    const plan = await this.planComp(req);
    if (!plan.ok) throw new Error(plan.reason ?? 'This tool cannot run on this source.');
    const prompt = (req.prompt ?? '').trim();
    if (plan.prompt && !plan.prompt.optional && !prompt) throw new Error(`Write the ${plan.prompt.label.toLowerCase()} first.`);
    if (req.resource && req.resource !== 'default' && req.resource !== 'auto' && !this.services.resources.get(req.resource)) throw new Error(`No resource "${req.resource}".`);
    const options = { ...tool.defaults, ...(req.options ?? {}) };
    const src = await this.compSource(req.source, plan.cap, req.layerId);
    if (tool.id === 'social') {
      // A pack: one run per format, queued one after the other; each one's upscale and master follow it (afterTool).
      const group = { id: `g_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`, label: resultName(req.source === 'layer' ? src.info.name : comp.name, 'social', options), at: new Date().toISOString() };
      const then = { upscale: options.upscale === true, masters: (['prores4444', 'png16'].includes(String(options.masters)) ? options.masters : 'none') as 'none' | 'prores4444' | 'png16' };
      const ids: string[] = [];
      for (const member of plan.members ?? []) {
        if (member.tool !== 'reframe') continue;
        const card = this.compCard(toolById('reframe')!, req, member.plan, { ...toolById('reframe')!.defaults, ...member.options }, src, prompt, comp);
        card.tool!.group = group;
        card.tool!.then = then;
        ids.push(card.id);
      }
      if (!ids.length) throw new Error('No format of this pack can be made from this source.');
      this.changed(true);
      return { id: group.id, queued: this.enqueue(ids) };
    }
    const card = this.compCard(tool, req, plan, options, src, prompt, comp);
    this.changed(true);
    return { id: card.id, queued: this.enqueue([card.id]) };
  }

  /**
   * The card of a Comp tab run: one per tool, variant and source (and layer), so running the same thing again is
   * its next version. Refuses one that is already queued or running.
   */
  private compCard(tool: ToolDef, req: CompPlanRequest & { resource?: string | null; seed?: number | null }, plan: ToolPlan, options: ToolOptions,
    src: Awaited<ReturnType<Engine['compSource']>>, prompt: string, comp: NonNullable<HostSnapshot['comp']>): Card {
    const layerId = src.layer?.layerId;
    let card = this.sidecar.cards.find((c) => c.tool && c.compId === comp.id && c.tool.id === tool.id && c.tool.source === req.source
      && c.tool.variant === plan.variant && (req.source !== 'layer' || (c.origin.kind === 'layer' && c.origin.layerId === layerId)));
    if (card && (card.status === 'queued' || card.status === 'running')) throw new Error(`${resultName(req.source === 'layer' ? src.info.name : comp.name, tool.id, options, plan)} is already in the queue: cancel it first, or wait for it.`);
    const now = new Date().toISOString();
    if (!card) {
      let origin: Card['origin'];
      if (req.source === 'layer') {
        const sel = src.layer!;
        if (sel.itemId === null) throw new Error('The selected layer has no footage item.');
        origin = { kind: 'layer', layerId: sel.layerId, itemId: sel.itemId, sourcePath: sel.path, width: sel.width, height: sel.height, labelBefore: sel.label };
      } else {
        origin = { kind: 'comp', range: req.source, start: src.range![0], end: src.range![1], width: comp.width, height: comp.height };
      }
      card = {
        id: newCardId(), compId: comp.id, origin, prompt, workflowId: plan.workflowId, seed: null, params: {},
        versions: [], activeVersion: null, status: 'idle', createdAt: now, updatedAt: now,
      };
      this.sidecar.cards.push(card);
    } else if (card.origin.kind === 'comp') {
      // The work area may have moved since the last run.
      card.origin.start = src.range![0];
      card.origin.end = src.range![1];
    }
    card.tool = {
      id: tool.id, source: req.source, options, cap: renderCap(req.cap), variant: plan.variant, compName: comp.name,
      label: resultName(req.source === 'layer' ? src.info.name : comp.name, tool.id, options, plan),
      plan: { makes: plan.makes, width: plan.output?.width, height: plan.output?.height, seconds: plan.output?.seconds, note: plan.notes[0] },
    };
    card.prompt = prompt;
    card.workflowId = plan.workflowId;
    card.params = { ...plan.params };
    card.seed = typeof req.seed === 'number' && Number.isFinite(req.seed) ? Math.round(req.seed) : null;
    card.resource = req.resource && req.resource !== 'default' ? req.resource : undefined;
    card.updatedAt = now;
    return card;
  }

  /**
   * A version's cost as the run history has it now: derived again (a deployment's start-up allowance), and billed
   * once the hourly report has its hours (server/credits.ts). Falls back to the version's own derived figure.
   */
  private costOf(v: Version): { derivedCredits: number | null; billedCredits: number | null; billedAsOf: string | null; costBasis: string | null } {
    const own = { derivedCredits: v.derivedCredits ?? null, billedCredits: null, billedAsOf: null, costBasis: null };
    if (!v.resource || v.derivedCredits === null || v.derivedCredits === undefined) return own;
    const ids = v.jobIds?.length ? v.jobIds : v.jobId ? [v.jobId] : [];
    const found = ids.map((id) => this.services.runs.byJob(id, v.resource));
    if (!found.length || found.some((r) => !r || r.derivedCredits === null)) return own;
    const runs = found as RunRecord[];
    // A version made before its jobs were all kept names only the last one: trusted when that job is all its time.
    if (!v.jobIds?.length && Math.abs((runs[0].executionMs ?? -1) - (v.executionMs ?? -2)) > 1000) return own;
    const sum = (f: (r: RunRecord) => number): number => Math.round(runs.reduce((n, r) => n + f(r), 0) * 100) / 100;
    const billed = runs.every((r) => typeof r.billedCredits === 'number') ? sum((r) => r.billedCredits!) : null;
    return {
      derivedCredits: sum((r) => r.derivedCredits!),
      billedCredits: billed,
      billedAsOf: billed !== null ? runs.map((r) => r.billedAsOf ?? '').sort()[0] || null : null,
      costBasis: runs[0].costBasis ?? null,
    };
  }

  private runView(c: Card): CompRunView {
    const t = c.tool!;
    return {
      id: c.id, tool: t.id, source: t.source, options: t.options, prompt: c.prompt, label: t.label ?? t.id, variant: t.variant, workflowId: c.workflowId,
      status: c.status, error: c.error, progress: c.progress, runsOn: this.routeView(c), compId: c.compId, activeVersion: c.activeVersion,
      versions: c.versions.map((v) => ({
        n: v.n, compId: v.compId ?? v.compare?.compId, compName: v.compName, createdAt: v.createdAt, elapsedMs: v.elapsedMs,
        executionMs: v.executionMs ?? null, ...this.costOf(v), resource: v.resource, width: v.width, height: v.height,
        seconds: v.seconds, exports: v.exports, file: v.file, thumb: v.thumb ?? null, showing: v.compare?.showing ?? null,
        canExport: (v.workflowId === 'sam3-matte' || v.workflowId === 'ltx25-alpha') && !!v.source?.file,
      })),
      group: t.group,
      updatedAt: c.updatedAt,
    };
  }

  /** Everything the Comp tab shows. */
  async compView(pickedLayer?: number): Promise<CompView> {
    const st = this.state();
    const comp = this.snap?.comp ?? null;
    const selected = comp && this.host.kind === 'timeline' ? await this.selectedInfo().catch(() => null) : null;
    const pickedInfo = comp && this.host.kind === 'timeline' && pickedLayer !== undefined
      ? (pickedLayer === selected?.layerId ? selected : await this.layerInfo(pickedLayer).catch(() => null)) : null;
    // This comp's runs, the runs whose result is this comp — and every run still in the queue, wherever it is from.
    const mine = (c: Card): boolean => c.status === 'queued' || c.status === 'running'
      || (!!comp && (c.compId === comp.id || c.versions.some((v) => v.compId === comp.id || v.compare?.compId === comp.id)));
    // A pack's runs stay together: its upscales belong to the reframes' comps, not to this one.
    const groups = new Set(this.sidecar.cards.filter((c) => c.tool?.group && mine(c)).map((c) => c.tool!.group!.id));
    const runs = this.sidecar.cards.filter((c) => c.tool && (mine(c) || (!!c.tool.group && groups.has(c.tool.group.id))))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((c) => this.runView(c));
    const from = comp ? this.sidecar.cards.find((c) => c.tool && c.compId !== comp.id && c.versions.some((v) => v.compId === comp.id)) : undefined;
    const bare = (x: typeof selected): LayerSourceView | null => {
      if (!x) return null;
      const { itemId: _item, label: _label, ...rest } = x;
      return rest;
    };
    return {
      host: { ok: st.host.ok, app: st.host.app, error: st.host.error, kind: st.host.kind },
      comp: comp ? { ...comp, workAreaSet: !!comp.workArea && (comp.workArea[0] > 1e-3 || comp.workArea[1] < comp.duration - 1e-3) } : null,
      time: this.snap?.time ?? 0,
      selected: bare(selected),
      picked: bare(pickedInfo),
      resultOf: from ? { cardId: from.id, compId: from.compId, compName: from.tool?.compName ?? null } : null,
      describe: this.describeStatus(),
      tools: this.host.kind === 'timeline'
        ? COMP_TOOLS.map(({ id, name, promise, icon, sources, defaults, family, licence, unavailable, loras }) => ({
          id, name, promise, icon, sources, defaults, family, licence, unavailable, missing: loras?.length ? this.missingLoras(loras as LoraId[]) : undefined,
        }))
        : [],
      runs,
      queue: st.queue,
      mediaDir: this.mediaDir,
    };
  }

  /**
   * Whether "Describe the clip" can run: the bundled describe-clip workflow, a ComfyUI on this machine (nothing may
   * leave it), and that ComfyUI's nodes and model file (its loaders' own lists, as verify:workflows reads them).
   */
  private describeStatus(): CompView['describe'] {
    const entry = this.library.get('describe-clip');
    if (!entry) return { available: false, reason: 'The describe-clip workflow is not in workflows/.' };
    let host = '';
    try { host = new URL(this.comfy.base).hostname; } catch { /* not a URL */ }
    if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) return { available: false, reason: 'Describe the clip runs only on a ComfyUI on this machine.' };
    const oi = this.objectInfo;
    if (!oi) {
      // Read it now; the tab asks again every few seconds.
      if (!this.checking) void this.checkComfy().catch(() => undefined);
      return { available: false, reason: 'The local ComfyUI has not been read yet.' };
    }
    const api = this.library.graph('describe-clip')!;
    const absent = missingNodes(api, oi);
    if (absent.length) return { available: false, reason: `The local ComfyUI lacks ${absent.join(', ')}.` };
    const models = resolveModels(api, oi, entry.manifest.models);
    if (models.missing.length) return { available: false, reason: `Not on the local ComfyUI: ${models.missing.map((x) => x.wanted).join(', ')} (${models.missing[0].url ?? 'see workflows/describe-clip.json'}).` };
    const clip = Object.values(api).find((x) => x.class_type === 'CLIPLoader')?.inputs.clip_name;
    return { available: true, model: models.remaps.find((r) => r.field === 'clip_name')?.using ?? String(clip) };
  }

  /**
   * "Describe the clip": four frames of the source — the last 3 s for Extend ("end"), the whole span for a scene
   * ("whole") — read by Qwen3-VL on the local ComfyUI (from the official template llm_qwen3vl_text_gen), as a
   * paragraph the card puts in its prompt for the user to edit. Local only: nothing leaves this machine. The frames,
   * the instruction and the answer are kept in <media>/_describe/.
   */
  async describeClip(req: { source: SourceKind; layerId?: number; focus?: 'end' | 'whole'; cap?: number }): Promise<{ text: string; model: string; frames: number; times: number[]; executionMs: number | null; file: string }> {
    if (this.host.kind !== 'timeline') throw new Error('Describe the clip works on an EffectCraft comp.');
    if (!this.objectInfo) await this.checkComfy();
    const st = this.describeStatus();
    if (!st.available) throw new Error(st.reason ?? 'Describe the clip is not available.');
    const entry = this.library.get('describe-clip')!;
    const m = entry.manifest;
    await this.sync();
    const comp = this.snap?.comp;
    if (!comp) throw new Error('Open a composition in EffectCraft first.');
    const { info } = await this.compSource(req.source, renderCap(req.cap), req.layerId);
    if (info.media === 'none') throw new Error('The selected layer has no footage file to describe.');
    const focus = req.focus === 'whole' ? 'whole' : 'end';
    const fps = info.kind === 'layer' ? info.fps : comp.fps;
    const [a, b] = info.span ?? [0, info.seconds];
    const lastAt = Math.max(a, b - 1 / fps);
    const from = focus === 'end' ? Math.max(a, lastAt - 3) : a;
    const count = info.media === 'image' ? 1 : 4;
    const times = Array.from({ length: count }, (_, i) => (count === 1 ? lastAt : from + ((lastAt - from) * i) / (count - 1)));
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = join(this.mediaDir, '_describe', stamp);
    mkdirSync(dir, { recursive: true });
    if (info.kind === 'layer') {
      const layer = this.snap?.layers.find((l) => l.id === req.layerId) ?? this.snap?.layers.find((l) => l.id === this.snap?.selectedLayers[0]);
      const path = (await this.layerInfo(layer?.id))?.path;
      if (!layer || !path) throw new Error('The layer has no footage file to describe.');
      for (let i = 0; i < times.length; i++) {
        const at = info.media === 'image' ? 0 : Math.max(0, times[i] - layer.start);
        if (!await frameOf(path, at, join(dir, `${String(i).padStart(3, '0')}.png`))) throw new Error(`Describe the clip could not take the frame at ${at.toFixed(2)} s of the layer's file with ffmpeg (is ffmpeg on the PATH?).`);
      }
    } else {
      for (let i = 0; i < times.length; i++) await this.tl().frameAt(times[i] + 0.1 / fps, join(dir, `${String(i).padStart(3, '0')}.png`));
    }
    const clip = join(dir, 'frames.mp4');
    if (!await ffmpegOk(['-v', 'error', '-y', '-framerate', '1', '-i', join(dir, '%03d.png'), '-vf', 'scale=640:-2', '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', clip], clip)) {
      throw new Error('Describe the clip packs its frames with ffmpeg: put ffmpeg on the PATH.');
    }
    for (let i = 0; i < times.length; i++) rmSync(join(dir, `${String(i).padStart(3, '0')}.png`), { force: true });
    const api = this.library.graph('describe-clip')!;
    const instruction = describeInstruction(focus, count);
    setRef(api, m.bindings.prompt, instruction);
    setRef(api, m.bindings.seed, Math.floor(Math.random() * 2 ** 31));
    setRef(api, m.bindings.video, await this.comfy.upload(readFileSync(clip), `flow_describe_${stamp}.mp4`, 'video/mp4'));
    resolveModels(api, this.objectInfo ?? {}, m.models);
    writeFileSync(join(dir, 'submitted.api.json'), JSON.stringify(api, null, 1));
    const jobId = await this.comfy.submit(api, this.clientId);
    const raw = await this.comfy.textOf(jobId, m.text?.node ?? '7');
    const text = cleanDescription(raw);
    const executionMs = await this.comfy.executionMs(jobId);
    writeFileSync(join(dir, 'describe.json'), JSON.stringify({ source: info, focus, times, instruction, model: st.model, jobId, executionMs, raw, text }, null, 1));
    return { text, model: st.model ?? 'Qwen3-VL', frames: count, times, executionMs, file: relative(this.mediaDir, join(dir, 'describe.json')).replace(/\\/g, '/') };
  }

  /** The comp's frame at the playhead, for the tool cards' previews (kept a few seconds: the playhead rarely moves alone). */
  async compFrame(force = false): Promise<{ file: string; time: number; compId: number; rev: number }> {
    const comp = this.snap?.comp;
    if (!comp || this.host.kind !== 'timeline') throw new Error('Open a composition in EffectCraft first.');
    const time = this.snap?.time ?? 0;
    const key = `${comp.id}@${time.toFixed(3)}`;
    if (!force && this.lastFrame?.key === key && Date.now() - this.lastFrame.at < 15_000) return this.lastFrame.view;
    const rel = `_comp/frame_${comp.id}.png`;
    mkdirSync(join(this.mediaDir, '_comp'), { recursive: true });
    await this.host.frameAt(time, join(this.mediaDir, rel));
    const view = { file: rel, time, compId: comp.id, rev: ++this.frameRev };
    this.lastFrame = { key, at: Date.now(), view };
    return view;
  }

  /** Open a run's result comp (or, with `which: 'source'`, the comp it was made from). */
  async openResult(id: string, n?: number, which: 'result' | 'source' = 'result'): Promise<void> {
    const card = this.card(id);
    if (!card) throw new Error('No such run.');
    const v = card.versions.find((x) => x.n === (n ?? card.activeVersion)) ?? card.versions.at(-1);
    const target = which === 'source' ? card.compId : v?.compId ?? v?.compare?.compId ?? card.compId;
    await this.tl().openComp(target);
    // Opened by the user from Results: theirs, even while a run is going.
    this.userComp = target;
    await this.sync();
  }

  /**
   * Original ⇄ result, by showing and hiding layers — or taking a matte's track
   * matte off and putting it back, or (a crop) opening the source comp and the
   * result in turn. Nothing is deleted; the state is remembered with the version.
   */
  async compare(id: string, n?: number): Promise<{ showing: CompareState['showing'] }> {
    const card = this.card(id);
    const v = card?.versions.find((x) => x.n === (n ?? card.activeVersion));
    if (!card || !v?.compare) throw new Error('This result has nothing to compare.');
    const host = this.tl();
    const c = v.compare;
    const next: CompareState['showing'] = c.showing === 'result' ? 'original' : 'result';
    if (c.openOriginal !== undefined) {
      await host.openComp(next === 'original' ? c.openOriginal : c.compId);
    } else {
      if (this.snap?.comp?.id !== c.compId) await host.openComp(c.compId);
      for (const [layer, visible] of c[next]) await host.setLayerVisible(layer, visible);
      if (c.matte) await host.setTrackMatte(c.matte.layer, next === 'result' ? c.matte.matte : null, 'luma');
    }
    c.showing = next;
    card.updatedAt = new Date().toISOString();
    this.changed(true);
    void this.sync();
    return { showing: next };
  }

  /**
   * A cut-out as a ProRes 4444 master with alpha: the clip the matte was made
   * from, with the matte as its alpha, through the same ffmpeg master the Flow
   * window uses for its lossless saves (server/bridge.ts). Written into the
   * run's folder next to the project.
   */
  async exportAlpha(id: string, n?: number): Promise<{ path: string }> {
    const card = this.card(id);
    const v = card?.versions.find((x) => x.n === (n ?? card.activeVersion));
    if (!card || !v) throw new Error('No such version.');
    if ((v.workflowId !== 'sam3-matte' && v.workflowId !== 'ltx25-alpha') || !v.source?.file) throw new Error('Only a cut-out can be exported with alpha.');
    const clip = /^([a-z]:|[\\/])/i.test(v.source.file) ? v.source.file : join(this.mediaDir, v.source.file);
    if (!existsSync(clip)) throw new Error(`The clip this matte was made from is no longer at ${clip}.`);
    const out = join(this.mediaDir, card.id, `${basename(v.file, extname(v.file))}_alpha_4444.mov`);
    const r = await master({ src: clip, kind: 'prores4444', matte: join(this.mediaDir, v.file), out });
    if (!r.ok || !r.path) throw new Error(r.reason ?? 'ffmpeg did not write the master.');
    v.exports = [...(v.exports ?? []).filter((x) => x.path !== r.path), { kind: 'prores4444', path: r.path, at: new Date().toISOString() }];
    card.updatedAt = new Date().toISOString();
    this.changed(true);
    return { path: r.path };
  }

  /* ─── Queue ────────────────────────────────────────────────────────── */

  /** Cards "Generate all" would run: ready to go and not generated yet (or failed last time). */
  pendingCards(): Card[] {
    // A Comp tab run is started from its own card there, never by "Generate all".
    return this.state().cards.filter((c) => !c.orphan && !c.tool && this.ready(c) && (c.versions.length === 0 || c.status === 'error'));
  }

  private ready(c: Card): boolean {
    const m = this.library.get(c.workflowId)?.manifest;
    return !!m && (!m.bindings.prompt || c.prompt.trim() !== '');
  }

  enqueue(ids?: string[]): number {
    // Cards named by id may belong to another comp than the open one (a pack's upscale works on a result comp).
    const chosen = ids?.length ? this.sidecar.cards.filter((c) => !c.orphan && ids.includes(c.id)) : this.pendingCards();
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
        if (this.running.jobId) await (this.running.runner ?? new LocalRunner(this.services.resources.local(), this.comfy, this.clientId)).cancel(this.running.jobId).catch(() => undefined);
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
    this.running = { cardId: next, jobId: null, stop: null, cancelled: false, runner: null, why: '', meter: { executionMs: 0, credits: 0, timed: false, billed: false, basis: null }, jobIds: [], graphs: [] };
    // Where the user is when a Comp tab run starts: given back at the end unless that was the run's own comp.
    const toolRun = !!card.tool && this.host.kind === 'timeline';
    if (toolRun) this.userComp ??= this.snap?.comp?.id;
    this.opened = new Set();
    try {
      await this.generate(card);
      // A pack's run is followed by its upscale, or by the master of its last comp. If that fails, the run itself
      // still stands: the card stays done and says what did not follow.
      if (card.status === 'done' && card.tool?.then) {
        try {
          await this.afterTool(card);
        } catch (e) {
          if (this.running?.cancelled) throw e;
          card.error = `Done, but what follows did not: ${e instanceof Error ? e.message : String(e)}`;
          this.notice = `${card.tool.label ?? 'A pack run'}: ${card.error}`;
        }
      }
    } catch (e) {
      if (!this.running?.cancelled) {
        card.status = 'error';
        card.error = e instanceof Error ? e.message : String(e);
        void this.setHostStatus(card, 'error');
      }
    } finally {
      if (toolRun) await this.settleFocus(card).catch(() => undefined);
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
    // Only the local ComfyUI's loaders are known here: they decide for Local, and for a proxy standing in front
    // of it; any other v2 resource answers for its own files (checked in generate).
    const r = this.running?.runner?.resource;
    if (r && r.kind !== 'local' && !(r.kind === 'proxy' && r.fronts === this.services.resources.local().id)) return { remaps: [], missing: [] };
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
    // LTX finishing's bundled graphs stay out of the pickers (hosts: []); they run from the Comp tab only.
    const hosts = m.task === 'finish-video' && card.tool ? ['effectcraft'] : m.hosts ?? ['effectcraft'];
    if (!hosts.includes(this.host.id)) throw new Error(`${m.title} does not run in ${this.host.label}; pick another workflow for this card.`);
    const route = this.route(card)!;
    if (m.task === 'finish-video') {
      const elsewhere = this.finishingElsewhere(route.resource);
      if (elsewhere) throw new Error(elsewhere);
    }
    const runner = this.runnerFor(route.resource);
    if (this.running) { this.running.runner = runner; this.running.why = route.why; }
    if (route.resource.kind === 'local') {
      if (!this.comfyHealth.online) await this.checkComfy();
      if (!this.comfyHealth.online) throw new Error(this.comfyHealth.message ?? 'ComfyUI is not reachable.');
      if (!this.objectInfo) this.objectInfo = await this.comfy.objectInfo();
    } else {
      // A proxy in front of the local ComfyUI: its loaders decide which precision of each model file to send.
      if (route.resource.kind === 'proxy' && route.resource.fronts === this.services.resources.local().id && !this.objectInfo) {
        this.objectInfo = await this.comfy.objectInfo().catch(() => null);
      }
      const u = this.services.resources.canTakeJobs(route.resource);
      if (!u.ok) throw new Error(`${route.resource.label}: ${u.reason}. Choose Local for this card, or set it up in the Flow window ▸ Settings ▸ Resources.`);
      // Said before a credit is spent: what the probe found missing there.
      const caps = this.services.caps.cached(route.resource.id) ?? await this.services.caps.get(route.resource.id).catch(() => null);
      const w = caps?.workflows[m.id];
      if (w?.status === 'missing') {
        throw new Error(`${route.resource.label} cannot run ${m.title}: missing ${[...w.missingNodes.map((n) => `node ${n}`), ...w.missingModels].join(', ')}. Choose Local for this card.`);
      }
    }
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
  private fill(card: Card, entry: LibraryEntry): { api: WorkflowJson; seed: number | null } {
    const api = this.library.graph(entry.manifest.id)!;
    setRef(api, entry.manifest.bindings.prompt, card.prompt);
    // A workflow without a seed (tracking, cut-outs) is the same every run: no seed to record.
    const seed = entry.manifest.bindings.seed ? card.seed ?? Math.floor(Math.random() * 2 ** 47) : null;
    setRef(api, entry.manifest.bindings.seed, seed);
    for (const [ref, v] of Object.entries(card.params)) setRef(api, ref, v);
    return { api, seed };
  }

  /** The runner of the generation in progress. */
  private runner(): Runner {
    const r = this.running?.runner;
    if (!r) throw new Error('No generation is running.');
    return r;
  }

  /** What a job records in the run history (estimates come from it). */
  private meta(m: WorkflowManifest, slotSeconds: number | null, suffix = ''): RunMeta {
    return { workflowId: m.id + suffix, slotSeconds, scaleWithSlot: m.output === 'video', source: 'engine' };
  }

  /** Submit, follow with live phases and previews, download the primary output. Returns its bytes and name. */
  private async runJob(card: Card, api: WorkflowJson, m: WorkflowManifest, part?: string, meta?: RunMeta): Promise<{ bytes: Uint8Array; filename: string; jobId: string }> {
    const { outputs, jobId } = await this.execute(card, api, part, meta ?? this.meta(m, null));
    const wanted = m.output === 'video' ? /\.(mp4|mov|webm|mkv)$/i : /\.(png|jpe?g|webp|exr|tiff?)$/i;
    const primary = outputs.filter((o) => o.type === 'output' && wanted.test(o.filename)).pop()
      ?? outputs.filter((o) => wanted.test(o.filename)).pop();
    if (!primary) throw new Error(`The workflow finished without a ${m.output} file.`);
    this.phase(card, part ? `${part} · Downloading` : 'Downloading');
    return { bytes: await this.runner().download(primary), filename: primary.filename, jobId };
  }

  /** Submit and follow a job; every file it wrote, in the order the nodes reported them. */
  private async execute(card: Card, api: WorkflowJson, part: string | undefined, meta: RunMeta): Promise<{ outputs: OutputFile[]; jobId: string }> {
    this.throwIfCancelled();
    const runner = this.runner();
    // A run that is one of several says which one it is.
    const label = (phase: string): string => (part ? `${part} · ${phase}` : phase);
    this.phase(card, label(runner.resource.kind === 'local' ? 'Queued in ComfyUI' : `Queued on ${runner.resource.label}`));
    const submittedAt = Date.now();
    if (this.host.id === 'effectcraft') eightBitVideo(api);
    // The exact graph that goes out, kept next to the versions: what ran can always be read back (and re-run in ComfyUI).
    const graphRel = `${card.id}/submitted_${new Date(submittedAt).toISOString().replace(/[:.]/g, '-')}${part ? `_${slugFromPrompt(part, 24)}` : ''}.api.json`;
    try {
      mkdirSync(join(this.mediaDir, card.id), { recursive: true });
      writeFileSync(join(this.mediaDir, graphRel), JSON.stringify(api, null, 1));
      this.running?.graphs.push(graphRel);
    } catch { /* provenance is a courtesy; the run goes on */ }
    const jobId = await runner.submit(api, meta, { previewMethod: 'auto' });
    if (this.running) { this.running.jobId = jobId; this.running.jobIds.push(jobId); }
    if (this.running?.cancelled) {
      await runner.cancel(jobId).catch(() => undefined);
      throw new Error('Canceled.');
    }
    const dir = join(this.mediaDir, card.id);
    const outputs = await new Promise<OutputFile[]>((resolve, reject) => {
      let got: OutputFile[] = [];
      let lastPreview = 0;
      const stop = runner.watch(jobId, (ev) => {
        switch (ev.kind) {
          case 'queued': this.phase(card, label('Starting')); break;
          case 'executing': {
            if (ev.nodeId === null) break;
            const phase = label(friendlyPhase(api[ev.nodeId]?.class_type ?? ''));
            if (phase !== card.progress?.phase) this.phase(card, phase, 0, 1);
            break;
          }
          case 'progress': this.phase(card, card.progress?.phase ?? label('Sampling'), ev.value, ev.max); break;
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
    // What it took: the server's execution time, and the credits derived from it (v2 records its own run).
    const meter = await runner.meter(jobId).catch(() => ({ executionMs: null, derivedCredits: null, costBasis: null }));
    if (this.running) {
      if (meter.executionMs !== null) { this.running.meter.executionMs += meter.executionMs; this.running.meter.timed = true; }
      if (meter.derivedCredits !== null) { this.running.meter.credits += meter.derivedCredits; this.running.meter.billed = true; }
      // The first job's basis says the most (a cold start); the next ones of the same generation found the worker up.
      this.running.meter.basis ??= meter.costBasis ?? null;
    }
    if (runner.resource.kind === 'local') {
      this.services.runs.add({
        at: new Date().toISOString(), workflowId: meta.workflowId, resourceId: runner.resource.id, resourceKind: 'local', gpu: null,
        executionMs: meter.executionMs, timing: meter.executionMs !== null ? 'history' : 'wall', wallMs: Date.now() - submittedAt,
        slotSeconds: meta.slotSeconds, scaleWithSlot: meta.scaleWithSlot, derivedCredits: null, creditsPerHour: null, jobId,
      });
    }
    return { outputs, jobId };
  }

  /** Save a result as the card's next version (descriptive name: hosts show it), with its job record. */
  private saveVersion(card: Card, m: WorkflowManifest, result: { bytes: Uint8Array; filename: string }, base?: string): { n: number; rel: string; abs: string; stem: string } {
    const n = (card.versions.at(-1)?.n ?? 0) + 1;
    const stem = `${base ?? slugFromPrompt(card.prompt || m.title, 28)}_v${String(n).padStart(3, '0')}`;
    const rel = `${card.id}/${stem}${extname(result.filename).toLowerCase()}`;
    const abs = join(this.mediaDir, rel);
    writeFileSync(abs, result.bytes);
    return { n, rel, abs, stem };
  }

  private recordVersion(card: Card, m: WorkflowManifest, v: Version, stem: string, extra: Record<string, unknown>): void {
    const meter = this.running?.meter;
    const r = this.running?.runner?.resource ?? this.services.resources.local();
    const rate = this.services.resources.creditsPerHour(r);
    v.resource = r.id;
    v.executionMs = meter?.timed ? meter.executionMs : null;
    v.derivedCredits = meter?.billed ? Math.round(meter.credits * 100) / 100 : null;
    if (this.running?.jobIds.length) v.jobIds = [...this.running.jobIds];
    writeFileSync(join(this.mediaDir, `${card.id}/${stem}.job.json`), JSON.stringify({
      ...v, card: card.id, host: { app: this.host.label, version: this.snap?.version, ...extra },
      resource: {
        id: r.id, kind: r.kind, label: r.label, url: r.url, why: this.running?.why,
        gpu: this.services.resources.gpuLabel(r), creditsPerHour: rate,
        // Derived, not billed: no endpoint returns a job's cost. The billed figure comes later, from the hourly report,
        // into the run history (runs.json), never into this file.
        cost: rate !== null ? { executionMs: v.executionMs, derivedCredits: v.derivedCredits, basis: `(${meter?.basis ?? 'GPU time of the job'}) × rate (≈)`, jobIds: v.jobIds } : undefined,
      },
      comfy: r.kind === 'local' ? { url: this.settings.comfyUrl, version: this.comfyHealth.version } : undefined,
      workflow: { id: m.id, template: m.source, license: m.license, submitted: this.running?.graphs ?? [] },
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
    if (card.tool) return this.generateTool(card, entry, api, seed, t0);
    if (m.task === 'outpaint-video') return this.outpaint(card, entry, api, seed, t0, await this.layerClip(card));
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
      setRef(api, m.bindings.image, await this.runner().uploadFile(src, () => readFileSync(src), `flow_${card.id}${extname(src)}`, 'image/png'));
    } else if (m.input === 'video') {
      if (card.origin.kind !== 'layer') throw new Error('This workflow needs a video: select a clip layer in EffectCraft, then press "Use selected layers".');
      // The item's file as the project has it now: footage may have been relinked or replaced since the card was made.
      const source = (await this.layerClip(card)).path;
      this.phase(card, 'Uploading');
      setRef(api, m.bindings.video, await this.runner().uploadFile(source, () => readFileSync(source), `flow_${card.id}${extname(source)}`, videoMime(source)));
    }
    const models = this.checkModels(api, m);
    if (m.task === 'reframe') return this.reframe(card, entry, api, seed, models, t0, await this.layerClip(card));

    const result = await this.runJob(card, api, m, undefined, this.meta(m, length?.seconds ?? null));
    const { n, rel, abs, stem } = this.saveVersion(card, m, result);

    // Into the project.
    this.phase(card, 'Placing in EffectCraft');
    const comment = `${SLUG} card=${card.id} v${n} · ${m.title}${seed !== null ? ` · seed ${seed}` : ''}\n${card.prompt}`;
    if (card.placed) {
      await host.replaceFootage(card.placed.itemId, abs, [card.placed.layerId]);
      await host.setLayerComment(card.placed.layerId, comment).catch(() => undefined);
    } else {
      // A result made from a layer goes straight above it; anything else on top of the comp.
      const source = card.origin.kind === 'layer' ? this.snap?.layers.find((l) => l.id === (card.origin as { layerId: number }).layerId) : undefined;
      const matte = m.task === 'matte-video';
      const placed = await host.place({
        // Clips and stills alike end where the slot ends (the next marker, or the layer's out point).
        file: abs, time: slot.start, endTime: slot.end !== null ? slot.end : undefined,
        // A result made from the clip itself lines up with it frame for frame.
        sourceStart: m.input === 'video' && source ? source.start : undefined,
        name: `${TAG}${matte ? ' matte' : ''} · ${layerNameFromPrompt(card.prompt || m.title, 48)}`, comment, index: source ? source.index : 1,
      });
      card.placed = placed;
      if (card.origin.kind === 'marker') await host.coverComp(placed.layerId, placed.itemId, comp.width, comp.height).catch(() => undefined);
      if (card.origin.kind === 'layer') {
        await host.matchLayer(placed.layerId, placed.itemId, card.origin.layerId, card.origin.itemId).catch(() => undefined);
        if (matte) {
          // The clip keeps its pixels; the matte above decides what shows.
          await host.setTrackMatte(card.origin.layerId, placed.layerId, 'luma');
        } else {
          // The result stands in for its source: the source is switched off, never deleted.
          await host.setLayerVisible(card.origin.layerId, false).catch(() => undefined);
        }
      }
      if (card.origin.kind === 'marker') {
        const idx = this.markerIndex.get(card.id);
        if (idx !== undefined) await host.tagMarker(idx, card.id).catch(() => undefined);
      }
    }
    card.placedVersion = n;
    this.recordVersion(card, m, {
      n, file: rel, kind: m.output === 'video' ? 'video' : 'image', workflowId: m.id, prompt: card.prompt, seed,
      width: m.bindings.width ? size?.width : undefined, height: m.bindings.width ? size?.height : undefined,
      seconds: length?.seconds, jobId: result.jobId, createdAt: new Date().toISOString(), elapsedMs: Date.now() - t0,
      remaps: models.remaps.map((r) => `${r.wanted} → ${r.using}`),
    }, stem, { comp: comp.name, at: slot.start, notes: { size: size?.note, length: length?.note } });
    await this.setHostStatus(card, 'done');
  }

  /** A layer card's clip: its item and file as the project has them now (footage may have been relinked or replaced). */
  private async layerClip(card: Card): Promise<ClipSource> {
    const origin = card.origin;
    if (origin.kind !== 'layer') throw new Error('This works on a clip: select its layer in EffectCraft, then press "Use selected layers".');
    const info = await this.tl().itemInfo(origin.itemId);
    if (!info?.width || !info.height) throw new Error('EffectCraft did not report the clip\'s size.');
    const path = info.path ?? origin.sourcePath;
    if (!path) throw new Error('This layer has no footage file to work from.');
    if (path !== origin.sourcePath) origin.sourcePath = path;
    const layer = this.snap?.layers.find((l) => l.id === origin.layerId);
    return { kind: 'layer', itemId: origin.itemId, path, info, name: layer?.name ?? info.name, layer };
  }

  /** Make `compId` the active comp (a run that waited in the queue may find another one open), and read it again. */
  private async ensureComp(compId: number): Promise<void> {
    if (this.snap?.comp?.id === compId) return;
    await this.tl().openComp(compId);
    this.opened.add(compId);
    this.snap = await this.host.snapshot();
  }

  /**
   * The end of a Comp tab run (decided 25 Oct: a queued run must not steal focus). A run opens the comps it works in —
   * EffectCraft renders and places only in the active one — so at the end: if the user was on the comp the run started
   * from, the result stays in front (its new comp, or the same comp for Extend and a layer's cut-out); otherwise the comp
   * they were on comes back to the front and Results offers "Open comp". A comp the user opened during the run (one the
   * run did not open itself) is left in front.
   */
  private async settleFocus(card: Card): Promise<void> {
    if (this.host.kind !== 'timeline') return;
    const userComp = this.userComp;
    const now = (await this.host.snapshot().catch(() => null))?.comp?.id;
    if (now === undefined || userComp === undefined || now === userComp) return;
    const v = card.versions.at(-1);
    const result = v?.compId ?? v?.compare?.compId;
    const ours = new Set<number>([card.compId, ...this.opened, ...(result !== undefined ? [result] : [])]);
    // A comp the run did not open: the user went there meanwhile, and it is theirs now.
    if (!ours.has(now)) { this.userComp = now; return; }
    // They were on the run's comp: the result is what they are looking for, and where they are now.
    if (userComp === card.compId) { this.userComp = now; return; }
    try {
      await this.tl().openComp(userComp);
    } catch {
      this.userComp = now;
      return;
    }
    this.snap = await this.host.snapshot();
    if (card.status === 'done' && result !== undefined) {
      this.notice = `"${card.tool?.label ?? 'The run'}" is ready — Open comp in Results. The comp you were on stays in front.`;
    }
  }

  /**
   * The input of a Comp tab run. A layer: its own file. The comp: a render of
   * its span (the work area, or all of it — never longer than the cap), made now
   * by the host's render queue into the card's folder next to the project, and
   * imported, so the result can stand on exactly what the model saw.
   */
  private async toolClip(card: Card): Promise<ClipSource> {
    const host = this.tl();
    await this.ensureComp(card.compId);
    if (card.origin.kind === 'layer') return this.layerClip(card);
    if (card.origin.kind !== 'comp') throw new Error('A Comp tab run starts from the comp or from a layer.');
    const comp = this.snap?.comp;
    if (!comp || comp.id !== card.compId) throw new Error('The comp this run is for is not open in EffectCraft.');
    const origin = card.origin;
    const n = (card.versions.at(-1)?.n ?? 0) + 1;
    const span = origin.range === 'workArea' ? `work-area-${secs(origin.start)}-${secs(origin.end)}s` : 'whole-comp';
    this.phase(card, 'Rendering the comp');
    const r = await host.renderRange({
      start: origin.start, duration: Math.max(0, origin.end - origin.start), cap: card.tool?.cap ?? 8,
      dir: join(this.mediaDir, card.id), name: `${slugFromPrompt(comp.name, 24)}_${span}_v${String(n).padStart(3, '0')}`, format: 'prores',
    });
    this.throwIfCancelled();
    // Comfy Cloud takes uploads up to 100 MiB (its /api/features: max_upload_size 104857600, measured 25 Oct 2026).
    const route = this.running?.runner?.resource;
    const size = existsSync(r.path) ? statSync(r.path).size : 0;
    if (route?.kind === 'cloud' && size > 104_857_600) {
      throw new Error(`The render is ${Math.round(size / 1048576)} MB and Comfy Cloud takes uploads up to 100 MiB: shorten the work area (or lower the cap), or run it locally.`);
    }
    this.phase(card, 'Importing the render');
    const itemId = await host.importFile(r.path);
    const info = await host.itemInfo(itemId);
    if (!info?.width || !info.height) throw new Error('EffectCraft did not report the size of the render.');
    const end = r.start + r.duration;
    const name = origin.range === 'workArea' ? `${comp.name} · work area ${secs(r.start)}–${secs(end)} s` : `${comp.name} · whole comp`;
    return {
      kind: origin.range, itemId, path: r.path, name, start: r.start, end,
      info: { ...info, frameRate: info.frameRate || comp.fps, duration: info.duration || r.duration },
    };
  }

  /** The result's name: "<Comp> · 9:16", then "<Comp> · 9:16 v2" for the next versions. */
  private toolCompName(card: Card, n: number): string {
    const base = card.tool?.label ?? resultName(this.snap?.comp?.name ?? 'Comp', card.tool?.id ?? 'tool', card.tool?.options ?? {});
    return n > 1 ? `${base} v${n}` : base;
  }

  /** What a Comp tab version records about its input. */
  private sourceRecord(src: ClipSource): NonNullable<Version['source']> {
    const rel = relative(this.mediaDir, src.path);
    const inside = !rel.startsWith('..') && !/^[a-z]:/i.test(rel);
    return {
      kind: src.kind, file: inside ? rel.replace(/\\/g, '/') : src.path, start: src.start, end: src.end,
      itemId: src.kind === 'layer' ? undefined : src.itemId, name: src.name,
    };
  }

  /** A frame of the result as the host composites it now (the comp just built is the open one). */
  private async resultThumb(card: Card, stem: string, time: number): Promise<string | undefined> {
    const png = `${card.id}/${stem}.thumb.png`;
    try {
      await this.tl().frameAt(Math.max(0, time), join(this.mediaDir, png));
    } catch {
      return undefined;
    }
    // A full frame is megabytes (14 MB at 2560×1408); Results shows it at 72 px: a 480-px JPEG, with ffmpeg on the PATH.
    const jpg = `${card.id}/${stem}.thumb.jpg`;
    if (await smallJpeg(join(this.mediaDir, png), join(this.mediaDir, jpg))) {
      rmSync(join(this.mediaDir, png), { force: true });
      return jpg;
    }
    return png;
  }

  /** A Comp tab run: its source first, then what its tool makes of it. */
  private async generateTool(card: Card, entry: LibraryEntry, api: WorkflowJson, seed: number | null, t0: number): Promise<void> {
    const m = entry.manifest;
    // Extend needs only the source's last frame, not a render of it.
    if (card.tool?.id === 'extend') return this.extendTool(card, entry, api, seed, t0);
    // LTX finishing: the graph is built from the plan of the clip in hand, not filled in from the bundled one.
    const spec = card.tool ? finishSpec(card.tool.id, card.tool.options) : null;
    if (spec) return this.finishingTool(card, entry, spec, t0);
    const src = await this.toolClip(card);
    if (m.task === 'outpaint-video') return this.outpaint(card, entry, api, seed, t0, src);
    this.phase(card, 'Uploading');
    setRef(api, m.bindings.video, await this.runner().uploadFile(src.path, () => readFileSync(src.path), `flow_${card.id}${extname(src.path)}`, videoMime(src.path)));
    const models = this.checkModels(api, m);
    if (m.task === 'reframe') return this.reframe(card, entry, api, seed, models, t0, src);
    if (m.task === 'upscale-video') return this.upscaleToComp(card, entry, api, seed, models, t0, src);
    if (m.task === 'matte-video') return this.matteTool(card, entry, api, seed, models, t0, src);
    if (m.task === 'interpolate-video') return this.interpolateTool(card, entry, api, seed, models, t0, src);
    throw new Error(`${m.title} is not one of the Comp tab's tools.`);
  }

  /**
   * Extend: a new layer that starts at the source's out point, in the same comp, the source untouched; a comp too
   * short to hold it is lengthened.
   *
   * From footage (ltx25-extend, from the official template video_ltx2_5_flf2v): the source's last 17 (or 9) frames go
   * up as a short clip and guide LTX-2.5 from frame 0 of the new latent (LTXVAddGuide; LTXVCropGuides takes the guide
   * tokens off before decoding). The result starts with those frames, given back, then the new ones: the layer starts
   * that many frames early and its in point is the out point. The result is made at the generation size and laid back
   * at the source's size, width and height each scaled on its own (the guide was stretched to it, not cropped).
   *
   * From a still, or a source too short to guide with (ltx25-i2v): the last frame into image-to-video, as before; its
   * first generated frame repeats that frame and is trimmed the same way.
   */
  private async extendTool(card: Card, entry: LibraryEntry, api: WorkflowJson, seed: number | null, t0: number): Promise<void> {
    const host = this.tl();
    const m = entry.manifest;
    await this.ensureComp(card.compId);
    const comp = this.snap?.comp;
    if (!comp || comp.id !== card.compId) throw new Error('The comp this run is for is not open in EffectCraft.');
    const seconds = Number(card.tool?.options.seconds) || 2;
    const n = (card.versions.at(-1)?.n ?? 0) + 1;
    const vtag = `_v${String(n).padStart(3, '0')}`;
    const dir = join(this.mediaDir, card.id);
    mkdirSync(dir, { recursive: true });
    const guided = m.task === 'extend-video' && !!m.guide;
    const frameRel = `${card.id}/last-frame${vtag}.png`;
    const tailRel = `${card.id}/last-frames${vtag}.mov`;
    let input = join(this.mediaDir, guided ? tailRel : frameRel);
    let guide = guided ? Number(card.params['@guide']) || m.guide!.frames[0] : 0;
    // The longest guide (8n + 1) that fits in what the source has; none under 9 frames.
    const fitGuide = (available: number): number => {
      const g = [...m.guide!.frames].sort((a, b) => b - a).find((x) => x <= Math.min(guide, available));
      if (!g) throw new Error(`The source has ${available} frame${available === 1 ? '' : 's'} before its out point: a motion guide needs ${Math.min(...m.guide!.frames)}.`);
      return g;
    };
    let out: number;
    let fps: number;
    let width: number;
    let height: number;
    let name: string;
    let layer: HostLayer | undefined;
    let item: number | undefined;
    let how: string;
    this.phase(card, guided ? 'Taking the last frames' : 'Taking the last frame');
    if (card.origin.kind === 'layer') {
      const clip = await this.layerClip(card);
      layer = this.snap?.layers.find((l) => l.id === (card.origin as { layerId: number }).layerId);
      if (!layer) throw new Error('The layer this run is for is no longer in the comp.');
      item = clip.itemId;
      out = layer.out;
      fps = clip.info.frameRate || comp.fps;
      width = clip.info.width;
      height = clip.info.height;
      name = clip.name;
      const still = clip.info.kind === 'still' || /\.(png|jpe?g|webp|tiff?|exr|bmp)$/i.test(clip.path);
      if (guided) {
        if (still) throw new Error('A still has no motion to carry on: open the card again, it plans the run from the still itself.');
        // The clip's own frames under its out point (its own pixels, not the comp's composite), by frame number —
        // never past the clip's last real frame (an LTX-2.5 clip's sound makes its container a frame or two longer).
        const last = await lastVideoFrame(clip.path, Math.round((out - layer.start) * fps) - 1);
        guide = fitGuide(last + 1);
        const first = last - guide + 1;
        if (!await framesOf(clip.path, first, last, input)) throw new Error('Extend takes the clip\'s last frames with ffmpeg: put ffmpeg on the PATH.');
        how = `frames ${first}–${last} of ${basename(clip.path)} (ffmpeg)`;
      } else if (still) {
        input = clip.path;
        how = 'the still itself';
      } else {
        const at = Math.max(0, out - layer.start - 1 / fps);
        if (await frameOf(clip.path, at, input)) how = `frame at ${at.toFixed(3)} s of ${basename(clip.path)} (ffmpeg)`;
        else {
          await host.frameAt(Math.max(layer.in, out - 1 / comp.fps), input);
          how = 'the comp\'s frame under the out point (ffmpeg not on the PATH)';
        }
      }
    } else if (card.origin.kind === 'comp') {
      const [s, e] = card.origin.range === 'workArea' ? (comp.workArea ?? [0, comp.duration]) : [0, comp.duration];
      card.origin.start = s;
      card.origin.end = e;
      out = e;
      fps = comp.fps;
      width = comp.width;
      height = comp.height;
      name = card.origin.range === 'workArea' ? `${comp.name} · work area ${secs(s)}–${secs(e)} s` : comp.name;
      if (guided) {
        // The comp's frames as EffectCraft composites them (render.frame), one by one, then one ProRes clip (ffmpeg).
        const last = Math.round(e * fps) - 1;
        guide = fitGuide(last - Math.round(s * fps) + 1);
        const first = last - guide + 1;
        const seq = join(dir, `last-frames${vtag}`);
        mkdirSync(seq, { recursive: true });
        for (let i = 0; i < guide; i++) {
          this.throwIfCancelled();
          this.phase(card, 'Taking the last frames', i, guide);
          // A tenth of a frame in: the frame itself whether the host rounds or floors the time.
          await host.frameAt((first + i + 0.1) / fps, join(seq, `${String(i).padStart(3, '0')}.png`));
        }
        if (!await sequenceToClip(seq, fps, input)) throw new Error('Extend joins the comp\'s last frames with ffmpeg: put ffmpeg on the PATH.');
        rmSync(seq, { recursive: true, force: true });
        how = `the comp's frames ${first}–${last} (render.frame ×${guide}, ffmpeg)`;
      } else {
        await host.frameAt(Math.max(s, e - 1 / fps), input);
        how = `the comp's frame at ${(e - 1 / fps).toFixed(3)} s (render.frame)`;
      }
    } else {
      throw new Error('Extend starts from the comp, its work area or a layer.');
    }
    this.throwIfCancelled();
    if (guided) {
      const got = await countFrames(input);
      if (got !== null && got < guide) throw new Error(`The last frames came out as ${got}, not ${guide}: ${how}.`);
    }
    const size = planSize(m, { width, height });
    if (!size) throw new Error('The source has no size.');
    setRef(api, m.bindings.width, size.width);
    setRef(api, m.bindings.height, size.height);
    setRef(api, m.bindings.fps, fps);
    setRef(api, m.bindings.seconds, Math.ceil(seconds));
    const frames = guided ? ltxGuidedFrames(seconds, fps, guide) : ltxExtendFrames(seconds, fps);
    if (!setLtxLength(api, m, frames)) throw new Error(`${m.title}: no length to set (the seconds × fps + 1 expression is not in the graph).`);
    this.phase(card, 'Uploading');
    const upFile = input;
    if (guided) {
      setRef(api, m.guide!.start, -guide);
      setRef(api, m.guide!.take, guide);
      setRef(api, m.bindings.video, await this.runner().uploadFile(upFile, () => readFileSync(upFile), `flow_${card.id}${vtag}.mov`, 'video/quicktime'));
    } else {
      setRef(api, m.bindings.image, await this.runner().uploadFile(upFile, () => readFileSync(upFile), `flow_${card.id}${extname(upFile)}`, extname(upFile).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg'));
    }
    const models = this.checkModels(api, m);
    const result = await this.runJob(card, api, m, undefined, this.meta(m, frames / fps));
    const saved = this.saveVersion(card, m, result, slugFromPrompt(card.tool?.label ?? name, 28));
    // The frames before the out point: the guide given back, or the repeated last frame.
    const lead = guided ? guide : 1;
    const outFrames = await countFrames(saved.abs);
    if (outFrames !== null && outFrames <= lead) throw new Error(`${m.title} returned ${outFrames} frames, no more than the ${lead} it was given.`);

    this.phase(card, 'Placing in EffectCraft');
    await this.ensureComp(card.compId);
    const before = this.snap?.comp?.duration ?? comp.duration;
    const end = out + seconds;
    let lengthened: [number, number] | undefined;
    if (end > before + 1e-3) {
      await host.setCompDuration(end);
      lengthened = [before, end];
      this.snap = await this.host.snapshot();
    }
    const comment = `${SLUG} card=${card.id} v${saved.n} · ${m.title} · +${seconds} s from ${secs(out)} s${guided ? ` · guided by the last ${guide} frames` : ''}${seed !== null ? ` · seed ${seed}` : ''}\n${card.prompt}`;
    let placedLayer: number;
    const still = card.placed && this.snap?.layers.some((l) => l.id === card.placed!.layerId);
    if (card.placed && still) {
      // The next version replaces the footage of the layer it made; its place and timing stay (same tool, variant, guide).
      await host.replaceFootage(card.placed.itemId, saved.abs, [card.placed.layerId]);
      await host.setLayerComment(card.placed.layerId, comment).catch(() => undefined);
      placedLayer = card.placed.layerId;
    } else {
      const placed = await host.place({
        file: saved.abs, time: out, endTime: end, sourceStart: out - lead / fps,
        name: `${TAG} +${seconds} s · ${layerNameFromPrompt(card.prompt || name, 40)}`, comment, index: layer ? layer.index : 1,
      });
      card.placed = placed;
      placedLayer = placed.layerId;
      if (layer && item !== undefined) await host.matchLayer(placed.layerId, placed.itemId, layer.id, item, guided).catch(() => undefined);
      else if (guided) await host.fitComp(placed.layerId, placed.itemId, comp.width, comp.height).catch(() => undefined);
      else await host.coverComp(placed.layerId, placed.itemId, comp.width, comp.height).catch(() => undefined);
    }
    card.placedVersion = saved.n;
    const thumb = await this.resultThumb(card, saved.stem, out + seconds / 2);
    this.notice = `Extended "${name}" by ${seconds} s${guided ? `, carrying on the last ${(guide / fps).toFixed(1)} s of motion` : ''}: a new layer from ${secs(out)} s in "${comp.name}"`
      + (lengthened ? `; the comp is now ${secs(lengthened[1])} s long (it was ${secs(lengthened[0])} s).` : '.');
    const fromRel = input.startsWith(this.mediaDir) ? relative(this.mediaDir, input).replace(/\\/g, '/') : input;
    this.recordVersion(card, m, {
      n: saved.n, file: saved.rel, kind: 'video', workflowId: m.id, prompt: card.prompt, seed, width: size.width, height: size.height, seconds,
      jobId: result.jobId, createdAt: new Date().toISOString(), elapsedMs: Date.now() - t0, remaps: models.remaps.map((r) => `${r.wanted} → ${r.using}`),
      thumb, compName: comp.name,
      source: { kind: card.origin.kind === 'layer' ? 'layer' : card.origin.range, file: fromRel, start: out - lead / fps, end: out, name },
      compare: { compId: card.compId, showing: 'result', result: [[placedLayer, true]], original: [[placedLayer, false]] },
    }, saved.stem, {
      comp: comp.name, tool: card.tool, at: out, seconds, frames, outputFrames: outFrames, fps, size: `${size.width}×${size.height}`, lengthened,
      ...(guided ? { guide: { frames: guide, seconds: Math.round((guide / fps) * 1000) / 1000, from: how, trimmed: guide } } : { lastFrame: how }),
    });
    await this.setHostStatus(card, 'done');
  }

  /**
   * Slow motion / frame rate: the interpolated clip in a new comp — at the source's rate for slow motion (×2 or ×4
   * as long), or at twice the rate (as long as before) — with the original under it, switched off.
   */
  private async interpolateTool(card: Card, entry: LibraryEntry, api: WorkflowJson, seed: number | null, models: ModelCheck, t0: number, src: ClipSource): Promise<void> {
    const host = this.tl();
    const m = entry.manifest;
    const it = m.interpolate;
    if (!it) throw new Error(`${m.title} has no interpolation settings in its manifest.`);
    const mode = String(card.tool?.options.mode ?? 'slow2');
    const k = Number(getRef(api, it.multiplier)) || 2;
    if (card.params['@audio'] === false) {
      // Slow motion: the sound would not stretch with the picture.
      const { nodeId, field } = splitRef(it.audio);
      if (api[nodeId]) delete api[nodeId].inputs[field];
    }
    const srcFps = src.info.frameRate || this.snap?.comp?.fps || 24;
    const result = await this.runJob(card, api, m, undefined, this.meta(m, src.info.duration || null));
    const saved = this.saveVersion(card, m, result, slugFromPrompt(card.tool?.label ?? src.name, 28));

    this.phase(card, 'Building the comp');
    const upItem = await host.importFile(saved.abs);
    const up = await host.itemInfo(upItem);
    const fps = mode === 'fps2' ? srcFps * 2 : srcFps;
    const inFrames = Math.max(1, Math.round((src.info.duration || 1) * srcFps));
    const outFrames = up?.duration && up.frameRate ? Math.round(up.duration * up.frameRate) : (inFrames - 1) * k + 1;
    const duration = up?.duration || outFrames / fps;
    const width = up?.width || src.info.width;
    const height = up?.height || src.info.height;
    const compName = this.toolCompName(card, saved.n);
    const by = /rife/.test(m.id) ? 'RIFE' : 'FILM';
    const comment = `${SLUG} card=${card.id} v${saved.n} · ${m.title} · ${mode === 'fps2' ? `${srcFps} → ${fps} fps` : `×${k} slow`}`;
    const built = await host.buildComp({
      name: compName, width, height, fps, duration,
      layers: [
        { itemId: upItem, name: `${TAG} ${mode === 'fps2' ? `${Math.round(fps * 100) / 100} fps` : `×${k} slow`} · ${src.name}`, comment },
        { itemId: src.itemId, name: `${src.name} (original)`, scale: Math.round((width / src.info.width) * 100000) / 1000, visible: false },
      ],
    });
    const [upLayer, original] = built.layers;
    const thumb = await this.resultThumb(card, saved.stem, duration / 2);
    this.notice = mode === 'fps2'
      ? `"${src.name}" at ${Math.round(fps * 100) / 100} fps in the new comp "${compName}": ${outFrames} frames, every other one made by ${by}.`
      : `"${src.name}" ×${k} slower in the new comp "${compName}" (${secs(duration)} s, ${outFrames} frames by ${by}); your original is in it too, switched off.`;
    this.recordVersion(card, m, {
      n: saved.n, file: saved.rel, kind: 'video', workflowId: m.id, prompt: card.prompt, seed, width, height, seconds: duration,
      jobId: result.jobId, createdAt: new Date().toISOString(), elapsedMs: Date.now() - t0,
      remaps: models.remaps.map((r) => `${r.wanted} → ${r.using}`), compId: built.compId, itemId: upItem,
      thumb, compName, source: this.sourceRecord(src),
      compare: { compId: built.compId, showing: 'result', result: [[upLayer, true], [original, false]], original: [[upLayer, false], [original, true]] },
    }, saved.stem, { comp: compName, mode, multiplier: k, fps: { in: srcFps, out: fps }, frames: { in: inFrames, out: outFrames }, tool: card.tool, source: this.sourceRecord(src) });
    await this.setHostStatus(card, 'done');
  }

  /* ─── LTX finishing ───────────────────────────────────────────────── */

  /**
   * Where LTX finishing may run: the local ComfyUI (or the proxy in front of it), or a resource whose probe found the
   * workflow's nodes and models (or where a run of it finished). A deployment's catalogue cannot be read over Comfy API
   * v2, and the one this app knows was built with core nodes, Wan VACE and SeedVR2 only: no LTX-2.5 there.
   */
  private finishingElsewhere(r: Resource, workflowId?: string): string | null {
    if (r.kind === 'local') return null;
    if (r.kind === 'proxy' && r.fronts === this.services.resources.local().id) return null;
    if (workflowId && this.services.caps.has(r, workflowId) === 'ok') return null;
    return `${r.label}: JustAE Flow knows of no LTX-2.5 model there${r.kind === 'deployment' ? ' — it was built without LTX-2.5, as far as JustAE Flow knows' : ''}. `
      + 'LTX finishing runs on your local ComfyUI: pick Local for this card (or set Settings ▸ Resources ▸ LTX finishing to Local).';
  }

  /** The IC-LoRA files of a tool the local ComfyUI lacks; undefined while its catalogue has not been read. */
  private missingLoras(loras: LoraId[]): Array<{ what: string; file: string; url: string }> | undefined {
    const oi = this.objectInfo as unknown as NodeCatalog | null;
    if (!oi) return undefined;
    const known = loras.filter((l): l is LoraId => l in LORAS);
    const { missing } = checkFiles(oi, known, 'local');
    const files = new Set(known.map((l) => LORAS[l].file));
    return missing.filter((x) => files.has(x.file)).map((x) => ({ what: x.what, file: x.file, url: x.repo }));
  }

  /** What is missing for a finishing run, with where it comes from (gated repos: the terms first). */
  private missingText(missing: Array<{ what: string; file: string; repo: string; folder: string }>): string {
    return `Not on the local ComfyUI: ${missing.map((x) => `${x.what} (${x.file} → ${x.folder}, from ${x.repo})`).join('; ')}. `
      + 'The Lightricks repos are gated: open each page, press "Agree and Access", download the file into that folder, then restart ComfyUI.';
  }

  /** A finishing card's plan, completed with what only the server knows: the local ComfyUI's files, where it would run. */
  private async finishingChecks(
    tool: ToolDef, options: ToolOptions, plan: ToolPlan, info: SourceInfo, resource?: string | null,
    tiling?: (r: TilingRequest) => TilingSizes | null,
  ): Promise<void> {
    const spec = finishSpec(tool.id, options);
    if (!spec || !plan.ok) return;
    const entry = this.library.get(spec.workflowId);
    if (entry) {
      const r = this.services.resources.resolve(taskOf(entry.manifest.task, entry.manifest.id), resource ?? null, (x) => this.services.caps.has(x, entry.manifest.id)).resource;
      const why = this.finishingElsewhere(r, entry.manifest.id);
      if (why) plan.warnings.unshift(why);
    }
    const oi = this.objectInfo as unknown as NodeCatalog | null;
    if (!oi) {
      plan.notes.push('The local ComfyUI has not been read yet: its LTX-2.5 files are checked when the run starts.');
      if (!this.checking) void this.checkComfy().catch(() => undefined);
      return;
    }
    let fp: FinishPlan | null = null;
    if (spec.kind === 'tiled') fp = planFinish({ width: info.width, height: info.height, pixelAspect: 1, frames: Math.max(1, Math.round(info.seconds * (info.fps || 24))), fps: info.fps || 24 }, spec.options, tiling);
    const files = checkFiles(oi, fp ? lorasOf(fp) : [spec.kind === 'single' ? spec.lora : spec.kind === 'hdr' ? 'sdr2hdr' : 'refine'], 'local');
    if (!files.models) {
      plan.ok = false;
      plan.reason = this.missingText(files.missing);
      return;
    }
    if (spec.kind === 'hdr' && !this.hdrEmbedding(oi)) {
      plan.ok = false;
      plan.reason = HDR_EMBEDDING.missing;
      return;
    }
    const fits = fitsLocally(oi, await this.localVramGb());
    if (fp) {
      const v = localVerdict(fp, fits);
      if (!v.ok) { plan.ok = false; plan.reason = v.warnings.join(' '); return; }
      plan.warnings.push(...v.warnings);
    } else if (!fits) {
      plan.ok = false;
      plan.reason = NO_QUANTIZED;
      return;
    }
    if (fp && (await this.decodeFor(fp.options)) === 'low-vram') {
      plan.notes.push('Decode on this card (16 GB): the official workflows\' low-VRAM tiles, 512 px / 64 / 128 frames / 32 — the Refine card\'s 1024 / 128 / 256 took 27 min to decode a Full HD clip of 121 frames here.');
    }
    plan.notes.push(`On the local ComfyUI: ${files.models.transformer.replace(/\.safetensors$/, '')}, ${Object.values(files.models.loras).map((x) => String(x).split('/').pop()!.replace(/\.safetensors$/, '')).join(' + ')}.`);
  }

  /** The SDR → HDR scene embedding as LTXVLoadConditioning lists it (models/embeddings), or null. */
  private hdrEmbedding(oi: NodeCatalog): string | null {
    return comboOptions(oi, 'LTXVLoadConditioning', 'file_name').find((x) => HDR_EMBEDDING.pattern.test(x)) ?? null;
  }

  /**
   * The LTX pack's sizes for a tiled finishing card (LTXVGetTilingSizes, one-node prompts on the local ComfyUI, cached
   * per request): what the card shows before a run. Undefined for other tools; a lookup that answers null where the
   * pack could not be asked in time (the card then says the sizes come at run time).
   */
  private async tilingForCard(toolId: string, options: ToolOptions, info: SourceInfo, resource?: string | null, waitMs = 4000): Promise<((r: TilingRequest) => TilingSizes | null) | undefined> {
    const spec = finishSpec(toolId, options);
    if (!spec || spec.kind !== 'tiled' || info.media !== 'video' || !info.width || !info.height) return undefined;
    // Only where the card would run: LTX finishing runs on the local ComfyUI (a card routed elsewhere is refused anyway).
    const entry = this.library.get(spec.workflowId);
    if (entry) {
      const r = this.services.resources.resolve(taskOf(entry.manifest.task, entry.manifest.id), resource ?? null, (x) => this.services.caps.has(x, entry.manifest.id)).resource;
      if (this.finishingElsewhere(r, entry.manifest.id)) return undefined;
    }
    const frames = Math.max(1, Math.round(info.seconds * (info.fps || 24)));
    const reqs = tilingRequests({ width: info.width, height: info.height, pixelAspect: 1, frames, fps: info.fps || 24 }, spec.options);
    try {
      return await tilingLookup(this.comfy, reqs, waitMs);
    } catch {
      return () => null;
    }
  }

  private vramTotal: { at: number; gb: number | null } | null = null;

  /** The local GPU's memory, GiB (its /system_stats), read at most once a minute; null when it does not say. */
  private async localVramGb(): Promise<number | null> {
    if (this.vramTotal && Date.now() - this.vramTotal.at < 60_000) return this.vramTotal.gb;
    let gb: number | null = null;
    try {
      const r = await fetch(`${this.comfy.base}/api/system_stats`, { signal: AbortSignal.timeout(4000) });
      const d = ((await r.json()) as { devices?: Array<{ vram_total?: number }> }).devices?.[0];
      gb = typeof d?.vram_total === 'number' ? Math.round((d.vram_total / 2 ** 30) * 10) / 10 : null;
    } catch { /* unknown */ }
    this.vramTotal = { at: Date.now(), gb };
    return gb;
  }

  /**
   * The decode a tiled run uses on this machine: on a card of 16 GB or less, the official LTX-2.5 workflows' low-VRAM
   * decode (512 / 64 / 128 / 32) for anything bigger than a preview tile — the Refine card's 1024 / 128 / 256 decode of a
   * Full HD clip of 121 frames took 27 min here, against 11 min of sampling (measured 26 Oct, RTX 5080 16 GB).
   */
  private async decodeFor(options: FinishOptions): Promise<'card' | 'low-vram'> {
    if (options.preview) return 'card';
    const gb = await this.localVramGb();
    return gb !== null && gb <= 17 ? 'low-vram' : 'card';
  }

  /** The lowest free VRAM the local ComfyUI reports while a job runs (its /system_stats, every 5 s). */
  private vramWatch(): { stop: () => { minFreeGb: number | null; totalGb: number | null; samples: number } } {
    let minFree = Infinity;
    let total = 0;
    let samples = 0;
    const tick = async (): Promise<void> => {
      try {
        const r = await fetch(`${this.comfy.base}/api/system_stats`, { signal: AbortSignal.timeout(4000) });
        const d = ((await r.json()) as { devices?: Array<{ vram_free?: number; vram_total?: number }> }).devices?.[0];
        if (typeof d?.vram_free === 'number') { minFree = Math.min(minFree, d.vram_free); total = d.vram_total ?? total; samples++; }
      } catch { /* a missed reading is not a failure */ }
    };
    void tick();
    const timer = setInterval(() => void tick(), 5000);
    const gb = (b: number): number => Math.round((b / 2 ** 30) * 10) / 10;
    return { stop: () => { clearInterval(timer); return { minFreeGb: Number.isFinite(minFree) ? gb(minFree) : null, totalGb: total ? gb(total) : null, samples }; } };
  }

  /**
   * LTX finishing (core/finishing): the source as one file — the layer's own, or a render of the comp — counted frame
   * by frame, planned again with that count, checked against the local ComfyUI (nodes, files, the graph itself) before
   * it is uploaded, then one job: the 16-bit frames (the master, kept next to the project) and an 8-bit MP4 of the
   * same frames (what the comp shows). The result is a new comp at the delivery size with the original under it,
   * switched off — or, for LTX Alpha, a matte placed like SAM 3's.
   */
  private async finishingTool(card: Card, entry: LibraryEntry, spec: FinishSpec, t0: number): Promise<void> {
    const host = this.tl();
    const m = entry.manifest;
    const t = card.tool!;
    const src = await this.toolClip(card);
    const fps = src.info.frameRate || this.snap?.comp?.fps || 24;
    this.phase(card, 'Counting the frames');
    const counted = await countFrames(src.path);
    const frames = counted ?? Math.max(1, Math.round((src.info.duration || 1) * fps));
    const { width, height } = src.info;
    this.throwIfCancelled();

    // The local ComfyUI's catalogue: finishing runs only there (generate() refused anything else).
    const oi = (this.objectInfo ?? await this.comfy.objectInfo()) as unknown as NodeCatalog;
    if (!fitsLocally(oi, await this.localVramGb())) throw new Error(NO_QUANTIZED);
    let fp: FinishPlan | null = null;
    let sp: SinglePlan | null = null;
    let hp: HdrPlan | null = null;
    let needs: LoraId[];
    let nodes: string[];
    if (spec.kind === 'tiled') {
      const fo = { ...spec.options, decode: await this.decodeFor(spec.options) };
      const src0 = { width, height, pixelAspect: 1, frames, fps };
      // The LTX pack's sizes for this clip (the same requests the graph's LTXVGetTilingSizes nodes get): the delivery,
      // the preview tile and the estimate need them before the run. A busy ComfyUI answers after its current job.
      this.phase(card, 'Asking the LTX pack for the sizes');
      fp = planFinish(src0, fo, await tilingLookup(this.comfy, tilingRequests(src0, fo), 90_000));
      if (!fp.sized && fo.preview) throw new Error('The LTX pack did not give its tiling sizes in time (is the local ComfyUI busy with another job?): a preview tile needs them to pick its tile. Try again when it is idle.');
      needs = lorasOf(fp);
      nodes = requiredNodes(fp, 'video', true);
    } else if (spec.kind === 'hdr') {
      hp = planHdr({ width, height, frames, fps });
      needs = ['sdr2hdr'];
      nodes = hdrNodes();
    } else {
      sp = planSingle(spec.lora, { width, height, frames, fps }, spec.size);
      if (sp.reason) throw new Error(sp.reason);
      needs = [spec.lora];
      nodes = singleNodes(spec.master !== 'none');
    }
    const absent = nodes.filter((x) => !oi[x]);
    if (absent.length) throw new Error(`The local ComfyUI lacks ${absent.join(', ')} (ComfyUI-LTXVideo 1.1.0, VideoHelperSuite).`);
    const files = checkFiles(oi, needs, 'local');
    if (!files.models) throw new Error(this.missingText(files.missing));
    const embedding = hp ? this.hdrEmbedding(oi) : null;
    if (hp && !embedding) throw new Error(HDR_EMBEDDING.missing);

    const n = (card.versions.at(-1)?.n ?? 0) + 1;
    const seed = card.seed ?? Math.floor(Math.random() * 2 ** 47);
    const crop = fp?.previewCrop ?? null;
    const prefix = `${SLUG}/finish/${card.id}_v${String(n).padStart(3, '0')}`;
    // The source's sound into the preview — not for a preview tile, which is shorter than the clip.
    const previewVideo = { prefix: `${prefix}/preview`, fps, audio: !crop };

    this.phase(card, 'Uploading');
    const uploaded = await this.runner().uploadFile(src.path, () => readFileSync(src.path), `flow_${card.id}${extname(src.path)}`, videoMime(src.path));
    let graph: { workflow: Record<string, { class_type: string; inputs: Record<string, unknown>; _meta?: { title?: string } }>; saveNode: string | null | undefined; previewNode?: string; hlgNode?: string };
    let prompts: Record<string, string>;
    if (fp && spec.kind === 'tiled') {
      const look = card.prompt.trim();
      const p = {
        positive: spec.look === 'refine' && look ? look : DEFAULT_PROMPTS.positive,
        negative: DEFAULT_PROMPTS.negative,
        restorePositive: spec.look === 'restore' && look ? look : DEFAULT_PROMPTS.restorePositive,
        // Kept as Flow 2 had it; at guidance 1.0 ComfyUI does not evaluate it (core/comp/finishing-tools.ts, NEGATIVE_NOTE).
        restoreNegative: DEFAULT_PROMPTS.restoreNegative,
      };
      prompts = p;
      graph = buildFinishGraph({ plan: fp, models: files.models, input: { video: uploaded }, prompts: p, seed, outputPrefix: `${prefix}/frame`, preview: previewVideo });
    } else if (hp) {
      // SDR → HDR: no prompt — the scene embedding is the conditioning (its card); the EXR frames are written by
      // LTXVHDRDecodePostprocess into its own folder under ComfyUI's output, fetched below by name.
      prompts = { conditioning: `scene embedding ${embedding}` };
      const h = buildHdrGraph({
        plan: hp, models: { transformer: files.models.transformer, vae: files.models.vae, lora: files.models.loras.sdr2hdr!, embedding: embedding! },
        video: uploaded, seed, exrDir: `${prefix}/exr`, exrPrefix: 'frame', preview: previewVideo, hlgPrefix: `${prefix}/hlg`,
      });
      graph = { workflow: h.workflow, saveNode: null, previewNode: h.previewNode, hlgNode: h.hlgNode };
    } else {
      const single = SINGLE_TOOLS.find((x) => x.lora === sp!.lora);
      const key = single?.field?.key;
      const p = singlePrompt(sp!.lora, card.prompt.trim() || single?.prompt.fallback || '', key ? String(t.options[key] ?? '') : '');
      prompts = p;
      graph = buildSingleGraph({ plan: sp!, models: files.models, video: uploaded, prompt: p, seed, outputPrefix: `${prefix}/frame`, master: spec.kind === 'single' ? spec.master : 'png16', preview: previewVideo });
    }
    const loadId = Object.entries(graph.workflow).find(([, x]) => x.class_type === 'LoadVideo')?.[0] ?? '';
    const problems = validateGraph(graph.workflow, oi, [`${loadId}.file`]);
    if (problems.length) throw new Error(`The local ComfyUI would refuse the finishing graph: ${problems.slice(0, 3).join(' · ')}`);
    const estimate = fp ? estimateFinish(fp) : estimateSingle(hp ?? sp!);

    const vram = this.vramWatch();
    let res: { outputs: OutputFile[]; jobId: string };
    let seenVram: { minFreeGb: number | null; totalGb: number | null; samples: number };
    try {
      // The run history knows each variant apart (core/comp/finishing-tools.ts: plan.jobs), for what it covered.
      const covered = (fp ? fp.frames.source : (hp ?? sp!).frames.source) / fps;
      res = await this.execute(card, graph.workflow as unknown as WorkflowJson, undefined, this.meta(m, covered, t.variant && t.variant !== 'ltx-alpha' ? `:${t.variant}` : ''));
    } finally {
      seenVram = vram.stop();
    }
    const mp4 = res.outputs.filter((o) => o.nodeId === graph.previewNode && /\.(mp4|mov|webm)$/i.test(o.filename)).pop();
    if (!mp4) throw new Error('The finishing job ended without its MP4 preview.');
    this.phase(card, 'Downloading');
    const saved = this.saveVersion(card, m, { bytes: await this.runner().download(mp4), filename: mp4.filename }, slugFromPrompt(t.label ?? src.name, 28));

    // The master: every 16-bit frame, next to the project.
    let masterRec: { kind: 'png16' | 'exr16'; dir: string; first: string; count: number } | null = null;
    if (graph.saveNode) {
      const outs = res.outputs.filter((o) => o.nodeId === graph.saveNode && o.type === 'output').sort((a, b) => a.filename.localeCompare(b.filename));
      if (outs.length) {
        const kind: 'png16' | 'exr16' = /\.exr$/i.test(outs[0].filename) ? 'exr16' : 'png16';
        const ext = kind === 'exr16' ? 'exr' : 'png';
        const dir = join(this.mediaDir, card.id, `${saved.stem}_${kind}`);
        mkdirSync(dir, { recursive: true });
        let done = 0;
        const label = kind === 'exr16' ? 'EXR' : 'PNG 16-bit';
        this.phase(card, `Downloading the ${label} master`, 0, outs.length);
        await inPool(outs, 4, async (o, i) => {
          writeFileSync(join(dir, `${saved.stem}_${String(i).padStart(5, '0')}.${ext}`), await this.runner().download(o));
          this.phase(card, `Downloading the ${label} master`, ++done, outs.length);
        });
        masterRec = { kind, dir, first: join(dir, `${saved.stem}_00000.${ext}`), count: outs.length };
      }
    }
    if (hp) {
      const dir = join(this.mediaDir, card.id, `${saved.stem}_exr16`);
      mkdirSync(dir, { recursive: true });
      let done = 0;
      this.phase(card, 'Downloading the EXR master', 0, hp.frames.source);
      await inPool(Array.from({ length: hp.frames.source }, (_, i) => i), 4, async (i) => {
        const name = `frame_${String(i).padStart(5, '0')}.exr`;
        const bytes = await this.runner().download({ filename: name, subfolder: `${prefix}/exr`, type: 'output', bucket: 'images', nodeId: '' });
        writeFileSync(join(dir, `${saved.stem}_${String(i).padStart(5, '0')}.exr`), bytes);
        this.phase(card, 'Downloading the EXR master', ++done, hp.frames.source);
      });
      const hlg = res.outputs.filter((o) => o.nodeId === graph.hlgNode && /\.(mp4|mov)$/i.test(o.filename)).pop();
      if (hlg) writeFileSync(join(dir, `${saved.stem}_hlg.mp4`), await this.runner().download(hlg));
      masterRec = { kind: 'exr16', dir, first: join(dir, `${saved.stem}_00000.exr`), count: hp.frames.source };
    }
    const meter = this.running?.meter;
    const took = meter?.timed ? meter.executionMs / 1000 : (Date.now() - t0) / 1000;
    const record = {
      finishing: {
        spec, sourceFrames: counted, frames, fps,
        plan: fp ? {
          preset: fp.options.preset, preview: !!crop, delivery: fp.delivery, frames: fp.frames, previewCrop: fp.previewCrop,
          passes: fp.passes.map((p) => ({
            name: p.name, lora: p.lora, extraLora: p.extraLora, tiling: p.tiling, canvas: p.canvas, tile: p.tile,
            tiles: p.grid ? p.grid.x * p.grid.y : null, grid: p.grid ? [p.grid.x, p.grid.y] : null,
            tilesEstimated: p.approx ? { spatial: p.approx.spatial, grid: [p.approx.x, p.approx.y], temporal: p.approx.temporal } : null,
            pack: p.sizes ? { summary: p.sizes.summary, chunks: p.sizes.chunks, tileFrames: p.sizes.tileFrames, overlapFrac: p.sizes.overlapFrac } : null,
            steps: p.steps, fromImage: p.fromImage, load: p.load,
          })),
          load: fp.load, loadFormula: fp.loadFormula, fixes: fp.fixes, warnings: fp.warnings, decode: fp.options.decode ?? 'card',
        } : hp ? { lora: 'sdr2hdr', canvas: hp.canvas, frames: hp.frames, conditioningFps: hp.conditioningFps, fixes: hp.fixes, warnings: hp.warnings, exr: 'ACEScg scene-linear, half float (LTXVHDRDecodePostprocess)', hlg: 'BT.2020 HLG 10-bit' }
          : { lora: sp!.lora, size: sp!.size, canvas: sp!.canvas, delivery: sp!.delivery, frames: sp!.frames, fixes: sp!.fixes, warnings: sp!.warnings },
        models: files.models, prompts, seed,
        estimate: estimate ? { seconds: Math.round(estimate.seconds), basis: estimate.basis, tileSteps: estimate.tileSteps } : null,
        took: { seconds: Math.round(took * 10) / 10, basis: meter?.timed ? 'ComfyUI execution time' : 'wall-clock' },
        vram: { ...seenVram, basis: 'lowest vram_free of /system_stats, read every 5 s while the job ran' },
        master: masterRec ? { kind: masterRec.kind, dir: masterRec.dir, frames: masterRec.count } : null,
        licence: m.license.weights,
      },
    };
    const remaps = [`LTX-2.5 files used: ${files.models.transformer}, ${files.models.textEncoder}, ${files.models.vae}, ${Object.values(files.models.loras).join(', ')}`];

    if (sp?.lora === 'alpha') {
      await this.placeMatte(card, m, saved, src, { jobId: res.jobId, seed, t0, remaps, subject: '', by: 'LTX Alpha Gen', extra: record });
      return;
    }

    this.phase(card, 'Building the comp');
    const delivery = (fp ? fp.delivery : hp ? hp.canvas : sp!.delivery) ?? { w: 0, h: 0 };
    const upItem = await host.importFile(saved.abs);
    const up = await host.itemInfo(upItem);
    const w = up?.width || delivery.w || width;
    const h = up?.height || delivery.h || height;
    const duration = up?.duration || (crop ? fp!.frames.source / fps : src.info.duration || frames / fps);
    const compName = this.toolCompName(card, saved.n);
    const what = fp ? fp.passes.map((p) => p.name).join(' → ') : hp ? 'SDR → HDR' : (SINGLE_TOOLS.find((x) => x.lora === sp!.lora)?.name ?? sp!.lora);
    const comment = `${SLUG} card=${card.id} v${saved.n} · ${m.title} · ${what} · seed ${seed}${card.prompt ? `\n${card.prompt}` : ''}`;
    // The original under the result, scaled to it; for a preview tile, scaled to the full canvas and moved so the tile lines up.
    const canvas = crop?.canvas;
    const scale = canvas ? (canvas.w / width) * 100 : (w / width) * 100;
    const position: [number, number] | undefined = crop && canvas ? [canvas.w / 2 - crop.x, canvas.h / 2 - crop.y] : undefined;
    const built = await host.buildComp({
      name: compName, width: w, height: h, fps, duration,
      layers: [
        { itemId: upItem, name: `${TAG} ${t.label?.split(' · ').pop() ?? 'LTX'} · ${src.name}`, comment },
        { itemId: src.itemId, name: `${src.name} (original)`, scale: Math.round(scale * 1000) / 1000, position, visible: false },
      ],
    });
    const [upLayer, original] = built.layers;
    const thumb = await this.resultThumb(card, saved.stem, duration / 2);
    const fmtT = (sec: number): string => (sec < 90 ? `${Math.round(sec)} s` : `${Math.round(sec / 60)} min`);
    this.notice = `${what} in the new comp "${compName}" (${w}×${h}${crop ? ', one tile' : ''}): ${frames} frames`
      + `${masterRec ? `; the ${masterRec.kind === 'exr16' ? 'EXR' : 'PNG 16-bit'} master is next to the project` : ''}, the comp shows an 8-bit MP4 preview. `
      + `${estimate ? `Estimated ${describeFinishEstimate(estimate).split(' (')[0]}, took` : 'Took'} ${fmtT(took)}.`;
    this.recordVersion(card, m, {
      n: saved.n, file: saved.rel, kind: 'video', workflowId: m.id, prompt: card.prompt, seed, width: w, height: h, seconds: duration,
      jobId: res.jobId, createdAt: new Date().toISOString(), elapsedMs: Date.now() - t0, remaps,
      compId: built.compId, itemId: upItem, thumb, compName, source: this.sourceRecord(src),
      compare: { compId: built.compId, showing: 'result', result: [[upLayer, true], [original, false]], original: [[upLayer, false], [original, true]] },
      exports: masterRec ? [{ kind: masterRec.kind, path: masterRec.first, at: new Date().toISOString() }] : undefined,
    }, saved.stem, { comp: compName, tool: card.tool, source: this.sourceRecord(src), ...record });
    await this.setHostStatus(card, 'done');
  }

  /**
   * What follows a pack's run once it is done: a reframe's result comp is upscaled ×2 (a run of its own, queued
   * behind the others), and the last comp of each format is written as a master (rendered by EffectCraft, ProRes
   * 422 HQ, then ffmpeg: ProRes 4444 or a PNG 16-bit sequence), kept with that version.
   */
  private async afterTool(card: Card): Promise<void> {
    const t = card.tool!;
    const v = card.versions.at(-1);
    if (!t.then || !v) return;
    const resultComp = v.compId ?? v.compare?.compId;
    if (t.id === 'reframe' && t.then.upscale && resultComp !== undefined) {
      const upTool = toolById('upscale')!;
      const options = { ...upTool.defaults, scale: 2 };
      const w = v.compare ? DELIVERY[String(t.options.aspect)]?.[0] : undefined;
      const h = v.compare ? DELIVERY[String(t.options.aspect)]?.[1] : undefined;
      const seconds = v.seconds ?? t.plan?.seconds ?? 1;
      const plan = upTool.plan({ kind: 'comp', media: 'video', width: w ?? 1080, height: h ?? 1920, fps: this.snap?.comp?.fps ?? 24, seconds, requested: seconds, name: v.compName ?? 'Comp' }, options, (id) => this.library.get(id)?.manifest);
      if (!plan.ok) throw new Error(`The pack's upscale of "${v.compName}" cannot run: ${plan.reason}`);
      const now = new Date().toISOString();
      let up = this.sidecar.cards.find((c) => c.tool?.id === 'upscale' && c.compId === resultComp && c.tool.source === 'comp' && c.tool.variant === plan.variant);
      if (up && (up.status === 'queued' || up.status === 'running')) return;
      if (!up) {
        up = {
          id: newCardId(), compId: resultComp, origin: { kind: 'comp', range: 'comp', start: 0, end: seconds, width: w, height: h }, prompt: '', workflowId: plan.workflowId,
          seed: null, params: {}, versions: [], activeVersion: null, status: 'idle', createdAt: now, updatedAt: now,
        };
        this.sidecar.cards.push(up);
      } else if (up.origin.kind === 'comp') {
        up.origin.end = seconds;
      }
      up.tool = {
        id: 'upscale', source: 'comp', options, cap: t.cap, variant: plan.variant, compName: v.compName,
        label: resultName(v.compName ?? 'Comp', 'upscale', options, plan),
        plan: { makes: plan.makes, width: plan.output?.width, height: plan.output?.height, seconds: plan.output?.seconds, note: plan.notes[0] },
        group: t.group, then: { masters: t.then.masters },
      };
      up.workflowId = plan.workflowId;
      up.params = { ...plan.params };
      up.resource = card.resource;
      up.updatedAt = now;
      this.enqueue([up.id]);
      return;
    }
    if (t.then.masters && t.then.masters !== 'none' && resultComp !== undefined) await this.writeMaster(card, v, resultComp, t.then.masters);
  }

  /** A version's comp as a delivery master: EffectCraft renders it (ProRes 422 HQ), ffmpeg writes the master next to it. */
  private async writeMaster(card: Card, v: Version, compId: number, kind: 'prores4444' | 'png16'): Promise<void> {
    const host = this.tl();
    this.phase(card, 'Rendering the master');
    await this.ensureComp(compId);
    const comp = this.snap?.comp;
    if (!comp) throw new Error('The comp to write a master of is not open.');
    const stem = `${basename(v.file, extname(v.file))}_master`;
    const r = await host.renderRange({ start: 0, duration: comp.duration, cap: Math.max(comp.duration, card.tool?.cap ?? 8), dir: join(this.mediaDir, card.id), name: `${stem}_prores422hq`, format: 'prores' });
    this.phase(card, kind === 'prores4444' ? 'Writing ProRes 4444' : 'Writing PNG 16-bit');
    const out = kind === 'prores4444' ? join(this.mediaDir, card.id, `${stem}_4444.mov`) : undefined;
    const done = await master({ src: r.path, kind, out });
    if (!done.ok || !done.path) throw new Error(`The master of "${comp.name}" was not written: ${done.reason ?? 'ffmpeg failed'}`);
    v.exports = [...(v.exports ?? []).filter((x) => x.path !== done.path), { kind, path: done.path, at: new Date().toISOString() }];
    card.updatedAt = new Date().toISOString();
  }

  /**
   * The workflow tracks the subject and returns a small mask per frame; the
   * framing is built here, on the original footage, as a new comp with
   * Position keyframes. Nothing in the source comp changes.
   */
  private async reframe(card: Card, entry: LibraryEntry, api: WorkflowJson, seed: number | null, models: ModelCheck, t0: number, src: ClipSource): Promise<void> {
    const host = this.tl();
    const m = entry.manifest;
    const info = src.info;
    const aspectName = String(card.params['@aspect'] ?? '9:16');
    const aspect = ASPECTS[aspectName] ?? ASPECTS['9:16'];
    const smoothing: Smoothing = card.params['@smooth'] === 'steady' || card.params['@smooth'] === 'locked' ? card.params['@smooth'] : 'gentle';

    const { outputs, jobId } = await this.execute(card, api, undefined, this.meta(m, info.duration || null));
    const masks = outputs.filter((o) => o.type === 'output' && /\.png$/i.test(o.filename));
    if (masks.length === 0) throw new Error('The tracking finished without masks.');
    const frames: SubjectFrame[] = new Array(masks.length);
    let read = 0;
    this.phase(card, 'Reading the track', 0, masks.length);
    await inPool(masks, 8, async (o, i) => {
      frames[i] = subjectOf(decodePngGrey(await this.runner().download(o)));
      this.phase(card, 'Reading the track', ++read, masks.length);
    });
    this.throwIfCancelled();
    const fps = info.frameRate || (info.duration ? masks.length / info.duration : 24);
    let plan: ReframePlan;
    try {
      plan = planReframe(frames, { width: info.width, height: info.height, fps }, aspect, smoothing);
    } catch {
      throw new Error(`SAM 3 did not find "${card.prompt}" in this clip. Try a plainer word (person, dog, car) or another subject.`);
    }

    const n = (card.versions.at(-1)?.n ?? 0) + 1;
    const stem = card.tool
      ? `${slugFromPrompt(card.tool.label ?? src.name, 28)}_v${String(n).padStart(3, '0')}`
      : `${slugFromPrompt(card.prompt, 20)}_${aspectName.replace(':', 'x')}_v${String(n).padStart(3, '0')}`;
    writeFileSync(join(this.mediaDir, card.id, `${stem}.track.json`), JSON.stringify({ aspect: aspectName, smoothing, source: info, frames, plan }, null, 1));
    this.phase(card, 'Building the comp');
    const sourceName = src.name;
    const compName = card.tool ? this.toolCompName(card, n) : `${sourceName.replace(/\.[a-z0-9]{2,4}$/i, '')} · ${aspectName} v${String(n).padStart(3, '0')}`;
    const duration = info.duration || masks.length / fps;
    const built = await host.buildReframe({
      name: compName, width: plan.width, height: plan.height, fps, duration, itemId: src.itemId,
      layerName: `${TAG} reframe · ${layerNameFromPrompt(card.prompt, 32)}`, keys: plan.keys,
      comment: `${SLUG} card=${card.id} v${n} · ${m.title} · ${aspectName} · ${smoothing}\n${card.prompt}`,
    });
    // The new comp is open: a frame of it is the version's picture.
    const rel = `${card.id}/${stem}.png`;
    await host.frameAt(duration / 2, join(this.mediaDir, rel)).catch(() => undefined);
    const missed = plan.frames - plan.found;
    this.notice = `Reframed to ${aspectName} in the new comp "${compName}" (${plan.width}×${plan.height}, the clip at 100%): `
      + `${plan.keys.length} Position keyframe${plan.keys.length === 1 ? '' : 's'} follow "${card.prompt}"`
      + (missed ? `; it was not found in ${missed} of ${plan.frames} frames, which hold the nearest framing` : '')
      + '. Edit them like any keyframes; the original comp is unchanged.';
    this.recordVersion(card, m, {
      n, file: rel, kind: 'image', workflowId: m.id, prompt: card.prompt, seed,
      width: plan.width, height: plan.height, seconds: duration, jobId, createdAt: new Date().toISOString(), elapsedMs: Date.now() - t0,
      remaps: models.remaps.map((r) => `${r.wanted} → ${r.using}`), compId: built.compId,
      ...(card.tool ? {
        thumb: rel, compName, source: this.sourceRecord(src),
        // A crop has no generated layer to hide: compare opens the source comp and the result in turn.
        compare: { compId: built.compId, showing: 'result' as const, result: [], original: [], openOriginal: card.compId },
      } : {}),
    }, stem, { comp: compName, aspect: aspectName, smoothing, keys: plan.keys.length, found: plan.found, frames: plan.frames, ...(card.tool ? { tool: card.tool, source: this.sourceRecord(src) } : {}) });
    await this.setHostStatus(card, 'done');
  }

  /**
   * Generative reframe: the clip goes into the model scaled into the new
   * frame with the space around it to fill; the result comes back as a new comp
   * where the generated video fills the frame and the original clip sits on
   * top, untouched, softened only where it meets the new space.
   */
  private async outpaint(card: Card, entry: LibraryEntry, api: WorkflowJson, seed: number | null, t0: number, src: ClipSource): Promise<void> {
    const host = this.tl();
    const m = entry.manifest;
    const o = m.outpaint;
    if (!o) throw new Error(`${m.title} has no outpaint settings in its manifest.`);
    const info = src.info;
    const fps = info.frameRate || this.snap?.comp?.fps || 24;
    const aspectName = String(card.params['@aspect'] ?? '9:16');
    const gen = o.sizes[aspectName] ?? o.sizes['9:16'];
    const delivery = DELIVERY[aspectName] ?? DELIVERY['9:16'];
    const plan = planOutpaint({ width: info.width, height: info.height, fps, frames: (info.duration || 0) * fps }, gen, delivery, o.maxFrames);

    setRef(api, m.bindings.width, plan.gen[0]);
    setRef(api, m.bindings.height, plan.gen[1]);
    setRef(api, m.bindings.fps, fps);
    setRef(api, o.scale[0], plan.scaled[0]);
    setRef(api, o.scale[1], plan.scaled[1]);
    // The model is shown the clip less a margin where it meets new space, so the model's own edge (a bright
    // line on the 21:9 draft of 25 Oct) lies under the original in the comp. A manifest without the crop shows it all.
    const [il, it, ir, ib] = o.crop ? plan.inset : [0, 0, 0, 0];
    if (o.crop) {
      setRef(api, o.crop.x, il);
      setRef(api, o.crop.y, it);
      setRef(api, o.crop.width, plan.scaled[0] - il - ir);
      setRef(api, o.crop.height, plan.scaled[1] - it - ib);
    }
    const pad = (o.crop ? plan.pad : plan.pad.map((v, i) => v - plan.inset[i])) as [number, number, number, number];
    o.pad.forEach((ref, i) => setRef(api, ref, pad[i]));

    this.phase(card, 'Uploading');
    const sourcePath = src.path;
    setRef(api, m.bindings.video, await this.runner().uploadFile(sourcePath, () => readFileSync(sourcePath), `flow_${card.id}${extname(sourcePath)}`, videoMime(sourcePath)));
    const models = this.checkModels(api, m);

    // One run per segment; each later run carries on from the frames the one before made.
    const parts: Array<{ bytes: Uint8Array; filename: string; jobId: string; uploaded: unknown; skip: number; take: number }> = [];
    const count = plan.segments.length;
    for (const [i, seg] of plan.segments.entries()) {
      const g = structuredClone(api);
      setRef(g, m.bindings.frames, seg.frames);
      setRef(g, o.start, seg.start);
      setRef(g, o.take, seg.take);
      if (i > 0) {
        const before = plan.segments[i - 1];
        chainGraph(g, { start: o.start, ...o.chain }, {
          previous: parts[i - 1].uploaded, from: before.overlap + before.take - seg.overlap, overlap: seg.overlap, take: seg.take, size: plan.gen,
        });
      }
      const r = await this.runJob(card, g, m, count > 1 ? `Part ${i + 1} of ${count}` : undefined, this.meta(m, seg.frames / fps));
      const uploaded = count > 1 ? await this.runner().upload(r.bytes, `flow_${card.id}_part${i + 1}.mp4`, 'video/mp4') : '';
      parts.push({ ...r, uploaded, skip: seg.overlap, take: seg.take });
    }
    let result: { bytes: Uint8Array; filename: string; jobId: string } = parts[0];
    if (count > 1) {
      const joined = await this.execute(card, joinGraph(parts.map((p) => ({ file: p.uploaded, skip: p.skip, take: p.take })), fps, `${SLUG}/vace_reframe_joined`), 'Joining the parts', this.meta(m, plan.seconds, ':join'));
      const out = joined.outputs.filter((f) => f.type === 'output' && /\.(mp4|mov|webm|mkv)$/i.test(f.filename)).pop();
      if (!out) throw new Error('Joining the parts finished without a video.');
      result = { bytes: await this.runner().download(out), filename: out.filename, jobId: joined.jobId };
    }
    const { n, rel, abs, stem } = this.saveVersion(card, m, result, card.tool ? slugFromPrompt(card.tool.label ?? src.name, 28) : undefined);

    // The model's colours drift a little from the clip's (measured on 28 Oct: brighter and more contrasted), and the
    // step shows where the clip's soft edge meets the new space: the generated frame is matched to the clip, which it
    // surrounds untouched. The model's own file stays beside it.
    this.phase(card, 'Matching colours');
    const asGenerated = abs.replace(/(\.[a-z0-9]+)$/i, '_as-generated$1');
    renameSync(abs, asGenerated);
    let colour: ColourFit | null = null;
    try {
      const inset: [number, number, number, number] = [il, it, ir, ib];
      colour = await matchReframeColour(asGenerated, sourcePath, { gen: plan.gen, scaled: plan.scaled, inset, pad }, abs);
    } finally {
      if (!existsSync(abs)) renameSync(asGenerated, abs);
    }

    this.phase(card, 'Building the comp');
    const sourceName = src.name;
    const compName = card.tool ? this.toolCompName(card, n) : `${sourceName.replace(/\.[a-z0-9]{2,4}$/i, '')} · ${aspectName} v${String(n).padStart(3, '0')}`;
    const comment = `${SLUG} card=${card.id} v${n} · ${m.title} · ${aspectName}${seed !== null ? ` · seed ${seed}` : ''}\n${card.prompt}`;
    const built = await host.buildOutpaint({
      name: compName, width: plan.delivery[0], height: plan.delivery[1], fps, duration: plan.seconds,
      file: abs, fillScale: plan.bgScale, fillName: `${TAG} reframe · ${layerNameFromPrompt(card.prompt, 32)}`,
      itemId: src.itemId, clipName: sourceName, clipScale: plan.clipScale, clipCentre: plan.clipCentre,
      mask: plan.mask, feather: plan.feather, comment,
    });
    const thumb = card.tool ? await this.resultThumb(card, stem, plan.seconds / 2) : undefined;
    this.notice = `Reframed to ${aspectName} in the new comp "${compName}": the space ${plan.pad[0] + plan.pad[2] > plan.pad[1] + plan.pad[3] ? 'left and right' : 'above and below'} `
      + `is generated, your clip sits on top of it untouched.`
      + (count > 1 ? ` The clip went through in ${count} runs, each carrying on from the last.` : '')
      + (plan.cut ? ` The comp covers the clip's first ${plan.seconds.toFixed(1)} s (${count} runs is the most one card makes).` : '');
    this.recordVersion(card, m, {
      n, file: rel, kind: 'video', workflowId: m.id, prompt: card.prompt, seed,
      width: plan.gen[0], height: plan.gen[1], seconds: plan.seconds, jobId: result.jobId, createdAt: new Date().toISOString(),
      elapsedMs: Date.now() - t0, remaps: models.remaps.map((r) => `${r.wanted} → ${r.using}`), compId: built.compId,
      itemId: built.fillItem,
      ...(card.tool ? {
        thumb, compName, source: this.sourceRecord(src),
        // Original: the clip alone in the new frame (the generated layer hidden); result: both.
        compare: { compId: built.compId, showing: 'result' as const, result: [[built.fillLayer, true]] as Array<[number, boolean]>, original: [[built.fillLayer, false]] as Array<[number, boolean]> },
      } : {}),
    }, stem, {
      comp: compName, aspect: aspectName, plan,
      colour: colour ? { ...colour, file: colour.applied ? basename(abs) : null, asGenerated: colour.applied ? basename(asGenerated) : null } : null,
      ...(card.tool ? { tool: card.tool, source: this.sourceRecord(src), delivery: plan.delivery } : {}),
    });
    await this.setHostStatus(card, 'done');
  }

  /**
   * Upscale into a new comp at the target size: the upscaled clip on top, the
   * original under it at the matching scale, switched off — never deleted. ×4 is
   * two ×2 passes, the second fed with the first's result (uploaded, as a
   * reframe's next run is fed with the one before).
   */
  private async upscaleToComp(card: Card, entry: LibraryEntry, api: WorkflowJson, seed: number | null, models: ModelCheck, t0: number, src: ClipSource): Promise<void> {
    const host = this.tl();
    const m = entry.manifest;
    const scale = Number(card.tool?.options.scale) === 4 ? 4 : 2;
    const seconds = src.info.duration || null;
    let result = await this.runJob(card, api, m, scale === 4 ? 'Pass 1 of 2' : undefined, this.meta(m, seconds));
    if (scale === 4) {
      this.phase(card, 'Pass 2 of 2 · Uploading');
      const first = await this.runner().upload(result.bytes, `flow_${card.id}_pass1.mp4`, 'video/mp4');
      const g = structuredClone(api);
      setRef(g, m.bindings.video, first);
      result = await this.runJob(card, g, m, 'Pass 2 of 2', this.meta(m, seconds, ':pass2'));
    }
    const { n, rel, abs, stem } = this.saveVersion(card, m, result, slugFromPrompt(card.tool?.label ?? src.name, 28));

    this.phase(card, 'Building the comp');
    const upItem = await host.importFile(abs);
    const up = await host.itemInfo(upItem);
    const width = up?.width || src.info.width * scale;
    const height = up?.height || src.info.height * scale;
    const fps = src.info.frameRate || up?.frameRate || this.snap?.comp?.fps || 24;
    const duration = up?.duration || src.info.duration || 1;
    const compName = this.toolCompName(card, n);
    const comment = `${SLUG} card=${card.id} v${n} · ${m.title} · ×${scale}${seed !== null ? ` · seed ${seed}` : ''}`;
    const built = await host.buildComp({
      name: compName, width, height, fps, duration,
      layers: [
        { itemId: upItem, name: `${TAG} ×${scale} · ${src.name}`, comment },
        { itemId: src.itemId, name: `${src.name} (original)`, scale: Math.round((width / src.info.width) * 100000) / 1000, visible: false },
      ],
    });
    const [upLayer, original] = built.layers;
    const thumb = await this.resultThumb(card, stem, duration / 2);
    this.notice = `Upscaled ×${scale} into the new comp "${compName}" (${width}×${height}); your original is in it too, switched off.`;
    this.recordVersion(card, m, {
      n, file: rel, kind: 'video', workflowId: m.id, prompt: card.prompt, seed, width, height, seconds: duration,
      jobId: result.jobId, createdAt: new Date().toISOString(), elapsedMs: Date.now() - t0,
      remaps: models.remaps.map((r) => `${r.wanted} → ${r.using}`), compId: built.compId, itemId: upItem,
      thumb, compName, source: this.sourceRecord(src),
      compare: { compId: built.compId, showing: 'result', result: [[upLayer, true], [original, false]], original: [[upLayer, false], [original, true]] },
    }, stem, { comp: compName, scale, passes: scale === 4 ? 2 : 1, tool: card.tool, source: this.sourceRecord(src) });
    await this.setHostStatus(card, 'done');
  }

  /**
   * A subject matte from the Comp tab. From a layer: above it in its comp, as its
   * luma track matte (the panel's cut-out). From a render of the comp: a new comp
   * holding the render with the matte as its luma track matte.
   */
  private async matteTool(card: Card, entry: LibraryEntry, api: WorkflowJson, seed: number | null, models: ModelCheck, t0: number, src: ClipSource): Promise<void> {
    const m = entry.manifest;
    const result = await this.runJob(card, api, m, undefined, this.meta(m, src.info.duration || null));
    const saved = this.saveVersion(card, m, result, slugFromPrompt(card.tool?.label ?? src.name, 28));
    await this.placeMatte(card, m, saved, src, {
      jobId: result.jobId, seed, t0, remaps: models.remaps.map((r) => `${r.wanted} → ${r.using}`), subject: card.prompt, extra: {},
    });
  }

  /**
   * A matte file (SAM 3's, or LTX Alpha Gen's) into the comp. From a layer: above it, as its luma track matte (a new
   * version replaces the matte's footage). From a render of the comp: a new comp holding the render with the matte as
   * its luma track matte.
   */
  private async placeMatte(card: Card, m: WorkflowManifest, saved: { n: number; rel: string; abs: string; stem: string }, src: ClipSource,
    ctx: { jobId: string; seed: number | null; t0: number; remaps: string[]; subject: string; extra: Record<string, unknown>; by?: string }): Promise<void> {
    const host = this.tl();
    const { n, rel, abs, stem } = saved;
    const what = ctx.subject || 'the foreground';
    const comment = `${SLUG} card=${card.id} v${n} · ${m.title}
${ctx.subject}`;
    const fps = src.info.frameRate || this.snap?.comp?.fps || 24;
    const duration = src.info.duration || 1;
    let compare: CompareState;
    let compName: string;
    let compId: number | undefined;
    let itemId: number | undefined;
    let thumb: string | undefined;
    if (src.kind === 'layer' && src.layer) {
      this.phase(card, 'Placing in EffectCraft');
      await this.ensureComp(card.compId);
      const layer = this.snap?.layers.find((l) => l.id === src.layer!.id) ?? src.layer;
      let matteLayer: number;
      if (card.placed) {
        // A new version replaces the matte's footage; the layer, its place and its role stay.
        await host.replaceFootage(card.placed.itemId, abs, [card.placed.layerId]);
        matteLayer = card.placed.layerId;
      } else {
        const placed = await host.place({
          file: abs, time: layer.in, endTime: layer.out, sourceStart: layer.start,
          name: `${TAG} matte · ${layerNameFromPrompt(what, 40)}`, comment, index: layer.index,
        });
        card.placed = placed;
        await host.matchLayer(placed.layerId, placed.itemId, layer.id, src.itemId).catch(() => undefined);
        matteLayer = placed.layerId;
      }
      card.placedVersion = n;
      await host.setTrackMatte(layer.id, matteLayer, 'luma');
      compName = this.snap?.comp?.name ?? 'the comp';
      compare = { compId: card.compId, showing: 'result', result: [], original: [], matte: { layer: layer.id, matte: matteLayer } };
      thumb = await this.resultThumb(card, stem, layer.in + (layer.out - layer.in) / 2);
    } else {
      this.phase(card, 'Building the comp');
      itemId = await host.importFile(abs);
      compName = this.toolCompName(card, n);
      const built = await host.buildComp({
        name: compName, width: src.info.width, height: src.info.height, fps, duration,
        layers: [
          { itemId, name: `${TAG} matte · ${layerNameFromPrompt(what, 40)}`, comment },
          { itemId: src.itemId, name: src.name },
        ],
      });
      const [matteLayer, clip] = built.layers;
      await host.setTrackMatte(clip, matteLayer, 'luma');
      compId = built.compId;
      compare = { compId: built.compId, showing: 'result', result: [], original: [], matte: { layer: clip, matte: matteLayer } };
      thumb = await this.resultThumb(card, stem, duration / 2);
    }
    const by = ctx.by ? ` (${ctx.by})` : '';
    this.notice = src.kind === 'layer'
      ? `Cut out ${ctx.subject ? `"${ctx.subject}"` : 'the foreground'}${by}: the matte is above "${src.name}" as its luma track matte. "Export with alpha" writes a ProRes 4444 master.`
      : `Cut out ${ctx.subject ? `"${ctx.subject}"` : 'the foreground'}${by} in the new comp "${compName}". "Export with alpha" writes a ProRes 4444 master.`;
    this.recordVersion(card, m, {
      n, file: rel, kind: 'video', workflowId: m.id, prompt: card.prompt, seed: ctx.seed, width: src.info.width, height: src.info.height, seconds: duration,
      jobId: ctx.jobId, createdAt: new Date().toISOString(), elapsedMs: Date.now() - ctx.t0,
      remaps: ctx.remaps, compId, itemId, thumb, compName, source: this.sourceRecord(src), compare,
    }, stem, { comp: compName, tool: card.tool, source: this.sourceRecord(src), ...ctx.extra });
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
      setRef(api, m.bindings.image, await this.runner().upload(readFileSync(abs), `flow_${card.id}.png`, 'image/png'));
    }
    const models = this.checkModels(api, m);

    const result = await this.runJob(card, api, m);
    const { n, rel, abs, stem } = this.saveVersion(card, m, result);

    this.phase(card, 'Placing in PhotoCraft');
    const name = `${TAG} · ${layerNameFromPrompt(card.prompt || m.title, 40)} v${n}`;
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
      n, file: rel, kind: m.output === 'video' ? 'video' : 'image', workflowId: m.id, prompt: card.prompt, seed,
      width: size?.width, height: size?.height, jobId: result.jobId, createdAt: new Date().toISOString(), elapsedMs: Date.now() - t0,
      remaps: models.remaps.map((r) => `${r.wanted} → ${r.using}`), layerId,
    }, stem, { document: doc.name, box: liveBox });
    await this.setHostStatus(card, 'done');
  }
}

/**
 * EffectCraft 0.11.1 decodes 8-bit H.264 only (measured: "H.264 (High 10) isn't supported
 * by the built-in decoder"). A template that carries its input's bit depth over — SeedVR2's
 * CreateVideo takes it from GetVideoComponents — makes a 10-bit file of a 10-bit source, such
 * as the Comp tab's ProRes renders; for EffectCraft it is set to 8 (CreateVideo offers auto, 8, 10).
 */
function eightBitVideo(api: WorkflowJson): void {
  for (const node of Object.values(api)) {
    if (node.class_type === 'CreateVideo' && Array.isArray(node.inputs.bit_depth)) node.inputs.bit_depth = 8;
  }
}

/**
 * LTX-2.5's length is seconds × fps + 1 (a ComfyMathExpression fed by the seconds and fps primitives). Extend needs
 * an exact 8k + 1 count at any frame rate, so that expression is set to the number itself. False when it is not there.
 */
function setLtxLength(api: WorkflowJson, m: WorkflowManifest, frames: number): boolean {
  if (!m.bindings.seconds || !m.bindings.fps) return false;
  const sec = splitRef(m.bindings.seconds).nodeId;
  const fps = splitRef(m.bindings.fps).nodeId;
  const link = (v: unknown, id: string): boolean => Array.isArray(v) && v[0] === id;
  for (const node of Object.values(api)) {
    if (node.class_type === 'ComfyMathExpression' && link(node.inputs['values.a'], sec) && link(node.inputs['values.b'], fps)) {
      node.inputs.expression = String(frames);
      return true;
    }
  }
  return false;
}

/**
 * One frame of a clip, at `seconds`, as a PNG (ffmpeg on the PATH); false when ffmpeg is not there or fails.
 *
 * A clip's length as EffectCraft reports it is the container's, which the sound can make longer than the video (an
 * LTX-2.5 clip: 121 frames, 5.04 s of video in 5.08 s): a seek past the last frame gives ffmpeg nothing to write. So a
 * seek that writes nothing steps back, a quarter of a second at a time, up to a second.
 */
export async function frameOf(src: string, seconds: number, out: string): Promise<boolean> {
  for (const back of [0, 0.25, 0.5, 1]) {
    if (back > 0 && seconds - back < 0) break;
    const ok = await new Promise<boolean>((done) => {
      rmSync(out, { force: true });
      const p = spawn('ffmpeg', ['-v', 'error', '-y', '-ss', (seconds - back).toFixed(4), '-i', src, '-frames:v', '1', out], { windowsHide: true });
      p.on('error', () => done(false));
      p.on('close', (code) => done(code === 0 && existsSync(out)));
    });
    if (ok) return true;
  }
  return false;
}

/**
 * Frames first…last (by number, from 0) of a clip as a ProRes 422 HQ .mov at the clip's own rate, no sound — the
 * guide Extend uploads. False when ffmpeg is not there or fails.
 */
function framesOf(src: string, first: number, last: number, out: string): Promise<boolean> {
  return ffmpegOk(['-v', 'error', '-y', '-i', src, '-vf', `select='between(n\\,${first}\\,${last})',setpts=N/FRAME_RATE/TB`, '-an',
    '-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le', out], out);
}

/** A folder of numbered PNGs (000.png, 001.png…) as one ProRes 422 HQ .mov at `fps`. */
function sequenceToClip(dir: string, fps: number, out: string): Promise<boolean> {
  return ffmpegOk(['-v', 'error', '-y', '-framerate', String(fps), '-i', join(dir, '%03d.png'), '-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le', out], out);
}

function ffmpegOk(args: string[], out: string): Promise<boolean> {
  return new Promise((done) => {
    const p = spawn('ffmpeg', args, { windowsHide: true });
    p.on('error', () => done(false));
    p.on('close', (code) => done(code === 0 && existsSync(out)));
  });
}

/** How many video frames a file has (ffprobe, decoding them all); null when ffprobe is not there or fails. */
/**
 * The last frame number to take from a clip: `wanted` (from the host's out point), or the clip's own last frame when
 * its video stream is shorter than its container says (the sound runs on). Unchanged when ffprobe cannot count.
 */
export async function lastVideoFrame(file: string, wanted: number): Promise<number> {
  const n = await countFrames(file);
  return n !== null && n > 0 && wanted > n - 1 ? n - 1 : wanted;
}

function countFrames(file: string): Promise<number | null> {
  return new Promise((done) => {
    let text = '';
    const p = spawn('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file], { windowsHide: true });
    p.stdout.on('data', (d: Buffer) => { text += d.toString(); });
    p.on('error', () => done(null));
    p.on('close', (code) => { const n = parseInt(text.trim(), 10); done(code === 0 && Number.isFinite(n) ? n : null); });
  });
}

/**
 * What "Describe the clip" asks Qwen3-VL. "end" (Extend): where the shot is going, so the user can write what happens
 * next; "whole" (a reframe's Scene): the whole scene, with what lies at the edges of the frame.
 */
function describeInstruction(focus: 'end' | 'whole', frames: number): string {
  const intro = frames > 1 ? `These are ${frames} frames of one video shot, in order${focus === 'end' ? ', from its last seconds' : ''}.` : 'This is a frame of one video shot.';
  return focus === 'end'
    ? `${intro} Describe the shot in one paragraph for a video generation prompt: the setting and the light, the main subject, what is moving, in which direction and how fast, and what the camera does. Present tense, plain and concrete, no lists, no guesses about what happens later, at most 80 words.`
    : `${intro} Describe the whole scene in one paragraph for a video generation prompt: the setting, what surrounds the subject towards the edges of the frame (sky, ground, water, walls), the light and the colours, the subject and how it moves, and the camera. Present tense, plain and concrete, no lists, at most 80 words.`;
}

/** The model's answer as prompt text: no reasoning block, no markdown, one paragraph. */
export function cleanDescription(raw: string): string {
  return raw.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^\s*(description|prompt)\s*:\s*/i, '').replace(/[*#`]/g, '').replace(/\s+/g, ' ').trim();
}

/** A 480-px wide JPEG of a still; false when ffmpeg is not there or fails. */
function smallJpeg(src: string, out: string): Promise<boolean> {
  return new Promise((done) => {
    const p = spawn('ffmpeg', ['-v', 'error', '-y', '-i', src, '-vf', 'scale=480:-2', '-q:v', '4', out], { windowsHide: true });
    p.on('error', () => done(false));
    p.on('close', (code) => done(code === 0 && existsSync(out)));
  });
}

/** The type a clip goes up as: the Comp tab's renders are ProRes .mov. */
function videoMime(path: string): string {
  return /\.mov$/i.test(path) ? 'video/quicktime' : /\.webm$/i.test(path) ? 'video/webm' : /\.mkv$/i.test(path) ? 'video/x-matroska' : 'video/mp4';
}

/** Seconds as the Comp tab names spans: "1.0", "12.5". */
function secs(v: number): string {
  return (Math.round(v * 10) / 10).toFixed(1);
}

/** The work-area render cap, seconds: the Flow window's setting (1–60, default 8). */
export function renderCap(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(60, Math.max(1, n)) : 8;
}

async function inPool<T>(items: T[], size: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
}

/** What a node is doing, in words a card can show. */
function friendlyPhase(classType: string): string {
  if (/SAM3_VideoTrack|SAM3_Detect/i.test(classType)) return 'Tracking the subject';
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
