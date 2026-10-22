/**
 * Workflow introspection.
 *
 * Inspects an API-format ComfyUI workflow and reports four categories:
 *
 *   inputs       — file slots (LoadImage, VHS_LoadVideo, LoadAudio…)
 *   outputs      — sinks (SaveImage, VHS_VideoCombine…)
 *   prompts      — text slots, traced through samplers / CFGGuider /
 *                  ComfySwitchNode / passthrough wires
 *   parameters   — scalar knobs (PrimitiveFloat, INTConstant,
 *                  PrimitiveBoolean…) that the user typically wants
 *                  to tune from outside, like "LENGTH", "FPS",
 *                  "FIRST FRAME STRENGTH"
 *
 * `[AE_*]` tags in node titles override heuristics but are optional.
 *
 * Which field is the prompt is decided from the node SCHEMA rather than from a
 * list of class names. The list was the bug: a workflow whose prompt sits on
 * `easy positive` — a node nobody thought to catalogue — came out with no
 * prompt slot at all, so the shot's prompt was accepted by the panel, shown as
 * typed, and then silently dropped at submit time. `/object_info` already says
 * which inputs are `STRING` with `multiline`, and which node consumes them
 * under the name `prompt`; both are facts, and neither needs a catalogue.
 */

import type { ComfyNode, NodeInfo, ObjectInfo, WorkflowJson } from '../comfy/types.ts';
import { nodesFeedingOutputs, resolveInputSpec } from './graph.ts';

export type InputKind = 'image' | 'video' | 'audio';
export type OutputKind = 'image' | 'video' | 'audio';
export type AeHint = 'frame' | 'work-area' | null;
export type ParamKind = 'int' | 'float' | 'boolean' | 'string';

export interface WorkflowInput {
  nodeId: string;
  classType: string;
  title: string;
  kind: InputKind;
  field: string;
  aeHint: AeHint;
  /** The literal value baked into the workflow JSON at import time (e.g. "old_frame.png"). */
  bakedInValue?: string;
}

export interface WorkflowOutput {
  nodeId: string;
  classType: string;
  title: string;
  kind: OutputKind;
  preferred: boolean;
}

export interface PromptSlot {
  nodeId: string;
  field: string;
  title: string;
  preview: string;
  /**
   * How this slot was found, shown in the shot row so the target can be
   * checked before a render rather than after one.
   */
  evidence?: string;
  /** False when the slot sits on a branch nothing outputs. */
  live?: boolean;
}

export interface SeedSlot {
  nodeId: string;
  field: string;
  title: string;
}

export type ParameterRole = 'width' | 'height' | 'frames' | 'length' | 'fps' | null;

export interface ParameterSlot {
  nodeId: string;
  classType: string;
  title: string;
  field: string;
  kind: ParamKind;
  currentValue: number | boolean | string;
  /** Heuristic role inferred from the node title — used by the Match-Comp banner. */
  role: ParameterRole;
}

export interface InspectedWorkflow {
  inputs: WorkflowInput[];
  outputs: WorkflowOutput[];
  positivePrompt: PromptSlot | null;
  negativePrompt: PromptSlot | null;
  seed: SeedSlot | null;
  promptCandidates: PromptSlot[];
  seedCandidates: SeedSlot[];
  parameters: ParameterSlot[];
  primaryOutputKind: OutputKind;
}

/* ─── Class-type catalogues ─────────────────────────────────────────── */

/**
 * Known file-loading nodes — used only as a HINT for which field holds the
 * filename. The detector always verifies the hint matches a string with a
 * media extension before using it; if not, it falls back to shape-based
 * detection so packs that use different field names (`file`, `filename`,
 * `path`, …) still work. The catalogue is intentionally short — adding a
 * class_type here is no longer required for it to be detected.
 */
const INPUT_NODE_HINTS: Record<string, { field: string }> = {
  LoadImage: { field: 'image' },
  LoadImageMask: { field: 'image' },
  ImageLoader: { field: 'image' },
  LoadVideo: { field: 'video' },           // some packs use this; others use `file`
  VHS_LoadVideo: { field: 'video' },
  VHS_LoadVideoPath: { field: 'video' },
  LoadAudio: { field: 'audio' },
  VHS_LoadAudio: { field: 'audio' },
};

