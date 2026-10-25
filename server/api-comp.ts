/**
 * HTTP routes of the Flow window's Comp tab.
 *
 *   GET  /api/comp[?layer=<id>]     the active comp (size, fps, length, work area), the selected layer,
 *                                   the layer the tab picked as its source (if it is in this comp),
 *                                   the tools, and the runs of this comp with their versions
 *   POST /api/comp/plan             {tool, source, layerId?, options, cap} → what it would make, before it runs
 *   POST /api/comp/frame            {force?} → the comp's frame at the playhead (for the previews)
 *   POST /api/comp/run              {tool, source, options, cap, prompt, resource, seed} → queues it
 *   POST /api/comp/compare          {id, n?} → original ⇄ result
 *   POST /api/comp/open             {id, n?, which?: result|source} → opens that comp in the host
 *   POST /api/comp/export-alpha     {id, n?} → a cut-out as ProRes 4444 with alpha
 *
 * Cancel is /api/cancel and a version is /api/cards/:id/version, as for every card.
 * Routes that queue work (which may spend credits) or write files want the page's
 * session token, like the resource and file routes.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { tokenOk } from './bridge.ts';
import type { CompPlanRequest, Engine } from './engine.ts';

type Handler = (req: IncomingMessage, res: ServerResponse, m: RegExpExecArray, url: URL) => Promise<void> | void;

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function json<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1024 * 1024) throw new Error('Request too large.');
    chunks.push(c as Buffer);
  }
  const b = Buffer.concat(chunks);
  return (b.length ? JSON.parse(b.toString('utf8')) : {}) as T;
}

function wrap(fn: Handler, guard: boolean): Handler {
  return async (req, res, m, url) => {
    if (guard && !tokenOk(req, url)) return send(res, 403, { error: 'This page was not served by this JustAE Flow session — reload it.' });
    try {
      await fn(req, res, m, url);
    } catch (e) {
      send(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  };
}

export function compRoutes(engine: Engine): Array<[string, RegExp, Handler]> {
  return [
    ['GET', /^\/api\/comp$/, wrap(async (_q, res, _m, url) => {
      const layer = Number(url.searchParams.get('layer'));
      send(res, 200, await engine.compView(Number.isInteger(layer) && layer > 0 ? layer : undefined));
    }, false)],
    ['POST', /^\/api\/comp\/plan$/, wrap(async (req, res) => send(res, 200, await engine.planComp(await json<CompPlanRequest>(req))), false)],
    ['POST', /^\/api\/comp\/frame$/, wrap(async (req, res) => {
      const { force } = await json<{ force?: boolean }>(req);
      send(res, 200, await engine.compFrame(!!force));
    }, true)],
    ['POST', /^\/api\/comp\/run$/, wrap(async (req, res) => {
      send(res, 200, await engine.runCompTool(await json<CompPlanRequest & { prompt?: string; resource?: string | null; seed?: number | null }>(req)));
    }, true)],
    ['POST', /^\/api\/comp\/compare$/, wrap(async (req, res) => {
      const { id, n } = await json<{ id: string; n?: number }>(req);
      send(res, 200, await engine.compare(id, n));
    }, true)],
    ['POST', /^\/api\/comp\/open$/, wrap(async (req, res) => {
      const { id, n, which } = await json<{ id: string; n?: number; which?: 'result' | 'source' }>(req);
      await engine.openResult(id, n, which === 'source' ? 'source' : 'result');
      send(res, 200, { ok: true });
    }, true)],
    ['POST', /^\/api\/comp\/export-alpha$/, wrap(async (req, res) => {
      const { id, n } = await json<{ id: string; n?: number }>(req);
      send(res, 200, await engine.exportAlpha(id, n));
    }, true)],
  ];
}
