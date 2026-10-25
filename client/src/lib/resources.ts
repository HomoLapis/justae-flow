/**
 * Resources, credits and estimates, as the JustAE Flow server states them.
 *
 * The page keeps no key: Settings ▸ Resources writes one to the server
 * (PUT /api/resources), which keeps it in the user's config folder and only
 * ever says whether it is set and its last four characters. Every number shown
 * here comes from the server with its basis (server/credits.ts, core/cost/estimate.ts).
 */

import { create } from 'zustand';
import { serverHeaders, serverJson } from '../bridge/server';
import { lsGet, lsSet } from '../state/persistence';

export type ResourceKind = 'local' | 'cloud' | 'deployment' | 'proxy';

export interface ResourceView {
  id: string;
  kind: ResourceKind;
  label: string;
  url: string;
  enabled: boolean;
  gpu?: string;
  minWorkers?: number;
  /** The proxy: the local resource whose ComfyUI it stands in front of. */
  fronts?: string;
  usable: boolean;
  reason?: string;
  /** A job it refused outright (403), with the server's words. */
  refused?: { at: string; message: string };
  creditsPerHour: number | null;
  gpuLabel: string | null;
  needsKey: 'platform' | 'proxy' | 'none';
}

export interface WorkflowCapability {
  status: 'ok' | 'missing' | 'unknown' | 'proven';
  missingNodes: string[];
  missingModels: string[];
  remaps: string[];
  provenAt?: string;
}

export interface Capabilities {
  resourceId: string;
  kind: ResourceKind;
  checkedAt: string;
  online: boolean;
  message?: string;
  version?: string;
  device?: string;
  nodes: { known: boolean; count?: number; basis: string };
  models: { known: boolean; basis: string };
  workflows: Record<string, WorkflowCapability>;
}

export interface TaskRow { id: string; label: string; default: string }

export interface ResourcesData {
  resources: ResourceView[];
  tasks: Record<string, string>;
  taskRows: TaskRow[];
  choice: string;
  key: { set: boolean; tail: string | null; file: string };
  proxyToken: { set: boolean; file: string };
  gpus: Array<{ id: string; label: string; vramGb: number; creditsPerHour: number }>;
  capabilities: Record<string, Capabilities | null>;
}

export interface CreditsView {
  ok: boolean;
  error?: string;
  balanceCents: number | null;
  prepaidCents: number | null;
  planCents: number | null;
  currency: string | null;
  credits: number | null;
  prepaidCredits: number | null;
  planCredits: number | null;
  creditsPerUsd: number;
  asOf: string | null;
  source: 'invoices';
  previous: { credits: number; asOf: string } | null;
  spendMicros: number | null;
  pendingRefresh: boolean;
}

export interface Estimate {
  basis: 'timed' | 'rate' | 'free';
  runs: number;
  timing: 'execution' | 'wall' | null;
  secondsLow: number | null;
  secondsHigh: number | null;
  creditsLow: number | null;
  creditsHigh: number | null;
  creditsPerMinute: number | null;
  gpuLabel: string | null;
  beyondHistory: boolean;
}

export interface EstimateAnswer {
  shots: Array<Estimate & { workflowId: string; resource: string; label: string; text: string }>;
  total: Estimate & { shots: number; unknown: number; text: string; resources: string[] };
}

export interface ResourcePatch {
  resources?: Array<Partial<ResourceView> & { id: string; remove?: boolean }>;
  tasks?: Record<string, string>;
  choice?: string;
  apiKey?: string | null;
  proxyToken?: string | null;
}

export interface Resolution { task: string; resource: string; label: string; kind: ResourceKind; why: string; auto: boolean; metered: boolean }

async function put(patch: ResourcePatch): Promise<ResourcesData> {
  const r = await fetch('/api/resources', { method: 'PUT', headers: serverHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(patch) });
  const data = await r.json() as ResourcesData & { error?: string };
  if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
  return data;
}

interface ResourcesStore {
  data: ResourcesData | null;
  credits: CreditsView | null;
  error: string | null;
  load: () => Promise<void>;
  save: (patch: ResourcePatch) => Promise<void>;
  loadCredits: (force?: boolean) => Promise<void>;
  /** The Generate button's pick: 'default' (each task's row in Settings) or a resource id. */
  choose: (choice: string) => Promise<void>;
}

