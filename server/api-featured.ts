/**
 * The Workflow tab's Featured section (PLAN v3 §4.3): a few bundled workflows,
 * each with where it runs — from the capability probes, never guessed — and,
 * when something is missing there, which file and where the official template
 * downloads it from.
 *
 *   GET /api/featured             the entries, with "runs on" per resource and what is missing locally
 *   GET /api/featured/:id/graph   the bundled API graph, with the local ComfyUI's precisions swapped in
 *                                 (the Flow window runs it like any workflow of its library)
 *
 * Nothing here probes anything: it reads the capability cache (server/capabilities.ts)
 * and the run history the probes use. Every entry stays listed, greyed with its
 * missing files, when it runs nowhere.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ComfyNode, WorkflowJson } from '../core/comfy/types.ts';
import { resolveModels, type WorkflowManifest } from '../core/workflows/manifest.ts';
import type { WorkflowLibrary } from './library.ts';
import type { Resource } from './resources.ts';
import type { Services } from './services.ts';

type Handler = (req: IncomingMessage, res: ServerResponse, m: RegExpExecArray, url: URL) => Promise<void> | void;

/** A Final: the draft's workflow, then a chained step on its result (a second job on the same resource). */
export interface FinalTier { id: 'seedvr2' | 'ltx'; label: string; then: string; scale: number; note: string }

/** Where a Featured entry belongs on the Workflow tab: making something, or working on what is there. */
export type FeaturedGroup = 'generate' | 'edit';

export interface FeaturedDef {
  id: string;
  name: string;
  /** One line: what it does for you. */
  line: string;
  group: FeaturedGroup;
  /** The licence in one line, and its text's link when the manifest gives one. */
  licence: { text: string; url?: string };
  tiers?: { draft: { workflow: string; note: string }; finals: FinalTier[] };
  licenceNote?: string;
  /** Runs from a Comp tab card, not as the Marker / Storyboard tabs' workflow ("Use it" opens that card). */
  comp?: { tool: string; engine?: string; label: string };
}

const LTX_LICENCE = { text: 'LTX-2.x Community License: commercial use under USD 10M annual revenue', url: 'https://github.com/Lightricks/LTX-2/blob/main/LICENSE-2_x' };

/**
 * The entries, in order, in two groups. `tiers`: Draft runs its own workflow (MiniMax H3: the 4-step turbo LoRA of the
 * official template); Final runs the entry's workflow (the base model), then one of the chained steps on its result.
 * The licence lines shorten the manifests' own (`license.weights`), which stay the full text.
 */
const H3_FEATURED_LICENCE = { text: 'MiniMax H3: commercial use of local outputs needs a MiniMax licence (sold by Comfy); EU: to be verified' };
const H3_NOTE = 'Commercial use of locally generated H3 outputs needs a MiniMax commercial licence (sold by Comfy); in the EU: to be verified on the licence text.';
/** Every H3 entry: Draft runs its turbo workflow; Final the base model, then SeedVR2 ×2 or LTX Refine on the result. */
const h3Tiers = (draft: string): NonNullable<FeaturedDef['tiers']> => ({
  draft: { workflow: draft, note: 'Draft = the 4-step turbo LoRA the official template names (Comfy-Org/MiniMax-H3), 4 steps: a quick look, never the final.' },
  finals: [
    { id: 'seedvr2', label: '+ SeedVR2 ×2', then: 'seedvr2-upscale', scale: 2, note: 'Final = the base model (20 steps), then SeedVR2 ×2 on its result (a second job), original colours kept.' },
    { id: 'ltx', label: '+ LTX Refine', then: 'ltx25-refine', scale: 1, note: 'Final = the base model (20 steps), then LTX Refine to Full HD on its result (LTX-2.5 + Refine Details, tiled; a second job on your local ComfyUI, with a PNG 16-bit master). For 4K: Comp tab ▸ Upscale ▸ LTX Refine.' },
  ],
});

