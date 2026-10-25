/**
 * Comfy API v2 jobs, run by the server through the official SDK
 * (@comfyorg/sdk 0.5.0) on Comfy Cloud, a deployment or comfy-api-proxy.
 *
 * The Flow window and the engine both come through here, so the key never
 * leaves the server: the window uploads its inputs and polls its job over
 * /api/run/<resource>/…, the engine calls these methods directly.
 *
 *   upload    client.assets.fromBytes / fromFile → asReference() (blake3 dedup: bytes the server has are not sent again)
 *   submit    client.submit(workflow, { idempotencyKey }) — one key per Generate; a 429 is retried under the same key
 *   status    client.jobs.get(id) — the poll is the source of truth (v2 "Poll first")
 *   output    Output.toBytes()
 *   cancel    Job.cancel()
 *
 * When a job finishes, its run goes into the run history with the execution
 * time the server reported (`metrics.execution_ms`) and the credits derived
 * from it — no endpoint returns a per-job cost — and the balance is read again.
 */

import { randomUUID } from 'node:crypto';
import {
  ComfyError, Forbidden, IdempotencyKeyReuse, InsufficientCredits, InvalidWorkflow, JobFailed, MissingAsset, MissingCredentials,
  NotFound, QueueFull, Unauthorized, WorkflowFormatUi, type Job, type Output,
} from '@comfyorg/sdk';
import { creditsFor, type RunRecord } from '../core/cost/estimate.ts';
import type { Resource, ResourceRegistry } from './resources.ts';
import type { RunLog } from './runs.ts';

export interface RunMeta {
  workflowId: string;
  slotSeconds: number | null;
  scaleWithSlot: boolean;
  source: 'flow' | 'engine';
}

export interface JobView {
  id: string;
  resourceId: string;
  status: string;
  queuePosition: number | null;
  progress: { value: number; nodesDone: number | null; nodesTotal: number | null; currentNode: string | null; currentNodeClass: string | null; step: number | null; steps: number | null } | null;
  outputs: Array<{ id: string; name: string; nodeId: string; contentType: string; type: string; sizeBytes: number; url: string }>;
  error: { code: string; message: string; nodeId?: string | null; classType?: string | null } | null;
  createdAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  executionMs: number | null;
  timing: RunRecord['timing'] | null;
  /** Credits derived from the execution time; null where nothing bills. */
  derivedCredits: number | null;
  creditsPerHour: number | null;
  gpuLabel: string | null;
}

/** An error in words the Flow window shows as they are, with what to do. */
export class RunError extends Error {
  status: number;
  code: string;
  action?: 'run-locally' | 'add-key' | 'check-key' | 'retry';
  constructor(message: string, status: number, code: string, action?: RunError['action']) {
    super(message);
    this.status = status;
    this.code = code;
    this.action = action;
  }
}

/** The codes the v2 contract documents (ErrorEnvelope in the SDK's types.gen.d.ts), and what to do about each. */
const HINTS: Record<string, string> = {
  workflow_format_ui: 'This is an editor-format file. Export the workflow from ComfyUI in API format and import that.',
  deployment_stopped: 'The deployment is stopped. `comfy deploy start` resumes it — and its billing.',
  deployment_not_ready: 'The deployment is still starting a worker. Try again in a moment.',
  queue_full: 'The queue is full. Try again in a moment.',
  missing_asset: 'An input the workflow names is not on this server. Run it from JustAE Flow so the inputs are uploaded.',
};

