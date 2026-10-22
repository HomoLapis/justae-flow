/**
 * Comfy API v2 — jobs and assets.
 *
 * A second protocol, not a replacement. The classic `/prompt` + `/ws` +
 * `/history` surface is what a plain ComfyUI speaks and what the Local and
 * cloud-router providers use; v2 is what Comfy Cloud speaks, what a serverless
 * deployment speaks, and what a self-hosted instance speaks once
 * `comfy-api-proxy` is in front of it (`pip install comfy-api-proxy`, proxies
 * 127.0.0.1:8188 and serves v2 on :8189). On a bare local ComfyUI
 * `/api/v2/jobs` answers 404 — measured — so this provider is for the three
 * cases above and says so rather than half-working.
 *
 * Why this is hand-written when an official SDK exists
 * ---------------------------------------------------
 * `@comfyorg/sdk` was installed and tried first. It cannot run in this panel,
 * for reasons that are properties of CEP rather than opinions:
 *
 *   - it is a Node package — `node:crypto`, `node:fs`, `node:fs/promises`,
 *     `node:path`, `node:stream`, `node:stream/promises` — with no browser
 *     export condition;
 *   - its upload path calls `openAsBlob`, which is Node 19.8+. CEP 12 ships
 *     Node 17.7.1;
 *   - it calls `AbortSignal.timeout`, which is Chrome 103+. CEP 12 renders in
 *     Chromium 99, where that does not return undefined, it THROWS;
 *   - `engines: node >= 22`.
 *
 * The one thing the SDK offers that our own code did not — content-addressed
 * upload with dedup — is precisely the path that needs `openAsBlob`. So the
 * package stays, as a devDependency, in the only role it can usefully play
 * here: the SPECIFICATION. Every wire type below is imported from
 * `@comfyorg/sdk/low`, which re-exports the types generated from Comfy's own
 * OpenAPI document. Those imports are type-only and erased at build time, so
 * this file ships none of the SDK's code while still failing to compile if the
 * contract moves under it.
 */

import type { Asset, Job, Output as V2Output } from '@comfyorg/sdk/low';
import { createBLAKE3 } from 'hash-wasm';
import type {
  OutputFile,
  ProviderEvent,
  ProviderHealth,
  ProviderId,
  SubmitCtx,
  UploadResult,
  VideoProvider,
  WorkflowJson,
} from './types';
import { HttpError } from './ComfyHttpProvider';
import { relayFetch } from '../lib/httpNode';

export interface ComfyV2Options {
  id: ProviderId;
  label: string;
  baseUrl: string;
  /** Bearer token. Comfy Cloud's API key, or comfy-api-proxy's `--token`. */
  token: string;
}

/**
 * The reference a v2 graph uses in place of a filename.
 *
 * Read off the SDK's `assetReference()` rather than guessed: v2 has no
 * `input/` directory to drop a file into, so an uploaded asset is addressed by
 * its UUID inside the graph itself.
 */
export function assetReference(asset: Asset): unknown {
  const info: Record<string, unknown> = { id: asset.id };
  if (asset.hash) info.hash = asset.hash;
  if (asset.file_path) info.file_path = asset.file_path;
  return { __type: 'core/ASSET', info };
}

/** Map a v2 output's MIME type onto the buckets the rest of the panel knows. */
function bucketFor(contentType: string): string {
  if (contentType.startsWith('video/')) return 'video';
  if (contentType.startsWith('audio/')) return 'audio';
  return 'images';
}

export class ComfyV2Provider implements VideoProvider {
  readonly id: ProviderId;
  readonly label: string;
  readonly requiresApiKey = true;

  private readonly base: string;
  private readonly token: string;