/**
 * Recognised media extensions per input kind. The detector picks the input
 * field whose VALUE matches one of these — this is the ComfyUI convention
 * (file-loader nodes hold a filename string with a real extension) and
 * cleanly excludes model loaders (.safetensors / .ckpt / .pt) so they don't
 * appear as user inputs.
 */
const MEDIA_EXT_KIND: Array<{ re: RegExp; kind: InputKind }> = [
  { re: /\.(mp4|mov|webm|mkv|avi|m4v|gif)$/i, kind: 'video' },
  { re: /\.(png|jpe?g|webp|bmp|tiff?|tga|exr)$/i, kind: 'image' },
  { re: /\.(mp3|wav|aiff?|flac|m4a|ogg|opus)$/i, kind: 'audio' },
];

function inferInputFromNode(
  classType: string,
  inputs: Record<string, unknown>,
): { field: string; kind: InputKind } | null {
  // Prefer the catalogued field name when it matches a string in this node.
  // This lets known nodes (e.g. LoadImage with field "image") pick the right
  // field even when other string inputs (titles, descriptions) exist.
  const hint = INPUT_NODE_HINTS[classType];
  if (hint && typeof inputs[hint.field] === 'string') {
    const v = inputs[hint.field] as string;
    for (const { re, kind } of MEDIA_EXT_KIND) {
      if (re.test(v)) return { field: hint.field, kind };
    }
    // Catalogued field exists but is empty (no extension to infer kind).
    // Use the class_type to guess the kind so the slot still shows up.
    const fromClass = kindFromClassName(classType);
    if (fromClass) return { field: hint.field, kind: fromClass };
  }

  // Generic fallback — any class_type that looks like a loader, scan its
  // string inputs for one that has a real media extension.
  if (!/load/i.test(classType)) return null;
  for (const [field, val] of Object.entries(inputs)) {
    if (typeof val !== 'string' || !val) continue;
    for (const { re, kind } of MEDIA_EXT_KIND) {
      if (re.test(val)) return { field, kind };
    }
  }
  return null;
}

function kindFromClassName(classType: string): InputKind | null {
  if (/(video|movie|clip)/i.test(classType)) return 'video';
  if (/(image|img|mask|frame)/i.test(classType)) return 'image';
  if (/(audio|sound|wav)/i.test(classType)) return 'audio';
  return null;
}

const OUTPUT_NODES: Record<string, OutputKind> = {
  SaveImage: 'image',
  PreviewImage: 'image',
  SaveAnimatedWEBP: 'video',
  SaveAnimatedPNG: 'video',
  VHS_VideoCombine: 'video',
  SaveVideo: 'video',
  VHS_SaveAudio: 'audio',
  SaveAudio: 'audio',
};

const SEED_FIELDS: Record<string, string> = {
  KSampler: 'seed',
  KSamplerAdvanced: 'noise_seed',
  RandomNoise: 'noise_seed',
  SamplerCustom: 'noise_seed',
};

/**
 * Text fields on nodes we have no schema for.
 *
 * Only a fallback now: with `/object_info` in hand the panel reads which
 * inputs are multiline STRING and needs no catalogue at all. Kept for the
 * offline case (a provider that cannot answer, a server still starting).
 */
const STRING_SOURCE_FIELDS: Record<string, string> = {
  CLIPTextEncode: 'text',
  CLIPTextEncodeSDXL: 'text',
  T5TextEncode: 'text',
  BNK_CLIPTextEncodeAdvanced: 'text',
  PrimitiveStringMultiline: 'value',
  PrimitiveString: 'value',
  String: 'string',
  StringConstant: 'string',
  ShowText: 'text',
  EasyString: 'string_value',
  'CR Prompt Text': 'prompt',
};

/**
 * Text inputs that are never a prompt, by the name the node declares for them.
 *
 * Every one of these is a real multiline STRING in `/object_info`, so the
 * schema alone cannot tell them apart from a prompt: `ComfyMathExpression`
 * declares `expression` multiline, and `SaveVideo` declares `filename_prefix`
 * multiline. Ruling them out by name is what keeps a graph with two text
 * widgets from being ambiguous — and that exact graph is what made the panel
 * give up and bind the prompt to nothing.
 */
