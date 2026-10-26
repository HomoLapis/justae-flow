/**
 * verify-finishing — the LTX-2.5 finishing plans and graphs (core/finishing).
 *
 * Offline (always): the passes each preset asks the LTX pack for, the 8n+1 + pad rule, the delivery and the preview
 * tile on the pack's sizes, the "Look" check, the single-pass sizes, and that every preset builds a graph whose links
 * all resolve, with LTXVGetTilingSizes feeding every tiled pass. The pack's answers come from a fixture recorded on a
 * real ComfyUI-LTXVideo (scripts/fixtures/ltx-tiling.json): the summary text of its LTXVGetTilingSizes node.
 *
 * With a server: every graph is checked against that server's /object_info — node types, inputs, combos, ranges — and
 * the model files it would use are listed; then the live pack is asked (one-node LTXVGetTilingSizes prompts, a few
 * milliseconds each, nothing else is queued) and its tile counts are set beside JustAE Flow's clean-room estimate.
 *
 *   node scripts/verify-finishing.ts                                 offline only
 *   node scripts/verify-finishing.ts http://127.0.0.1:8188           + the local server
 *   node scripts/verify-finishing.ts http://127.0.0.1:8188 --record  (re)write the fixture from that server's pack
 *
 * The checks of JustAE Flow 2's verify-finishing.ts kept where they still apply; its comparisons with the pack's own
 * planner are gone with the port they tested (26 Oct 2026): the pack's sizes are now read, not re-computed.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  planFinish, framePlan, localVerdict, tilingRequests, DEFAULT_OPTIONS, FINISH_PRESETS,
  type FinishOptions, type FinishSource,
} from '../core/finishing/plan.ts';
import {
  approxTiles, parseTilingSummary, summaryFromHistory, tilingKey, tilingProbeGraph, windowsToCover,
  TILING_NODE, TILING_OUT, type TilingRequest, type TilingSizes,
} from '../core/finishing/sizes.ts';
import { buildFinishGraph, type ApiGraph } from '../core/finishing/graph.ts';
import { checkFiles, checkModels, requiredNodes, type FinishModels, type NodeCatalog } from '../core/finishing/models.ts';
import { lintPrompt, DEFAULT_PROMPTS, singlePrompt } from '../core/finishing/prompt.ts';
import { validateGraph } from '../core/finishing/validate.ts';
import { buildSingleGraph, planSingle, singleNodes, SINGLE, type SingleLora } from '../core/finishing/single.ts';
import { estimateFinish } from '../core/finishing/estimate.ts';

let failures = 0;
const ok = (name: string, cond: boolean, detail = ''): void => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
};

const HD: FinishSource = { width: 1920, height: 1080, pixelAspect: 1, frames: 120, fps: 24 };
const SAIL: FinishSource = { width: 1280, height: 704, pixelAspect: 1, frames: 121, fps: 24 };
const SCAN: FinishSource = { width: 640, height: 480, pixelAspect: 1, frames: 100, fps: 25 };
const DV: FinishSource = { width: 720, height: 480, pixelAspect: 0.9091, frames: 60, fps: 29.97 };
const PORTRAIT: FinishSource = { width: 1080, height: 1920, pixelAspect: 1, frames: 48, fps: 30 };
const SMALL: FinishSource = { width: 854, height: 480, pixelAspect: 1, frames: 49, fps: 24 };
const H3: FinishSource = { width: 1344, height: 768, pixelAspect: 1, frames: 124, fps: 24 };
const FOURTHREE: FinishSource = { width: 1440, height: 1080, pixelAspect: 1, frames: 77, fps: 24 };
/** The selftest's fake comp (1280×720): its fake ComfyUI answers tiling prompts from this fixture. */
const COMP720: FinishSource = { width: 1280, height: 720, pixelAspect: 1, frames: 72, fps: 24 };
const opts = (o: Partial<FinishOptions>): FinishOptions => ({ ...DEFAULT_OPTIONS, preview: false, ...o });

/** Every plan the offline checks make: the fixture holds the pack's answer for each of their requests. */
const CASES: Array<[FinishSource, FinishOptions]> = [];
for (const p of FINISH_PRESETS) {
  for (const src of [HD, SAIL, FOURTHREE]) {
    CASES.push([src, opts({ preset: p.id })], [src, { ...DEFAULT_OPTIONS, preset: p.id, preview: true }], [src, opts({ preset: p.id, duplicate: 2, format: 'exr16' })]);
  }
  for (const src of [SCAN, DV, PORTRAIT, SMALL, H3, COMP720]) CASES.push([src, opts({ preset: p.id })]);
}

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, 'fixtures', 'ltx-tiling.json');
const base = process.argv[2]?.replace(/\/+$/, '');
const record = process.argv.includes('--record');

