/**
 * Regenerates workflows/*.json from the official ComfyUI templates.
 *
 *   node scripts/build-workflows.ts [http://127.0.0.1:8188]
 *
 * Every bundled workflow starts life as a template from the
 * `comfyui-workflow-templates` package that a ComfyUI server serves at
 * /templates/<name>.json. The template is converted to the API format with the
 * server's own node schemas, a few declared patches are applied (an output
 * prefix, a preview turned into a save), and the bindings below say which
 * node field the host fills in. Nothing else is edited by hand.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SLUG } from '../core/brand.ts';
import { ComfyClient } from '../core/comfy/client.ts';
import type { WorkflowJson } from '../core/comfy/types.ts';
import { convertUiToApi } from '../core/workflows/uiconvert.ts';
import { missingNodes, type ModelFile, type WorkflowManifest } from '../core/workflows/manifest.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'workflows');
const base = process.argv[2] ?? process.env.COMFY_URL ?? 'http://127.0.0.1:8188';

type Recipe = Omit<WorkflowManifest, 'api' | 'models' | 'source'> & {
  template: string;
  patch?: (api: WorkflowJson) => void;
};

const LTX_LICENSE = {
  weights: 'LTX-2 Community License (Lightricks) — free below USD 10M annual revenue; read it before commercial use',
  openWeights: true,
};

const SAM_LICENSE = {
  weights: 'SAM License (Meta) — royalty-free, commercial use included; trade-control and lawful-use terms apply',
  openWeights: true,
};

const RECIPES: Recipe[] = [
  {
    id: 'ltx25-i2v',
    template: 'video_ltx2_5_i2v',
    title: 'LTX-2.5 · Image to Video',
    description: 'Animates the frame under the marker (or an image you attach) into a clip with sound.',
    task: 'i2v', hosts: ['effectcraft'], output: 'video', input: 'image',
    bindings: {
      prompt: '398:376.value', negative: '398:373.text', image: '395.image', seed: '398:339.noise_seed',
      width: '398:372.value', height: '398:360.value', seconds: '398:362.value', fps: '398:361.value',
    },
    sizeMultiple: 64, maxLongSide: 1536, defaults: { seconds: 5, width: 1280, height: 704 },
    params: [{ ref: '398:383.value', label: 'Prompt enhancer (Gemma)' }],
    license: LTX_LICENSE,
    patch: (api) => { api['75'].inputs.filename_prefix = SLUG + '/ltx25_i2v'; },
  },
  {
    id: 'ltx25-t2v',
    template: 'video_ltx2_5_t2v',
    title: 'LTX-2.5 · Text to Video',
    description: 'A clip with sound from the prompt alone, sized and timed by the slot.',
    task: 't2v', hosts: ['effectcraft'], output: 'video',
    bindings: {
      prompt: '405:376.value', negative: '405:373.text', seed: '405:338.noise_seed',
      width: '405:372.value', height: '405:360.value', seconds: '405:362.value', fps: '405:361.value',
    },
    sizeMultiple: 64, maxLongSide: 1536, defaults: { seconds: 5, width: 1280, height: 704 },
    params: [{ ref: '405:383.value', label: 'Prompt enhancer (Gemma)' }],
    license: LTX_LICENSE,
    patch: (api) => { api['75'].inputs.filename_prefix = SLUG + '/ltx25_t2v'; },
  },
  {
    id: 'zimage-t2i',
    template: 'image_z_image_turbo',
    title: 'Z-Image-Turbo · Text to Image',
    description: 'A still in a few seconds: backgrounds, plates, title cards, keyframes.',
    task: 't2i', hosts: ['effectcraft', 'photocraft'], output: 'image',
    bindings: { prompt: '57:27.text', seed: '57:3.seed', width: '57:13.width', height: '57:13.height' },
    sizeMultiple: 32, maxLongSide: 2048, defaults: { width: 1024, height: 1024 },
    license: { weights: 'Apache-2.0 (Tongyi-MAI Z-Image-Turbo)', openWeights: true },
    patch: (api) => { api['9'].inputs.filename_prefix = SLUG + '/zimage'; },
  },
  {
    id: 'seedvr2-upscale',
    template: 'utility_seedvr2_3b_int8_upscale_video',
    title: 'SeedVR2 · Video Upscale ×2',
    description: 'Restores and doubles the resolution of the clip in the slot.',
    task: 'upscale-video', hosts: ['effectcraft'], output: 'video', input: 'video',
    bindings: { video: '73.file', seed: '66:54.seed' },
    params: [{ ref: '66:57.resize_type.multiplier', label: 'Scale' }],
    license: { weights: 'Apache-2.0 (ByteDance Seed SeedVR2)', openWeights: true },
    patch: (api) => { api['76'].inputs.filename_prefix = SLUG + '/seedvr2'; },
  },
  {
    id: 'birefnet-rmbg',
    template: 'utility_birefnet_remove_background',
    title: 'BiRefNet · Remove Background',
    description: 'Cuts the subject out of a still, with a clean alpha channel.',
    task: 'remove-bg', hosts: ['effectcraft', 'photocraft'], output: 'image', input: 'image',
    bindings: { image: '17.image' },
    license: { weights: 'MIT (BiRefNet)', openWeights: true },
    patch: (api) => {
      // The template only previews; a save is what can be downloaded and placed.
      api['18'] = { class_type: 'SaveImage', inputs: { images: ['19:16', 0], filename_prefix: SLUG + '/rmbg' }, _meta: { title: 'Save Image' } };
      delete api['20'];
    },
  },
  {
    id: 'qwen-edit',
    template: 'image_qwen_image_edit_2511_int8',
    title: 'Qwen-Image-Edit 2511 · Edit',
    description: 'Changes the image as the prompt says; only the selected area takes the change.',
    task: 'i2i', hosts: ['photocraft'], output: 'image', input: 'image',
    bindings: { prompt: '170:151.prompt', image: '41.image', seed: '170:169.seed' },
    params: [{ ref: '170:168.value', label: 'Lightning LoRA (4 steps, faster)' }],
    license: { weights: 'Apache-2.0 (Qwen-Image-Edit-2511; Lightning LoRA by lightx2v, Apache-2.0)', openWeights: true },
    patch: (api) => { api['195'].inputs.filename_prefix = SLUG + '/qwen_edit'; },
  },
  {
    id: 'seedvr2-upscale-image',
    template: 'utility_seedvr2_3b_int8_upscale_image',
    title: 'SeedVR2 · Image Upscale',
    description: 'Restores detail and enlarges the layer; the result keeps its place and size on the canvas.',
    task: 'upscale-image', hosts: ['photocraft'], output: 'image', input: 'image',
    bindings: { image: '1.image', seed: '66:54.seed' },
    params: [{ ref: '66:57.resize_type.multiplier', label: 'Scale' }],
    license: { weights: 'Apache-2.0 (ByteDance Seed SeedVR2)', openWeights: true },
    patch: (api) => { api['9'].inputs.filename_prefix = SLUG + '/seedvr2_image'; },
  },
  {
    id: 'sam3-matte',
    template: 'utility_video_segment_sam3',
    title: 'SAM 3 · Subject Matte',
    description: 'Tracks what the prompt names through the clip and cuts it out with a luma track matte; the clip itself is untouched.',
    task: 'matte-video', hosts: ['effectcraft'], output: 'video', input: 'video',
    bindings: { video: '115.file', prompt: '114:100.text' },
    params: [{ ref: '116.max_objects', label: 'Subjects' }, { ref: '116.detection_threshold', label: 'Threshold' }],
    license: SAM_LICENSE,
    patch: (api) => {
      samTrack(api, 4);
      api['118'] = { class_type: 'MaskToImage', inputs: { mask: ['117', 0] }, _meta: { title: 'Convert Mask to Image' } };
      api['119'] = { class_type: 'CreateVideo', inputs: { images: ['118', 0], fps: ['114:104', 2] }, _meta: { title: 'Create Video' } };
      api['120'] = { class_type: 'SaveVideo', inputs: { video: ['119', 0], filename_prefix: SLUG + '/sam3_matte', format: 'auto', 'format.codec': 'auto' }, _meta: { title: 'Save Video' } };
    },
  },
  {
    id: 'sam3-reframe',
    template: 'utility_video_segment_sam3',
    title: 'SAM 3 · Reframe',
    description: 'Follows what the prompt names and builds a new comp in another aspect ratio, framed on it with keyframes you can edit.',
    task: 'reframe', hosts: ['effectcraft'], output: 'image', input: 'video',
    bindings: { video: '115.file', prompt: '114:100.text' },
    params: [
      { ref: '@aspect', label: 'Aspect', options: ['9:16', '4:5', '1:1', '16:9'] },
      { ref: '@smooth', label: 'Smoothing', options: ['gentle', 'steady', 'locked'] },
    ],
    license: SAM_LICENSE,
    patch: (api) => {
      samTrack(api, 1);
      // A small mask per frame is all the framing needs: where the subject is, not what it looks like.
      api['118'] = { class_type: 'MaskToImage', inputs: { mask: ['117', 0] }, _meta: { title: 'Convert Mask to Image' } };
      api['119'] = { class_type: 'ImageScale', inputs: { image: ['118', 0], upscale_method: 'area', width: 160, height: 0, crop: 'disabled' }, _meta: { title: 'Upscale Image' } };
      api['120'] = { class_type: 'SaveImage', inputs: { images: ['119', 0], filename_prefix: SLUG + '/sam3_track' }, _meta: { title: 'Save Image' } };
    },
  },
];

/**
 * The template detects frame by frame and only previews; tracking keeps one
 * subject the same subject from frame to frame.
 */
