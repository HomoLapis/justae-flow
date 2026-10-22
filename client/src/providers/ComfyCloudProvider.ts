/**
 * ComfyCloud provider — https://cloud.comfy.org
 *
 * Reference: https://docs.comfy.org/development/cloud/api-reference
 *   - Auth: header `X-API-Key`
 *   - Submit: POST /api/prompt { prompt, extra_data?, client_id }
 *   - Status: GET /api/job/{prompt_id}/status
 *   - Job details (with outputs): GET /api/jobs/{prompt_id}
 *   - Download: GET /api/view?filename=&subfolder=&type=  (302 → signed URL)
 *   - Upload: POST /api/upload/image  (multipart: image, type=input, overwrite=true)
 *   - WebSocket: wss://cloud.comfy.org/ws?clientId={uuid}&token={API_KEY}
 *   - Cancel: POST /api/queue { delete: [prompt_id] }
 */

import type {
  ObjectInfo,
  OutputFile,
  ProviderEvent,
  ProviderHealth,
  SubmitCtx,
  UploadResult,
  VideoProvider,
  WorkflowJson,
} from './types';
import { bytesFromBase64, serverUrl } from '../bridge/server';
import { buildMultipart, relayFetch } from '../lib/httpNode';

const BASE = 'https://cloud.comfy.org';

const WS_BASE = 'wss://cloud.comfy.org/ws';

export class ComfyCloudProvider implements VideoProvider {
  readonly id = 'comfy-cloud' as const;
  readonly label = 'ComfyCloud';
  readonly requiresApiKey = true;

  constructor(private apiKey: string) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { 'X-API-Key': this.apiKey, ...extra };
  }

  async health(): Promise<ProviderHealth> {
    if (!this.apiKey) return { online: false, message: 'No API key set' };
    try {
      const r = await relayFetch(`${BASE}/api/object_info`, { headers: this.headers() });
      if (r.ok) return { online: true };
      if (r.status === 401) return { online: false, message: 'Invalid API key' };
      return { online: false, message: `HTTP ${r.status}` };
    } catch (e) {
      return { online: false, message: e instanceof Error ? e.message : 'Network error' };
    }
  }

  private objectInfoCache: ObjectInfo | null = null;

  /** Node schemas — needed to convert an editor-format workflow to API format. */
  async objectInfo(): Promise<ObjectInfo> {
    if (this.objectInfoCache) return this.objectInfoCache;
    const r = await relayFetch(`${BASE}/api/object_info`, { headers: this.headers() });
    if (!r.ok) throw new Error(`object_info failed: HTTP ${r.status}`);
    const data = (await r.json()) as ObjectInfo;
    this.objectInfoCache = data;
    return data;
  }

  /**
   * ComfyCloud's editor is the signed-in web app at this domain. Opening it in
   * the user's browser is exactly right — that is where it was meant to run.
   *
   * What still does not work here is the automatic round trip: ComfyCloud does
   * not expose /userdata, so `workflows()` is null and a workflow saved there
   * cannot be listed by the panel. The Workflow tab says so and offers the file
   * importer instead.
   */
  editorUrl(): string | null {
    return BASE;
  }

  workflows(): null {
    return null;
  }

  async uploadInput(file: Blob, filename: string): Promise<UploadResult> {
    const { body, contentType } = buildMultipart([
      { name: 'image', filename, contentType: file.type || 'application/octet-stream', data: new Uint8Array(await file.arrayBuffer()) },
      { name: 'type', value: 'input' },
      { name: 'overwrite', value: 'true' },
    ]);
    const r = await relayFetch(`${BASE}/api/upload/image`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': contentType }),
      body: new Blob([new Uint8Array(body)]),
    });
    if (!r.ok) throw new Error(`Upload failed: HTTP ${r.status} — ${await r.text()}`);
    const data = (await r.json()) as { name: string; subfolder?: string };
    return { name: data.name, subfolder: data.subfolder ?? '' };
  }

  async submit(workflow: WorkflowJson, ctx: SubmitCtx): Promise<{ jobId: string }> {
    const r = await relayFetch(`${BASE}/api/prompt`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        prompt: workflow,
        client_id: ctx.clientId,
        extra_data: { api_key_comfy_org: this.apiKey },
      }),
    });
    if (!r.ok) {
      const text = await r.text();
      throw new Error(`Submit failed: HTTP ${r.status} — ${text}`);
    }
    const data = (await r.json()) as { prompt_id: string };
    if (!data.prompt_id) throw new Error('Submit response missing prompt_id');
    return { jobId: data.prompt_id };
  }

  watch(jobId: string, ctx: SubmitCtx, onEvent: (e: ProviderEvent) => void): () => void {
    const url = `${WS_BASE}?clientId=${encodeURIComponent(ctx.clientId)}&token=${encodeURIComponent(this.apiKey)}`;
    const stopWs = openComfyWebSocket(url, jobId, onEvent);
    // Safety net: poll the documented status endpoint in case the WS drops or
    // misses execution_success. The `done` dedup guard in useGenerate ensures
    // whichever signal arrives first wins.
    const stopPoll = this.pollStatus(jobId, onEvent);
    return () => { stopWs(); stopPoll(); };
  }

  /** Poll GET /api/job/{prompt_id}/status until a terminal state. */
  private pollStatus(jobId: string, onEvent: (e: ProviderEvent) => void): () => void {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async (): Promise<void> => {
      if (stopped) return;
      try {
        const r = await relayFetch(`${BASE}/api/job/${encodeURIComponent(jobId)}/status`, {
          headers: this.headers(),
        });
        if (r.ok) {
          const data = (await r.json()) as { status?: string };
          const status = (data.status ?? '').toLowerCase();
          if (status === 'completed') { onEvent({ kind: 'done' }); return; }
          if (status === 'failed') { onEvent({ kind: 'error', message: 'Job failed on ComfyCloud.' }); return; }
          if (status === 'cancelled') { onEvent({ kind: 'error', message: 'Job cancelled.' }); return; }
        }
      } catch {
        /* network hiccup — keep polling */
      }
      if (!stopped) timer = setTimeout(() => void tick(), 4000);
    };
    // Start after a short delay so the WS gets first chance at progress events.
    timer = setTimeout(() => void tick(), 4000);
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }

  async fetchOutputs(jobId: string): Promise<OutputFile[]> {
    // The cloud docs say outputs primarily stream over the WS `executed`
    // messages and don't document a REST outputs endpoint. ComfyCloud runs
    // ComfyUI under the hood though, so try the standard history endpoint
    // first (shape: { [promptId]: { outputs } }), then the job-detail shape
    // ({ outputs }) as a fallback. Either may exist depending on tier.
    const tryUrls = [
      `${BASE}/api/history/${encodeURIComponent(jobId)}`,
      `${BASE}/api/jobs/${encodeURIComponent(jobId)}`,
    ];
    for (const url of tryUrls) {
      try {
        const r = await relayFetch(url, { headers: this.headers() });
        if (!r.ok) continue;
        const data = (await r.json()) as unknown;
        const outputs = extractOutputsFlexible(data, jobId);
        if (outputs.length > 0) return outputs;
      } catch {
        /* try next */
      }
    }
    return [];
  }

  async download(out: OutputFile): Promise<Blob> {
    const params = new URLSearchParams({
      filename: out.filename,
      subfolder: out.subfolder,
      type: out.type,
    });
    const r = await relayFetch(`${BASE}/api/view?${params.toString()}`, {
      headers: this.headers(),
      redirect: 'follow',
    });
    if (!r.ok) throw new Error(`Download failed: HTTP ${r.status}`);
    return await r.blob();
  }

  async cancel(jobId: string): Promise<void> {
    const r = await relayFetch(`${BASE}/api/queue`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ delete: [jobId] }),
    });
    if (!r.ok) throw new Error(`Cancel failed: HTTP ${r.status}`);
  }
}

