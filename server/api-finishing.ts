/**
 * LTX finishing for the Flow window's chained step (Featured ▸ MiniMax H3 ▸ Final ▸ "+ LTX Refine"):
 *
 *   POST /api/finishing/graph   {file, size?: 'fhd' | 'same', fast?: 1|2|3}
 *       → the Refine graph for that file, planned from the file itself (ffprobe: size, frame count, fps), checked
 *         against the local ComfyUI's catalogue, ready to submit once the file is uploaded into its LoadVideo:
 *         {graph, loadNode, saveNode, previewNode, plan: {delivery, tiles, frames, load}, estimate: {seconds, line}}
 *
 * The Comp tab's runs go through the engine (server/engine.ts, finishingTool); this is the same planner and graph
 * builder (core/finishing) for a job the Flow window runs itself. Refine only, on the local ComfyUI: the file is
 * read from disk, so the route wants the page's session token.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SLUG } from '../core/brand.ts';
import { DEFAULT_OPTIONS, localVerdict, planFinish, type FinishPresetId } from '../core/finishing/plan.ts';
import { checkModels, hasQuantizedTransformer, type NodeCatalog } from '../core/finishing/models.ts';
import { buildFinishGraph } from '../core/finishing/graph.ts';
import { DEFAULT_PROMPTS } from '../core/finishing/prompt.ts';
import { validateGraph } from '../core/finishing/validate.ts';
import { describeFinishEstimate, estimateFinish } from '../core/finishing/estimate.ts';
import { tokenOk } from './bridge.ts';
import type { Services } from './services.ts';

type Handler = (req: IncomingMessage, res: ServerResponse, m: RegExpExecArray, url: URL) => Promise<void> | void;

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function json<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const b = Buffer.concat(chunks);
  return (b.length ? JSON.parse(b.toString('utf8')) : {}) as T;
}

/** Width, height, frame rate and the decoded frame count of a clip (ffprobe on the PATH). */
export function probeClip(file: string): Promise<{ width: number; height: number; fps: number; frames: number } | null> {
  return new Promise((done) => {
    let text = '';
    const p = spawn('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate,nb_read_frames', '-of', 'json', file], { windowsHide: true });
    p.stdout.on('data', (d: Buffer) => { text += d.toString(); });
    p.on('error', () => done(null));
    p.on('close', (code) => {
      try {
        const s = (JSON.parse(text) as { streams?: Array<{ width?: number; height?: number; r_frame_rate?: string; nb_read_frames?: string }> }).streams?.[0];
        const [a, b] = String(s?.r_frame_rate ?? '').split('/').map(Number);
        const fps = a && b ? a / b : 0;
        const frames = Number(s?.nb_read_frames);
        done(code === 0 && s?.width && s.height && fps && frames ? { width: s.width, height: s.height, fps, frames } : null);
      } catch {
        done(null);
      }
    });
  });
}

export function finishingRoutes(s: Services): Array<[string, RegExp, Handler]> {
  return [
    ['POST', /^\/api\/finishing\/graph$/, async (req, res, _m, url) => {
      if (!tokenOk(req, url)) return send(res, 403, { error: 'This page was not served by this JustAE Flow session — reload it.' });
      try {
        const q = await json<{ file?: string; size?: string; fast?: number }>(req);
        const file = String(q.file ?? '');
        if (!file || !existsSync(file)) return send(res, 400, { error: `No such file: ${file || '(none)'}` });
        const clip = await probeClip(file);
        if (!clip) return send(res, 400, { error: 'ffprobe could not read the clip (is ffmpeg on the PATH?).' });
        const preset: FinishPresetId = q.size === 'same' ? 'refine-same' : 'refine-fhd';
        const fast = q.fast === 2 || q.fast === 3 ? q.fast : 1;
        const plan = planFinish({ width: clip.width, height: clip.height, pixelAspect: 1, frames: clip.frames, fps: clip.fps }, { ...DEFAULT_OPTIONS, preset, preview: false, duplicate: fast, format: 'png16' });
        const local = s.resources.local();
        const oi = (s.caps.objectInfo(local.id) ?? (await s.caps.get(local.id, true).then(() => s.caps.objectInfo(local.id)))) as unknown as NodeCatalog | null;
        if (!oi) return send(res, 400, { error: 'The local ComfyUI could not be read: LTX Refine runs there.' });
        const verdict = localVerdict(plan, hasQuantizedTransformer(oi));
        if (!verdict.ok) return send(res, 400, { error: verdict.warnings.join(' ') });
        const check = checkModels(oi, plan, 'local', 'video', true);
        if (check.missingNodes.length) return send(res, 400, { error: `The local ComfyUI lacks ${check.missingNodes.join(', ')}.` });
        if (!check.models) return send(res, 400, { error: `Not on the local ComfyUI: ${check.missing.map((x) => `${x.what} (${x.file}, from ${x.repo} — accept its terms first)`).join('; ')}.` });
        const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
        const { workflow, saveNode, previewNode } = buildFinishGraph({
          plan, models: check.models, input: { video: 'flow_upload.mp4' }, prompts: { ...DEFAULT_PROMPTS },
          seed: Math.floor(Math.random() * 2 ** 47), outputPrefix: `${SLUG}/finish/chain_${stamp}/frame`,
          preview: { prefix: `${SLUG}/finish/chain_${stamp}/preview`, fps: clip.fps, audio: true },
        });
        const loadNode = Object.entries(workflow).find(([, n]) => n.class_type === 'LoadVideo')?.[0] ?? '';
        const problems = validateGraph(workflow, oi, [`${loadNode}.file`]);
        if (problems.length) return send(res, 400, { error: `The local ComfyUI would refuse the graph: ${problems.slice(0, 3).join(' · ')}` });
        const est = estimateFinish(plan);
        send(res, 200, {
          graph: workflow, loadNode, saveNode, previewNode,
          plan: { delivery: plan.delivery, tiles: plan.passes[0].grid.count, frames: plan.frames, load: plan.load, canvas: plan.passes[0].canvas },
          estimate: { seconds: Math.round(est.seconds), line: describeFinishEstimate(est) },
          models: check.models,
        });
      } catch (e) {
        send(res, 400, { error: e instanceof Error ? e.message : String(e) });
      }
    }],
  ];
}
