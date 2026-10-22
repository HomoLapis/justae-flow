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
    patch: (api) => { api['75'].inputs.filename_prefix = 'shiftfield/ltx25_i2v'; },
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
    patch: (api) => { api['75'].inputs.filename_prefix = 'shiftfield/ltx25_t2v'; },
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
    patch: (api) => { api['9'].inputs.filename_prefix = 'shiftfield/zimage'; },
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
    patch: (api) => { api['76'].inputs.filename_prefix = 'shiftfield/seedvr2'; },
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
      api['18'] = { class_type: 'SaveImage', inputs: { images: ['19:16', 0], filename_prefix: 'shiftfield/rmbg' }, _meta: { title: 'Save Image' } };
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
    patch: (api) => { api['195'].inputs.filename_prefix = 'shiftfield/qwen_edit'; },
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
    patch: (api) => { api['9'].inputs.filename_prefix = 'shiftfield/seedvr2_image'; },
  },
];

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
  for (const [k, ref] of Object.entries(r.bindings)) {
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