const NON_PROMPT_FIELD = new RegExp(
  '^(expression|formula|equation|filename_prefix|filename|file|filepath|path|url|uri'
  + '|regex|pattern|format|codec|container|color|colour|background_color|font|font_name'
  + '|font_family|delimiter|separator|code|script|command|args|tooltip|note|label|title'
  + '|suffix|prefix|extension|ext|device|dtype|precision|preset|mode|type|version'
  + '|model|model_name|lora_name|ckpt_name|vae_name|clip_name|unet_name|sampler_name'
  + '|scheduler|weight_dtype|save_path|output_path|subfolder)$',
  'i',
);

/**
 * A value that is a filename or a path rather than prose.
 *
 * Found by auditing the bindings instead of trusting them: on
 * `LTX25_ICLoRA_Motion_Track_Distilled` the walk back from the sampler landed
 * on a node holding "ltx-2.3-22b-dev.safetensors" and offered it as the prompt.
 * The field is a perfectly ordinary multiline STRING, so no rule about names
 * could catch it — the value is what gives it away. A real prompt has spaces.
 */
const LOOKS_LIKE_FILE = new RegExp(
  '^[^\\s]*\\.(safetensors|ckpt|pt|pth|bin|gguf|onnx|sft|pkl'
  + '|png|jpe?g|webp|bmp|tiff?|tga|exr|mp4|mov|webm|mkv|avi|m4v|gif'
  + '|mp3|wav|aiff?|flac|m4a|ogg|opus|json|ya?ml|csv|txt|log)$',
  'i',
);

/** Input names through which a node asks for the POSITIVE text. */
const POSITIVE_INPUT = /^(prompt|positive|positive_prompt|positive_text|text|caption|description)$/i;
/** …and for the negative one. */
const NEGATIVE_INPUT = /^(negative|negative_prompt|negative_text)$/i;

/**
 * How much a field name looks like the prompt, for ranking candidates.
 *
 * Scored on the LEAF: a dynamic combo's nested widget arrives as
 * `model.prompt`, and the parent widget's name says nothing about the meaning.
 */
function promptFieldScore(field: string): number {
  const leaf = field.includes('.') ? field.slice(field.lastIndexOf('.') + 1) : field;
  if (/^(positive|positive_prompt|prompt)$/i.test(leaf)) return 4;
  if (/^(text|text_g|text_l|string|value|string_value|caption)$/i.test(leaf)) return 3;
  if (/prompt|text/i.test(leaf)) return 2;
  return 1;
}

/** Is this input declared as a multiline STRING by the server's schema? */
function declaredTextInput(info: NodeInfo | undefined, field: string, node: ComfyNode): boolean {
  const spec = resolveInputSpec(info, field, node);
  if (!Array.isArray(spec) || spec[0] !== 'STRING') return false;
  const opts = spec[1] as { multiline?: unknown } | undefined;
  return opts?.multiline === true;
}

/**
 * The text slot this node holds, if any — the field carrying a literal string
 * a prompt could live in. Wired fields are excluded: they are produced
 * elsewhere, and the trace follows the wire to wherever that is.
 */
function textSlotOf(
  wf: WorkflowJson,
  objectInfo: ObjectInfo | null,
  nodeId: string,
): PromptSlot | null {
  const node = wf[nodeId];
  if (!node) return null;
  const title = node._meta?.title ?? node.class_type;
  const info = objectInfo?.[node.class_type];

  const candidates: Array<{ field: string; value: string }> = [];
  for (const [field, value] of Object.entries(node.inputs)) {
    if (typeof value !== 'string') continue;
    // On the leaf, so `format.codec` is ruled out by `codec`.
    if (NON_PROMPT_FIELD.test(field.includes('.') ? field.slice(field.lastIndexOf('.') + 1) : field)) continue;
    if (LOOKS_LIKE_FILE.test(value.trim())) continue;
    const accepted = info
      ? declaredTextInput(info, field, node)
      // No schema: fall back to the catalogue, then to the shape of the value.
      : (STRING_SOURCE_FIELDS[node.class_type] === field
         || value.length > 40 || value.includes('\n'));
    if (accepted) candidates.push({ field, value });
  }
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => promptFieldScore(b.field) - promptFieldScore(a.field)
    || b.value.length - a.value.length);
  const best = candidates[0];
  return { nodeId, field: best.field, title, preview: best.value };
}

/**
 * Parameter (scalar knob) nodes — class_type → { field, kind }. Detected
 * only when the node has a LITERAL value in that field (not a wire).
 */