export const FEATURED: FeaturedDef[] = [
  { id: 'zimage-t2i', group: 'generate', name: 'Z-Image-Turbo · text to image', line: 'A still in seconds: plates, keyframes, title backgrounds.', licence: { text: 'Apache-2.0' } },
  { id: 'ltx25-i2v', group: 'generate', name: 'LTX-2.5 · image to video', line: "A shot with sound from a frame: the marker's, or an image you attach.", licence: LTX_LICENCE },
  { id: 'ltx25-t2v', group: 'generate', name: 'LTX-2.5 · text to video', line: 'A shot with sound from the prompt alone, sized and timed by the slot.', licence: LTX_LICENCE },
  {
    id: 'h3-flf', group: 'generate', name: 'MiniMax H3 · first + last frame', line: 'From one frame you choose to another, with sound.',
    licence: { text: 'MiniMax H3: commercial use of local outputs needs a MiniMax licence (sold by Comfy); EU: to be verified' },
    tiers: {
      draft: { workflow: 'h3-flf-draft', note: 'Draft = the 4-step turbo LoRA the official template names (Comfy-Org/MiniMax-H3), 4 steps: a quick look, never the final.' },
      finals: [
        { id: 'seedvr2', label: '+ SeedVR2 ×2', then: 'seedvr2-upscale', scale: 2, note: 'Final = the base model (20 steps), then SeedVR2 ×2 on its result (a second job), original colours kept.' },
        { id: 'ltx', label: '+ LTX Refine', then: 'ltx25-refine', scale: 1, note: 'Final = the base model (20 steps), then LTX Refine to Full HD on its result (LTX-2.5 + Refine Details, tiled; a second job on your local ComfyUI, with a PNG 16-bit master). For 4K: Comp tab ▸ Upscale ▸ LTX Refine.' },
      ],
    },
    licenceNote: 'Commercial use of locally generated H3 outputs needs a MiniMax commercial licence (sold by Comfy); in the EU: to be verified on the licence text.',
  },
  {
    id: 'h3-t2v', group: 'generate', name: 'MiniMax H3 · text to video', line: 'A shot with sound from the prompt alone, sized and timed by the slot.',
    licence: H3_FEATURED_LICENCE, tiers: h3Tiers('h3-t2v-draft'), licenceNote: H3_NOTE,
  },
  {
    id: 'h3-i2v', group: 'generate', name: 'MiniMax H3 · image to video', line: "A shot with sound from the marker's frame, or an image you attach.",
    licence: H3_FEATURED_LICENCE, tiers: h3Tiers('h3-i2v-draft'), licenceNote: H3_NOTE,
  },
  { id: 'wan22-flf', group: 'generate', name: 'Wan 2.2 14B · first + last frame', line: 'Keyframe to keyframe, under Apache-2.0.', licence: { text: 'Apache-2.0' } },
  { id: 'qwen-edit', group: 'edit', name: 'Qwen-Image-Edit 2511', line: 'Change an image as the prompt says.', licence: { text: 'Apache-2.0' } },
  { id: 'seedvr2-upscale', group: 'edit', name: 'SeedVR2 · video upscale ×2', line: 'Restored detail at twice the size.', licence: { text: 'Apache-2.0' } },
  { id: 'sam3-matte', group: 'edit', name: 'SAM 3 · subject matte', line: 'The subject the prompt names, tracked through the clip.', licence: { text: 'SAM License (Meta): royalty-free, commercial use included' } },
  {
    id: 'ltx25-refine', group: 'edit', name: 'LTX Refine · more detail, up to 4K', line: 'Rebuilds fine detail on a clip (LTX-2.5 + Refine Details), on your local ComfyUI.',
    licence: LTX_LICENCE, comp: { tool: 'upscale', engine: 'ltx', label: 'Comp tab ▸ Upscale ▸ LTX Refine' },
  },
  {
    id: 'h3-regen-2k', group: 'edit', name: 'Open-H3 · regenerate an H3 draft to 2K', line: 'The H3 model redraws its own 768p draft at twice the size (NVlabs refiner): a 96 GB job, on the platform.',
    licence: { text: 'MiniMax H3 open weights (+ a MiniMax licence for commercial use); Open-H3 refiner (NVlabs): no licence stated; LBH latent upscaler: its own' },
    comp: { tool: 'upscale', engine: 'openh3', label: 'Comp tab ▸ Upscale ▸ Open-H3 2K' },
  },
];

export interface FeaturedRunsOn {
  resource: string;
  kind: Resource['kind'];
  label: string;
  /** ok: its probe found every node and model · proven: a run of it finished there · missing · unknown · unusable (off, no key, refuses jobs). */
  status: 'ok' | 'proven' | 'missing' | 'unknown' | 'unusable';
  note?: string;
}

export interface FeaturedEntry {
  id: string;
  name: string;
  line: string;
  title: string;
  task: WorkflowManifest['task'];
  input?: WorkflowManifest['input'];
  output: WorkflowManifest['output'];
  template: string;
  licence: string;
  licenceNote?: string;
  tiers?: FeaturedDef['tiers'];
  group: FeaturedGroup;
  licenceLine: FeaturedDef['licence'];
  comp?: FeaturedDef['comp'];
  /** The draft tier's own workflow, as a library entry the Flow window can load ("bundled:<id>"). */
  draftName?: string;
  runsOn: FeaturedRunsOn[];
  /** Missing on the local ComfyUI: node classes, and model files with where the template downloads them. */
  missing: Array<{ kind: 'node' | 'model'; name: string; directory?: string; url?: string }>;
  /** Runs on at least one resource that can take jobs. */
  runnable: boolean;
}

