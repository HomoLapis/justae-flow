/**
 * The generation form — one description of "what does this workflow ask the
 * user for", built from whichever source knows best:
 *
 *   1. **App Mode** (`extra.linearData`) when the workflow's author configured
 *      one in ComfyUI's App Builder. That's their own arrangement, in their
 *      own order — we render it, we don't second-guess it.
 *   2. **The heuristic inspector** otherwise, so a workflow that has never
 *      been near App Builder still gets a usable panel.
 *
 * On top of that, fields whose meaning After Effects already knows — canvas
 * size, shot duration, frame rate — are filled in from the comp and marked, so
 * a clip generated between two markers comes out the right length and the
 * right size without the user retyping numbers that are already on screen.
 * The fill is a default, not a lock: every auto field can be taken over.
 */

import type { ComfyNode, NodeInfo, ObjectInfo, WorkflowJson } from '../comfy/types.ts';
import type { InspectedWorkflow } from './inspector.ts';
import type { AppModeConfig } from './appmode.ts';
import { nodesFeedingOutputs, resolveInputSpec } from './graph.ts';

export type FieldKind =
  | 'text' | 'multiline' | 'int' | 'float' | 'boolean' | 'combo'
  | 'image' | 'video' | 'audio';

/**
 * What After Effects can fill in by itself.
 *
 * `longest` / `shortest` exist because plenty of workflows never expose a
 * width and a height at all: they hand a resizer one number and a side to
 * apply it to, and the frame size follows from the source image's aspect. That
 * one number is as much "the canvas" as a width is.
 */
export type AeRole =
  | 'width' | 'height' | 'longest' | 'shortest'
  | 'seconds' | 'frames' | 'fps' | 'seed';

export interface FormField {
  /** Stable identity: `${nodeId}.${field}`. */
  id: string;
  nodeId: string;
  field: string;
  label: string;
  help?: string;
  kind: FieldKind;
  /** Value baked into the workflow — the starting point. */
  value: string | number | boolean;
  options?: string[];
  /**
   * The choices in the type the node declared, aligned with `options`.
   *
   * Combo options are labels for the UI, but a node's list can hold numbers
   * (`CreateVideo.bit_depth` is `["auto", 8, 10]`). Sending back the label
   * where the number belongs is a crash, not a coercion ComfyUI performs.
   */
  optionValues?: Array<string | number | boolean>;
  min?: number;
  max?: number;
  step?: number;
  /** Non-null when AE can supply this value from the comp/segment. */
  aeRole: AeRole | null;
  /** How that role was decided — shown on the badge, so it can be checked. */
  aeRoleEvidence?: string;
  /**
   * The lattice the value has to land on, taken from the input that CONSUMES
   * it rather than from the field itself.
   *
   * A `PrimitiveInt` wired into `WanImageToVideo.length` declares no step at
   * all — the 4n+1 rule lives on the input at the far end of the wire. Reading
   * the step off the primitive would round to nothing and the model would
   * reject the graph.
   */
  aeConstraint?: { min?: number; step?: number; max?: number };
  /** True for the field the prompt box is bound to. */
  isPrompt?: boolean;
  isNegativePrompt?: boolean;
  /**
   * Real knob, just not one you set per shot (sampler steps, checkpoint name,
   * …). Shown behind "All controls" so nothing is hidden, nothing is in
   * the way. Never set on an App Mode layout: there the author already chose.
   */
  advanced?: boolean;
  /**
   * This field's node feeds nothing the workflow outputs.
   *
   * Big workflows carry switched-off branches — an AIO file with four
   * pipelines and one live, an extension graph with later stages muted. Their
   * knobs are real controls on real nodes, and changing them does nothing at
   * all, so they are never offered up front and the panel says why when asked.
   */
  inactive?: boolean;
  origin: 'appmode' | 'inspector';
}

export interface WorkflowForm {
  fields: FormField[];
  /** Which source produced the layout. */
  source: 'appmode' | 'inspector';
  /** App Mode entries that could not be mapped onto the API graph. */
  unmapped: string[];
  /** Output nodes the author chose to surface, if they said. */
  preferredOutputs: string[];
  /** What After Effects could and could not take over — see {@link AeCoverage}. */
  aeCoverage: AeCoverage;
}

/**
 * What the comp is actually able to drive in this workflow.
 *
 * Reported rather than assumed. A clip that comes out 1080 wide in a 1920 comp,
 * or five seconds long in an eight-second slot, is not a rendering artefact —
 * it is the panel having found nothing to write the number into. That has to be
 * visible on the shot row BEFORE the render, which is the whole point of
 * keeping this alongside the fields.
 */
export interface AeCoverage {
  /** The workflow decides a frame size, and nothing here can set it. */
  sizeUnbound: boolean;
  /** The workflow decides a clip length, and nothing here can set it. */
  lengthUnbound: boolean;
  /** Knobs left alone because two different roles landed on the same one. */
  conflicts: string[];
}

/* ─── Context After Effects contributes ─────────────────────────────── */

export interface AeContext {
  width?: number;
  height?: number;
  /** Shot length in seconds — from the marker pair or the placeholder layer. */
  seconds?: number;
  fps?: number;
  /**
   * Draft renders: cap the long side of the canvas AE supplies, keeping its
   * proportions (then the usual snap to 32). Undefined = full size.
   */
  maxLongSide?: number;
}

/* ─── Field construction ────────────────────────────────────────────── */

const MEDIA_EXT = {
  image: /\.(png|jpe?g|webp|bmp|tiff?|tga|exr)$/i,
  video: /\.(mp4|mov|webm|mkv|avi|m4v|gif)$/i,
  audio: /\.(mp3|wav|aiff?|flac|m4a|ogg|opus)$/i,
};

function specFor(info: NodeInfo | undefined, field: string, node?: ComfyNode): unknown[] | null {
  return resolveInputSpec(info, field, node);
}

/** Media kind implied by a combo of filenames (LoadImage, VHS_LoadVideo, …). */
function mediaKindOfOptions(options: string[]): FieldKind | null {
  const sample = options.slice(0, 24);
  if (sample.length === 0) return null;
  for (const [kind, re] of Object.entries(MEDIA_EXT) as Array<[FieldKind, RegExp]>) {
    if (sample.some((o) => re.test(o))) return kind;
  }
  return null;
}

/** Media kind implied by the value already baked into the workflow. */
function mediaKindOfValue(value: unknown): FieldKind | null {
  if (typeof value !== 'string') return null;
  for (const [kind, re] of Object.entries(MEDIA_EXT) as Array<[FieldKind, RegExp]>) {
    if (re.test(value)) return kind;
  }
  return null;
}