const PARAMETER_NODES: Record<string, { field: string; kind: ParamKind }> = {
  PrimitiveInt: { field: 'value', kind: 'int' },
  PrimitiveFloat: { field: 'value', kind: 'float' },
  PrimitiveBoolean: { field: 'value', kind: 'boolean' },
  INTConstant: { field: 'value', kind: 'int' },
  FloatConstant: { field: 'value', kind: 'float' },
  BooleanConstant: { field: 'value', kind: 'boolean' },
  Boolean: { field: 'value', kind: 'boolean' },
};

const TAG_RE = /\[AE_([A-Z_]+)\]/i;

function isWire(v: unknown): v is [string, number] {
  return Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'number';
}

function detectParamRole(title: string, kind: ParamKind): ParameterRole {
  if (kind !== 'int' && kind !== 'float') return null;
  const t = title.toLowerCase();
  // Width — match "width", "w", "larghezza"; avoid "weight"
  if (/(^|[^a-z])w(idth|\b)/i.test(title) || /\blarghezza\b/i.test(t)) return 'width';
  if (/(^|[^a-z])h(eight|\b)/i.test(title) || /\baltezza\b/i.test(t)) return 'height';
  if (/\b(fps|frame\s*rate)\b/i.test(t)) return 'fps';
  if (/^length\b|length \(in seconds\)|durata|duration/i.test(t)) return 'length';
  if (/\bframes?\b|num.*frames/i.test(t)) return 'frames';
  return null;
}

function readTag(title: string): string | null {
  const m = TAG_RE.exec(title);
  if (!m) return null;
  return m[1].toLowerCase().replace(/_/g, '');
}

/**
 * Walk back from a node, hopping through any passthrough / switch nodes,
 * until we hit a node holding a literal string a prompt could live in.
 *
 * Text-carrying inputs are followed first, so a node that takes both a prompt
 * and a model does not lead the walk off into the loaders.
 */
function traceToStringSource(
  wf: WorkflowJson,
  objectInfo: ObjectInfo | null,
  startNodeId: string,
  visited: Set<string> = new Set(),
): PromptSlot | null {
  if (visited.has(startNodeId)) return null;
  visited.add(startNodeId);

  const node = wf[startNodeId];
  if (!node) return null;

  const own = textSlotOf(wf, objectInfo, startNodeId);
  if (own) return own;

  const wires = Object.entries(node.inputs).filter((e): e is [string, [string, number]] => isWire(e[1]));
  wires.sort((a, b) => promptFieldScore(b[0]) - promptFieldScore(a[0]));
  for (const [, v] of wires) {
    const next = traceToStringSource(wf, objectInfo, v[0], visited);
    if (next) return next;
  }

  return null;
}

/* ─── Inspection ────────────────────────────────────────────────────── */

