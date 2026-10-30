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

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SLUG } from '../core/brand.ts';
import { ComfyClient } from '../core/comfy/client.ts';
import type { ObjectInfo, WorkflowJson } from '../core/comfy/types.ts';
import { convertUiToApi } from '../core/workflows/uiconvert.ts';
import { missingNodes, type ModelFile, type WorkflowManifest } from '../core/workflows/manifest.ts';
import { REFRAME_ASPECTS, vaceGenSize } from '../core/reframe/outpaint.ts';
import { LTX_LICENCE_LINE, LTX_LICENCE_URL } from '../core/finishing/licence.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'workflows');
const base = process.argv[2] ?? process.env.COMFY_URL ?? 'http://127.0.0.1:8188';

type Recipe = Omit<WorkflowManifest, 'api' | 'models' | 'source'> & {
  /** An official ComfyUI template the server serves at /templates/<name>.json … */
  template: string;
  /** … or a workflow kept in workflows/sources/ (a community workflow with no template): converted the same way. */
  file?: string;
  patch?: (api: WorkflowJson) => void;
  /** Card params whose choices are the node's own, read from the server's object_info at build time. */
  optionsFrom?: (oi: ObjectInfo) => void;
  /** Model files a patch brings in that the template does not list. */
  extraModels?: ModelFile[];
  /** The patch replaced the template's model: list only extraModels. */
  ownModels?: boolean;
  /** Template models the patch took out of the graph. */
  dropModels?: string[];
};

/** The LTX-2.x Community License, as the README, NOTICE, the Featured cards and the LTX finishing cards state it (core/finishing/licence.ts). */
const LTX_LICENSE_NOTE = LTX_LICENCE_LINE;
const LTX_LICENSE_URL = LTX_LICENCE_URL;

const LTX_LICENSE = {
  weights: `${LTX_LICENSE_NOTE} — ${LTX_LICENSE_URL}`,
  openWeights: true,
};

/** Qwen3-VL-4B-Instruct: apache-2.0 on its model card (Qwen/Qwen3-VL-4B-Instruct) and on Comfy-Org/Qwen3-VL (HF API, 25 Oct 2026). */
const QWEN3VL_LICENSE = { weights: 'Apache-2.0 (Qwen3-VL-4B-Instruct, Qwen; repackaged by Comfy-Org/Qwen3-VL)', openWeights: true };

const SAM_LICENSE = {
  weights: 'SAM License (Meta) — royalty-free, commercial use included; trade-control and lawful-use terms apply',
  openWeights: true,
};

const LIGHTX2V = 'wan2.1_t2v_14b_lora_rank64_lightx2v_4step.safetensors';
/** MiniMax H3's 4-step turbo LoRA, as the official template's note names it (Comfy-Org/MiniMax-H3, loras/). */
const H3_TURBO_4STEP = 'minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors';

const VACE_BINDINGS: WorkflowManifest['bindings'] = {
  prompt: '6.text', negative: '7.text', video: '71.file', seed: '3.seed',
  width: '137.value', height: '139.value', frames: '131.value', fps: '68.fps',
};

/** The generation frame per format, by the rule in core/reframe/outpaint.ts (vaceGenSize). */
function vaceSizes(model: '14b' | '1.3b'): Record<string, [number, number]> {
  return Object.fromEntries(REFRAME_ASPECTS.map((a) => [a, vaceGenSize(a, model)]));
}

const VACE_OUTPAINT = {
  take: '200.length',
  start: '200.batch_index',
  scale: ['201.width', '201.height'] as [string, string],
  // The part of the scaled clip the model is shown (core/reframe/outpaint.ts: inset, SEAM_GUARD).
  crop: { x: '202.x', y: '202.y', width: '202.width', height: '202.height' },
  pad: ['110.left', '110.top', '110.right', '110.bottom'] as [string, string, string, string],
  // Tested: 125 frames in one run stay coherent to the last frame.
  maxFrames: 125,
  chain: { padded: ['110', 0] as [string, number], padMask: ['110', 1] as [string, number], controlVideo: '49.control_video', controlMasks: '49.control_masks' },
};