interface KindResult {
  kind: FieldKind;
  options?: string[];
  optionValues?: Array<string | number | boolean>;
  min?: number;
  max?: number;
  step?: number;
  /** The schema's own default — what the node is built around. */
  default?: unknown;
}

function inferKind(
  classType: string,
  field: string,
  value: unknown,
  info: NodeInfo | undefined,
  node?: ComfyNode,
): KindResult {
  const spec = specFor(info, field, node);
  const type = spec?.[0];
  const opts = (spec?.[1] ?? {}) as Record<string, unknown>;

  /*
   * Combo — an inline list of choices, COMBO with options in opts, or the
   * newer dynamic combo whose options are objects keyed by `key`.
   *
   * A combo's choices are not always strings. `CreateVideo.bit_depth` offers
   * `["auto", 8, 10]`, and dropping the two numbers left a one-entry dropdown
   * the user could not change; worse, the untouched value 8 came back out of
   * the form as the string "8" and ComfyUI crashed inside SaveVideo on
   * `bit_depth >= 10` — a TypeError, after the whole video had rendered. So
   * the raw choices are kept alongside their labels, and the value the user
   * picks is handed back in the type the node declared.
   */
  if (Array.isArray(type) || type === 'COMBO'
      || (typeof type === 'string' && type.startsWith('COMFY_DYNAMICCOMBO'))) {
    const rawOptions = Array.isArray(type) ? type : (opts.options as unknown[]) ?? [];
    const pairs = rawOptions
      .map((o): [string, string | number | boolean] | null => {
        if (typeof o === 'string' || typeof o === 'number' || typeof o === 'boolean') {
          return [String(o), o];
        }
        if (o && typeof o === 'object' && typeof (o as { key?: unknown }).key === 'string') {
          return [(o as { key: string }).key, (o as { key: string }).key];
        }
        return null;
      })
      .filter((p): p is [string, string | number | boolean] => p !== null);
    const options = pairs.map((p) => p[0]);
    const optionValues = pairs.map((p) => p[1]);
    const media = mediaKindOfOptions(options) ?? mediaKindOfValue(value);
    if (media) return { kind: media, options, optionValues };
    return { kind: 'combo', options, optionValues };
  }
  if (type === 'BOOLEAN') return { kind: 'boolean' };
  if (type === 'INT' || type === 'FLOAT') {
    return {
      kind: type === 'INT' ? 'int' : 'float',
      min: typeof opts.min === 'number' ? opts.min : undefined,
      max: typeof opts.max === 'number' ? opts.max : undefined,
      step: typeof opts.step === 'number' ? opts.step : undefined,
      default: opts.default,
    };
  }
  if (type === 'STRING') {
    return { kind: opts.multiline === true ? 'multiline' : 'text' };
  }

  // No schema (offline, or a custom node we can't see): fall back to the
  // shape of the value that's already in the file.
  const media = mediaKindOfValue(value);
  if (media) return { kind: media };
  if (typeof value === 'boolean') return { kind: 'boolean' };
  if (typeof value === 'number') return { kind: Number.isInteger(value) ? 'int' : 'float' };
  if (typeof value === 'string') {
    const looksLikeProse = value.length > 60 || value.includes('\n');
    return { kind: looksLikeProse || /prompt|text|description/i.test(field) ? 'multiline' : 'text' };
  }
  void classType;
  return { kind: 'text' };
}

/**
 * Which AE-known quantity a field stands for.
 *
 * This runs on whole-graph sweeps, so it has to be strict: a false positive
 * silently rewrites someone's render. Two real cases from the test corpus that
 * a looser rule got wrong — `ImageStitch.spacing_width` read as the canvas
 * width, and a float titled "FIRST FRAME STRENGTH" read as a frame count.
 *
 * The harder call is `length`, because it means different things in different
 * node families and both are common:
 *
 *   WanImageToVideo.length        default 81, step 4   → FRAMES
 *   EmptyLTXVLatentVideo.length   default 97, step 8   → FRAMES
 *   a Primitive titled "LENGTH (in seconds)"           → SECONDS
 *
 * Guessing wrong is not a rounding error: writing "4" into a frame count
 * produces a quarter-second clip where four seconds were asked for. So the
 * unit is read from the schema — a knob whose default is 81 and whose step is
 * 4 is counting frames, whatever it's called — and only falls back to the
 * wording when there's no schema to read.
 */

/** Fields named generically (`value` on a Primitive node) carry meaning in the title instead. */
const GENERIC_FIELD = /^(value|number|int|float|x|a)$/i;

/** Explicit units in a label settle the question outright. */
const SAYS_SECONDS = new RegExp('\\bsec(onds?|ondi)?\\b');
const SAYS_FRAMES = new RegExp('\\bframes?\\b');

/** Words that make a "width"/"frames"-looking name mean something else. */
const DISQUALIFY = new RegExp('\\b(strength|weight|scale|denoise|cfg|steps?|index|offset|percent|ratio|blend|overlap' + '|spacing|padding|batch|crop|pad|margin|border|shift|start|end|skip|stride|min|max' + '|guidance|noise|temperature)\\b',);

const EXACT: Array<{ role: AeRole; names: RegExp; kinds?: FieldKind[]; needsVideoNode?: boolean }> = [
  { role: 'seed', names: /^(seed|noise seed|random seed)$/ },
  { role: 'width', names: /^(width|w|larghezza|canvas width|image width|video width)$/ },
  { role: 'height', names: /^(height|h|altezza|canvas height|image height|video height)$/ },
  { role: 'fps', names: /^(fps|frame rate|framerate|frames per second)$/ },
  {
    role: 'frames',
    names: /^(frames|num frames|number of frames|frame count|length in frames|video frames|video length frames|total frames)$/,
    kinds: ['int'],
  },
  {
    role: 'seconds',
    names: /^(duration|seconds|length in seconds|length seconds|duration seconds|durata|video length|clip length)$/,
  },
  // Bare "length": the unit comes from the schema, resolved below, and only on
  // a node that makes video — `ImageFromBatch.length` is not a clip length.
  { role: 'seconds', names: /^(length)$/, needsVideoNode: true },
];

