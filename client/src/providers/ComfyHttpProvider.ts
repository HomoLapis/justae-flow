/**
 * Base implementation for anything that speaks the plain ComfyUI HTTP/WS
 * protocol at a base URL:
 *
 *   POST /api/prompt            queue a job
 *   GET  /api/history/{id}      outputs of a finished job
 *   GET  /api/view              download an output
 *   POST /api/upload/image      upload an input (images AND videos — ComfyUI's
 *                               upload route is named after images but accepts
 *                               any file and routes it into input/)
 *   GET  /api/object_info       node schemas (needed for UI→API conversion)
 *   GET/POST/DELETE /api/userdata/…   the editor's own workflow folder
 *   WS   /ws?clientId=…         progress, previews, outputs
 *
 * Two backends ride on this: a local ComfyUI (no auth) and a self-hosted
 * self-hosted cloud router (Bearer token + a GPU-selection header). The only
 * difference between them is the headers and the query string, so both are
 * expressed as hooks rather than separate copies of the protocol.
 */

import { extractOutputs, openComfyWebSocket } from './comfyProtocol';
import { parseHistory } from './history';
import { buildMultipart, nodeHttpAvailable, nodeRequest } from '../lib/httpNode';
import type {
  DeviceStats,
  ObjectInfo,
  OutputFile,
  ProviderEvent,
  ProviderHealth,
  ProviderId,
  RecentRun,
  RemoteWorkflowFile,
  RemoteWorkflowStore,
  SubmitCtx,
  UploadResult,
  VideoProvider,
  WorkflowJson,
} from './types';

/** An HTTP failure that callers can react to by status, not by parsing text. */
export class HttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface JobStatusRead {
  state: 'unknown' | 'error' | 'canceled';
  /** The server's own explanation, when it gave one. */
  detail?: string;
}

export interface ComfyHttpOptions {
  id: ProviderId;
  label: string;
  requiresApiKey: boolean;
  baseUrl: string;
  /** Extra headers sent with every request (auth, GPU selection, …). */
  headers?: () => Record<string, string>;
  /**
   * Query string appended to WebSocket and editor URLs, for servers that
   * authenticate those via `?token=` because a header can't be attached — a
   * WebSocket constructor takes none, and neither does a URL handed to the
   * user's browser.
   */
  urlAuthQuery?: () => string;
  /** Human-readable hint shown when health() can't reach the server. */
  offlineHint?: string;
}

/** ComfyUI stores editor workflows under user/default/workflows/. */
const WORKFLOW_DIR = 'workflows';

export class ComfyHttpProvider implements VideoProvider {
  readonly id: ProviderId;
  readonly label: string;
  readonly requiresApiKey: boolean;

  protected base: string;
  private opts: ComfyHttpOptions;
  private objectInfoCache: ObjectInfo | null = null;

  constructor(opts: ComfyHttpOptions) {
    this.opts = opts;
    this.id = opts.id;
    this.label = opts.label;
    this.requiresApiKey = opts.requiresApiKey;
    this.base = opts.baseUrl.replace(/\/+$/, '');
  }

  protected headers(extra: Record<string, string> = {}): Record<string, string> {
    return { ...(this.opts.headers?.() ?? {}), ...extra };
  }

  /**
   * Every call to the server goes through here.
   *
   * Inside After Effects that means Node, not `fetch`. Neither a ComfyUI nor
   * a cloud router implements CORS — measured: every preflight OPTIONS comes
   * back 401 and no response carries an `Access-Control-*` header — so a
   * browser request with an `Authorization` header is refused before it is
   * even sent. Node isn't a browser: no preflight, no `Sec-Fetch-*` (which
   * a cloud edge rejects on forwarded requests), only the headers we pass.
   *
   * `fetch` remains the path outside CEP so the UI can still be developed in
   * a normal browser against a permissive server.
   */
  protected async req(
    path: string,
    init: { method?: string; headers?: Record<string, string>; body?: Uint8Array | string; timeoutMs?: number } = {},
  ): Promise<{ status: number; ok: boolean; text: string; bytes: Uint8Array }> {
    const url = path.startsWith('http') ? path : `${this.base}${path}`;
    const headers = this.headers(init.headers ?? {});

    if (nodeHttpAvailable()) {
      const r = await nodeRequest(url, {
        method: init.method, headers, body: init.body, timeoutMs: init.timeoutMs,
      });
      return { status: r.status, ok: r.ok, text: r.text, bytes: r.bytes };
    }

    const body = init.body instanceof Uint8Array
      ? new Blob([new Uint8Array(init.body)])
      : init.body;
    const r = await fetch(url, { method: init.method, headers, body });
    const buf = new Uint8Array(await r.arrayBuffer());
    return { status: r.status, ok: r.ok, bytes: buf, text: new TextDecoder().decode(buf) };
  }