/** Ask a server's LTX pack: one LTXVGetTilingSizes prompt, its summary from /history. */
async function askPack(url: string, r: TilingRequest): Promise<string | null> {
  const res = await fetch(`${url}/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: tilingProbeGraph(r), client_id: 'justae-flow-verify-finishing' }) });
  if (!res.ok) return null;
  const id = ((await res.json()) as { prompt_id: string }).prompt_id;
  for (let i = 0; i < 100; i++) {
    await new Promise((d) => setTimeout(d, 100));
    const h = (await (await fetch(`${url}/history/${id}`)).json()) as Record<string, unknown>;
    const t = summaryFromHistory(h[id]);
    if (t) return t;
  }
  return null;
}

if (record) {
  if (!base) { console.error('--record needs a server URL'); process.exit(2); }
  const reqs = new Map<string, TilingRequest>();
  for (const [src, o] of CASES) for (const r of tilingRequests(src, o)) reqs.set(tilingKey(r), r);
  const out: Record<string, string> = {};
  for (const [k, r] of reqs) {
    const t = await askPack(base, r);
    if (!t) { console.error(`no answer for ${k}`); process.exit(1); }
    out[k] = t;
  }
  mkdirSync(dirname(FIXTURE), { recursive: true });
  writeFileSync(FIXTURE, JSON.stringify({
    about: 'Answers of the LTXVGetTilingSizes node (its summary output) of ComfyUI-LTXVideo, recorded with `node scripts/verify-finishing.ts <url> --record` for the offline checks. Output of the user\'s own install; no code of the pack.',
    recorded: new Date().toISOString(), server: base, answers: out,
  }, null, 2) + '\n');
  console.log(`recorded ${reqs.size} answers → ${FIXTURE}`);
  process.exit(0);
}

const fixture = existsSync(FIXTURE) ? (JSON.parse(readFileSync(FIXTURE, 'utf8')) as { answers: Record<string, string> }).answers : {};
const missing = new Set<string>();
const lookup = (r: TilingRequest): TilingSizes | null => {
  const t = fixture[tilingKey(r)];
  if (!t) { missing.add(tilingKey(r)); return null; }
  return parseTilingSummary(t);
};
const plan = (src: FinishSource, o: FinishOptions) => planFinish(src, o, lookup);

console.log('\n[1] the pack\'s summary, read; the clean-room count beside the pack\'s grid');
{
  const s = parseTilingSummary('source      1920×1080 × 49f\ncanvas      1920×1088  FullHD\ntile        960×544  qHD\noutput      3840×2176  4K\noverlap     0.5\ntile_frames 49\nspatial     3×3 on canvas, 7×7 on output\ntemporal    1 chunk');
  ok('a two-canvas summary: canvas, tile, output, overlap, window, both grids, chunks', !!s && s.canvas.w === 1920 && s.canvas.h === 1088 && s.tile.w === 960 && s.output.w === 3840 && s.output.h === 2176
    && s.overlapFrac === 0.5 && s.tileFrames === 49 && s.gridCanvas?.x === 3 && s.gridOutput?.x === 7 && s.chunks === 1, JSON.stringify(s));
  const one = parseTilingSummary('canvas      1920×1088  FullHD\ntile        960×544  qHD\noutput      1920×1088  FullHD\noverlap     0.5\ntile_frames 97\nspatial     3×3 tiles\ntemporal    2 chunks');
  ok('a one-canvas summary ("3×3 tiles"): the same grid for both', !!one && one.gridCanvas?.x === 3 && one.gridOutput?.y === 3 && one.chunks === 2);
  ok('a summary missing a size is not read (null, never wrong numbers)', parseTilingSummary('canvas 1920×1088\noverlap 0.5') === null);
  ok('the one-node probe is the pack\'s node with its six inputs', JSON.stringify(Object.keys(tilingProbeGraph({ width: 1, height: 1, frames: 9, tileSize: 'qHD', initialCanvas: 'FullHD', outputSize: '4K' })[1].inputs)) === JSON.stringify(['width', 'height', 'frame_count', 'tile_size', 'initial_canvas_size', 'output_size']));
  ok('windowsToCover: one window covers a shorter length; overlap 0.5 on 1920 with 960 → 3', windowsToCover(500, 960, 0.5) === 1 && windowsToCover(1920, 960, 0.5) === 3 && windowsToCover(129, 97, 0.5) === 2);
  ok('the fixture of the pack\'s answers is there', Object.keys(fixture).length > 0, `${FIXTURE} — run with <url> --record`);
  // The estimate's count against the pack's own grid, on every recorded answer: an approximation, said as such.
  let same = 0;
  const off: string[] = [];
  for (const [k, t] of Object.entries(fixture)) {
    const sz = parseTilingSummary(t)!;
    const a = approxTiles(sz.output, sz, Number(/·(\d+)f·/.exec(k)?.[1] ?? 1));
    if (sz.gridOutput && a.x === sz.gridOutput.x && a.y === sz.gridOutput.y) same++;
    else off.push(`${k}: pack ${sz.gridOutput?.x}×${sz.gridOutput?.y}, estimate ${a.x}×${a.y}`);
  }
  console.log(`    the estimate's grid = the pack's on ${same} of ${Object.keys(fixture).length} recorded answers${off.length ? `; differs on: ${off.join(' · ')}` : ''}`);
  ok('the estimate\'s count is within one tile per side of the pack\'s on every recorded answer', Object.entries(fixture).every(([k, t]) => {
    const sz = parseTilingSummary(t)!;
    const a = approxTiles(sz.output, sz, Number(/·(\d+)f·/.exec(k)?.[1] ?? 1));
    return !sz.gridOutput || (Math.abs(a.x - sz.gridOutput.x) <= 1 && Math.abs(a.y - sz.gridOutput.y) <= 1);
  }), off.join(' · '));
}

console.log('\n[2] frames: 8n+1, at least 8 frames of pad (the cards)');
{
  const f = framePlan(120, 1);
  ok('120 → 129 (pad 9)', f.total === 129 && f.pad === 9 && (f.total - 1) % 8 === 0);
  ok('89 → 97 (pad 8)', framePlan(89, 1).total === 97);
  ok('1 frame → 9', framePlan(1, 1).total === 9);
  ok('233 → 241', framePlan(233, 1).total === 241);
  const d = framePlan(50, 3);
  ok('fast motion ×3: 50 → 150 → 161 (pad 11)', d.content === 150 && d.total === 161 && d.pad === 11);
  let bad = '';
  for (let n = 1; n <= 400 && !bad; n++) {
    for (const dup of [1, 2, 3, 4]) {
      const p = framePlan(n, dup);
      if ((p.total - 1) % 8 !== 0 || p.pad < 8 || p.pad > 15) { bad = `${n}×${dup} ${JSON.stringify(p)}`; break; }
    }
  }
  ok('every length 1..400 × dup 1..4 is 8n+1 with 8..15 frames of pad', !bad, bad);
}

console.log('\n[3] presets: what each pass asks the pack for, and the delivery on its answer');
{
  const req = (src: FinishSource, o: FinishOptions): string => tilingRequests(src, o).map((r) => `${r.outputSize}/${r.initialCanvas}/${r.tileSize}`).join(' + ');
  ok('Refine Full HD / 4K: the pack\'s FullHD / 4K output, qHD tiles', req(HD, opts({ preset: 'refine-fhd' })) === 'FullHD/FullHD/qHD' && req(HD, opts({ preset: 'refine-4k' })) === '4K/FullHD/qHD');
  ok('8K: two passes, 4K then 8K (the card: through 4K)', req(HD, opts({ preset: 'refine-8k' })) === '4K/FullHD/qHD + 8K/FullHD/qHD');
  ok('Restore archive: FullHD, then 4K (twice the Full HD step)', req(SCAN, opts({ preset: 'restore-archive' })) === 'FullHD/FullHD/qHD + 4K/FullHD/qHD');
  ok('the requests carry the display size and the padded frames', JSON.stringify(tilingRequests(DV, opts({ preset: 'restore' }))[0]) === JSON.stringify({ width: 655, height: 480, frames: 73, tileSize: 'qHD', initialCanvas: 'FullHD', outputSize: 'FullHD' }));
  const same = (src: FinishSource): string => { const t = planFinish(src, opts({ preset: 'refine-same' })).passes[0].tiling; return `${t.canvas}:${t.canvas === 'initial' ? t.initialCanvas : t.outputSize}`; };
  ok('Same size: the pack\'s canvas nearest the source (854 → qHD, 1280 → HD, 1920 → FullHD, 3840 → 4K)',
    same(SMALL) === 'initial:qHD' && same(SAIL) === 'initial:HD' && same(HD) === 'initial:FullHD' && same({ ...HD, width: 3840, height: 2160 }) === 'output:4K');

  const r4 = plan(HD, opts({ preset: 'refine-4k' }));
  ok('Refine 4K of 1920×1080: the pack\'s 3840×2176 canvas, delivered at 3840×2160', r4.sized && r4.passes[0].canvas?.w === 3840 && r4.passes[0].canvas.h === 2176 && r4.delivery?.w === 3840 && r4.delivery.h === 2160, JSON.stringify([r4.passes[0].canvas, r4.delivery]));
  ok('…its tiles are the pack\'s (7×7 of 960×544), the estimate\'s count beside them', r4.passes[0].grid?.x === 7 && r4.passes[0].tile?.w === 960 && r4.passes[0].approx?.spatial === 49 && (r4.load ?? 0) > 0);
  const r8 = plan(HD, opts({ preset: 'refine-8k' }));
  ok('8K: the second pass from the image, on the pack\'s 8K canvas, gentle = 2 steps', r8.passes.length === 2 && r8.passes[1].fromImage && !r8.passes[0].fromImage && r8.passes[1].canvas?.w === 7680 && r8.passes[1].steps === 2, JSON.stringify(r8.passes[1].canvas));
  const fhd = plan(SAIL, opts({ preset: 'refine-fhd' }));
  ok('Refine Full HD from 1280×704: the pack\'s 1920×1056, delivered as is', fhd.passes[0].canvas?.w === 1920 && fhd.passes[0].canvas.h === 1056 && fhd.delivery?.w === 1920 && fhd.delivery.h === 1056, JSON.stringify([fhd.passes[0].canvas, fhd.delivery]));
  const h3 = plan(H3, opts({ preset: 'refine-fhd' }));
  ok('1344×768 (H3): the pack\'s 1920×1088, delivered at 1904×1088 (the source\'s aspect inside it)', h3.passes[0].canvas?.h === 1088 && h3.delivery?.w === 1904 && h3.delivery.h === 1088, JSON.stringify([h3.passes[0].canvas, h3.delivery]));
  const sm = plan(SAIL, opts({ preset: 'refine-same' }));
  ok('Same size from 1280×704: the pack\'s HD canvas, delivered at 1280×704', sm.passes[0].canvas?.w === 1280 && sm.delivery?.w === 1280 && sm.delivery.h === 704, JSON.stringify([sm.passes[0].canvas, sm.delivery]));
  const rr = plan(SCAN, opts({ preset: 'restore-refine', refineInRestore: 0.3 }));
  ok('Restore + Refine: one pass, Refine 0.3 as the second LoRA', rr.passes.length === 1 && rr.passes[0].extraLora?.kind === 'refine' && rr.passes[0].extraLora.strength === 0.3);
  const a43 = plan(SCAN, opts({ preset: 'restore-archive' }));
  ok('Archive 4:3: the card\'s 1440-wide canvas and 960×544 tile are said beside the pack\'s', a43.notes.some((n) => /1440 wide/.test(n)) && a43.passes[0].canvas !== null, JSON.stringify(a43.notes));
  const portrait = plan(PORTRAIT, opts({ preset: 'refine-4k' }));
  ok('Portrait: the pack turns canvas and tile; delivery 2160×3840', portrait.delivery?.w === 2160 && portrait.delivery.h === 3840 && (portrait.passes[0].tile?.h ?? 0) > (portrait.passes[0].tile?.w ?? 0), JSON.stringify([portrait.passes[0].tile, portrait.delivery]));
  for (const p of FINISH_PRESETS) {
    const x = plan(FOURTHREE, opts({ preset: p.id }));
    ok(`${p.label}: sized from the fixture, every canvas a multiple of 32`, x.sized && x.passes.every((q) => q.canvas!.w % 32 === 0 && q.canvas!.h % 32 === 0));
  }
  const bare = planFinish(HD, opts({ preset: 'refine-4k' }));
  ok('without the pack\'s answer: no sizes, no delivery, no estimate — the card says "at run time"', !bare.sized && bare.delivery === null && estimateFinish(bare) === null);
}

console.log('\n[4] preview: one of the pack\'s tiles at 1:1, short');
{
  const pv = plan(HD, { ...DEFAULT_OPTIONS, preset: 'refine-4k', preview: true });
  ok('one pass, one tile (the pack\'s), delivered at its size', pv.passes.length === 1 && pv.passes[0].grid?.x === 1 && pv.delivery?.w === pv.passes[0].tile?.w && pv.delivery?.h === pv.passes[0].tile?.h);
  ok('first 41 frames → 49', pv.frames.source === 41 && pv.frames.total === 49);
  ok('crop centred on the pack\'s 4K canvas, on the 32 grid', !!pv.previewCrop && pv.previewCrop.x % 32 === 0 && pv.previewCrop.y % 32 === 0 && pv.previewCrop.canvas.w === 3840);
  let threw = '';
  try { buildFinishGraph({ plan: planFinish(HD, { ...DEFAULT_OPTIONS, preset: 'refine-4k', preview: true }), models: { transformer: 't', textEncoder: 'c', vae: 'v', loras: { refine: 'r' } }, input: { video: 'x.mp4' }, prompts: { ...DEFAULT_PROMPTS }, seed: 1, outputPrefix: 'x' }); } catch (e) { threw = String(e); }
  ok('a preview without the pack\'s sizes is refused (it could not pick its tile)', /needs the LTX pack sizes/.test(threw), threw);
}

console.log('\n[5] local verdict (16 GB) and the estimate');
{
  const fhd = plan(SAIL, opts({ preset: 'refine-fhd' }));
  ok('Full HD with a quantized transformer: allowed, no "hours" warning', localVerdict(fhd, true).ok && localVerdict(fhd, true).warnings.length === 0);
  ok('without a quantized transformer: refused', !localVerdict(fhd, false).ok);
  const r4 = plan(HD, opts({ preset: 'refine-4k' }));
  ok('4K: allowed, with the "hours" warning', localVerdict(r4, true).ok && localVerdict(r4, true).warnings.some((w) => /hours/.test(w)));
  const e = estimateFinish(fhd)!;
  ok('the estimate rests on measured runs and on the counted tile-steps (9 × 2 × 8 = 144 here)', e.seconds > 0 && e.tileSteps === 144 && / in \d+(–\d+)? s/.test(e.basis) && /approximation/.test(e.basis), JSON.stringify(e));
  ok('4K costs more than Full HD', estimateFinish(r4)!.seconds > e.seconds);
}

console.log('\n[6] prompts: the Look check');
{
  ok('the default Refine look names no subject', lintPrompt(DEFAULT_PROMPTS.positive, 'refine').length === 0, JSON.stringify(lintPrompt(DEFAULT_PROMPTS.positive, 'refine')));
  ok('the default Restore look names no subject', lintPrompt(DEFAULT_PROMPTS.restorePositive, 'restore').length === 0, JSON.stringify(lintPrompt(DEFAULT_PROMPTS.restorePositive, 'restore')));
  ok('"a woman in a red car" is flagged twice', lintPrompt('a woman in a red car, sharp', 'refine').length === 2, JSON.stringify(lintPrompt('a woman in a red car, sharp', 'refine')));
  ok('Italian too: "due ragazze e un cane"', lintPrompt('due ragazze e un cane', 'refine').length === 3);
  ok('Restore may describe what people wear', lintPrompt('1950s Naples, people wear wool coats', 'restore').length === 0);
  ok('Refine may not describe people at all', lintPrompt('crowd, sharp detail', 'refine').length === 1);
  ok('a noun after a determiner that is no rendering term is caught: "the lighthouse"', lintPrompt('crisp detail on the lighthouse, natural grain', 'refine').some((i) => i.word === 'lighthouse' && i.category === 'named'));
  ok('rendering words after a determiner pass: "a subtle film grain, the light"', lintPrompt('a subtle film grain, the light of dawn', 'refine').length === 0, JSON.stringify(lintPrompt('a subtle film grain, the light of dawn', 'refine')));
  ok('the Refine card\'s own example prompt passes', lintPrompt('sharp photographic detail, crisp natural texture, fine surface detail, clean edges, natural film grain, high resolution footage', 'refine').length === 0);
  const d = singlePrompt('deblur', 'a sailboat on a misty lake at dawn');
  ok('Deblur: the card\'s DEBLUR sentence, the scene in both halves', /^Reference shows a sailboat on a misty lake at dawn, heavily out of focus/.test(d.positive) && /DEBLUR a sailboat on a misty lake at dawn\. Subject identity/.test(d.positive));
  ok('Decompression: ENHANCE QUALITY', /ENHANCE QUALITY a sailboat/.test(singlePrompt('decompression', 'a sailboat').positive));
  ok('Colorization: COLORIZE with the colours', /in grayscale\. Edited shows .* COLORIZE a sailboat: white sail, golden sky\./.test(singlePrompt('colorize', 'a sailboat', 'white sail, golden sky').positive));
  ok('Clean plate: the empty place, the extra object named in both prompts', (() => { const c = singlePrompt('cleanplate', 'a lake shore', 'bicycle'); return /No bicycle anywhere in the frame/.test(c.positive) && /, bicycle$/.test(c.negative); })());
  ok('Alpha Gen: empty prompt', singlePrompt('alpha', 'anything').positive === '');
}

console.log('\n[7] single-pass sizes from the cards');
{
  ok('Deblur from 1280×704 at the source size: 1280×704', (() => { const p = planSingle('deblur', { width: 1280, height: 704, frames: 121, fps: 24 }); return p.canvas.w === 1280 && p.canvas.h === 704 && p.frames.total === 129; })());
  ok('Decompression at the bucket: shorter side 544 → 992×544', (() => { const p = planSingle('decompression', { width: 1280, height: 704, frames: 121, fps: 24 }); return p.canvas.w === 992 && p.canvas.h === 544; })());
  ok('Day-To-Night at the bucket: shorter side 448 → 800×448 (814.5 to the nearest 32)', (() => { const p = planSingle('daynight', { width: 1280, height: 704, frames: 97, fps: 24 }); return p.canvas.w === 800 && p.canvas.h === 448; })());
  ok('Alpha Gen: the source size exactly, ≤ 145 frames', (() => { const p = planSingle('alpha', { width: 1280, height: 704, frames: 121, fps: 24 }); return p.delivery.w === 1280 && p.delivery.h === 704 && p.frames.total <= 145 && !p.reason; })());
  ok('Alpha Gen refuses a clip past 145 frames', !!planSingle('alpha', { width: 1280, height: 704, frames: 200, fps: 24 }).reason);
  ok('a 4K source is capped at the 1920×1088 class', (() => { const p = planSingle('deblur', { width: 3840, height: 2160, frames: 49, fps: 24 }); return p.canvas.w === 1920 && p.canvas.h === 1088; })());
}

console.log('\n[8] graphs: every preset builds, every link resolves, the pack\'s sizes feed every tiled pass');
const fakeModels: FinishModels = {
  transformer: 'ltx-2.5-22b-distilled-transformer-nvfp4.safetensors',
  textEncoder: 'gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors',
  vae: 'ltx-2-5/ltx-2.5-video-vae-bf16.safetensors',
  loras: {
    refine: 'LTX2.5/ltx-2.5-22b-ic-lora-refine-details-1.0.safetensors', restore: 'LTX2.5/ltx-2.5-22b-ic-lora-restore-1.0.safetensors',
    deblur: 'LTX2.5/ltx-2.5-22b-ic-lora-deblur-0.9.safetensors', decompression: 'LTX2.5/ltx-2.5-22b-ic-lora-decompression-0.9.safetensors',
    colorize: 'LTX2.5/ltx-2.5-22b-ic-lora-colorization-0.9.safetensors', cleanplate: 'LTX2.5/ltx-2.5-22b-ic-lora-clean-plate-1.0.safetensors',
    alpha: 'LTX2.5/ltx-2.5-22b-ic-lora-alpha-gen-0.9.safetensors', daynight: 'LTX2.5/ltx-2.5-22b-ic-lora-day-to-night-0.9.safetensors',
  },
};
type Variant = { name: string; build: (m: FinishModels) => ApiGraph; nodes: string[]; tiled: boolean; ignore: (g: ApiGraph) => string[] };
const variants: Variant[] = [];
const dangling = (g: ApiGraph): number => Object.values(g).reduce((n, node) => n + Object.values(node.inputs).filter((v) => Array.isArray(v) && typeof v[0] === 'string' && !g[v[0] as string]).length, 0);
const loadIgnore = (g: ApiGraph): string[] => Object.entries(g).filter(([, n]) => n.class_type === 'VHS_LoadImages' || n.class_type === 'LoadVideo').map(([id, n]) => `${id}.${n.class_type === 'LoadVideo' ? 'file' : 'directory'}`);
for (const p of FINISH_PRESETS) {
  const cases: Array<[string, FinishSource, FinishOptions, 'frames' | 'video']> = [
    [p.label, HD, opts({ preset: p.id }), 'frames'],
    [`${p.label} preview`, HD, { ...DEFAULT_OPTIONS, preset: p.id, preview: true }, 'frames'],
    [`${p.label} ×2 EXR`, HD, opts({ preset: p.id, duplicate: 2, format: 'exr16' }), 'frames'],
    [`${p.label} · video in, MP4 preview`, SAIL, opts({ preset: p.id }), 'video'],
  ];
  for (const [name, src, o, input] of cases) {
    const pl = plan(src, o);
    const preview = input === 'video' ? { prefix: 'justae-flow/finish/test/preview', fps: src.fps, audio: true } : undefined;
    variants.push({
      name, nodes: requiredNodes(pl, input, !!preview), tiled: true,
      build: (m) => buildFinishGraph({ plan: pl, models: m, input: input === 'video' ? { video: 'flow_test.mp4' } : { framesDir: 'jae_finish_test' }, prompts: { ...DEFAULT_PROMPTS }, seed: 42, outputPrefix: 'justae-flow/finish/test/frame', preview }).workflow,
      ignore: loadIgnore,
    });
  }
}
{
  // JustAE Flow: the official workflows' low-VRAM decode (512 / 64 / 128 / 32), used on 16 GB cards.
  const pl = plan(SAIL, opts({ preset: 'refine-fhd', decode: 'low-vram' }));
  const preview = { prefix: 'justae-flow/finish/test/preview', fps: 24, audio: true };
  variants.push({
    name: 'Refine Full HD · low-VRAM decode', nodes: requiredNodes(pl, 'video', true), tiled: true,
    build: (m) => buildFinishGraph({ plan: pl, models: m, input: { video: 'flow_test.mp4' }, prompts: { ...DEFAULT_PROMPTS }, seed: 42, outputPrefix: 'justae-flow/finish/test/frame', preview }).workflow,
    ignore: loadIgnore,
  });
  const g = buildFinishGraph({ plan: pl, models: fakeModels, input: { video: 'x.mp4' }, prompts: { ...DEFAULT_PROMPTS }, seed: 1, outputPrefix: 'x', preview }).workflow;
  const d = Object.values(g).find((n) => n.class_type === 'VAEDecodeTiled')!.inputs;
  ok('the low-VRAM decode is the official workflows\' 512 / 64 / 128 / 32; the default stays the card\'s 1024 / 128 / 256 / 32',
    d.tile_size === 512 && d.overlap === 64 && d.temporal_size === 128 && d.temporal_overlap === 32
    && Object.values(buildFinishGraph({ plan: plan(SAIL, opts({ preset: 'refine-fhd' })), models: fakeModels, input: { video: 'x.mp4' }, prompts: { ...DEFAULT_PROMPTS }, seed: 1, outputPrefix: 'x' }).workflow).find((n) => n.class_type === 'VAEDecodeTiled')!.inputs.tile_size === 1024);
  // The wiring of the pack's node, as the official Upscale workflow wires it.
  const link = (v: unknown, slot: number): boolean => Array.isArray(v) && g[v[0] as string]?.class_type === TILING_NODE && v[1] === slot;
  const tf = Object.values(g).find((n) => n.class_type === 'LTXVTiledFusionSampler')!.inputs;
  const guide = Object.values(g).find((n) => n.class_type === 'LTXAddVideoICLoRAGuide')!.inputs;
  const scale = Object.values(g).find((n) => n.class_type === 'ImageScale')!.inputs;
  const latent = Object.values(g).find((n) => n.class_type === 'EmptyLTXVLatentVideo')!.inputs;
  ok('the sampler\'s tile_width / tile_height / overlap_frac / tile_frames are links to LTXVGetTilingSizes',
    link(tf.tile_width, TILING_OUT.tileW) && link(tf.tile_height, TILING_OUT.tileH) && link(tf.overlap_frac, TILING_OUT.overlapFrac) && link(tf.tile_frames, TILING_OUT.tileFrames), JSON.stringify(tf));
  ok('…and so are the guide\'s tile_frames, the canvas resize and the empty latent (the pack\'s output size)',
    link(guide.tile_frames, TILING_OUT.tileFrames) && link(scale.width, TILING_OUT.outputW) && link(scale.height, TILING_OUT.outputH) && link(latent.width, TILING_OUT.outputW) && link(latent.height, TILING_OUT.outputH));
  const tn = Object.values(g).find((n) => n.class_type === TILING_NODE)!.inputs;
  ok('the node gets the same inputs the card asked before the run', JSON.stringify(tn) === JSON.stringify({ width: 1280, height: 704, frame_count: 129, tile_size: 'qHD', initial_canvas_size: 'FullHD', output_size: 'FullHD' }), JSON.stringify(tn));
  const g8 = buildFinishGraph({ plan: plan(HD, opts({ preset: 'refine-8k' })), models: fakeModels, input: { video: 'x.mp4' }, prompts: { ...DEFAULT_PROMPTS }, seed: 1, outputPrefix: 'x' }).workflow;
  ok('8K: one LTXVGetTilingSizes per pass (4K, then 8K)', Object.values(g8).filter((n) => n.class_type === TILING_NODE).map((n) => n.inputs.output_size).join() === '4K,8K');
  const same = buildFinishGraph({ plan: plan(SAIL, opts({ preset: 'refine-same' })), models: fakeModels, input: { video: 'x.mp4' }, prompts: { ...DEFAULT_PROMPTS }, seed: 1, outputPrefix: 'x' }).workflow;
  const ss = Object.values(same).find((n) => n.class_type === 'ImageScale')!.inputs;
  const sl = (v: unknown, slot: number): boolean => Array.isArray(v) && same[v[0] as string]?.class_type === TILING_NODE && v[1] === slot;
  ok('Same size runs on the pack\'s initial canvas (initial_canvas_width / _height)', sl(ss.width, TILING_OUT.canvasW) && sl(ss.height, TILING_OUT.canvasH));
}
for (const lora of Object.keys(SINGLE) as SingleLora[]) {
  const pl = planSingle(lora, { width: 1280, height: 704, frames: 49, fps: 24 });
  const master = lora === 'alpha' ? 'none' : 'png16';
  variants.push({
    name: `single pass · ${lora} (${pl.canvas.w}×${pl.canvas.h})`, nodes: singleNodes(master !== 'none'), tiled: false,
    build: (m) => buildSingleGraph({ plan: pl, models: m, video: 'flow_test.mp4', prompt: singlePrompt(lora, 'a sailboat on a lake'), seed: 42, outputPrefix: 'justae-flow/finish/test/frame', master, preview: { prefix: 'justae-flow/finish/test/preview', fps: 24, audio: true } }).workflow,
    ignore: loadIgnore,
  });
}
for (const v of variants) {
  const g = v.build(fakeModels);
  const classes = new Set(Object.values(g).map((n) => n.class_type));
  ok(`${v.name}: ${Object.keys(g).length} nodes, no dangling link`, dangling(g) === 0);
  ok(`${v.name}: uses only its listed nodes`, [...classes].every((c) => v.nodes.includes(c)), [...classes].filter((c) => !v.nodes.includes(c)).join(','));
  if (v.tiled) {
    const samplers = Object.values(g).filter((n) => n.class_type === 'LTXVTiledFusionSampler');
    ok(`${v.name}: every sampler's tiles come from the pack (no tile size written in the graph)`, samplers.length > 0 && samplers.every((n) => Array.isArray(n.inputs.tile_width) && Array.isArray(n.inputs.tile_height) && Array.isArray(n.inputs.overlap_frac) && Array.isArray(n.inputs.tile_frames)));
  }
}
ok('every request the offline checks make is in the fixture', missing.size === 0, [...missing].slice(0, 5).join(' · '));

