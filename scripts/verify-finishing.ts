/**
 * verify-finishing — the LTX-2.5 finishing plan and graphs (core/finishing).
 *
 * Offline (always): the tile grid against the counts of ComfyUI-LTXVideo's
 * planner (Full HD 9, 4K 49, 8K 210 for 1024×576 tiles), the 8n+1 + pad rule,
 * streaming windows, archive canvases, the single-pass sizes, the "Look" check,
 * and that every preset builds a graph whose links all resolve.
 *
 * With a server (read-only, nothing is queued): every graph is checked against
 * that server's /object_info — node types, inputs, combos, ranges — and the
 * model files it would use are listed.
 *
 *   node scripts/verify-finishing.ts                       offline only
 *   node scripts/verify-finishing.ts http://127.0.0.1:8188 + the local server
 *
 * Ported from JustAE Flow 2's scripts/verify-finishing.ts (its checks kept; the
 * routing checks there were about its own cloud and are replaced by the local
 * verdict), with the presets and the single-pass IC-LoRAs JustAE Flow adds.
 */

import {
  planFinish, tileGrid, framePlan, localVerdict, DEFAULT_OPTIONS, FINISH_PRESETS,
  type FinishOptions, type FinishSource,
} from '../core/finishing/plan.ts';
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
const opts = (o: Partial<FinishOptions>): FinishOptions => ({ ...DEFAULT_OPTIONS, preview: false, ...o });

console.log('\n[1] tile grid = ComfyUI-LTXVideo\'s planner');
ok('Full HD 1920×1088 → 3×3 = 9', tileGrid(1920, 1088, 1024, 576).count === 9);
ok('4K 3840×2176 → 7×7 = 49', tileGrid(3840, 2176, 1024, 576).count === 49);
const g8 = tileGrid(7680, 4352, 1024, 576);
ok('8K 7680×4352 → 14×15 = 210', g8.count === 210 && g8.x === 14 && g8.y === 15, `${g8.x}×${g8.y}`);
ok('a canvas smaller than the tile is one tile', tileGrid(960, 544, 1024, 576).count === 1);