  /** Same, parsed as JSON, with the server's own error text on failure. */
  protected async reqJson<T>(
    path: string,
    init?: Parameters<ComfyHttpProvider['req']>[1],
  ): Promise<T> {
    const r = await this.req(path, init);
    if (!r.ok) throw new HttpError(`HTTP ${r.status} — ${r.text.slice(0, 300)}`, r.status);
    return JSON.parse(r.text) as T;
  }

  /** Append the URL-borne auth to a path, preserving any existing query. */
  protected withAuthQuery(url: string): string {
    const q = this.opts.urlAuthQuery?.();
    if (!q) return url;
    return url + (url.includes('?') ? '&' : '?') + q;
  }

  /* ─── Health ─────────────────────────────────────────────────────── */

  /**
   * Reachability, cheaply.
   *
   * `/api/queue` is a few dozen bytes and exists on every ComfyUI; on the
   * cloud router it's answered by the router itself, so it doesn't wake the
   * CPU Builder. `/api/object_info` would also work but it's ~5 MB and goes
   * through the Builder, which can take minutes to cold-start — long enough
   * that the panel kept showing a stale error while the real answer was still
   * in flight.
   */
  async health(): Promise<ProviderHealth> {
    try {
      const r = await this.req('/api/queue', { timeoutMs: 20_000 });
      if (r.ok) return { online: true };
      if (r.status === 401 || r.status === 403) {
        return { online: false, message: 'Rejected — check the auth token.' };
      }
      return { online: false, message: `HTTP ${r.status}` };
    } catch {
      return { online: false, message: this.opts.offlineHint ?? `Cannot reach ${this.base}` };
    }
  }

  /* ─── Node catalogue ─────────────────────────────────────────────── */

  /**
   * The node catalogue.
   *
   * On a self-hosted cloud ComfyUI this is the one call the Router forwards to the
   * Builder, and a cloud edge rejects a forwarded request that carries
   * `Sec-Fetch-Site: cross-site` — which Chromium stamps on everything the
   * panel sends and script cannot strip. So when the browser is refused, we
   * ask again through Node, which sends only the headers we hand it.
   */
  async objectInfo(): Promise<ObjectInfo> {
    if (this.objectInfoCache) return this.objectInfoCache;
    // Several megabytes, and on a cloud router it's the one call proxied to
    // the CPU Builder, which can be cold — give it room.
    const r = await this.req('/api/object_info', { timeoutMs: 240_000 });
    if (!r.ok) {
      throw new Error(
        `Could not read the node list (HTTP ${r.status}). Editor-format workflows need it `
        + 'to be converted.',
      );
    }
    const data = JSON.parse(r.text) as ObjectInfo;
    this.objectInfoCache = data;
    return data;
  }

  /** Drop the cached catalogue — call after installing custom nodes. */
  invalidateObjectInfo(): void {
    this.objectInfoCache = null;
  }

  /* ─── The server's workflow folder ───────────────────────────────── */

