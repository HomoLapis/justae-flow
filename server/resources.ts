/**
 * Resources: the places a workflow can run, and which one each task uses.
 *
 *   local       your ComfyUI over its own protocol (core/comfy/client.ts) — free, your GPU
 *   cloud       Comfy Cloud, https://cloud.comfy.org — Comfy API v2 for jobs, v1 for
 *               billing, node catalogue and model folders; one platform API key
 *   deployment  a Comfy API deployment you made on platform.comfy.org,
 *               https://<deployment>.run.comfy.app — v2, the same key
 *   proxy       your ComfyUI behind comfy-api-proxy (v2 on :8189) — your GPU, an optional token
 *
 * The registry lives in the user's config folder (resources.json). The two
 * secrets live beside it, one line each, and never anywhere else:
 *   comfy-api-key.txt      the platform API key (Cloud, deployments)
 *   comfy-proxy-token.txt  the proxy's --token, if it was started with one
 * Nothing here returns a secret: the views say whether one is set and its last
 * four characters, so the Settings page can show which key it is.
 *
 * Nothing here creates, builds, starts, scales or stops anything on the
 * platform: a deployment is an endpoint URL the user pastes.
 *
 * Sources: base URLs and auth per surface from docs.comfy.org "Comfy API v2
 * Overview" (Base URLs); the v1 surface from "v1 Cloud API Overview"; the
 * SDK's per-construction base URL from @comfyorg/sdk 0.5.0 src/sdk/client.ts
 * (resolveBaseUrl reads COMFY_BASE_URL in the constructor; there is no option).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Comfy } from '@comfyorg/sdk';
import { DEFAULT_GPU, GPUS, isGpuId, type GpuId } from '../core/cost/estimate.ts';
import type { Task } from '../core/workflows/manifest.ts';

export type ResourceKind = 'local' | 'cloud' | 'deployment' | 'proxy';
export const CLOUD_BASE = 'https://cloud.comfy.org';
export const PROXY_DEFAULT = 'http://127.0.0.1:8189';

export interface Resource {
  id: string;
  kind: ResourceKind;
  label: string;
  url: string;
  enabled: boolean;
  /** The GPU it bills on: Comfy Cloud runs on the RTX PRO 6000; a deployment on what it was deployed with. */
  gpu?: GpuId;
  /** A deployment's minimum workers, as the user deployed it: a warm worker bills while idle. */
  minWorkers?: number;
  /**
   * The proxy: the resource whose ComfyUI it stands in front of. comfy-api-proxy proxies the ComfyUI on
   * 127.0.0.1:8188 by default (docs.comfy.org, Comfy API v2 Overview), so it starts as 'local'; then that
   * ComfyUI's node catalogue answers for the proxy (v2 has none) and its model precisions can be swapped in.
   */
  fronts?: string;
}

/** What each button runs: the rows of Settings ▸ Resources ▸ "Where each task runs" (PLAN v3 §2.1). */
export type TaskId = 'video' | 'image' | 'reframe' | 'reframe-draft' | 'upscale' | 'matte' | 'interpolate' | 'restyle';
export const TASKS: Array<{ id: TaskId; label: string; default: string }> = [
  { id: 'video', label: 'Generate video (LTX, H3, Wan)', default: 'auto' },
  { id: 'image', label: 'Generate image', default: 'local' },
  { id: 'reframe', label: 'Generative reframe (VACE 14B)', default: 'cloud' },
  { id: 'reframe-draft', label: 'Reframe draft (VACE 1.3B)', default: 'local' },
  { id: 'upscale', label: 'Upscale (SeedVR2)', default: 'cloud' },
  { id: 'matte', label: 'Cut-out / matte (SAM 3)', default: 'local' },
  { id: 'interpolate', label: 'Slow motion / fps (RIFE, GIMM)', default: 'local' },
  { id: 'restyle', label: 'Restyle / edit video', default: 'auto' },
];

