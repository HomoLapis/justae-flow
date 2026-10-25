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

export interface CompToolInfo { id: string; name: string; promise: string; icon: string; sources: SourceKind[]; defaults: ToolOptions }

export interface RunVersion {
  n: number;
  compId?: number;
  compName?: string;
  createdAt: string;
  elapsedMs: number;
  executionMs: number | null;
  derivedCredits: number | null;
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
  status: 'idle' | 'queued' | 'running' | 'done' | 'error' | 'canceled';
  error?: string;
  progress?: { value: number; max: number; phase: string; startedAt: number };
  runsOn: { id: string; kind: string; label: string; why: string; metered: boolean } | null;
  compId: number;
  activeVersion: number | null;
  versions: RunVersion[];
  updatedAt: string;
}

export interface CompState {
  host: { ok: boolean; app: string; error?: string; kind: 'timeline' | 'canvas' };
  comp: { id: number; name: string; width: number; height: number; fps: number; duration: number; workArea?: [number, number]; workAreaSet: boolean } | null;
  time: number;
  selected: { layerId: number; name: string; media: 'video' | 'image' | 'none'; width: number; height: number; fps: number; seconds: number; path: string | null } | null;
  resultOf: { cardId: string; compId: number; compName: string | null } | null;
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
  output?: { width: number; height: number; seconds: number };
  notes: string[];
  warnings: string[];
  action: string;
  prompt?: { label: string; placeholder: string };
  variant: string;
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
  drafts: Record<string, ToolDraft>;
  /** The result the Tab key compares. */
  focusRun: string | null;
  load: () => Promise<void>;
  setOpenTool: (id: string | null) => void;
  setSource: (s: SourceKind | null) => void;
  setDraft: (tool: string, patch: Partial<ToolDraft>) => void;
  setFocusRun: (id: string | null) => void;
}

const saved = lsGet<{ openTool?: string | null; drafts?: Record<string, ToolDraft> }>('comp', {});

export const useComp = create<CompStore>((set, get) => ({
  state: null,
  error: null,
  openTool: saved.openTool ?? 'reframe',
  source: null,
  drafts: saved.drafts ?? {},
  focusRun: null,
  load: async () => {
    try {
      set({ state: await serverJson<CompState>('/api/comp'), error: null });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },
  setOpenTool: (openTool) => { set({ openTool }); lsSet('comp', { openTool, drafts: get().drafts }); },
  setSource: (source) => set({ source }),
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
export function effectiveSource(s: CompState | null, pick: SourceKind | null): SourceKind {
  if (pick === 'layer' && s?.selected) return 'layer';
  if (pick === 'workArea' || pick === 'comp') return pick;
  return s?.comp?.workAreaSet ? 'workArea' : 'comp';
}

export const compApi = {
  plan: (q: { tool: string; source: SourceKind; options: ToolOptions; cap: number }) => serverJson<ToolPlan>('/api/comp/plan', q),
  frame: (force = false) => serverJson<{ file: string; time: number; compId: number; rev: number }>('/api/comp/frame', { force }),
  run: (q: { tool: string; source: SourceKind; options: ToolOptions; cap: number; prompt: string; resource: string | null; seed: number | null }) =>
    serverJson<{ id: string; queued: number }>('/api/comp/run', q),
  compare: (id: string, n?: number) => serverJson<{ showing: 'result' | 'original' }>('/api/comp/compare', { id, n }),
  open: (id: string, n?: number, which: 'result' | 'source' = 'result') => serverJson<{ ok: true }>('/api/comp/open', { id, n, which }),
  exportAlpha: (id: string, n?: number) => serverJson<{ path: string }>('/api/comp/export-alpha', { id, n }),
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