export function mapV2Error(e: unknown, r: Resource): RunError {
  if (e instanceof RunError) return e;
  const who = r.label;
  if (e instanceof InsufficientCredits) {
    return new RunError(`${who}: the account behind this key is out of credits (402 insufficient_credits). Run this one on Local, or top up at platform.comfy.org.`, 402, 'insufficient_credits', 'run-locally');
  }
  if (e instanceof MissingCredentials) return new RunError(`${who}: no API key yet — add it in Settings ▸ Resources.`, 401, 'missing_credentials', 'add-key');
  // The server's own words come along: a refusal says why (a plan without API access, a key without the scope…).
  const said = (x: ComfyError): string => (x.message ? ` — ${x.code ? `${x.code}: ` : ''}${x.message}` : '');
  if (e instanceof Unauthorized) return new RunError(`${who}: the key was not accepted (401)${said(e)}. Check it in Settings ▸ Resources.`, 401, 'unauthorized', 'check-key');
  if (e instanceof Forbidden) return new RunError(`${who}: refused (403 forbidden)${said(e)}.`, 403, e.code ?? 'forbidden', 'run-locally');
  if (e instanceof WorkflowFormatUi) return new RunError(`${who}: ${HINTS.workflow_format_ui}`, 422, 'workflow_format_ui');
  if (e instanceof MissingAsset) return new RunError(`${who}: ${HINTS.missing_asset}`, 422, 'missing_asset');
  if (e instanceof InvalidWorkflow) {
    const detail = e.details ? ` — ${JSON.stringify(e.details).slice(0, 500)}` : '';
    return new RunError(`${who} rejected the workflow: ${e.message}${detail}`, e.httpStatus ?? 422, e.code ?? 'invalid_workflow');
  }
  if (e instanceof QueueFull) return new RunError(`${who}: ${HINTS.queue_full}`, 429, 'queue_full', 'retry');
  if (e instanceof IdempotencyKeyReuse) return new RunError(`${who}: this submit was already sent once (idempotency key reused); nothing was queued twice. Check the job list before trying again.`, 422, 'idempotency_key_reuse');
  if (e instanceof NotFound) return new RunError(`${who}: not found (404) — the job or asset is gone, or this is not a v2 endpoint.`, 404, e.code ?? 'not_found');
  if (e instanceof JobFailed) return new RunError(`${who}: the job failed — ${e.error?.message ?? e.message}`, 500, e.code ?? 'job_failed');
  if (e instanceof ComfyError) {
    const hint = e.code ? HINTS[e.code] : undefined;
    return new RunError(`${who}: ${e.code ? `${e.code}: ` : ''}${e.message}${hint ? `\n${hint}` : ''}`, e.httpStatus ?? 502, e.code ?? 'comfy_error', e.code === 'deployment_not_ready' ? 'retry' : undefined);
  }
  const msg = e instanceof Error ? e.message : String(e);
  return new RunError(`Could not reach ${who} (${r.url}): ${msg}`, 502, 'unreachable', 'retry');
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const TERMINAL = new Set(['succeeded', 'failed', 'canceled', 'expired']);

interface Tracked { resourceId: string; meta: RunMeta; submittedAt: number; recorded: boolean; last: Job | null }

export class V2Jobs {
  private registry: ResourceRegistry;
  private runs: RunLog;
  private tracked = new Map<string, Tracked>();
  private finished = new Set<(r: Resource) => void>();

  constructor(registry: ResourceRegistry, runs: RunLog) {
    this.registry = registry;
    this.runs = runs;
  }

  /** Told when a job on a resource finishes (the balance is read again). */
  onFinished(fn: (r: Resource) => void): () => void {
    this.finished.add(fn);
    return () => this.finished.delete(fn);
  }

  private resource(id: string): Resource {
    const r = this.registry.get(id);
    if (!r) throw new RunError(`No resource "${id}".`, 404, 'no_resource');
    if (r.kind === 'local') throw new RunError('The local ComfyUI runs over its own protocol, not through /api/run.', 400, 'wrong_protocol');
    const u = this.registry.usable(r);
    if (!u.ok) throw new RunError(`${r.label}: ${u.reason}.`, 400, 'not_usable', r.kind === 'proxy' ? undefined : 'add-key');
    return r;
  }

  async upload(resourceId: string, bytes: Uint8Array, filename: string, contentType: string): Promise<{ name: string; reference: unknown; deduped: boolean | null }> {
    const r = this.resource(resourceId);
    try {
      const asset = this.registry.sdk(r).assets.fromBytes(bytes, { filename, contentType });
      const reference = await asset.asReference();
      return { name: filename, reference, deduped: asset.createdNew === null ? null : !asset.createdNew };
    } catch (e) {
      throw mapV2Error(e, r);
    }
  }

  /** A file on disk, read lazily by the SDK (large clips are not held in memory). */
  async uploadFile(resourceId: string, path: string): Promise<unknown> {
    const r = this.resource(resourceId);
    try {
      return await this.registry.sdk(r).assets.fromFile(path).asReference();
    } catch (e) {
      throw mapV2Error(e, r);
    }
  }

  /**
   * One submission per Generate. A 429 (queue full, or a deployment still
   * starting a worker) creates no job; the SDK retries it for a minute, and
   * this goes on under the same Idempotency-Key for up to ten, so a submit that
   * did land can never become a second billed job.
   */
  async submit(resourceId: string, workflow: Record<string, unknown>, meta: RunMeta): Promise<{ jobId: string }> {
    const r = this.resource(resourceId);
    // A resource on record as refusing jobs is not asked again until the key changes or Check is pressed.
    const refused = this.registry.refusal(r);
    if (refused) throw new RunError(`${r.label} refuses jobs with this key: ${refused.message} (403, since ${refused.at.slice(0, 16).replace('T', ' ')} UTC). Run it on Local, or press Check in Settings ▸ Resources after changing the plan.`, 403, 'forbidden', 'run-locally');
    const client = this.registry.sdk(r);
    const wf = client.workflows.fromJson(workflow);
    const idempotencyKey = randomUUID();
    const giveUpAt = Date.now() + 10 * 60_000;
    for (;;) {
      try {
        const job = await client.submit(wf, { idempotencyKey });
        this.tracked.set(job.id, { resourceId, meta, submittedAt: Date.now(), recorded: false, last: job });
        return { jobId: job.id };
      } catch (e) {
        const retryable = e instanceof QueueFull || (e instanceof ComfyError && e.httpStatus === 429);
        if (retryable && Date.now() < giveUpAt) {
          const after = e instanceof ComfyError && e.retryAfter ? e.retryAfter : 5;
          await sleep(Math.min(Math.max(after, 1), 30) * 1000);
          continue;
        }
        // Measured on Comfy Cloud: a free-tier key gets 403 "API key authentication is not available for
        // free tier accounts" on every submit. Remember it, so routing stops sending jobs there.
        if (e instanceof Forbidden) this.registry.noteRefusal(r.id, e.message || 'forbidden');
        throw mapV2Error(e, r);
      }
    }
  }

  async status(resourceId: string, jobId: string): Promise<JobView> {
    const r = this.resource(resourceId);
    let job: Job;
    try {
      job = await this.registry.sdk(r).jobs.get(jobId);
    } catch (e) {
      throw mapV2Error(e, r);
    }
    const t = this.tracked.get(jobId);
    if (t) t.last = job;
    const view = this.view(r, job, t);
    if (TERMINAL.has(job.status) && t && !t.recorded) {
      t.recorded = true;
      if (job.status === 'succeeded') {
        this.runs.add({
          at: new Date().toISOString(), workflowId: t.meta.workflowId, resourceId: r.id, resourceKind: r.kind,
          gpu: this.registry.gpuLabel(r), executionMs: view.executionMs, timing: view.timing ?? 'wall', wallMs: Date.now() - t.submittedAt,
          slotSeconds: t.meta.slotSeconds, scaleWithSlot: t.meta.scaleWithSlot, derivedCredits: view.derivedCredits,
          creditsPerHour: this.registry.creditsPerHour(r), jobId,
        });
      }
      // A cancelled or failed job may have run (and billed) too: the balance is read again either way.
      for (const fn of this.finished) fn(r);
    }
    return view;
  }

  private view(r: Resource, job: Job, t: Tracked | undefined): JobView {
    const metrics = job.metrics ?? {};
    let executionMs: number | null = typeof metrics.execution_ms === 'number' ? metrics.execution_ms : null;
    let timing: JobView['timing'] = executionMs !== null ? 'execution_ms' : null;
    if (executionMs === null && job.startedAt && job.completedAt) {
      executionMs = job.completedAt.getTime() - job.startedAt.getTime();
      timing = 'started→completed';
    }
    if (executionMs === null && TERMINAL.has(job.status) && t) {
      executionMs = Date.now() - t.submittedAt;
      timing = 'wall';
    }
    const rate = this.registry.creditsPerHour(r);
    const p = job.progress;
    return {
      id: job.id, resourceId: r.id, status: job.status, queuePosition: job.queuePosition,
      progress: p ? { value: p.value, nodesDone: p.nodesDone, nodesTotal: p.nodesTotal, currentNode: p.currentNode, currentNodeClass: p.currentNodeClass, step: p.step, steps: p.steps } : null,
      outputs: job.outputs.map((o: Output) => ({
        id: o.id, name: o.name, nodeId: o.nodeId, contentType: o.contentType, type: String(o.type), sizeBytes: o.sizeBytes,
        url: `/api/run/${encodeURIComponent(r.id)}/jobs/${encodeURIComponent(job.id)}/outputs/${encodeURIComponent(o.id)}`,
      })),
      error: job.error ? { code: job.error.code, message: job.error.message, nodeId: job.error.node_id, classType: job.error.class_type } : null,
      createdAt: job.createdAt?.toISOString() ?? null, startedAt: job.startedAt?.toISOString() ?? null, completedAt: job.completedAt?.toISOString() ?? null,
      executionMs, timing,
      derivedCredits: rate !== null && executionMs !== null ? creditsFor(executionMs, rate) : null,
      creditsPerHour: rate, gpuLabel: this.registry.gpuLabel(r),
    };
  }

  async output(resourceId: string, jobId: string, outputId: string): Promise<{ bytes: Uint8Array; contentType: string; name: string }> {
    const r = this.resource(resourceId);
    try {
      const job = this.tracked.get(jobId)?.last ?? await this.registry.sdk(r).jobs.get(jobId);
      let out = job.outputs.find((o) => o.id === outputId);
      if (!out) {
        const fresh = await this.registry.sdk(r).jobs.get(jobId);
        out = fresh.outputs.find((o) => o.id === outputId);
      }
      if (!out) throw new RunError(`${r.label}: job ${jobId} has no output ${outputId}.`, 404, 'no_output');
      return { bytes: await out.toBytes({ timeoutMs: 900_000 }), contentType: out.contentType, name: out.name };
    } catch (e) {
      throw mapV2Error(e, r);
    }
  }

  async cancel(resourceId: string, jobId: string): Promise<string> {
    const r = this.resource(resourceId);
    try {
      const job = await this.registry.sdk(r).jobs.get(jobId);
      await job.cancel();
      return job.status;
    } catch (e) {
      throw mapV2Error(e, r);
    }
  }

  /**
   * Reachability without a job. Proxy and deployment: `GET /api/v2/jobs?limit=1`.
   * Comfy Cloud: the v1 `GET /api/user` with the key, the documented account
   * check (v1 Cloud API Overview, "Authentication").
   */
  async health(resourceId: string): Promise<{ online: boolean; message?: string; status?: number }> {
    const r = this.registry.get(resourceId);
    if (!r) return { online: false, message: `No resource "${resourceId}".` };
    const u = this.registry.usable(r);
    if (!u.ok) return { online: false, message: u.reason };
    const token = this.registry.tokenFor(r);
    try {
      const res = r.kind === 'cloud'
        ? await fetch(`${r.url}/api/user`, { headers: { 'X-API-Key': token ?? '' }, signal: AbortSignal.timeout(15_000) })
        : await fetch(`${r.url}/api/v2/jobs?limit=1`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(15_000) });
      if (res.ok) return { online: true, status: res.status };
      if (res.status === 401 || res.status === 403) return { online: false, status: res.status, message: 'The server is up but did not accept the key.' };
      if (res.status === 404) return { online: false, status: 404, message: 'This address answers, but has no Comfy API v2.' };
      if (res.status === 429 && r.kind === 'cloud') return { online: false, status: 429, message: 'The key is on an inactive subscription (429).' };
      return { online: false, status: res.status, message: `HTTP ${res.status}` };
    } catch (e) {
      return { online: false, message: e instanceof Error ? e.message : String(e) };
    }
  }
}
