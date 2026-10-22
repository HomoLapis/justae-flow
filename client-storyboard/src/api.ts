import type { EngineState } from '../../server/engine.ts';
import type { Settings } from '../../server/config.ts';

export type { EngineState };
export type CardView = EngineState['cards'][number];
export type WorkflowInfo = EngineState['workflows'][number];

async function call<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const init: RequestInit = { method, headers: { ...headers } };
  if (body instanceof Blob) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
  }
  const r = await fetch(path, init);
  const text = await r.text();
  const data = text ? JSON.parse(text) : {};
  if (!r.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${r.status}`);
  return data as T;
}

export const api = {
  generate: (ids?: string[]) => call<{ queued: number }>('POST', '/api/generate', { ids }),
  cancel: (id?: string) => call('POST', '/api/cancel', { id }),
  update: (id: string, patch: Record<string, unknown>) => call('POST', `/api/cards/${id}`, patch),
  bulk: (ids: string[], patch: Record<string, unknown>) => call('POST', '/api/cards/bulk', { ids, patch }),
  version: (id: string, n: number) => call('POST', `/api/cards/${id}/version`, { n }),
  attach: (id: string, file: File) => call('POST', `/api/cards/${id}/attach`, file, { 'X-Filename': encodeURIComponent(file.name) }),
  detach: (id: string) => call('DELETE', `/api/cards/${id}/attach`),
  remove: (id: string) => call('DELETE', `/api/cards/${id}`),
  placeholder: () => call<{ id: string }>('POST', '/api/placeholder'),
  adopt: () => call<{ ids: string[] }>('POST', '/api/adopt'),
  marker: (comment: string) => call('POST', '/api/marker', { comment }),
  selectionCard: () => call<{ id: string }>('POST', '/api/selection'),
  resume: () => call('POST', '/api/queue/resume'),
  discard: () => call('POST', '/api/queue/discard'),
  settings: (patch: Partial<Settings>) => call<Settings>('POST', '/api/settings', patch),
  testComfy: (url: string, token?: string) => call<{ online: boolean; version?: string; device?: string; message?: string; routed?: boolean }>('POST', '/api/test/comfy', { url, token }),
  gpus: () => call<{ options: Array<{ key: string; usdPerSec: number; vramGb: number }>; default: string } | null>('GET', '/api/comfy/gpus'),
  testHost: (body: Partial<Settings>) => call<{ ok: boolean; app?: string; version?: string; project?: string | null; comp?: string | null; markers?: number; layers?: number; error?: string }>('POST', '/api/test/host', body),
  testGenerate: () => call<{ file: string; seconds: number }>('POST', '/api/test/generate'),
  dismissNotice: () => call('POST', '/api/notice/dismiss'),
};

export function mediaUrl(rel: string | undefined, rev = 0): string | undefined {
  return rel ? `/api/media/${rel.split('/').map(encodeURIComponent).join('/')}?v=${rev}` : undefined;
}

export function subscribe(onState: (s: EngineState) => void, onConn: (ok: boolean) => void): () => void {
  let es: EventSource | null = null;
  let closed = false;
  const open = (): void => {
    es = new EventSource('/api/events');
    es.addEventListener('state', (e) => { onConn(true); onState(JSON.parse((e as MessageEvent).data)); });
    es.onerror = () => {
      onConn(false);
      es?.close();
      if (!closed) setTimeout(open, 1500);
    };
  };
  open();
  return () => { closed = true; es?.close(); };
}
