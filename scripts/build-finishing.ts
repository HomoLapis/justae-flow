/**
 * Writes workflows/ltx25-<tool>.json (+ .api.json) for the LTX finishing tools.
 *
 *   node scripts/build-finishing.ts
 *
 * Offline: the graphs come from core/finishing (the plan and graph builders of JustAE Flow, from JustAE Flow 2), not
 * from a template the server serves. The tiled ones carry the LTX pack's LTXVGetTilingSizes node in every pass; the
 * sizes it answered on a real pack (scripts/fixtures/ltx-tiling.json) give the representative delivery. At run time the engine builds each graph again from the plan of the clip in hand;
 * these bundled ones are a representative run of each tool, so that what every bundled workflow gets also applies to
 * them — the capability probes ("runs on Local ✓ · deployment ?"), the routing row (Settings ▸ Resources ▸ LTX
 * finishing), `npm run verify:workflows`, and the model list with where each file comes from.
 *
 * Files are named as Lightricks publishes them (bf16); a server's own precision (NVFP4, int8) and sub-folder
 * (loras/LTX2.5/) are swapped in by the usual model check.
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SLUG } from '../core/brand.ts';
import { readFileSync } from 'node:fs';
import { DEFAULT_OPTIONS, planFinish, type FinishPresetId } from '../core/finishing/plan.ts';
import { parseTilingSummary, tilingKey } from '../core/finishing/sizes.ts';
import { buildFinishGraph } from '../core/finishing/graph.ts';
import { BASE_FILES, LORAS, type FinishModels, type LoraId } from '../core/finishing/models.ts';
import { DEFAULT_PROMPTS, singlePrompt } from '../core/finishing/prompt.ts';
import { buildSingleGraph, planSingle, type SingleLora } from '../core/finishing/single.ts';
import { LTX_LICENCE_LINE, LTX_LICENCE_URL } from '../core/finishing/licence.ts';
import type { ModelFile, WorkflowManifest } from '../core/workflows/manifest.ts';
import type { WorkflowJson } from '../core/comfy/types.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'workflows');

const models: FinishModels = {
  transformer: BASE_FILES.transformer.file,
  textEncoder: BASE_FILES.textEncoder.file,
  vae: BASE_FILES.vae.file,
  loras: Object.fromEntries(Object.entries(LORAS).map(([k, v]) => [k, v.file])) as FinishModels['loras'],
};

const base: ModelFile[] = [
  { name: BASE_FILES.transformer.file, directory: BASE_FILES.transformer.directory, url: BASE_FILES.transformer.url },
  { name: BASE_FILES.textEncoder.file, directory: BASE_FILES.textEncoder.directory, url: BASE_FILES.textEncoder.url },
  { name: BASE_FILES.vae.file, directory: BASE_FILES.vae.directory, url: BASE_FILES.vae.url },
];
const loraFile = (id: LoraId): ModelFile => ({ name: LORAS[id].file, directory: 'loras', url: `https://huggingface.co/${LORAS[id].repo}/blob/main/${LORAS[id].file}` });

/** A 5 s clip at 1280×704, 24 fps (the size of the LTX-2.5 clips this was tested with). */
const SRC = { width: 1280, height: 704, pixelAspect: 1, frames: 121, fps: 24 };
const PREVIEW = { prefix: `${SLUG}/finish/preview`, fps: 24, audio: true };
const LICENSE = { weights: `${LTX_LICENCE_LINE} — ${LTX_LICENCE_URL}`, openWeights: true };

interface Out { id: string; title: string; description: string; api: WorkflowJson; loras: LoraId[]; template: string }

const answers = (JSON.parse(readFileSync(join(root, 'scripts', 'fixtures', 'ltx-tiling.json'), 'utf8')) as { answers: Record<string, string> }).answers;

