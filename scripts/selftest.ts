/**
 * Offline checks — no GPU, no host app, no network beyond loopback.
 *
 *   node scripts/selftest.ts
 *
 * A fake ComfyUI (HTTP, on a random loopback port) and an in-memory host stand
 * in for the real ones, so the storyboard rules, the queue and the whole
 * generation pipeline run end to end in a couple of seconds.
 */

import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { ComfyClient } from '../core/comfy/client.ts';
import { allowedOrigin, SESSION_TOKEN, withToken } from '../server/bridge.ts';
import { decodePngGrey } from '../core/lib/png.ts';
import { ASPECTS, planReframe, simplify, subjectOf } from '../core/reframe/plan.ts';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ObjectInfo } from '../core/comfy/types.ts';
import { getRef, modelFamily, planLength, planSize, resolveModels, setRef, splitRef, type WorkflowManifest } from '../core/workflows/manifest.ts';
import { convertUiToApi } from '../core/workflows/uiconvert.ts';
import type { CardStatus } from '../core/storyboard/types.ts';
import type { Box, CanvasHost, CanvasPlaceRequest, CompRequest, HostMarker, HostSnapshot, ItemInfo, OutpaintRequest, PlaceRequest, ReframeRequest, RenderRequest, RenderResult, TimelineHost } from '../hosts/types.ts';
import { chainGraph, DELIVERY, joinGraph, planOutpaint, REFRAME_ASPECTS, SEAM_GUARD, vaceGenSize } from '../core/reframe/outpaint.ts';
import { COMP_TOOLS, extendGuide, KEEP_COLOUR_DEFAULT, ltxExtendFrames, ltxGuidedFrames, toolById } from '../core/comp/tools.ts';
import { compRoutes } from '../server/api-comp.ts';
import { FEATURED, featuredRoutes, featuredView } from '../server/api-featured.ts';
import { finishingRoutes } from '../server/api-finishing.ts';
import type { Settings } from '../server/config.ts';
import { Engine } from '../server/engine.ts';
import { WorkflowLibrary } from '../server/library.ts';
import { makeServices } from '../server/services.ts';
import { FAKE_KEY, fakeV2, resourceChecks } from './selftest-resources.ts';
import { LTX_LICENCE_LINE } from '../core/finishing/licence.ts';
import { DEFAULT_OPTIONS as FINISH_DEFAULTS, planFinish, tileGrid } from '../core/finishing/plan.ts';
import { DEFAULT_PROMPTS as FINISH_PROMPTS, lintPrompt } from '../core/finishing/prompt.ts';
import { TASKS } from '../server/resources.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
let failed = 0;
function check(name: string, cond: unknown, detail = ''): void {
  if (cond) { passed++; console.log(`  ✔ ${name}`); }
  else { failed++; console.log(`  ✖ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 8000): Promise<boolean> {
  const t = Date.now();
  while (Date.now() - t < ms) { if (fn()) return true; await sleep(50); }
  return fn();
}

/* ─── Manifest helpers ─────────────────────────────────────────────── */
console.log('manifest');
check('splitRef keeps subgraph ids and dotted fields', JSON.stringify(splitRef('398:380.sampling_mode.seed')) === JSON.stringify({ nodeId: '398:380', field: 'sampling_mode.seed' }));
check('splitRef plain', splitRef('17.image').nodeId === '17' && splitRef('17.image').field === 'image');
const ltx = { bindings: { seconds: 'x' }, sizeMultiple: 64, maxLongSide: 1536, defaults: { seconds: 5 } } as unknown as WorkflowManifest;
check('planSize 1280×720 → 1280×704 (LTX steps of 64)', JSON.stringify(planSize(ltx, { width: 1280, height: 720 })?.width) === '1280' && planSize(ltx, { width: 1280, height: 720 })?.height === 704);
check('planSize caps the long side', planSize(ltx, { width: 3840, height: 2160 })?.width === 1536);
check('planLength rounds seconds up, never down', planLength(ltx, 3.5, 24)?.seconds === 4);
const frames = { bindings: { frames: 'x' }, frameLattice: { min: 9, step: 8 } } as unknown as WorkflowManifest;
check('planLength frames on the 8n+1 lattice', planLength(frames, 2, 24)?.frames === 49);
check('modelFamily drops precision tokens', modelFamily('ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors') === modelFamily('ltx-2.5-22b-distilled-transformer-nvfp4.safetensors'));
check('modelFamily keeps different models apart', modelFamily('qwen_3_4b.safetensors') !== modelFamily('qwen_3_8b.safetensors'));
{
  const oi: ObjectInfo = { UNETLoader: { input: { required: { unet_name: [['ltx-2.5-22b-distilled-transformer-nvfp4.safetensors', 'other.safetensors']] } } }, CLIPLoader: { input: { required: { clip_name: ['COMBO', { options: ['a.safetensors'] }] } } } };
  const api = { 1: { class_type: 'UNETLoader', inputs: { unet_name: 'ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors' } }, 2: { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen_3_4b.safetensors' } } };
  const r = resolveModels(api, oi, [{ name: 'qwen_3_4b.safetensors', directory: 'text_encoders', url: 'https://example.invalid/q' }]);
  check('resolveModels swaps in the local precision', api[1].inputs.unet_name === 'ltx-2.5-22b-distilled-transformer-nvfp4.safetensors' && r.remaps.length === 1);
  check('resolveModels reports what is missing, with its URL', r.missing.length === 1 && r.missing[0].url === 'https://example.invalid/q');
}

/* ─── Bundled workflows ────────────────────────────────────────────── */
console.log('bundled workflows');
const library = new WorkflowLibrary(join(root, 'workflows'));
for (const m of library.list()) {
  const api = library.graph(m.id)!;
  const broken = Object.entries(m.bindings).filter(([, ref]) => getRef(api, ref) === undefined);
  check(`${m.id}: every binding points at a real input`, broken.length === 0, broken.map(([k]) => k).join(', '));
  check(`${m.id}: open weights, licence named`, m.license.openWeights && m.license.weights.length > 3);
  if (m.id.startsWith('ltx')) {
    check(`${m.id}: the LTX-2.x Community License as the README states it, with its link`,
      m.license.weights.startsWith(LTX_LICENCE_LINE)
      && m.license.weights.includes('https://github.com/Lightricks/LTX-2/blob/main/LICENSE-2_x'));
  }
  if (m.output === 'text') check(`${m.id}: answers in words, through its PreviewAny node`, api[m.text?.node ?? '']?.class_type === 'PreviewAny');
  else check(`${m.id}: has a Save node with a justae-flow prefix`, Object.values(api).some((n) => /^Save/.test(n.class_type) && String(n.inputs.filename_prefix ?? '').startsWith('justae-flow/')));
  check(`${m.id}: no partner/API nodes`, !Object.values(api).some((n) => /Api|API/.test(n.class_type)));
}
{
  const ui = { nodes: [
    { id: 1, type: 'PrimitiveNode', widgets_values: [7], outputs: [{ name: 'INT', type: 'INT', links: [1] }] },
    { id: 2, type: 'Thing', inputs: [{ name: 'n', type: 'INT', link: 1, widget: { name: 'n' } }], widgets_values: [0] },
    { id: 3, type: 'Note', widgets_values: ['hi'] },
  ], links: [[1, 1, 0, 2, 0, 'INT']] };
  const conv = convertUiToApi(ui, { Thing: { input: { required: { n: ['INT', {}] } }, output_node: true } });
  check('uiconvert folds a primitive into its consumer and drops notes', conv.api['2']?.inputs.n === 7 && !conv.api['3']);
}

/* ─── Reframe maths ────────────────────────────────────────────────── */
console.log('reframe');
/** A grey PNG with a bright block — the shape of the masks the tracking workflow saves. */
function maskPng(w: number, h: number, block: [number, number, number, number] | null, colour: 0 | 2 = 0): Uint8Array {
  const ch = colour === 2 ? 3 : 1;
  const rows: Buffer[] = [];
  let prev = Buffer.alloc(w * ch);
  for (let y = 0; y < h; y++) {
    const px = Buffer.alloc(w * ch);
    for (let x = 0; x < w; x++) {
      const on = block && x >= block[0] && x < block[0] + block[2] && y >= block[1] && y < block[1] + block[3];
      for (let c = 0; c < ch; c++) px[x * ch + c] = on ? 255 : 0;
    }
    // Alternate the Sub and Up filters so the decoder's unfiltering is exercised.
    const filter = y % 2 === 0 ? 1 : 2;
    const enc = Buffer.alloc(w * ch);
    for (let i = 0; i < enc.length; i++) enc[i] = (px[i] - (filter === 1 ? (i >= ch ? px[i - ch] : 0) : prev[i])) & 255;
    rows.push(Buffer.from([filter]), enc);
    prev = px;
  }
  const chunk = (type: string, body: Buffer): Buffer => {
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
    return Buffer.concat([len, Buffer.from(type, 'latin1'), body, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = colour;
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]));
}
{
  const g = decodePngGrey(maskPng(32, 18, [10, 4, 6, 8], 2));
  const f = subjectOf(g);
  check('PNG masks decode (RGB, Sub/Up filters) and give the subject\'s centre', g.width === 32 && f.found && Math.abs(f.cx - 13 / 32) < 1e-9 && Math.abs(f.cy - 8 / 18) < 1e-9);
  check('an empty mask says the subject is not there', subjectOf(decodePngGrey(maskPng(8, 8, null))).found === false);
  const moving = Array.from({ length: 48 }, (_, i) => subjectOf(decodePngGrey(maskPng(64, 36, i === 20 ? null : [8 + i, 10, 6, 16]))));
  const plan = planReframe(moving, { width: 1344, height: 768, fps: 24 }, ASPECTS['9:16'], 'gentle');
  check('9:16 from 1344×768 is a 432×768 comp, the clip at 100%', plan.width === 432 && plan.height === 768 && plan.axis === 'x');
  check('the framing follows the subject (it moves right, the clip moves left)', plan.keys[0].x > plan.keys.at(-1)!.x && plan.keys.every((k) => k.y === 384));
  check('a few keyframes, not one per frame', plan.keys.length >= 2 && plan.keys.length < 48, String(plan.keys.length));
  check('the crop never leaves the footage', plan.keys.every((k) => k.x <= 1344 / 2 && k.x >= 432 - 1344 / 2));
  check('a frame without the subject holds the framing', plan.found === 47);
  check('"locked" is one still framing', planReframe(moving, { width: 1344, height: 768, fps: 24 }, ASPECTS['9:16'], 'locked').keys.length === 1);
  check('16:9 from a vertical clip moves up and down', planReframe(moving, { width: 768, height: 1344, fps: 24 }, ASPECTS['16:9'], 'gentle').axis === 'y');
  check('simplify keeps a straight line to its ends', JSON.stringify(simplify([0, 1, 2, 3, 4], 0.1)) === '[0,4]');
}
{
  const p = planOutpaint({ width: 1344, height: 768, fps: 24, frames: 124 }, [720, 1280], DELIVERY['9:16'], 81);
  check('outpaint 9:16: the clip fills the width, the space above and below is to be generated', p.scaled[0] === 720 && p.scaled[1] === 411 && p.pad[0] === 0 && p.pad[2] === 0 && p.pad[1] + p.pad[3] === 1280 - 411 + p.inset[1] + p.inset[3]);
  // The seam fix (26 Oct): the model is shown the clip less a margin where it meets new space, so its own edge
  // (a bright line on the 21:9 draft of 25 Oct) lies under the opaque original in the comp.
  const featherGen = p.feather * (720 / 1344);
  check('outpaint: the model\'s edge is inside the clip by its soft edge (1.5 × feather) plus the guard, top and bottom only',
    p.inset[0] === 0 && p.inset[2] === 0 && p.inset[1] === Math.ceil(1.5 * featherGen) + SEAM_GUARD && p.inset[3] === p.inset[1]);
  check('outpaint: a long clip in chained runs on the model\'s 4k+1 lattice, each carrying on from the last',
    JSON.stringify(p.segments) === JSON.stringify([{ start: 0, take: 81, frames: 81, overlap: 0 }, { start: 81, take: 43, frames: 53, overlap: 8 }]) && !p.cut && Math.abs(p.seconds - 124 / 24) < 1e-9);
  check('outpaint: a short clip is one run', JSON.stringify(planOutpaint({ width: 1344, height: 768, fps: 24, frames: 50 }, [720, 1280], DELIVERY['9:16'], 81).segments) === JSON.stringify([{ start: 0, take: 50, frames: 53, overlap: 0 }]));
  const long = planOutpaint({ width: 1344, height: 768, fps: 24, frames: 1000 }, [720, 1280], DELIVERY['9:16'], 125);
  check('outpaint: a card makes at most four runs, and says what it left out', long.segments.length === 4 && long.cut && long.segments.reduce((n, s) => n + s.take, 0) === 125 + 3 * 117);
  {
    const g: Record<string, { class_type: string; inputs: Record<string, unknown> }> = { 49: { class_type: 'WanVaceToVideo', inputs: { control_video: ['110', 0], control_masks: ['130', 0] } }, 200: { class_type: 'ImageFromBatch', inputs: {} } };
    chainGraph(g, { start: '200.batch_index', padded: ['110', 0], padMask: ['110', 1], controlVideo: '49.control_video', controlMasks: '49.control_masks' }, { previous: 'part1.mp4', from: 73, overlap: 8, take: 43, size: [720, 1280] });
    check('a chained run starts from the last 8 frames of the run before (kept), then the clip\'s next frames (filled around)',
      JSON.stringify(g['49'].inputs.control_video) === '["903",0]' && g['902'].inputs.batch_index === 73 && g['902'].inputs.length === 8
      && g['904'].inputs.value === 0 && g['906'].inputs.amount === 8 && g['908'].inputs.amount === 43 && JSON.stringify(g['49'].inputs.control_masks) === '["910",0]');
    const j = joinGraph([{ file: 'a.mp4', skip: 0, take: 81 }, { file: 'b.mp4', skip: 8, take: 43 }], 24, 'x/joined');
    check('the parts are joined without the frames they repeat', j['22'].inputs.batch_index === 8 && j['22'].inputs.length === 43 && JSON.stringify(j['1'].inputs.images) === '["23",0]' && j['1'].inputs.fps === 24);
  }
  check('outpaint: in the 1080×1920 comp the clip spans the width, centred where the model saw it',
    Math.abs(p.clipScale - 1080 / 1344 * 100) < 0.01 && Math.abs(p.clipCentre[0] - 540) < 0.01 && Math.abs(p.clipCentre[1] - (p.pad[1] - p.inset[1] + 411 / 2) * 1.5) < 0.01 && p.bgScale === 150);
  check('outpaint: the soft edge stays inside the clip where it meets new space, and off its outer edges',
    p.mask[1] > 0 && p.mask[1] + p.mask[3] < 768 && p.mask[0] < 0 && p.mask[0] + p.mask[2] > 1344);
  let same = false;
  try { planOutpaint({ width: 1080, height: 1920, fps: 24, frames: 24 }, [720, 1280], DELIVERY['9:16'], 81); } catch { same = true; }
  check('outpaint: a clip already in the target shape is refused plainly', same);
}

/* ─── Fake ComfyUI ─────────────────────────────────────────────────── */
const seenHeaders: Array<{ path: string; auth: string | undefined; gpu: string | undefined }> = [];
const submits: Array<{ prompt: Record<string, { inputs: Record<string, unknown> }>; extra_data?: { preview_method?: string } }> = [];
const history: Record<string, unknown> = {};
let uploads = 0;
// The fake server has every model the bundled workflows name — the LTX transformer only as nvfp4,
// like the machine this was built on, so the precision swap is exercised.
const objectInfo: ObjectInfo = {};
for (const m of library.list()) {
  for (const n of Object.values(library.graph(m.id)!)) {
    const info = (objectInfo[n.class_type] ??= { input: { required: {} }, output_node: /^Save/.test(n.class_type) });
    for (const [k, v] of Object.entries(n.inputs)) {
      // Every other input is known by name, of any type: graphs built at run time (LTX finishing) are validated against this.
      if (typeof v !== 'string' || !/\.(safetensors|pth)$/.test(v)) { (info.input!.optional ??= {})[k] ??= ['*']; continue; }
      const opts = ((info.input!.required![k] ??= [[]])[0] as string[]);
      const local = v.replace(/transformer-(comfy-int8-convrot|bf16)/, 'transformer-nvfp4');
      if (!opts.includes(local)) opts.push(local);
    }
  }
}
const fake = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const body = await new Promise<string>((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });
  const json = (o: unknown): void => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (url.pathname === '/api/system_stats') return json({ system: { comfyui_version: 'fake' }, devices: [{ name: 'cuda:0 Fake GPU : cudaMallocAsync', vram_free: 8 * 2 ** 30, vram_total: 16 * 2 ** 30 }] });
  if (url.pathname === '/api/object_info') return json(objectInfo);
  if (url.pathname === '/api/upload/image') { uploads++; return json({ name: 'uploaded.png', subfolder: '' }); }
  if (url.pathname === '/api/queue') return json({ queue_running: [], queue_pending: [] });
  seenHeaders.push({ path: url.pathname, auth: req.headers.authorization, gpu: req.headers['x-comfy-gpu'] as string | undefined });
  if (url.pathname === '/api/prompt') {
    const p = JSON.parse(body);
    submits.push(p);
    const classes = Object.values(p.prompt as Record<string, { class_type: string }>).map((n) => n.class_type);
    const isVideo = classes.includes('SaveVideo');
    // Describe the clip: TextGenerate → PreviewAny shows words, no file.
    if (classes.includes('TextGenerate')) {
      setTimeout(() => {
        history[p.prompt_id] = { status: { status_str: 'success' }, outputs: { 7: { text: ['<think>frames</think>Description: A small sailboat glides to the right on a calm lake at dawn.'] } } };
      }, 150);
      return json({ prompt_id: p.prompt_id });
    }
    // LTX finishing: the 16-bit frames on the SaveImageAdvanced node, the MP4 on the SaveVideo node (the engine reads them by node id).
    if (classes.includes('LTXICLoRALoaderModelOnly')) {
      const ids = (c: string): string[] => Object.entries(p.prompt as Record<string, { class_type: string }>).filter(([, n]) => n.class_type === c).map(([id]) => id);
      const outs: Record<string, unknown> = {};
      for (const id of ids('SaveImageAdvanced')) outs[id] = { images: [0, 1, 2].map((i) => ({ filename: `frame_${String(i).padStart(5, '0')}_.png`, subfolder: 'justae-flow/finish', type: 'output' })) };
      for (const id of ids('SaveVideo')) outs[id] = { images: [{ filename: 'preview_00001_.mp4', subfolder: 'justae-flow/finish', type: 'output' }], animated: [true] };
      setTimeout(() => { history[p.prompt_id] = { status: { status_str: 'success' }, outputs: outs }; }, 150);
      return json({ prompt_id: p.prompt_id });
    }
    // The tracking workflow saves one small mask per frame.
    const track = classes.includes('SAM3_VideoTrack') && !isVideo;
    const files = track
      ? Array.from({ length: 12 }, (_, i) => ({ filename: `track_${String(i).padStart(5, '0')}.png`, subfolder: 'justae-flow', type: 'output' }))
      : [{ filename: isVideo ? 'out.mp4' : 'out.png', subfolder: 'justae-flow', type: 'output' }];
    setTimeout(() => {
      history[p.prompt_id] = { status: { status_str: 'success' }, outputs: { 9: { images: files } } };
    }, 150);
    return json({ prompt_id: p.prompt_id });
  }
  const h = /^\/api\/history\/(.+)$/.exec(url.pathname);
  if (h) return json(history[h[1]] ? { [h[1]]: history[h[1]] } : {});
  if (url.pathname === '/api/view') {
    const t = /^track_(\d+)\.png$/.exec(url.searchParams.get('filename') ?? '');
    res.writeHead(200);
    return res.end(t ? maskPng(64, 36, [10 + Number(t[1]) * 3, 8, 6, 20]) : Buffer.from('fake-media-bytes'));
  }
  res.writeHead(404); res.end();
});
await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()));
const comfyUrl = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;

console.log('page bridge');
{
  check('only this app\'s own page may drive the server', allowedOrigin('http://127.0.0.1:5199', 5199) && allowedOrigin(undefined, 5199)
    && !allowedOrigin('https://example.com', 5199) && !allowedOrigin('http://127.0.0.1:9999', 5199));
  const page = withToken('<head><meta name="flow-token" content="" /></head>');
  check('the page carries the session token, and only the page', page.includes(`content="${SESSION_TOKEN}"`) && SESSION_TOKEN.length === 32);
}

console.log('cloud router');
{
  const routed = new ComfyClient(comfyUrl, { token: 't0k', gpu: 'H100' });
  await routed.submit({ 1: { class_type: 'SaveImage', inputs: {} } }, 'c');
  const sent = seenHeaders.filter((h) => h.path === '/api/prompt').at(-1);
  check('a ComfyUI behind a router gets the token and the chosen GPU with the job', sent?.auth === 'Bearer t0k' && sent.gpu === 'H100');
  await new ComfyClient(comfyUrl).submit({ 1: { class_type: 'SaveImage', inputs: {} } }, 'c');
  const plain = seenHeaders.filter((h) => h.path === '/api/prompt').at(-1);
  check('a plain ComfyUI gets neither', plain?.auth === undefined && plain?.gpu === undefined);
  submits.length = 0;
}

await resourceChecks(check, until);

/* ─── Fake host ────────────────────────────────────────────────────── */
const projectDir = mkdtempSync(join(tmpdir(), 'sf-selftest-'));
class FakeHost implements TimelineHost {
  readonly id = 'effectcraft' as const;
  readonly kind = 'timeline' as const;
  readonly label = 'EffectCraft';
  markers: HostMarker[] = [];
  layers: Array<{ id: number; index: number; name: string; in: number; out: number; start: number; label: string; type: string; item: number; visible: boolean }> = [];
  items = new Map<number, { path: string | null; width: number; height: number; duration?: number }>();
  workArea: [number, number] | undefined = undefined;
  renders: RenderRequest[] = [];
  comps: CompRequest[] = [];
  visibility: Array<[number, boolean]> = [];
  relinks: Array<[number, string]> = [];
  labels: string[] = [];
  nextId = 100;
  selected: number[] = [];
  compId = 1;
  mattes: Array<[number, number, string]> = [];
  reframes: ReframeRequest[] = [];
  outpaints: OutpaintRequest[] = [];
  duration = 12;
  frames: Array<{ time: number; out: string }> = [];
  async snapshot(): Promise<HostSnapshot> {
    return {
      app: 'effectcraft', version: 'fake', project: { path: join(projectDir, 'p.ecproj'), dirty: false },
      comp: { id: this.compId, name: 'Comp', width: 1280, height: 720, fps: 24, duration: this.duration, workArea: this.workArea ?? [0, this.duration] },
      markers: this.markers.map((m, index) => ({ ...m, index })), layers: this.layers.map(({ item: _i, visible: _v, ...l }) => l),
      selectedLayers: this.selected, time: 0,
    };
  }
  /** frameAt writes a real (tiny) PNG, for the ffmpeg routes (Extend's guide, Describe the clip). */
  realFrames = false;
  kinds = new Map<number, string>();
  async frameAt(t: number, out: string): Promise<string> {
    this.frames.push({ time: t, out });
    if (this.realFrames) (await import('node:child_process')).spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=gray:size=64x36', '-frames:v', '1', out]);
    else (await import('node:fs')).writeFileSync(out, 'png');
    return out;
  }
  async setCompDuration(s: number): Promise<void> { this.duration = s; }
  async tagMarker(i: number, id: string): Promise<void> { this.markers[i].cardId = id; }
  async setMarkerComment(i: number, c: string): Promise<void> { this.markers[i].comment = c; }
  async setStatus(t: { markerIndex?: number; layerId?: number }, s: CardStatus): Promise<void> { this.labels.push(`${t.markerIndex ?? ''}/${t.layerId ?? ''}:${s}`); if (t.markerIndex !== undefined) this.markers[t.markerIndex].label = s; }
  async place(r: PlaceRequest): Promise<{ itemId: number; layerId: number }> {
    const itemId = this.nextId++; const layerId = this.nextId++;
    this.items.set(itemId, { path: r.file, width: 1280, height: 704 });
    const at = Math.max(0, (r.index ?? 1) - 1);
    this.layers.splice(at, 0, { id: layerId, index: 1, name: r.name, in: r.time, out: r.endTime ?? r.time + 4, start: r.sourceStart ?? r.time, label: 'Green', type: 'Footage', item: itemId, visible: true });
    this.layers.forEach((l, i) => (l.index = i + 1));
    return { itemId, layerId };
  }
  async setTrackMatte(layer: number, matte: number | null, kind: string): Promise<void> { this.mattes.push([layer, matte ?? -1, matte === null ? 'none' : kind]); }
  async buildReframe(r: ReframeRequest): Promise<{ compId: number; layerId: number }> { this.reframes.push(r); this.compId = this.nextId++; return { compId: this.compId, layerId: this.nextId++ }; }
  async openComp(id: number): Promise<void> { this.compId = id; }
  async buildOutpaint(r: OutpaintRequest): Promise<{ compId: number; fillLayer: number; fillItem: number; clipLayer: number }> { this.outpaints.push(r); this.compId = this.nextId++; return { compId: this.compId, fillLayer: this.nextId++, fillItem: this.nextId++, clipLayer: this.nextId++ }; }
  async replaceFootage(itemId: number, file: string): Promise<void> { const it = this.items.get(itemId); if (it) it.path = file; }
  async coverComp(): Promise<void> {}
  async fitComp(): Promise<void> {}
  async matchLayer(): Promise<void> {}
  async createPlaceholder(r: { name: string; width: number; height: number; duration: number; time: number }): Promise<{ itemId: number; layerId: number }> {
    const itemId = this.nextId++; const layerId = this.nextId++;
    this.items.set(itemId, { path: null, width: r.width, height: r.height });
    this.layers.push({ id: layerId, index: this.layers.length + 1, name: r.name, in: r.time, out: r.time + r.duration, start: r.time, label: 'Aqua', type: 'Footage', item: itemId, visible: true });
    return { itemId, layerId };
  }
  async sourceOfLayer(id: number): Promise<number | null> { return this.layers.find((l) => l.id === id)?.item ?? null; }
  async itemInfo(id: number): Promise<ItemInfo | null> { const it = this.items.get(id); return it ? { id, name: 'x', path: it.path, kind: this.kinds.get(id) ?? 'video', width: it.width, height: it.height, duration: it.duration ?? 4, frameRate: 24, comment: '' } : null; }
  /** A render that is a real (tiny) movie, for the ffmpeg masters. */
  realRender = false;
  async renderRange(r: RenderRequest): Promise<RenderResult> {
    this.renders.push(r);
    const fs = await import('node:fs');
    fs.mkdirSync(r.dir, { recursive: true });
    const path = join(r.dir, `${r.name}.mp4`);
    if (this.realRender) {
      const { spawnSync } = await import('node:child_process');
      spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=64x36:rate=24', '-t', '0.5', '-pix_fmt', 'yuv420p', path]);
    } else {
      fs.writeFileSync(path, 'fake-render');
    }
    return { path, start: r.start, duration: Math.min(r.duration, r.cap), capped: r.duration > r.cap };
  }
  async importFile(path: string): Promise<number> {
    const id = this.nextId++;
    // The fake knows the size of a render of its comp; anything else it imports reports none.
    const render = this.renders.find((r) => path.endsWith(`${r.name}.mp4`));
    this.items.set(id, render ? { path, width: 1280, height: 720, duration: Math.min(render.duration, render.cap) } : { path, width: 0, height: 0 });
    return id;
  }
  async buildComp(r: CompRequest): Promise<{ compId: number; layers: number[] }> { this.comps.push(r); this.compId = this.nextId++; return { compId: this.compId, layers: r.layers.map(() => this.nextId++) }; }
  async addMarker(time: number, comment: string): Promise<void> { this.markers.push({ index: 0, time, duration: 0, comment, label: 'None', cardId: null }); this.markers.sort((a, b) => a.time - b.time); }
  async setLayerComment(): Promise<void> {}
  async renameLayer(): Promise<void> {}
  async relink(itemId: number, path: string): Promise<void> { this.relinks.push([itemId, path]); }
  async setLayerVisible(id: number, v: boolean): Promise<void> { this.visibility.push([id, v]); const l = this.layers.find((x) => x.id === id); if (l) l.visible = v; }
  async setLayerLabel(): Promise<void> {}
  close(): void {}
}

/* ─── Storyboard ───────────────────────────────────────────────────── */
console.log('storyboard sync');
const host = new FakeHost();
const settings: Settings = {
  comfyUrl, comfyToken: '', comfyGpu: '', host: 'effectcraft', effectcraftPort: 0, photocraftPort: 0, photocraftTokenFile: '', photocraftRoot: projectDir,
  canvasPlaceholderWorkflow: 'zimage-t2i', selectionWorkflow: 'qwen-edit',
  markerWorkflow: 'ltx25-t2v', placeholderWorkflow: 'ltx25-t2v', placeholderSeconds: 4, pollSeconds: 60, setupDone: true,
};
{
  const secret = new Engine({ ...settings, comfyToken: 's3cret' }, library, makeServices(mkdtempSync(join(tmpdir(), 'jaf-svc-')), () => settings, library, 'http://127.0.0.1:9'), new FakeHost());
  const st = secret.state();
  check('the router token never reaches the browser', !JSON.stringify(st).includes('s3cret') && st.settings.comfyTokenSet && st.comfy.routed);
}
// The engine's resources, run history and balance live in a temporary folder; the Cloud stand-in is the fake v2.
const v2fake = await fakeV2();
const svcDir = mkdtempSync(join(tmpdir(), 'jaf-svc-'));
const services = makeServices(svcDir, () => settings, library, v2fake.url);
const engine = new Engine(settings, library, services, host);
await engine.checkComfy();
await host.addMarker(1, 'a paper plane over a desk');
await host.addMarker(5, 'a red balloon in the sky');
await engine.sync();
let s = engine.state();
check('two markers become two cards, in time order', s.cards.length === 2 && s.cards[0].at === 1 && s.cards[1].at === 5);
check('the marker text is the prompt', s.cards[0].prompt === 'a paper plane over a desk');
check('a marker slot runs to the next marker', s.cards[0].slotSeconds === 4);
check('the last marker runs to the comp end', s.cards[1].slotSeconds === 7);
check('the plan says what will render', s.cards[0].plan.width === 1280 && s.cards[0].plan.height === 704 && s.cards[0].plan.seconds === 4);
const [a, b] = s.cards;

host.markers[0].time = 2;
await engine.sync();
s = engine.state();
check('moving an untagged marker keeps its card (same text)', s.cards.find((c) => c.id === a.id)?.at === 2);
host.markers[1].comment = 'a blue balloon';
await engine.sync();
check('editing the marker text in the host updates the prompt', engine.state().cards.find((c) => c.id === b.id)?.prompt === 'a blue balloon');
await engine.updateCards([a.id], { prompt: 'a white paper plane' });
check('editing the prompt in the card rewrites the marker text', host.markers[0].comment === 'a white paper plane');

console.log('generation');
const n = engine.enqueue();
check('"Generate all" takes every ready card', n === 2);
check('the queue paints the host: queued', host.labels.some((l) => l.endsWith(':queued')));
await until(() => engine.state().cards.every((c) => c.status === 'done'));
s = engine.state();
check('both cards finish', s.cards.every((c) => c.status === 'done'), s.cards.map((c) => `${c.status} ${c.error ?? ''}`).join(' | '));
check('submitted once per card — never twice', submits.length === 2, String(submits.length));
check('live previews were asked for', submits.every((p) => p.extra_data?.preview_method === 'auto'));
const sent = submits[0].prompt;
const ltxM = library.get('ltx25-t2v')!.manifest;
check('the prompt reached its node', getRef(sent as never, ltxM.bindings.prompt) === 'a white paper plane');
check('the slot set the length (marker at 2s, next at 5s → 3s)', getRef(sent as never, ltxM.bindings.seconds) === 3);
check('the comp set the size (1280×704)', getRef(sent as never, ltxM.bindings.width) === 1280 && getRef(sent as never, ltxM.bindings.height) === 704);
check('the int8 model was swapped for the local nvfp4', JSON.stringify(sent).includes('nvfp4'));
const done = s.cards[0];
check('the result was placed at the marker', host.layers.some((l) => l.in === 2 && l.item === done.placed?.itemId));
check('the result is trimmed to the next marker', host.layers.find((l) => l.item === done.placed?.itemId)?.out === 5);
check('the marker is tagged with its card', host.markers[0].cardId === done.id);
check('the marker turns done', host.markers[0].label === 'done');
check('the version is on disk with its job record', existsSync(join(s.mediaDir, done.versions[0].file)) && existsSync(join(s.mediaDir, done.versions[0].file.replace(/\.\w+$/, '.job.json'))));
check('"Generate all" skips finished cards', engine.enqueue() === 0);

engine.enqueue([done.id]);
await until(() => engine.state().cards.find((c) => c.id === done.id)?.versions.length === 2);
const two = engine.state().cards.find((c) => c.id === done.id)!;
check('a new run is a new version, the old one kept', two.versions.length === 2 && two.activeVersion === 2);
check('the new version replaced the footage under the same layer', host.items.get(two.placed!.itemId)?.path?.endsWith(two.versions[1].file.split('/')[1]));
await engine.selectVersion(done.id, 1);
check('switching back puts v1 in the comp', host.items.get(two.placed!.itemId)?.path?.endsWith(two.versions[0].file.split('/')[1]) && engine.state().cards.find((c) => c.id === done.id)?.activeVersion === 1);

console.log('engine on resources');
{
  const job = JSON.parse(readFileSync(join(s.mediaDir, done.versions[0].file.replace(/\.\w+$/, '.job.json')), 'utf8'));
  check('a card with no choice runs where its task\'s row says (video: Auto → Local)', engine.state().cards[0].runsOn?.id === 'local' && /Auto/.test(engine.state().cards[0].runsOn?.why ?? ''));
  check('job.json says where it ran, and nothing billed on your own GPU', job.resource?.id === 'local' && job.resource.creditsPerHour === null && job.resource.cost === undefined);
  check('local runs go into the run history (in the test folder, never the user\'s)', services.runs.of('ltx25-t2v', 'local').length >= 3 && existsSync(join(svcDir, 'runs.json')));
  // The same card on a deployment (the fake v2), through the SDK.
  services.resources.update({ apiKey: FAKE_KEY, resources: [{ id: 'deployment', url: v2fake.url, enabled: true }] });
  await engine.updateCards([done.id], { resource: 'deployment' });
  check('a card can be sent to another resource; the card says so', engine.state().cards.find((c) => c.id === done.id)?.runsOn?.id === 'deployment');
  const prompts = submits.length;
  engine.enqueue([done.id]);
  await until(() => engine.state().cards.find((c) => c.id === done.id)?.versions.length === 3, 10_000);
  const onDep = engine.state().cards.find((c) => c.id === done.id)!;
  const v3 = onDep.versions[2];
  check('it ran on the deployment, not on the local ComfyUI', onDep.status === 'done' && v3?.resource === 'deployment' && submits.length === prompts, onDep.error);
  check('the version carries the execution time and the derived credits (12 s × 736.39 cr/h ≈ 2.45)', v3?.executionMs === 12_000 && Math.abs((v3?.derivedCredits ?? 0) - 2.45) < 0.01);
  check('the input frame went up as a v2 asset', v2fake.seen.some((x) => x.path === '/api/v2/jobs' && x.method === 'POST'));
  const job3 = JSON.parse(readFileSync(join(s.mediaDir, v3.file.replace(/\.\w+$/, '.job.json')), 'utf8'));
  check('its job.json: the resource, its GPU and rate, and the cost marked as derived', job3.resource?.id === 'deployment' && job3.resource.gpu === 'RTX PRO 6000' && job3.resource.creditsPerHour === 736.39 && /≈/.test(job3.resource.cost?.basis ?? ''));
  check('the key is in none of it', !readFileSync(join(s.mediaDir, v3.file.replace(/\.\w+$/, '.job.json')), 'utf8').includes('test-key') && !JSON.stringify(engine.state()).includes('test-key'));
  await engine.updateCards([done.id], { resource: 'default' });
  services.resources.update({ apiKey: null, resources: [{ id: 'deployment', remove: true }] });
}

console.log('placeholders, layers, errors');
const pid = await engine.createPlaceholder();
const ph = engine.state().cards.find((c) => c.id === pid)!;
check('a placeholder is a card with the placeholder workflow', ph.origin.kind === 'placeholder' && ph.workflowId === 'ltx25-t2v');
await engine.updateCards([pid], { prompt: 'a lighthouse at dusk' });
engine.enqueue([pid]);
await until(() => engine.state().cards.find((c) => c.id === pid)?.status === 'done');
const phDone = engine.state().cards.find((c) => c.id === pid)!;
check('the placeholder is filled in place (same item)', phDone.placed?.itemId === (ph.origin as { itemId: number }).itemId && !!host.items.get(phDone.placed!.itemId)?.path);
await engine.updateCards([b.id], { workflowId: 'seedvr2-upscale' });
engine.enqueue([b.id]);
await until(() => engine.state().cards.find((c) => c.id === b.id)?.status === 'error');
const err = engine.state().cards.find((c) => c.id === b.id)!;
check('a marker cannot feed a video-input workflow — said plainly', err.status === 'error' && /needs a video/.test(err.error ?? ''));
check('the error keeps the earlier version', err.versions.length === 1);
check('the error is painted in the host', host.labels.some((l) => l.endsWith(':error')));
host.selected = [host.layers.find((l) => l.name.startsWith('Flow placeholder'))!.id];
await engine.sync();
let already = false;
try { await engine.adoptSelectedLayers(); } catch { already = true; }
check('a layer that already has a card is not adopted twice', already);
host.selected = [host.layers.find((l) => l.name.startsWith('Flow ·'))!.id];
await engine.sync();
const adopted = await engine.adoptSelectedLayers();
check('a selected layer becomes a card', adopted.length === 1 && engine.state().cards.find((c) => c.id === adopted[0])?.origin.kind === 'layer');
host.markers.splice(0, 1);
await engine.sync();
check('a deleted marker leaves an orphan card, versions kept', engine.state().cards.find((c) => c.id === done.id)?.orphan === true);
engine.removeCard(done.id);
check('an orphan can be removed from the storyboard', !engine.state().cards.some((c) => c.id === done.id));
let refused = false;
try { engine.removeCard(err.id); } catch { refused = true; }
check('a live marker card cannot be removed (it would come back)', refused);

console.log('video matte and reframe');
const clipPath = join(projectDir, 'clip.mov');
writeFileSync(clipPath, 'fake-clip');
host.items.set(900, { path: clipPath, width: 1344, height: 768 });
host.layers.push({ id: 901, index: host.layers.length + 1, name: 'clip.mov', in: 1.5, out: 5, start: 1, label: 'Aqua', type: 'Footage', item: 900, visible: true });
host.selected = [901];
await engine.sync();
const [clipCard] = await engine.adoptSelectedLayers();
await engine.updateCards([clipCard], { workflowId: 'sam3-matte', prompt: 'woman' });
check('the matte plan says what it does', /luma track matte/.test(engine.state().cards.find((c) => c.id === clipCard)!.plan.sizeNote ?? ''));
engine.enqueue([clipCard]);
await until(() => ['done', 'error'].includes(engine.state().cards.find((c) => c.id === clipCard)!.status));
const matteCard = engine.state().cards.find((c) => c.id === clipCard)!;
const matteLayer = host.layers.find((l) => l.id === matteCard.placed?.layerId);
check('a subject matte finishes', matteCard.status === 'done', matteCard.error);
check('the clip gets the matte as a luma track matte', JSON.stringify(host.mattes.at(-1)) === JSON.stringify([901, matteCard.placed?.layerId, 'luma']));
check('the matte sits just above the clip', !!matteLayer && matteLayer.index === host.layers.find((l) => l.id === 901)!.index - 1);
check('the matte lines up frame for frame (same start, same in and out)', matteLayer?.start === 1 && matteLayer?.in === 1.5 && matteLayer?.out === 5);
check('the clip stays visible — the matte cuts it, nothing is hidden or deleted', host.layers.find((l) => l.id === 901)?.visible === true);
check('the subject named in the prompt reached SAM 3', JSON.stringify(submits.at(-1)).includes('"woman"'));

const clipCard2 = clipCard;
await engine.updateCards([clipCard2], { workflowId: 'sam3-reframe', params: { '@aspect': '9:16' } });
check('the reframe plan says what it does', /new 9:16 comp/.test(engine.state().cards.find((c) => c.id === clipCard2)!.plan.sizeNote ?? ''));
engine.enqueue([clipCard2]);
await until(() => engine.state().cards.find((c) => c.id === clipCard2)!.versions.length === 2 || engine.state().cards.find((c) => c.id === clipCard2)!.status === 'error');
const rf = engine.state().cards.find((c) => c.id === clipCard2)!;
const req = host.reframes.at(-1);
check('a reframe finishes as a new version', rf.status === 'done' && rf.versions.length === 2, rf.error);
check('the "@" settings never reach the graph', !JSON.stringify(submits.at(-1)).includes('@aspect'));
check('the new comp is 9:16 at the clip\'s own pixels', req?.width === 432 && req.height === 768 && req.itemId === 900);
check('its keyframes follow the subject (moving right → the clip moves left)', !!req && req.keys.length >= 2 && req.keys[0].x > req.keys.at(-1)!.x);
check('the version opens its comp', rf.versions[1].compId === host.compId);
await engine.sync();
check('inside the new comp, the storyboard still shows the card', engine.state().cards.some((c) => c.id === clipCard2));
await engine.selectVersion(clipCard2, 1);
check('choosing the matte version again leaves the comp alone', host.compId !== 1);
await host.openComp(1);
await engine.sync();
check('back in the source comp, the card is where it was', engine.state().cards.some((c) => c.id === clipCard2 && !c.orphan));

await engine.updateCards([clipCard], { workflowId: 'vace-reframe', prompt: 'a woman paddleboarding at sunset, wide calm sea', params: { '@aspect': '9:16' } });
check('the generative reframe plan names the comp and the generated size', /1080×1920/.test(engine.state().cards.find((c) => c.id === clipCard)!.plan.sizeNote ?? ''));
engine.enqueue([clipCard]);
await until(() => engine.state().cards.find((c) => c.id === clipCard)!.versions.length === 3 || engine.state().cards.find((c) => c.id === clipCard)!.status === 'error');
const op = engine.state().cards.find((c) => c.id === clipCard)!;
const opReq = host.outpaints.at(-1);
const opSent = submits.at(-1)!.prompt as never;
const vace = library.get('vace-reframe')!.manifest;
check('a generative reframe finishes as a new version with its own comp', op.status === 'done' && op.versions.length === 3 && op.versions[2].compId === host.compId, op.error);
check('the model gets the clip scaled into 720×1280 with the new space above and below',
  getRef(opSent, vace.bindings.width) === 720 && getRef(opSent, vace.bindings.height) === 1280
  && getRef(opSent, vace.outpaint!.scale[0]) === 720 && getRef(opSent, vace.outpaint!.pad[0]) === 0 && Number(getRef(opSent, vace.outpaint!.pad[1])) > 400);
check('the whole 4 s clip in one run: 96 frames in, 97 on the model\'s lattice, at the clip\'s own rate',
  getRef(opSent, vace.bindings.frames) === 97 && getRef(opSent, vace.outpaint!.take) === 96 && getRef(opSent, vace.bindings.fps) === 24);
check('the comp: 1080×1920, the generated video filling it, the clip on top with a soft edge',
  opReq?.width === 1080 && opReq.height === 1920 && opReq.fillScale === 150 && opReq.itemId === 900 && opReq.feather > 0);
check('no non-commercial LoRA in the bundled reframe', !JSON.stringify(library.graph('vace-reframe')).includes('CausVid') && !JSON.stringify(library.graph('vace-reframe-draft')).includes('CausVid'));
await host.openComp(1);
await engine.sync();

console.log('comp tab');
{
  // Sizes: the rule reproduces every size the reframe shipped with, and gives the two new formats.
  const shipped14: Record<string, [number, number]> = { '9:16': [720, 1280], '4:5': [832, 1040], '1:1': [960, 960], '16:9': [1280, 720] };
  const shipped13: Record<string, [number, number]> = { '9:16': [480, 832], '4:5': [576, 720], '1:1': [624, 624], '16:9': [832, 480] };
  check('the VACE size rule reproduces the shipped 14B and 1.3B sizes',
    Object.entries(shipped14).every(([a, s]) => JSON.stringify(vaceGenSize(a, '14b')) === JSON.stringify(s))
    && Object.entries(shipped13).every(([a, s]) => JSON.stringify(vaceGenSize(a, '1.3b')) === JSON.stringify(s)));
  check('21:9 is generated at 1456×624 (14B) and 1008×432 (1.3B): exactly 7:3, multiples of 16',
    JSON.stringify(vaceGenSize('21:9', '14b')) === '[1456,624]' && JSON.stringify(vaceGenSize('21:9', '1.3b')) === '[1008,432]');
  check('4:3 is generated at 1088×816 (14B) and 704×528 (1.3B)', JSON.stringify(vaceGenSize('4:3', '14b')) === '[1088,816]' && JSON.stringify(vaceGenSize('4:3', '1.3b')) === '[704,528]');
  check('delivery comps are 1080 on the short side: 21:9 2520×1080, 4:3 1440×1080, 9:16 1080×1920',
    JSON.stringify(DELIVERY['21:9']) === '[2520,1080]' && JSON.stringify(DELIVERY['4:3']) === '[1440,1080]' && JSON.stringify(DELIVERY['9:16']) === '[1080,1920]');
  for (const id of ['vace-reframe', 'vace-reframe-draft']) {
    const m = library.get(id)!.manifest;
    check(`${id}: the manifest offers the six formats, each with the rule's size`,
      JSON.stringify(m.params?.[0].options) === JSON.stringify([...REFRAME_ASPECTS])
      && REFRAME_ASPECTS.every((a) => JSON.stringify(m.outpaint!.sizes[a]) === JSON.stringify(vaceGenSize(a, id === 'vace-reframe' ? '14b' : '1.3b'))));
  }
  check('the auto crop offers the same six formats', JSON.stringify(library.get('sam3-reframe')!.manifest.params?.[0].options) === JSON.stringify([...REFRAME_ASPECTS]) && Math.abs(ASPECTS['21:9'] - 7 / 3) < 1e-9);
  const wide = planOutpaint({ width: 1280, height: 704, fps: 24, frames: 72 }, vaceGenSize('21:9', '1.3b'), DELIVERY['21:9'], 125);
  check('21:9 from a 1280×704 clip: the new space left and right, the clip the full height', wide.scaled[1] === 432 && wide.pad[1] === 0 && wide.pad[3] === 0 && wide.pad[0] + wide.pad[2] === 1008 - wide.scaled[0] + wide.inset[0] + wide.inset[2] && wide.bgScale === 250);
  // The case of 25 Oct: the clip at x 111–895 of 1008; the model now sees it from x 111 + 28 to 895 − 28.
  check('21:9: the model is shown the clip less 28 px left and right (the seam lands under the original)', JSON.stringify(wide.inset) === '[28,0,28,0]' && wide.pad[0] === 139 && wide.pad[2] === 140);

  // Plans, before anything runs.
  const man = (id: string) => library.get(id)?.manifest;
  const compSrc = { kind: 'workArea' as const, media: 'video' as const, width: 1280, height: 720, fps: 24, seconds: 3, requested: 3, name: 'Comp' };
  const rp = toolById('reframe')!.plan(compSrc, { aspect: '21:9', quality: 'draft', mode: 'generate' }, man);
  check('the reframe plan says the comp, the generated size and the model before it runs', rp.ok && rp.workflowId === 'vace-reframe-draft' && /2520×1080/.test(rp.makes) && /1008×432/.test(rp.makes) && rp.jobs.length === 1 && rp.variant === 'draft:21:9');
  const fp = toolById('reframe')!.plan(compSrc, { aspect: '9:16', quality: 'final' }, man);
  check('Final is the 14B workflow, at 720p', fp.workflowId === 'vace-reframe' && /720×1280/.test(fp.makes));
  const cp = toolById('reframe')!.plan(compSrc, { aspect: '4:3', mode: 'crop' }, man);
  check('crop with tracking: SAM 3, nothing generated, a 960×720 comp', cp.workflowId === 'sam3-reframe' && cp.output?.width === 960 && cp.output.height === 720 && /Nothing is generated/.test(cp.makes));
  const up4 = toolById('upscale')!.plan(compSrc, { scale: 4 }, man);
  check('×4 is two SeedVR2 passes, 5120×2880, and says it is beyond what was verified', up4.ok && up4.jobs.length === 2 && up4.output?.width === 5120 && up4.output.height === 2880 && up4.warnings.some((w) => /beyond 4K/.test(w)));
  const up2 = toolById('upscale')!.plan(compSrc, { scale: 2 }, man);
  check('×2 is one pass, 2560×1440, nothing to warn about', up2.jobs.length === 1 && up2.output?.width === 2560 && up2.warnings.length === 0 && Object.values(up2.params).includes(2));
  const still = toolById('matte')!.plan({ ...compSrc, kind: 'layer', media: 'image' }, {}, man);
  check('a tool that needs video refuses a still, in words', !still.ok && /still/.test(still.reason ?? ''));
  check('the same shape is refused: no new space to generate', !toolById('reframe')!.plan(compSrc, { aspect: '16:9' }, man).ok);

  // The engine: a run on the work area.
  host.workArea = [1, 4];
  await engine.sync();
  const plan = await engine.planComp({ tool: 'reframe', source: 'workArea', options: { aspect: '9:16', quality: 'draft' }, cap: 8 });
  check('the plan reads the work area from the host (1–4 s → 3 s)', plan.ok && plan.source.seconds === 3 && plan.source.width === 1280);
  host.workArea = [0, 12];
  await engine.sync();
  const long = await engine.planComp({ tool: 'reframe', source: 'workArea', options: { aspect: '9:16' }, cap: 8 });
  check('a work area longer than the cap is said, with the cap', long.source.seconds === 8 && long.source.requested === 12 && long.warnings.some((w) => /render stops at 8 s/.test(w)));
  host.workArea = [1, 4];
  await engine.sync();
  let noPrompt = false;
  try { await engine.runCompTool({ tool: 'reframe', source: 'workArea', options: { aspect: '9:16' }, cap: 8 }); } catch { noPrompt = true; }
  check('a reframe without a scene is refused before anything is queued', noPrompt);
  const submitsBefore = submits.length;
  const { id: rfId } = await engine.runCompTool({ tool: 'reframe', source: 'workArea', options: { aspect: '9:16', quality: 'draft' }, cap: 8, prompt: 'a calm lake at dawn, mist' });
  await until(() => ['done', 'error'].includes(engine.state().cards.find((c) => c.id === rfId)?.status ?? ''));
  const rfc = engine.state().cards.find((c) => c.id === rfId)!;
  const render = host.renders.at(-1)!;
  const rfOut = host.outpaints.at(-1)!;
  const draftM = library.get('vace-reframe-draft')!.manifest;
  const rfSent = submits.at(-1)!.prompt as never;
  check('a Comp tab reframe finishes', rfc.status === 'done' && rfc.versions.length === 1, rfc.error);
  check('the host rendered exactly the work area, with the cap, into the card\'s folder', render.start === 1 && render.duration === 3 && render.cap === 8 && render.dir.endsWith(rfId));
  check('the model got the render: 3 s = 72 frames → 73 on the lattice, at 480×832', getRef(rfSent, draftM.bindings.frames) === 73 && getRef(rfSent, draftM.outpaint!.take) === 72 && getRef(rfSent, draftM.bindings.width) === 480 && submits.length === submitsBefore + 1);
  check('the new comp is "Comp · 9:16", 1080×1920, with the render (imported) on top', rfOut.name === 'Comp · 9:16' && rfOut.width === 1080 && rfOut.height === 1920 && host.items.get(rfOut.itemId)?.path === join(render.dir, `${render.name}.mp4`));
  const rv = rfc.versions[0];
  check('the version records its source, its comp, a picture and how to compare', rv.source?.kind === 'workArea' && rv.source.start === 1 && rv.compName === 'Comp · 9:16' && !!rv.thumb && rv.compare?.showing === 'result' && rv.compare.original[0][1] === false);
  const rfJob = JSON.parse(readFileSync(join(s.mediaDir, rv.file.replace(/\.\w+$/, '.job.json')), 'utf8'));
  check('job.json names the tool, the source render and the graph that was submitted',
    rfJob.host?.tool?.id === 'reframe' && rfJob.host?.source?.kind === 'workArea' && rfJob.workflow?.submitted?.length === 1 && existsSync(join(s.mediaDir, rfJob.workflow.submitted[0])));
  check('a Comp tab run is not part of "Generate all"', !engine.pendingCards().some((c) => c.id === rfId));
  await engine.compare(rfId);
  check('compare: the generated layer hidden (the clip alone in the new frame)', JSON.stringify(host.visibility.at(-1)) === JSON.stringify([rv.compare!.result[0][0], false]) && engine.state().cards.find((c) => c.id === rfId)!.versions[0].compare?.showing === 'original');
  await engine.compare(rfId);
  check('compare again: the result back', JSON.stringify(host.visibility.at(-1)) === JSON.stringify([rv.compare!.result[0][0], true]));
  await host.openComp(1);
  await engine.sync();
  const again = await engine.runCompTool({ tool: 'reframe', source: 'workArea', options: { aspect: '9:16', quality: 'draft' }, cap: 8, prompt: 'a calm lake at dawn, mist' });
  await until(() => engine.state().cards.find((c) => c.id === rfId)?.versions.length === 2);
  check('the same reframe again is the same card\'s next version, "Comp · 9:16 v2"', again.id === rfId && host.outpaints.at(-1)?.name === 'Comp · 9:16 v2', `${again.id} ${rfId} ${host.outpaints.at(-1)?.name} ${engine.state().cards.find((c) => c.id === rfId)?.status} ${engine.state().cards.find((c) => c.id === rfId)?.error}`);
  const view = await engine.compView();
  check('the Comp tab view: comp, work area, the six tools then the LTX finishing family, this run', view.comp?.workAreaSet === true && JSON.stringify(view.comp?.workArea) === '[1,4]' && view.tools.map((t) => t.id).join() === 'reframe,upscale,matte,extend,slowmo,social,restore,deblur,decompress,colorize,cleanplate,daynight,sdr2hdr' && view.tools.filter((t) => t.family === 'ltx').length === 7 && view.runs.some((r) => r.id === rfId && r.versions.length === 2));

  // Upscale from the selected layer (the clip, 1344×768): a new comp at 2688×1536, the original kept, switched off.
  await host.openComp(1);
  host.selected = [901];
  await engine.sync();
  const { id: upId } = await engine.runCompTool({ tool: 'upscale', source: 'layer', options: { scale: 2 }, cap: 8 });
  await until(() => ['done', 'error'].includes(engine.state().cards.find((c) => c.id === upId)?.status ?? ''));
  const upc = engine.state().cards.find((c) => c.id === upId)!;
  const upComp = host.comps.at(-1)!;
  check('an upscale from a layer finishes', upc.status === 'done', upc.error);
  check('its comp: the upscaled clip on top, the original under it at 200%, switched off', upComp.layers.length === 2 && upComp.layers[1].itemId === 900 && upComp.layers[1].visible === false && upComp.layers[1].scale === 200 && /×2/.test(upComp.name));
  const upSent = submits.at(-1)!.prompt as never;
  check('SeedVR2 got ×2 and the clip\'s own file', getRef(upSent, '66:57.resize_type.multiplier') === 2);
  check('…and writes 8-bit video (EffectCraft decodes 8-bit H.264 only), not the source\'s bit depth', getRef(upSent, '66:75.bit_depth') === 8);
  const before4 = submits.length;
  const uploads4 = uploads;
  const { id: up4Id } = await engine.runCompTool({ tool: 'upscale', source: 'workArea', options: { scale: 4 }, cap: 8 });
  await until(() => ['done', 'error'].includes(engine.state().cards.find((c) => c.id === up4Id)?.status ?? ''));
  const up4c = engine.state().cards.find((c) => c.id === up4Id)!;
  check('×4 runs twice, the second pass fed with the first\'s result (two uploads: the render, then pass 1)', up4c.status === 'done' && submits.length === before4 + 2 && uploads === uploads4 + 2, up4c.error);
  check('×4 of the 1280×720 work area: a 5120×2880 comp', host.comps.at(-1)?.width === 5120 && host.comps.at(-1)?.height === 2880);
  const up4Job = JSON.parse(readFileSync(join(s.mediaDir, up4c.versions[0].file.replace(/\.\w+$/, '.job.json')), 'utf8'));
  check('the run history knows the two passes apart (for the estimate)', services.runs.of('seedvr2-upscale:pass2', 'local').length >= 1 && up4Job.workflow.submitted.length === 2);

  // Cut-out from the comp: a new comp, the render with its matte as luma track matte.
  await host.openComp(1);
  await engine.sync();
  const { id: mId } = await engine.runCompTool({ tool: 'matte', source: 'comp', cap: 8, prompt: 'boat' });
  await until(() => ['done', 'error'].includes(engine.state().cards.find((c) => c.id === mId)?.status ?? ''));
  const mc = engine.state().cards.find((c) => c.id === mId)!;
  const mComp = host.comps.at(-1)!;
  check('a cut-out of the whole comp finishes in a new comp "Comp · cut-out"', mc.status === 'done' && mComp.name === 'Comp · cut-out', mc.error);
  check('the whole comp, capped: 0–12 s rendered as 8 s', host.renders.at(-1)?.start === 0 && host.renders.at(-1)?.duration === 12 && host.renders.at(-1)?.cap === 8);
  const mv = mc.versions[0];
  check('the render takes its matte as a luma track matte', JSON.stringify(host.mattes.at(-1)) === JSON.stringify([mv.compare!.matte!.layer, mv.compare!.matte!.matte, 'luma']));
  await engine.compare(mId);
  check('compare takes the track matte off (nothing deleted)', JSON.stringify(host.mattes.at(-1)) === JSON.stringify([mv.compare!.matte!.layer, -1, 'none']));
  await engine.compare(mId);
  let refusedExport = false;
  try { await engine.exportAlpha(rfId); } catch { refusedExport = true; }
  check('only a cut-out exports with alpha', refusedExport);

  // A cut-out from a layer goes above it, as its track matte.
  await host.openComp(1);
  host.selected = [901];
  await engine.sync();
  const { id: lmId } = await engine.runCompTool({ tool: 'matte', source: 'layer', cap: 8, prompt: 'woman' });
  await until(() => ['done', 'error'].includes(engine.state().cards.find((c) => c.id === lmId)?.status ?? ''));
  const lmc = engine.state().cards.find((c) => c.id === lmId)!;
  check('a cut-out from a layer: its matte above it, as its luma track matte', lmc.status === 'done' && JSON.stringify(host.mattes.at(-1)) === JSON.stringify([901, lmc.placed?.layerId, 'luma']), lmc.error);
  check('…and its version keeps the clip\'s file for the alpha master', lmc.versions[0].source?.file === clipPath && lmc.versions[0].compId === undefined && lmc.versions[0].compare?.compId === 1, JSON.stringify(lmc.versions[0]?.source) + ' ' + lmc.versions[0]?.compId + ' ' + lmc.versions[0]?.compare?.compId);

  // The alpha master, through the same ffmpeg route as the Flow window's (when ffmpeg is on the PATH).
  const { spawnSync } = await import('node:child_process');
  const ff = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  if (ff.status === 0) {
    const dir = join(s.mediaDir, mId);
    const clip = join(dir, 'tiny_clip.mp4');
    const matte = join(dir, 'tiny_matte.mp4');
    spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=64x36:rate=24', '-t', '0.5', '-pix_fmt', 'yuv420p', clip]);
    spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=black:size=64x36:rate=24', '-t', '0.5', '-vf', 'drawbox=x=16:y=8:w=32:h=20:color=white:t=fill', '-pix_fmt', 'yuv420p', matte]);
    const card = engine.state().cards.find((c) => c.id === mId)!;
    const v = card.versions[0];
    const keep = { file: v.file, source: v.source };
    // Point the version at the tiny files (the fake ComfyUI's outputs are not video).
    const real = (engine as unknown as { card(id: string): { versions: Array<{ file: string; source?: { file: string | null } }> } }).card(mId);
    real.versions[0].file = `${mId}/tiny_matte.mp4`;
    real.versions[0].source!.file = `${mId}/tiny_clip.mp4`;
    const out = await engine.exportAlpha(mId);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,profile,pix_fmt', '-of', 'compact', out.path], { encoding: 'utf8' }).stdout;
    const raw = spawnSync('ffmpeg', ['-v', 'error', '-i', out.path, '-frames:v', '1', '-pix_fmt', 'rgba', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 20 }).stdout as Buffer;
    let lo = 255, hi = 0;
    for (let i = 3; i < raw.length; i += 4) { lo = Math.min(lo, raw[i]); hi = Math.max(hi, raw[i]); }
    check('the alpha master is ProRes 4444 with an alpha channel', /prores/.test(probe) && /4444/.test(probe) && /yuva/.test(probe), probe.trim());
    check('its alpha is the matte, full range: black 0, white 254–255', lo === 0 && hi >= 254, `${lo}–${hi}`);
    check('the export is remembered with the version', engine.state().cards.find((c) => c.id === mId)!.versions[0].exports?.[0]?.path === out.path);
    real.versions[0].file = keep.file;
    real.versions[0].source!.file = keep.source!.file;
  } else {
    console.log('  · ffmpeg is not on the PATH: the alpha master is not checked here');
  }

  /* ── Phase 3: the pinned layer source, Upscale colours, Extend, Slow motion / fps, Social pack ── */
  console.log('comp tab, phase 3');
  // The layer source stays the one picked: EffectCraft selects every result it places.
  await host.openComp(1);
  host.selected = [901];
  await engine.sync();
  const pickedView = await engine.compView(901);
  host.selected = [];
  host.layers.push({ id: 950, index: host.layers.length + 1, name: 'a result', in: 0, out: 4, start: 0, label: 'Green', type: 'Footage', item: 900, visible: true });
  host.selected = [950];
  await engine.sync();
  const later = await engine.compView(901);
  const pinnedPlan = await engine.planComp({ tool: 'upscale', source: 'layer', layerId: 901, options: { scale: 2 }, cap: 8 });
  check('the picked layer stays the source when EffectCraft selects another layer (offered, not taken)',
    pickedView.picked?.layerId === 901 && later.picked?.layerId === 901 && later.selected?.layerId === 950 && pinnedPlan.source.name === 'clip.mov' && JSON.stringify(pinnedPlan.source.span) === '[1.5,5]');
  let gone = false;
  try { await engine.planComp({ tool: 'upscale', source: 'layer', layerId: 777, options: {}, cap: 8 }); } catch (e) { gone = /no longer in this comp/.test(String(e)); }
  check('a picked layer that is gone is said, never swapped for the selection', gone);
  host.layers = host.layers.filter((l) => l.id !== 950);
  host.selected = [];
  await engine.sync();

  // Upscale: "Keep original colours" is SeedVR2's own colour correction; the template's "none" is the model's colours.
  const keep = toolById('upscale')!.plan(compSrc, { scale: 2 }, man);
  const model = toolById('upscale')!.plan(compSrc, { scale: 2, colour: 'model' }, man);
  const seedM = library.get('seedvr2-upscale')!.manifest;
  check('the colour choices are SeedVR2PostProcessing\'s own, read from object_info when the manifest was built', JSON.stringify(seedM.params?.find((p) => p.label === 'Colour')?.options) === '["lab","wavelet","adain","none"]');
  check('Upscale keeps the original colours by default (wavelet, measured closest); "model colours" is the template\'s none',
    keep.params['66:59.color_correction_method'] === KEEP_COLOUR_DEFAULT && KEEP_COLOUR_DEFAULT === 'wavelet' && model.params['66:59.color_correction_method'] === 'none' && !keep.choices?.method.includes('none'));

  // Extend.
  check('LTX extend frames from one frame: 8k + 1, one more than shown (24 fps 2 s → 49, 25 fps → 57, 30 fps → 65, 5 s → 121)',
    ltxExtendFrames(2, 24) === 49 && ltxExtendFrames(2, 25) === 57 && ltxExtendFrames(2, 30) === 65 && ltxExtendFrames(5, 24) === 121);
  check('LTX extend frames with a video guide: the guide (8n + 1) then a multiple of 8 (17 + 48 = 65, 17 + 56 = 73, 17 + 64 = 81, 17 + 120 = 137, 9 + 48 = 57)',
    ltxGuidedFrames(2, 24, 17) === 65 && ltxGuidedFrames(2, 25, 17) === 73 && ltxGuidedFrames(2, 30, 17) === 81 && ltxGuidedFrames(5, 24, 17) === 137 && ltxGuidedFrames(2, 24, 9) === 57
    && [65, 73, 81, 137, 57].every((n) => (n - 1) % 8 === 0));
  check('the guide is the longest 8n + 1 the source has: 17, else 9, else none', extendGuide(400, [17, 9]) === 17 && extendGuide(16, [17, 9]) === 9 && extendGuide(8, [17, 9]) === undefined);
  const extM = library.get('ltx25-extend')!.manifest;
  const extG = library.graph('ltx25-extend')!;
  check('the Extend workflow comes from the official LTX-2.5 FLF2V template: LTXVAddGuide at frame 0, strength 1, LTXVCropGuides before the decode, no last-frame guide',
    extM.source.template === 'video_ltx2_5_flf2v' && extM.task === 'extend-video' && JSON.stringify(extM.guide?.frames) === '[17,9]'
    && Object.values(extG).filter((n) => n.class_type === 'LTXVAddGuide').length === 1 && extG['251:206'].inputs.frame_idx === 0 && extG['251:206'].inputs.strength === 1
    && JSON.stringify(extG['251:219'].inputs.samples) === '["251:200",2]' && extG['251:200'].class_type === 'LTXVCropGuides' && extG['251:213'].inputs['resize_type.crop'] === 'disabled'
    && !extG['39'] && extG['300'].class_type === 'LoadVideo' && extG['302'].class_type === 'ImageFromBatch');
  const extPlan = toolById('extend')!.plan({ ...compSrc, kind: 'comp', span: [0, 12], compSeconds: 12, compFps: 24 }, { seconds: 2 }, man);
  check('the Extend plan from footage: the video-guided workflow, "continues the last 0.7 s of motion", 65 frames, a layer at the out point, the comp lengthened',
    extPlan.ok && extPlan.workflowId === 'ltx25-extend' && extPlan.motion?.frames === 17 && Math.abs(extPlan.motion.seconds - 17 / 24) < 1e-9
    && /continues the last 0\.7 s of motion/.test(extPlan.makes) && /new layer at 12\.0 s/.test(extPlan.makes) && extPlan.notes.some((n) => /65 frames/.test(n))
    && extPlan.notes.some((n) => /12\.0 s → 14\.0 s/.test(n)) && extPlan.output?.height === 736 && extPlan.params['@guide'] === 17 && extPlan.variant === '+2·g17');
  const stillPlan = toolById('extend')!.plan({ ...compSrc, kind: 'layer', media: 'image', span: [0, 4], compSeconds: 12, compFps: 24 }, { seconds: 2 }, man);
  check('from a still: the single-frame path (LTX-2.5 i2v), said on the card', stillPlan.ok && stillPlan.workflowId === 'ltx25-i2v' && !stillPlan.motion && stillPlan.notes.some((n) => /A still/.test(n)) && stillPlan.variant === '+2');
  const shortPlan = toolById('extend')!.plan({ ...compSrc, kind: 'layer', span: [0, 0.3], compSeconds: 12, compFps: 24 }, { seconds: 2 }, man);
  check('from a source shorter than 9 frames: the single frame too, and why', shortPlan.ok && shortPlan.workflowId === 'ltx25-i2v' && shortPlan.notes.some((n) => /fewer than the 9/.test(n)));
  const ffOk = (await import('node:child_process')).spawnSync('ffmpeg', ['-version']).status === 0;
  host.workArea = [1, 4];
  await engine.sync();
  const extWa = await engine.planComp({ tool: 'extend', source: 'workArea', options: { seconds: 2 }, cap: 1 });
  check('Extend renders nothing: the render cap is not warned about', extWa.ok && !extWa.warnings.some((w) => /render stops/.test(w)));
  if (ffOk) {
    host.realFrames = true;
    const beforeFrames = host.frames.length;
    const { id: exId } = await engine.runCompTool({ tool: 'extend', source: 'workArea', options: { seconds: 2 }, cap: 8, prompt: 'the boat sails on' });
    await until(() => ['done', 'error'].includes(engine.state().cards.find((c) => c.id === exId)?.status ?? ''));
    const exc = engine.state().cards.find((c) => c.id === exId)!;
    const exSent = submits.at(-1)!.prompt as never;
    const exLayer = host.layers.find((l) => l.id === exc.placed?.layerId);
    const lengthExpr = Object.values(exSent as Record<string, { class_type: string; inputs: Record<string, unknown> }>).find((n) => n.class_type === 'ComfyMathExpression' && Array.isArray(n.inputs['values.a']) && (n.inputs['values.a'] as unknown[])[0] === '251:198');
    // The 17 frames of the guide (the result's picture is taken after them).
    const taken = host.frames.slice(beforeFrames, beforeFrames + 17);
    check('a guided Extend run finishes', exc.status === 'done' && exc.versions.length === 1 && exc.workflowId === 'ltx25-extend', exc.error);
    check('…from the work area\'s last 17 frames (frames 79–95 of the comp, each a tenth of a frame in), nothing rendered',
      taken.length === 17 && Math.abs(taken[0].time - 79.1 / 24) < 1e-9 && Math.abs(taken[16].time - 95.1 / 24) < 1e-9 && host.renders.every((r) => !r.dir.endsWith(exId)), taken.map((f) => f.time.toFixed(3)).join(' '));
    check('…LTX-2.5 asked for 65 frames at 24 fps, 1280×736, the last 17 frames of the uploaded clip as the guide',
      lengthExpr?.inputs.expression === '65' && getRef(exSent, extM.bindings.fps) === 24 && getRef(exSent, extM.bindings.width) === 1280 && getRef(exSent, extM.bindings.height) === 736
      && getRef(exSent, extM.guide!.start) === -17 && getRef(exSent, extM.guide!.take) === 17 && getRef(exSent, extM.bindings.video) === 'uploaded.png');
    check('…a new layer from the out point, the 17 guide frames trimmed off, 2 s long',
      !!exLayer && exLayer.in === 4 && exLayer.out === 6 && Math.abs(exLayer.start - (4 - 17 / 24)) < 1e-9 && exc.versions[0].compare?.result[0][0] === exLayer.id);
    host.realFrames = false;
  } else {
    console.log('  · ffmpeg is not on the PATH: the guided Extend run is not checked here');
  }
  // The single-frame path still runs end to end (a layer that is a still).
  host.workArea = undefined;
  const stillItem = host.nextId++;
  host.items.set(stillItem, { path: join(projectDir, 'still.png'), width: 1280, height: 720 });
  (await import('node:fs')).writeFileSync(join(projectDir, 'still.png'), 'png');
  host.layers.push({ id: 960, index: host.layers.length + 1, name: 'still.png', in: 0, out: 3, start: 0, label: 'None', type: 'Footage', item: stillItem, visible: true });
  host.kinds.set(stillItem, 'still');
  host.selected = [960];
  await engine.sync();
  const { id: exS } = await engine.runCompTool({ tool: 'extend', source: 'layer', layerId: 960, options: { seconds: 2 }, cap: 8, prompt: 'the boat sails on' });
  await until(() => ['done', 'error'].includes(engine.state().cards.find((c) => c.id === exS)?.status ?? ''));
  const exsc = engine.state().cards.find((c) => c.id === exS)!;
  const exsSent = submits.at(-1)!.prompt as never;
  const ltxM = library.get('ltx25-i2v')!.manifest;
  const exsLayer = host.layers.find((l) => l.id === exsc.placed?.layerId);
  check('Extend from a still runs the single-frame path: LTX-2.5 i2v, 49 frames, the still uploaded, the repeat trimmed',
    exsc.status === 'done' && exsc.workflowId === 'ltx25-i2v' && getRef(exsSent, ltxM.bindings.image) === 'uploaded.png' && !!exsLayer && exsLayer.in === 3 && Math.abs(exsLayer.start - (3 - 1 / 24)) < 1e-9, exsc.error);
  host.layers = host.layers.filter((l) => l.id !== 960 && l.id !== exsc.placed?.layerId);
  host.selected = [];
  await engine.sync();
  const { id: ex2 } = await engine.runCompTool({ tool: 'extend', source: 'comp', options: { seconds: 4 }, cap: 8, prompt: 'the boat sails on' });
  if (ffOk) {
    host.realFrames = true;
    await until(() => ['done', 'error'].includes(engine.state().cards.find((c) => c.id === ex2)?.status ?? ''));
    host.realFrames = false;
    check('Extend from the whole comp lengthens it: 12 s → 16 s, the layer at 12 s', host.duration === 16 && host.layers.some((l) => l.id === engine.state().cards.find((c) => c.id === ex2)?.placed?.layerId && l.in === 12 && l.out === 16));
  } else {
    await until(() => ['done', 'error'].includes(engine.state().cards.find((c) => c.id === ex2)?.status ?? ''));
    check('without ffmpeg, a guided Extend says what it needs', /ffmpeg/.test(engine.state().cards.find((c) => c.id === ex2)?.error ?? ''));
  }
  host.duration = 12;
  await engine.sync();

  // Describe the clip: Qwen3-VL on the local ComfyUI (the official template llm_qwen3vl_text_gen), into the prompt.
  const dM = library.get('describe-clip')!.manifest;
  check('the describe workflow: the official Qwen3-VL text template, several frames in, Apache-2.0, not offered to the panel',
    dM.source.template === 'llm_qwen3vl_text_gen' && dM.output === 'text' && dM.text?.node === '7' && /Apache-2\.0/.test(dM.license.weights)
    && library.graph('describe-clip')!['6'].inputs.image?.toString() === '10,0' && !engine.state().workflows.some((w) => w.id === 'describe-clip'));
  const dv = await engine.compView();
  check('the Comp tab offers Describe the clip when the local ComfyUI has the node and the model', dv.describe.available && dv.describe.model === 'qwen3vl_4b_fp8_scaled.safetensors', JSON.stringify(dv.describe));
  if (ffOk) {
    host.realFrames = true;
    const d = await engine.describeClip({ source: 'comp', focus: 'end' });
    host.realFrames = false;
    const dSent = submits.at(-1)!.prompt as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
    check('…it reads four frames of the last 3 s and returns the text, cleaned', d.text === 'A small sailboat glides to the right on a calm lake at dawn.' && d.frames === 4 && Math.abs(d.times[3] - (12 - 1 / 24)) < 1e-9 && /last seconds/.test(String(dSent['6'].inputs.prompt)), JSON.stringify(d));
  }

  // Slow motion / fps.
  const sp = toolById('slowmo')!.plan({ ...compSrc, seconds: 2 }, { mode: 'slow2', engine: 'rife' }, man);
  check('slow ×2 plan: 48 frames → 95 ((n − 1) × 2 + 1), same rate, about twice as long, no sound',
    sp.ok && sp.workflowId === 'interp-rife' && /95 frames/.test(sp.makes) && sp.output?.fps === 24 && Math.abs(sp.output.seconds - 95 / 24) < 1e-9 && sp.params['@audio'] === false && sp.params['16:9.value'] === 2 && sp.params['16:13.value'] === false);
  const fp2 = toolById('slowmo')!.plan({ ...compSrc, fps: 25, seconds: 2 }, { mode: 'fps2', engine: 'film' }, man);
  check('25 → 50 fps plan: the same length, sound kept, FILM is the template as it ships', fp2.ok && fp2.output?.fps === 50 && fp2.workflowId === 'interp-film' && fp2.params['16:13.value'] === true && fp2.params['@audio'] === true);
  check('GIMM-VFI is not offered (S-Lab 1.0, non-commercial): asked for, the card falls back to RIFE', toolById('slowmo')!.plan(compSrc, { engine: 'gimm' }, man).workflowId === 'interp-rife' && !library.get('interp-gimm'));
  check('the interpolation manifests: the official template, RIFE in place of its interpolator, FILM as it ships',
    ['interp-rife', 'interp-film'].every((id) => library.get(id)?.manifest.source.template === 'utility_video_frame_interpolation')
    && library.graph('interp-rife')!['16:2'].class_type === 'RIFE VFI' && library.graph('interp-film')!['16:2'].class_type === 'FrameInterpolate');
  const { id: smId } = await engine.runCompTool({ tool: 'slowmo', source: 'comp', options: { mode: 'slow2', engine: 'rife' }, cap: 8 });
  await until(() => ['done', 'error'].includes(engine.state().cards.find((c) => c.id === smId)?.status ?? ''));
  const smc = engine.state().cards.find((c) => c.id === smId)!;
  const smSent = submits.at(-1)!.prompt as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
  check('slow ×2 runs: RIFE ×2, the frame rate not multiplied, the sound left out', smc.status === 'done' && smSent['16:9'].inputs.value === 2 && smSent['16:13'].inputs.value === false && !('audio' in smSent['16:5'].inputs), smc.error);
  check('…into a new comp "Comp · ×2 slow" at 24 fps, the original under it switched off', host.comps.at(-1)?.name === 'Comp · ×2 slow' && host.comps.at(-1)?.fps === 24 && host.comps.at(-1)?.layers[1].visible === false);
  const { id: fpsId } = await engine.runCompTool({ tool: 'slowmo', source: 'comp', options: { mode: 'fps2', engine: 'rife' }, cap: 8 });
  await until(() => ['done', 'error'].includes(engine.state().cards.find((c) => c.id === fpsId)?.status ?? ''));
  const fpsSent = submits.at(-1)!.prompt as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
  check('24 → 48 fps: a comp "Comp · 48 fps" at 48 fps, the sound kept', host.comps.at(-1)?.name === 'Comp · 48 fps' && host.comps.at(-1)?.fps === 48 && fpsSent['16:13'].inputs.value === true && 'audio' in fpsSent['16:5'].inputs);

  // A queued run does not take the user's comp away (decided 25 Oct): two runs queued from comp 1; the first one's
  // result opens (the user was on comp 1), the second one's does not — its comp is offered in Results.
  await host.openComp(1);
  await engine.sync();
  const sideCards = (): import('../core/storyboard/types.ts').Card[] => (engine as unknown as { sidecar: { cards: import('../core/storyboard/types.ts').Card[] } }).sidecar.cards;
  const { id: q1 } = await engine.runCompTool({ tool: 'slowmo', source: 'comp', options: { mode: 'slow4', engine: 'rife' }, cap: 8 });
  const { id: q2 } = await engine.runCompTool({ tool: 'slowmo', source: 'comp', options: { mode: 'fps2', engine: 'film' }, cap: 8 });
  await until(() => [q1, q2].every((id) => ['done', 'error'].includes(sideCards().find((c) => c.id === id)?.status ?? '')), 30000);
  const r1 = sideCards().find((c) => c.id === q1)!.versions.at(-1)?.compId;
  const r2 = sideCards().find((c) => c.id === q2)!.versions.at(-1)?.compId;
  check('a queued run leaves the comp the user is on in front, and says where its result is',
    r1 !== undefined && r2 !== undefined && r1 !== r2 && host.compId === r1 && /ready — Open comp in Results/.test(engine.state().notice ?? ''), `front ${host.compId}, r1 ${r1}, r2 ${r2}, ${engine.state().notice}`);
  // The user goes to another comp while a run works (the run did not open it): that comp stays in front at the end.
  await host.openComp(1);
  await engine.sync();
  const { id: q3 } = await engine.runCompTool({ tool: 'slowmo', source: 'comp', options: { mode: 'slow2', engine: 'film' }, cap: 8 });
  await until(() => /Queued|Starting|Working|Saving|Sampling/.test(sideCards().find((c) => c.id === q3)?.progress?.phase ?? ''), 10000);
  await host.openComp(55);
  await engine.sync();
  await until(() => ['done', 'error'].includes(sideCards().find((c) => c.id === q3)?.status ?? ''), 30000);
  check('a comp the user opens during a run stays in front when it ends', host.compId === 55 && sideCards().find((c) => c.id === q3)?.status === 'done', `front ${host.compId}`);
  await host.openComp(1);
  await engine.sync();

  // Social pack: the reframes in series, each one's upscale queued after it, one group.
  const pack = toolById('social')!.plan(compSrc, { formats: '9:16,1:1,16:9', quality: 'draft', upscale: true }, man);
  check('a pack plan leaves out the format the source already has, and lists reframe + upscale per format',
    pack.ok && pack.members?.map((x) => `${x.tool}:${x.options.aspect ?? ''}`).join() === 'reframe:9:16,upscale:,reframe:1:1,upscale:' && pack.notes.some((n) => /16:9/.test(n)) && pack.jobs.length === 4);
  const sub0 = submits.length;
  const { id: gId, queued } = await engine.runCompTool({ tool: 'social', source: 'comp', options: { formats: '9:16,1:1', quality: 'draft', upscale: true, masters: 'none' }, cap: 8, prompt: 'a calm lake at dawn' });
  // The upscales work on the result comps, so the sidecar (not the open comp's view) says when the pack is done.
  const allCards = (): import('../core/storyboard/types.ts').Card[] => (engine as unknown as { sidecar: { cards: import('../core/storyboard/types.ts').Card[] } }).sidecar.cards;
  await until(() => {
    const g = allCards().filter((c) => c.tool?.group?.id === gId);
    return g.length === 4 && g.every((c) => c.status === 'done' || c.status === 'error');
  }, 60000);
  const members = allCards().filter((c) => c.tool?.group?.id === gId);
  const reframes = members.filter((c) => c.tool?.id === 'reframe');
  const ups = members.filter((c) => c.tool?.id === 'upscale');
  check('a Social pack queues one reframe per format (2), one after the other', queued === 2 && reframes.length === 2 && reframes.every((c) => c.status === 'done'), members.map((c) => `${c.tool?.id} ${c.status} ${c.error ?? ''}`).join('; '));
  check('…and each reframe\'s result comp is upscaled ×2 after it, in the same group', ups.length === 2 && ups.every((u) => u.status === 'done' && reframes.some((r) => r.versions.at(-1)?.compId === u.compId))
    && submits.slice(sub0).filter((x) => Object.values(x.prompt).some((n) => (n as unknown as { class_type: string }).class_type === 'SeedVR2PostProcessing')).length === 2,
    `${ups.map((u) => `${u.status} ${u.compId} ${u.progress?.phase ?? ''} ${u.error ?? ''}`).join('; ')} | ${reframes.map((r) => r.versions.at(-1)?.compId).join(',')} | ${submits.length - sub0} ${submits.slice(sub0).map((x) => Object.values(x.prompt).map((n) => (n as unknown as { class_type: string }).class_type).filter((c) => /Vace|SeedVR2Post|LoadVideo/.test(c)).join('+')).join(' / ')}`);
  const gv = await engine.compView();
  check('the Comp tab shows the pack\'s four runs together (the upscales belong to other comps)', gv.runs.filter((r) => r.group?.id === gId).length === 4);
  // A pack's master: EffectCraft renders the last comp, ffmpeg writes ProRes 4444 (only with ffmpeg on the PATH).
  const { spawnSync: run } = await import('node:child_process');
  if (run('ffmpeg', ['-version']).status === 0) {
    host.realRender = true;
    const { id: g2 } = await engine.runCompTool({ tool: 'social', source: 'comp', options: { formats: '9:16', quality: 'draft', upscale: false, masters: 'prores4444' }, cap: 8, prompt: 'a calm lake at dawn' });
    await until(() => engine.state().cards.some((c) => c.tool?.group?.id === g2 && (c.status === 'done' || c.status === 'error') && (c.versions.at(-1)?.exports?.length || c.error)), 15000);
    const mc2 = engine.state().cards.find((c) => c.tool?.group?.id === g2)!;
    const ex = mc2.versions.at(-1)?.exports?.at(-1);
    const probe = ex ? run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,profile', '-of', 'compact', ex.path], { encoding: 'utf8' }).stdout : '';
    check('a pack with masters: the last comp rendered and written as ProRes 4444', !!ex && ex.kind === 'prores4444' && /prores/.test(probe) && /4444/.test(probe), mc2.error ?? probe);
    host.realRender = false;
  } else {
    console.log('  · ffmpeg is not on the PATH: the pack master is not checked here');
  }
  host.workArea = [1, 4];
  await host.openComp(1);
  await engine.sync();

  // Relinking after a save: a reframe version must not take over the item a matte was placed on.
  host.relinks.length = 0;
  (engine as unknown as { relinkMoved(media: string): void }).relinkMoved(s.mediaDir);
  await until(() => host.relinks.length > 0, 2000);
  await sleep(200);
  const clipCardNow = (engine as unknown as { card(id: string): import('../core/storyboard/types.ts').Card }).card(clipCard);
  const placedRelink = host.relinks.find(([item]) => item === clipCardNow.placed?.itemId);
  check('relinking keeps a matte\'s item on the matte, even when a reframe version is the active one',
    clipCardNow.versions.at(-1)?.compId !== undefined && !!placedRelink && placedRelink[1].endsWith(clipCardNow.versions[0].file.split('/')[1]));
  check('…and relinks the items a version imported (a generated fill, a render)', host.relinks.some(([item]) => item === rfc.versions[0].itemId) && host.relinks.some(([item]) => item === rfc.versions[0].source?.itemId));
  await host.openComp(1);
  await engine.sync();
}

