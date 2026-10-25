/**
 * HTTP routes for resources, credits, estimates and v2 jobs.
 *
 *   GET  /api/resources                       the registry and the task table (no secrets: whether a key is set, its last 4)
 *   PUT  /api/resources                       change them; the only way a key gets in (written to the config folder)
 *   POST /api/resources/migrate               the Flow window's old local-storage settings, once
 *   GET  /api/resources/:id/capabilities      nodes and models there, per bundled workflow (?force=1 to probe again)
 *   POST /api/resources/:id/check             reachability and the key, without a job
 *   POST /api/resources/:id/check-graph       a graph of the Flow window's own library against that resource
 *   POST /api/resources/resolve               where a run of this task goes, and why
 *   GET  /api/credits                         the balance from the billing report (?force=1)
 *   POST /api/estimate                        ≈ credits and time, from the run history
 *   GET  /api/runs  ·  POST /api/runs         the run history (the Flow window reports its local runs)
 *   POST /api/run/:id/upload                  an input, as a v2 asset (raw body, X-Filename)
 *   POST /api/run/:id/jobs                    submit {workflow, meta}
 *   GET  /api/run/:id/jobs/:job               status, progress, outputs, execution time, derived credits
 *   GET  /api/run/:id/jobs/:job/outputs/:out  an output's bytes
 *   POST /api/run/:id/jobs/:job/cancel
 *
 * Routes that write a secret or can spend credits want the page's session
 * token, like the host and file routes (bridge.ts).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { describeEstimate, estimateRun, sumEstimates, type Estimate, type RunRecord } from '../core/cost/estimate.ts';
import type { WorkflowJson } from '../core/comfy/types.ts';
import { tokenOk } from './bridge.ts';
import type { Engine } from './engine.ts';
import { TASKS, taskOf, type Resource, type ResourcePatch, type TaskId } from './resources.ts';
import type { Services } from './services.ts';
import { RunError } from './v2run.ts';

type Handler = (req: IncomingMessage, res: ServerResponse, m: RegExpExecArray, url: URL) => Promise<void> | void;

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function body(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error('Request too large.');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

async function json<T>(req: IncomingMessage, limit = 64 * 1024 * 1024): Promise<T> {
  const b = await body(req, limit);
  return (b.length ? JSON.parse(b.toString('utf8')) : {}) as T;
}

function guarded(fn: Handler): Handler {
  return async (req, res, m, url) => {
    if (!tokenOk(req, url)) return send(res, 403, { error: 'This page was not served by this JustAE Flow session — reload it.' });
    try {
      await fn(req, res, m, url);
    } catch (e) {
      if (e instanceof RunError) return send(res, e.status >= 400 && e.status < 600 ? e.status : 502, { error: e.message, code: e.code, action: e.action });
      send(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  };
}

function open(fn: Handler): Handler {
  return async (req, res, m, url) => {
    try {
      await fn(req, res, m, url);
    } catch (e) {
      if (e instanceof RunError) return send(res, e.status, { error: e.message, code: e.code, action: e.action });
      send(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  };
}

export interface EstimateRequest {
  resource?: string;
  task?: TaskId;
  shots: Array<{ workflowId: string; seconds?: number | null; scaleWithSlot?: boolean; resource?: string; task?: TaskId }>;
}

/** The resource a shot of the Flow window runs on: its own pick, the batch's, or the task's row. */
function pickFor(s: Services, task: TaskId, override: string | undefined, workflowId: string, engine: Engine): Resource {
  const entry = engine.libraryEntry(workflowId);
  return s.resources.resolve(entry ? taskOf(entry.manifest.task, entry.manifest.id) : task, override, (r) => s.caps.has(r, workflowId)).resource;
}

