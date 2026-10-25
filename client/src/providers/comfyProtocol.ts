/**
 * The plain ComfyUI protocol's shared pieces: reading the files a job wrote
 * (history / job-detail shapes) and following its WebSocket, relayed by the
 * JustAE Flow server as server-sent events.
 *
 * Kept from the former ComfyCloud (v1) provider, which is gone: Comfy Cloud
 * now runs through Comfy API v2 on the server (ServerV2Provider), so its key
 * never reaches this page.
 */

import type { OutputFile, ProviderEvent } from './types';
import { bytesFromBase64, serverUrl } from '../bridge/server';


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