  workflows(): RemoteWorkflowStore | null {
    const self = this;
    const at = (path: string): string => `/api/userdata/${encodePath(`${WORKFLOW_DIR}/${path}`)}`;
    return {
      async list(): Promise<RemoteWorkflowFile[]> {
        const r = await self.req(
          `/api/userdata?dir=${encodeURIComponent(WORKFLOW_DIR)}&recurse=true&full_info=true`,
          { timeoutMs: 30_000 },
        );
        // 404 = the folder doesn't exist yet (fresh install). Not an error.
        if (r.status === 404) return [];
        if (!r.ok) throw new HttpError(`Listing workflows failed: HTTP ${r.status}`, r.status);
        const raw = JSON.parse(r.text) as unknown;
        if (!Array.isArray(raw)) return [];
        return raw
          .map((item): RemoteWorkflowFile | null => {
            if (typeof item === 'string') return { path: item };
            if (item && typeof item === 'object' && typeof (item as { path?: unknown }).path === 'string') {
              const o = item as { path: string; size?: number; modified?: number };
              return { path: o.path, size: o.size, modified: o.modified };
            }
            return null;
          })
          .filter((f): f is RemoteWorkflowFile => f !== null && /\.json$/i.test(f.path));
      },

      async read(path: string): Promise<unknown> {
        const r = await self.req(at(path), { timeoutMs: 60_000 });
        if (!r.ok) throw new HttpError(`Reading "${path}" failed: HTTP ${r.status}`, r.status);
        return JSON.parse(r.text) as unknown;
      },

      async save(path: string, data: unknown): Promise<void> {
        const r = await self.req(`${at(path)}?overwrite=true`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
          timeoutMs: 60_000,
        });
        if (!r.ok) throw new HttpError(`Saving "${path}" failed: HTTP ${r.status} — ${r.text.slice(0, 200)}`, r.status);
      },

      async remove(path: string): Promise<void> {
        const r = await self.req(at(path), { method: 'DELETE', timeoutMs: 30_000 });
        if (!r.ok && r.status !== 404) {
          throw new HttpError(`Deleting "${path}" failed: HTTP ${r.status}`, r.status);
        }
      },
    };
  }

  /* ─── The embeddable editor ──────────────────────────────────────── */

  editorUrl(): string | null {
    return this.withAuthQuery(this.base + '/');
  }

  /* ─── Jobs ───────────────────────────────────────────────────────── */

  async uploadInput(file: Blob, filename: string): Promise<UploadResult> {
    const bytes = new Uint8Array(await file.arrayBuffer());

    // Node can't serialise a browser FormData, so the multipart body is built
    // by hand. The parts are joined as bytes — a JPEG pushed through a JS
    // string comes out corrupt.
    if (nodeHttpAvailable()) {
      const { body, contentType } = buildMultipart([
        { name: 'image', filename, contentType: file.type || 'application/octet-stream', data: bytes },
        { name: 'type', value: 'input' },
        { name: 'overwrite', value: 'true' },
      ]);
      // Uploads overwrite by name, so repeating one is harmless — retry what
      // looks like a dropped connection or a waking cloud edge.
      let r: Awaited<ReturnType<ComfyHttpProvider['req']>> | null = null;
      let lastErr: unknown = null;
      for (let attempt = 0; attempt < 3 && !(r && r.ok); attempt++) {
        if (attempt > 0) await sleep(attempt * 2500);
        try {
          r = await this.req('/api/upload/image', {
            method: 'POST', headers: { 'Content-Type': contentType }, body, timeoutMs: 300_000,
          });
          if (!r.ok && !RETRYABLE.has(r.status)) break;
        } catch (e) {
          lastErr = e;
          r = null;
        }
      }
      if (!r) throw lastErr instanceof Error ? lastErr : new Error(`Upload failed: ${String(lastErr)}`);
      if (!r.ok) throw new HttpError(`Upload failed: HTTP ${r.status} — ${r.text.slice(0, 200)}`, r.status);
      const data = JSON.parse(r.text) as { name: string; subfolder?: string };
      return { name: data.name, subfolder: data.subfolder ?? '' };
    }

    const form = new FormData();
    form.append('image', file, filename);
    form.append('type', 'input');
    form.append('overwrite', 'true');
    const r = await fetch(`${this.base}/api/upload/image`, {
      method: 'POST', headers: this.headers(), body: form,
    });
    if (!r.ok) throw new Error(`Upload failed: HTTP ${r.status} — ${await r.text()}`);
    const data = (await r.json()) as { name: string; subfolder?: string };
    return { name: data.name, subfolder: data.subfolder ?? '' };
  }

  /**
   * Queue a job — at most once, even when the network is not on our side.
   *
   * The panel picks the prompt_id itself (ComfyUI's /prompt accepts one: see
   * `post_prompt` in server.py) so that, when a submit fails WITHOUT a usable
   * answer — connection dropped, a cloud edge answering 502/503/504 while the
   * router is waking, 429 — it can ask the server whether the job arrived
   * before sending it again. A blind retry would be worse than none here: on
   * a metered cloud a duplicated job is a duplicated GPU bill. A 4xx is the server's
   * considered answer (a node error, bad auth) and is never retried.
   */
  async submit(workflow: WorkflowJson, ctx: SubmitCtx): Promise<{ jobId: string }> {
    const promptId = newPromptId();
    await this.beforeSubmit();
    const body = JSON.stringify({ prompt: workflow, client_id: ctx.clientId, prompt_id: promptId });
    const delays = [1500, 4000, 10_000];
    let lastError = '';
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      if (attempt > 0) {
        ctx.onRetry?.(attempt, delays.length, lastError);
        await sleep(delays[attempt - 1]);
        const found = await this.findSubmitted(promptId);
        if (found) return { jobId: found };
      }
      let r: Awaited<ReturnType<ComfyHttpProvider['req']>>;
      try {
        r = await this.req('/api/prompt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          timeoutMs: 120_000,
        });
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        continue;
      }
      if (r.ok) {
        const data = JSON.parse(r.text) as { prompt_id?: string };
        if (!data.prompt_id) throw new Error('Submit response missing prompt_id');
        return { jobId: data.prompt_id };
      }
      if (!RETRYABLE.has(r.status)) throw new Error(describeSubmitError(r.status, r.text));
      lastError = `HTTP ${r.status}`;
    }
    throw new Error(`Could not queue the job after ${delays.length + 1} attempts (${lastError}). Nothing was queued twice.`);
  }

  /** Hook for backends that need a snapshot before a submit (see a cloud router). */
  protected async beforeSubmit(): Promise<void> { /* nothing on plain ComfyUI */ }

  /** The id under which the server already has this submit, or null. */
  protected async findSubmitted(promptId: string): Promise<string | null> {
    return (await this.isKnownJob(promptId)) ? promptId : null;
  }

  /** Has the server already got this prompt — finished, running or waiting? */
  protected async isKnownJob(promptId: string): Promise<boolean> {
    try {
      const h = await this.req(`/api/history/${encodeURIComponent(promptId)}`, { timeoutMs: 20_000 });
      if (h.ok && (JSON.parse(h.text) as Record<string, unknown>)[promptId]) return true;
    } catch { /* fall through to the queue */ }
    try {
      const q = await this.req('/api/queue', { timeoutMs: 20_000 });
      if (!q.ok) return false;
      const data = JSON.parse(q.text) as { queue_running?: unknown[][]; queue_pending?: unknown[][] };
      const all = [...(data.queue_running ?? []), ...(data.queue_pending ?? [])];
      return all.some((item) => Array.isArray(item) && item[1] === promptId);
    } catch {
      return false;
    }
  }

  watch(jobId: string, ctx: SubmitCtx, onEvent: (e: ProviderEvent) => void): () => void {
    const wsBase = this.base.replace(/^http/i, 'ws');
    const url = this.withAuthQuery(`${wsBase}/ws?clientId=${encodeURIComponent(ctx.clientId)}`);
    const stopWs = openComfyWebSocket(url, jobId, onEvent);
    const stopPoll = this.pollHistory(jobId, onEvent);
    return () => { stopWs(); stopPoll(); };
  }

  /**
   * Safety net behind the WebSocket: poll /history until the job shows up.
   *
   * On a cloud router this is not merely a fallback — polling /queue is what
   * ADVANCES the server's sequential queue, so a panel that stops asking can
   * leave the next clip of a batch sitting in the queue.
   */
  private pollHistory(jobId: string, onEvent: (e: ProviderEvent) => void): () => void {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async (): Promise<void> => {
      if (stopped) return;
      try {
        // Touching /queue is the dispatcher tick on a cloud router; harmless
        // on a plain ComfyUI.
        void this.req('/api/queue', { timeoutMs: 20_000 }).catch(() => {});
        const outputs = await this.fetchOutputs(jobId);
        if (outputs.length > 0 && !stopped) {
          onEvent({ kind: 'output', outputs });
          onEvent({ kind: 'done' });
          return;
        }
        const status = await this.jobStatus(jobId);
        if (status.state !== 'unknown' && !stopped) {
          // Pass the server's own words through. "spec mancante (job scaduto)"
          // tells you what to do; "canceled on the server" does not.
          const what = status.state === 'error' ? 'The server reported this job as failed'
            : 'The server canceled this job';
          onEvent({
            kind: 'error',
            message: status.detail ? `${what}: ${status.detail}` : `${what} (${jobId}).`,
          });
          return;
        }
      } catch {
        /* transient — keep polling */
      }
      if (!stopped) timer = setTimeout(() => void tick(), 3000);
    };
    timer = setTimeout(() => void tick(), 3000);
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }

  /**
   * Best-effort terminal-state read, with whatever the server said about it.
   * Plain ComfyUI has no status field, so the base answer is "don't know".
   */
  protected async jobStatus(jobId: string): Promise<JobStatusRead> {
    void jobId;
    return { state: 'unknown' };
  }

  /**
   * The last few prompts the server ran, newest first — the graphs ComfyUI
   * itself compiled. See `providers/history.ts` for the shape, and
   * `workflows/capture.ts` for why the panel wants them.
   *
   * Deliberately small by default: every entry carries a whole graph, and a
   * 400-node workflow is a few hundred kilobytes on its own.
   */
  async recentRuns(limit = 5): Promise<RecentRun[]> {
    const r = await this.req(`/api/history?max_items=${Math.max(1, Math.floor(limit))}`, {
      timeoutMs: 60_000,
    });
    if (!r.ok) throw new HttpError(`Reading the run history failed: HTTP ${r.status}`, r.status);

    let data: unknown;
    try {
      data = JSON.parse(r.text);
    } catch {
      throw new Error("The server's run history was not JSON.");
    }
    return parseHistory(data);
  }

  /**
   * What the GPU has left. Best effort by design: this is shown beside a
   * running job, so a server that is too busy to answer must cost nothing
   * rather than raise. The first device is the one ComfyUI renders on.
   */
  async deviceStats(): Promise<DeviceStats | null> {
    try {
      const r = await this.req('/api/system_stats', { timeoutMs: 8_000 });
      if (!r.ok) return null;
      const data = JSON.parse(r.text) as {
        devices?: Array<{ name?: string; vram_free?: number; vram_total?: number }>;
      };
      const d = data.devices?.[0];
      if (!d || typeof d.vram_free !== 'number' || typeof d.vram_total !== 'number') return null;
      return { name: d.name ?? null, vramFreeBytes: d.vram_free, vramTotalBytes: d.vram_total };
    } catch {
      return null;
    }
  }

  async fetchOutputs(jobId: string): Promise<OutputFile[]> {
    const r = await this.req(`/api/history/${encodeURIComponent(jobId)}`, { timeoutMs: 60_000 });
    if (!r.ok) throw new HttpError(`Fetch outputs failed: HTTP ${r.status}`, r.status);
    const data = JSON.parse(r.text) as Record<string, { outputs?: Parameters<typeof extractOutputs>[0]['outputs'] }>;
    const job = data[jobId];
    if (!job) return [];
    return extractOutputs({ outputs: job.outputs });
  }

  /**
   * How long the job executed, from ComfyUI's own history: the timestamps of
   * its execution_start and execution_success messages (ms). Null when the
   * history does not carry them.
   */
  async executionMs(jobId: string): Promise<number | null> {
    try {
      const r = await this.req(`/api/history/${encodeURIComponent(jobId)}`, { timeoutMs: 10_000 });
      if (!r.ok) return null;
      const data = JSON.parse(r.text) as Record<string, { status?: { messages?: unknown[] } }>;
      const at = (name: string): number | null => {
        for (const m of data[jobId]?.status?.messages ?? []) {
          if (Array.isArray(m) && m[0] === name && typeof (m[1] as { timestamp?: unknown } | undefined)?.timestamp === 'number') return (m[1] as { timestamp: number }).timestamp;
        }
        return null;
      };
      const start = at('execution_start');
      const end = at('execution_success');
      return start !== null && end !== null && end >= start ? end - start : null;
    } catch {
      return null;
    }
  }

  async download(out: OutputFile): Promise<Blob> {
    const params = new URLSearchParams({
      filename: out.filename,
      subfolder: out.subfolder,
      type: out.type,
    });
    // A finished video can be tens of megabytes; the bytes come back raw and
    // are wrapped as a Blob so the rest of the panel is unaware of the
    // transport underneath.
    const r = await this.req(`/api/view?${params.toString()}`, { timeoutMs: 600_000 });
    if (!r.ok) throw new HttpError(`Download failed: HTTP ${r.status}`, r.status);
    return new Blob([new Uint8Array(r.bytes)]);
  }

  async cancel(jobId: string): Promise<void> {
    // Drop it from the queue if it hasn't started…
    await this.req('/api/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delete: [jobId] }),
      timeoutMs: 30_000,
    }).catch(() => {});
    // …and interrupt it if it has — only this prompt: ComfyUI accepts a
    // prompt_id here, so a job somebody else is running is left alone.
    await this.req('/api/interrupt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt_id: jobId }),
      timeoutMs: 30_000,
    }).catch(() => {});
  }
}

