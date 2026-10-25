/**
 * JustAE Flow's local server: the storyboard engine plus a small HTTP API for
 * the UI. Listens on loopback only; nothing here talks to anything the user
 * did not configure (their host app, their ComfyUI).
 *
 *   node server/index.ts            → http://127.0.0.1:5199
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRODUCT } from '../core/brand.ts';
import { configDir, loadSettings, type Settings } from './config.ts';
import { comfyFor, Engine, makeHost } from './engine.ts';
import { WorkflowLibrary } from './library.ts';
import { allowedOrigin, handleBridge, HostBridge, withToken } from './bridge.ts';
import { openFlowWindow } from './dock.ts';
import { makeServices } from './services.ts';
import { taskOf } from './resources.ts';
import { activeResource, resourceRoutes } from './api-resources.ts';
import { compRoutes } from './api-comp.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.JUSTAE_FLOW_PORT ?? process.env.SHIFTFIELD_PORT ?? 5199);
const settings = loadSettings(root);
const library = new WorkflowLibrary(join(root, 'workflows'));
// Resources, run history, capabilities, v2 jobs and credits live in the user's config folder.
let engineRef: Engine | null = null;
const services = makeServices(configDir(), () => engineRef?.settings ?? settings, library);
const engine = new Engine(settings, library, services);
engineRef = engine;
const dist = join(root, 'client', 'dist');
const bridge = new HostBridge(settings.effectcraftPort, join(root, 'extensions', 'effectcraft', 'flow-host.jsx'));

/**
 * A local page that sends the browser to the full storyboard. Host scripts may
 * not run system commands, but they may open a file with its default app
 * (File.execute) — and an .html file opens in the browser.
 */
const openPage = join(configDir(), `Open ${PRODUCT}.html`);
writeFileSync(openPage, `<!doctype html><meta charset="utf-8"><title>${PRODUCT}</title><meta http-equiv="refresh" content="0;url=http://127.0.0.1:${PORT}/"><a href="http://127.0.0.1:${PORT}/">Open ${PRODUCT}</a>\n`);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4',
  '.webm': 'video/webm', '.mov': 'video/quicktime', '.json': 'application/json', '.ico': 'image/x-icon',
};

function send(res: ServerResponse, status: number, body: unknown): void {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json', 'Cache-Control': 'no-store' });
  res.end(data);
}

async function readBody(req: IncomingMessage, limit = 64 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error('Request too large.');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

async function json<T>(req: IncomingMessage): Promise<T> {
  const b = await readBody(req, 1024 * 1024);
  return (b.length ? JSON.parse(b.toString('utf8')) : {}) as T;
}

/** Serves a file under `base` only — a path that climbs out is refused. */
function serveFile(res: ServerResponse, base: string, rel: string, req: IncomingMessage): void {
  const abs = resolve(base, normalize(rel));
  if (!abs.startsWith(resolve(base) + sep) && abs !== resolve(base)) return send(res, 403, 'Forbidden');
  if (!existsSync(abs) || !statSync(abs).isFile()) return send(res, 404, 'Not found');
  const type = MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream';
  const size = statSync(abs).size;
  const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
  if (range && type.startsWith('video/')) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
    res.end(readFileSync(abs).subarray(start, end + 1));
    return;
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Cache-Control': 'no-cache', 'Accept-Ranges': 'bytes' });
  res.end(readFileSync(abs));
}

const sseClients = new Set<ServerResponse>();
let pushTimer: ReturnType<typeof setTimeout> | null = null;
engine.onChange(() => {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    const payload = `event: state\ndata: ${JSON.stringify(engine.state())}\n\n`;
    for (const c of sseClients) c.write(payload);
  }, 120);
});

type Handler = (req: IncomingMessage, res: ServerResponse, m: RegExpExecArray, url: URL) => Promise<void> | void;

/** A tab the panel asked the Flow window to show ("Open the Comp tab"); an open window picks it up within a few seconds. */
let uiIntent: { tab: string; at: number } | null = null;