/**
 * Frame interpolation, from the official template `utility_video_frame_interpolation`
 * (LoadVideo → GetVideoComponents → FrameInterpolate → CreateVideo → SaveVideo, with
 * a multiplier and "Apply multiplier to FPS?"). FILM is the template as it ships
 * (core nodes, film_net_fp16). RIFE swaps the template's interpolator for a custom
 * node checked in this server's object_info; everything around it — the multiplier,
 * the frame-rate switch, the save — stays the template's. (GIMM-VFI was a third
 * engine until 25 Oct: its S-Lab 1.0 licence is non-commercial, so it is not shipped.)
 */
const INTERP = {
  // "Int (Multiplier)", "Boolean (Apply multiplier to FPS?)", and the audio the template carries over.
  multiplier: '16:9.value', multiplyFps: '16:13.value', audio: '16:5.audio',
};
const INTERPOLATION: Recipe[] = [
  {
    id: 'interp-rife',
    template: 'utility_video_frame_interpolation',
    title: 'RIFE · Frame interpolation',
    description: 'New frames between the frames: slow motion (×2, ×4 the length) or twice the frame rate (24 → 48, 25 → 50, 30 → 60).',
    task: 'interpolate-video', hosts: ['effectcraft'], output: 'video', input: 'video',
    bindings: { video: '4.file' },
    params: [{ ref: INTERP.multiplier, label: 'Multiplier' }, { ref: INTERP.multiplyFps, label: 'Multiply the frame rate' }],
    interpolate: INTERP,
    // The pack's checkpoint list is fixed in its code and it downloads a missing one itself: no model folder to check.
    ownModels: true,
    license: {
      weights: 'MIT (RIFE by hzwer, Practical-RIFE; node pack ComfyUI-Frame-Interpolation by Fannovel16, MIT)',
      openWeights: true,
      note: 'The pack downloads rife47.pth itself from Hugging Face mirrors it lists (vfi_utils.py), not from the RIFE author: provenance of that file to be verified.',
    },
    patch: (api) => {
      // RIFE VFI (ComfyUI-Frame-Interpolation) in place of the template's FrameInterpolationModelLoader + FrameInterpolate.
      delete api['16:1'];
      api['16:2'] = {
        class_type: 'RIFE VFI',
        inputs: {
          // rife47.pth: the checkpoint the pack has on disk here (its list default is rife49.pth, which it would download).
          ckpt_name: 'rife47.pth', frames: ['16:3', 0], clear_cache_after_n_frames: 10, multiplier: ['16:9', 0],
          fast_mode: true, ensemble: true, scale_factor: 1, dtype: 'float32', torch_compile: false, batch_size: 1,
        },
        _meta: { title: 'RIFE VFI' },
      };
      api['7'].inputs.filename_prefix = SLUG + '/interp_rife';
    },
  },
  {
    id: 'interp-film',
    template: 'utility_video_frame_interpolation',
    title: 'FILM · Frame interpolation (ComfyUI core)',
    description: 'The official template as it ships: core nodes and Google\'s FILM model, for large motion RIFE tears on.',
    task: 'interpolate-video', hosts: ['effectcraft'], output: 'video', input: 'video',
    bindings: { video: '4.file' },
    params: [{ ref: INTERP.multiplier, label: 'Multiplier' }, { ref: INTERP.multiplyFps, label: 'Multiply the frame rate' }],
    interpolate: INTERP,
    license: {
      weights: 'Apache-2.0 (FILM, google-research/frame-interpolation); the file is Comfy-Org\'s repackaging (its model card says "other": to be verified)',
      openWeights: true,
    },
    patch: (api) => { api['7'].inputs.filename_prefix = SLUG + '/interp_film'; },
  },
];

/**
 * Keyframe models for the Workflow tab's Featured section (the Flow window runs
 * them; `hosts: []` keeps them out of the panel's own pickers, which fill one image).
 */
/** MiniMax H3's licence line, as every H3 recipe states it. */
const H3_LICENSE = {
  weights: 'MiniMax H3 open weights: commercial use of locally generated outputs needs a MiniMax commercial licence (sold by Comfy); EU territory: to be verified on the licence text',
  openWeights: true,
};
/** The 8-step turbo LoRA the templates list: not in these graphs. */
const H3_DROP = ['minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors'];
const H3_TURBO_MODEL: ModelFile[] = [{
  name: H3_TURBO_4STEP, directory: 'loras',
  url: `https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/loras/${H3_TURBO_4STEP}`,
}];