console.log('\n[2] frames: 8n+1, at least 8 frames of pad, streaming windows of 97');
{
  const f = framePlan(120, 1);
  ok('120 → 129 (pad 9)', f.total === 129 && f.pad === 9 && (f.total - 1) % 8 === 0);
  ok('89 → 97 (pad 8) in one window', framePlan(89, 1).total === 97 && framePlan(89, 1).windows === 1);
  ok('1 frame → 9', framePlan(1, 1).total === 9);
  ok('129 frames: 2 windows of 97', f.windows === 2 && f.tileFrames === 97);
  ok('233 → 241: 4 windows', framePlan(233, 1).total === 241 && framePlan(233, 1).windows === 4);
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

console.log('\n[3] presets: canvases, delivery, passes');
{
  const r4 = planFinish(HD, opts({ preset: 'refine-4k' }));
  ok('Refine 4K: canvas 3840×2176, delivery 3840×2160', r4.passes[0].canvas.w === 3840 && r4.passes[0].canvas.h === 2176 && r4.delivery.w === 3840 && r4.delivery.h === 2160);
  ok('Refine 4K: 49 tiles, 2 windows, 8 steps → 784 tile-steps', r4.load === 49 * 2 * 8, String(r4.load));
  const r8 = planFinish(HD, opts({ preset: 'refine-8k' }));
  ok('8K: two passes, the second from the image', r8.passes.length === 2 && r8.passes[1].fromImage && !r8.passes[0].fromImage);
  ok('8K: 4K canvas then 7680×4352 (exactly ×2), delivery 7680×4320', r8.passes[1].canvas.w === 7680 && r8.passes[1].canvas.h === 4352 && r8.delivery.w === 7680 && r8.delivery.h === 4320);
  ok('8K light pass: 210 tiles, gentle = 2 steps', r8.passes[1].grid.count === 210 && r8.passes[1].steps === 2);
  const a43 = planFinish({ width: 640, height: 480, pixelAspect: 1, frames: 100, fps: 25 }, opts({ preset: 'restore-archive' }));
  ok('Archive 4:3: Restore 1440×1088 with 960×544 tiles', a43.passes[0].canvas.w === 1440 && a43.passes[0].canvas.h === 1088 && a43.passes[0].tile.w === 960 && a43.passes[0].tile.h === 544);
  ok('Archive 4:3: then Refine at 2880×2176, delivery 2880×2160', a43.passes[1].canvas.w === 2880 && a43.passes[1].canvas.h === 2176 && a43.delivery.w === 2880 && a43.delivery.h === 2160);
  const a169 = planFinish({ width: 1024, height: 576, pixelAspect: 1, frames: 100, fps: 25 }, opts({ preset: 'restore-archive' }));
  ok('Archive 16:9: Restore 1920×1088', a169.passes[0].canvas.w === 1920 && a169.passes[0].canvas.h === 1088);
  const dv = planFinish({ width: 720, height: 480, pixelAspect: 0.9091, frames: 60, fps: 29.97 }, opts({ preset: 'restore-archive' }));
  ok('DV 720×480 PAR 0.9091 follows the display aspect (1440 wide)', dv.passes[0].canvas.w === 1440 && dv.fixes.some((f) => /Pixel aspect/.test(f)));
  const rr = planFinish({ width: 640, height: 480, pixelAspect: 1, frames: 60, fps: 25 }, opts({ preset: 'restore-refine', refineInRestore: 0.3 }));
  ok('Restore + Refine: one pass, refine 0.3 as the second LoRA', rr.passes.length === 1 && rr.passes[0].extraLora?.kind === 'refine' && rr.passes[0].extraLora.strength === 0.3);
  const portrait = planFinish({ width: 1080, height: 1920, pixelAspect: 1, frames: 48, fps: 30 }, opts({ preset: 'refine-4k' }));
  ok('Portrait: 2160×3840 delivery, tiles turned 576×1024', portrait.delivery.w === 2160 && portrait.delivery.h === 3840 && portrait.passes[0].tile.w === 576 && portrait.passes[0].tile.h === 1024);
  // JustAE Flow's presets.
  const fhd = planFinish(SAIL, opts({ preset: 'refine-fhd' }));
  ok('Refine Full HD from 1280×704: canvas 1920×1056 = delivery, 3×3 tiles, 2 windows → 144 tile-steps',
    fhd.passes[0].canvas.w === 1920 && fhd.passes[0].canvas.h === 1056 && fhd.delivery.w === 1920 && fhd.delivery.h === 1056 && fhd.passes[0].grid.count === 9 && fhd.load === 144, JSON.stringify([fhd.passes[0].canvas, fhd.delivery, fhd.load]));
  const same = planFinish(SAIL, opts({ preset: 'refine-same' }));
  ok('Refine same size from 1280×704: 1280×704, 2×2 tiles', same.delivery.w === 1280 && same.delivery.h === 704 && same.passes[0].grid.count === 4, JSON.stringify(same.passes[0].grid));
  const rs = planFinish({ width: 854, height: 480, pixelAspect: 1, frames: 49, fps: 24 }, opts({ preset: 'restore' }));
  ok('Restore alone from 854×480: one pass at 1920×1088, delivery 1920×1080, 960×544 tiles', rs.passes.length === 1 && rs.passes[0].lora === 'restore' && rs.passes[0].canvas.w === 1920 && rs.passes[0].canvas.h === 1088 && rs.delivery.w === 1920 && rs.delivery.h === 1080 && rs.passes[0].tile.w === 960, JSON.stringify([rs.passes[0].canvas, rs.delivery]));
  for (const p of FINISH_PRESETS) {
    const plan = planFinish({ width: 1440, height: 1080, pixelAspect: 1, frames: 77, fps: 24 }, opts({ preset: p.id }));
    ok(`${p.label}: every canvas a multiple of 32`, plan.passes.every((x) => x.canvas.w % 32 === 0 && x.canvas.h % 32 === 0));
  }
}

console.log('\n[4] preview: one tile at 1:1, short');
{
  const pv = planFinish(HD, { ...DEFAULT_OPTIONS, preset: 'refine-4k', preview: true });
  ok('one pass, one tile 1024×576', pv.passes.length === 1 && pv.passes[0].grid.count === 1 && pv.delivery.w === 1024 && pv.delivery.h === 576);
  ok('first 41 frames → 49', pv.frames.source === 41 && pv.frames.total === 49);
  ok('crop centred on the 4K canvas, on the 32 grid', !!pv.previewCrop && pv.previewCrop.x % 32 === 0 && pv.previewCrop.y % 32 === 0 && pv.previewCrop.canvas.w === 3840);
}

console.log('\n[5] local verdict (16 GB) and the estimate');
{
  const fhd = planFinish(SAIL, opts({ preset: 'refine-fhd' }));
  ok('Full HD with a quantized transformer: allowed, no "hours" warning', localVerdict(fhd, true).ok && localVerdict(fhd, true).warnings.length === 0);
  ok('without a quantized transformer: refused', !localVerdict(fhd, false).ok);
  const r4 = planFinish(HD, opts({ preset: 'refine-4k' }));
  ok('4K: allowed, with the "hours" warning', localVerdict(r4, true).ok && localVerdict(r4, true).warnings.some((w) => /hours/.test(w)));
  const e = estimateFinish(fhd);
  ok('the estimate rests on measured runs and scales with the tile count', e.seconds > 0 && e.tileSteps === 144 && /steps in \d+ s/.test(e.basis), JSON.stringify(e));
  ok('4K costs more than Full HD (49 vs 9 tiles)', estimateFinish(r4).seconds > e.seconds);
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

console.log('\n[8] graphs: every preset builds, every link resolves');
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
type Variant = { name: string; build: (m: FinishModels) => ApiGraph; nodes: string[]; loras: Array<keyof FinishModels['loras']>; ignore: (g: ApiGraph) => string[] };
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
    const plan = planFinish(src, o);
    const preview = input === 'video' ? { prefix: 'justae-flow/finish/test/preview', fps: src.fps, audio: true } : undefined;
    variants.push({
      name, nodes: requiredNodes(plan, input, !!preview), loras: [...new Set(plan.passes.flatMap((x) => [x.lora, ...(x.extraLora ? [x.extraLora.kind] : [])]))],
      build: (m) => buildFinishGraph({ plan, models: m, input: input === 'video' ? { video: 'flow_test.mp4' } : { framesDir: 'jae_finish_test' }, prompts: { ...DEFAULT_PROMPTS }, seed: 42, outputPrefix: 'justae-flow/finish/test/frame', preview }).workflow,
      ignore: loadIgnore,
    });
  }
}
for (const lora of Object.keys(SINGLE) as SingleLora[]) {
  const plan = planSingle(lora, { width: 1280, height: 704, frames: 49, fps: 24 });
  const master = lora === 'alpha' ? 'none' : 'png16';
  variants.push({
    name: `single pass · ${lora} (${plan.canvas.w}×${plan.canvas.h})`, nodes: singleNodes(master !== 'none'), loras: [lora],
    build: (m) => buildSingleGraph({ plan, models: m, video: 'flow_test.mp4', prompt: singlePrompt(lora, 'a sailboat on a lake'), seed: 42, outputPrefix: 'justae-flow/finish/test/frame', master, preview: { prefix: 'justae-flow/finish/test/preview', fps: 24, audio: true } }).workflow,
    ignore: loadIgnore,
  });
}
for (const v of variants) {
  const g = v.build(fakeModels);
  const classes = new Set(Object.values(g).map((n) => n.class_type));
  ok(`${v.name}: ${Object.keys(g).length} nodes, no dangling link`, dangling(g) === 0);
  ok(`${v.name}: uses only its listed nodes`, [...classes].every((c) => v.nodes.includes(c)), [...classes].filter((c) => !v.nodes.includes(c)).join(','));
}