console.log('ltx finishing');
{
  // The planner, ported from Flow 2: the official grid, frames, the 8K ladder.
  check('Tiled Fusion grid = ComfyUI-LTXVideo\'s planner: Full HD 9, 4K 49, 8K 210 tiles of 1024×576',
    tileGrid(1920, 1088, 1024, 576).count === 9 && tileGrid(3840, 2176, 1024, 576).count === 49 && tileGrid(7680, 4352, 1024, 576).count === 210);
  const fhd = planFinish({ width: 1280, height: 704, pixelAspect: 1, frames: 121, fps: 24 }, { ...FINISH_DEFAULTS, preset: 'refine-fhd', preview: false });
  check('Refine Full HD of a 5 s 1280×704 clip: 1920×1056, 3×3 tiles, 121 → 129 frames in 2 windows of 97, 144 tile-steps',
    fhd.delivery.w === 1920 && fhd.delivery.h === 1056 && fhd.passes[0].grid.count === 9 && fhd.frames.total === 129 && fhd.frames.pad === 8 && fhd.frames.windows === 2 && fhd.load === 144);
  const r8 = planFinish({ width: 1920, height: 1080, pixelAspect: 1, frames: 48, fps: 24 }, { ...FINISH_DEFAULTS, preset: 'refine-8k', preview: false });
  check('8K goes through 4K: Refine 3840×2176, then a 2-step pass at 7680×4352 from the image', r8.passes.length === 2 && r8.passes[0].canvas.w === 3840 && r8.passes[1].canvas.w === 7680 && r8.passes[1].fromImage && r8.passes[1].steps === 2);
  const dup = planFinish({ width: 1280, height: 704, pixelAspect: 1, frames: 121, fps: 24 }, { ...FINISH_DEFAULTS, preset: 'refine-fhd', preview: false, duplicate: 2 });
  check('Fast scene ×2: 121 → 242 → 257 frames (8n+1, 15 copies of the last frame), conditioning at 48 fps', dup.frames.content === 242 && dup.frames.total === 257 && dup.frames.pad === 15 && dup.conditioningFps === 48);
  check('the Look check: subjects flagged, rendering words pass', lintPrompt('crisp detail, a sailboat on the lake', 'refine').length === 2 && lintPrompt(FINISH_PROMPTS.positive, 'refine').length === 0);

  // The cards' plans.
  const man = (id: string) => library.get(id)?.manifest;
  const clip5 = { kind: 'layer' as const, media: 'video' as const, width: 1280, height: 704, fps: 24, seconds: 121 / 24, requested: 121 / 24, name: 'Sailboat' };
  const lp = toolById('upscale')!.plan(clip5, { engine: 'ltx', size: 'fhd' }, man, { prompt: 'crisp detail, the boat' });
  check('Upscale ▸ LTX Refine: Full HD 1920×1056, an optional "Look", the time from the tile count, measured on an RTX 5080',
    lp.ok && lp.workflowId === 'ltx25-refine' && lp.output?.width === 1920 && lp.output.height === 1056 && lp.prompt?.label === 'Look' && !!lp.prompt.optional
    && lp.prompt.placeholder === 'sharpness, grain, light — not the subjects' && /measured on an RTX 5080/.test(lp.estimate?.line ?? '') && (lp.estimate?.seconds ?? 0) > 0, JSON.stringify([lp.reason, lp.output, lp.estimate]));
  check('…a subject in the Look is warned about, with what the check is', lp.warnings.some((w) => /"boat"/.test(w) && /simple check/.test(w)));
  check('…the master is a PNG 16-bit sequence, the comp an MP4 preview', lp.notes.some((n) => /PNG 16-bit sequence/.test(n) && /MP4 preview/.test(n)));
  const l8 = toolById('upscale')!.plan(clip5, { engine: 'ltx', size: '8k' }, man);
  check('…8K says it goes through 4K', l8.ok && l8.output?.width === 7680 && l8.notes.some((n) => /8K always goes through 4K/.test(n)));
  check('…the LTX variants are cards of their own', lp.variant === 'ltx:fhd' && l8.variant === 'ltx:8k' && toolById('upscale')!.plan(clip5, { engine: 'ltx', size: 'fhd', fast: 2, preview: true }, man).variant === 'ltx:fhd·f2·tile');
  check('…and SeedVR2 stays the default engine', toolById('upscale')!.defaults.engine === 'seedvr2' && toolById('upscale')!.plan(clip5, { scale: 2 }, man).workflowId === 'seedvr2-upscale');
  const arch = { ...clip5, width: 640, height: 480, seconds: 2, requested: 2 };
  const rr = toolById('restore')!.plan(arch, { mode: 'restore-refine' }, man);
  check('Archive restore + Refine 30 %: one pass at 1440×1088 (4:3), Refine 0.3 as the second IC-LoRA', rr.ok && /Refine Details at 30 %/.test(rr.makes) && rr.notes.some((n) => /\+ Refine 30 %/.test(n) && /1440×1088/.test(n)), JSON.stringify([rr.reason, rr.makes, rr.notes[0]]));
  const ra = toolById('restore')!.plan(arch, { mode: 'archive' }, man);
  check('Archive order: Restore first, then Refine ×2 (2880×2160)', ra.ok && ra.output?.width === 2880 && ra.output.height === 2160 && ra.notes.some((n) => /Restore first, then Refine/.test(n)));
  check('Restore says Colorization is a tool of its own (not documented as combinable)', rr.notes.some((n) => /Colorization IC-LoRA is a separate tool/.test(n)));
  const db = toolById('deblur')!.plan(clip5, {}, man);
  check('Deblur: one pass at the source size, the card\'s sentence, a scene to write', db.ok && db.prompt?.label === 'Scene' && !db.prompt.optional && db.output?.width === 1280 && db.notes.some((n) => /sentence the card trained on/.test(n)));
  const cz = toolById('colorize')!.plan(clip5, {}, man);
  check('Colorize: near the 960×544 training size, with a "Colours" field', cz.ok && cz.fields?.[0].key === 'colours' && cz.notes.some((n) => /992×544/.test(n)), JSON.stringify(cz.notes));
  const sh = toolById('sdr2hdr')!;
  check('SDR → HDR is listed, not runnable: to be verified, with why', !!sh.unavailable && /models\/embeddings/.test(sh.unavailable) && !sh.plan(clip5, {}, man).ok);
  const ap = toolById('matte')!.plan(clip5, { engine: 'ltx' }, man);
  check('Cut-out ▸ LTX Alpha: no prompt, a luma matte like SAM 3\'s, ≤ 145 frames', ap.ok && !ap.prompt && ap.workflowId === 'ltx25-alpha' && ap.notes.some((n) => /White = foreground/.test(n)));
  check('every LTX finishing card carries the LTX-2.x licence line and its link', COMP_TOOLS.filter((t) => t.family === 'ltx').every((t) => t.licence?.line === LTX_LICENCE_LINE && /LICENSE-2_x/.test(t.licence.url)));
  check('Settings ▸ Resources has an "LTX finishing" row, Local by default', TASKS.some((t) => t.id === 'finishing' && t.default === 'local') && library.get('ltx25-refine')!.manifest.task === 'finish-video');

  // The engine: LTX Refine from a layer, on the fake ComfyUI.
  await host.openComp(1);
  host.selected = [901];
  await engine.sync();
  const pl = await engine.planComp({ tool: 'upscale', source: 'layer', options: { engine: 'ltx', size: 'fhd' }, cap: 8, prompt: '' });
  check('the plan from the server: the local files found (NVFP4, the Refine IC-LoRA)', pl.ok && pl.notes.some((n) => /On the local ComfyUI: ltx-2\.5-22b-distilled-transformer-nvfp4/.test(n)), JSON.stringify([pl.reason, pl.notes.slice(-2)]));
  const before = submits.length;
  const { id: lId } = await engine.runCompTool({ tool: 'upscale', source: 'layer', options: { engine: 'ltx', size: 'fhd' }, cap: 8, prompt: '' });
  await until(() => ['done', 'error'].includes(engine.state().cards.find((c) => c.id === lId)?.status ?? ''));
  const lc = engine.state().cards.find((c) => c.id === lId)!;
  check('LTX Refine from a layer finishes, one job', lc.status === 'done' && submits.length === before + 1, lc.error);
  const g = submits.at(-1)!.prompt as unknown as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
  const byClass = (c: string) => Object.values(g).filter((n) => n.class_type === c);
  const tf = byClass('LTXVTiledFusionSampler')[0]?.inputs;
  check('its graph: the clip uploaded into LoadVideo, Tiled Fusion with 1024×576 tiles, overlap 0.5, blend 0.05, cfg 1, 97-frame windows',
    byClass('LoadVideo')[0]?.inputs.file === 'uploaded.png' && tf?.tile_width === 1024 && tf.tile_height === 576 && tf.overlap_frac === 0.5 && tf.blend_var === 0.05 && tf.cfg === 1 && tf.tile_frames === 97);
  check('…the 8 distilled sigmas, the Refine IC-LoRA at 1.0; on a 16 GB card the official workflows\' low-VRAM decode, 512/64/128/32',
    byClass('ManualSigmas')[0]?.inputs.sigmas === '1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0'
    && /refine-details/.test(String(byClass('LTXICLoRALoaderModelOnly')[0]?.inputs.lora_name)) && byClass('LTXICLoRALoaderModelOnly')[0]?.inputs.strength_model === 1
    && byClass('VAEDecodeTiled')[0]?.inputs.tile_size === 512 && byClass('VAEDecodeTiled')[0]?.inputs.overlap === 64 && byClass('VAEDecodeTiled')[0]?.inputs.temporal_size === 128);
  check('…the empty Look runs with the card\'s generic look', byClass('CLIPTextEncode').some((n) => n.inputs.text === FINISH_PROMPTS.positive));
  check('…16-bit PNG frames and an 8-bit MP4 with the clip\'s sound', byClass('SaveImageAdvanced')[0]?.inputs['format.bit_depth'] === '16-bit' && byClass('CreateVideo')[0]?.inputs.bit_depth === 8 && Array.isArray(byClass('CreateVideo')[0]?.inputs.audio));
  const lv = lc.versions[0];
  check('the master: every 16-bit frame next to the project, recorded with the version', lv?.exports?.[0]?.kind === 'png16' && existsSync(lv.exports[0].path) && /_png16[\\/]/.test(lv.exports[0].path));
  const lComp = host.comps.at(-1)!;
  check('a new comp at the delivery size (1344×768 → 1890×1080), the original under it at 140.625 %, switched off',
    lComp.width === 1890 && lComp.height === 1080 && lComp.layers[1].visible === false && Math.abs((lComp.layers[1].scale ?? 0) - 140.625) < 0.01 && /LTX Full HD/.test(lComp.name), JSON.stringify([lComp.width, lComp.height, lComp.layers[1], lComp.name]));
  // The run's own record sits under "host" in job.json, as every Comp tab tool's does.
  const lJob = JSON.parse(readFileSync(join(engine.state().mediaDir, lv.file.replace(/\.\w+$/, '.job.json')), 'utf8')).host;
  check('its job.json: the plan (tiles, frames), the estimate and its basis, the time it took, the VRAM seen, the licence',
    lJob.finishing?.plan?.passes?.[0]?.tiles === 9 && lJob.finishing.estimate.seconds > 0 && / in \d+(–\d+)? s/.test(lJob.finishing.estimate.basis) && typeof lJob.finishing.took.seconds === 'number'
    && 'minFreeGb' in lJob.finishing.vram && lJob.finishing.licence.startsWith(LTX_LICENCE_LINE), JSON.stringify(lJob.finishing ? { p: lJob.finishing.plan?.passes?.[0], e: lJob.finishing.estimate, t: lJob.finishing.took, v: lJob.finishing.vram, l: String(lJob.finishing.licence).slice(0, 40) } : Object.keys(lJob)));

  // A preview tile: one 1024×576 tile, the original placed so the tile lines up.
  const { id: tId } = await engine.runCompTool({ tool: 'upscale', source: 'layer', options: { engine: 'ltx', size: 'fhd', preview: true }, cap: 8, prompt: 'subtle film grain' });
  await until(() => ['done', 'error'].includes(engine.state().cards.find((c) => c.id === tId)?.status ?? ''));
  const tComp = host.comps.at(-1)!;
  const crop = (submits.at(-1)!.prompt as unknown as Record<string, { class_type: string; inputs: Record<string, number> }>);
  const ic = Object.values(crop).find((n) => n.class_type === 'ImageCrop')?.inputs;
  check('…a preview tile keeps the Refine card\'s decode, 1024/128/256 (it fits)', Object.values(crop).find((n) => n.class_type === 'VAEDecodeTiled')?.inputs.tile_size === 1024);
  check('a preview tile: a 1024×576 comp, the original scaled to the canvas and moved so the tile lines up',
    engine.state().cards.find((c) => c.id === tId)?.status === 'done' && tComp.width === 1024 && tComp.height === 576 && !!ic
    && JSON.stringify(tComp.layers[1].position) === JSON.stringify([1888 / 2 - ic.x, 1088 / 2 - ic.y]), JSON.stringify([tComp.width, tComp.layers[1], ic, engine.state().cards.find((c) => c.id === tId)?.error]));

  // Archive restore + Refine 30 %, and a single-pass tool, from the work area.
  const { id: rId } = await engine.runCompTool({ tool: 'restore', source: 'workArea', options: { mode: 'restore-refine' }, cap: 8, prompt: '' });
  await until(() => ['done', 'error'].includes(engine.state().cards.find((c) => c.id === rId)?.status ?? ''));
  const rg = submits.at(-1)!.prompt as unknown as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
  const loras = Object.values(rg).filter((n) => n.class_type === 'LTXICLoRALoaderModelOnly').map((n) => `${String(n.inputs.lora_name).split('/').pop()}@${n.inputs.strength_model}`);
  check('Restore + Refine: Restore at 1.0 and Refine at 0.3 in the same pass, on 960×544 tiles, the default Restore look',
    engine.state().cards.find((c) => c.id === rId)?.status === 'done' && loras.join() === 'ltx-2.5-22b-ic-lora-restore-1.0.safetensors@1,ltx-2.5-22b-ic-lora-refine-details-1.0.safetensors@0.3'
    && Object.values(rg).some((n) => n.class_type === 'LTXVTiledFusionSampler' && n.inputs.tile_width === 960 && n.inputs.tile_height === 544)
    && Object.values(rg).some((n) => n.class_type === 'CLIPTextEncode' && n.inputs.text === FINISH_PROMPTS.restorePositive), engine.state().cards.find((c) => c.id === rId)?.error ?? loras.join());
  check('…and the card says the negative does nothing at guidance 1.0, instead of a field that would do nothing', !toolById('restore')!.plan({ kind: 'layer', media: 'video', width: 640, height: 480, fps: 24, seconds: 2, requested: 2, name: 'x' }, {}, (id) => library.get(id)?.manifest).fields && toolById('restore')!.plan({ kind: 'layer', media: 'video', width: 640, height: 480, fps: 24, seconds: 2, requested: 2, name: 'x' }, {}, (id) => library.get(id)?.manifest).notes.some((n) => /does not evaluate a negative prompt/.test(n)));
  const { id: dId } = await engine.runCompTool({ tool: 'deblur', source: 'workArea', options: {}, cap: 8, prompt: 'a sailboat on a lake' });
  await until(() => ['done', 'error'].includes(engine.state().cards.find((c) => c.id === dId)?.status ?? ''));
  const dg = submits.at(-1)!.prompt as unknown as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
  check('Deblur: the official single-stage chain (CFGGuider 1, euler_ancestral, LTXVCropGuides), the card\'s DEBLUR sentence',
    engine.state().cards.find((c) => c.id === dId)?.status === 'done'
    && Object.values(dg).some((n) => n.class_type === 'CFGGuider' && n.inputs.cfg === 1) && Object.values(dg).some((n) => n.class_type === 'KSamplerSelect' && n.inputs.sampler_name === 'euler_ancestral')
    && Object.values(dg).some((n) => n.class_type === 'LTXVCropGuides') && Object.values(dg).some((n) => n.class_type === 'CLIPTextEncode' && /DEBLUR a sailboat on a lake\./.test(String(n.inputs.text))),
    engine.state().cards.find((c) => c.id === dId)?.error);

  // LTX Alpha from a layer: a matte above it, like SAM 3's, exportable with alpha.
  await host.openComp(1);
  host.selected = [901];
  await engine.sync();
  const { id: aId } = await engine.runCompTool({ tool: 'matte', source: 'layer', options: { engine: 'ltx' }, cap: 8 });
  await until(() => ['done', 'error'].includes(engine.state().cards.find((c) => c.id === aId)?.status ?? ''));
  const ac = engine.state().cards.find((c) => c.id === aId)!;
  const ag = submits.at(-1)!.prompt as unknown as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
  check('LTX Alpha: no prompt, no master, the matte above the clip as its luma track matte',
    ac.status === 'done' && JSON.stringify(host.mattes.at(-1)) === JSON.stringify([901, ac.placed?.layerId, 'luma'])
    && !Object.values(ag).some((n) => n.class_type === 'SaveImageAdvanced') && Object.values(ag).filter((n) => n.class_type === 'CLIPTextEncode').every((n) => n.inputs.text === ''), ac.error);
  check('…and can be exported with alpha, like a SAM 3 matte', engine.compView ? (await engine.compView(901)).runs.find((r) => r.id === aId)?.versions[0]?.canExport === true : false);

  // Where it may run: a deployment is not known to have LTX-2.5.
  services.resources.update({ apiKey: FAKE_KEY, resources: [{ id: 'deployment', url: v2fake.url, enabled: true }] });
  const dp = await engine.planComp({ tool: 'upscale', source: 'layer', options: { engine: 'ltx', size: 'fhd' }, cap: 8, resource: 'deployment' });
  check('a finishing plan on a deployment says JustAE Flow knows of no LTX-2.5 there', dp.warnings.some((w) => /knows of no LTX-2\.5 model there/.test(w) && /built without LTX-2\.5/.test(w)), JSON.stringify(dp.warnings));
  const beforeDep = submits.length;
  const { id: depId } = await engine.runCompTool({ tool: 'upscale', source: 'layer', options: { engine: 'ltx', size: 'same' }, cap: 8, resource: 'deployment' });
  await until(() => ['done', 'error'].includes(engine.state().cards.find((c) => c.id === depId)?.status ?? ''));
  const depc = engine.state().cards.find((c) => c.id === depId)!;
  check('…and a run sent there is refused before anything is uploaded', depc.status === 'error' && /runs on your local ComfyUI/.test(depc.error ?? '') && submits.length === beforeDep, depc.error);
  services.resources.update({ apiKey: null, resources: [{ id: 'deployment', remove: true }] });

  // The Flow window's chained step (Featured ▸ H3 ▸ Final ▸ + LTX Refine): the server plans the Refine from the file.
  const { spawnSync: run } = await import('node:child_process');
  if (run('ffmpeg', ['-version']).status === 0) {
    const clip = join(engine.state().mediaDir, 'h3_draft_like.mp4');
    run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=448x256:rate=24', '-frames:v', '29', '-pix_fmt', 'yuv420p', clip]);
    const routes = finishingRoutes(services);
    const { createServer: mk } = await import('node:http');
    const srv = mk(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      for (const [method, re, h] of routes) { const m = re.exec(url.pathname); if (m && req.method === method) return void (await h(req, res, m, url)); }
      res.writeHead(404); res.end();
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    const refused = await fetch(`${base}/api/finishing/graph`, { method: 'POST', body: JSON.stringify({ file: clip }) });
    check('POST /api/finishing/graph wants the page\'s session token (it reads a file)', refused.status === 403);
    const r = await fetch(`${base}/api/finishing/graph`, { method: 'POST', headers: { 'x-flow-token': SESSION_TOKEN }, body: JSON.stringify({ file: clip }) });
    const d = await r.json() as { error?: string; graph: Record<string, { class_type: string; inputs: Record<string, unknown> }>; loadNode: string; saveNode: string; previewNode: string; plan: { delivery: { w: number; h: number }; tiles: number; frames: { source: number; total: number } }; estimate: { line: string } };
    check('…plans LTX Refine to Full HD from the file itself (ffprobe: 448×256, 29 frames → 1890×1080 on a 1888×1088 canvas, 29 → 41 frames)',
      r.ok && d.plan.delivery.w === 1890 && d.plan.delivery.h === 1080 && d.plan.frames.source === 29 && d.plan.frames.total === 41
      && d.graph[d.loadNode]?.class_type === 'LoadVideo' && d.graph[d.saveNode]?.class_type === 'SaveImageAdvanced' && d.graph[d.previewNode]?.class_type === 'SaveVideo' && /RTX 5080/.test(d.estimate.line),
      d.error ?? JSON.stringify(d.plan));
    srv.close();
  }
}

console.log('comp routes');
{
  const { createServer: mk } = await import('node:http');
  const routes = compRoutes(engine);
  const srv = mk(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    for (const [method, re, h] of routes) {
      const m = re.exec(url.pathname);
      if (m && req.method === method) return void (await h(req, res, m, url));
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  const get = await (await fetch(`${base}/api/comp`)).json() as { comp: { name: string; workArea: number[] }; tools: unknown[]; runs: unknown[] };
  check('GET /api/comp: the comp with its work area, the tools, the runs', get.comp?.name === 'Comp' && get.comp.workArea[0] === 1 && get.tools.length === 13 && get.runs.length >= 4);
  const pl = await (await fetch(`${base}/api/comp/plan`, { method: 'POST', body: JSON.stringify({ tool: 'reframe', source: 'comp', options: { aspect: '4:3' }, cap: 8 }) })).json() as { ok: boolean; makes: string; warnings: string[] };
  check('POST /api/comp/plan: 4:3 from the whole comp, capped at 8 s, said', pl.ok && /1440×1080/.test(pl.makes) && pl.warnings.some((w) => /12\.0 s/.test(w)));
  const no = await fetch(`${base}/api/comp/run`, { method: 'POST', body: JSON.stringify({ tool: 'upscale', source: 'comp', options: { scale: 2 } }) });
  check('POST /api/comp/run wants the page\'s session token', no.status === 403);
  const bad = await fetch(`${base}/api/comp/run`, { method: 'POST', headers: { 'X-Flow-Token': SESSION_TOKEN }, body: JSON.stringify({ tool: 'nope', source: 'comp' }) });
  check('an unknown tool is refused in words', bad.status === 400 && /No Comp tool/.test(((await bad.json()) as { error: string }).error));
  const ok = await (await fetch(`${base}/api/comp/run`, { method: 'POST', headers: { 'X-Flow-Token': SESSION_TOKEN }, body: JSON.stringify({ tool: 'upscale', source: 'comp', options: { scale: 2 }, cap: 4 }) })).json() as { id: string; queued: number };
  check('with the token it queues the run', !!ok.id && ok.queued === 1);
  await until(() => ['done', 'error'].includes(engine.state().cards.find((c) => c.id === ok.id)?.status ?? ''));
  check('…which renders the whole comp with the cap it was given (4 s)', host.renders.at(-1)?.cap === 4 && engine.state().cards.find((c) => c.id === ok.id)?.status === 'done');
  const cmp = await fetch(`${base}/api/comp/compare`, { method: 'POST', headers: { 'X-Flow-Token': SESSION_TOKEN }, body: JSON.stringify({ id: ok.id }) });
  check('POST /api/comp/compare switches it', cmp.ok && ((await cmp.json()) as { showing: string }).showing === 'original');
  srv.close();
  await host.openComp(1);
  await engine.sync();
}

console.log('featured workflows');
{
  await services.caps.get('local', true);
  const entries = featuredView(services, library);
  const h3 = entries.find((e) => e.id === 'h3-flf');
  check('Featured lists the eight entries, in order, each with where it runs', entries.map((e) => e.id).join() === FEATURED.map((f) => f.id).join() && entries.length === 8 && entries.every((e) => e.runsOn.some((r) => r.resource === 'local')));
  check('…from the probes: Local ✓ where the local ComfyUI has every node and model', entries.find((e) => e.id === 'ltx25-i2v')?.runsOn.find((r) => r.resource === 'local')?.status === 'ok' && entries.every((e) => e.runnable === e.runsOn.some((r) => r.status === 'ok' || r.status === 'proven')));
  check('MiniMax H3 first + last frame: Draft / Final, Final = + SeedVR2 ×2 or + LTX Refine, and its licence note',
    h3?.tiers?.finals.map((x) => `${x.id}:${x.then}`).join() === 'seedvr2:seedvr2-upscale,ltx:ltx25-refine' && h3.tiers.finals[0].scale === 2
    && /MiniMax commercial licence/.test(h3.licenceNote ?? '') && /to be verified/.test(h3.licenceNote ?? ''));
  const h3d = library.graph('h3-flf-draft')!;
  check('H3 Draft is the turbo 4-step LoRA the official template names, 4 steps; the base model stays in Final',
    h3?.tiers?.draft.workflow === 'h3-flf-draft' && h3.draftName === library.get('h3-flf-draft')!.manifest.title
    && Object.values(h3d).some((n) => n.class_type === 'LoraLoaderModelOnly' && n.inputs.lora_name === 'minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors' && n.inputs.strength_model === 1)
    && JSON.stringify(h3d['105:9'].inputs.steps) === '["105:125",0]' && h3d['105:125'].inputs.value === 4 && JSON.stringify(h3d['105:16'].inputs.model) === '["105:121",0]'
    && library.get('h3-flf-draft')!.manifest.models.some((x) => /Comfy-Org\/MiniMax-H3\/resolve\/main\/loras\/minimax_h3_fl2v_turbo_4step/.test(x.url)));
  const h3g = library.graph('h3-flf')!;
  check('the H3 graph takes a first and a last frame, on the base model (no turbo LoRA left in it)',
    JSON.stringify(h3g['105:104'].inputs.first_frame) === '["114",0]' && JSON.stringify(h3g['105:104'].inputs.last_frame) === '["130",0]' && !Object.values(h3g).some((n) => n.class_type === 'LoraLoaderModelOnly'));
  const routes = featuredRoutes(services, library);
  const { createServer: mk } = await import('node:http');
  const srv = mk(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    for (const [method, re, h] of routes) { const m = re.exec(url.pathname); if (m && req.method === method) return void (await h(req, res, m, url)); }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  const g = await fetch(`${base}/api/featured/ltx25-i2v/graph`);
  const graph = await g.json() as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
  const remaps = JSON.parse(decodeURIComponent(g.headers.get('x-flow-remaps') ?? '[]')) as string[];
  check('GET /api/featured/:id/graph: the bundled graph with the local precision swapped in (int8 → nvfp4 here)',
    g.ok && Object.values(graph).some((n) => n.inputs.unet_name === 'ltx-2.5-22b-distilled-transformer-nvfp4.safetensors') && remaps.some((r) => /nvfp4/.test(r)));
  check('…and only for Featured entries', (await fetch(`${base}/api/featured/sam3-reframe/graph`)).status === 404);
  srv.close();
}

const sidecar = JSON.parse(readFileSync(join(projectDir, 'p.justae-flow.json'), 'utf8')) as { cards: unknown[] };
engine.stop();
check('the storyboard is saved next to the project', Array.isArray(sidecar.cards) && sidecar.cards.length >= 3);
setRef({}, undefined, 1);

/* ─── Canvas host (PhotoCraft) ─────────────────────────────────────── */
console.log('canvas host');
const canvasRoot = mkdtempSync(join(tmpdir(), 'sf-canvas-'));
class FakeCanvas implements CanvasHost {
  readonly id = 'photocraft' as const;
  readonly kind = 'canvas' as const;
  readonly label = 'PhotoCraft';
  readonly root = canvasRoot;
  layers: Array<{ id: number; name: string; bounds: Box; visible: boolean; label: string }> = [{ id: 1, name: 'Background', bounds: [0, 0, 1000, 600], visible: true, label: 'none' }];
  selection: Box | null = null;
  channels: string[] = [];
  placed: CanvasPlaceRequest[] = [];
  exported: string[] = [];
  opened: string[] = [];
  next = 10;
  async snapshot(): Promise<HostSnapshot> {
    return {
      app: 'photocraft', version: '', project: { path: 'demo/scene.png', dirty: false },
      comp: { id: 7, name: 'scene.png', width: 1000, height: 600, fps: 0, duration: 0 }, markers: [],
      layers: this.layers.map((l, i) => ({ id: l.id, index: i + 1, name: l.name, in: 0, out: 0, start: 0, label: l.label, type: 'Pixel', bounds: l.bounds, visible: l.visible })),
      selectedLayers: [], time: 0, selection: this.selection, channels: this.channels,
    };
  }
  async exportComposite(rel: string): Promise<void> { const { writeFileSync, mkdirSync } = await import('node:fs'); mkdirSync(dirname(join(canvasRoot, rel)), { recursive: true }); writeFileSync(join(canvasRoot, rel), 'png'); this.exported.push(`composite:${rel}`); }
  async exportLayer(id: number, rel: string): Promise<void> { await this.exportComposite(rel); this.exported.push(`layer:${id}`); }
  async placeImage(r: CanvasPlaceRequest): Promise<number> { this.placed.push(r); const id = this.next++; this.layers.unshift({ id, name: r.name, bounds: r.box, visible: true, label: 'none' }); return id; }
  async openDocument(rel: string): Promise<void> { this.opened.push(rel); }
  async saveSelection(name: string): Promise<Box | null> { if (!this.selection) return null; this.channels.push(name); return this.selection; }
  async createPlaceholderBox(name: string, box: Box): Promise<number> { const id = this.next++; this.layers.unshift({ id, name, bounds: box, visible: true, label: 'blue' }); return id; }
  async setStatus(t: { layerId?: number }, s: CardStatus): Promise<void> { const l = this.layers.find((x) => x.id === t.layerId); if (l) l.label = s; }
  async setLayerVisible(id: number, v: boolean): Promise<void> { const l = this.layers.find((x) => x.id === id); if (l) l.visible = v; }
  async setLayerLabel(): Promise<void> {}
  async renameLayer(): Promise<void> {}
  close(): void {}
}
const pc = new FakeCanvas();
const canvas = new Engine({ ...settings, host: 'photocraft', photocraftRoot: canvasRoot }, library, services, pc);
await canvas.checkComfy();
await canvas.sync();
check('a canvas offers only the workflows made for it', canvas.state().workflows.every((w) => w.hosts.includes('photocraft')) && !canvas.state().workflows.some((w) => w.id.startsWith('ltx')));
check('the storyboard lives in the automation folder', canvas.state().mediaDir.startsWith(canvasRoot));
let refusedSel = false;
try { await canvas.addSelectionCard(); } catch { refusedSel = true; }
check('no selection, no selection card — said plainly', refusedSel);
pc.selection = [600, 40, 300, 200];
await canvas.sync();
const selId = await canvas.addSelectionCard();
const sel = canvas.state().cards.find((c) => c.id === selId)!;
check('a selection is saved as an alpha channel and becomes a card', sel.origin.kind === 'selection' && pc.channels.includes(`Flow ${selId}`) && sel.workflowId === 'qwen-edit');
const phId = await canvas.createPlaceholder();
const ph2 = canvas.state().cards.find((c) => c.id === phId)!;
check('a canvas placeholder is a box over the selection', ph2.origin.kind === 'placeholder' && JSON.stringify(ph2.origin.box) === JSON.stringify([600, 40, 300, 200]));
pc.layers.find((l) => l.name.startsWith('Flow placeholder'))!.bounds = [100, 300, 400, 200];
await canvas.sync();
check('moving the placeholder in the host moves the card\'s box', JSON.stringify((canvas.state().cards.find((c) => c.id === phId)!.origin as { box: Box }).box) === JSON.stringify([100, 300, 400, 200]));
check('the plan follows the box (400×200 → 416×192)', canvas.state().cards.find((c) => c.id === phId)!.plan.width === 416);
await canvas.updateCards([selId], { prompt: 'add a striped balloon' });
await canvas.updateCards([phId], { prompt: 'a cabin at dawn' });
canvas.enqueue();
await until(() => canvas.state().cards.every((c) => c.status === 'done'));
check('both canvas cards finish', canvas.state().cards.every((c) => c.status === 'done'), canvas.state().cards.map((c) => c.error ?? '').join(' | '));
const selPlace = pc.placed.find((p) => p.maskChannel === `Flow ${selId}`);
check('a selection result covers the canvas, masked to the saved selection, feathered', !!selPlace && selPlace.fit === 'stretch' && JSON.stringify(selPlace.box) === '[0,0,1000,600]' && (selPlace.feather ?? 0) >= 4);
check('the selection card sent the whole visible image', pc.exported.some((e) => e.startsWith('composite:')));
const phPlace = pc.placed.find((p) => p.maskBox);
check('a placeholder result covers its box, masked to it', !!phPlace && phPlace.fit === 'cover' && JSON.stringify(phPlace.box) === '[100,300,400,200]');
check('the placeholder is hidden, not deleted', pc.layers.find((l) => l.name.startsWith('Flow placeholder'))?.visible === false);
canvas.enqueue([selId]);
await until(() => canvas.state().cards.find((c) => c.id === selId)!.versions.length === 2);
const two2 = canvas.state().cards.find((c) => c.id === selId)!;
const v1Layer = pc.layers.find((l) => l.id === two2.versions[0].layerId)!;
const v2Layer = pc.layers.find((l) => l.id === two2.versions[1].layerId)!;
check('a new version is a new layer; the old one is hidden, kept', v1Layer.visible === false && v2Layer.visible === true);
await canvas.selectVersion(selId, 1);
check('switching versions swaps which layer shows', v1Layer.visible === true && v2Layer.visible === false);
pc.channels = [];
await canvas.sync();
check('a deleted selection channel orphans its card', canvas.state().cards.find((c) => c.id === selId)?.orphan === true);
canvas.stop();

fake.close();
v2fake.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