/**
 * The template's turbo branch (a LoRA loader, a model switch, a steps switch), taken out for the base model or
 * switched on for the draft, by the ids of its nodes: the text-to-video template numbers its subgraph 140 (nodes
 * 119–139), the image-to-video one 105 (nodes 6–126). ComfyUI validates every linked node, switch or not, so the
 * branch that is not used goes, and a ComfyUI without the LoRA file can run the base graph.
 */
interface H3BranchIds { lora: string; modelSwitch: string; stepsSwitch: string; unet: string; baseSteps: string; turboSteps: string; enable: string }
const T2V_IDS: H3BranchIds = { lora: '140:134', modelSwitch: '140:135', stepsSwitch: '140:136', unet: '140:127', baseSteps: '140:137', turboSteps: '140:138', enable: '140:139' };
const I2V_IDS: H3BranchIds = { lora: '105:121', modelSwitch: '105:122', stepsSwitch: '105:123', unet: '105:6', baseSteps: '105:124', turboSteps: '105:125', enable: '105:126' };
function h3Branch(api: WorkflowJson, ids: H3BranchIds, turbo: boolean): void {
  for (const node of Object.values(api)) {
    for (const [k, v] of Object.entries(node.inputs)) {
      if (Array.isArray(v) && v[0] === ids.modelSwitch) node.inputs[k] = [turbo ? ids.lora : ids.unet, 0];
      if (Array.isArray(v) && v[0] === ids.stepsSwitch) node.inputs[k] = [turbo ? ids.turboSteps : ids.baseSteps, 0];
    }
  }
  if (turbo) {
    api[ids.lora].inputs.lora_name = H3_TURBO_4STEP;
    api[ids.lora].inputs.strength_model = 1;
    api[ids.turboSteps].inputs.value = 4;
    for (const id of [ids.modelSwitch, ids.stepsSwitch, ids.baseSteps, ids.enable]) delete api[id];
  } else {
    for (const id of [ids.lora, ids.modelSwitch, ids.stepsSwitch, ids.turboSteps, ids.enable]) delete api[id];
  }
}
const H3_T2V_BINDINGS = { prompt: '140:131.prompt', seed: '140:129.noise_seed', width: '140:131.width', height: '140:131.height', seconds: '140:133.value' };
const H3_I2V_BINDINGS = { prompt: '105:104.prompt', image: '114.image', seed: '105:15.noise_seed', width: '105:104.width', height: '105:104.height', seconds: '105:111.value' };

