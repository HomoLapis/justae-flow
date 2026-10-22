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
  /** Model files a patch brings in that the template does not list. */
  extraModels?: ModelFile[];
};

const LTX_LICENSE = {
  weights: 'LTX-2 Community License (Lightricks) — free below USD 10M annual revenue; read it before commercial use',
  openWeights: true,
};

const SAM_LICENSE = {
  weights: 'SAM License (Meta) — royalty-free, commercial use included; trade-control and lawful-use terms apply',
  openWeights: true,
};

const LIGHTX2V = 'wan2.1_t2v_14b_lora_rank64_lightx2v_4step.safetensors';

const VACE_BINDINGS: WorkflowManifest['bindings'] = {
  prompt: '6.text', negative: '7.text', video: '71.file', seed: '3.seed',
  width: '137.value', height: '139.value', frames: '131.value', fps: '68.fps',
};

const VACE_OUTPAINT = {
  take: '200.length',
  start: '200.batch_index',
  scale: ['201.width', '201.height'] as [string, string],
  pad: ['110.left', '110.top', '110.right', '110.bottom'] as [string, string, string, string],
  // Tested: 125 frames in one run stay coherent to the last frame.
  maxFrames: 125,
  chain: { padded: ['110', 0] as [string, number], padMask: ['110', 1] as [string, number], controlVideo: '49.control_video', controlMasks: '49.control_masks' },
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
    title: 'SAM 3 · Auto Crop',
    description: 'Crops to another aspect ratio and follows what the prompt names: a new comp, the clip at 100%, framed with keyframes you can edit. Nothing is generated.',
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
  {
    id: 'vace-reframe',
    template: 'video_wan_vace_outpainting',
    title: 'Wan VACE 14B · Reframe',
    description: 'Changes the clip\'s aspect ratio and generates the new space around it (720p). A new comp: the generated frame below, your clip on top, untouched, with a soft edge.',
    task: 'outpaint-video', hosts: ['effectcraft'], output: 'video', input: 'video',
    bindings: VACE_BINDINGS,
    frameLattice: { min: 1, step: 4 },
    params: [{ ref: '@aspect', label: 'Aspect', options: ['9:16', '4:5', '1:1', '16:9'] }],
    outpaint: { ...VACE_OUTPAINT, sizes: { '9:16': [720, 1280], '4:5': [832, 1040], '1:1': [960, 960], '16:9': [1280, 720] } },
    license: {
      weights: 'Apache-2.0 (Wan2.1 VACE 14B; lightx2v 4-step LoRA)',
      openWeights: true,
      note: 'The template accelerates with the CausVid LoRA, which is CC BY-NC 4.0; this workflow uses lightx2v\'s Apache-2.0 distillation LoRA instead.',
    },
    extraModels: [{ name: LIGHTX2V, directory: 'loras', url: `https://huggingface.co/lightx2v/Wan2.1-Distill-Loras/resolve/main/${LIGHTX2V}` }],
    patch: (api) => {
      vacePatch(api, SLUG + '/vace_reframe');
      api['165'].inputs.lora_name = LIGHTX2V;
      api['165'].inputs.strength_model = 1;
      api['3'].inputs.steps = 4;
      api['3'].inputs.cfg = 1;
    },
  },
  {
    id: 'vace-reframe-draft',
    template: 'video_wan_vace_outpainting',
    title: 'Wan VACE 1.3B · Reframe (draft)',
    description: 'The same reframe on the template\'s small model, at 480p: a quick look at the framing before the 14B run.',
    task: 'outpaint-video', hosts: ['effectcraft'], output: 'video', input: 'video',
    bindings: VACE_BINDINGS,
    frameLattice: { min: 1, step: 4 },
    params: [{ ref: '@aspect', label: 'Aspect', options: ['9:16', '4:5', '1:1', '16:9'] }],
    outpaint: { ...VACE_OUTPAINT, sizes: { '9:16': [480, 832], '4:5': [576, 720], '1:1': [624, 624], '16:9': [832, 480] } },
    license: { weights: 'Apache-2.0 (Wan2.1 VACE 1.3B)', openWeights: true },
    patch: (api) => {
      vacePatch(api, SLUG + '/vace_reframe_draft');
      // The template's 1.3B loader, without the CausVid LoRA (CC BY-NC 4.0): its default sampler settings instead.
      api['151'].inputs.unet_name = 'wan2.1_vace_1.3B_fp16.safetensors';
      delete api['165'];
      api['48'].inputs.model = ['151', 0];
      api['6'].inputs.clip = ['161', 0];
      api['7'].inputs.clip = ['161', 0];
      api['3'].inputs.steps = 20;
      api['3'].inputs.cfg = 6;
    },
  },
];

/**
 * The template pads a clip by fixed amounts and previews it; here the clip is
 * first cut to the frames one run holds and scaled into the generation frame,
 * so the padding is the new space exactly, and the result is saved.
 */
function vacePatch(api: WorkflowJson, prefix: string): void {
  delete api['135'];
  delete api['143'];
  api['200'] = { class_type: 'ImageFromBatch', inputs: { image: ['72', 0], batch_index: 0, length: 81 }, _meta: { title: 'Image From Batch' } };
  api['201'] = { class_type: 'ImageScale', inputs: { image: ['200', 0], upscale_method: 'lanczos', width: 720, height: 404, crop: 'disabled' }, _meta: { title: 'Upscale Image' } };
  api['110'].inputs.image = ['201', 0];
  // A soft strip into the clip, so the new space grows out of it rather than meeting it at a line.
  api['110'].inputs.feathering = 24;
  api['69'].inputs.filename_prefix = prefix;
}

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
  const outpaintRefs = r.outpaint ? [r.outpaint.take, r.outpaint.start, ...r.outpaint.scale, ...r.outpaint.pad, r.outpaint.chain.controlVideo, r.outpaint.chain.controlMasks].map((ref) => ['outpaint', ref] as const) : [];
  for (const [k, ref] of [...Object.entries(r.bindings), ...(r.params ?? []).filter((p) => !p.ref.startsWith('@')).map((p) => [p.label, p.ref] as const), ...outpaintRefs]) {
    const dot = ref.indexOf('.', ref.lastIndexOf(':') + 1);
    const node = api[ref.slice(0, dot)];
    if (!node || !(ref.slice(dot + 1) in node.inputs)) { console.error(`✖ ${r.id}: binding ${k} → ${ref} not in graph`); failed++; }
  }
  const { template, patch: _patch, extraModels, ...rest } = r;
  const manifest: WorkflowManifest = {
    ...rest,
    api: `${r.id}.api.json`,
    models: [...templateModels(ui), ...(extraModels ?? [])],
    source: { template, package: 'comfyui-workflow-templates', version },
  };
  writeFileSync(join(outDir, `${r.id}.api.json`), JSON.stringify(api, null, 2) + '\n');
  writeFileSync(join(outDir, `${r.id}.json`), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`✔ ${r.id}  ${Object.keys(api).length} nodes  from ${template}@${version}${absent.length ? `  (nodes not on this server: ${absent.join(', ')})` : ''}`);
}
process.exit(failed ? 1 : 0);
