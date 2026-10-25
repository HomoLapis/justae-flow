/**
 * What each resource can run: its node classes and model files, checked
 * against every bundled workflow — the "runs here ✓ / missing X" badges and
 * the Auto rule come from here. Kept ten minutes per resource.
 *
 *   local       GET /api/object_info: node classes, and the model files its
 *               loaders offer (the same check as `npm run verify:workflows`)
 *   cloud       v1 GET /api/object_info with the key, for node classes and loader
 *               options; v1 GET /api/experiment/models/{folder} (public) for model
 *               files, also without a key (openapi-cloud.yaml)
 *   deployment  no node catalogue on Comfy API v2: unknown until a workflow
 *   proxy       has finished there — then it is "proven" by the run history.
 *               Measured on comfy-api-proxy 0.1.6: /api/object_info answers 404.
 */

import { ComfyClient } from '../core/comfy/client.ts';
import type { ObjectInfo, WorkflowJson } from '../core/comfy/types.ts';
import { missingNodes, resolveModels } from '../core/workflows/manifest.ts';
import type { WorkflowLibrary } from './library.ts';
import { CLOUD_BASE, type Resource, type ResourceKind, type ResourceRegistry } from './resources.ts';
import type { RunLog } from './runs.ts';

export interface WorkflowCapability {
  status: 'ok' | 'missing' | 'unknown' | 'proven';
  missingNodes: string[];
  missingModels: string[];
  /** Another precision of the same weights the resource has instead (local only). */
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

const TTL = 10 * 60_000;

export class CapabilityProbe {
  private registry: ResourceRegistry;
  private library: WorkflowLibrary;
  private runs: RunLog;
  private localAuth: () => { token: string; gpu: string };
  private cache = new Map<string, { at: number; caps: Capabilities; objectInfo: ObjectInfo | null }>();
  private inflight = new Map<string, Promise<Capabilities>>();
  private folders = new Map<string, { at: number; names: Set<string> | null }>();

  private cloudBase: string;

  constructor(registry: ResourceRegistry, library: WorkflowLibrary, runs: RunLog, localAuth: () => { token: string; gpu: string }, cloudBase = CLOUD_BASE) {
    this.registry = registry;
    this.cloudBase = cloudBase;
    this.library = library;
    this.runs = runs;
    this.localAuth = localAuth;
    registry.onChange(() => this.cache.clear());
    // A run that finishes on a deployment is the proof it can run there.
    runs.onAdd((r) => { const c = this.cache.get(r.resourceId); if (c) this.applyProven(c.caps); });
  }

  cached(id: string): Capabilities | null {
    return this.cache.get(id)?.caps ?? null;
  }

  objectInfo(id: string): ObjectInfo | null {
    return this.cache.get(id)?.objectInfo ?? null;
  }

  /** From the cache only: what Auto and the engine ask. */
  has(r: Resource, workflowId: string): 'ok' | 'missing' | 'unknown' {
    const w = this.cache.get(r.id)?.caps.workflows[workflowId];
    if (!w) return 'unknown';
    return w.status === 'ok' || w.status === 'proven' ? 'ok' : w.status === 'missing' ? 'missing' : 'unknown';
  }

  async get(id: string, force = false): Promise<Capabilities> {
    const hit = this.cache.get(id);
    if (!force && hit && Date.now() - hit.at < TTL) return hit.caps;
    const running = this.inflight.get(id);
    if (running) return running;
    const r = this.registry.get(id);
    if (!r) throw new Error(`No resource "${id}".`);
    const p = this.probe(r).finally(() => this.inflight.delete(id));
    this.inflight.set(id, p);
    return p;
  }

  /**
   * Probe every resource that can take a job, in the background (the Auto rule
   * needs them). Comfy Cloud only once a key is set: nothing is sent to a
   * service the user has not set up. (Its Check button probes the public model
   * folders without a key, when asked.)
   */
  warm(): void {
    for (const r of this.registry.list()) {
      if (r.enabled && this.registry.usable(r).ok) void this.get(r.id).catch(() => undefined);
    }
  }