const KEYFRAMES: Recipe[] = [
  {
    id: 'h3-flf',
    template: 'video_minimax_h3_i2v',
    title: 'MiniMax H3 · First + last frame',
    description: 'A clip with sound that starts on one frame you give it and ends on another (base model, 20 steps).',
    dropModels: ['minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors'],
    task: 'i2v', hosts: [], output: 'video', input: 'image',
    bindings: { prompt: '105:104.prompt', image: '114.image', seed: '105:15.noise_seed', width: '105:104.width', height: '105:104.height', seconds: '105:111.value' },
    sizeMultiple: 32, maxLongSide: 1344, defaults: { seconds: 5, width: 1344, height: 768 },
    license: {
      weights: 'MiniMax H3 open weights: commercial use of locally generated outputs needs a MiniMax commercial licence (sold by Comfy); EU territory: to be verified on the licence text',
      openWeights: true,
    },
    patch: (api) => {
      // The template's MiniMaxH3ImageToVideo takes an optional last_frame (object_info): a second image, wired to it.
      api['130'] = { class_type: 'LoadImage', inputs: { image: 'last_frame.png' }, _meta: { title: 'Load Image (last frame)' } };
      api['105:104'].inputs.last_frame = ['130', 0];
      // The template's own image is the first frame: named so, it reads as one of a pair in the shot's inputs.
      api['114']._meta = { title: 'Load Image (first frame)' };
      // A scale node the template leaves without an input, and its size reader: not part of the run.
      delete api['119'];
      delete api['120'];
      // The base model, 20 steps — the template's default (its turbo LoRA switch is off); the LoRA branch goes, so a
      // ComfyUI without that LoRA file can run it (ComfyUI validates every linked node, switch or not).
      for (const node of Object.values(api)) {
        for (const [k, v] of Object.entries(node.inputs)) {
          if (Array.isArray(v) && v[0] === '105:122') node.inputs[k] = ['105:6', 0];
          if (Array.isArray(v) && v[0] === '105:123') node.inputs[k] = ['105:124', 0];
        }
      }
      for (const id of ['105:121', '105:122', '105:123', '105:125', '105:126']) delete api[id];
      api['92'].inputs.filename_prefix = SLUG + '/h3_flf';
    },
  },
  {
    // Draft = the 4-step turbo LoRA the official template's note names (Comfy-Org/MiniMax-H3, "4 steps"); the local
    // file's sha256 equals that repo's LFS sha256 (checked 25 Oct 2026). The
    // template's own turbo branch (LoraLoaderModelOnly + the steps switch) is kept and switched on; Final is h3-flf.
    id: 'h3-flf-draft',
    template: 'video_minimax_h3_i2v',
    title: 'MiniMax H3 · First + last frame (Draft, turbo 4 steps)',
    description: 'The H3 draft: the template\'s turbo LoRA branch on, with its 4-step 768p LoRA, 4 steps. For a quick look; Final is the base model.',
    dropModels: ['minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors'],
    extraModels: [{
      name: H3_TURBO_4STEP, directory: 'loras',
      url: `https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/loras/${H3_TURBO_4STEP}`,
    }],
    task: 'i2v', hosts: [], output: 'video', input: 'image',
    bindings: { prompt: '105:104.prompt', image: '114.image', seed: '105:15.noise_seed', width: '105:104.width', height: '105:104.height', seconds: '105:111.value' },
    sizeMultiple: 32, maxLongSide: 1344, defaults: { seconds: 5, width: 1344, height: 768 },
    license: {
      weights: 'MiniMax H3 open weights: commercial use of locally generated outputs needs a MiniMax commercial licence (sold by Comfy); EU territory: to be verified on the licence text',
      openWeights: true,
    },
    patch: (api) => {
      api['130'] = { class_type: 'LoadImage', inputs: { image: 'last_frame.png' }, _meta: { title: 'Load Image (last frame)' } };
      api['105:104'].inputs.last_frame = ['130', 0];
      api['114']._meta = { title: 'Load Image (first frame)' };
      delete api['119'];
      delete api['120'];
      // The turbo branch, switched on: the model goes through the LoRA, the steps come from the turbo value.
      for (const node of Object.values(api)) {
        for (const [k, v] of Object.entries(node.inputs)) {
          if (Array.isArray(v) && v[0] === '105:122') node.inputs[k] = ['105:121', 0];
          if (Array.isArray(v) && v[0] === '105:123') node.inputs[k] = ['105:125', 0];
        }
      }
      api['105:121'].inputs.lora_name = H3_TURBO_4STEP;
      api['105:121'].inputs.strength_model = 1;
      api['105:125'].inputs.value = 4;
      for (const id of ['105:122', '105:123', '105:124', '105:126']) delete api[id];
      api['92'].inputs.filename_prefix = SLUG + '/h3_flf_draft';
    },
  },
  {
    id: 'h3-t2v',
    template: 'video_minimax_h3_t2v',
    title: 'MiniMax H3 · Text to video',
    description: 'A clip with sound from the prompt alone, at the comp\'s size and length (base model, 20 steps).',
    dropModels: H3_DROP,
    task: 't2v', hosts: [], output: 'video',
    bindings: H3_T2V_BINDINGS,
    sizeMultiple: 32, maxLongSide: 1344, defaults: { seconds: 5, width: 1344, height: 768 },
    license: H3_LICENSE,
    patch: (api) => { h3Branch(api, T2V_IDS, false); api['92'].inputs.filename_prefix = SLUG + '/h3_t2v'; },
  },
  {
    id: 'h3-t2v-draft',
    template: 'video_minimax_h3_t2v',
    title: 'MiniMax H3 · Text to video (Draft, turbo 4 steps)',
    description: 'The H3 draft from the prompt alone: the template\'s turbo LoRA branch on, 4 steps. For a quick look; Final is the base model.',
    dropModels: H3_DROP, extraModels: H3_TURBO_MODEL,
    task: 't2v', hosts: [], output: 'video',
    bindings: H3_T2V_BINDINGS,
    sizeMultiple: 32, maxLongSide: 1344, defaults: { seconds: 5, width: 1344, height: 768 },
    license: H3_LICENSE,
    patch: (api) => { h3Branch(api, T2V_IDS, true); api['92'].inputs.filename_prefix = SLUG + '/h3_t2v_draft'; },
  },
  {
    id: 'h3-i2v',
    template: 'video_minimax_h3_i2v',
    title: 'MiniMax H3 · Image to video',
    description: 'A clip with sound that starts on the frame under the marker, or an image you attach (base model, 20 steps).',
    dropModels: H3_DROP,
    task: 'i2v', hosts: [], output: 'video', input: 'image',
    bindings: H3_I2V_BINDINGS,
    sizeMultiple: 32, maxLongSide: 1344, defaults: { seconds: 5, width: 1344, height: 768 },
    license: H3_LICENSE,
    patch: (api) => {
      // The template's scale node without an input, and its size reader: not part of the run.
      delete api['119'];
      delete api['120'];
      h3Branch(api, I2V_IDS, false);
      api['92'].inputs.filename_prefix = SLUG + '/h3_i2v';
    },
  },
  {
    id: 'h3-i2v-draft',
    template: 'video_minimax_h3_i2v',
    title: 'MiniMax H3 · Image to video (Draft, turbo 4 steps)',
    description: 'The H3 draft from one frame: the template\'s turbo LoRA branch on, 4 steps. For a quick look; Final is the base model.',
    dropModels: H3_DROP, extraModels: H3_TURBO_MODEL,
    task: 'i2v', hosts: [], output: 'video', input: 'image',
    bindings: H3_I2V_BINDINGS,
    sizeMultiple: 32, maxLongSide: 1344, defaults: { seconds: 5, width: 1344, height: 768 },
    license: H3_LICENSE,
    patch: (api) => {
      delete api['119'];
      delete api['120'];
      h3Branch(api, I2V_IDS, true);
      api['92'].inputs.filename_prefix = SLUG + '/h3_i2v_draft';
    },
  },
  {
    id: 'wan22-flf',
    template: 'video_wan2_2_14B_flf2v',
    title: 'Wan 2.2 14B · First + last frame',
    description: 'Keyframe to keyframe under Apache-2.0: the licence-safe choice for client work.',
    task: 'i2v', hosts: [], output: 'video', input: 'image',
    bindings: { prompt: '90.text', negative: '78.text', image: '80.image', seed: '84.noise_seed', width: '81.width', height: '81.height', frames: '81.length', fps: '86.fps' },
    sizeMultiple: 16, frameLattice: { min: 1, step: 4 }, maxLongSide: 1280, defaults: { seconds: 5, width: 1280, height: 720 },
    license: { weights: 'Apache-2.0 (Wan-AI Wan2.2)', openWeights: true },
    patch: (api) => { api['83'].inputs.filename_prefix = SLUG + '/wan22_flf'; },
  },
];