/** A bundled workflow's task, as a row of that table. */
export function taskOf(manifestTask: Task, workflowId = ''): TaskId {
  switch (manifestTask) {
    case 't2v': case 'i2v': return 'video';
    case 'v2v': return 'restyle';
    case 't2i': case 'i2i': return 'image';
    case 'outpaint-video': return /draft/.test(workflowId) ? 'reframe-draft' : 'reframe';
    case 'upscale-video': case 'upscale-image': return 'upscale';
    case 'matte-video': case 'reframe': case 'remove-bg': return 'matte';
  }
}

export interface ResourceConfig {
  schema: 1;
  resources: Resource[];
  tasks: Record<TaskId, string>;
  /** The Flow window's last pick on its Generate button ('default' = the task table). */
  choice: string;
  /**
   * Resources that refused a job outright (403), with the server's words —
   * measured on Comfy Cloud: "API key authentication is not available for free
   * tier accounts". Until the key changes or the user presses Check, such a
   * resource is "not usable", so rows and Auto go elsewhere instead of failing.
   */
  refusals?: Record<string, { at: string; message: string }>;
}

export interface ResourceView extends Resource {
  /** Whether it can take a job now, and why not. */
  usable: boolean;
  reason?: string;
  /** Credits per hour while a job runs; null where nothing bills (your GPU). */
  creditsPerHour: number | null;
  gpuLabel: string | null;
  needsKey: 'platform' | 'proxy' | 'none';
  /** A job this resource refused outright, with its words (see ResourceConfig.refusals). */
  refused?: { at: string; message: string };
}

export interface ResourcesView {
  resources: ResourceView[];
  tasks: Record<TaskId, string>;
  taskRows: typeof TASKS;
  choice: string;
  key: { set: boolean; tail: string | null; file: string };
  proxyToken: { set: boolean; file: string };
  gpus: Array<{ id: GpuId; label: string; vramGb: number; creditsPerHour: number }>;
}

export interface ResourcePatch {
  resources?: Array<Partial<Resource> & { id: string; remove?: boolean }>;
  tasks?: Partial<Record<TaskId, string>>;
  choice?: string;
  /** A new platform key; '' or null removes it. Write-only. */
  apiKey?: string | null;
  proxyToken?: string | null;
}

/** What the Flow window kept in its local storage before resources lived here. */
export interface LegacyClientSettings {
  provider?: string;
  localComfyUrl?: string;
  comfyCloudApiKey?: string;
  comfyV2Target?: string;
  comfyV2Url?: string;
  comfyV2Token?: string;
  comfyV2ProxyToken?: string;
}

export function isLoopback(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === '127.0.0.1' || h === 'localhost' || h === '[::1]';
  } catch {
    return false;
  }
}

function sameOrigin(a: string, b: string): boolean {
  try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
}

const TAIL = (s: string): string | null => (s.length >= 8 ? s.slice(-4) : null);

/**
 * A one-line secret file: its first non-blank line, trimmed (a byte-order mark
 * or a trailing newline from a text editor included). '' when the file is
 * missing, empty or blank.
 */
export function readSecret(file: string): string {
  if (!existsSync(file)) return '';
  try {
    return readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  } catch {
    return '';
  }
}

export class ResourceRegistry {
  readonly dir: string;
  private file: string;
  private keyFile: string;
  private proxyFile: string;
  private cfg: ResourceConfig;
  private clients = new Map<string, { sig: string; client: Comfy }>();
  private listeners = new Set<() => void>();

