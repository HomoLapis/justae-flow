/**
 * A ComfyUI server spoken to over its own HTTP + WebSocket protocol:
 *
 *   POST /api/prompt            queue a job (with a prompt_id we choose)
 *   GET  /api/history/{id}      outputs of a finished job
 *   GET  /api/view              download an output
 *   POST /api/upload/image      upload an input (any file type lands in input/)
 *   GET  /api/object_info       node schemas
 *   GET  /templates/{name}.json the official workflow templates the server ships
 *   WS   /ws?clientId=…         progress, previews, outputs
 *
 * Runs in Node, so there is no CORS and no preflight to worry about.
 */

import { extractOutputs, type HistoryOutputs } from './outputs.ts';
import type { ObjectInfo, OutputFile, ProviderEvent, WorkflowJson } from './types.ts';

export class HttpError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export interface ComfyHealth {
  online: boolean;
  version?: string;
  device?: string;
  vramFreeGb?: number;
  message?: string;
}

/** Statuses that mean "no considered answer yet" — worth asking again. */
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

export class ComfyClient {
  readonly base: string;
  private objectInfoCache: ObjectInfo | null = null;

  constructor(baseUrl: string) {
    this.base = baseUrl.replace(/\/+$/, '');
  }

  private async req(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 30_000);
    try {
      return await fetch(path.startsWith('http') ? path : `${this.base}${path}`, { ...init, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private async json<T>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
    const r = await this.req(path, init);
    const text = await r.text();
    if (!r.ok) throw new HttpError(`HTTP ${r.status} — ${text.slice(0, 300)}`, r.status);
    return JSON.parse(text) as T;
  }

  async health(): Promise<ComfyHealth> {
    try {
      const s = await this.json<{
        system?: { comfyui_version?: string };
        devices?: Array<{ name?: string; vram_free?: number }>;
      }>('/api/system_stats', { timeoutMs: 5_000 });
      const d = s.devices?.[0];
      return {
        online: true,
        version: s.system?.comfyui_version,
        device: d?.name?.replace(/^cuda:\d+\s*/, '').replace(/\s*:\s*[A-Za-z]+$/, ''),
        vramFreeGb: typeof d?.vram_free === 'number' ? Math.round((d.vram_free / 2 ** 30) * 10) / 10 : undefined,
      };
    } catch (e) {
      return { online: false, message: `Cannot reach ComfyUI at ${this.base} (${e instanceof Error ? e.message : e})` };
    }
  }

  async objectInfo(force = false): Promise<ObjectInfo> {
    if (this.objectInfoCache && !force) return this.objectInfoCache;
    this.objectInfoCache = await this.json<ObjectInfo>('/api/object_info', { timeoutMs: 240_000 });
    return this.objectInfoCache;
  }

  /** An official template from the server's own template package, or null. */
  async template(name: string): Promise<unknown | null> {
    const r = await this.req(`/templates/${encodeURIComponent(name)}.json`, { timeoutMs: 30_000 });
    if (!r.ok) return null;
    return JSON.parse(await r.text()) as unknown;
  }

  async upload(bytes: Uint8Array, filename: string, mime = 'application/octet-stream'): Promise<string> {
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(bytes)], { type: mime }), filename);
    form.append('type', 'input');
    form.append('overwrite', 'true');
    let last: unknown = null;
    // Uploads overwrite by name, so repeating one is harmless.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await sleep(attempt * 2000);
      try {
        const r = await this.req('/api/upload/image', { method: 'POST', body: form, timeoutMs: 300_000 });
        const text = await r.text();
        if (r.ok) {
          const data = JSON.parse(text) as { name: string; subfolder?: string };
          return data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
        }
        last = new HttpError(`Upload failed: HTTP ${r.status} — ${text.slice(0, 200)}`, r.status);
        if (!RETRYABLE.has(r.status)) break;
      } catch (e) {
        last = e;
      }
    }
    throw last instanceof Error ? last : new Error(String(last));
  }

  /**
   * Queue a job — at most once. The prompt_id is ours, so a submit that fails
   * without a usable answer is checked against /history and /queue before it
   * is sent again: a blind retry could queue the same render twice.
   */
  async submit(workflow: WorkflowJson, clientId: string, opts: { previewMethod?: 'auto' | 'latent2rgb' | 'taesd' | 'none' } = {}): Promise<string> {
    const promptId = crypto.randomUUID();
    // extra_data.preview_method overrides the server's --preview-method for this prompt
    // only (ComfyUI execution.py, set_preview_method), which is how the editor does it too.
    const extra = opts.previewMethod ? { extra_data: { preview_method: opts.previewMethod } } : {};
    const body = JSON.stringify({ prompt: workflow, client_id: clientId, prompt_id: promptId, ...extra });
    const delays = [1500, 4000, 10_000];
    let lastError = '';
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      if (attempt > 0) {
        await sleep(delays[attempt - 1]);
        if (await this.isKnownJob(promptId)) return promptId;
      }
      let r: Response;
      try {
        r = await this.req('/api/prompt', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body, timeoutMs: 120_000,
        });
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        continue;
      }
      const text = await r.text();
      if (r.ok) return (JSON.parse(text) as { prompt_id?: string }).prompt_id ?? promptId;
      if (!RETRYABLE.has(r.status)) throw new Error(describeSubmitError(r.status, text));
      lastError = `HTTP ${r.status}`;
    }
    throw new Error(`Could not queue the job after ${delays.length + 1} attempts (${lastError}). Nothing was queued twice.`);
  }

  private async isKnownJob(promptId: string): Promise<boolean> {
    try {
      const h = await this.json<Record<string, unknown>>(`/api/history/${encodeURIComponent(promptId)}`);
      if (h[promptId]) return true;
    } catch { /* fall through to the queue */ }
    try {
      const q = await this.json<{ queue_running?: unknown[][]; queue_pending?: unknown[][] }>('/api/queue');
      return [...(q.queue_running ?? []), ...(q.queue_pending ?? [])].some((i) => Array.isArray(i) && i[1] === promptId);
    } catch {
      return false;
    }
  }

  /** Jobs ahead of ours, so a queued card can say "2 ahead" instead of nothing. */
  async queueDepth(): Promise<number> {
    try {
      const q = await this.json<{ queue_running?: unknown[]; queue_pending?: unknown[] }>('/api/queue', { timeoutMs: 5_000 });
      return (q.queue_running?.length ?? 0) + (q.queue_pending?.length ?? 0);
    } catch {
      return 0;
    }
  }

  /**
   * Follow a job: WebSocket for progress and previews, /history polling as the
   * source of truth for completion (a WS frame can be missed, history can't).
   */
  watch(jobId: string, clientId: string, onEvent: (e: ProviderEvent) => void): () => void {
    let stopped = false;
    let ws: WebSocket | null = null;
    let reconnect = 0;
    let finished = false;
    const finish = (e: ProviderEvent): void => {
      if (finished || stopped) return;
      finished = true;
      onEvent(e);
    };

    const connect = (): void => {
      if (stopped) return;
      ws = new WebSocket(`${this.base.replace(/^http/i, 'ws')}/ws?clientId=${encodeURIComponent(clientId)}`);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => { reconnect = 0; };
      ws.onmessage = (ev: MessageEvent) => {
        if (typeof ev.data === 'string') {
          let msg: { type?: string; data?: Record<string, unknown> };
          try { msg = JSON.parse(ev.data); } catch { return; }
          const d = msg.data ?? {};
          if (d.prompt_id && d.prompt_id !== jobId) return;
          switch (msg.type) {
            case 'execution_start': onEvent({ kind: 'queued' }); break;
            case 'executing': if (d.node != null) onEvent({ kind: 'executing', nodeId: String(d.node) }); break;
            case 'progress': onEvent({ kind: 'progress', value: Number(d.value ?? 0), max: Number(d.max ?? 1) }); break;
            case 'execution_error':
              finish({ kind: 'error', message: describeExecutionError(d) });
              break;
            case 'execution_interrupted':
              finish({ kind: 'error', message: 'Interrupted on the server.' });
              break;
          }
        } else if (ev.data instanceof ArrayBuffer && ev.data.byteLength > 8) {
          // Binary frames (ComfyUI protocol.py BinaryEventTypes), big-endian header:
          //   1 PREVIEW_IMAGE                [type][format 1=jpeg 2=png][image]
          //   4 PREVIEW_IMAGE_WITH_METADATA  [type][metadata length][metadata JSON][image]
          const view = new DataView(ev.data);
          const type = view.getUint32(0);
          if (type === 1) {
            const fmt = view.getUint32(4) === 2 ? 'image/png' : 'image/jpeg';
            onEvent({ kind: 'preview', blob: new Blob([ev.data.slice(8)], { type: fmt }) });
          } else if (type === 4) {
            const len = view.getUint32(4);
            let meta: { prompt_id?: string; image_type?: string } = {};
            try { meta = JSON.parse(new TextDecoder().decode(ev.data.slice(8, 8 + len))); } catch { /* keep going */ }
            if (meta.prompt_id && meta.prompt_id !== jobId) return;
            onEvent({ kind: 'preview', blob: new Blob([ev.data.slice(8 + len)], { type: meta.image_type ?? 'image/jpeg' }) });
          }
        }
      };
      ws.onclose = () => {
        if (stopped || finished) return;
        reconnect++;
        setTimeout(connect, Math.min(8000, 500 * 2 ** Math.min(reconnect, 4)));
      };
      ws.onerror = () => { /* onclose follows */ };
    };
    connect();

    const poll = async (): Promise<void> => {
      while (!stopped && !finished) {
        await sleep(2000);
        if (stopped || finished) break;
        try {
          const h = await this.json<Record<string, { outputs?: HistoryOutputs; status?: { status_str?: string; messages?: unknown[] } }>>(
            `/api/history/${encodeURIComponent(jobId)}`,
          );
          const job = h[jobId];
          if (!job) continue;
          if (job.status?.status_str === 'error') {
            finish({ kind: 'error', message: describeHistoryError(job.status.messages) });
            break;
          }
          const outputs = extractOutputs(job.outputs);
          if (outputs.length > 0) {
            onEvent({ kind: 'output', outputs });
            finish({ kind: 'done' });
            break;
          }
          if (job.status?.status_str === 'success') {
            finish({ kind: 'error', message: 'The workflow finished but saved no file. Check that it ends in a Save node.' });
            break;
          }
        } catch { /* transient: keep polling */ }
      }
    };
    void poll();

    return () => {
      stopped = true;
      try { ws?.close(); } catch { /* already closed */ }
    };
  }

  async download(out: OutputFile): Promise<Uint8Array> {
    const q = new URLSearchParams({ filename: out.filename, subfolder: out.subfolder, type: out.type });
    const r = await this.req(`/api/view?${q.toString()}`, { timeoutMs: 600_000 });
    if (!r.ok) throw new HttpError(`Download failed: HTTP ${r.status}`, r.status);
    return new Uint8Array(await r.arrayBuffer());
  }

  /** Drop the job from the queue, or interrupt it if it already started — only this one. */
  async cancel(jobId: string): Promise<void> {
    const post = (path: string, body: unknown): Promise<unknown> => this.req(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).catch(() => null);
    await post('/api/queue', { delete: [jobId] });
    await post('/api/interrupt', { prompt_id: jobId });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** ComfyUI names the failing node in a rejected graph; say it in those words. */
export function describeSubmitError(status: number, text: string): string {
  try {
    const body = JSON.parse(text) as {
      error?: { message?: string; details?: string };
      node_errors?: Record<string, { class_type?: string; errors?: Array<{ message?: string; details?: string }> }>;
    };
    const parts: string[] = [];
    if (body.error?.message) parts.push(body.error.details ? `${body.error.message} — ${body.error.details}` : body.error.message);
    for (const [nodeId, ne] of Object.entries(body.node_errors ?? {})) {
      for (const e of ne.errors ?? []) {
        parts.push(`node ${nodeId} (${ne.class_type ?? '?'}): ${e.message ?? ''}${e.details ? ` — ${e.details}` : ''}`);
      }
    }
    if (parts.length > 0) return parts.join('\n');
  } catch { /* not JSON */ }
  return `Submit failed: HTTP ${status} — ${text.slice(0, 400)}`;
}

function describeExecutionError(d: Record<string, unknown>): string {
  const node = d.node_type ? ` in ${String(d.node_type)}` : '';
  const msg = String(d.exception_message ?? 'Workflow execution failed').trim();
  if (/out of memory|OutOfMemory|CUDA error: out of memory/i.test(msg)) {
    return `The GPU ran out of memory${node}. Try a shorter clip or a smaller size, or close other GPU apps.`;
  }
  return `ComfyUI stopped${node}: ${msg.split('\n')[0]}`;
}

function describeHistoryError(messages: unknown[] | undefined): string {
  for (const m of messages ?? []) {
    if (Array.isArray(m) && m[0] === 'execution_error' && m[1] && typeof m[1] === 'object') {
      return describeExecutionError(m[1] as Record<string, unknown>);
    }
  }
  return 'ComfyUI reported the job as failed.';
}