function normaliseName(s: string): string {
  return s
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Does this integer knob count frames rather than seconds?
 *
 * A seconds knob is a small number and moves in ones; a frame count starts in
 * the dozens and moves in fours or eights because the model's temporal
 * compression demands it. Both facts are in `/object_info`.
 */
function looksLikeFrameCount(
  kind: FieldKind,
  schema: { value?: unknown; def?: unknown; step?: number; max?: number } | undefined,
): boolean {
  if (kind !== 'int' || !schema) return false;

  // A step above 1 settles it. Video models accept only every 4th or 8th frame
  // because of how they compress time, and `/object_info` states that as the
  // step. Nothing measured in seconds moves in fours.
  if ((schema.step ?? 1) > 1) return true;

  // Otherwise judge by what the node is built around — its schema DEFAULT, not
  // whatever number happens to sit in this particular file. Reading the file's
  // value was the bug: the same node came out "frames" in one workflow and
  // "seconds" in another purely because someone had typed a small number.
  const n = typeof schema.def === 'number' ? schema.def
    : typeof schema.value === 'number' ? schema.value : NaN;
  return Number.isFinite(n) && n >= 24 && (schema.max ?? 0) > 1000;
}

/**
 * Node classes that actually decide how long a clip is — the ones that create
 * video or a video latent. A bare `length` anywhere else is something else:
 * `ImageFromBatch.length` slices frames out of an existing batch, and driving
 * it from the shot duration would quietly break the graph.
 */
const MAKES_VIDEO = /(latent.*video|video.*latent|to_?video|tovideo|t2v|i2v|wan|ltx|hunyuan|mochi|cosmos|animate|svd)/i;

export function detectAeRole(
  field: string,
  title: string,
  kind: FieldKind,
  schema?: { value?: unknown; def?: unknown; step?: number; max?: number },
  classType?: string,
): AeRole | null {
  if (kind !== 'int' && kind !== 'float') return null;

  // A dynamic combo's nested widget is named `model.duration` in the API graph.
  // The parent is the combo, not part of the meaning — the leaf is the field.
  const leaf = field.includes('.') ? field.slice(field.lastIndexOf('.') + 1) : field;

  // Primitive/constant nodes name every field `value`; the title is the label.
  const raw = GENERIC_FIELD.test(leaf) ? title : leaf;
  const candidates = [normaliseName(raw)];
  const inlined = raw.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (inlined !== candidates[0]) candidates.push(inlined);

  // An explicit unit in the wording always wins — "LENGTH (in seconds)" is not
  // a guess, it's a statement.
  const saysSeconds = candidates.some((c) => SAYS_SECONDS.test(c));
  const saysFrames = candidates.some((c) => SAYS_FRAMES.test(c));

  for (const name of candidates) {
    if (DISQUALIFY.test(name)) return null;
  }
  for (const rule of EXACT) {
    if (rule.kinds && !rule.kinds.includes(kind)) continue;
    if (!candidates.some((c) => rule.names.test(c))) continue;
    if (rule.role === 'seconds') {
      if (saysSeconds) return 'seconds';
      if (saysFrames) return 'frames';
      if (looksLikeFrameCount(kind, schema)) return 'frames';
      // A bare `length` with nothing to go on: only claim it when the node is
      // one that produces video, or when it's a knob the workflow's author
      // labelled themselves (a Primitive titled "Length"). Filling the wrong
      // field silently changes someone's render; leaving it alone just means
      // typing a number. A field the node actually calls `duration` needs no
      // such hedge — that word means one thing.
      const authored = GENERIC_FIELD.test(leaf);
      if (rule.needsVideoNode && !authored && classType && !MAKES_VIDEO.test(classType)) return null;
      return 'seconds';
    }
    return rule.role;
  }
  return null;
}

/* ─── Following the wire back to the knob ───────────────────────────── */

/**
 * The role a field has is often decided somewhere else entirely.
 *
 * `detectAeRole` above reads one field at a time and asks what its NAME means.
 * That works when the number sits on the node that uses it, and fails
 * completely on the shape most real workflows take, where the video node's
 * `width`, `height` and `length` are all wired and the actual knobs are bare
 * primitives with titles like "PrimitiveInt" — names that mean nothing.
 *
 * Measured on the workflow this was reported against: `MiniMaxH3ImageToVideo`
 * has width, height and length all wired, so the panel found no size field and
 * no length field, filled in nothing, and generated a 1080-wide five-second
 * clip into a 1920-wide eight-second slot. Nothing looked broken.
 *
 * So the roles are resolved from the CONSUMER end, which is where the meaning
 * is: ComfyUI's own schema says that input is called `width`, and the wire says
 * which knob feeds it. Three shapes are followed, and anything else is left
 * alone and reported rather than guessed at:
 *
 *   1. a primitive / constant holding one number     → that is the knob
 *   2. a reroute or other pure passthrough           → keep walking
 *   3. a resizer that takes one length and a side    → the knob is that side
 *      ("scale to longest = 1080" is the frame size, stated differently)
 */

/** Tags the author can put in a node title to settle it outright. */
const AE_ROLE_TAG = /\[AE_(WIDTH|HEIGHT|LONGEST|SHORTEST|SECONDS|DURATION|FRAMES|LENGTH|FPS|SEED)\]/i;

/** Input names a node uses to ask for a frame dimension or a clip length. */
const CONSUMER_WIDTH = /^(width|w|target_width|image_width|video_width)$/i;
const CONSUMER_HEIGHT = /^(height|h|target_height|image_height|video_height)$/i;
const CONSUMER_FPS = /^(fps|frame_rate|framerate|frames_per_second|frame_rate_fps)$/i;
const CONSUMER_LENGTH =
  /^(length|num_frames|number_of_frames|frames|video_frames|frame_count|total_frames|video_length)$/i;

/** A resizer states which side its length applies to, in its own words. */
const SIDE_WORDS: Record<string, AeRole> = {
  longest: 'longest',
  shortest: 'shortest',
  width: 'width',
  height: 'height',
};
/** …and holds that length in an input named something like this. */
const SIDE_LENGTH_FIELD = /(scale_to_length|_length$|^length$|size|resolution|side)/i;

function isWire(v: unknown): v is [string, number] {
  return Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'number';
}

function schemaOf(info: NodeInfo | undefined, field: string, node?: ComfyNode): Record<string, unknown> {
  const spec = specFor(info, field, node);
  return (spec?.[1] ?? {}) as Record<string, unknown>;
}

interface RoleClaim {
  role: AeRole;
  evidence: string;
  constraint?: { min?: number; step?: number; max?: number };
}

/**
 * Walk back from a wired input to the single literal number that decides it.
 * Returns null — rather than a guess — as soon as the chain forks or lands on
 * a node that computes rather than carries.
 */
function traceToKnob(
  api: WorkflowJson,
  objectInfo: ObjectInfo | null,
  from: [string, number],
  claim: RoleClaim,
  seen: Set<string>,
): { fieldId: string; claim: RoleClaim } | null {
  const [nodeId, slot] = from;
  if (seen.has(nodeId)) return null;
  seen.add(nodeId);

  const node = api[nodeId];
  if (!node) return null;

  const info = objectInfo?.[node.class_type];
  const entries = Object.entries(node.inputs);
  const numbers = entries.filter(([, v]) => typeof v === 'number');
  const wires = entries.filter((e): e is [string, [string, number]] => isWire(e[1]));
  const others = entries.filter(([, v]) => typeof v !== 'number' && !isWire(v));
  /**
   * One declared output means the node carries a value; several mean it
   * derives them.
   *
   * This is the test that stops the walk at a calculator, and it was found by
   * running the probe rather than by reasoning: `ComfyMathExpression` takes one
   * wire and holds no numbers, which looked exactly like a reroute. The walk
   * went straight through it and claimed the SECONDS knob on the far side as a
   * frame count — an eight-second slot would have asked for 4608 frames. It
   * declares FLOAT, INT and BOOL; a reroute declares one thing. Holding a
   * literal of any other type (that node's `expression`) rules it out too.
   */
  const carries = !info || (info.output?.length ?? 1) === 1;

  // 1. A primitive / constant: one number and nothing else at all.
  if (numbers.length === 1 && wires.length === 0 && others.length === 0 && carries) {
    return { fieldId: `${nodeId}.${numbers[0][0]}`, claim };
  }

  // 2. A pure passthrough — a reroute: one wire in, nothing of its own.
  if (numbers.length === 0 && others.length === 0 && wires.length === 1 && carries) {
    return traceToKnob(api, objectInfo, wires[0][1], claim, seen);
  }

  // 3. A resizer. The node itself declares this output to be a width or a
  //    height, and it holds a plain-language statement of which side its
  //    length input refers to. That statement is what turns a lone "1080" into
  //    "the longest side of the frame" — read off the node, not inferred.
  const outName = info?.output_name?.[slot];
  if ((claim.role === 'width' || claim.role === 'height')
      && (outName === 'width' || outName === 'height')) {
    let side: AeRole | null = null;
    for (const [, v] of Object.entries(node.inputs)) {
      if (typeof v !== 'string') continue;
      const mapped = SIDE_WORDS[v.toLowerCase()];
      if (mapped) { side = mapped; break; }
    }
    const lengthEntries = Object.entries(node.inputs).filter(
      ([k, v]) => SIDE_LENGTH_FIELD.test(k) && (typeof v === 'number' || isWire(v)),
    );
    if (side && lengthEntries.length === 1) {
      const [field, value] = lengthEntries[0];
      const next: RoleClaim = {
        role: side,
        evidence: `${node.class_type} scales to its ${side} side, and this is that length`,
        constraint: numericConstraint(schemaOf(info, field, node)),
      };
      if (typeof value === 'number') return { fieldId: `${nodeId}.${field}`, claim: next };
      if (isWire(value)) return traceToKnob(api, objectInfo, value, next, seen);
    }
  }

  return null;
}

function numericConstraint(opts: Record<string, unknown>): { min?: number; step?: number; max?: number } {
  return {
    min: typeof opts.min === 'number' ? opts.min : undefined,
    step: typeof opts.step === 'number' ? opts.step : undefined,
    max: typeof opts.max === 'number' ? opts.max : undefined,
  };
}

/**
 * The role an author's own title states.
 *
 * Only consulted for fields the node names generically (`value` on a
 * primitive), where the title IS the label — and matched anywhere in the
 * string rather than against the whole of it, because "Float (duration)" is a
 * person saying "duration" and the anchored rule read it as "float".
 */
function roleFromAuthoredTitle(
  title: string,
  kind: FieldKind,
  schema: { def?: unknown; value?: unknown; step?: number; max?: number },
): AeRole | null {
  const t = title.toLowerCase();
  if (DISQUALIFY.test(t)) return null;
  if (/\b(longest|long side|lato lungo)\b/.test(t)) return 'longest';
  if (/\b(shortest|short side|lato corto)\b/.test(t)) return 'shortest';
  if (/(^|[^a-z])w(idth|\b)/.test(t) || /\blarghezza\b/.test(t)) return 'width';
  if (/(^|[^a-z])h(eight|\b)/.test(t) || /\baltezza\b/.test(t)) return 'height';
  if (/\b(fps|frame\s*rate|framerate)\b/.test(t)) return 'fps';
  if (/\bframes?\b/.test(t)) return 'frames';
  if (/\b(duration|durata|seconds|secondi|length|lunghezza)\b/.test(t)) {
    if (/\bsec(onds?|ondi)?\b/.test(t)) return 'seconds';
    return looksLikeFrameCount(kind, schema) ? 'frames' : 'seconds';
  }
  return null;
}

/** Which unit an `[AE_LENGTH]` tag means, read off the schema. */
function tagRole(
  word: string,
  kind: FieldKind,
  schema: { def?: unknown; value?: unknown; step?: number; max?: number },
): AeRole {
  const w = word.toUpperCase();
  if (w === 'DURATION' || w === 'SECONDS') return 'seconds';
  if (w === 'FRAMES') return 'frames';
  if (w === 'LENGTH') return looksLikeFrameCount(kind, schema) ? 'frames' : 'seconds';
  return w.toLowerCase() as AeRole;
}

export interface ResolvedRoles {
  claims: Map<string, RoleClaim>;
  coverage: AeCoverage;
}

/**
 * Work out, for the whole graph at once, which knob After Effects drives.
 *
 * Priority, strongest first, because a weaker rule must never overwrite a
 * stronger one: an `[AE_*]` tag is the author speaking, a wire is the graph
 * itself speaking, a title is the author speaking less precisely, and a bare
 * field name is us guessing.
 */
export function resolveAeRoles(
  api: WorkflowJson,
  objectInfo: ObjectInfo | null,
  fields: FormField[],
): ResolvedRoles {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const claims = new Map<string, RoleClaim>();
  const rank: Record<string, number> = { tag: 4, wire: 3, title: 2, name: 1 };
  const strength = new Map<string, number>();
  const conflicts = new Set<string>();

  const put = (fieldId: string, claim: RoleClaim, level: keyof typeof rank): void => {
    if (!byId.has(fieldId)) return;
    const existing = claims.get(fieldId);
    const existingLevel = strength.get(fieldId) ?? 0;
    if (existing && existing.role !== claim.role) {
      // Two roles on one knob is not a tie to break — 1920 and 1080 cannot
      // both be written into the same number. Same level means neither wins.
      if (rank[level] === existingLevel) {
        claims.delete(fieldId);
        strength.set(fieldId, 99);   // and nothing weaker may claim it later
        conflicts.add(byId.get(fieldId)?.label ?? fieldId);
        return;
      }
    }
    if (rank[level] <= existingLevel) return;
    claims.set(fieldId, claim);
    strength.set(fieldId, rank[level]);
  };

  const live = nodesFeedingOutputs(api, objectInfo);
  let wantsSize = false;
  let wantsLength = false;

  /* 1. Tags in node titles. */
  for (const [nodeId, node] of Object.entries(api)) {
    const m = AE_ROLE_TAG.exec(node._meta?.title ?? '');
    if (!m) continue;
    const numeric = fields.filter((f) => f.nodeId === nodeId && (f.kind === 'int' || f.kind === 'float'));
    // A tag names the node, so it needs exactly one number to land on — or a
    // field whose own name already matches the tag, on a node with several.
    const named = numeric.find((f) => new RegExp(`^${m[1]}$`, 'i').test(f.field));
    const target = named ?? (numeric.length === 1 ? numeric[0] : undefined);
    if (!target) continue;
    put(
      target.id,
      {
        role: tagRole(m[1], target.kind, { def: target.value, step: target.step, max: target.max }),
        evidence: `the ${m[0]} tag on "${node._meta?.title}"`,
      },
      'tag',
    );
  }

  /* 2. Wires, read from the input names the consuming node declares. */
  for (const [nodeId, node] of Object.entries(api)) {
    if (!live.has(nodeId)) continue;
    const info = objectInfo?.[node.class_type];
    for (const [field, value] of Object.entries(node.inputs)) {
      let role: AeRole | null = null;
      if (CONSUMER_WIDTH.test(field)) role = 'width';
      else if (CONSUMER_HEIGHT.test(field)) role = 'height';
      else if (CONSUMER_FPS.test(field)) role = 'fps';
      else if (CONSUMER_LENGTH.test(field)) {
        const opts = schemaOf(info, field, node);
        // A bare `length` means frames on a video node and something else
        // anywhere else — the same call `detectAeRole` makes, made here from
        // the consumer's side. A declared step above 1 settles it outright.
        const stride = typeof opts.step === 'number' ? opts.step : 1;
        if (stride > 1 || MAKES_VIDEO.test(node.class_type)) role = 'frames';
      }
      if (!role) continue;

      if (role === 'width' || role === 'height') wantsSize = true;
      if (role === 'frames') wantsLength = true;

      if (!isWire(value)) continue;   // a literal here is handled by rule 4
      const opts = schemaOf(info, field, node);
      const hit = traceToKnob(api, objectInfo, value, {
        role,
        evidence: `wired into "${field}" on node ${nodeId} (${node.class_type})`,
        constraint: numericConstraint(opts),
      }, new Set());
      if (hit) put(hit.fieldId, hit.claim, 'wire');
    }
  }

  /* 3. The author's own title, for fields the node names generically. */
  for (const f of fields) {
    if (!GENERIC_FIELD.test(f.field)) continue;
    if (f.kind !== 'int' && f.kind !== 'float') continue;
    const title = api[f.nodeId]?._meta?.title;
    if (!title) continue;
    const role = roleFromAuthoredTitle(title, f.kind, { value: f.value, step: f.step, max: f.max });
    if (role) put(f.id, { role, evidence: `the node's own title, "${title}"` }, 'title');
  }

  /* 4. Whatever the strict per-field rule already found. */
  for (const f of fields) {
    if (!f.aeRole) continue;
    put(f.id, { role: f.aeRole, evidence: `the field is called "${f.field}"` }, 'name');
  }

  const bound = new Set([...claims.values()].map((c) => c.role));
  const hasSize = bound.has('width') || bound.has('height') || bound.has('longest') || bound.has('shortest');
  const hasLength = bound.has('frames') || bound.has('seconds');

  return {
    claims,
    coverage: {
      sizeUnbound: wantsSize && !hasSize,
      lengthUnbound: wantsLength && !hasLength,
      conflicts: [...conflicts],
    },
  };
}

function buildField(args: {
  api: WorkflowJson;
  objectInfo: ObjectInfo | null;
  nodeId: string;
  field: string;
  label?: string;
  help?: string;
  origin: 'appmode' | 'inspector';
}): FormField | null {
  const { api, objectInfo, nodeId, field, origin } = args;
  const node = api[nodeId];
  if (!node) return null;
  const value = node.inputs[field];
  // Wired inputs are produced by another node — not something to type into.
  if (Array.isArray(value)) return null;
  if (value === undefined) return null;

  const info = objectInfo?.[node.class_type];
  const title = node._meta?.title ?? node.class_type;
  const k = inferKind(node.class_type, field, value, info, node);

  return {
    id: `${nodeId}.${field}`,
    nodeId,
    field,
    label: args.label ?? `${title} · ${field.replace(/_/g, ' ')}`,
    help: args.help,
    kind: k.kind,
    value: value as string | number | boolean,
    options: k.options,
    optionValues: k.optionValues,
    min: k.min,
    max: k.max,
    step: k.step,
    aeRole: detectAeRole(
      field, title, k.kind,
      { value, def: k.default, step: k.step, max: k.max },
      node.class_type,
    ),
    origin,
  };
}

/* ─── Assembly ──────────────────────────────────────────────────────── */

export function buildForm(args: {
  api: WorkflowJson;
  objectInfo: ObjectInfo | null;
  appMode: AppModeConfig | null;
  inspected: InspectedWorkflow;
}): WorkflowForm {
  const { api, objectInfo, appMode, inspected } = args;

  if (appMode && appMode.inputs.length > 0) {
    const fields = appMode.inputs
      .map((i) => buildField({
        api, objectInfo, nodeId: i.nodeId, field: i.field,
        label: i.label, help: i.description, origin: 'appmode',
      }))
      .filter((f): f is FormField => f !== null);

    // The author's own order decides the layout; we only tag which field the
    // prompt box drives so the assistant and per-shot prompts have a target.
    markPrompts(fields, inspected);
    return {
      fields,
      source: 'appmode',
      unmapped: appMode.unmapped,
      preferredOutputs: appMode.outputs,
      aeCoverage: applyAeRoles(api, objectInfo, fields),
    };
  }

  const built = buildFromInspection(api, objectInfo, inspected);
  return {
    fields: built.fields,
    source: 'inspector',
    unmapped: [],
    preferredOutputs: inspected.outputs.filter((o) => o.preferred).map((o) => o.nodeId),
    aeCoverage: built.coverage,
  };
}

/**
 * Settle every field's AE role against the whole graph, in place.
 *
 * Run BEFORE the fields are ranked: the ranking reads `aeRole` to decide what
 * belongs up front, and a knob the comp drives belongs there whether its own
 * name gave it away or a wire did.
 */
function applyAeRoles(
  api: WorkflowJson,
  objectInfo: ObjectInfo | null,
  fields: FormField[],
): AeCoverage {
  const { claims, coverage } = resolveAeRoles(api, objectInfo, fields);
  for (const f of fields) {
    const claim = claims.get(f.id);
    f.aeRole = claim?.role ?? null;
    f.aeRoleEvidence = claim?.evidence;
    f.aeConstraint = claim?.constraint;
  }
  return coverage;
}

/**
 * The fallback layout, for a workflow whose author never opened App Builder.
 *
 * It sweeps every literal value in the graph — not just the tidy
 * `PrimitiveInt`-style knobs — because that's where the numbers that matter
 * actually live: a `LTXVBaseSampler`'s width/height, an `EmptyLatentVideo`'s
 * length. Those are exactly the fields After Effects fills in, and missing
 * them would mean generating 512×512 clips for a 4K comp.
 *
 * The order is how a shot is set up: prompt, the files it needs, what AE
 * drives, the exposed knobs, the seed — and everything else folded into
 * "All controls" rather than dropped.
 */
function buildFromInspection(
  api: WorkflowJson,
  objectInfo: ObjectInfo | null,
  inspected: InspectedWorkflow,
): { fields: FormField[]; coverage: AeCoverage } {
  const collected = new Map<string, FormField>();

  // Sweep the whole graph first, then order what we found.
  for (const [nodeId, node] of Object.entries(api)) {
    for (const field of Object.keys(node.inputs)) {
      const f = buildField({ api, objectInfo, nodeId, field, origin: 'inspector' });
      if (f) collected.set(f.id, f);
    }
  }

  const label = (nodeId: string, field: string, title: string): void => {
    const f = collected.get(`${nodeId}.${field}`);
    if (f) f.label = title;
  };
  if (inspected.positivePrompt) {
    label(inspected.positivePrompt.nodeId, inspected.positivePrompt.field, inspected.positivePrompt.title);
  }
  if (inspected.negativePrompt) {
    label(inspected.negativePrompt.nodeId, inspected.negativePrompt.field, inspected.negativePrompt.title);
  }
  for (const i of inspected.inputs) label(i.nodeId, i.field, i.title);
  for (const p of inspected.parameters) label(p.nodeId, p.field, p.title);

  const fields = [...collected.values()];
  markPrompts(fields, inspected);
  // Before the ranking, which reads the roles it settles.
  const coverage = applyAeRoles(api, objectInfo, fields);

  const fileInputs = new Set(inspected.inputs.map((i) => `${i.nodeId}.${i.field}`));
  const primitives = new Set(inspected.parameters.map((p) => `${p.nodeId}.${p.field}`));
  const seedId = inspected.seed ? `${inspected.seed.nodeId}.${inspected.seed.field}` : null;

  /*
   * Knobs on a branch that produces nothing are not knobs.
   *
   * The inspector sweeps the whole graph, and on the big files most of the
   * graph is switched off: alternative pipelines, muted extension stages,
   * half-finished experiments parked to one side. Their widgets looked exactly
   * like the live ones, so a prompt or a seed found there could be ranked
   * straight to the top of the form — where changing it does nothing and there
   * is no way to tell. Reachability from the output nodes is what separates
   * them, and it is the same rule ComfyUI executes by.
   */
  const live = nodesFeedingOutputs(api, objectInfo);
  for (const f of fields) f.inactive = !live.has(f.nodeId);

  const rank = (f: FormField): number => {
    if (f.inactive) return 7;
    if (f.isPrompt) return 0;
    if (f.isNegativePrompt) return 1;
    if (fileInputs.has(f.id) || f.kind === 'image' || f.kind === 'video' || f.kind === 'audio') return 2;
    if (f.aeRole && f.aeRole !== 'seed') return 3;
    if (primitives.has(f.id)) return 4;
    if (f.id === seedId || f.aeRole === 'seed') return 5;
    return 6;
  };

  for (const f of fields) {
    f.advanced = rank(f) >= 6;
  }
  fields.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
  return { fields, coverage };
}

function markPrompts(fields: FormField[], inspected: InspectedWorkflow): void {
  const pos = inspected.positivePrompt;
  const neg = inspected.negativePrompt;
  for (const f of fields) {
    if (pos && f.nodeId === pos.nodeId && f.field === pos.field) f.isPrompt = true;
    if (neg && f.nodeId === neg.nodeId && f.field === neg.field) f.isNegativePrompt = true;
  }
  // App Mode layouts that expose exactly one long-text field and no detected
  // prompt slot: that field IS the prompt.
  if (!fields.some((f) => f.isPrompt)) {
    const texts = fields.filter((f) => f.kind === 'multiline');
    if (texts.length === 1) texts[0].isPrompt = true;
  }
}

/* ─── Where the prompt goes ─────────────────────────────────────────── */

/**
 * The field the shot's prompt is written into.
 *
 * `override` is the user's own answer, kept per workflow. It exists because
 * "which of these text boxes is the prompt" is a reading of somebody else's
 * graph, and a reading can be wrong — on a workflow with two prompts, or one
 * whose author wired things in a way nobody anticipated. Being able to point
 * at the right one takes a second; discovering after a render that the prompt
 * went nowhere does not.
 */
export function promptFieldOf(form: WorkflowForm, override?: string): FormField | null {
  if (override) {
    const chosen = form.fields.find((f) => f.id === override);
    if (chosen) return chosen;
  }
  return form.fields.find((f) => f.isPrompt) ?? null;
}

/** Every text box the prompt could plausibly go into, best guess first. */
export function promptFieldChoices(form: WorkflowForm): FormField[] {
  return form.fields
    .filter((f) => f.kind === 'multiline' || f.kind === 'text')
    .sort((a, b) => Number(b.isPrompt === true) - Number(a.isPrompt === true)
      || Number(a.inactive === true) - Number(b.inactive === true)
      || a.label.localeCompare(b.label));
}

/* ─── After Effects auto-fill ───────────────────────────────────────── */

export interface AutoFill {
  /** Field id → the value AE derived. */
  values: Record<string, number>;
  /** Field id → why, for the badge tooltip. */
  reasons: Record<string, string>;
}

/**
 * Compute what AE would put in each auto-fillable field.
 *
 * Dimensions snap to a multiple of 32 — the latent stride nearly every
 * diffusion model needs. A comp of 1920×1080 therefore asks for 1920×1088,
 * which is a real change to what gets generated, so the badge says so instead
 * of quietly rounding.
 */
export function computeAutoFill(fields: FormField[], ctx: AeContext): AutoFill {
  const values: Record<string, number> = {};
  const reasons: Record<string, string> = {};

  /**
   * The rate used to turn seconds into frames is the WORKFLOW's, not the
   * comp's — and the workflow's fps field is deliberately left alone.
   *
   * Overwriting it with the comp's rate looks harmless and isn't: a model
   * trained at 24 fps, muxed at 30, plays 25% fast. The motion changes, which
   * is not something to do to someone's shot without asking. Converting with
   * the workflow's own rate instead gives a clip whose duration still matches
   * the slot exactly — 96 frames at 24 fps is four seconds — and After Effects
   * conforms the footage on import as it does for any other clip.
   */
  const fpsField = fields.find((f) => f.aeRole === 'fps');
  const workflowFps = typeof fpsField?.value === 'number' && fpsField.value > 0
    ? fpsField.value
    : null;
  const fps = workflowFps ?? (ctx.fps && ctx.fps > 0 ? ctx.fps : 24);

  // Draft: the comp scaled down so its long side is maxLongSide, said on the badge.
  if (ctx.maxLongSide && ctx.width && ctx.height && Math.max(ctx.width, ctx.height) > ctx.maxLongSide) {
    const k = ctx.maxLongSide / Math.max(ctx.width, ctx.height);
    const draftNote = ` (draft: comp ${ctx.width}×${ctx.height} scaled to a ${ctx.maxLongSide} px long side)`;
    const scaled: AeContext = { ...ctx, width: Math.round(ctx.width * k), height: Math.round(ctx.height * k), maxLongSide: undefined };
    const inner = computeAutoFill(fields, scaled);
    for (const id of Object.keys(inner.reasons)) {
      const f = fields.find((x) => x.id === id);
      if (f && (f.aeRole === 'width' || f.aeRole === 'height' || f.aeRole === 'longest' || f.aeRole === 'shortest')) {
        inner.reasons[id] += draftNote;
      }
    }
    return inner;
  }

  for (const f of fields) {
    const via = f.aeRoleEvidence ? ` — ${f.aeRoleEvidence}` : '';
    switch (f.aeRole) {
      case 'width':
        if (ctx.width) {
          values[f.id] = snap(ctx.width);
          reasons[f.id] = describeSnap('Comp width', ctx.width, snap(ctx.width)) + via;
        }
        break;
      case 'height':
        if (ctx.height) {
          values[f.id] = snap(ctx.height);
          reasons[f.id] = describeSnap('Comp height', ctx.height, snap(ctx.height)) + via;
        }
        break;
      case 'longest':
      case 'shortest':
        if (ctx.width && ctx.height) {
          const raw = f.aeRole === 'longest'
            ? Math.max(ctx.width, ctx.height)
            : Math.min(ctx.width, ctx.height);
          values[f.id] = snap(raw);
          reasons[f.id] = describeSnap(
            f.aeRole === 'longest' ? 'Comp long side' : 'Comp short side', raw, snap(raw),
          ) + via;
        }
        break;
      case 'fps':
        // Left to the workflow on purpose — see the note above. It's still
        // marked so the row can show which rate the length was computed at.
        break;
      case 'seconds':
        if (ctx.seconds) {
          // Up, not nearest: too long is trimmed on the timeline, too short
          // leaves a gap.
          const v = f.kind === 'int' ? Math.max(1, Math.ceil(ctx.seconds - 0.001)) : round(ctx.seconds, f.kind);
          values[f.id] = v;
          reasons[f.id] = (f.kind === 'int' && Math.abs(ctx.seconds - v) > 0.01
            ? `Shot length ${ctx.seconds.toFixed(2)}s, rounded up to ${v}s (this knob is a whole number) `
              + '— trimmed back to the slot on the timeline'
            : 'Shot length from the timeline') + via;
        }
        break;
      case 'frames':
        if (ctx.seconds) {
          const exact = ctx.seconds * fps;
          // The lattice belongs to the input that consumes this number, not to
          // the primitive that holds it — see FormField.aeConstraint.
          const min = f.aeConstraint?.min ?? f.min;
          const step = f.aeConstraint?.step ?? f.step;
          const snapped = snapFramesUp(exact, min, step);
          values[f.id] = snapped;
          const realSeconds = snapped / fps;
          reasons[f.id] = snapped === Math.round(exact)
            ? `Shot length ${ctx.seconds.toFixed(2)}s × ${fps} fps (the workflow's own rate)${via}`
            : `Shot length ${ctx.seconds.toFixed(2)}s × ${fps} fps (the workflow's own rate) `
              + `= ${exact.toFixed(1)} frames, rounded up to ${snapped} — this model only accepts `
              + `every ${step} frames — giving ${realSeconds.toFixed(2)}s, trimmed back to the slot `
              + `when the clip is placed${via}`;
        }
        break;
      case 'seed':
        break;  // seeds are handled by the seed policy, not by the comp
    }
  }
  return { values, reasons };
}

/* ─── What this shot will actually produce ──────────────────────────── */

export interface ShotPlan {
  /** Clip length the workflow is being asked for, when the panel can tell. */
  seconds: number | null;
  /** Short label for the row, e.g. "124f @24 = 5.17s". */
  lengthText: string | null;
  /** Frame size the workflow is being asked for, e.g. "1920×1088". */
  sizeText: string | null;
  /** True when the clip will overrun the slot and be trimmed on placement. */
  over: boolean;
  /** Things worth knowing BEFORE the render, not after it. */
  warnings: string[];
}

/**
 * What the comp is about to be turned into — stated up front.
 *
 * Every number here was already computed somewhere; the point of gathering
 * them is that a shot which silently ignores the slot must SAY so on the row.
 * The two failures this exists to make impossible are a clip shorter than the
 * gap between its markers and a clip smaller than the canvas, both of which
 * are invisible until the file lands on the timeline.
 */
export function shotPlan(form: WorkflowForm, ctx: AeContext, slotSeconds: number | null): ShotPlan {
  const fields = form.fields;
  const auto = computeAutoFill(fields, ctx);
  const warnings: string[] = [];

  const fpsField = fields.find((f) => f.aeRole === 'fps');
  const fps = (typeof fpsField?.value === 'number' && fpsField.value > 0)
    ? fpsField.value
    : (ctx.fps && ctx.fps > 0 ? ctx.fps : 24);

  const lengthField = fields.find(
    (f) => (f.aeRole === 'frames' || f.aeRole === 'seconds') && f.id in auto.values,
  );
  let seconds: number | null = null;
  let lengthText: string | null = null;
  if (lengthField) {
    const v = auto.values[lengthField.id];
    seconds = lengthField.aeRole === 'frames' ? v / fps : v;
    lengthText = lengthField.aeRole === 'frames'
      ? `${v}f @${fps} = ${seconds.toFixed(2)}s`
      : `${seconds}s`;
  }

  const w = fields.find((f) => f.aeRole === 'width' && f.id in auto.values);
  const h = fields.find((f) => f.aeRole === 'height' && f.id in auto.values);
  const side = fields.find(
    (f) => (f.aeRole === 'longest' || f.aeRole === 'shortest') && f.id in auto.values,
  );
  const sizeText = w && h ? `${auto.values[w.id]}×${auto.values[h.id]}`
    : side ? `${side.aeRole === 'longest' ? 'long' : 'short'} side ${auto.values[side.id]}`
    : null;

  if (form.aeCoverage.sizeUnbound) {
    warnings.push(
      'Frame size is not driven by the comp — this workflow decides it, and the clip will come '
      + 'back at whatever it is set to. Title the knob that sets it with [AE_WIDTH], [AE_HEIGHT] '
      + 'or [AE_LONGEST] in ComfyUI and the panel will fill it from the canvas.',
    );
  }
  if (form.aeCoverage.lengthUnbound) {
    warnings.push(
      'Clip length is not driven by the timeline — this workflow decides it, so the clip will not '
      + 'reach the second marker. Title the knob that sets it with [AE_SECONDS] or [AE_FRAMES] in '
      + 'ComfyUI and the panel will fill it from the slot.',
    );
  }
  for (const c of form.aeCoverage.conflicts) {
    warnings.push(
      `"${c}" was left alone: two different things in this workflow are driven by that one number, `
      + 'so there is no single value the comp could put there.',
    );
  }
  if (seconds !== null && slotSeconds && seconds < slotSeconds - 0.01) {
    warnings.push(
      `The clip will be ${seconds.toFixed(2)}s against a ${slotSeconds.toFixed(2)}s slot — `
      + `${(slotSeconds - seconds).toFixed(2)}s of the gap will stay empty.`,
    );
  }

  return {
    seconds,
    lengthText,
    sizeText,
    over: seconds !== null && !!slotSeconds && seconds > slotSeconds + 0.005,
    warnings,
  };
}

function snap(v: number, multiple = 32): number {
  return Math.max(multiple, Math.round(v / multiple) * multiple);
}

/**
 * Round a frame count up onto the lattice the model accepts.
 *
 * Video models don't take any number of frames: Wan wants 4n+1, LTX 8n+1,
 * Mochi 6n+7. `/object_info` states it as `min` and `step`, so the valid
 * values are min, min+step, min+2·step…
 *
 * Rounding UP rather than to the nearest is deliberate. A clip a few frames
 * too long is trimmed to the slot when it's placed — an out-point cut, no
 * quality lost. A clip a few frames too short leaves a hole nothing fills.
 */
export function snapFramesUp(target: number, min?: number, step?: number): number {
  const floor = Math.max(1, min ?? 1);
  const stride = Math.max(1, step ?? 1);
  if (target <= floor) return floor;
  const steps = Math.ceil((target - floor) / stride);
  return floor + steps * stride;
}

function describeSnap(what: string, raw: number, snapped: number): string {
  return raw === snapped
    ? `${what} (${raw}px)`
    : `${what} ${raw}px, snapped to ${snapped}px (models need a multiple of 32)`;
}

function round(v: number, kind: FieldKind): number {
  return kind === 'int' ? Math.round(v) : Math.round(v * 1000) / 1000;
}

/* ─── Writing values back ───────────────────────────────────────────── */

/**
 * Produce the workflow to submit: a deep clone of the API graph with every
 * form value written into its node. Never mutates the stored workflow.
 */
export function applyFormValues(
  api: WorkflowJson,
  fields: FormField[],
  values: Record<string, string | number | boolean>,
): WorkflowJson {
  const wf = JSON.parse(JSON.stringify(api)) as WorkflowJson;
  for (const f of fields) {
    const v = values[f.id];
    if (v === undefined) continue;
    const node = wf[f.nodeId];
    if (!node) continue;
    node.inputs[f.field] = coerce(v, f);
  }
  return wf;
}

function coerce(v: string | number | boolean, f: FormField): string | number | boolean {
  switch (f.kind) {
    case 'int': {
      const n = typeof v === 'number' ? v : parseInt(String(v), 10);
      return Number.isFinite(n) ? Math.round(n) : 0;
    }
    case 'float': {
      const n = typeof v === 'number' ? v : parseFloat(String(v));
      return Number.isFinite(n) ? n : 0;
    }
    case 'boolean':
      return typeof v === 'boolean' ? v : v === 'true' || v === 1;
    default:
      return comboValue(v, f.optionValues) ?? (typeof v === 'string' ? v : String(v));
  }
}

/**
 * The chosen label, back in the type the node's option list uses.
 *
 * A `<select>` hands back a string whatever the choices were made of. Matching
 * it against the declared options is what turns "8" into 8 again; when nothing
 * matches — a filename combo the server has since changed, a custom node we
 * have no schema for — the caller keeps the string, which is what those combos
 * hold anyway.
 */
function comboValue(
  v: string | number | boolean,
  optionValues: Array<string | number | boolean> | undefined,
): string | number | boolean | null {
  if (!optionValues || optionValues.length === 0) return null;
  const exact = optionValues.find((o) => o === v);
  if (exact !== undefined) return exact;
  const byLabel = optionValues.find((o) => String(o) === String(v));
  return byLabel !== undefined ? byLabel : null;
}