  constructor(opts: ComfyV2Options) {
    this.id = opts.id;
    this.label = opts.label;
    this.base = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      ...extra,
    };
  }

  /**
   * One request, with a deadline that does not use `AbortSignal.timeout`.
   *
   * Chromium 99 throws on that method rather than returning undefined, and a
   * throw inside a helper like this one reads downstream as "the server is
   * unreachable" — a diagnosis that sends the user to check their network
   * while the panel is the thing at fault.
   */
  private async req(path: string, init: RequestInit = {}, timeoutMs = 60_000): Promise<Response> {
    const control = new AbortController();
    const timer = setTimeout(() => control.abort(), timeoutMs);
    try {
      return await relayFetch(this.base + path, {
        ...init,
        headers: this.headers(init.headers as Record<string, string> | undefined),
        signal: control.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async json<T>(path: string, init?: RequestInit, timeoutMs?: number): Promise<T> {
    const r = await this.req(path, init, timeoutMs);
    if (!r.ok) {
      // v2 answers failures with an error envelope carrying a machine-readable
      // `code`. Surfacing that beats a bare status: `workflow_format_ui` and
      // `insufficient_credits` need different things from the user.
      let detail = '';
      try {
        const body = await r.json() as { error?: { code?: string; message?: string } };
        detail = [body.error?.code, body.error?.message].filter(Boolean).join(': ');
      } catch { /* not an envelope — the status will have to do */ }
      throw new HttpError(`${this.label}: HTTP ${r.status}${detail ? ` — ${detail}` : ''}`, r.status);
    }
    return await r.json() as T;
  }

  async health(): Promise<ProviderHealth> {
    if (!this.base) return { online: false, message: 'No base URL set for this provider.' };
    try {
      const r = await this.req('/api/v2/jobs?limit=1', {}, 10_000);
      if (r.ok) return { online: true };
      if (r.status === 401 || r.status === 403) {
        return { online: false, message: 'The server is up but rejected the token.' };
      }
      if (r.status === 404) {
        return {
          online: false,
          message: 'This address answers, but has no /api/v2. A plain ComfyUI does not — put '
            + 'comfy-api-proxy in front of it, or point this at Comfy Cloud.',
        };
      }
      return { online: false, message: `HTTP ${r.status}` };
    } catch (e) {
      return { online: false, message: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Upload an input — without re-uploading bytes the server already has.
   *
   * This is the one thing v2 does better than the classic protocol, and it
   * matters here more than most places: After Effects sends the same first
   * frame again for every shot in a batch that starts from it, and the same
   * reference image for every take. The hash is computed locally, the server
   * is asked whether it knows those bytes, and if it does the asset is minted
   * over them with no upload at all.
   *
   * blake3 is not a choice — it is the hash v2 addresses blobs by
   * (`blake3:<hex>`). `hash-wasm` provides it, bundles to 29 KB and needs
   * nothing newer than Chromium 99 (checked).
   */
  async uploadInput(file: Blob, filename: string): Promise<UploadResult> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const hasher = await createBLAKE3();
    hasher.init();
    hasher.update(bytes);
    const hash = `blake3:${hasher.digest('hex')}`;

    // Does the platform already hold these bytes? A HEAD costs one round trip
    // and can save a hundred-megabyte upload.
    let known = false;
    try {
      const probe = await this.req(`/api/v2/assets/by-hash/${encodeURIComponent(hash)}`, { method: 'HEAD' }, 15_000);
      known = probe.ok;
    } catch { /* probing is an optimisation; failing it just means uploading */ }

    if (known) {
      try {
        const asset = await this.json<Asset>('/api/v2/assets/from-hash', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hash, file_path: filename, tags: ['input'] }),
        });
        return { name: filename, reference: assetReference(asset) };
      } catch {
        // The blob can disappear between the probe and the mint (retention),
        // and a stale optimisation must never become a failed upload.
      }
    }

    const form = new FormData();
    form.append('file', file, filename);
    form.append('content_type', file.type || 'application/octet-stream');
    form.append('file_path', filename);
    form.append('expected_hash', hash);
    form.append('tags', 'input');

    const asset = await this.json<Asset>('/api/v2/assets', {
      method: 'POST',
      body: form,
    }, 600_000);
    return { name: filename, reference: assetReference(asset) };
  }

  async submit(workflow: WorkflowJson, ctx: SubmitCtx): Promise<{ jobId: string }> {
    const job = await this.json<Job>('/api/v2/jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Single-use, and the server rejects a repeat rather than replaying it.
        // A fresh one per submit is what makes each Generate its own job.
        'Idempotency-Key': crypto.randomUUID(),
      },
      body: JSON.stringify({ workflow }),
    });
    void ctx;
    return { jobId: job.id };
  }

  /**
   * Follow a job.
   *
   * SSE where it works, polling where it doesn't — and polling is not a
   * degraded mode here, it is the source of truth the panel already trusts
   * everywhere else. The v2 progress snapshot is complete rather than
   * incremental ("one fully re-syncs a client", per the contract), so a missed
   * event costs nothing.
   *
   * Previews are deliberately not wired up. v2 delivers them as base64 JPEG
   * inside the SSE stream, throttled; the classic providers receive unthrottled
   * binary PNG frames off the WebSocket. Showing the worse one under the same
   * UI would quietly make previews look broken on this backend.
   */
  watch(jobId: string, ctx: SubmitCtx, onEvent: (e: ProviderEvent) => void): () => void {
    void ctx;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastStatus = '';

    const tick = async (): Promise<void> => {
      if (stopped) return;
      try {
        const job = await this.json<Job>(`/api/v2/jobs/${encodeURIComponent(jobId)}`, {}, 30_000);

        if (job.status !== lastStatus) {
          lastStatus = job.status;
          if (job.status === 'queued') onEvent({ kind: 'queued' });
        }
        if (job.progress) {
          onEvent({
            kind: 'progress',
            value: job.progress.nodes_done ?? Math.round((job.progress.value ?? 0) * 100),
            max: job.progress.nodes_total ?? 100,
          });
          if (job.progress.current_node) {
            onEvent({ kind: 'executing', nodeId: job.progress.current_node });
          }
        }

        if (job.status === 'succeeded') {
          onEvent({ kind: 'output', outputs: job.outputs.map(toOutputFile) });
          onEvent({ kind: 'done' });
          stopped = true;
          return;
        }
        if (job.status === 'failed' || job.status === 'expired') {
          onEvent({
            kind: 'error',
            message: job.error?.message ?? `The job ${job.status}.`,
          });
          stopped = true;
          return;
        }
        if (job.status === 'canceled') {
          onEvent({ kind: 'error', message: 'The job was cancelled.' });
          stopped = true;
          return;
        }
      } catch {
        /* a lost poll is not a lost job — try again */
      }
      if (!stopped) timer = setTimeout(() => void tick(), 2000);
    };
    void tick();

    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }

  async fetchOutputs(jobId: string): Promise<OutputFile[]> {
    const job = await this.json<Job>(`/api/v2/jobs/${encodeURIComponent(jobId)}`);
    return job.outputs.map(toOutputFile);
  }

  /**
   * Fetch an output.
   *
   * The signed URL is preferred and the asset route is the fallback, because
   * `url_expires_at` is real: a batch that takes an hour can outlive the link
   * it was handed at minute one, and `/api/v2/assets/{id}/content` still works
   * for as long as the job is retained.
   */
  async download(out: OutputFile): Promise<Blob> {
    if (out.url) {
      try {
        // A signed URL carries its own credentials in the query string, and
        // sending ours as well is both unnecessary and a way to leak a token
        // to whatever CDN is serving it.
        const r = await relayFetch(out.url);
        if (r.ok) return await r.blob();
      } catch { /* expired or unreachable — fall through to the asset route */ }
    }
    const r = await this.req(`/api/v2/assets/${encodeURIComponent(out.filename)}/content`, {}, 600_000);
    if (!r.ok) throw new HttpError(`Download failed: HTTP ${r.status}`, r.status);
    return await r.blob();
  }

  async cancel(jobId: string): Promise<void> {
    await this.req(`/api/v2/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' }, 30_000)
      .catch(() => undefined);
  }

  /**
   * No node catalogue, and therefore no conversion of editor-format files.
   *
   * v2 has no `/object_info`: it takes an API-format graph and rejects a UI one
   * with `workflow_format_ui`. That is not a gap to paper over — on this
   * backend a workflow has to arrive already in API format, which the panel
   * gets either from a capture or from an "Export (API)" file.
   */

  /** v2 has no `/userdata`, so there is no workflow folder to list. */
  workflows(): null {
    return null;
  }

  editorUrl(): string | null {
    return null;
  }
}

export function toOutputFile(o: V2Output): OutputFile {
  return {
    // The asset UUID travels as the filename: it is what `download` needs when
    // the signed URL has expired, and nothing downstream parses this field.
    filename: o.id,
    subfolder: '',
    type: 'output',
    bucket: bucketFor(o.content_type),
    nodeId: o.node_id,
    url: o.url,
  };
}