export function featuredView(s: Services, library: WorkflowLibrary): FeaturedEntry[] {
  const out: FeaturedEntry[] = [];
  for (const f of FEATURED) {
    const entry = library.get(f.id);
    if (!entry) continue;
    const m = entry.manifest;
    const runsOn: FeaturedRunsOn[] = [];
    for (const r of s.resources.list()) {
      if (!r.enabled && r.kind !== 'local') continue;
      const can = s.resources.canTakeJobs(r);
      if (!can.ok) { runsOn.push({ resource: r.id, kind: r.kind, label: r.label, status: 'unusable', note: can.reason }); continue; }
      const w = s.caps.cached(r.id)?.workflows[m.id];
      const note = w?.status === 'missing' ? [...w.missingNodes, ...w.missingModels].slice(0, 3).join(', ')
        : w?.status === 'proven' ? `ran here ${w.provenAt?.slice(0, 10) ?? ''}`.trim()
          : w?.status === 'unknown' && (r.kind === 'deployment' || r.kind === 'proxy') ? 'not run here yet' : undefined;
      runsOn.push({ resource: r.id, kind: r.kind, label: r.label, status: w?.status ?? 'unknown', note });
    }
    const local = s.caps.cached(s.resources.local().id)?.workflows[m.id];
    const missing: FeaturedEntry['missing'] = [
      ...(local?.missingNodes ?? []).map((n) => ({ kind: 'node' as const, name: n })),
      ...(local?.missingModels ?? []).map((name) => {
        const k = m.models.find((x) => x.name === name);
        return { kind: 'model' as const, name, directory: k?.directory, url: k?.url };
      }),
    ];
    out.push({
      id: m.id, name: f.name, line: f.line, title: m.title, task: m.task, input: m.input, output: m.output,
      template: m.source.template, licence: m.license.weights, licenceNote: f.licenceNote, tiers: f.tiers, runsOn, missing,
      group: f.group, licenceLine: f.licence, comp: f.comp,
      draftName: f.tiers ? library.get(f.tiers.draft.workflow)?.manifest.title : undefined,
      runnable: runsOn.some((r) => r.status === 'ok' || r.status === 'proven'),
    });
  }
  return out;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

/**
 * The graph as the Flow window should read it: sized by the comp, as the engine sizes it.
 *
 * The Flow window finds the knobs the comp fills by reading the graph (`client/src/workflows/form.ts`). A template that
 * wires its size from a node of its own — LTX-2.5's `ResolutionSelector`, 16:9 at 0.9 MP — leaves it nothing to fill,
 * so a 9:16 comp would get a 16:9 clip. The manifest names the two numbers that set the size (`bindings.width`,
 * `bindings.height`): when one is wired, it becomes a plain number (the manifest's default) tagged `[AE_WIDTH]` /
 * `[AE_HEIGHT]`, with the manifest's lattice and long-side cap in `_meta.flowSize` for the form to snap and scale to.
 * The node that fed it is left unconnected, and ComfyUI does not run it.
 */
export function compSized(graph: WorkflowJson, m: WorkflowManifest): WorkflowJson {
  const sides: Array<['width' | 'height', string | undefined]> = [['width', m.bindings.width], ['height', m.bindings.height]];
  if (!sides.every(([, ref]) => !!ref)) return graph;
  const out = structuredClone(graph);
  for (const [side, ref] of sides) {
    const dot = ref!.indexOf('.');
    const node = out[ref!.slice(0, dot)];
    const field = ref!.slice(dot + 1);
    if (!node || !Array.isArray(node.inputs[field])) continue;
    node.inputs[field] = m.defaults?.[side] ?? (side === 'width' ? 1280 : 704);
    const title = String(node._meta?.title ?? node.class_type).replace(/\s*\[AE_[A-Z]+\]/g, '');
    node._meta = {
      ...node._meta,
      title: `${title} [AE_${side.toUpperCase()}]`,
      flowSize: { multiple: m.sizeMultiple ?? 32, ...(m.maxLongSide ? { maxLongSide: m.maxLongSide } : {}) },
    } as ComfyNode['_meta'];
  }
  return out;
}

export function featuredRoutes(s: Services, library: WorkflowLibrary): Array<[string, RegExp, Handler]> {
  return [
    ['GET', /^\/api\/featured$/, (_q, res) => send(res, 200, { entries: featuredView(s, library) })],
    ['GET', /^\/api\/featured\/([\w-]+)\/graph$/, (_q, res, m) => {
      const entry = library.get(m[1]);
      // A Featured entry, or the workflow of one of its tiers (MiniMax H3's Draft).
      if (!entry || !FEATURED.some((f) => f.id === m[1] || f.tiers?.draft.workflow === m[1])) return send(res, 404, { error: `No featured workflow "${m[1]}".` });
      const graph = compSized(library.graph(m[1])!, entry.manifest);
      // The template names one precision of each model; the local ComfyUI may have another of the same weights.
      const oi = s.caps.objectInfo(s.resources.local().id);
      const check = oi ? resolveModels(graph, oi, entry.manifest.models) : null;
      res.setHeader('X-Flow-Remaps', encodeURIComponent(JSON.stringify(check?.remaps.map((r) => `${r.wanted} → ${r.using}`) ?? [])));
      send(res, 200, graph);
    }],
  ];
}