/* ─── helpers ─────────────────────────────────────────────────────── */

/** Statuses that mean "no considered answer yet" — worth asking again. */
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** UUID v4 for the prompt_id (crypto.randomUUID exists from Chromium 92; CEP 12 is 99). */
function newPromptId(): string {
  const c = globalThis.crypto as Crypto & { randomUUID?: () => string };
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Encode a userdata path as ONE URL segment.
 *
 * ComfyUI registers `@routes.get("/userdata/{file}")`, and in aiohttp `{file}`
 * matches a single segment — it does not cross slashes. A workflow inside a
 * folder (`LTX2.3_Editing/edit.json`, and 177 of one real library's 232 files
 * are) therefore has to arrive percent-encoded, or the route simply doesn't
 * match and the server answers 404 for a file that is plainly there.
 *
 * The same form works on a cloud router, whose FastAPI route is
 * `{file:path}` and which unquotes the value when it contains a `%`. So one
 * encoding serves both, and sending literal slashes serves only one of them —
 * which is exactly why this worked in the cloud and failed on a local ComfyUI.
 */
function encodePath(p: string): string {
  return encodeURIComponent(p);
}

/**
 * ComfyUI answers a rejected graph with a structured body naming the offending
 * node. Surfacing it verbatim is the difference between "HTTP 400" and
 * "node 27 (LoadImage): required input is missing: image".
 */
function describeSubmitError(status: number, text: string): string {
  try {
    const body = JSON.parse(text) as {
      error?: { message?: string; details?: string; type?: string };
      node_errors?: Record<string, { class_type?: string; errors?: Array<{ message?: string; details?: string }> }>;
    };
    const parts: string[] = [];
    if (body.error?.message) {
      parts.push(body.error.details ? `${body.error.message} — ${body.error.details}` : body.error.message);
    }
    for (const [nodeId, ne] of Object.entries(body.node_errors ?? {})) {
      for (const e of ne.errors ?? []) {
        parts.push(`node ${nodeId} (${ne.class_type ?? '?'}): ${e.message ?? ''}${e.details ? ` — ${e.details}` : ''}`);
      }
    }
    if (parts.length > 0) return parts.join('\n');
  } catch {
    /* not JSON — fall through to the raw text */
  }
  return `Submit failed: HTTP ${status} — ${text.slice(0, 400)}`;
}
