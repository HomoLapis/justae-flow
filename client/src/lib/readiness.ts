/**
 * What is ready, as the JustAE Flow server states it (GET /api/readiness, server/readiness.ts): each Featured
 * workflow on the resource the Generate button would use, the files the local ComfyUI lacks with their sizes, the
 * Get started card's rules — and the model downloads (server/models.ts).
 */

import { create } from 'zustand';
import { serverHeaders, serverJson } from '../bridge/server';

export type ReadyStatus = 'ready' | 'missing-models' | 'missing-nodes' | 'not-on-this-resource' | 'unknown';
export type ResourceKind = 'local' | 'cloud' | 'deployment' | 'proxy';

export interface ReadinessFile {
  key: string;
  name: string;
  directory: string;
  repo: string;
  url: string;
  pageUrl: string;
  size: number | null;
  sha256: boolean;
  gated: boolean | null;
  state: 'present' | 'variant' | 'missing' | 'unknown';
  basis: 'comfyui' | 'folder' | null;
  using?: string;
  onDisk?: boolean;
  partial?: number;
  draftOnly?: boolean;
  /** An alternative some users want ("for GPUs with 32 GB or more"): listed and downloadable, never counted as missing. */
  optional?: string;
}

export interface SuggestionPart { ids: string[]; label: string; files: number; bytes: number; unknownSizes: number; gated: boolean | null }

export interface ReadinessPack { id: string; name: string; repo: string; classes: string[]; installed: boolean | null }

export interface FinalTier { id: 'seedvr2' | 'ltx'; label: string; then: string; scale: number; note: string }

export interface ReadinessEntry {
  id: string;
  name: string;
  line: string;
  group: 'generate' | 'edit';
  title: string;
  status: ReadyStatus;
  chip: string;
  note?: string;
  on: { id: string; label: string; kind: ResourceKind } | null;
  local: { status: ReadyStatus; chip: string; note?: string };
  files: ReadinessFile[];
  missing: { count: number; bytes: number; unknownSizes: number };
  packs: ReadinessPack[];
  licence: { text: string; url?: string };
  licenceNote?: string;
  tiers?: { draft: { workflow: string; note: string }; finals: FinalTier[] };
  draftName?: string;
  comp?: { tool: string; engine?: string; label: string };
  elsewhere: Array<{ id: string; label: string; kind: ResourceKind; status: ReadyStatus; chip: string; note?: string }>;
}

export interface Readiness {
  resource: { id: string; label: string; kind: ResourceKind | 'default'; usable: boolean; online: boolean | null; reason?: string };
  entries: ReadinessEntry[];
  counts: { total: number; ready: number; missingModels: number; missingNodes: number; notHere: number; unknown: number };
  missing: { files: number; bytes: number; unknownSizes: number };
  local: { id: string; url: string; online: boolean | null; version?: string; device?: string; message?: string; modelsDir: string | null; folder: { ok: boolean; message?: string } | null };
  usable: Array<{ id: string; label: string; kind: ResourceKind }>;
  speed: { bytesPerSec: number; at: string } | null;
  sizes: { pending: boolean; basis: string };
  /** Z-Image alone (not gated); then LTX-2.5 image to video (gated: its terms first, on `pages`). */
  suggestion: SuggestionPart & { then: SuggestionPart & { pages: string[] } };
  onboarding: { show: boolean; mode: 'auto' | 'hidden' | 'open'; reasons: string[]; firstRun: boolean; testImageAt: string | null; nothingUsable: boolean };
}

export interface DownloadItem {
  key: string;
  name: string;
  directory: string;
  repo: string;
  url: string;
  pageUrl: string;
  workflows: string[];
  size: number | null;
  sha256: string | null;
  received: number;
  status: 'queued' | 'downloading' | 'verifying' | 'done' | 'skipped' | 'error' | 'cancelled';
  message?: string;
  gated?: boolean;
  resumedFrom?: number;
  bytesPerSec?: number;
  shaChecked?: boolean;
}

export interface DownloadState {
  id: string;
  folder: string;
  items: DownloadItem[];
  running: boolean;
  startedAt: string;
  finishedAt?: string;
  reprobe?: { at: string; stillMissing: string[]; online: boolean } | null;
}

interface ReadinessStore {
  data: Readiness | null;
  error: string | null;
  /** The resource the data is for ('' = the Generate button's pick). */
  forResource: string;
  downloads: DownloadState | null;
  /** The "Get the models" list is open (an overlay over the window). */
  pickerOpen: boolean;
  /** Workflows ticked in the list (never pre-ticked: the suggested set is one click). */
  picked: string[];
  /** A README section shown over the window (its anchor), or null. */
  readme: string | null;
  setReadme: (anchor: string | null) => void;
  load: () => Promise<void>;
  setOpen: (v: boolean) => void;
  setPicked: (ids: string[]) => void;
  setOnboarding: (mode: 'hidden' | 'open' | 'auto') => Promise<void>;
  download: (files: Array<{ directory: string; name: string; url: string }>) => Promise<void>;
  cancel: () => Promise<void>;
  pollDownloads: () => Promise<void>;
}

let polling: ReturnType<typeof setTimeout> | null = null;
let reloadTimer: ReturnType<typeof setTimeout> | null = null;