export function estimate(s: Services, engine: Engine, q: EstimateRequest): {
  shots: Array<Estimate & { workflowId: string; resource: string; label: string; text: string }>;
  total: Estimate & { shots: number; unknown: number; text: string; resources: string[] };
} {
  const shots = (q.shots ?? []).map((shot) => {
    // A workflow of the Flow window's own library has no manifest: a still is an image task, a clip a video one.
    const r = pickFor(s, shot.task ?? q.task ?? (shot.scaleWithSlot === false ? 'image' : 'video'), shot.resource ?? q.resource, shot.workflowId, engine);
    const entry = engine.libraryEntry(shot.workflowId);
    const scaleWithSlot = shot.scaleWithSlot ?? (entry ? entry.manifest.output === 'video' : true);
    const gpu = s.resources.gpuLabel(r);
    const e = estimateRun(s.runs.of(shot.workflowId, r.id, gpu), {
      slotSeconds: shot.seconds ?? null, scaleWithSlot, creditsPerHour: s.resources.creditsPerHour(r), gpuLabel: gpu,
    });
    return { ...e, workflowId: shot.workflowId, resource: r.id, label: r.label, text: describeEstimate(e, r.label) };
  });
  const sum = sumEstimates(shots);
  const resources = [...new Set(shots.map((x) => x.resource))];
  const where = resources.length === 1 ? shots[0].label : `${resources.length} resources`;
  return { shots, total: { ...sum, resources, text: shots.length ? describeEstimate(sum, where) : '' } };
}