/* ─── Shared helpers (also used by LocalComfyProvider in Round 2) ───── */

interface JobDetailResponse {
  outputs?: Record<string, Record<string, Array<{ filename: string; subfolder: string; type: string }>>>;
}

/**
 * Tests whether an item in a Comfy output bucket actually points to a file.
 * Nodes like VHS_VideoCombine include non-file fields (`animated: [true]`,
 * `fps: 24`, `workflow: "..."`) alongside the real `gifs`/`images` arrays.
 * We need to discard them or the save loop will crash on `out.filename.split`.
 */
function isFileItem(v: unknown): v is { filename: string; subfolder?: string; type?: string } {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { filename?: unknown }).filename === 'string' &&
    (v as { filename: string }).filename.length > 0
  );
}

/**
 * Accepts either of the two shapes a Comfy-style backend may return and
 * extracts file outputs:
 *   A) job-detail:   { outputs: { nodeId: { images: [...] } } }
 *   B) history:      { [promptId]: { outputs: { nodeId: { images: [...] } } } }
 */
export function extractOutputsFlexible(data: unknown, jobId: string): OutputFile[] {
  if (!data || typeof data !== 'object') return [];
  const obj = data as Record<string, unknown>;

  // Shape A — direct `outputs`
  if (obj.outputs && typeof obj.outputs === 'object') {
    return extractOutputs({ outputs: obj.outputs as JobDetailResponse['outputs'] });
  }
  // Shape B — history keyed by prompt id
  const entry = obj[jobId] as { outputs?: JobDetailResponse['outputs'] } | undefined;
  if (entry && typeof entry === 'object' && entry.outputs) {
    return extractOutputs({ outputs: entry.outputs });
  }
  // Shape B without our exact key — take the first entry that has outputs
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object' && 'outputs' in (v as object)) {
      const o = (v as { outputs?: JobDetailResponse['outputs'] }).outputs;
      if (o) {
        const out = extractOutputs({ outputs: o });
        if (out.length > 0) return out;
      }
    }
  }
  return [];
}