function samTrack(api: WorkflowJson, maxObjects: number): void {
  delete api['95'];
  delete api['114:101'];
  api['116'] = {
    class_type: 'SAM3_VideoTrack',
    inputs: { images: ['114:104', 0], model: ['114:102', 0], detection_threshold: 0.5, max_objects: maxObjects, detect_interval: 1, conditioning: ['114:100', 0] },
    _meta: { title: 'SAM3 Video Track' },
  };
  api['117'] = { class_type: 'SAM3_TrackToMask', inputs: { track_data: ['116', 0], object_indices: '' }, _meta: { title: 'SAM3 Track to Mask' } };
}

function templateModels(ui: unknown): ModelFile[] {
  const w = ui as { nodes?: unknown[]; definitions?: { subgraphs?: Array<{ nodes?: unknown[] }> } };
  const nodes = [...(w.nodes ?? []), ...(w.definitions?.subgraphs ?? []).flatMap((s) => s.nodes ?? [])] as Array<{ properties?: { models?: ModelFile[] } }>;
  const seen = new Map<string, ModelFile>();
  for (const n of nodes) for (const m of n.properties?.models ?? []) seen.set(m.name, { name: m.name, directory: m.directory, url: m.url });
  return [...seen.values()];
}

const comfy = new ComfyClient(base);
const health = await comfy.health();
if (!health.online) {
  console.error(health.message);
  process.exit(1);
}
const stats = await (await fetch(`${base}/api/system_stats`)).json() as { system?: { installed_templates_version?: string } };
const version = stats.system?.installed_templates_version ?? 'unknown';
const objectInfo = await comfy.objectInfo();
mkdirSync(outDir, { recursive: true });