export function inspectWorkflow(
  wf: WorkflowJson,
  objectInfo: ObjectInfo | null = null,
): InspectedWorkflow {
  const inputs: WorkflowInput[] = [];
  const outputs: WorkflowOutput[] = [];
  const promptCandidates: PromptSlot[] = [];
  const seedCandidates: SeedSlot[] = [];
  const parameters: ParameterSlot[] = [];

  const live = nodesFeedingOutputs(wf, objectInfo);

  let positiveHint: PromptSlot | null = null;
  let negativeHint: PromptSlot | null = null;
  let outputHintId: string | null = null;
  /** First node with both `positive` and `negative` inputs wired — sampler or guider. */
  let firstPromptHub: { id: string; positive: [string, number]; negative: [string, number] } | null = null;
  /** Nodes that ask for text through a wire — `MiniMaxH3ImageToVideo.prompt`, … */
  const positiveConsumers: Array<{ id: string; from: [string, number]; field: string }> = [];
  const negativeConsumers: Array<{ id: string; from: [string, number]; field: string }> = [];

  for (const [nodeId, node] of Object.entries(wf)) {
    const classType = node.class_type;
    const title = node._meta?.title ?? classType;
    const tag = readTag(title);

    // Inputs (file slots). Detection is shape-based: we look for a string
    // input whose value matches a real media-file extension (.mp4 / .png /
    // .wav / …). This works for any custom loader pack because it doesn't
    // rely on the field NAME being `image`/`video`/`audio` — node packs
    // freely use `file`, `filename`, `path` etc. Model-loader nodes are
    // naturally excluded because their .safetensors / .ckpt files don't
    // match any of the media-extension regexes.
    const inputSpec = inferInputFromNode(classType, node.inputs as Record<string, unknown>);
    if (inputSpec) {
      let aeHint: AeHint =
        tag === 'frame' ? 'frame'
        : tag === 'workarea' ? 'work-area'
        : inputSpec.kind === 'video' ? 'work-area'
        : inputSpec.kind === 'image' ? 'frame'
        : null;
      // Smarter defaults for image inputs based on title keywords —
      // "first frame" / "start" → frame capture; "reference" / "last frame"
      // stay as a plain image picker.
      if (inputSpec.kind === 'image' && tag === null) {
        if (/^(last frame|end frame|reference)/i.test(title)) aeHint = null;
      }
      const baked = node.inputs[inputSpec.field];
      const bakedInValue = typeof baked === 'string' && baked.length > 0 ? baked : undefined;
      inputs.push({
        nodeId, classType, title,
        kind: inputSpec.kind, field: inputSpec.field, aeHint, bakedInValue,
      });
    }

    // Outputs
    const outKind = OUTPUT_NODES[classType];
    if (outKind) {
      const preferred = tag === 'output';
      outputs.push({ nodeId, classType, title, kind: outKind, preferred });
      if (preferred) outputHintId = nodeId;
    }

    // Prompt candidates — every node holding a literal text a prompt could
    // live in, read from the schema rather than from a list of class names.
    const slot = textSlotOf(wf, objectInfo, nodeId);
    if (slot) {
      slot.live = live.has(nodeId);
      promptCandidates.push(slot);
      if (tag === 'prompt' || tag === 'positive') {
        positiveHint = { ...slot, evidence: 'the [AE_PROMPT] tag on this node' };
      }
      if (tag === 'negative') {
        negativeHint = { ...slot, evidence: 'the [AE_NEGATIVE] tag on this node' };
      }
    }

    // Nodes that ask for their text through a wire. This is what finds the
    // prompt on a graph with no sampler at all: MiniMaxH3ImageToVideo declares
    // an input called `prompt`, and whatever is wired into it IS the prompt,
    // whichever node pack happens to hold the string.
    for (const [field, value] of Object.entries(node.inputs)) {
      if (!isWire(value)) continue;
      if (POSITIVE_INPUT.test(field)) positiveConsumers.push({ id: nodeId, from: value, field });
      else if (NEGATIVE_INPUT.test(field)) negativeConsumers.push({ id: nodeId, from: value, field });
    }

    // Seed candidates
    const seedField = SEED_FIELDS[classType];
    if (seedField && typeof node.inputs[seedField] === 'number') {
      seedCandidates.push({ nodeId, field: seedField, title });
    }

    // Parameter knobs (scalar PrimitiveX / Constants)
    const paramSpec = PARAMETER_NODES[classType];
    if (paramSpec) {
      const v = node.inputs[paramSpec.field];
      const matchesKind =
        (paramSpec.kind === 'int' && typeof v === 'number') ||
        (paramSpec.kind === 'float' && typeof v === 'number') ||
        (paramSpec.kind === 'boolean' && typeof v === 'boolean') ||
        (paramSpec.kind === 'string' && typeof v === 'string');
      if (matchesKind) {
        parameters.push({
          nodeId,
          classType,
          title,
          field: paramSpec.field,
          kind: paramSpec.kind,
          currentValue: v as number | boolean | string,
          role: detectParamRole(title, paramSpec.kind),
        });
      }
    }

    // Prompt-hub detection: any node with both `positive` and `negative`
    // wired inputs is a candidate (KSampler, CFGGuider, BasicGuider, …).
    const pos = node.inputs.positive;
    const neg = node.inputs.negative;
    if (!firstPromptHub && isWire(pos) && isWire(neg)) {
      firstPromptHub = { id: nodeId, positive: pos, negative: neg };
    }
  }

  /* ─── Resolve prompt slots ───────────────────────────────────────── */

  let positive: PromptSlot | null = positiveHint;
  let negative: PromptSlot | null = negativeHint;

  // A node with both `positive` and `negative` wired says which is which, so
  // it is tried before anything that has to rank candidates.
  if (firstPromptHub && !positive) {
    const traced = traceToStringSource(wf, objectInfo, firstPromptHub.positive[0]);
    if (traced) {
      positive = { ...traced, evidence: `wired into the positive input of node ${firstPromptHub.id}` };
    }
  }
  if (firstPromptHub && !negative) {
    const traced = traceToStringSource(wf, objectInfo, firstPromptHub.negative[0]);
    if (traced) {
      negative = { ...traced, evidence: `wired into the negative input of node ${firstPromptHub.id}` };
    }
  }

  // Then whoever asks for text by name, live branches first.
  const byLive = <T extends { id: string }>(a: T, b: T): number =>
    Number(live.has(b.id)) - Number(live.has(a.id));
  if (!positive) {
    for (const c of [...positiveConsumers].sort(byLive)) {
      const traced = traceToStringSource(wf, objectInfo, c.from[0]);
      if (traced) {
        positive = { ...traced, evidence: `wired into "${c.field}" on node ${c.id} (${wf[c.id]?.class_type})` };
        break;
      }
    }
  }
  if (!negative) {
    for (const c of [...negativeConsumers].sort(byLive)) {
      const traced = traceToStringSource(wf, objectInfo, c.from[0]);
      if (traced && traced.nodeId !== positive?.nodeId) {
        negative = { ...traced, evidence: `wired into "${c.field}" on node ${c.id} (${wf[c.id]?.class_type})` };
        break;
      }
    }
  }

  // Last resort: rank the literal text slots. A live branch beats a dead one,
  // a field the node calls "prompt" beats one it calls something else, and a
  // longer default beats an empty box — in that order. This used to require
  // there to be exactly ONE text field in the whole graph, which is why a
  // workflow carrying a maths expression alongside its prompt ended up with no
  // prompt at all.
  const rankable = promptCandidates
    .filter((c) => !/neg/i.test(c.title) && !/neg/i.test(c.field))
    .sort((a, b) => Number(b.live === true) - Number(a.live === true)
      || promptFieldScore(b.field) - promptFieldScore(a.field)
      || b.preview.length - a.preview.length);
  if (!positive && rankable.length > 0) {
    positive = { ...rankable[0], evidence: 'the workflow\'s most prompt-like text field' };
  }
  if (!negative) {
    const neg = promptCandidates.find(
      (c) => (/neg/i.test(c.title) || /neg/i.test(c.field)) && c.nodeId !== positive?.nodeId,
    );
    if (neg) negative = { ...neg, evidence: 'named as the negative prompt' };
  }

  /* ─── Resolve seed ────────────────────────────────────────────────── */

  const seed: SeedSlot | null = seedCandidates[0] ?? null;

  /* ─── Primary output kind ─────────────────────────────────────────── */

  let primaryOutputKind: OutputKind = 'image';
  if (outputHintId) {
    const o = outputs.find((x) => x.nodeId === outputHintId);
    if (o) primaryOutputKind = o.kind;
  } else {
    const video = outputs.find((o) => o.kind === 'video');
    if (video) primaryOutputKind = 'video';
    else {
      const audio = outputs.find((o) => o.kind === 'audio');
      if (audio) primaryOutputKind = 'audio';
    }
  }

  return {
    inputs,
    outputs,
    positivePrompt: positive,
    negativePrompt: negative,
    seed,
    promptCandidates,
    seedCandidates,
    parameters,
    primaryOutputKind,
  };
}

/* ─── Output picker ─────────────────────────────────────────────────── */

export function pickPrimaryOutput<T extends { nodeId: string; filename: string }>(
  produced: T[],
  inspected: InspectedWorkflow,
): T | null {
  if (produced.length === 0) return null;
  const preferred = inspected.outputs.find((o) => o.preferred);
  if (preferred) {
    const match = produced.find((p) => p.nodeId === preferred.nodeId);
    if (match) return match;
  }
  const order: Record<string, number> = { video: 3, audio: 2, image: 1 };
  return [...produced].sort((a, b) => {
    const aOut = inspected.outputs.find((o) => o.nodeId === a.nodeId);
    const bOut = inspected.outputs.find((o) => o.nodeId === b.nodeId);
    const aRank = aOut ? order[aOut.kind] ?? 0 : 0;
    const bRank = bOut ? order[bOut.kind] ?? 0 : 0;
    return bRank - aRank;
  })[0];
}