  private base(r: Resource): Capabilities {
    return { resourceId: r.id, kind: r.kind, checkedAt: new Date().toISOString(), online: false, nodes: { known: false, basis: '' }, models: { known: false, basis: '' }, workflows: {} };
  }

  private applyProven(caps: Capabilities): void {
    const proven = this.runs.provenOn(caps.resourceId);
    for (const [id, at] of proven) {
      const w = caps.workflows[id];
      if (w && w.status === 'unknown') { w.status = 'proven'; w.provenAt = at; }
      else if (!w && this.library.get(id)) caps.workflows[id] = { status: 'proven', missingNodes: [], missingModels: [], remaps: [], provenAt: at };
    }
  }

  private async probe(r: Resource): Promise<Capabilities> {
    const caps = this.base(r);
    let oi: ObjectInfo | null = null;
    const u = this.registry.usable(r);
    try {
      if (r.kind === 'local') oi = await this.probeLocal(r, caps);
      else if (r.kind === 'cloud') oi = await this.probeCloud(r, caps, u.ok);
      else await this.probeV2(r, caps, u.ok, u.reason);
    } catch (e) {
      caps.online = false;
      caps.message = e instanceof Error ? e.message : String(e);
    }
    this.applyProven(caps);
    this.cache.set(r.id, { at: Date.now(), caps, objectInfo: oi });
    return caps;
  }

  private async probeLocal(r: Resource, caps: Capabilities): Promise<ObjectInfo | null> {
    const auth = this.localAuth();
    const c = new ComfyClient(r.url, { token: auth.token, gpu: auth.gpu });
    const h = await c.health();
    caps.online = h.online;
    caps.message = h.message;
    caps.version = h.version;
    caps.device = h.device;
    if (!h.online) return null;
    const oi = await c.objectInfo(true);
    caps.nodes = { known: true, count: Object.keys(oi).length, basis: 'GET /api/object_info' };
    caps.models = { known: true, basis: 'the model files its loader nodes offer (object_info)' };
    for (const m of this.library.list()) {
      const api = this.library.graph(m.id)!;
      const nodes = missingNodes(api, oi);
      const models = resolveModels(api, oi, m.models);
      caps.workflows[m.id] = {
        status: nodes.length || models.missing.length ? 'missing' : 'ok',
        missingNodes: nodes, missingModels: models.missing.map((x) => x.wanted), remaps: models.remaps.map((x) => `${x.wanted} → ${x.using}`),
      };
    }
    return oi;
  }

  /** The files of one Comfy Cloud model folder (public), kept with the probe. */
  private async cloudFolder(dir: string): Promise<Set<string> | null> {
    const hit = this.folders.get(dir);
    if (hit && Date.now() - hit.at < TTL) return hit.names;
    let names: Set<string> | null = null;
    try {
      const res = await fetch(`${this.cloudBase}/api/experiment/models/${encodeURIComponent(dir)}`, { signal: AbortSignal.timeout(30_000) });
      if (res.ok) names = new Set(((await res.json()) as Array<{ name: string }>).map((x) => x.name));
      else if (res.status === 404) names = new Set();
    } catch { /* unknown */ }
    this.folders.set(dir, { at: Date.now(), names });
    return names;
  }