const base = process.argv[2];
if (base) {
  console.log(`\n[9] against ${base} (read-only)`);
  const r = await fetch(base.replace(/\/+$/, '') + '/object_info');
  const oi = await r.json() as NodeCatalog;
  console.log(`  ${Object.keys(oi).length} node types`);
  const all = checkFiles(oi, ['refine', 'restore', 'deblur', 'decompression', 'colorize', 'cleanplate', 'alpha', 'daynight'], 'local');
  for (const x of all.missing) console.log(`  · missing: ${x.what} (${x.file} → ${x.folder}, ${x.repo})`);
  for (const n of all.notes) console.log(`  · ${n}`);
  if (all.models) console.log(`  models: ${all.models.transformer} · ${all.models.textEncoder} · ${all.models.vae}\n  IC-LoRAs: ${Object.values(all.models.loras).join(', ')}`);
  ok('every base file and IC-LoRA of the exposed tools is on this server', !!all.models, all.missing.map((m) => m.file).join(', '));
  const m: FinishModels = all.models ?? fakeModels;
  for (const v of variants) {
    const g = v.build(m);
    const problems = validateGraph(g, oi, v.ignore(g));
    ok(`${v.name}: graph valid on this server`, problems.length === 0, problems.slice(0, 6).join(' | '));
  }
  // Flow 2's check of the tiled plan (nodes + files) agrees.
  const fhd = planFinish(SAIL, opts({ preset: 'refine-fhd' }));
  const chk = checkModels(oi, fhd, 'local', 'video', true);
  ok('checkModels for Refine Full HD (video in, preview): no missing node or file', chk.missingNodes.length === 0 && chk.missing.length === 0, JSON.stringify([chk.missingNodes, chk.missing]));
  // The validator must also say no: a wrong input name, a wrong combo, a number out of range, a dynamic sub-input.
  const plan = planFinish(HD, opts({ preset: 'refine-4k' }));
  const { workflow } = buildFinishGraph({ plan, models: m, input: { framesDir: 'jae_finish_test' }, prompts: { ...DEFAULT_PROMPTS }, seed: 42, outputPrefix: 'x' });
  const byClass = (c: string): string => Object.entries(workflow).find(([, n]) => n.class_type === c)?.[0] ?? '';
  const bad = JSON.parse(JSON.stringify(workflow)) as typeof workflow;
  bad[byClass('LTXVTiledFusionSampler')].inputs.overlap_frac = 0.1;
  bad[byClass('KSamplerSelect')].inputs.sampler_name = 'no-such-sampler';
  bad[byClass('LTXAddVideoICLoRAGuide')].inputs.tile_framez = 97;
  bad[byClass('SaveImageAdvanced')].inputs['format.bit_depth'] = '12-bit';
  const found = validateGraph(bad, oi, [`${byClass('VHS_LoadImages')}.directory`]);
  ok('the validator rejects range, combo, input name and dynamic sub-input errors', found.length >= 4, found.join(' | '));
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL FINISHING CHECKS PASSED');
process.exit(failures ? 1 : 0);
