/**
 * The Comp tab's data: the active comp as the JustAE Flow server reads it from
 * EffectCraft (GET /api/comp), what a tool would make (POST /api/comp/plan),
 * and the runs — all the server's, polled while the tab is open. The page keeps
 * only its own choices (open card, source, each tool's settings and resource
 * pick), in local storage.
 */

import { create } from 'zustand';
import { serverJson } from '../bridge/server';
import { lsGet, lsSet } from '../state/persistence';

export type SourceKind = 'workArea' | 'comp' | 'layer';
export type ToolOptions = Record<string, string | number | boolean>;

export interface CompToolInfo {
  id: string; name: string; promise: string; icon: string; sources: SourceKind[]; defaults: ToolOptions;
  /** 'ltx': listed under "LTX finishing". */
  family?: 'ltx';
  /** The licence line the card carries (LTX-2.x), with its link. */
  licence?: { line: string; url: string };
  /** Listed, cannot run: why (to be verified). */
  unavailable?: string;
  /** IC-LoRA files the local ComfyUI lacks, with their (gated) Hugging Face page. */
  missing?: Array<{ what: string; file: string; url: string }>;
}

export interface RunVersion {
  n: number;
  compId?: number;
  compName?: string;
  createdAt: string;
  elapsedMs: number;
  executionMs: number | null;
  derivedCredits: number | null;
  /** The hourly billing report's figure for its jobs, once the report has their hours, and its as_of. */
  billedCredits: number | null;
  billedAsOf: string | null;
  /** What derivedCredits counts, in words (a deployment: the worker's start-up and idle window too). */
  costBasis: string | null;
  resource?: string;
  width?: number;
  height?: number;
  seconds?: number;
  exports?: Array<{ kind: string; path: string; at: string }>;
  file: string;
  thumb: string | null;
  showing: 'result' | 'original' | null;
  canExport: boolean;
}

export interface CompRun {
  id: string;
  tool: string;
  source: SourceKind;
  options: ToolOptions;
  prompt: string;
  label: string;
  variant?: string;
  workflowId?: string;
  status: 'idle' | 'queued' | 'running' | 'done' | 'error' | 'canceled';
  error?: string;
  progress?: { value: number; max: number; phase: string; startedAt: number };
  runsOn: { id: string; kind: string; label: string; why: string; metered: boolean } | null;
  compId: number;
  activeVersion: number | null;
  versions: RunVersion[];
  /** A run of a pack (the Social pack). */
  group?: { id: string; label: string; at: string };
  updatedAt: string;
}

export interface LayerSource { layerId: number; name: string; media: 'video' | 'image' | 'none'; width: number; height: number; fps: number; seconds: number; path: string | null; in: number; out: number }

export interface CompState {
  host: { ok: boolean; app: string; error?: string; kind: 'timeline' | 'canvas' };
  comp: { id: number; name: string; width: number; height: number; fps: number; duration: number; workArea?: [number, number]; workAreaSet: boolean } | null;
  time: number;
  /** What EffectCraft has selected now (it selects every result it places). */
  selected: LayerSource | null;
  /** The layer this tab picked as its source, if it is in the open comp. */
  picked: LayerSource | null;
  resultOf: { cardId: string; compId: number; compName: string | null } | null;
  /** "Describe the clip" (Qwen3-VL on the local ComfyUI): offered only when its model file is there. */
  describe?: { available: boolean; model?: string; reason?: string };
  tools: CompToolInfo[];
  runs: CompRun[];
  queue: { running: string | null; pending: string[] };
  mediaDir: string;
}

export interface ToolPlan {
  ok: boolean;
  reason?: string;
  workflowId: string;
  jobs: Array<{ workflowId: string; seconds: number | null }>;
  makes: string;
  output?: { width: number; height: number; seconds: number; fps?: number };
  notes: string[];
  warnings: string[];
  action: string;
  /** optional: an empty field runs with `fallback` (the LTX "Look"). */
  prompt?: { label: string; placeholder: string; optional?: boolean; fallback?: string; lint?: string };
  /** Free-text choices beside the prompt, kept in the options. */
  fields?: Array<{ key: string; label: string; placeholder: string; advanced?: boolean }>;
  /** LTX finishing: the time on this machine, from the tile count and measured runs. */
  estimate?: { seconds: number; line: string };
  variant: string;
  /** Choices that come from the workflow itself (a node's own options). */
  choices?: Record<string, string[]>;
  /** A pack: the runs it queues, in order. */
  members?: Array<{ tool: string; options: ToolOptions; plan: Omit<ToolPlan, 'source' | 'cap'> }>;
  /** Extend: the source's last frames that guide the model (absent: it starts from one frame). */
  motion?: { frames: number; seconds: number };
  params?: ToolOptions;
  source: { kind: SourceKind; media: string; width: number; height: number; fps: number; seconds: number; requested: number; name: string };
  cap: number;
}

/** What the page remembers about one tool card. */
export interface ToolDraft {
  options: ToolOptions;
  prompt: string;
  /** 'default' (the task's row in Settings ▸ Resources) or a resource id, for this tool's runs. */
  resource: string;
  /** null: a new random seed each run. */
  seed: number | null;
}

