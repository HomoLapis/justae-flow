/**
 * What the Flow panel did with CEP's Node and ExtendScript, done here for the
 * page in the browser:
 *
 *   /api/host/eval   run a host function inside EffectCraft (script.run on its
 *                    control channel) — EffectCraft scripting follows After
 *                    Effects scripting, so the panel's host file runs as it is
 *   /api/fs/*        files, under the user's home folder and the temp folder
 *   /api/http        an HTTP request without the browser's CORS rules
 *   /api/ws          a ComfyUI WebSocket, relayed as server-sent events
 *
 * Every route wants the session token written into the page, and a request
 * that says where it comes from must come from this server's own page: any web
 * page can reach 127.0.0.1, none other can read the token.
 */

import { copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { JsonLinesClient } from '../hosts/jsonlines.ts';
import { PRODUCT } from '../core/brand.ts';

export const SESSION_TOKEN = crypto.randomUUID().replace(/-/g, '');

const ROOTS = [resolve(homedir()), resolve(tmpdir())];

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8',
};

export function allowedOrigin(origin: string | undefined, port: number): boolean {
  if (!origin) return true;
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`, 'http://127.0.0.1:5198', 'http://localhost:5198'].includes(origin);
}

export function tokenOk(req: IncomingMessage, url: URL): boolean {
  return req.headers['x-flow-token'] === SESSION_TOKEN || url.searchParams.get('t') === SESSION_TOKEN;
}

/** The page, with the session token in its head. */
export function withToken(html: string): string {
  return html.replace('<meta name="flow-token" content="" />', `<meta name="flow-token" content="${SESSION_TOKEN}" />`);
}

function safePath(p: unknown): string {
  if (typeof p !== 'string' || !p) throw new Error('No path given.');
  const abs = resolve(p);
  const lower = abs.toLowerCase();
  if (!ROOTS.some((r) => lower === r.toLowerCase() || lower.startsWith(r.toLowerCase() + sep))) {
    throw new Error(`${abs} is outside the folders JustAE Flow may use (your user folder and the temp folder).`);
  }
  return abs;
}

async function body(req: IncomingMessage, limit = 2 * 1024 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error('Request too large.');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

/* ─── Host ─────────────────────────────────────────────────────────────── */

export class HostBridge {
  private rpc: JsonLinesClient;
  private hostFile: string;
  private hostCode = '';
  private hostMtime = 0;

  constructor(port: number, hostFile: string) {
    this.rpc = new JsonLinesClient({ port, label: 'EffectCraft' });
    this.hostFile = hostFile;
  }

  setPort(port: number): void {
    this.rpc.close();
    this.rpc = new JsonLinesClient({ port, label: 'EffectCraft' });
  }

  private code(): string {
    const m = statSync(this.hostFile).mtimeMs;
    if (m !== this.hostMtime) {
      this.hostCode = readFileSync(this.hostFile, 'utf8');
      this.hostMtime = m;
    }
    return this.hostCode;
  }

  /** The JSON string a host function returns, or an error envelope. */
  async eval(script: string): Promise<string> {
    // EffectCraft's scripting has no Folder.temp; the temp folder is this machine's.
    if (script.trim() === 'getTempDir()') {
      const dir = join(tmpdir(), PRODUCT);
      mkdirSync(dir, { recursive: true });
      return JSON.stringify({ path: dir });
    }
    const r = await this.rpc.call<{ ok: boolean; result: unknown; error: { message: string; line?: number } | null }>(
      'engine.execute', { command: 'script.run', params: { code: `${this.code()}\n${script}`, name: 'JustAE Flow host' } }, 600_000,
    );
    if (!r.ok || r.error) return JSON.stringify({ error: r.error?.message ?? 'The script failed in EffectCraft.' });
    return typeof r.result === 'string' ? r.result : JSON.stringify(r.result ?? null);
  }

  close(): void {
    this.rpc.close();
  }
}

/* ─── Routes ───────────────────────────────────────────────────────────── */

export async function handleBridge(req: IncomingMessage, res: ServerResponse, url: URL, bridge: HostBridge): Promise<boolean> {
  const p = url.pathname;
  if (!p.startsWith('/api/host/') && !p.startsWith('/api/fs/') && p !== '/api/http' && p !== '/api/ws') return false;
  if (!tokenOk(req, url)) { json(res, 403, { error: 'This page was not served by this JustAE Flow session — reload it.' }); return true; }
  try {
    if (p === '/api/host/eval') {
      const { script } = JSON.parse((await body(req)).toString('utf8')) as { script: string };
      json(res, 200, { result: await bridge.eval(script) });
      return true;
    }
    if (p.startsWith('/api/fs/')) { await fsRoute(p.slice('/api/fs/'.length), req, res, url); return true; }
    if (p === '/api/http') { await httpRelay(req, res); return true; }
    if (p === '/api/ws') { wsRelay(req, res, url); return true; }
  } catch (e) {
    json(res, 400, { error: e instanceof Error ? e.message : String(e) });
    return true;
  }
  return false;
}

async function fsRoute(op: string, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (op === 'read-bytes' || op === 'raw') {
    const file = safePath(url.searchParams.get('path'));
    if (!existsSync(file) || !statSync(file).isFile()) return json(res, 404, { error: `No such file: ${file}` });
    const size = statSync(file).size;
    const type = op === 'raw' ? MIME[extname(file).toLowerCase()] ?? 'application/octet-stream' : 'application/octet-stream';
    const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
    if (op === 'raw' && range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
      createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' });
    createReadStream(file).pipe(res);
    return;
  }
  if (op === 'write-bytes') {
    const file = safePath(url.searchParams.get('path'));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, await body(req));
    return json(res, 200, { result: true });
  }
  const a = JSON.parse((await body(req, 64 * 1024 * 1024)).toString('utf8') || '{}') as Record<string, unknown>;
  switch (op) {
    case 'mkdir': mkdirSync(safePath(a.path), { recursive: true }); return json(res, 200, { result: true });
    case 'copy': {
      const dest = safePath(a.dest);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(safePath(a.src), dest);
      return json(res, 200, { result: true });
    }
    case 'stat': {
      const file = safePath(a.path);
      if (!existsSync(file)) return json(res, 200, { result: null });
      const st = statSync(file);
      return json(res, 200, { result: { size: st.size, mtime: st.mtimeMs, isDir: st.isDirectory() } });
    }
    case 'read-text': return json(res, 200, { result: readFileSync(safePath(a.path), 'utf8') });
    case 'write-text': {
      const file = safePath(a.path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, String(a.text ?? ''), 'utf8');
      return json(res, 200, { result: true });
    }
    case 'list': {
      const dir = safePath(a.path);
      if (!existsSync(dir)) return json(res, 200, { result: [] });
      const out = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile()).flatMap((d) => {
        try {
          const st = statSync(join(dir, d.name));
          return [{ name: d.name, path: join(dir, d.name), modified: st.mtimeMs, size: st.size }];
        } catch { return []; }
      });
      return json(res, 200, { result: out });
    }
    case 'delete': rmSync(safePath(a.path), { force: true }); return json(res, 200, { result: true });
    case 'reveal': {
      const target = safePath(a.path);
      // Shown, not opened: the file manager with the item selected.
      if (process.platform === 'win32') spawn('explorer.exe', [`/select,${target}`], { detached: true, stdio: 'ignore' }).unref();
      else if (process.platform === 'darwin') spawn('open', ['-R', target], { detached: true, stdio: 'ignore' }).unref();
      else spawn('xdg-open', [existsSync(target) && statSync(target).isDirectory() ? target : dirname(target)], { detached: true, stdio: 'ignore' }).unref();
      return json(res, 200, { result: true });
    }
    case 'master': return json(res, 200, await master(a));
    case 'launch-editor': return json(res, 200, launchEditor(a));
    default: return json(res, 404, { error: `No file operation "${op}".` });
  }
}

/** Where the browsers live; the first one found opens the ComfyUI editor as an app window. */
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/microsoft-edge',
];

/**
 * The ComfyUI editor in its own window, on a DevTools port the page can drive
 * to load a workflow into it. Only this app's own page may connect.
 */
function launchEditor(a: Record<string, unknown>): { ok: boolean; reason?: string } {
  const url = String(a.url ?? '');
  const port = Number(a.port) || 9334;
  const origin = String(a.origin ?? '');
  if (!/^https?:\/\//i.test(url)) return { ok: false, reason: 'No editor address.' };
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) return { ok: false, reason: 'Unexpected page origin.' };
  const exe = BROWSERS.find((p) => existsSync(p));
  if (!exe) return { ok: false, reason: 'Neither Edge nor Chrome could be found to open the editor window.' };
  const profileDir = safePath(a.profileDir);
  mkdirSync(profileDir, { recursive: true });
  spawn(exe, [
    `--app=${url}`, `--remote-debugging-port=${port}`, `--remote-allow-origins=${origin}`,
    `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', '--window-size=1600,1000',
  ], { detached: true, stdio: 'ignore' }).unref();
  return { ok: true };
}

