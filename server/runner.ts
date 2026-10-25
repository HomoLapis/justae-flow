/**
 * One job on one resource, the same five verbs whichever protocol it speaks:
 * the engine's layer tools and the PhotoCraft storyboard run through this.
 *
 *   LocalRunner  a ComfyUI over its own HTTP + WebSocket protocol (core/comfy/client.ts)
 *   V2Runner     Comfy API v2 through the SDK (server/v2run.ts): Comfy Cloud, a deployment, the proxy
 */

import type { ComfyClient } from '../core/comfy/client.ts';
import type { OutputFile, ProviderEvent, WorkflowJson } from '../core/comfy/types.ts';
import type { Resource } from './resources.ts';
import type { JobView, RunMeta, V2Jobs } from './v2run.ts';

export interface JobMeter {
  executionMs: number | null;
  derivedCredits: number | null;
}

export interface Runner {
  readonly resource: Resource;
  /** It bills by GPU time (Comfy Cloud, a deployment). */
  readonly metered: boolean;
  /** Whatever goes into the graph in place of a filename: a name (local) or a core/ASSET reference (v2). */
  upload(bytes: Uint8Array, filename: string, mime: string): Promise<unknown>;
  uploadFile(path: string, bytes: () => Uint8Array, filename: string, mime: string): Promise<unknown>;
  submit(api: WorkflowJson, meta: RunMeta, opts?: { previewMethod?: 'auto' }): Promise<string>;
  watch(jobId: string, onEvent: (e: ProviderEvent) => void): () => void;
  download(out: OutputFile): Promise<Uint8Array>;
  cancel(jobId: string): Promise<void>;
  /** Execution time and derived credits of a finished job. */
  meter(jobId: string): Promise<JobMeter>;
}

export class LocalRunner implements Runner {
  readonly resource: Resource;
  readonly metered = false;
  private comfy: ComfyClient;
  private clientId: string;

  constructor(resource: Resource, comfy: ComfyClient, clientId: string) {
    this.resource = resource;
    this.comfy = comfy;
    this.clientId = clientId;
  }

  upload(bytes: Uint8Array, filename: string, mime: string): Promise<unknown> {
    return this.comfy.upload(bytes, filename, mime);
  }

  uploadFile(_path: string, bytes: () => Uint8Array, filename: string, mime: string): Promise<unknown> {
    return this.comfy.upload(bytes(), filename, mime);
  }

  submit(api: WorkflowJson, _meta: RunMeta, opts: { previewMethod?: 'auto' } = {}): Promise<string> {
    return this.comfy.submit(api, this.clientId, opts);
  }

  watch(jobId: string, onEvent: (e: ProviderEvent) => void): () => void {
    return this.comfy.watch(jobId, this.clientId, onEvent);
  }

  download(out: OutputFile): Promise<Uint8Array> {
    return this.comfy.download(out);
  }

  cancel(jobId: string): Promise<void> {
    return this.comfy.cancel(jobId);
  }

  async meter(jobId: string): Promise<JobMeter> {
    return { executionMs: await this.comfy.executionMs(jobId), derivedCredits: null };
  }
}

function bucketFor(contentType: string): string {
  if (contentType.startsWith('video/')) return 'video';
  if (contentType.startsWith('audio/')) return 'audio';
  return 'images';
}

export function outputFilesOf(view: JobView): OutputFile[] {
  return view.outputs.map((o) => ({ filename: o.name || o.id, subfolder: '', type: 'output', bucket: bucketFor(o.contentType), nodeId: o.nodeId, assetId: o.id, jobId: view.id }));
}

export class V2Runner implements Runner {
  readonly resource: Resource;
  readonly metered: boolean;
  private jobs: V2Jobs;
  private last = new Map<string, JobView>();

  constructor(resource: Resource, jobs: V2Jobs, metered: boolean) {
    this.resource = resource;
    this.jobs = jobs;
    this.metered = metered;
  }

  async upload(bytes: Uint8Array, filename: string, mime: string): Promise<unknown> {
    return (await this.jobs.upload(this.resource.id, bytes, filename, mime)).reference;
  }

  uploadFile(path: string): Promise<unknown> {
    return this.jobs.uploadFile(this.resource.id, path);
  }

  async submit(api: WorkflowJson, meta: RunMeta): Promise<string> {
    return (await this.jobs.submit(this.resource.id, api as unknown as Record<string, unknown>, meta)).jobId;
  }

  /** Polled every two seconds: the v2 snapshot is complete, so a missed poll costs nothing. */
  watch(jobId: string, onEvent: (e: ProviderEvent) => void): () => void {
    let stopped = false;
    let lastStatus = '';
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async (): Promise<void> => {
      if (stopped) return;
      try {
        const v = await this.jobs.status(this.resource.id, jobId);
        this.last.set(jobId, v);
        if (v.status !== lastStatus) {
          lastStatus = v.status;
          if (v.status === 'queued') onEvent({ kind: 'queued' });
        }
        if (v.progress) {
          if (v.progress.currentNode) onEvent({ kind: 'executing', nodeId: v.progress.currentNode });
          const steps = v.progress.steps && v.progress.steps > 0;
          onEvent({ kind: 'progress', value: steps ? v.progress.step ?? 0 : v.progress.nodesDone ?? Math.round(v.progress.value * 100), max: steps ? v.progress.steps! : v.progress.nodesTotal ?? 100 });
        }
        if (v.status === 'succeeded') { stopped = true; onEvent({ kind: 'output', outputs: outputFilesOf(v) }); onEvent({ kind: 'done' }); return; }
        if (v.status === 'failed' || v.status === 'expired') { stopped = true; onEvent({ kind: 'error', message: `${this.resource.label}: ${v.error?.message ?? `the job ${v.status}`}${v.error?.classType ? ` (in ${v.error.classType})` : ''}` }); return; }
        if (v.status === 'canceled') { stopped = true; onEvent({ kind: 'error', message: 'Canceled.' }); return; }
      } catch { /* a lost poll is not a lost job */ }
      if (!stopped) timer = setTimeout(() => void tick(), 2000);
    };
    void tick();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }

  async download(out: OutputFile): Promise<Uint8Array> {
    if (!out.assetId || !out.jobId) throw new Error('A v2 output without its asset id cannot be fetched.');
    return (await this.jobs.output(this.resource.id, out.jobId, out.assetId)).bytes;
  }

  async cancel(jobId: string): Promise<void> {
    await this.jobs.cancel(this.resource.id, jobId).catch(() => undefined);
  }

  async meter(jobId: string): Promise<JobMeter> {
    const v = this.last.get(jobId) ?? await this.jobs.status(this.resource.id, jobId);
    return { executionMs: v.executionMs, derivedCredits: v.derivedCredits };
  }
}