export const useResources = create<ResourcesStore>((set, get) => ({
  data: null,
  credits: null,
  error: null,
  load: async () => {
    try {
      set({ data: await serverJson<ResourcesData>('/api/resources'), error: null });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },
  save: async (patch) => {
    const data = await put(patch);
    set({ data, error: null });
    if (patch.apiKey !== undefined) void get().loadCredits(true);
  },
  loadCredits: async (force = false) => {
    try {
      set({ credits: await serverJson<CreditsView>(`/api/credits${force ? '?force=1' : ''}`) });
    } catch { /* the pill keeps the last reading, with its own time */ }
  },
  choose: async (choice) => {
    const prev = get().data;
    if (prev) set({ data: { ...prev, choice } });
    try { set({ data: await put({ choice }) }); } catch { /* the pick stays on screen */ }
  },
}));

export function resourceById(id: string | null | undefined): ResourceView | undefined {
  return useResources.getState().data?.resources.find((r) => r.id === id);
}

export function localResource(): ResourceView | undefined {
  return useResources.getState().data?.resources.find((r) => r.kind === 'local');
}

/** Any resource that bills (Cloud, a deployment) can take a job: the balance is worth reading. */
export function billingConfigured(d: ResourcesData | null): boolean {
  // The balance is worth reading whenever a key is set and a billing resource is on — even one that refuses jobs.
  return !!d && d.key.set && d.resources.some((r) => r.creditsPerHour !== null && r.enabled);
}

export async function resolveRun(q: { task: 'video' | 'image'; override: string | null; workflowId: string; graph?: unknown }): Promise<Resolution> {
  return serverJson<Resolution>('/api/resources/resolve', q);
}

export async function estimate(q: { resource?: string; task?: string; shots: Array<{ workflowId: string; seconds: number | null; scaleWithSlot: boolean; resource?: string }> }): Promise<EstimateAnswer> {
  return serverJson<EstimateAnswer>('/api/estimate', q);
}

export async function reportRun(r: { workflowId: string; resourceId: string; wallMs: number; executionMs: number | null; slotSeconds: number | null; scaleWithSlot: boolean; jobId: string }): Promise<void> {
  await serverJson('/api/runs', r).catch(() => undefined);
}

/* ─── Words ─────────────────────────────────────────────────────────── */

export function formatCredits(v: number): string {
  return v < 10 ? v.toFixed(1) : Math.round(v).toLocaleString('en-US');
}

export function formatUsd(v: number): string {
  return v < 0.1 ? `$${v.toFixed(3)}` : `$${v.toFixed(2)}`;
}

export function clock(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "≈ $42.50 · 4,220 plan + 4,748 top-ups · read 14:02 (from invoices, may lag)" */
export function creditsTooltip(c: CreditsView): string {
  if (!c.ok || c.credits === null) return c.error ?? 'No balance read yet.';
  const usd = c.balanceCents !== null ? `≈ $${(c.balanceCents / 100).toFixed(2)}` : '';
  const split = c.planCredits !== null && c.prepaidCredits !== null ? `${formatCredits(c.planCredits)} plan + ${formatCredits(c.prepaidCredits)} top-ups` : '';
  return [usd, split, `read ${clock(c.asOf)} from the billing report (invoices — it can lag behind the last job)`].filter(Boolean).join(' · ');
}

/* ─── Migration ─────────────────────────────────────────────────────── */

/**
 * Before resources, the Flow window kept its backend and keys in this page's
 * local storage. Once, they go to the server (which never overwrites a key it
 * already has) and leave the page's storage. `legacy` is what the store found
 * at load (state/store.ts takeLegacySettings).
 */
export async function migrateLegacySettings(legacy: Record<string, unknown>): Promise<string[]> {
  const { moved } = await serverJson<{ moved: string[] }>('/api/resources/migrate', legacy);
  const raw = lsGet<Record<string, unknown> | null>('settings', null);
  if (raw) {
    const rest = { ...raw };
    for (const k of Object.keys(legacy)) delete rest[k];
    lsSet('settings', rest);
  }
  return moved;
}