let failed = 0;
for (const r of RECIPES) {
  const ui = await comfy.template(r.template);
  if (!ui) { console.error(`✖ ${r.id}: template ${r.template} not served by ${base}`); failed++; continue; }
  const conv = convertUiToApi(ui, objectInfo);
  if (conv.problems.length) { console.error(`✖ ${r.id}: ${conv.problems.join('; ')}`); failed++; continue; }
  const api = conv.api;
  r.patch?.(api);
  const absent = missingNodes(api, objectInfo);
  for (const [k, ref] of [...Object.entries(r.bindings), ...(r.params ?? []).filter((p) => !p.ref.startsWith('@')).map((p) => [p.label, p.ref] as const)]) {
    const dot = ref.indexOf('.', ref.lastIndexOf(':') + 1);
    const node = api[ref.slice(0, dot)];
    if (!node || !(ref.slice(dot + 1) in node.inputs)) { console.error(`✖ ${r.id}: binding ${k} → ${ref} not in graph`); failed++; }
  }
  const { template, patch: _patch, ...rest } = r;
  const manifest: WorkflowManifest = {
    ...rest,
    api: `${r.id}.api.json`,
    models: templateModels(ui),
    source: { template, package: 'comfyui-workflow-templates', version },
  };
  writeFileSync(join(outDir, `${r.id}.api.json`), JSON.stringify(api, null, 2) + '\n');
  writeFileSync(join(outDir, `${r.id}.json`), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`✔ ${r.id}  ${Object.keys(api).length} nodes  from ${template}@${version}${absent.length ? `  (nodes not on this server: ${absent.join(', ')})` : ''}`);
}
process.exit(failed ? 1 : 0);