  /** `seedLocalUrl`: the ComfyUI address the settings already had, so an upgrade keeps it. */
  constructor(dir: string, seedLocalUrl: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'resources.json');
    this.keyFile = join(dir, 'comfy-api-key.txt');
    this.proxyFile = join(dir, 'comfy-proxy-token.txt');
    this.cfg = this.load(seedLocalUrl);
  }

  private defaults(localUrl: string): ResourceConfig {
    return {
      schema: 1,
      resources: [
        { id: 'local', kind: 'local', label: 'Local ComfyUI', url: localUrl || 'http://127.0.0.1:8188', enabled: true },
        { id: 'cloud', kind: 'cloud', label: 'Comfy Cloud', url: CLOUD_BASE, enabled: true, gpu: DEFAULT_GPU },
        { id: 'proxy', kind: 'proxy', label: 'Your ComfyUI via comfy-api-proxy', url: PROXY_DEFAULT, enabled: false, fronts: 'local' },
      ],
      tasks: Object.fromEntries(TASKS.map((t) => [t.id, t.default])) as Record<TaskId, string>,
      choice: 'default',
    };
  }

  private load(seedLocalUrl: string): ResourceConfig {
    const base = this.defaults(seedLocalUrl);
    if (!existsSync(this.file)) { this.save(base); return base; }
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<ResourceConfig>;
      const resources = Array.isArray(saved.resources) && saved.resources.length ? saved.resources : base.resources;
      // The three fixed entries always exist; deployments are the user's.
      for (const fixed of base.resources) if (!resources.some((r) => r.id === fixed.id)) resources.push(fixed);
      return {
        schema: 1, resources, tasks: { ...base.tasks, ...(saved.tasks ?? {}) }, choice: typeof saved.choice === 'string' ? saved.choice : 'default',
        refusals: saved.refusals && typeof saved.refusals === 'object' ? saved.refusals : {},
      };
    } catch {
      return base;
    }
  }

  private save(c: ResourceConfig = this.cfg): void {
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, JSON.stringify(c, null, 2));
    renameSync(tmp, this.file);
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    this.save();
    this.clients.clear();
    for (const fn of this.listeners) fn();
  }

  /* ─── Secrets ──────────────────────────────────────────────────────── */

  /**
   * The platform API key: the key file, else COMFY_API_KEY in the environment (a headless setup). Never returned to a page.
   * An empty or blank file is no key at all — a resource without one is "not set up", never a 401 waiting to happen.
   */
  key(): string {
    return readSecret(this.keyFile) || (process.env.COMFY_API_KEY?.trim() ?? '');
  }

  proxyToken(): string {
    return readSecret(this.proxyFile);
  }

  private writeSecret(file: string, value: string | null): void {
    if (!value) { rmSync(file, { force: true }); return; }
    if (/\s/.test(value)) throw new Error('A key is one line without spaces.');
    writeFileSync(file, value + '\n', { mode: 0o600 });
  }

  /** The credential a resource is called with, or undefined for none. */
  tokenFor(r: Resource): string | undefined {
    if (r.kind === 'cloud' || r.kind === 'deployment') return this.key() || undefined;
    if (r.kind === 'proxy') return this.proxyToken() || undefined;
    return undefined;
  }

  /* ─── Reading ──────────────────────────────────────────────────────── */

  list(): Resource[] {
    return this.cfg.resources;
  }

  get(id: string): Resource | undefined {
    return this.cfg.resources.find((r) => r.id === id);
  }

  local(): Resource {
    return this.get('local')!;
  }

  tasks(): Record<TaskId, string> {
    return this.cfg.tasks;
  }

  choice(): string {
    return this.cfg.choice;
  }

  creditsPerHour(r: Resource): number | null {
    if (r.kind === 'cloud') return GPUS['rtx-pro-6000'].creditsPerHour;
    if (r.kind === 'deployment') return GPUS[r.gpu ?? DEFAULT_GPU].creditsPerHour;
    return null;
  }

  gpuLabel(r: Resource): string | null {
    if (r.kind === 'cloud') return GPUS['rtx-pro-6000'].label;
    if (r.kind === 'deployment') return GPUS[r.gpu ?? DEFAULT_GPU].label;
    return null;
  }

  /** Can it take a job now? Only configuration is checked here; reachability is the probe's job. */
  usable(r: Resource): { ok: boolean; reason?: string } {
    if (!r.enabled) return { ok: false, reason: 'switched off in Settings' };
    let u: URL;
    try { u = new URL(r.url); } catch { return { ok: false, reason: 'no valid address' }; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: 'not an http(s) address' };
    if ((r.kind === 'cloud' || r.kind === 'deployment') && !this.key()) return { ok: false, reason: 'no API key yet' };
    // A key travels over https only, or over plain http to this machine.
    const token = this.tokenFor(r);
    if (token && u.protocol === 'http:' && !isLoopback(r.url)) return { ok: false, reason: 'refusing to send the key over plain http to another machine' };
    return { ok: true };
  }

  /** The job refusal on record for a resource, if any (see ResourceConfig.refusals). */
  refusal(r: Resource): { at: string; message: string } | undefined {
    return this.cfg.refusals?.[r.id];
  }

  /** Can it take a job: set up, and not on record as refusing jobs. Reads (status, billing) need only `usable`. */
  canTakeJobs(r: Resource): { ok: boolean; reason?: string } {
    const u = this.usable(r);
    if (!u.ok) return u;
    const refused = this.refusal(r);
    return refused ? { ok: false, reason: `refuses jobs: ${refused.message}` } : u;
  }

  noteRefusal(id: string, message: string): void {
    this.cfg.refusals = { ...(this.cfg.refusals ?? {}), [id]: { at: new Date().toISOString(), message } };
    this.changed();
  }

  clearRefusal(id: string): void {
    if (!this.cfg.refusals?.[id]) return;
    const next = { ...this.cfg.refusals };
    delete next[id];
    this.cfg.refusals = next;
    this.changed();
  }

  view(): ResourcesView {
    const key = this.key();
    return {
      resources: this.cfg.resources.map((r) => {
        const u = this.canTakeJobs(r);
        return {
          ...r, usable: u.ok, reason: u.reason, refused: this.refusal(r), creditsPerHour: this.creditsPerHour(r), gpuLabel: this.gpuLabel(r),
          needsKey: r.kind === 'cloud' || r.kind === 'deployment' ? 'platform' : r.kind === 'proxy' ? 'proxy' : 'none',
        };
      }),
      tasks: this.cfg.tasks,
      taskRows: TASKS,
      choice: this.cfg.choice,
      key: { set: !!key, tail: key ? TAIL(key) : null, file: this.keyFile },
      proxyToken: { set: !!this.proxyToken(), file: this.proxyFile },
      gpus: (Object.keys(GPUS) as GpuId[]).map((id) => ({ id, ...GPUS[id] })),
    };
  }

  /* ─── Writing ──────────────────────────────────────────────────────── */

  update(p: ResourcePatch): void {
    if (p.apiKey !== undefined) {
      this.writeSecret(this.keyFile, p.apiKey?.trim() || null);
      // Another key may well be on another plan: what the old one was refused says nothing about it.
      this.cfg.refusals = {};
    }
    if (p.proxyToken !== undefined) this.writeSecret(this.proxyFile, p.proxyToken?.trim() || null);
    for (const ch of p.resources ?? []) {
      const at = this.cfg.resources.findIndex((r) => r.id === ch.id);
      if (ch.remove) {
        if (at >= 0 && this.cfg.resources[at].kind !== 'deployment') throw new Error('Only a deployment can be removed; switch the others off.');
        if (at >= 0) this.cfg.resources.splice(at, 1);
        continue;
      }
      const url = typeof ch.url === 'string' ? ch.url.trim().replace(/\/+$/, '') : undefined;
      if (at < 0) {
        // A new entry is a deployment: the fixed ones always exist.
        if (!/^deployment(-\d+)?$/.test(ch.id)) throw new Error(`No resource "${ch.id}".`);
        this.cfg.resources.push({
          id: ch.id, kind: 'deployment', label: ch.label?.trim() || 'Deployment', url: url ?? '', enabled: ch.enabled ?? true,
          gpu: isGpuId(ch.gpu) ? ch.gpu : DEFAULT_GPU, minWorkers: typeof ch.minWorkers === 'number' ? Math.max(0, Math.round(ch.minWorkers)) : 0,
        });
        continue;
      }
      const r = this.cfg.resources[at];
      if (url !== undefined) {
        if (r.kind === 'cloud' && url !== CLOUD_BASE) throw new Error(`Comfy Cloud is ${CLOUD_BASE}; a different address is a deployment.`);
        r.url = url;
      }
      if (typeof ch.enabled === 'boolean') r.enabled = ch.enabled;
      if (typeof ch.label === 'string' && ch.label.trim()) r.label = ch.label.trim();
      if (r.kind === 'deployment' && isGpuId(ch.gpu)) r.gpu = ch.gpu;
      if (r.kind === 'deployment' && typeof ch.minWorkers === 'number') r.minWorkers = Math.max(0, Math.round(ch.minWorkers));
      if (r.kind === 'proxy' && ch.fronts !== undefined) r.fronts = ch.fronts && this.get(ch.fronts)?.kind === 'local' ? ch.fronts : undefined;
    }
    for (const [task, pick] of Object.entries(p.tasks ?? {})) {
      if (!TASKS.some((t) => t.id === task)) continue;
      if (pick !== 'auto' && !this.get(String(pick))) throw new Error(`No resource "${pick}" for ${task}.`);
      this.cfg.tasks[task as TaskId] = String(pick);
    }
    if (typeof p.choice === 'string') this.cfg.choice = p.choice === 'default' || p.choice === 'auto' || this.get(p.choice) ? p.choice : 'default';
    this.changed();
  }

  /** A new deployment entry's id. */
  nextDeploymentId(): string {
    for (let n = 1; ; n++) {
      const id = n === 1 ? 'deployment' : `deployment-${n}`;
      if (!this.get(id)) return id;
    }
  }

  /**
   * The Flow window's old local-storage settings, moved here once. A key or
   * token already in the config folder is never overwritten; the local
   * address is kept.
   */
  migrate(old: LegacyClientSettings): { moved: string[] } {
    const moved: string[] = [];
    const patch: ResourcePatch = { resources: [] };
    const platformKey = (old.comfyV2Target !== 'proxy' ? old.comfyV2Token : '')?.trim() || old.comfyCloudApiKey?.trim() || '';
    if (platformKey && !this.key()) { patch.apiKey = platformKey; moved.push('API key'); }
    if (old.comfyV2ProxyToken?.trim() && !this.proxyToken()) { patch.proxyToken = old.comfyV2ProxyToken.trim(); moved.push('proxy token'); }
    const v2 = old.comfyV2Url?.trim().replace(/\/+$/, '') ?? '';
    if (v2 && (old.comfyV2Target === 'proxy' || isLoopback(v2))) {
      patch.resources!.push({ id: 'proxy', url: v2, enabled: true });
      moved.push('proxy address');
    } else if (v2 && v2 !== CLOUD_BASE && !this.list().some((r) => r.kind === 'deployment' && r.url === v2)) {
      patch.resources!.push({ id: this.nextDeploymentId(), url: v2, label: 'Deployment', enabled: true });
      moved.push('deployment address');
    }
    // The address the server already uses wins; the page's copy fills in only a default.
    const local = this.local();
    if (old.localComfyUrl && old.localComfyUrl !== local.url && local.url === 'http://127.0.0.1:8188') {
      patch.resources!.push({ id: 'local', url: old.localComfyUrl });
      moved.push('local address');
    }
    if (old.provider === 'comfy-v2' || old.provider === 'comfy-cloud') {
      const target = old.provider === 'comfy-cloud' || old.comfyV2Target === 'cloud' ? 'cloud' : old.comfyV2Target === 'proxy' ? 'proxy' : 'default';
      if (target !== 'default') { patch.choice = target; moved.push(`run target (${target})`); }
    }
    if (moved.length) this.update(patch);
    return { moved };
  }

  /* ─── Choosing ─────────────────────────────────────────────────────── */

  /**
   * Where a run goes: the per-run override, else the task's row, else Auto.
   * Auto = Local when its probe has every node and model, else the first
   * other resource whose probe says it has them, else Local.
   * `has` answers from the capability cache: 'ok' | 'missing' | 'unknown'.
   */
  resolve(task: TaskId, override: string | null | undefined, has: (r: Resource) => 'ok' | 'missing' | 'unknown'): { resource: Resource; why: string; auto: boolean } {
    const row = TASKS.find((t) => t.id === task)!;
    const chosen = !!override && override !== 'default' && override !== 'auto';
    const pick = override && override !== 'default' ? override : this.cfg.tasks[task] ?? 'auto';
    let note = '';
    if (pick !== 'auto') {
      const r = this.get(pick);
      const u = r ? this.canTakeJobs(r) : { ok: false, reason: 'not in Settings' };
      // A run's own pick stands (the run then says what is missing there, before any credit is spent);
      // a row of the table gives way to Auto when the probe found the workflow's nodes or models missing there.
      if (r && u.ok && (chosen || has(r) !== 'missing')) {
        return { resource: r, why: chosen ? `${r.label}, chosen for this run` : `${r.label} (Settings: ${row.label})`, auto: false };
      }
      note = r && u.ok ? `${r.label} lacks a node or model of this workflow → ` : `${r?.label ?? pick}: ${u.reason} → `;
    }
    const local = this.local();
    const localOk = this.canTakeJobs(local).ok;
    if (localOk && has(local) === 'ok') return { resource: local, why: `${note}Auto: Local has the nodes and models`, auto: true };
    const order = [this.get('cloud'), ...this.list().filter((r) => r.kind === 'deployment'), this.get('proxy')].filter((r): r is Resource => !!r);
    for (const r of order) {
      if (this.canTakeJobs(r).ok && has(r) === 'ok') return { resource: r, why: `${note}Auto: ${localOk && has(local) === 'missing' ? 'Local lacks something; ' : ''}${r.label} has the nodes and models`, auto: true };
    }
    if (localOk) return { resource: local, why: `${note}Auto: Local (no other resource is known to have everything)`, auto: true };
    const any = order.find((r) => this.canTakeJobs(r).ok);
    return { resource: any ?? local, why: `${note}Auto: ${any ? any.label : 'nothing is set up'}`, auto: true };
  }

  /* ─── Comfy API v2 clients ─────────────────────────────────────────── */

  /**
   * One SDK client per resource. The SDK takes its base URL only from
   * COMFY_BASE_URL, read in the constructor, and falls back to COMFY_API_KEY
   * when no key is passed — so both are set (or cleared) around the
   * constructor and put back at once. Construction is synchronous, so no other
   * request can see the swapped environment, and a proxy without a token can
   * never be handed the platform key from the environment.
   */
  sdk(r: Resource): Comfy {
    if (r.kind === 'local') throw new Error('The local ComfyUI is spoken to over its own protocol, not v2.');
    const u = this.usable(r);
    if (!u.ok) throw new Error(`${r.label}: ${u.reason}.`);
    const token = this.tokenFor(r);
    const sig = `${r.url}|${token ? createHash('sha256').update(token).digest('hex').slice(0, 16) : '-'}`;
    const cached = this.clients.get(r.id);
    if (cached?.sig === sig) return cached.client;
    const saved = { base: process.env.COMFY_BASE_URL, key: process.env.COMFY_API_KEY };
    let client: Comfy;
    try {
      if (sameOrigin(r.url, CLOUD_BASE)) delete process.env.COMFY_BASE_URL;
      else process.env.COMFY_BASE_URL = r.url;
      delete process.env.COMFY_API_KEY;
      client = new Comfy({ apiKey: token, clientInfo: 'justae-flow' });
    } finally {
      if (saved.base === undefined) delete process.env.COMFY_BASE_URL; else process.env.COMFY_BASE_URL = saved.base;
      if (saved.key === undefined) delete process.env.COMFY_API_KEY; else process.env.COMFY_API_KEY = saved.key;
    }
    this.clients.set(r.id, { sig, client });
    return client;
  }
}