if (base) {
  console.log(`\n[9] against ${base}`);
  const r = await fetch(base + '/object_info');
  const oi = await r.json() as NodeCatalog;
  console.log(`  ${Object.keys(oi).length} node types`);
  const all = checkFiles(oi, ['refine', 'restore', 'deblur', 'decompression', 'colorize', 'cleanplate', 'alpha', 'daynight'], 'local');
  for (const x of all.missing) console.log(`  · missing: ${x.what} (${x.file} → ${x.folder}, ${x.repo})`);
  for (const n of all.notes) console.log(`  · ${n}`);
  if (all.models) console.log(`  models: ${all.models.transformer} · ${all.models.textEncoder} · ${all.models.vae}\n  IC-LoRAs: ${Object.values(all.models.loras).join(', ')}`);
  ok('every base file and IC-LoRA of the exposed tools is on this server', !!all.models, all.missing.map((m) => m.file).join(', '));
  ok('the server has the LTX pack\'s LTXVGetTilingSizes, with the size choices this code asks for', !!oi[TILING_NODE]
    && ['qHD'].every((c) => JSON.stringify(oi[TILING_NODE]?.input?.required?.tile_size).includes(c))
    && ['FullHD', '4K', '8K'].every((c) => JSON.stringify(oi[TILING_NODE]?.input?.required?.output_size).includes(c)));
  const m: FinishModels = all.models ?? fakeModels;
  for (const v of variants) {
    const g = v.build(m);
    const problems = validateGraph(g, oi, v.ignore(g));
    ok(`${v.name}: graph valid on this server`, problems.length === 0, problems.slice(0, 6).join(' | '));
  }
  const fhd = plan(SAIL, opts({ preset: 'refine-fhd' }));
  const chk = checkModels(oi, fhd, 'local', 'video', true);
  ok('checkModels for Refine Full HD (video in, preview): no missing node or file', chk.missingNodes.length === 0 && chk.missing.length === 0, JSON.stringify([chk.missingNodes, chk.missing]));
  const pl4 = plan(HD, opts({ preset: 'refine-4k' }));
  const { workflow } = buildFinishGraph({ plan: pl4, models: m, input: { framesDir: 'jae_finish_test' }, prompts: { ...DEFAULT_PROMPTS }, seed: 42, outputPrefix: 'x' });
  const byClass = (c: string): string => Object.entries(workflow).find(([, n]) => n.class_type === c)?.[0] ?? '';
  const bad = JSON.parse(JSON.stringify(workflow)) as typeof workflow;
  bad[byClass('LTXVTiledFusionSampler')].inputs.blend_var = 0.9;
  bad[byClass('KSamplerSelect')].inputs.sampler_name = 'no-such-sampler';
  bad[byClass('LTXAddVideoICLoRAGuide')].inputs.tile_framez = 97;
  bad[byClass('SaveImageAdvanced')].inputs['format.bit_depth'] = '12-bit';
  const found = validateGraph(bad, oi, [`${byClass('VHS_LoadImages')}.directory`]);
  ok('the validator rejects range, combo, input name and dynamic sub-input errors', found.length >= 4, found.join(' | '));

  // The live pack: its answers against the recorded ones, and its tile counts beside the estimate's.
  console.log('  the live LTX pack (one-node LTXVGetTilingSizes prompts):');
  const probes: TilingRequest[] = [
    { width: 1920, height: 1080, frames: 129, tileSize: 'qHD', initialCanvas: 'FullHD', outputSize: 'FullHD' },
    { width: 1920, height: 1080, frames: 129, tileSize: 'qHD', initialCanvas: 'FullHD', outputSize: '4K' },
    { width: 1920, height: 1080, frames: 129, tileSize: 'qHD', initialCanvas: 'FullHD', outputSize: '8K' },
    { width: 1280, height: 704, frames: 129, tileSize: 'qHD', initialCanvas: 'FullHD', outputSize: '8K' },
    { width: 1344, height: 768, frames: 137, tileSize: 'qHD', initialCanvas: 'FullHD', outputSize: 'FullHD' },
    { width: 872, height: 480, frames: 57, tileSize: 'qHD', initialCanvas: 'FullHD', outputSize: 'FullHD' },
    { width: 640, height: 480, frames: 113, tileSize: 'qHD', initialCanvas: 'FullHD', outputSize: '4K' },
    { width: 1080, height: 1920, frames: 57, tileSize: 'qHD', initialCanvas: 'FullHD', outputSize: '4K' },
    { width: 1920, height: 1080, frames: 249, tileSize: 'qHD', initialCanvas: 'FullHD', outputSize: 'FullHD' },
    { width: 1920, height: 1080, frames: 129, tileSize: 'HD', initialCanvas: 'FullHD', outputSize: '4K' },
  ];
  let live = 0;
  for (const q of probes) {
    const t = await askPack(base, q);
    const s = t ? parseTilingSummary(t) : null;
    if (!s) { ok(`the pack answers ${tilingKey(q)}`, false); continue; }
    live++;
    const a = approxTiles(s.output, s, q.frames);
    const rec = fixture[tilingKey(q)];
    console.log(`    ${tilingKey(q).padEnd(42)} pack: ${s.output.w}×${s.output.h}, tile ${s.tile.w}×${s.tile.h}, ${s.gridOutput?.x}×${s.gridOutput?.y} tiles, ${s.chunks} chunk(s) · estimate: ${a.x}×${a.y}, ${a.temporal} window(s)${rec && rec.trim() !== t!.trim() ? ' · DIFFERS FROM THE FIXTURE' : ''}`);
  }
  ok('the live pack answered every probe', live === probes.length);
  const drift = Object.entries(fixture).slice(0, 12);
  let same = 0;
  for (const [k, t] of drift) {
    const q = [...new Map(CASES.flatMap(([src, o]) => tilingRequests(src, o)).map((x) => [tilingKey(x), x])).values()].find((x) => tilingKey(x) === k);
    if (!q) continue;
    const now = await askPack(base, q);
    if (now?.trim() === t.trim()) same++;
  }
  ok('the fixture still matches this server\'s pack (12 answers asked again)', same === drift.length, `${same}/${drift.length} — re-record with --record if the pack changed`);
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL FINISHING CHECKS PASSED');
process.exit(failures ? 1 : 0);
