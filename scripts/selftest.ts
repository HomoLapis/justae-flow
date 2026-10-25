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
import type { Box, CanvasHost, CanvasPlaceRequest, HostMarker, HostSnapshot, ItemInfo, OutpaintRequest, PlaceRequest, ReframeRequest, TimelineHost } from '../hosts/types.ts';
import { chainGraph, DELIVERY, joinGraph, planOutpaint } from '../core/reframe/outpaint.ts';
import type { Settings } from '../server/config.ts';
import { Engine } from '../server/engine.ts';
import { WorkflowLibrary } from '../server/library.ts';
import { makeServices } from '../server/services.ts';
import { FAKE_KEY, fakeV2, resourceChecks } from './selftest-resources.ts';

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
  check(`${m.id}: has a Save node with a justae-flow prefix`, Object.values(api).some((n) => /^Save/.test(n.class_type) && String(n.inputs.filename_prefix ?? '').startsWith('justae-flow/')));
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
  check('outpaint 9:16: the clip fills the width, the space above and below is to be generated', p.scaled[0] === 720 && p.scaled[1] === 411 && p.pad[0] === 0 && p.pad[2] === 0 && p.pad[1] + p.pad[3] === 1280 - 411);
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
    Math.abs(p.clipScale - 1080 / 1344 * 100) < 0.01 && Math.abs(p.clipCentre[0] - 540) < 0.01 && Math.abs(p.clipCentre[1] - (p.pad[1] + 411 / 2) * 1.5) < 0.01 && p.bgScale === 150);
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
// The fake server has every model the bundled workflows name — the LTX transformer only as nvfp4,
// like the machine this was built on, so the precision swap is exercised.
const objectInfo: ObjectInfo = {};
for (const m of library.list()) {
  for (const n of Object.values(library.graph(m.id)!)) {
    const info = (objectInfo[n.class_type] ??= { input: { required: {} }, output_node: /^Save/.test(n.class_type) });
    for (const [k, v] of Object.entries(n.inputs)) {
      if (typeof v !== 'string' || !/\.(safetensors|pth)$/.test(v)) continue;
      const opts = ((info.input!.required![k] ??= [[]])[0] as string[]);
      const local = v.replace('transformer-comfy-int8-convrot', 'transformer-nvfp4');
      if (!opts.includes(local)) opts.push(local);
    }
  }
}
const fake = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const body = await new Promise<string>((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });
  const json = (o: unknown): void => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (url.pathname === '/api/system_stats') return json({ system: { comfyui_version: 'fake' }, devices: [{ name: 'cuda:0 Fake GPU : cudaMallocAsync', vram_free: 8 * 2 ** 30 }] });
  if (url.pathname === '/api/object_info') return json(objectInfo);
  if (url.pathname === '/api/upload/image') return json({ name: 'uploaded.png', subfolder: '' });
  if (url.pathname === '/api/queue') return json({ queue_running: [], queue_pending: [] });
  seenHeaders.push({ path: url.pathname, auth: req.headers.authorization, gpu: req.headers['x-comfy-gpu'] as string | undefined });
  if (url.pathname === '/api/prompt') {
    const p = JSON.parse(body);
    submits.push(p);
    const classes = Object.values(p.prompt as Record<string, { class_type: string }>).map((n) => n.class_type);
    const isVideo = classes.includes('SaveVideo');
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
  items = new Map<number, { path: string | null; width: number; height: number }>();
  labels: string[] = [];
  nextId = 100;
  selected: number[] = [];
  compId = 1;
  mattes: Array<[number, number, string]> = [];
  reframes: ReframeRequest[] = [];
  outpaints: OutpaintRequest[] = [];
  async snapshot(): Promise<HostSnapshot> {
    return {
      app: 'effectcraft', version: 'fake', project: { path: join(projectDir, 'p.ecproj'), dirty: false },
      comp: { id: this.compId, name: 'Comp', width: 1280, height: 720, fps: 24, duration: 12 },
      markers: this.markers.map((m, index) => ({ ...m, index })), layers: this.layers.map(({ item: _i, visible: _v, ...l }) => l),
      selectedLayers: this.selected, time: 0,
    };
  }
  async frameAt(_t: number, out: string): Promise<string> { (await import('node:fs')).writeFileSync(out, 'png'); return out; }
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
  async setTrackMatte(layer: number, matte: number, kind: string): Promise<void> { this.mattes.push([layer, matte, kind]); }
  async buildReframe(r: ReframeRequest): Promise<{ compId: number; layerId: number }> { this.reframes.push(r); this.compId = this.nextId++; return { compId: this.compId, layerId: this.nextId++ }; }
  async openComp(id: number): Promise<void> { this.compId = id; }
  async buildOutpaint(r: OutpaintRequest): Promise<{ compId: number; fillLayer: number; fillItem: number; clipLayer: number }> { this.outpaints.push(r); this.compId = this.nextId++; return { compId: this.compId, fillLayer: this.nextId++, fillItem: this.nextId++, clipLayer: this.nextId++ }; }
  async replaceFootage(itemId: number, file: string): Promise<void> { const it = this.items.get(itemId); if (it) it.path = file; }
  async coverComp(): Promise<void> {}
  async matchLayer(): Promise<void> {}
  async createPlaceholder(r: { name: string; width: number; height: number; duration: number; time: number }): Promise<{ itemId: number; layerId: number }> {
    const itemId = this.nextId++; const layerId = this.nextId++;
    this.items.set(itemId, { path: null, width: r.width, height: r.height });
    this.layers.push({ id: layerId, index: this.layers.length + 1, name: r.name, in: r.time, out: r.time + r.duration, start: r.time, label: 'Aqua', type: 'Footage', item: itemId, visible: true });
    return { itemId, layerId };
  }
  async sourceOfLayer(id: number): Promise<number | null> { return this.layers.find((l) => l.id === id)?.item ?? null; }
  async itemInfo(id: number): Promise<ItemInfo | null> { const it = this.items.get(id); return it ? { id, name: 'x', path: it.path, kind: 'video', width: it.width, height: it.height, duration: 4, frameRate: 24, comment: '' } : null; }
  async addMarker(time: number, comment: string): Promise<void> { this.markers.push({ index: 0, time, duration: 0, comment, label: 'None', cardId: null }); this.markers.sort((a, b) => a.time - b.time); }
  async setLayerComment(): Promise<void> {}
  async renameLayer(): Promise<void> {}
  async relink(): Promise<void> {}
  async setLayerVisible(id: number, v: boolean): Promise<void> { const l = this.layers.find((x) => x.id === id); if (l) l.visible = v; }
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