/**
 * The Flow window: this app's page as an app window (no address bar), with a
 * profile of its own so it remembers its size and the page's settings. Falls
 * back to the default browser when neither Edge nor Chrome is installed.
 */
export function openFlowWindow(url: string, profileDir: string): { ok: boolean; how: string } {
  const exe = BROWSERS.find((p) => existsSync(p));
  if (exe) {
    mkdirSync(profileDir, { recursive: true });
    spawn(exe, [`--app=${url}`, `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', '--disable-features=Translate', '--window-size=560,980'],
      { detached: true, stdio: 'ignore' }).unref();
    return { ok: true, how: 'app window' };
  }
  const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] as const
    : process.platform === 'darwin' ? ['open', [url]] as const : ['xdg-open', [url]] as const;
  spawn(opener[0], [...opener[1]], { detached: true, stdio: 'ignore' }).unref();
  return { ok: true, how: 'default browser' };
}

/**
 * Delivery masters with ffmpeg (on the PATH), from a lossless save:
 *   prores4444  prores_ks · profile 4444 · yuva444p10le (alpha kept) · vendor apl0
 *   png16       a bit-exact 16-bit PNG sequence (rgba64be)
 */
function master(a: Record<string, unknown>): Promise<{ ok: boolean; path?: string; reason?: string }> {
  const src = safePath(a.src);
  let out: string;
  let args: string[];
  if (a.kind === 'prores4444') {
    out = src.replace(/(_\d{5})?\.(mkv|png|tiff?|exr)$/i, '') + '_master_4444.mov';
    const seq = /_(\d{5})\.png$/i.test(src);
    const input = seq ? ['-framerate', String(Number(a.fps) || 24), '-i', src.replace(/_\d{5}\.png$/i, '_%05d.png')] : ['-i', src];
    args = ['-v', 'error', '-y', ...input, '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', '-vendor', 'apl0',
      '-alpha_bits', '16', '-c:a', 'pcm_s24le', out];
  } else if (a.kind === 'png16') {
    const base = src.split(/[\\/]/).pop()!.replace(/\.(mkv|mov)$/i, '');
    const dir = join(dirname(src), `${base}_png16`);
    mkdirSync(dir, { recursive: true });
    out = join(dir, `${base}_00000.png`);
    args = ['-v', 'error', '-y', '-i', src, '-pix_fmt', 'rgba64be', '-start_number', '0', join(dir, `${base}_%05d.png`)];
  } else {
    return Promise.resolve({ ok: false, reason: `Unknown master kind ${String(a.kind)}.` });
  }
  return new Promise((done) => {
    const p = spawn('ffmpeg', args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += String(d); });
    p.on('error', (e) => done({ ok: false, reason: `ffmpeg not found on the PATH: ${e.message}` }));
    p.on('close', (code) => done(code === 0 ? { ok: true, path: out } : { ok: false, reason: `ffmpeg failed: ${err.slice(0, 300)}` }));
  });
}

async function httpRelay(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const a = JSON.parse((await body(req)).toString('utf8')) as { url: string; method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number };
  if (!/^https?:\/\//i.test(a.url)) return json(res, 400, { error: 'Only http(s) URLs.' });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.min(a.timeoutMs ?? 30_000, 900_000));
  try {
    const r = await fetch(a.url, {
      method: a.method ?? 'GET', headers: a.headers ?? {}, signal: ctrl.signal, redirect: 'follow',
      body: a.body !== undefined && a.method && !['GET', 'HEAD'].includes(a.method.toUpperCase()) ? Buffer.from(a.body, 'base64') : undefined,
    });
    const headers: Record<string, string> = {};
    r.headers.forEach((v, k) => { headers[k] = v; });
    const bytes = Buffer.from(await r.arrayBuffer());
    json(res, 200, { status: r.status, headers, body: bytes.toString('base64') });
  } catch (e) {
    json(res, 502, { error: `Could not reach ${a.url}: ${e instanceof Error ? e.message : e}` });
  } finally {
    clearTimeout(timer);
  }
}

function wsRelay(req: IncomingMessage, res: ServerResponse, url: URL): void {
  const target = url.searchParams.get('url') ?? '';
  if (!/^wss?:\/\//i.test(target)) return json(res, 400, { error: 'Only ws(s) URLs.' });
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  res.write('retry: 2000\n\n');
  const ws = new WebSocket(target);
  ws.binaryType = 'arraybuffer';
  const send = (event: string, data: string): void => {
    res.write(`event: ${event}\n${data.split(/\r?\n/).map((l) => `data: ${l}`).join('\n')}\n\n`);
  };
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') send('text', ev.data);
    else send('bin', Buffer.from(ev.data as ArrayBuffer).toString('base64'));
  };
  // The page's EventSource reconnects by itself when the stream ends.
  ws.onclose = () => res.end();
  ws.onerror = () => res.end();
  const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
  req.on('close', () => { clearInterval(ping); try { ws.close(); } catch { /* already closed */ } });
}
