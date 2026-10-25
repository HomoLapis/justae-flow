/**
 * verify-finishing-run — run a finishing graph on a real ComfyUI and check what
 * comes back. This QUEUES work: use it on your own local server.
 *
 *   node scripts/verify-finishing-run.ts <baseUrl> io [--dup 2]
 *       the tiled graph's head and tail around no model — load, ×d, pad to 8n+1,
 *       cut the pad, drop the duplicates, save 16-bit PNG + the MP4 preview:
 *       every frame back must be the frame sent, in order. Seconds.
 *   node scripts/verify-finishing-run.ts <baseUrl> preview
 *       the real Refine preview tile (one 1024×576 tile of the Full HD canvas, 8 steps).
 *   node scripts/verify-finishing-run.ts <baseUrl> single <lora> [--frames N]
 *       a single-pass IC-LoRA (deblur, decompression, colorize, cleanplate, alpha, daynight) at its card's size.
 *
 * The source is ffmpeg's testsrc2 (or --video <file>: a clip you generated), uploaded as one MP4, as the Comp tab
 * does. Outputs are downloaded to a temp folder and checked with ffprobe (size, count, rgb48 = 16-bit; the MP4).
 * Ported from JustAE Flow 2's verify-finishing-run.ts (there: frames through a folder of PNGs).
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { planFinish, DEFAULT_OPTIONS } from '../core/finishing/plan.ts';
import { buildFinishGraph, type ApiGraph } from '../core/finishing/graph.ts';
import { checkFiles, type NodeCatalog } from '../core/finishing/models.ts';
import { DEFAULT_PROMPTS, singlePrompt } from '../core/finishing/prompt.ts';
import { validateGraph } from '../core/finishing/validate.ts';
import { buildSingleGraph, planSingle, SINGLE, type SingleLora } from '../core/finishing/single.ts';

const [baseArg, mode = 'io', ...rest] = process.argv.slice(2);
if (!baseArg) { console.error('usage: verify-finishing-run <baseUrl> io|preview|single <lora> [--frames N] [--video file] [--dup d]'); process.exit(2); }
const base = baseArg.replace(/\/+$/, '');
const flag = (k: string): string | undefined => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : undefined; };

let failures = 0;
const ok = (name: string, cond: boolean, detail = ''): void => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
};

const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
const work = join(tmpdir(), `justae-finish-verify-${stamp}`);
mkdirSync(work, { recursive: true });
const N = Number(flag('--frames') ?? (mode === 'io' ? 12 : 41));
let video = flag('--video');
let W = 1920;
let H = 1080;
if (!video) {
  video = join(work, 'source.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=1920x1080:rate=24:duration=${(N + 0.5) / 24}`,
    '-frames:v', String(N), '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', video]);
} else {
  const p = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', video]).toString().trim().split(',');
  W = Number(p[0]); H = Number(p[1]);
}
console.log(`source ${video} (${W}×${H}, first ${N} frames)`);

const fd = new FormData();
const upName = `justae_finish_verify_${stamp}${/\.mov$/i.test(video) ? '.mov' : '.mp4'}`;
fd.append('image', new Blob([readFileSync(video)], { type: 'video/mp4' }), upName);
fd.append('type', 'input');
fd.append('overwrite', 'true');
const up = await fetch(`${base}/upload/image`, { method: 'POST', body: fd });
if (!up.ok) { console.error(`upload: HTTP ${up.status} ${await up.text()}`); process.exit(1); }
const uploaded = ((await up.json()) as { name: string }).name;

const oi = await (await fetch(`${base}/object_info`)).json() as NodeCatalog;
const prefix = `justae-flow/finish-verify/${stamp}`;
let graph: ApiGraph;
let expect: { w: number; h: number; frames: number; save: boolean };
if (mode === 'io') {
  const d = Math.max(1, Math.min(4, Number(flag('--dup') ?? 1))) as 1 | 2 | 3 | 4;
  const plan = planFinish({ width: W, height: H, pixelAspect: 1, frames: N, fps: 24 }, { ...DEFAULT_OPTIONS, preview: false, duplicate: d });
  console.log(`  frames ${N} ×${d} = ${plan.frames.content} → ${plan.frames.total} (pad ${plan.frames.pad})`);
  graph = {
    '1': { class_type: 'LoadVideo', inputs: { file: uploaded } },
    '2': { class_type: 'GetVideoComponents', inputs: { video: ['1', 0] } },
    '3': { class_type: 'ImageFromBatch', inputs: { image: ['2', 0], batch_index: 0, length: N } },
  };
  let src: [string, number] = ['3', 0];
  if (d > 1) { graph['4'] = { class_type: 'ImageBatchRepeatInterleaving', inputs: { images: src, repeats: d } }; src = ['4', 0]; }
  graph['5'] = { class_type: 'ImageFromBatch', inputs: { image: src, batch_index: plan.frames.content - 1, length: 1 } };
  graph['6'] = { class_type: 'RepeatImageBatch', inputs: { image: ['5', 0], amount: plan.frames.pad } };
  graph['7'] = { class_type: 'VHS_MergeImages', inputs: { images_A: src, images_B: ['6', 0], merge_strategy: 'match A', scale_method: 'bicubic', crop: 'disabled' } };
  graph['8'] = { class_type: 'ImageFromBatch', inputs: { image: ['7', 0], batch_index: 0, length: plan.frames.content } };
  let out: [string, number] = ['8', 0];
  if (d > 1) { graph['9'] = { class_type: 'VHS_SelectEveryNthImage', inputs: { images: out, select_every_nth: d, skip_first_images: 0 } }; out = ['9', 0]; }
  graph['10'] = { class_type: 'SaveImageAdvanced', inputs: { images: out, filename_prefix: `${prefix}/frame`, format: 'png', 'format.bit_depth': '16-bit', 'format.input_color_space': 'sRGB' } };
  graph['11'] = { class_type: 'CreateVideo', inputs: { images: out, fps: 24, bit_depth: 8, audio: ['2', 1] } };
  graph['12'] = { class_type: 'SaveVideo', inputs: { video: ['11', 0], filename_prefix: `${prefix}/preview`, format: 'auto', 'format.codec': 'auto' } };
  expect = { w: W, h: H, frames: N, save: true };
} else {
  const all = checkFiles(oi, mode === 'single' ? [rest[0] as SingleLora] : ['refine'], 'local');
  if (!all.models) { console.error(`missing: ${all.missing.map((m) => m.file).join(', ')}`); process.exit(2); }
  console.log(`  models: ${all.models.transformer} · ${all.models.textEncoder} · ${all.models.vae} · ${Object.values(all.models.loras).join(', ')}`);
  const preview = { prefix: `${prefix}/preview`, fps: 24, audio: false };
  if (mode === 'preview') {
    const plan = planFinish({ width: W, height: H, pixelAspect: 1, frames: N, fps: 24 }, { ...DEFAULT_OPTIONS, preset: 'refine-fhd', preview: true });
    graph = buildFinishGraph({ plan, models: all.models, input: { video: uploaded }, prompts: { ...DEFAULT_PROMPTS }, seed: 42, outputPrefix: `${prefix}/frame`, preview }).workflow;
    expect = { w: plan.delivery.w, h: plan.delivery.h, frames: plan.frames.source, save: true };
    console.log(`  plan: ${plan.passes.map((p) => `${p.name} ${p.canvas.w}×${p.canvas.h}`).join(', ')} · frames ${plan.frames.source}→${plan.frames.total}`);
  } else {
    const lora = rest[0] as SingleLora;
    if (!(lora in SINGLE)) { console.error(`single: one of ${Object.keys(SINGLE).join(', ')}`); process.exit(2); }
    const plan = planSingle(lora, { width: W, height: H, frames: N, fps: 24 }, (flag('--size') as 'source' | 'bucket' | undefined));
    const master = lora === 'alpha' ? 'none' : 'png16';
    graph = buildSingleGraph({ plan, models: all.models, video: uploaded, prompt: singlePrompt(lora, 'a test pattern of coloured bars and moving shapes'), seed: 42, outputPrefix: `${prefix}/frame`, master, preview }).workflow;
    expect = { w: plan.delivery.w, h: plan.delivery.h, frames: plan.frames.source, save: master !== 'none' };
    console.log(`  plan: ${lora} at ${plan.canvas.w}×${plan.canvas.h} → ${plan.delivery.w}×${plan.delivery.h} · frames ${plan.frames.source}→${plan.frames.total}`);
  }
}

const loadId = Object.entries(graph).find(([, n]) => n.class_type === 'LoadVideo')?.[0] ?? '';
const problems = validateGraph(graph, oi, [`${loadId}.file`]);
ok('graph valid before submit', problems.length === 0, problems.join(' | '));
writeFileSync(join(work, 'graph.json'), JSON.stringify(graph, null, 2));

const promptId = randomUUID().toLowerCase();
const t0 = Date.now();
const sr = await fetch(`${base}/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: graph, client_id: 'justae-finish-verify', prompt_id: promptId }) });
const st = await sr.text();
ok('queued', sr.ok, st.slice(0, 1500));
if (!sr.ok) process.exit(1);
console.log(`  prompt ${promptId}`);

let status = '';
let minFree = Infinity;
let total = 0;
for (;;) {
  await new Promise((r) => setTimeout(r, 3000));
  const j = await (await fetch(`${base}/api/jobs/${promptId}`)).json() as { status: string; execution_error?: { exception_message?: string; node_type?: string } };
  if (j.status !== status) { status = j.status; console.log(`  ${Math.round((Date.now() - t0) / 1000)}s ${status}`); }
  if (status === 'in_progress') {
    try {
      const s = await (await fetch(`${base}/system_stats`)).json() as { devices: Array<{ vram_free: number; vram_total: number }> };
      minFree = Math.min(minFree, s.devices[0].vram_free);
      total = s.devices[0].vram_total;
    } catch { /* stats are a nicety */ }
  }
  if (status === 'completed') break;
  if (status === 'failed' || status === 'cancelled') {
    ok('ran', false, `${j.execution_error?.node_type ?? ''}: ${j.execution_error?.exception_message ?? ''}`.slice(0, 1500));
    process.exit(1);
  }
}
const seconds = Math.round((Date.now() - t0) / 1000);
console.log(`  done in ${seconds}s (lowest free VRAM seen while running: ${Number.isFinite(minFree) ? `${(minFree / 2 ** 30).toFixed(1)} of ${(total / 2 ** 30).toFixed(1)} GiB` : 'n/a'})`);

