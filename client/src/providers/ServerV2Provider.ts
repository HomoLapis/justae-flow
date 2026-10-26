/**
 * Comfy API v2 — Comfy Cloud, a deployment, or your ComfyUI behind
 * comfy-api-proxy — run by the JustAE Flow server through the official SDK
 * (@comfyorg/sdk, server/v2run.ts).
 *
 * This page never holds the key: it uploads its inputs to the server, which
 * turns them into v2 assets; it submits the API-format graph to the server,
 * which submits it under one Idempotency-Key; it polls the server for the
 * job, and downloads outputs from the server's own route. The server keeps
 * the run history and derives the credits from the execution time.
 */

import { serverHeaders, serverJson } from '../bridge/server';
import { HttpError } from './ComfyHttpProvider';
import type {
  OutputFile, ProviderEvent, ProviderHealth, SubmitCtx, UploadResult, VideoProvider, WorkflowJson,
} from './types';
import type { ResourceView } from '../lib/resources';

/** An error from the server's v2 route, with what to do about it (402 → run locally). */
export class RunError extends Error {
  constructor(message: string, readonly status: number, readonly code: string, readonly action?: string) {
    super(message);
    this.name = 'RunError';
  }
}

interface JobView {
  id: string;
  status: string;
  queuePosition: number | null;
  progress: { value: number; nodesDone: number | null; nodesTotal: number | null; currentNode: string | null; step: number | null; steps: number | null } | null;
  outputs: Array<{ id: string; name: string; nodeId: string; contentType: string; url: string }>;
  error: { code: string; message: string; classType?: string | null } | null;
  startedAt: string | null;
  executionMs: number | null;
  timing: string | null;
  derivedCredits: number | null;
  creditsPerHour: number | null;
  /** What derivedCredits counts (a deployment: its worker's start-up and idle window too). */
  costBasis?: string | null;
}

function bucketFor(contentType: string): string {
  if (contentType.startsWith('video/')) return 'video';
  if (contentType.startsWith('audio/')) return 'audio';
  return 'images';
}

async function failure(r: Response): Promise<RunError> {
  let body: { error?: string; code?: string; action?: string } = {};
  try { body = await r.json() as typeof body; } catch { /* not JSON */ }
  return new RunError(body.error ?? `HTTP ${r.status}`, r.status, body.code ?? '', body.action);
}

export class ServerV2Provider implements VideoProvider {
  readonly id = 'comfy-v2' as const;
  readonly label: string;
  readonly requiresApiKey: boolean;
  readonly resourceId: string;
  private base: string;
  private last = new Map<string, JobView>();

  constructor(resource: ResourceView) {
    this.resourceId = resource.id;
    this.label = resource.label;
    this.requiresApiKey = resource.needsKey === 'platform';
    this.base = `/api/run/${encodeURIComponent(resource.id)}`;
  }

  async health(): Promise<ProviderHealth> {
    try {
      const h = await serverJson<{ online: boolean; message?: string }>(`/api/resources/${encodeURIComponent(this.resourceId)}/check`, {});
      return { online: h.online, message: h.message };
    } catch (e) {
      return { online: false, message: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Bytes the platform already has (blake3) are not sent again — the SDK checks. */
  async uploadInput(file: Blob, filename: string): Promise<UploadResult> {
    const r = await fetch(`${this.base}/upload`, {
      method: 'POST',
      headers: serverHeaders({ 'Content-Type': file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(filename) }),
      body: file,
    });
    if (!r.ok) throw await failure(r);
    const data = await r.json() as { name: string; reference: unknown };
    return { name: data.name, reference: data.reference };
  }

  async submit(workflow: WorkflowJson, ctx: SubmitCtx): Promise<{ jobId: string }> {
    const r = await fetch(`${this.base}/jobs`, {
      method: 'POST',
      headers: serverHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ workflow, meta: ctx.meta }),
    });
    if (!r.ok) throw await failure(r);
    return { jobId: (await r.json() as { jobId: string }).jobId };
  }

  private async job(jobId: string): Promise<JobView> {
    const r = await fetch(`${this.base}/jobs/${encodeURIComponent(jobId)}`, { headers: serverHeaders() });
    if (!r.ok) throw await failure(r);
    const v = await r.json() as JobView;
    this.last.set(jobId, v);
    return v;
  }

  /** Polled every two seconds: a v2 snapshot is complete, so a missed poll costs nothing. */
  watch(jobId: string, _ctx: SubmitCtx, onEvent: (e: ProviderEvent) => void): () => void {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastStatus = '';
    const tick = async (): Promise<void> => {
      if (stopped) return;
      try {
        const v = await this.job(jobId);
        onEvent({ kind: 'meter', status: v.status, startedAt: v.startedAt, executionMs: v.executionMs, timing: v.timing, derivedCredits: v.derivedCredits, creditsPerHour: v.creditsPerHour, costBasis: v.costBasis ?? null });
        if (v.status !== lastStatus) {
          lastStatus = v.status;
          if (v.status === 'queued') onEvent({ kind: 'queued' });
        }
        if (v.progress) {
          if (v.progress.currentNode) onEvent({ kind: 'executing', nodeId: v.progress.currentNode });
          const steps = v.progress.steps && v.progress.steps > 0;
          onEvent({ kind: 'progress', value: steps ? v.progress.step ?? 0 : v.progress.nodesDone ?? Math.round(v.progress.value * 100), max: steps ? v.progress.steps! : v.progress.nodesTotal ?? 100 });
        }
        if (v.status === 'succeeded') { stopped = true; onEvent({ kind: 'output', outputs: this.files(v) }); onEvent({ kind: 'done' }); return; }
        if (v.status === 'failed' || v.status === 'expired') {
          stopped = true;
          onEvent({ kind: 'error', message: `${this.label}: ${v.error?.message ?? `the job ${v.status}`}${v.error?.classType ? ` (in ${v.error.classType})` : ''}` });
          return;
        }
        if (v.status === 'canceled') { stopped = true; onEvent({ kind: 'error', message: 'The job was cancelled.' }); return; }
      } catch { /* a lost poll is not a lost job */ }
      if (!stopped) timer = setTimeout(() => void tick(), 2000);
    };
    void tick();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }

  private files(v: JobView): OutputFile[] {
    return v.outputs.map((o) => ({ filename: o.name || o.id, subfolder: '', type: 'output', bucket: bucketFor(o.contentType), nodeId: o.nodeId, url: o.url, assetId: o.id }));
  }

  async fetchOutputs(jobId: string): Promise<OutputFile[]> {
    return this.files(await this.job(jobId));
  }

  async download(out: OutputFile): Promise<Blob> {
    if (!out.url) throw new HttpError('This output has no address on the server.', 404);
    const r = await fetch(out.url, { headers: serverHeaders() });
    if (!r.ok) throw await failure(r);
    return await r.blob();
  }

  async cancel(jobId: string): Promise<void> {
    await fetch(`${this.base}/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST', headers: serverHeaders() }).catch(() => undefined);
  }

  /** The execution time the server reported for a finished job. */
  async executionMs(jobId: string): Promise<number | null> {
    return (this.last.get(jobId) ?? await this.job(jobId)).executionMs;
  }

  /** v2 has no workflow folder and no editor. */
  workflows(): null {
    return null;
  }

  editorUrl(): string | null {
    return null;
  }
}
