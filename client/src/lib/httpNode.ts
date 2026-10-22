/**
 * HTTP without the browser's CORS rules.
 *
 * In After Effects this went through CEP's Node. Here the JustAE Flow server
 * makes the request on the page's behalf: a stock ComfyUI has no CORS layer,
 * and a cloud API that wants an Authorization header would need a preflight
 * it does not answer. The server follows redirects the way fetch does, which
 * also drops the Authorization header when a redirect leaves the host.
 */

import { base64FromBytes, bytesFromBase64, serverJson } from '../bridge/server';

export function nodeHttpAvailable(): boolean {
  return true;
}

export interface NodeHttpResponse {
  status: number;
  headers: Record<string, string>;
  bytes: Uint8Array;
  /** The body decoded as UTF-8. */
  text: string;
  ok: boolean;
}

export interface NodeRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
  timeoutMs?: number;
}

export async function nodeRequest(url: string, opts: NodeRequestOptions = {}): Promise<NodeHttpResponse> {
  const body = opts.body === undefined ? undefined
    : typeof opts.body === 'string' ? base64FromBytes(new TextEncoder().encode(opts.body))
      : base64FromBytes(opts.body);
  const r = await serverJson<{ status: number; headers: Record<string, string>; body: string }>('/api/http', {
    url, method: opts.method ?? 'GET', headers: opts.headers ?? {}, body, timeoutMs: opts.timeoutMs ?? 30_000,
  });
  const bytes = bytesFromBase64(r.body);
  return { status: r.status, headers: r.headers, bytes, text: new TextDecoder('utf-8').decode(bytes), ok: r.status >= 200 && r.status < 300 };
}

/**
 * `fetch`, made by the server. Same signature as the browser's for the parts
 * the providers use (method, headers, a string / bytes / Blob / FormData body),
 * and a real Response back. The signal is honoured on our side only.
 */
export async function relayFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
  let body: Uint8Array | string | undefined;
  const b = init.body;
  if (typeof b === 'string') body = b;
  else if (b instanceof Uint8Array) body = b;
  else if (b instanceof ArrayBuffer) body = new Uint8Array(b);
  else if (b instanceof Blob) body = new Uint8Array(await b.arrayBuffer());
  else if (b instanceof FormData) {
    const parts: MultipartPart[] = [];
    for (const [name, value] of b.entries()) {
      if (typeof value === 'string') parts.push({ name, value });
      else parts.push({ name, filename: value.name || 'blob', contentType: value.type || 'application/octet-stream', data: new Uint8Array(await value.arrayBuffer()) });
    }
    const mp = buildMultipart(parts);
    body = mp.body;
    headers['content-type'] = mp.contentType;
  }
  if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const r = await nodeRequest(url, { method: init.method ?? 'GET', headers, body, timeoutMs: 300_000 });
  const noBody = r.status === 204 || r.status === 205 || r.status === 304;
  return new Response(noBody ? null : new Uint8Array(r.bytes), { status: r.status, headers: r.headers });
}

/* ─── multipart/form-data ───────────────────────────────────────────── */

export type MultipartPart =
  | { name: string; value: string }
  | { name: string; filename: string; contentType: string; data: Uint8Array };

/** A multipart body built as bytes (a JPEG run through a JS string comes out corrupt). */
export function buildMultipart(parts: MultipartPart[]): { body: Uint8Array; contentType: string } {
  const enc = new TextEncoder();
  const boundary = `----JustAEFlow${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"`;
    if ('filename' in part) {
      head += `; filename="${part.filename}"\r\nContent-Type: ${part.contentType}\r\n\r\n`;
      chunks.push(enc.encode(head), part.data);
    } else {
      chunks.push(enc.encode(head + '\r\n\r\n' + part.value));
    }
    chunks.push(enc.encode('\r\n'));
  }
  chunks.push(enc.encode(`--${boundary}--\r\n`));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const body = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { body.set(c, at); at += c.length; }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}