function tiled(id: string, title: string, description: string, preset: FinishPresetId, loras: LoraId[]): Out {
  const plan = planFinish(SRC, { ...DEFAULT_OPTIONS, preset, preview: false, refineInRestore: 0.3 }, (r) => {
    const t = answers[tilingKey(r)];
    return t ? parseTilingSummary(t) : null;
  });
  const { workflow } = buildFinishGraph({
    plan, models, input: { video: 'source.mp4' }, prompts: { ...DEFAULT_PROMPTS }, seed: 42,
    outputPrefix: `${SLUG}/finish/frame`, preview: PREVIEW,
  });
  return { id, title, description, api: workflow as WorkflowJson, loras, template: 'LTX-2.5_V2V_TiledFusion_Upscale.json' };
}

function single(id: string, title: string, description: string, lora: SingleLora): Out {
  const plan = planSingle(lora, SRC);
  const { workflow } = buildSingleGraph({
    plan, models, video: 'source.mp4', prompt: singlePrompt(lora, 'a sailboat on a misty lake at dawn'), seed: 42,
    outputPrefix: `${SLUG}/finish/frame`, master: lora === 'alpha' ? 'none' : 'png16', preview: PREVIEW,
  });
  return { id, title, description, api: workflow as WorkflowJson, loras: [lora], template: 'LTX-2.5_V2V_ICLoRA_Single_Stage_Distilled.json' };
}

const OUT: Out[] = [
  tiled('ltx25-refine', 'LTX-2.5 · Refine (Tiled Fusion)', 'Rebuilt detail to Full HD, 4K or 8K (through 4K): the Refine Details IC-LoRA on overlapping tiles, sized by the LTX pack (LTXVGetTilingSizes).', 'refine-fhd', ['refine']),
  tiled('ltx25-restore', 'LTX-2.5 · Archive restore', 'Restore at 100 %, then Refine: the Restore IC-LoRA, then the Refine Details IC-LoRA, on tiles sized by the LTX pack (LTXVGetTilingSizes).', 'restore-archive', ['restore', 'refine']),
  single('ltx25-deblur', 'LTX-2.5 · Deblur', 'Out-of-focus footage back in focus (the Deblur IC-LoRA, one pass).', 'deblur'),
  single('ltx25-decompression', 'LTX-2.5 · De-compression', 'Compression artefacts removed (the Decompression IC-LoRA, one pass).', 'decompression'),
  single('ltx25-colorize', 'LTX-2.5 · Colorize', 'Natural colour for black-and-white footage (the Colorization IC-LoRA, one pass).', 'colorize'),
  single('ltx25-cleanplate', 'LTX-2.5 · Clean plate', 'People and vehicles removed, the background rebuilt (the Clean Plate IC-LoRA, one pass).', 'cleanplate'),
  single('ltx25-alpha', 'LTX-2.5 · Alpha matte', 'A soft-edged luma matte of the foreground (the Alpha Gen IC-LoRA, one pass, no prompt).', 'alpha'),
  single('ltx25-daynight', 'LTX-2.5 · Day → Night', 'The same shot relit at night (the Day-To-Night IC-LoRA, one pass).', 'daynight'),
];

for (const o of OUT) {
  const load = Object.entries(o.api).find(([, n]) => n.class_type === 'LoadVideo')?.[0];
  if (!load) throw new Error(`${o.id}: no LoadVideo`);
  const manifest: WorkflowManifest = {
    id: o.id, title: o.title, description: o.description,
    task: 'finish-video', hosts: [], output: 'video', input: 'video',
    api: `${o.id}.api.json`,
    bindings: { video: `${load}.file` },
    models: [...base, ...o.loras.map(loraFile)],
    source: { template: o.template, package: 'ComfyUI-LTXVideo (example_workflows/2.5), via core/finishing', version: '1.1.0' },
    license: LICENSE,
  };
  writeFileSync(join(outDir, `${o.id}.api.json`), JSON.stringify(o.api, null, 2) + '\n');
  writeFileSync(join(outDir, `${o.id}.json`), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`✔ ${o.id}  ${Object.keys(o.api).length} nodes`);
}