export function extractOutputs(data: JobDetailResponse): OutputFile[] {
  const out: OutputFile[] = [];
  const buckets = data.outputs ?? {};
  for (const [nodeId, byKind] of Object.entries(buckets)) {
    if (!byKind || typeof byKind !== 'object') continue;
    for (const [bucket, items] of Object.entries(byKind)) {
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (!isFileItem(item)) continue;
        out.push({
          filename: item.filename,
          subfolder: item.subfolder ?? '',
          type: (item.type as OutputFile['type']) ?? 'output',
          bucket,
          nodeId,
        });
      }
    }
  }
  return out;
}

/**
 * Open a ComfyUI-protocol WebSocket and translate its messages into
 * ProviderEvents filtered by jobId. Returns an unsubscribe function.
 */
export function openComfyWebSocket(
  url: string,
  jobId: string,
  onEvent: (e: ProviderEvent) => void,
): () => void {
  // The socket is opened by the JustAE Flow server and relayed as server-sent
  // events: no CORS, no origin check on the ComfyUI side, and a token in the
  // URL never sits in a browser socket. EventSource reconnects by itself.
  const es = new EventSource(serverUrl('/api/ws', { url }));
  es.addEventListener('text', (ev) => {
    try {
      const msg = JSON.parse((ev as MessageEvent<string>).data) as ComfyWsMessage;
      handleMessage(msg, jobId, onEvent);
    } catch {
      /* swallow malformed frames */
    }
  });
  es.addEventListener('bin', (ev) => {
    // Binary preview frame: [type][format][image], or type 4 [type][meta length][meta JSON][image].
    const bytes = bytesFromBase64((ev as MessageEvent<string>).data);
    if (bytes.length <= 8) return;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const type = view.getUint32(0);
    if (type === 4) {
      const len = view.getUint32(4);
      let meta: { prompt_id?: string; image_type?: string } = {};
      try { meta = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + len))); } catch { /* keep going */ }
      if (meta.prompt_id && meta.prompt_id !== jobId) return;
      onEvent({ kind: 'preview', blob: new Blob([bytes.slice(8 + len)], { type: meta.image_type ?? 'image/jpeg' }) });
    } else {
      onEvent({ kind: 'preview', blob: new Blob([bytes.slice(8)], { type: view.getUint32(4) === 2 ? 'image/png' : 'image/jpeg' }) });
    }
  });
  return () => es.close();
}

interface ComfyWsMessage {
  type: string;
  data: Record<string, unknown> & { prompt_id?: string };
}

function handleMessage(msg: ComfyWsMessage, jobId: string, onEvent: (e: ProviderEvent) => void): void {
  // Some message types omit prompt_id (e.g. status). Only filter when present.
  if (msg.data?.prompt_id && msg.data.prompt_id !== jobId) return;

  switch (msg.type) {
    case 'execution_start':
      onEvent({ kind: 'queued' });
      break;
    case 'executing': {
      const node = (msg.data.node as string | null) ?? null;
      if (node === null) {
        onEvent({ kind: 'done' });
      } else {
        onEvent({ kind: 'executing', nodeId: node });
      }
      break;
    }
    case 'progress': {
      const value = (msg.data.value as number) ?? 0;
      const max = (msg.data.max as number) ?? 1;
      onEvent({ kind: 'progress', value, max });
      break;
    }
    case 'executed': {
      const out = msg.data.output as unknown;
      if (out && typeof out === 'object') {
        const nodeId = msg.data.node as string;
        const outputs: OutputFile[] = [];
        for (const [bucket, items] of Object.entries(out as Record<string, unknown>)) {
          if (!Array.isArray(items)) continue; // skip non-file fields like `fps`, `animated`
          for (const item of items) {
            if (!isFileItem(item)) continue;   // skip non-file array entries
            outputs.push({
              filename: item.filename,
              subfolder: item.subfolder ?? '',
              type: (item.type as OutputFile['type']) ?? 'output',
              bucket,
              nodeId,
            });
          }
        }
        if (outputs.length > 0) onEvent({ kind: 'output', outputs });
      }
      break;
    }
    case 'execution_success':
      onEvent({ kind: 'done' });
      break;
    case 'execution_error': {
      const exc = (msg.data.exception_message as string) ?? 'Workflow execution failed';
      onEvent({ kind: 'error', message: exc });
      break;
    }
  }
}