  private async probeCloud(r: Resource, caps: Capabilities, withKey: boolean): Promise<ObjectInfo | null> {
    const stats = await fetch(`${this.cloudBase}/api/system_stats`, { signal: AbortSignal.timeout(15_000) });
    caps.online = stats.ok;
    if (stats.ok) {
      const s = (await stats.json()) as { system?: { comfyui_version?: string; cloud_version?: string } };
      caps.version = [s.system?.comfyui_version, s.system?.cloud_version && `cloud ${s.system.cloud_version}`].filter(Boolean).join(' · ');
    }
    caps.device = 'RTX PRO 6000 (comfy.org/cloud/pricing)';
    let oi: ObjectInfo | null = null;
    if (withKey) {
      const res = await fetch(`${this.cloudBase}/api/object_info`, { headers: { 'X-API-Key': this.registry.key() }, signal: AbortSignal.timeout(240_000) });
      if (res.ok) {
        oi = (await res.json()) as ObjectInfo;
        caps.nodes = { known: true, count: Object.keys(oi).length, basis: 'v1 GET /api/object_info' };
      } else {
        caps.nodes = { known: false, basis: `v1 GET /api/object_info answered HTTP ${res.status}` };
        if (res.status === 401) caps.message = 'The key was not accepted (401).';
      }
    } else {
      caps.nodes = { known: false, basis: 'needs the API key (v1 /api/object_info)' };
      caps.message = 'No API key yet: model files checked, node classes not.';
    }
    caps.models = { known: true, basis: 'v1 GET /api/experiment/models/{folder}' };
    for (const m of this.library.list()) {
      const api = this.library.graph(m.id)!;
      const nodes = oi ? missingNodes(api, oi) : null;
      const used = m.models.filter((x) => JSON.stringify(api).includes(JSON.stringify(x.name)));
      const missingModels: string[] = [];
      let modelsKnown = true;
      for (const x of used) {
        const names = await this.cloudFolder(x.directory);
        if (names === null) { modelsKnown = false; continue; }
        const found = names.has(x.name) || [...names].some((n) => n.split('/').pop() === x.name);
        if (!found) missingModels.push(x.name);
      }
      const missing = (nodes?.length ?? 0) > 0 || missingModels.length > 0;
      caps.workflows[m.id] = {
        status: missing ? 'missing' : nodes === null || !modelsKnown ? 'unknown' : 'ok',
        missingNodes: nodes ?? [], missingModels, remaps: [],
      };
    }
    return oi;
  }

  private async probeV2(r: Resource, caps: Capabilities, usable: boolean, reason?: string): Promise<void> {
    caps.nodes = { known: false, basis: 'Comfy API v2 has no node catalogue: unknown until a workflow has finished here' };
    caps.models = { known: false, basis: 'unknown until a workflow has finished here' };
    if (!usable) { caps.online = false; caps.message = reason; }
    else {
      const token = this.registry.tokenFor(r);
      try {
        const res = await fetch(`${r.url}/api/v2/jobs?limit=1`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(20_000) });
        caps.online = res.ok;
        if (!res.ok) caps.message = res.status === 401 || res.status === 403 ? 'The server is up but did not accept the key.' : `HTTP ${res.status}`;
      } catch (e) {
        caps.online = false;
        caps.message = e instanceof Error ? e.message : String(e);
      }
    }
    for (const m of this.library.list()) caps.workflows[m.id] = { status: 'unknown', missingNodes: [], missingModels: [], remaps: [] };
  }

  /**
   * A workflow that is not bundled (the Flow window's own library), checked
   * against a resource: its node classes, and every model file it names
   * against the files the resource's loaders offer.
   */
  async checkGraph(id: string, graph: WorkflowJson): Promise<{ status: 'ok' | 'missing' | 'unknown'; missingNodes: string[]; missingModels: string[]; basis: string }> {
    const caps = await this.get(id);
    const oi = this.objectInfo(id);
    if (!oi) return { status: 'unknown', missingNodes: [], missingModels: [], basis: caps.nodes.basis || 'no node catalogue' };
    const nodes = missingNodes(graph, oi);
    const clone = structuredClone(graph);
    const models = resolveModels(clone, oi);
    // The Flow window sends a graph as it is: a file the resource has only in another precision is missing too.
    const missingModels = [...models.missing.map((x) => x.wanted), ...models.remaps.map((x) => `${x.wanted} (has ${x.using})`)];
    return { status: nodes.length || missingModels.length ? 'missing' : 'ok', missingNodes: nodes, missingModels, basis: caps.nodes.basis };
  }
}