const RECIPES: Recipe[] = [
  ...KEYFRAMES,
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
    id: 'ltx25-extend',
    template: 'video_ltx2_5_flf2v',
    title: 'LTX-2.5 · Extend (video guide)',
    description: 'Carries a clip on: its last frames guide LTX-2.5 from the start of the new clip, so the motion goes on as it was.',
    task: 'extend-video', hosts: ['effectcraft'], output: 'video', input: 'video',
    bindings: {
      prompt: '251:252.value', negative: '251:217.text', video: '300.file', seed: '251:196.noise_seed',
      width: '251:215.value', height: '251:216.value', seconds: '251:198.value', fps: '251:205.value',
    },
    // EmptyLTXVLatentVideo steps by 32; the template is one stage at the full size (no latent upscaler).
    sizeMultiple: 32, maxLongSide: 1536, defaults: { seconds: 2, width: 1280, height: 704 },
    // LTXVAddGuide: "Must be 8*n + 1 frames" (its tooltip, object_info). 17 at 24 fps is 0.7 s of motion.
    guide: { start: '302.batch_index', take: '302.length', frames: [17, 9] },
    license: LTX_LICENSE,
    patch: (api) => {
      // The template guides with two stills (LTXVAddGuide at frame 0 and at −1, strength 0.7) and crops the guides off
      // the latent before decoding (LTXVCropGuides). Here the first guide is the source's last frames, as video, and the
      // second goes: LoadVideo → GetVideoComponents → ImageFromBatch (the last N) → the template's resize and
      // LTXVPreprocess → LTXVAddGuide at frame 0, strength 1 (the frames that are already shot stay as they are).
      for (const id of ['31', '39', '251:214', '251:195', '251:204']) delete api[id];
      api['300'] = { class_type: 'LoadVideo', inputs: { file: 'tail.mov' }, _meta: { title: 'Load Video (the source\'s last frames)' } };
      api['301'] = { class_type: 'GetVideoComponents', inputs: { video: ['300', 0] }, _meta: { title: 'Get Video Components' } };
      api['302'] = { class_type: 'ImageFromBatch', inputs: { image: ['301', 0], batch_index: -17, length: 17 }, _meta: { title: 'Image From Batch (the guide frames)' } };
      api['251:213'].inputs.input = ['302', 0];
      // Stretched to the generation size, not cropped (its own "disabled" choice), and lanczos as the i2v template
      // resizes: the result is laid back at the source's size with the inverse scale, so every pixel meets its own.
      api['251:213'].inputs['resize_type.crop'] = 'disabled';
      api['251:213'].inputs.scale_method = 'lanczos';
      api['251:206'].inputs.strength = 1;
      // What the removed last-frame guide fed (the guider, the crop, the audio-video concat) takes the first guide's outputs.
      for (const node of Object.values(api)) {
        for (const [k, v] of Object.entries(node.inputs)) if (Array.isArray(v) && v[0] === '251:204') node.inputs[k] = ['251:206', v[1]];
      }
      // The prompt enhancer (off, as in the template) reads one picture: the last guide frame.
      api['303'] = { class_type: 'ImageFromBatch', inputs: { image: ['251:199', 0], batch_index: -1, length: 1 }, _meta: { title: 'Image From Batch (last frame)' } };
      api['251:247'].inputs.image = ['303', 0];
      api['68'].inputs.filename_prefix = SLUG + '/ltx25_extend';
    },
  },
  {
    id: 'describe-clip',
    template: 'llm_qwen3vl_text_gen',
    title: 'Qwen3-VL · Describe the clip',
    description: 'A few frames of the clip in, a paragraph out: what is in the shot, what moves and how, the camera, the light. Local only.',
    task: 'describe', hosts: [], output: 'text', input: 'video',
    bindings: { prompt: '6.prompt', video: '9.file', seed: '6.sampling_mode.seed' },
    text: { node: '7' },
    license: QWEN3VL_LICENSE,
    patch: (api) => {
      // The template reads one image; Qwen3-VL in ComfyUI takes an image batch as several pictures in one turn
      // (comfy/text_encoders/qwen3vl.py), so a few frames of the clip go in, in order, as a short video.
      delete api['8'];
      api['9'] = { class_type: 'LoadVideo', inputs: { file: 'frames.mp4' }, _meta: { title: 'Load Video (a few frames of the clip)' } };
      api['10'] = { class_type: 'GetVideoComponents', inputs: { video: ['9', 0] }, _meta: { title: 'Get Video Components' } };
      api['6'].inputs.image = ['10', 0];
      api['6'].inputs.max_length = 320;
    },
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
    params: [
      { ref: '66:57.resize_type.multiplier', label: 'Scale' },
      // The template leaves it at "none"; the choices are SeedVR2PostProcessing's own (filled in from object_info).
      { ref: '66:59.color_correction_method', label: 'Colour', options: [] },
    ],
    license: { weights: 'Apache-2.0 (ByteDance Seed SeedVR2)', openWeights: true },
    patch: (api) => { api['76'].inputs.filename_prefix = SLUG + '/seedvr2'; },
    optionsFrom(oi) { this.params![1].options = comboOf(oi, 'SeedVR2PostProcessing', 'color_correction_method'); },
  },
  ...INTERPOLATION,
  {
    // Open-H3 Regenerate 2K (NVlabs, github.com/NVlabs/Sana, branch sol-engine): the H3 model and its refiner LoRA
    // redraw a 768p H3 draft at twice the size, over the LBH latent upscaler, in three steps with the draft's prompt.
    // No official template: the community ComfyUI workflow (father558's rank-128 conversion), without its
    // SolAttnPatch node (sparse attention, a speed-up a 96 GB card does not need), is kept in workflows/sources/.
    id: 'h3-regen-2k',
    template: '', file: 'open-h3-regenerate-2k.json',
    title: 'Open-H3 · Regenerate to 2K',
    description: 'An H3 draft (768p, 24 fps) rebuilt at twice its size by the H3 model itself with the Open-H3 refiner LoRA: motion and timing stay, textures are redrawn, the draft\'s sound is kept. Three steps over the LBH latent upscale.',
    task: 'upscale-video', hosts: ['effectcraft'], output: 'video', input: 'video',
    bindings: { video: '1.file', prompt: '10.value', seed: '17.noise_seed' },
    params: [
      { ref: '5.mode.width', label: 'Target width' }, { ref: '5.mode.height', label: 'Target height' },
      { ref: '11.width', label: 'Canvas width' }, { ref: '11.height', label: 'Canvas height' }, { ref: '11.length', label: 'Frames' },
    ],
    frameLattice: { min: 5, step: 17 }, sizeMultiple: 32,
    license: {
      weights: 'MiniMax H3 open weights (commercial use of locally generated outputs needs a MiniMax commercial licence, sold by Comfy; EU: to be verified); Open-H3 refiner LoRA: NVlabs, no licence stated on its page, merges LightX2V Turbo and LMS Sharp; LBH latent upscaler: its own licence',
      openWeights: true,
    },
    ownModels: true,
    extraModels: [
      { name: 'minimax_h3_fl2va_pruned_int8_convrot.safetensors', directory: 'diffusion_models', url: 'https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors' },
      { name: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', directory: 'text_encoders', url: 'https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors' },
      { name: 'minimax_h3_video_vae_int8_convrot.safetensors', directory: 'vae', url: 'https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_video_vae_int8_convrot.safetensors' },
      { name: 'minimax_h3_open_regenerate_2k_r128_comfyui_bf16.safetensors', directory: 'loras', url: 'https://huggingface.co/father558/H3-Open-Regenerate-2K-ComfyUI-r128/resolve/main/minimax_h3_open_regenerate_2k_r128_comfyui_bf16.safetensors' },
      { name: 'minimax_h3_latent_upscaler_3d_conv_v1_fp16.safetensors', directory: 'latent_upscale_models', url: 'https://huggingface.co/LBH-123-AI/Minimax_h3_latent_Upscaler/resolve/main/minimax_h3_latent_upscaler_3d_conv_v1/minimax_h3_latent_upscaler_3d_conv_v1_fp16.safetensors' },
    ],
    patch: (api) => { api['22'].inputs.filename_prefix = SLUG + '/h3_regen_2k'; },
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
      { ref: '@aspect', label: 'Aspect', options: [...REFRAME_ASPECTS] },
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
    params: [{ ref: '@aspect', label: 'Aspect', options: [...REFRAME_ASPECTS] }],
    outpaint: { ...VACE_OUTPAINT, sizes: vaceSizes('14b') },
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
    params: [{ ref: '@aspect', label: 'Aspect', options: [...REFRAME_ASPECTS] }],
    outpaint: { ...VACE_OUTPAINT, sizes: vaceSizes('1.3b') },
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
 * so the padding is the new space exactly, and the result is saved. The model
 * is shown the scaled clip less a margin on the sides that meet new space
 * (ImageCrop), so its own edge falls under the original in the comp.
 */
function vacePatch(api: WorkflowJson, prefix: string): void {
  delete api['135'];
  delete api['143'];
  api['200'] = { class_type: 'ImageFromBatch', inputs: { image: ['72', 0], batch_index: 0, length: 81 }, _meta: { title: 'Image From Batch' } };
  api['201'] = { class_type: 'ImageScale', inputs: { image: ['200', 0], upscale_method: 'lanczos', width: 720, height: 404, crop: 'disabled' }, _meta: { title: 'Upscale Image' } };
  api['202'] = { class_type: 'ImageCrop', inputs: { image: ['201', 0], width: 720, height: 404, x: 0, y: 0 }, _meta: { title: 'Image Crop' } };
  api['110'].inputs.image = ['202', 0];
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

/** A combo input's choices, as the server's own node schema lists them. */
function comboOf(oi: ObjectInfo, node: string, input: string): string[] {
  const spec = { ...(oi[node]?.input?.required ?? {}), ...(oi[node]?.input?.optional ?? {}) }[input] as unknown[] | undefined;
  const opts = Array.isArray(spec?.[0]) ? spec![0] as unknown[] : (spec?.[1] as { options?: unknown[] } | undefined)?.options;
  if (!Array.isArray(opts) || !opts.length) throw new Error(`${node}.${input} has no choices in this server's object_info`);
  return opts.map(String);
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
  const ui = r.file ? JSON.parse(readFileSync(join(root, 'workflows', 'sources', r.file), 'utf8')) as unknown : await comfy.template(r.template);
  if (!ui) { console.error(`✖ ${r.id}: template ${r.template} not served by ${base}`); failed++; continue; }
  const conv = convertUiToApi(ui, objectInfo);
  if (conv.problems.length) { console.error(`✖ ${r.id}: ${conv.problems.join('; ')}`); failed++; continue; }
  const api = conv.api;
  r.patch?.(api);
  r.optionsFrom?.(objectInfo);
  const absent = missingNodes(api, objectInfo);
  const outpaintRefs = r.outpaint ? [r.outpaint.take, r.outpaint.start, ...r.outpaint.scale, ...r.outpaint.pad, r.outpaint.chain.controlVideo, r.outpaint.chain.controlMasks,
    ...(r.outpaint.crop ? Object.values(r.outpaint.crop) : [])].map((ref) => ['outpaint', ref] as const) : [];
  const guideRefs = r.guide ? [['guide', r.guide.start] as const, ['guide', r.guide.take] as const] : [];
  if (r.text && !api[r.text.node]) { console.error(`✖ ${r.id}: text node ${r.text.node} not in graph`); failed++; }
  for (const [k, ref] of [...Object.entries(r.bindings), ...(r.params ?? []).filter((p) => !p.ref.startsWith('@')).map((p) => [p.label, p.ref] as const), ...outpaintRefs, ...guideRefs]) {
    const dot = ref.indexOf('.', ref.lastIndexOf(':') + 1);
    const node = api[ref.slice(0, dot)];
    if (!node || !(ref.slice(dot + 1) in node.inputs)) { console.error(`✖ ${r.id}: binding ${k} → ${ref} not in graph`); failed++; }
  }
  const { template, file, patch: _patch, optionsFrom: _options, extraModels, ownModels, dropModels, ...rest } = r;
  const manifest: WorkflowManifest = {
    ...rest,
    api: `${r.id}.api.json`,
    models: [...(ownModels ? [] : templateModels(ui).filter((x) => !dropModels?.includes(x.name))), ...(extraModels ?? [])],
    source: file ? { template: `sources/${file}`, package: 'justae-flow', version: '1' } : { template, package: 'comfyui-workflow-templates', version },
  };
  writeFileSync(join(outDir, `${r.id}.api.json`), JSON.stringify(api, null, 2) + '\n');
  writeFileSync(join(outDir, `${r.id}.json`), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`✔ ${r.id}  ${Object.keys(api).length} nodes  from ${template}@${version}${absent.length ? `  (nodes not on this server: ${absent.join(', ')})` : ''}`);
}
process.exit(failed ? 1 : 0);