interface CompStore {
  state: CompState | null;
  error: string | null;
  /** The tool card that is open (one at a time). */
  openTool: string | null;
  /** The source picked by hand; null = the default (the work area when one is set, else the whole comp). */
  source: SourceKind | null;
  /**
   * The layer behind "Layer", fixed when it is picked: EffectCraft selects the result of every run, and the
   * source must not follow it there. A new selection is offered, never taken.
   */
  layerPick: { compId: number; layerId: number; name: string } | null;
  drafts: Record<string, ToolDraft>;
  /** The result the Tab key compares. */
  focusRun: string | null;
  load: () => Promise<void>;
  setOpenTool: (id: string | null) => void;
  setSource: (s: SourceKind | null) => void;
  /** Pick the layer EffectCraft has selected now as the source. */
  pickLayer: (l: { compId: number; layerId: number; name: string }) => void;
  setDraft: (tool: string, patch: Partial<ToolDraft>) => void;
  setFocusRun: (id: string | null) => void;
}

const saved = lsGet<{ openTool?: string | null; drafts?: Record<string, ToolDraft> }>('comp', {});

export const useComp = create<CompStore>((set, get) => ({
  state: null,
  error: null,
  openTool: saved.openTool ?? 'reframe',
  source: null,
  layerPick: null,
  drafts: saved.drafts ?? {},
  focusRun: null,
  load: async () => {
    try {
      const pick = get().layerPick;
      set({ state: await serverJson<CompState>(`/api/comp${pick ? `?layer=${pick.layerId}` : ''}`), error: null });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },
  setOpenTool: (openTool) => { set({ openTool }); lsSet('comp', { openTool, drafts: get().drafts }); },
  setSource: (source) => set({ source }),
  pickLayer: (layerPick) => { set({ layerPick, source: 'layer' }); void get().load(); },
  setDraft: (tool, patch) => {
    const drafts = { ...get().drafts, [tool]: { ...draftOf(get().drafts, tool, get().state?.tools.find((t) => t.id === tool)?.defaults ?? {}), ...patch } };
    set({ drafts });
    lsSet('comp', { openTool: get().openTool, drafts });
  },
  setFocusRun: (focusRun) => set({ focusRun }),
}));

export function draftOf(drafts: Record<string, ToolDraft>, tool: string, defaults: ToolOptions): ToolDraft {
  const d = drafts[tool];
  return { options: { ...defaults, ...(d?.options ?? {}) }, prompt: d?.prompt ?? '', resource: d?.resource ?? 'default', seed: d?.seed ?? null };
}

/** The source a run uses now: the hand pick if it still applies, else the work area when set, else the whole comp. */
export function effectiveSource(s: CompState | null, pick: SourceKind | null, layerPick?: { compId: number; layerId: number } | null): SourceKind {
  if (pick === 'layer' && pickedLayer(s, layerPick ?? null)) return 'layer';
  if (pick === 'workArea' || pick === 'comp') return pick;
  return s?.comp?.workAreaSet ? 'workArea' : 'comp';
}

/** The picked layer, when it is in the open comp (the server says, from the project). */
export function pickedLayer(s: CompState | null, layerPick: { compId: number; layerId: number } | null): LayerSource | null {
  if (!s?.comp || !layerPick || layerPick.compId !== s.comp.id) return null;
  return s.picked && s.picked.layerId === layerPick.layerId ? s.picked : null;
}

export const compApi = {
  plan: (q: { tool: string; source: SourceKind; layerId?: number; options: ToolOptions; cap: number; prompt?: string; resource?: string | null }) => serverJson<ToolPlan>('/api/comp/plan', q),
  frame: (force = false) => serverJson<{ file: string; time: number; compId: number; rev: number }>('/api/comp/frame', { force }),
  run: (q: { tool: string; source: SourceKind; layerId?: number; options: ToolOptions; cap: number; prompt: string; resource: string | null; seed: number | null }) =>
    serverJson<{ id: string; queued: number }>('/api/comp/run', q),
  compare: (id: string, n?: number) => serverJson<{ showing: 'result' | 'original' }>('/api/comp/compare', { id, n }),
  open: (id: string, n?: number, which: 'result' | 'source' = 'result') => serverJson<{ ok: true }>('/api/comp/open', { id, n, which }),
  exportAlpha: (id: string, n?: number) => serverJson<{ path: string }>('/api/comp/export-alpha', { id, n }),
  describe: (q: { source: SourceKind; layerId?: number; focus: 'end' | 'whole'; cap: number }) =>
    serverJson<{ text: string; model: string; frames: number; times: number[]; executionMs: number | null; file: string }>('/api/comp/describe', q),
  cancel: (id: string) => serverJson<{ ok: true }>('/api/cancel', { id }),
  retry: (id: string) => serverJson<{ queued: number }>('/api/generate', { ids: [id] }),
  version: (id: string, n: number) => serverJson<{ ok: true }>(`/api/cards/${id}/version`, { n }),
  remove: async (id: string): Promise<void> => {
    const r = await fetch(`/api/cards/${id}`, { method: 'DELETE' });
    if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`);
  },
  reveal: (path: string) => serverJson<{ result: boolean }>('/api/fs/reveal', { path }),
};

/** A file of the engine's media folder, as an <img> can load it. */
export function mediaUrl(rel: string, rev?: number | string): string {
  return `/api/media/${rel.split('/').map(encodeURIComponent).join('/')}${rev !== undefined ? `?rev=${rev}` : ''}`;
}

export function seconds(v: number): string {
  return `${(Math.round(v * 10) / 10).toFixed(1)} s`;
}

/** "3:48" / "42 s" */
export function clockTime(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