export function resourceRoutes(s: Services, engine: Engine): Array<[string, RegExp, Handler]> {
  const view = () => {
    const v = s.resources.view();
    return { ...v, capabilities: Object.fromEntries(v.resources.map((r) => [r.id, s.caps.cached(r.id)])) };
  };
  return [
    ['GET', /^\/api\/resources$/, open((_q, res) => send(res, 200, view()))],
    ['PUT', /^\/api\/resources$/, guarded(async (req, res) => {
      const patch = await json<ResourcePatch>(req, 1024 * 1024);
      for (const r of patch.resources ?? []) if (r.id === 'new') r.id = s.resources.nextDeploymentId();
      s.resources.update(patch);
      s.caps.warm();
      send(res, 200, view());
    })],
    ['POST', /^\/api\/resources\/migrate$/, guarded(async (req, res) => {
      const moved = s.resources.migrate(await json(req, 1024 * 1024));
      send(res, 200, { ...moved, resources: view() });
    })],
    ['GET', /^\/api\/resources\/([\w-]+)\/capabilities$/, open(async (_q, res, m, url) => {
      send(res, 200, await s.caps.get(m[1], url.searchParams.get('force') === '1'));
    })],
    ['POST', /^\/api\/resources\/([\w-]+)\/check$/, guarded(async (_q, res, m) => {
      const r = s.resources.get(m[1]);
      if (!r) return send(res, 404, { error: `No resource "${m[1]}".` });
      const caps = await s.caps.get(r.id, true);
      const health = r.kind === 'local' ? { online: caps.online, message: caps.message } : await s.v2.health(r.id);
      send(res, 200, { ...health, capabilities: caps });
    })],
    ['POST', /^\/api\/resources\/([\w-]+)\/check-graph$/, guarded(async (req, res, m) => {
      const { graph } = await json<{ graph: WorkflowJson }>(req);
      send(res, 200, await s.caps.checkGraph(m[1], graph));
    })],
    ['POST', /^\/api\/resources\/resolve$/, open(async (req, res) => {
      const q = await json<{ task?: TaskId; override?: string | null; workflowId?: string; graph?: WorkflowJson }>(req);
      const entry = q.workflowId ? engine.libraryEntry(q.workflowId) : undefined;
      const task: TaskId = entry ? taskOf(entry.manifest.task, entry.manifest.id) : TASKS.some((t) => t.id === q.task) ? q.task! : 'video';
      // A graph of the Flow window's own library is checked against each resource the probe knows.
      const verdicts = new Map<string, 'ok' | 'missing' | 'unknown'>();
      if (q.graph && !entry) {
        for (const r of s.resources.list()) {
          if (!s.resources.usable(r).ok) continue;
          verdicts.set(r.id, (await s.caps.checkGraph(r.id, q.graph).catch(() => ({ status: 'unknown' as const }))).status);
        }
      }
      const out = s.resources.resolve(task, q.override, (r) => (entry ? s.caps.has(r, entry.manifest.id) : verdicts.get(r.id) ?? 'unknown'));
      send(res, 200, { task, resource: out.resource.id, label: out.resource.label, kind: out.resource.kind, why: out.why, auto: out.auto, metered: s.resources.creditsPerHour(out.resource) !== null });
    })],
    ['GET', /^\/api\/credits$/, open(async (_q, res, _m, url) => send(res, 200, await s.credits.get(url.searchParams.get('force') === '1')))],
    ['POST', /^\/api\/estimate$/, open(async (req, res) => send(res, 200, estimate(s, engine, await json<EstimateRequest>(req, 1024 * 1024))))],
    ['GET', /^\/api\/runs$/, open((_q, res) => send(res, 200, { runs: s.runs.recent(100) }))],
    ['POST', /^\/api\/runs$/, guarded(async (req, res) => {
      const r = await json<Partial<RunRecord>>(req, 64 * 1024);
      const resource = r.resourceId ? s.resources.get(r.resourceId) : undefined;
      if (!resource || !r.workflowId || typeof r.wallMs !== 'number') return send(res, 400, { error: 'A run needs workflowId, resourceId and wallMs.' });
      const rate = s.resources.creditsPerHour(resource);
      const executionMs = typeof r.executionMs === 'number' && r.executionMs > 0 ? r.executionMs : null;
      s.runs.add({
        at: new Date().toISOString(), workflowId: r.workflowId, resourceId: resource.id, resourceKind: resource.kind, gpu: s.resources.gpuLabel(resource),
        executionMs, timing: executionMs !== null ? (r.timing ?? 'execution_ms') : 'wall', wallMs: r.wallMs,
        slotSeconds: typeof r.slotSeconds === 'number' && r.slotSeconds > 0 ? r.slotSeconds : null, scaleWithSlot: r.scaleWithSlot ?? true,
        derivedCredits: rate !== null && executionMs !== null ? (executionMs / 3_600_000) * rate : null, creditsPerHour: rate, jobId: r.jobId,
      });
      send(res, 200, { ok: true });
    })],
    ['POST', /^\/api\/run\/([\w-]+)\/upload$/, guarded(async (req, res, m) => {
      const name = decodeURIComponent(String(req.headers['x-filename'] ?? 'input.png'));
      const type = String(req.headers['content-type'] ?? 'application/octet-stream');
      send(res, 200, await s.v2.upload(m[1], new Uint8Array(await body(req, 2 * 1024 * 1024 * 1024)), name, type));
    })],
    ['POST', /^\/api\/run\/([\w-]+)\/jobs$/, guarded(async (req, res, m) => {
      const q = await json<{ workflow: Record<string, unknown>; meta?: { workflowId?: string; slotSeconds?: number | null; scaleWithSlot?: boolean } }>(req);
      send(res, 200, await s.v2.submit(m[1], q.workflow, {
        workflowId: q.meta?.workflowId ?? 'unknown', slotSeconds: q.meta?.slotSeconds ?? null, scaleWithSlot: q.meta?.scaleWithSlot ?? true, source: 'flow',
      }));
    })],
    // Job and asset ids are the server's own strings: comfy-api-proxy's asset ids carry dots (measured), so any path segment.
    ['GET', /^\/api\/run\/([\w-]+)\/jobs\/([^/]+)$/, guarded(async (_q, res, m) => send(res, 200, await s.v2.status(m[1], decodeURIComponent(m[2]))))],
    ['GET', /^\/api\/run\/([\w-]+)\/jobs\/([^/]+)\/outputs\/([^/]+)$/, guarded(async (_q, res, m) => {
      const out = await s.v2.output(m[1], decodeURIComponent(m[2]), decodeURIComponent(m[3]));
      res.writeHead(200, { 'Content-Type': out.contentType || 'application/octet-stream', 'Content-Length': out.bytes.length, 'X-Filename': encodeURIComponent(out.name), 'Cache-Control': 'no-store' });
      res.end(Buffer.from(out.bytes));
    })],
    ['POST', /^\/api\/run\/([\w-]+)\/jobs\/([^/]+)\/cancel$/, guarded(async (_q, res, m) => send(res, 200, { status: await s.v2.cancel(m[1], decodeURIComponent(m[2])) }))],
  ];
}

/** The resource the panel line names: the running job's, else the Flow window's pick, else Auto for video. */
export function activeResource(s: Services, engine: Engine): { id: string; label: string; kind: Resource['kind']; metered: boolean; running: boolean } {
  const st = engine.state();
  const running = st.cards.find((c) => c.id === st.queue.running)?.runsOn;
  if (running) return { id: running.id, label: running.label, kind: running.kind, metered: running.metered, running: true };
  const choice = s.resources.choice();
  const picked = choice !== 'default' && choice !== 'auto' ? s.resources.get(choice) : undefined;
  const r = picked && s.resources.usable(picked).ok ? picked : s.resources.resolve('video', choice === 'auto' ? 'auto' : null, () => 'unknown').resource;
  return { id: r.id, label: r.label, kind: r.kind, metered: s.resources.creditsPerHour(r) !== null, running: false };
}
