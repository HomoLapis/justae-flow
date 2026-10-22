/**
 * The JustAE Flow server this page was served by: it owns everything a CEP
 * panel would have done with Node (files, HTTP without CORS, sockets) and
 * speaks to EffectCraft over its control channel.
 *
 * Every call carries the session token the server wrote into the page. A web
 * page from anywhere else can reach 127.0.0.1 too, but it cannot read this
 * page, so it cannot make these calls.
 */

let cachedToken: string | null = null;

export function sessionToken(): string {
  if (cachedToken !== null) return cachedToken;
  const meta = typeof document !== 'undefined' ? document.querySelector('meta[name="flow-token"]') : null;
  cachedToken = meta?.getAttribute('content') ?? '';
  return cachedToken;
}

export function serverHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { 'X-Flow-Token': sessionToken(), ...extra };
}

/** A URL on the server that a <video>/<img> can load (no headers there, so the token rides in the query). */
export function serverUrl(path: string, params: Record<string, string> = {}): string {
  const q = new URLSearchParams({ ...params, t: sessionToken() });
  return `${path}?${q.toString()}`;
}

export async function serverJson<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: serverHeaders(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  const data = text ? JSON.parse(text) : {};
  if (!r.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${r.status}`);
  return data as T;
}

/**
 * Synchronous call, for the file helpers whose callers were written against
 * Node's synchronous fs. Loopback and small payloads only.
 */
export function serverSync(method: 'GET' | 'POST', path: string, body?: string, binary = false): { status: number; text: string } {
  const x = new XMLHttpRequest();
  x.open(method, path, false);
  x.setRequestHeader('X-Flow-Token', sessionToken());
  // A synchronous request cannot ask for an ArrayBuffer; this keeps every byte as one char code.
  if (binary) x.overrideMimeType('text/plain; charset=x-user-defined');
  if (body !== undefined) x.setRequestHeader('Content-Type', 'text/plain; charset=utf-8');
  x.send(body ?? null);
  return { status: x.status, text: x.responseText };
}

export function bytesFromBinaryString(s: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

export function base64FromBytes(bytes: Uint8Array): string {
  let s = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) s += String.fromCharCode(...bytes.subarray(i, i + step));
  return btoa(s);
}

export function bytesFromBase64(b64: string): Uint8Array<ArrayBuffer> {
  return bytesFromBinaryString(atob(b64));
}