export const useReadiness = create<ReadinessStore>((set, get) => ({
  data: null,
  error: null,
  forResource: '',
  downloads: null,
  pickerOpen: false,
  picked: [],
  readme: null,
  setReadme: (readme) => set({ readme }),
  load: async () => {
    try {
      const data = await serverJson<Readiness>('/api/readiness');
      set({ data, error: null });
      // Sizes are read from Hugging Face in the background: ask again once they are in.
      if (data.sizes.pending && !reloadTimer) reloadTimer = setTimeout(() => { reloadTimer = null; void get().load(); }, 1500);
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },
  setOpen: (pickerOpen) => {
    set({ pickerOpen });
    if (pickerOpen) { void get().load(); void get().pollDownloads(); }
  },
  setPicked: (picked) => set({ picked }),
  setOnboarding: async (mode) => {
    await serverJson('/api/onboarding', { mode });
    await get().load();
  },
  download: async (files) => {
    const st = await serverJson<DownloadState>('/api/models/download', { files });
    set({ downloads: st });
    void get().pollDownloads();
  },
  cancel: async () => {
    await serverJson('/api/models/downloads/cancel', {});
    void get().pollDownloads();
  },
  pollDownloads: async () => {
    if (polling) { clearTimeout(polling); polling = null; }
    try {
      const { state } = await serverJson<{ state: DownloadState | null }>('/api/models/downloads');
      const was = get().downloads?.running;
      set({ downloads: state });
      if (state?.running) polling = setTimeout(() => void get().pollDownloads(), 1000);
      else if (was || (state && !state.reprobe && state.finishedAt && Date.now() - Date.parse(state.finishedAt) < 15_000)) {
        // Finished: the local ComfyUI is read again by the server; the chips follow.
        void get().load();
        if (state && state.items.some((i) => i.status === 'done') && !state.reprobe) polling = setTimeout(() => void get().pollDownloads(), 1500);
      }
    } catch { /* the list keeps what it showed */ }
  },
}));

export async function putModelsFolder(path: string | null): Promise<{ ok: boolean; path: string | null; note?: string }> {
  const r = await fetch('/api/models/folder', { method: 'PUT', headers: serverHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ path }) });
  const data = await r.json() as { ok?: boolean; path?: string | null; note?: string; error?: string };
  if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
  return { ok: true, path: data.path ?? null, note: data.note };
}

export async function putHfToken(token: string | null): Promise<{ set: boolean; file: string }> {
  const r = await fetch('/api/models/hf-token', { method: 'PUT', headers: serverHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ token }) });
  const data = await r.json() as { set: boolean; file: string; error?: string };
  if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
  return data;
}

export async function makeTestImage(): Promise<{ file: string; seconds: number; placed?: { comp: string; layerId: number; at: number } }> {
  return serverJson('/api/test/generate', { place: true });
}

/* ─── Words ─────────────────────────────────────────────────────────── */

/** "8.0 GB" · "243 MB" — decimal units, as Hugging Face shows sizes (core/workflows/hf.ts). */
export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'size unknown';
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e11 ? 0 : 1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} kB`;
  return `${n} B`;
}

/** "~12 min" from bytes and a measured speed. */
export function etaText(bytes: number, bytesPerSec: number): string {
  const s = bytes / Math.max(1, bytesPerSec);
  if (s < 90) return `~${Math.max(1, Math.round(s))} s`;
  if (s < 5400) return `~${Math.round(s / 60)} min`;
  return `~${(s / 3600).toFixed(1)} h`;
}

/** The comfy-cli line for a file (verified with `comfy model download --help`, comfy-cli 1.23.0). */
export function comfyCommand(f: { url: string; directory: string; name: string }, modelsDir: string | null): string {
  const url = f.url.replace(/\?download=true$/, '');
  // --relative-path is relative to the ComfyUI folder (comfy-cli's workspace): models/<directory>.
  const ws = modelsDir && /[\\/]models$/i.test(modelsDir) ? modelsDir.replace(/[\\/]models$/i, '') : null;
  return `comfy${ws ? ` --workspace "${ws}"` : ''} model download --url "${url}" --relative-path "models/${f.directory}" --filename "${f.name}"`;
}

/** The files a set of workflows lacks on the local ComfyUI, each once, with the workflows that need it (optional files: never). */
export function filesToGet(entries: ReadinessEntry[], ids: string[]): Array<ReadinessFile & { workflows: string[] }> {
  const out = new Map<string, ReadinessFile & { workflows: string[] }>();
  for (const e of entries) {
    if (!ids.includes(e.id)) continue;
    for (const f of e.files) {
      if (f.state !== 'missing' || f.onDisk || f.optional) continue;
      const have = out.get(f.key);
      if (have) have.workflows.push(e.id);
      else out.set(f.key, { ...f, workflows: [e.id] });
    }
  }
  return [...out.values()];
}

/** "Start with Z-Image · 1 workflow · 20.7 GB · not gated" */
export function suggestionText(p: SuggestionPart): string {
  const size = `${formatBytes(p.bytes)}${p.unknownSizes ? '+' : ''}`;
  const gate = p.gated === false ? 'not gated' : p.gated ? 'gated · accept terms' : 'gating not read yet';
  return `${p.label} · ${p.ids.length} workflow${p.ids.length === 1 ? '' : 's'} · ${size} · ${gate}`;
}
