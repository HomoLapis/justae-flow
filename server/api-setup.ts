/**
 * Getting started: readiness, the Get started card's flag, the models folder and the model downloads.
 *
 *   GET  /api/readiness?resource=<id|default>   each Featured workflow on that resource (default: the Generate pick)
 *   POST /api/onboarding                        {mode: 'hidden' | 'open' | 'auto'} — hide the card, or open it again
 *   PUT  /api/models/folder                     {path} the local ComfyUI's models folder (checked), or null
 *   PUT  /api/models/hf-token                   {token} an optional Hugging Face token (write-only), or null
 *   POST /api/models/download                   {files: [{directory, name, url?}]} — manifest files only, into that folder
 *   GET  /api/models/downloads                  the queue: per file, bytes, speed, check, errors
 *   POST /api/models/downloads/cancel           stops it; the partial file stays and resumes next time
 *   GET  /api/readme?section=<anchor>           one section of the guide, docs/GUIDE.md (the app shows its setup instructions from it)
 *
 * Routes that write or download want the page's session token, like the resource routes.
 */

import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { tokenOk } from './bridge.ts';
import type { WorkflowLibrary } from './library.ts';
import { checkModelsFolder } from './models.ts';
import { catalogueFiles, readiness, type OnboardingMode } from './readiness.ts';
import type { Services } from './services.ts';

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
    if (size > 256 * 1024) throw new Error('Request too large.');
    chunks.push(c as Buffer);
  }
  const b = Buffer.concat(chunks);
  return (b.length ? JSON.parse(b.toString('utf8')) : {}) as T;
}

function guarded(fn: Handler): Handler {
  return async (req, res, m, url) => {
    if (!tokenOk(req, url)) return send(res, 403, { error: 'This page was not served by this JustAE Flow session — reload it.' });
    try { await fn(req, res, m, url); } catch (e) { send(res, 400, { error: e instanceof Error ? e.message : String(e) }); }
  };
}

function open(fn: Handler): Handler {
  return async (req, res, m, url) => {
    try { await fn(req, res, m, url); } catch (e) { send(res, 400, { error: e instanceof Error ? e.message : String(e) }); }
  };
}

/** GitHub's anchor for a heading: lower case, punctuation dropped, spaces to hyphens. */
export function anchorOf(heading: string): string {
  return heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s/g, '-');
}

/** One section of a Markdown file: its heading line to the next heading of the same level or higher. */
export function readmeSection(md: string, anchor: string): { title: string; level: number; markdown: string } | null {
  const lines = md.split(/\r?\n/);
  let fence = false;
  let start = -1;
  let level = 0;
  let title = '';
  for (let i = 0; i < lines.length; i++) {
    if (/^```/.test(lines[i])) fence = !fence;
    if (fence) continue;
    const h = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
    if (!h) continue;
    if (start < 0) {
      if (anchorOf(h[2]) === anchor) { start = i; level = h[1].length; title = h[2].trim(); }
    } else if (h[1].length <= level) {
      return { title, level, markdown: lines.slice(start + 1, i).join('\n').trim() };
    }
  }
  return start < 0 ? null : { title, level, markdown: lines.slice(start + 1).join('\n').trim() };
}

export function setupRoutes(s: Services, library: WorkflowLibrary, root: string): Array<[string, RegExp, Handler]> {
  const deps = { services: s, library, meta: s.models.meta, folders: s.models.folders, onboarding: s.onboarding };
  return [
    ['GET', /^\/api\/readiness$/, open((_q, res, _m, url) => send(res, 200, readiness(deps, url.searchParams.get('resource'))))],
    ['POST', /^\/api\/onboarding$/, guarded(async (req, res) => {
      const { mode } = await json<{ mode?: OnboardingMode }>(req);
      if (mode !== 'hidden' && mode !== 'open' && mode !== 'auto') throw new Error('mode is hidden, open or auto.');
      s.onboarding.setMode(mode);
      send(res, 200, readiness(deps).onboarding);
    })],
    ['PUT', /^\/api\/models\/folder$/, guarded(async (req, res) => {
      const { path } = await json<{ path?: string | null }>(req);
      if (!path) { s.resources.setModelsDir(null); return send(res, 200, { ok: true, path: null }); }
      const c = checkModelsFolder(path);
      if (!c.ok) return send(res, 400, { error: c.message });
      s.resources.setModelsDir(c.path);
      s.models.folders.forget();
      send(res, 200, { ok: true, path: c.path, note: c.note });
    })],
    ['PUT', /^\/api\/models\/hf-token$/, guarded(async (req, res) => {
      const { token } = await json<{ token?: string | null }>(req);
      s.models.downloads.setToken(token ?? null);
      send(res, 200, s.models.downloads.tokenView());
    })],
    ['GET', /^\/api\/models\/hf-token$/, open((_q, res) => send(res, 200, s.models.downloads.tokenView()))],
    ['POST', /^\/api\/models\/download$/, guarded(async (req, res) => {
      const { files } = await json<{ files?: Array<{ directory: string; name: string; url?: string }> }>(req);
      const dir = s.resources.local().modelsDir;
      if (!dir) throw new Error('Set your ComfyUI models folder first (Settings ▸ Resources ▸ Local ComfyUI).');
      const c = checkModelsFolder(dir);
      if (!c.ok) throw new Error(c.message);
      const wanted = catalogueFiles(library, Array.isArray(files) ? files : []);
      const st = s.models.downloads.start(c.path, wanted);
      send(res, 200, st);
    })],
    ['GET', /^\/api\/models\/downloads$/, open((_q, res) => send(res, 200, { state: s.models.downloads.state() }))],
    ['GET', /^\/api\/readme$/, open((_q, res, _m, url) => {
      const anchor = url.searchParams.get('section') ?? '';
      const sec = readmeSection(readFileSync(join(root, 'docs', 'GUIDE.md'), 'utf8'), anchor);
      if (!sec) return send(res, 404, { error: `No section "${anchor}" in the guide.` });
      send(res, 200, { anchor, ...sec });
    })],
    ['POST', /^\/api\/models\/downloads\/cancel$/, guarded((_q, res) => { s.models.downloads.cancel(); send(res, 200, { ok: true }); })],
  ];
}