/** The panel's status line: the resource the next (or running) job uses, and the balance when it bills. */
function panelResource(): {
  resource: ReturnType<typeof activeResource>;
  /** Where each layer tool's workflow would run now (its task's row in Settings ▸ Resources). */
  routes: Record<string, { id: string; label: string; kind: string; metered: boolean }>;
  credits: { ok: boolean; credits: number | null; asOf: string | null; error: string | null } | null;
} {
  const resource = activeResource(services, engine);
  const routes: Record<string, { id: string; label: string; kind: string; metered: boolean }> = {};
  for (const w of library.list()) {
    const r = services.resources.resolve(taskOf(w.task, w.id), null, (x) => services.caps.has(x, w.id)).resource;
    routes[w.id] = { id: r.id, label: r.label, kind: r.kind, metered: services.resources.creditsPerHour(r) !== null };
  }
  if (!resource.metered && !Object.values(routes).some((r) => r.metered)) return { resource, routes, credits: null };
  // Never a network call per poll: the balance is read at most every five minutes (credits.ts).
  void services.credits.get().catch(() => undefined);
  const c = services.credits.cached();
  return { resource, routes, credits: c ? { ok: c.ok, credits: c.credits, asOf: c.asOf, error: c.error ?? null } : null };
}
const routes: Array<[string, RegExp, Handler]> = [
  ['GET', /^\/api\/state$/, (_q, res) => send(res, 200, engine.state())],
  // A small view for the panel inside the host app: it polls this every second or two over a raw socket.
  ['GET', /^\/api\/panel$/, (_q, res) => {
    const s = engine.state();
    send(res, 200, {
      host: { ok: s.host.ok, app: s.host.app, kind: s.host.kind, comp: s.host.comp?.name ?? null, error: s.host.error ?? null, selection: !!s.host.selection, selectedLayers: s.host.selectedLayers.length },
      comfy: { online: s.comfy.online, version: s.comfy.version ?? null },
      ...panelResource(),
      queue: { running: s.queue.running, waiting: s.queue.pending.length, ready: s.queue.ready },
      workflows: s.workflows.map((w) => ({ id: w.id, title: w.title, options: (w.params ?? []).filter((p) => p.options?.length) })),
      cards: s.cards.map((c, i) => ({
        id: c.id, n: i + 1, kind: c.origin.kind, at: c.at, status: c.status,
        layerId: c.origin.kind === 'layer' || c.origin.kind === 'placeholder' ? c.origin.layerId : null, prompt: c.prompt, workflowId: c.workflowId, params: c.params,
        promptless: !s.workflows.find((w) => w.id === c.workflowId)?.bindings.prompt,
        box: c.origin.kind !== 'marker' && c.origin.box ? [Math.round(c.origin.box[2]), Math.round(c.origin.box[3])] : null,
        progress: c.progress ? { phase: c.progress.phase, value: c.progress.value, max: c.progress.max } : null,
        versions: c.versions.map((v) => v.n), active: c.activeVersion, error: c.error ?? null, orphan: !!c.orphan,
      })),
      openPage,
    });
  }],
  ['GET', /^\/api\/events$/, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(`event: state\ndata: ${JSON.stringify(engine.state())}\n\n`);
    sseClients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
  }],
  ['POST', /^\/api\/settings$/, async (req, res) => {
    engine.applySettings(await json<Partial<Settings>>(req));
    send(res, 200, engine.state().settings);
  }],
  ['POST', /^\/api\/test\/comfy$/, async (req, res) => {
    const { url, token } = await json<{ url?: string; token?: string }>(req);
    const probe = comfyFor({ comfyUrl: url || engine.settings.comfyUrl, comfyToken: token ?? engine.settings.comfyToken, comfyGpu: engine.settings.comfyGpu });
    send(res, 200, { ...(await probe.health()), routed: probe.routed });
  }],
  ['GET', /^\/api\/comfy\/gpus$/, async (_q, res) => send(res, 200, await comfyFor(engine.settings).gpuMenu())],
  ['POST', /^\/api\/test\/host$/, async (req, res) => {
    const body = await json<Partial<Settings>>(req);
    const probe = makeHost({ ...engine.settings, ...body });
    try {
      const s = await probe.snapshot();
      send(res, 200, { ok: true, app: probe.label, version: s.version, project: s.project.path, comp: s.comp?.name ?? null, markers: s.markers.length, layers: s.layers.length });
    } catch (e) {
      send(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      probe.close();
    }
  }],
  ['POST', /^\/api\/test\/generate$/, async (_q, res) => send(res, 200, await engine.testGenerate())],
  ['POST', /^\/api\/cards\/bulk$/, async (req, res) => {
    const { ids, patch } = await json<{ ids: string[]; patch: Record<string, unknown> }>(req);
    await engine.updateCards(ids, patch);
    send(res, 200, { ok: true });
  }],
  ['POST', /^\/api\/cards\/([\w-]+)$/, async (req, res, m) => {
    await engine.updateCards([m[1]], await json(req));
    send(res, 200, { ok: true });
  }],
  ['POST', /^\/api\/cards\/([\w-]+)\/version$/, async (req, res, m) => {
    const { n } = await json<{ n: number }>(req);
    await engine.selectVersion(m[1], n);
    send(res, 200, { ok: true });
  }],
  ['POST', /^\/api\/cards\/([\w-]+)\/attach$/, async (req, res, m) => {
    const name = decodeURIComponent(String(req.headers['x-filename'] ?? 'image.png'));
    await engine.attach(m[1], new Uint8Array(await readBody(req)), name);
    send(res, 200, { ok: true });
  }],
  ['DELETE', /^\/api\/cards\/([\w-]+)\/attach$/, (_q, res, m) => { engine.detach(m[1]); send(res, 200, { ok: true }); }],
  ['DELETE', /^\/api\/cards\/([\w-]+)$/, (_q, res, m) => { engine.removeCard(m[1]); send(res, 200, { ok: true }); }],
  ['POST', /^\/api\/generate$/, async (req, res) => {
    const { ids } = await json<{ ids?: string[] }>(req);
    send(res, 200, { queued: engine.enqueue(ids) });
  }],
  ['POST', /^\/api\/cancel$/, async (req, res) => {
    const { id } = await json<{ id?: string }>(req);
    await engine.cancel(id);
    send(res, 200, { ok: true });
  }],
  ['POST', /^\/api\/queue\/resume$/, (_q, res) => { engine.resume(); send(res, 200, { ok: true }); }],
  ['POST', /^\/api\/queue\/discard$/, (_q, res) => { engine.discardRecovered(); send(res, 200, { ok: true }); }],
  ['POST', /^\/api\/placeholder$/, async (_q, res) => send(res, 200, { id: await engine.createPlaceholder() })],
  ['POST', /^\/api\/adopt$/, async (_q, res) => send(res, 200, { ids: await engine.adoptSelectedLayers() })],
  ['POST', /^\/api\/layer-card$/, async (_q, res) => send(res, 200, { id: await engine.cardForSelectedLayer() })],
  ['POST', /^\/api\/selection$/, async (_q, res) => send(res, 200, { id: await engine.addSelectionCard() })],
  ['POST', /^\/api\/marker$/, async (req, res) => {
    const { comment } = await json<{ comment?: string }>(req);
    await engine.addMarkerAtPlayhead(comment ?? '');
    send(res, 200, { ok: true });
  }],
  ['POST', /^\/api\/notice\/dismiss$/, (_q, res) => { engine.dismissNotice(); send(res, 200, { ok: true }); }],
  // The panel in EffectCraft opens the Flow window, docked at EffectCraft's right edge (server/dock.ts).
  // The ScriptUI panel asks with wait: false — its socket would hold EffectCraft's UI while the window docks.
  ['POST', /^\/api\/window\/open$/, async (req, res) => {
    const { wait, tab } = await json<{ wait?: boolean; tab?: string }>(req);
    const want = tab && /^(workflow|marker|storyboard|comp)$/.test(tab) ? tab : null;
    if (want) uiIntent = { tab: want, at: Date.now() };
    const opening = openFlowWindow(`http://127.0.0.1:${PORT}/${want ? `#${want}` : ''}`, join(configDir(), 'window'));
    if (wait === false) { opening.catch(() => undefined); return send(res, 200, { ok: true, how: 'opening' }); }
    send(res, 200, await opening);
  }],
  ['GET', /^\/api\/ui\/intent$/, (_q, res) => send(res, 200, uiIntent ?? { tab: null, at: 0 })],
  ['GET', /^\/api\/media\/(.+)$/, (req, res, m) => serveFile(res, engine.mediaDir, decodeURIComponent(m[1]), req)],
  ...resourceRoutes(services, engine),
  ...compRoutes(engine),
];

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    // A page from elsewhere may reach this port; it may not drive it.
    if (url.pathname.startsWith('/api/') && !allowedOrigin(req.headers.origin, PORT)) return send(res, 403, { error: 'Not from this app.' });
    if (await handleBridge(req, res, url, bridge)) return;
    for (const [method, re, handler] of routes) {
      const m = re.exec(url.pathname);
      if (m && req.method === method) return await handler(req, res, m, url);
    }
    if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'No such endpoint.' });
    if (!existsSync(join(dist, 'index.html'))) {
      return send(res, 503, 'The UI is not built yet: run "npm run build", then reload.');
    }
    // The PhotoCraft storyboard has a page of its own.
    if (url.pathname === '/storyboard' || url.pathname.startsWith('/storyboard/')) {
      const board = join(dist, 'storyboard');
      const sub = url.pathname.slice('/storyboard/'.length);
      return serveFile(res, board, sub && existsSync(join(board, sub)) ? sub : 'index.html', req);
    }
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (rel !== 'index.html' && existsSync(join(dist, rel))) return serveFile(res, dist, rel, req);
    // The page carries this session's token: only it can use the host, file and relay routes.
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return void res.end(withToken(readFileSync(join(dist, 'index.html'), 'utf8')));
  } catch (e) {
    send(res, 400, { error: e instanceof Error ? e.message : String(e) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`${PRODUCT}  →  http://127.0.0.1:${PORT}`);
  console.log(settings.host === 'photocraft'
    ? `  host: PhotoCraft on 127.0.0.1:${settings.photocraftPort} (root ${settings.photocraftRoot}) · ComfyUI: ${settings.comfyUrl}`
    : `  host: EffectCraft on 127.0.0.1:${settings.effectcraftPort} · ComfyUI: ${settings.comfyUrl}`);
  engine.start();
  // What each resource can run, for the Auto rule and the badges: now, then every ten minutes.
  services.caps.warm();
  setInterval(() => services.caps.warm(), 10 * 60_000);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { engine.stop(); process.exit(0); });
}