const h = await (await fetch(`${base}/history/${promptId}`)).json() as Record<string, { outputs: Record<string, { images?: Array<{ filename: string; subfolder: string; type: string }>; videos?: Array<{ filename: string; subfolder: string; type: string }> }> }>;
const outs = Object.values(h[promptId].outputs);
const imgs = outs.flatMap((o) => o.images ?? []).filter((x) => x.type === 'output' && /\.png$/i.test(x.filename));
const vids = outs.flatMap((o) => [...(o.videos ?? []), ...(o.images ?? [])]).filter((x) => x.type === 'output' && /\.mp4$/i.test(x.filename));
const outDir = join(work, 'out');
mkdirSync(outDir, { recursive: true });
const fetchOut = async (x: { filename: string; subfolder: string }, to: string): Promise<void> => {
  const q = new URLSearchParams({ filename: x.filename, subfolder: x.subfolder, type: 'output' });
  writeFileSync(to, Buffer.from(await (await fetch(`${base}/view?${q}`)).arrayBuffer()));
};
if (expect.save) {
  ok(`${expect.frames} PNG frames saved`, imgs.length === expect.frames, String(imgs.length));
  imgs.sort((a, b) => a.filename.localeCompare(b.filename));
  for (let i = 0; i < imgs.length; i++) await fetchOut(imgs[i], join(outDir, `frame_${String(i).padStart(5, '0')}.png`));
  const probe = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,pix_fmt', '-of', 'csv=p=0', join(outDir, 'frame_00000.png')]).toString().trim();
  const [w, hh, pix] = probe.split(',');
  ok(`PNG size ${expect.w}×${expect.h}`, Number(w) === expect.w && Number(hh) === expect.h, probe);
  ok('16-bit PNG (rgb48)', /rgb(a)?(48|64)/.test(pix), pix);
}
ok('one MP4 preview', vids.length === 1, String(vids.length));
if (vids[0]) {
  const mp4 = join(outDir, basename(vids[0].filename));
  await fetchOut(vids[0], mp4);
  const p = execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,pix_fmt,nb_read_frames,codec_name', '-of', 'csv=p=0', mp4]).toString().trim();
  console.log(`  ffprobe preview: ${p}`);
  ok('the preview is 8-bit H.264 at the delivery size, every frame', p.startsWith('h264,') && p.includes(`${expect.w},${expect.h},yuv420p`) && p.endsWith(`,${expect.frames}`), p);
}
if (mode === 'io' && expect.save) {
  // Every frame back must be the frame that went in, in order (Flow 2's check, there on PNGs at ≥ 45 dB): here the source
  // is H.264, decoded by ComfyUI (PyAV) and by ffmpeg with their own YUV → RGB conversions (measured 25 Oct: ~31 dB for
  // the same frame, ~20 dB for its neighbour), so: ≥ 28 dB with its own source and 6 dB better than with the next one.
  const ref = join(work, 'ref');
  mkdirSync(ref, { recursive: true });
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', video, '-frames:v', String(N), '-pix_fmt', 'rgb24', '-start_number', '0', join(ref, 'f_%05d.png')]);
  const psnr = (a: string, b: string): number => {
    const r = spawnSync('ffmpeg', ['-i', a, '-i', b, '-lavfi', '[0:v]format=rgb24[x];[1:v]format=rgb24[y];[x][y]psnr', '-f', 'null', '-'], { encoding: 'utf8' });
    const m = /average:([\d.]+|inf)/.exec(r.stderr ?? '');
    return m ? (m[1] === 'inf' ? 999 : Number(m[1])) : 0;
  };
  let same = 0;
  for (let i = 0; i < imgs.length; i++) {
    const out = join(outDir, `frame_${String(i).padStart(5, '0')}.png`);
    const own = psnr(out, join(ref, `f_${String(i).padStart(5, '0')}.png`));
    const nxt = i + 1 < N ? psnr(out, join(ref, `f_${String(i + 1).padStart(5, '0')}.png`)) : 0;
    if (own >= 28 && own > nxt + 6) same++;
  }
  ok(`every frame back is the frame sent, in order (${same}/${imgs.length})`, same === imgs.length && imgs.length === N);
}
console.log(`  files: ${outDir}`);
console.log(failures ? `\n${failures} CHECK(S) FAILED` : `\nRUN OK (${mode}, ${seconds}s)`);
process.exit(failures ? 1 : 0);
