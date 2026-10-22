/**
 * Editor-format ("UI") → API-format workflow conversion.
 *
 * ComfyUI's editor saves workflows as a graph — `nodes[]`, `links[]`,
 * positional `widgets_values[]`, optional `definitions.subgraphs`. The /prompt
 * endpoint wants the flat API format keyed by node id. The conversion lives in
 * the frontend and ComfyUI core still exposes no server endpoint for it
 * (verified August 2026), so we do it here.
 *
 * This is a TypeScript port of the converter proven against ~50 real-world
 * workflows in the JustAffinity bridge. It handles:
 *   - subgraph expansion (including nested, with promoted boundary widgets)
 *   - bypass (mode 4) and mute (mode 2)
 *   - Reroute / RerouteNode passthrough
 *   - PrimitiveNode constants
 *   - kjnodes SetNode / GetNode named wires
 *   - `control_after_generate` widget slots (present in widgets_values,
 *     absent from the input schema)
 *   - editor-only nodes (Note, MarkdownNote)
 *   - links serialised as arrays or as objects
 *
 * Widget values are positional, so the node's input schema from
 * `GET /object_info` is required to name them. That's the one thing we can't
 * derive from the file alone.
 */

import type { NodeInfo, ObjectInfo, WorkflowJson } from '../providers/types';
import { nodesFeedingOutputs } from './graph';

const UI_ONLY = new Set(['Note', 'MarkdownNote', 'GroupNode']);
const CONTROL_VALUES = new Set(['fixed', 'increment', 'decrement', 'randomize']);
/** Widget names the editor attaches a control_after_generate slot to by itself. */
const SEED_NAMES = /(^|\.)(noise_seed|seed|rand_seed)$/i;
/** What the editor's upload button stores in the slot it occupies. */
const UPLOAD_MARKERS = new Set(['image', 'video', 'audio', 'file']);

/**
 * Boundary input types that occupy a slot in a subgraph instance's
 * `widgets_values`. Anything else is a socket and takes no slot.
 */
const BOUNDARY_WIDGET_TYPES = new Set(['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO']);

/* ─── Shapes of the editor format (only the parts we read) ──────────── */

export interface UiSlot {
  name?: string;
  type?: string;
  link?: number | null;
  widget?: { name?: string } | boolean;
  widgetId?: string;
}

export interface UiNode {
  id: number | string;
  type: string;
  title?: string;
  mode?: number;
  inputs?: UiSlot[];
  outputs?: UiSlot[];
  widgets_values?: unknown[] | Record<string, unknown>;
}

export interface UiLinkObject {
  id: number;
  origin_id: number;
  origin_slot: number;
  target_id: number;
  target_slot: number;
  type?: string;
}

export type UiLink = UiLinkObject | [number, number, number, number, number, string];

export interface UiSubgraphDef {
  id: string;
  name?: string;
  nodes?: UiNode[];
  links?: UiLink[];
  inputs?: Array<{ name?: string; type?: string; widget?: unknown }>;
  outputs?: Array<{ name?: string; type?: string }>;
}

export interface UiWorkflow {
  nodes: UiNode[];
  links?: UiLink[];
  definitions?: { subgraphs?: UiSubgraphDef[] };
  extra?: Record<string, unknown>;
  [k: string]: unknown;
}

/* ─── Format detection ──────────────────────────────────────────────── */

export function isApiFormat(json: unknown): json is WorkflowJson {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return false;
  const values = Object.values(json as Record<string, unknown>);
  if (values.length === 0) return false;
  return values.every((v) => !!v && typeof v === 'object' && 'class_type' in (v as object));
}

export function isUiFormat(json: unknown): json is UiWorkflow {
  return !!json && typeof json === 'object' && Array.isArray((json as UiWorkflow).nodes);
}

/* ─── Flattening (subgraph expansion) ───────────────────────────────── */

interface FlatOrigin {
  fid?: string;
  slot?: number;
  /** Set while an origin is still waiting to be resolved to a parent-graph link. */
  pendingOuter?: number;
  /** Set when the origin resolved to a literal instead of a wire. */
  constant?: unknown;
}

interface FlatLink {
  origin: FlatOrigin;
  target: { fid: string; slot: number };
  type?: string;
  outerId?: number;
  prefix?: string;
  _drop?: boolean;
}

interface FlatConstant {
  fid: string;
  slot: number;
  value: unknown;
  viaInstance?: boolean;
}

interface FlatNode extends UiNode {
  _fid: string;
}

interface FlatGraph {
  nodes: FlatNode[];
  links: FlatLink[];
  constants: FlatConstant[];
}

type Binding =
  | { kind: 'link'; outerLink: number }
  | { kind: 'value'; value: unknown };

function normLinks(ls: UiLink[] | undefined): UiLinkObject[] {
  return (ls ?? []).map((l) =>
    Array.isArray(l)
      ? { id: l[0], origin_id: l[1], origin_slot: l[2], target_id: l[3], target_slot: l[4], type: l[5] }
      : l,
  );
}

function flatten(ui: UiWorkflow): FlatGraph {
  const defs = new Map<string, UiSubgraphDef>(
    (ui.definitions?.subgraphs ?? []).map((s) => [s.id, s]),
  );
  const out: FlatGraph = { nodes: [], links: [], constants: [] };

  /** Returns: instance output slot → the inner origin it resolves to. */
  function walk(
    nodes: UiNode[],
    rawLinks: UiLink[] | undefined,
    prefix: string,
    inputBindings: { bindings: Map<number, Binding> } | null,
  ): Map<number, FlatOrigin> {
    const fid = (id: number | string): string => (prefix ? `${prefix}:${id}` : String(id));
    const links = normLinks(rawLinks);
    const here = new Map(nodes.map((n) => [n.id, n]));
    const outputOrigins = new Map<number, FlatOrigin>();       // targets of the -20 boundary
    const instanceOutputs = new Map<number | string, Map<number, FlatOrigin>>();

    // 1. Instantiate subgraph children first, so the link pass can see them.
    for (const n of nodes) {
      if (!defs.has(n.type)) continue;
      if (n.mode === 2 || n.mode === 4) continue;  // muted / bypassed: don't expand
      const def = defs.get(n.type)!;
      const childBindings = new Map<number, Binding>();
      const w = Array.isArray(n.widgets_values) ? n.widgets_values : [];

      /*
       * Bind the instance's inputs to the subgraph's boundary, BY NAME.
       *
       * Position does not work, and the failure is silent. A subgraph
       * definition declares every boundary input; the instance node lists only
       * the ones it actually shows — the wired ones plus any widget the author
       * exposed — in its own order. Measured on a real MiniMax H3 workflow: 11
       * boundary inputs against 6 instance slots, where definition index 3
       * (`width`) sat opposite instance index 3 (`height`). Aligning them by
       * index swapped two wires and shifted every widget value after the third,
       * so `unet_name` came out as the integer 5 and the seed as 768. That graph
       * still passes validation — it just renders something else.
       *
       * The widget array is the other half of the rule: every WIDGET-TYPED
       * boundary input occupies one slot in `widgets_values`, in definition
       * order, whether or not it is wired. Boundary inputs carry no `widget`
       * flag in the files (checked), so the type is what decides; a wired one
       * still holds its place, and its value is simply overridden by the link.
       */
      const instByName = new Map<string, UiSlot>();
      for (const s of n.inputs ?? []) if (s?.name) instByName.set(s.name, s);

      let wi = 0;
      (def.inputs ?? []).forEach((bIn, i) => {
        const inst = (bIn.name && instByName.get(bIn.name)) || (bIn.name ? undefined : (n.inputs ?? [])[i]);
        const linked = !!inst && inst.link !== null && inst.link !== undefined;

        const takesWidgetSlot = !!bIn.widget
          || (typeof bIn.type === 'string' && BOUNDARY_WIDGET_TYPES.has(bIn.type));
        let widgetVal: unknown;
        if (takesWidgetSlot && wi < w.length) widgetVal = w[wi++];

        if (linked) childBindings.set(i, { kind: 'link', outerLink: inst!.link as number });
        else if (widgetVal !== undefined) childBindings.set(i, { kind: 'value', value: widgetVal });
      });
      const childOut = walk(def.nodes ?? [], def.links, fid(n.id), { bindings: childBindings });
      instanceOutputs.set(n.id, childOut);
    }

    // 2. Real nodes.
    for (const n of nodes) {
      /*
       * A BYPASSED subgraph instance is kept, deliberately.
       *
       * Step 1 does not expand it — bypassed means its contents do not run —
       * and the obvious next move is to drop it like any other subgraph node.
       * That is what this did, and it deleted the wire passing THROUGH it.
       * Found on `QWEN-edit-controlnet` in the 281-file corpus: an image
       * reached `ControlNetApplyAdvanced` via a bypassed subgraph, arrived
       * nowhere, and was reported as `missing required input "image"`.
       *
       * Bypassed is not muted. It means "hand your input straight to your
       * output", which is exactly what resolveVirtual already does for an
       * ordinary bypassed node — but only if the node is still there to route
       * through. The instance carries its own `inputs` and `outputs`, which is
       * all that rewiring needs. Muted instances (mode 2) are still dropped,
       * because muted really does mean gone.
       */
      if (defs.has(n.type) && n.mode !== 4) continue;
      out.nodes.push({ ...n, _fid: fid(n.id) });
    }

    /**
     * An instance slot index → the matching index on the subgraph's boundary.
     *
     * The same trap as the widget binding above, on the wiring side: a link
     * into or out of a subgraph instance carries the slot number as the
     * INSTANCE numbers it, while the inner links speak in BOUNDARY numbers, and
     * the two lists are neither the same length nor the same order. Getting
     * this wrong swaps wires between same-typed inputs — `width` fed from the
     * output that should have fed `height` — which no validation can catch,
     * because both ends are INT and both are connected.
     */
    const boundaryIndex = (
      slots: UiSlot[] | undefined,
      boundary: Array<{ name?: string }> | undefined,
      slot: number,
    ): number => {
      const name = (slots ?? [])[slot]?.name;
      if (!name) return slot;
      const i = (boundary ?? []).findIndex((b) => b.name === name);
      return i >= 0 ? i : slot;
    };

    // 3. Links of this graph.
    for (const l of links) {
      let origins: FlatOrigin[] = [];
      if (l.origin_id === -10) {
        // The current subgraph's input boundary.
        const b = inputBindings?.bindings.get(l.origin_slot);
        if (!b) continue;
        if (b.kind === 'value') {
          out.constants.push({
            fid: fid(l.target_id), slot: l.target_slot, value: b.value, viaInstance: true,
          });
          continue;
        }
        origins = [{ pendingOuter: b.outerLink }];
      } else if (instanceOutputs.has(l.origin_id)) {
        const originNode = here.get(l.origin_id);
        const slot = boundaryIndex(
          originNode?.outputs,
          defs.get(originNode?.type ?? '')?.outputs,
          l.origin_slot,
        );
        const o = instanceOutputs.get(l.origin_id)!.get(slot);
        if (!o) continue;
        origins = [o];
      } else {
        origins = [{ fid: fid(l.origin_id), slot: l.origin_slot }];
      }

      let targets: Array<{ fid: string; slot: number }>;
      const targetNode = here.get(l.target_id);
      if (l.target_id === -20) {
        for (const o of origins) outputOrigins.set(l.target_slot, o);
        continue;
      } else if (
        instanceOutputs.has(l.target_id) ||
        (targetNode && defs.has(targetNode.type) && targetNode.mode !== 2 && targetNode.mode !== 4)
      ) {
        // A wire INTO a subgraph instance: follow it to the inner consumers.
        const childDef = defs.get(targetNode!.type)!;
        const boundarySlot = boundaryIndex(targetNode!.inputs, childDef.inputs, l.target_slot);
        const inner = normLinks(childDef.links)
          .filter((il) => il.origin_id === -10 && il.origin_slot === boundarySlot);
        targets = inner.map((il) => ({ fid: `${fid(l.target_id)}:${il.target_id}`, slot: il.target_slot }));
      } else {
        targets = [{ fid: fid(l.target_id), slot: l.target_slot }];
      }

      for (const o of origins) {
        for (const t of targets) {
          out.links.push({ origin: o, target: t, type: l.type, outerId: l.id, prefix });
        }
      }
    }
    return outputOrigins;
  }

  walk(ui.nodes ?? [], ui.links, '', null);

  // Resolve origins that were still pointing at a parent-graph link id.
  const byOuterId = new Map<string, FlatOrigin>();
  for (const l of out.links) {
    if (l.origin.pendingOuter === undefined) byOuterId.set(`${l.prefix ?? ''}|${l.outerId}`, l.origin);
  }
  for (const l of out.links) {
    if (l.origin.pendingOuter !== undefined) {
      const prefix = l.prefix ?? '';
      const parentPrefix = prefix.includes(':') ? prefix.slice(0, prefix.lastIndexOf(':')) : '';
      const resolved = byOuterId.get(`${parentPrefix}|${l.origin.pendingOuter}`);
      if (resolved) l.origin = resolved;
      else l._drop = true;
    }
  }
  out.links = out.links.filter((l) => !l._drop);
  return out;
}

/* ─── Virtual node resolution ───────────────────────────────────────── */

function resolveVirtual(flat: FlatGraph): FlatGraph {
  const byFid = new Map(flat.nodes.map((n) => [n._fid, n]));
  const incoming = new Map<string, Map<number, FlatLink>>();
  for (const l of flat.links) {
    if (!incoming.has(l.target.fid)) incoming.set(l.target.fid, new Map());
    incoming.get(l.target.fid)!.set(l.target.slot, l);
  }

  // kjnodes named wires: SetNode publishes, GetNode subscribes.
  const setters = new Map<string, FlatOrigin>();
  for (const n of flat.nodes) {
    if (n.type !== 'SetNode') continue;
    const name = (Array.isArray(n.widgets_values) ? n.widgets_values : [])[0];
    const inLink = incoming.get(n._fid)?.get(0);
    if (name !== undefined && name !== null && inLink) setters.set(String(name), inLink.origin);
  }

  /**
   * Nodes that hand whatever arrives on their first input straight out again.
   *
   * `SetNode` belongs here and its absence was a real defect. kjnodes' SetNode
   * both publishes a named value AND passes it through on its own output, and
   * authors of large workflows wire the two ways interchangeably — 9 links read
   * a SetNode output directly in one of the test files, 7 in another. Treating
   * it as publish-only deleted the node and left those wires pointing at
   * nothing, which surfaced as `missing required input "images"` on the node at
   * the far end.
   */
  const FORWARDS_FIRST_INPUT = new Set(['Reroute', 'RerouteNode', 'SetNode']);

  const isPassthrough = (n: FlatNode): boolean =>
    FORWARDS_FIRST_INPUT.has(n.type) || n.mode === 4;
  const isDropped = (n: FlatNode): boolean =>
    n.mode === 2 || UI_ONLY.has(n.type) ||
    n.type === 'SetNode' || n.type === 'GetNode' || n.type === 'PrimitiveNode';

  function resolveOrigin(origin: FlatOrigin | undefined, depth = 0): FlatOrigin | null {
    if (depth > 50 || !origin || origin.fid === undefined) return null;
    const n = byFid.get(origin.fid);
    if (!n) return null;
    if (n.type === 'GetNode') {
      const name = (Array.isArray(n.widgets_values) ? n.widgets_values : [])[0];
      const src = setters.get(String(name));
      return src ? resolveOrigin(src, depth + 1) : null;
    }
    if (n.type === 'PrimitiveNode') {
      return { constant: (Array.isArray(n.widgets_values) ? n.widgets_values : [])[0] };
    }
    if (isPassthrough(n)) {
      const ins = incoming.get(n._fid);
      if (!ins) return null;
      let chosen: FlatLink | undefined;
      if (FORWARDS_FIRST_INPUT.has(n.type)) {
        chosen = ins.get(0);
      } else {
        // A bypassed node forwards each output to the input of the same type.
        const outType = (n.outputs ?? [])[origin.slot ?? 0]?.type;
        for (const [slot, l] of ins) {
          const inType = (n.inputs ?? [])[slot]?.type;
          if (!outType || outType === '*' || inType === outType || inType === '*') { chosen = l; break; }
        }
      }
      return chosen ? resolveOrigin(chosen.origin, depth + 1) : null;
    }
    if (n.mode === 2) return null;
    return origin;
  }

  const resolvedLinks: FlatLink[] = [];
  for (const l of flat.links) {
    const t = byFid.get(l.target.fid);
    if (!t || isDropped(t) || isPassthrough(t)) continue;  // consumed / removed elsewhere
    const o = resolveOrigin(l.origin);
    if (!o) continue;
    if (o.constant !== undefined) {
      flat.constants.push({ fid: l.target.fid, slot: l.target.slot, value: o.constant });
    } else {
      resolvedLinks.push({ origin: o, target: l.target });
    }
  }
  flat.links = resolvedLinks;
  flat.nodes = flat.nodes.filter((n) => !isDropped(n) && !isPassthrough(n) && !UI_ONLY.has(n.type));
  return flat;
}

/* ─── Widget assignment ─────────────────────────────────────────────── */

function widgetSpecs(info: NodeInfo | null): Array<[string, unknown[]]> {
  const specs: Array<[string, unknown[]]> = [];
  for (const sec of ['required', 'optional'] as const) {
    for (const [name, spec] of Object.entries(info?.input?.[sec] ?? {})) {
      specs.push([name, spec as unknown[]]);
    }
  }
  return specs;
}

const WIDGET_TYPES = new Set(['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO']);

/**
 * Does this schema entry consume a slot in `widgets_values`?
 *
 * The file itself answers this better than any type list: names that appear in
 * the node's `inputs[]` are sockets, and only those carrying a `widget` marker
 * (a widget the user converted into an input) still hold their place in the
 * positional widget array. Names absent from `inputs[]` are plain widgets.
 *
 * The type check is only the fallback for older files that omit unconnected
 * sockets. It has to stay open-ended: ComfyUI keeps adding widget types —
 * `COMFY_DYNAMICCOMBO_V3` (SaveVideo's codec) is one, and treating it as a
 * socket silently shifts every later widget value by one.
 */
function isWidgetSpec(spec: unknown[], name: string, node: UiNode): boolean {
  const slot = (node.inputs ?? []).find((s) => s.name === name);
  if (slot) return !!slot.widget;

  const t = spec?.[0];
  if (Array.isArray(t)) return true;                       // legacy inline combo
  if (typeof t === 'string') {
    if (WIDGET_TYPES.has(t)) return true;
    if (t.startsWith('COMFY_DYNAMICCOMBO')) return true;
  }
  // Anything carrying a default or a list of choices is something the user
  // sets, not something another node produces.
  const opts = spec?.[1];
  if (opts && typeof opts === 'object' && ('default' in opts || 'options' in opts)) return true;
  return false;
}

/**
 * The extra widget slots a dynamic combo opens up once a choice is made.
 *
 * `COMFY_DYNAMICCOMBO_V3` is a widget that grows more widgets: `SaveVideo`'s
 * `format` carries a nested `codec`, which on `h264` carries an `encoding`,
 * which carries a CRF. They live in `widgets_values` right after their parent,
 * under dotted names (`format.codec`) — the editor's own prompt sends them
 * that way, and every one of them takes a slot.
 *
 * Ignoring them shifted every later value by one: a `SaveVideo` set to MP4/AV1
 * handed the nested codec's value to the node's own `codec` input, and the
 * nested one went missing. It stayed invisible only because a workflow left on
 * "auto" everywhere reads the same either way.
 */
function dynamicOptionSpecs(spec: unknown[], value: unknown): Array<[string, unknown[]]> {
  const type = spec?.[0];
  if (typeof type !== 'string' || !type.startsWith('COMFY_DYNAMICCOMBO')) return [];
  const options = (spec?.[1] as { options?: unknown[] } | undefined)?.options;
  if (!Array.isArray(options)) return [];
  const chosen = options.find(
    (o) => o && typeof o === 'object' && (o as { key?: unknown }).key === value,
  ) as { inputs?: NodeInfo['input'] } | undefined;
  const nested: Array<[string, unknown[]]> = [];
  for (const sec of ['required', 'optional'] as const) {
    for (const [name, s] of Object.entries(chosen?.inputs?.[sec] ?? {})) {
      nested.push([name, s as unknown[]]);
    }
  }
  return nested;
}

interface NodeInputs {
  inputs: Record<string, unknown>;
  /**
   * True when the file holds widget values that no name in the schema can
   * claim — see `unnameableWidgets` below.
   */
  unnameable: boolean;
}

/**
 * Widget values that exist on the node but not in `/object_info`.
 *
 * Some packs build their widgets in the browser and the schema never mentions
 * them. rgthree's Power Lora Loader declares NO widgets at all and keeps its
 * whole list in `widgets_values` as objects — `{on, lora, strength}` per LoRA.
 * Read positionally there is nothing to key them to, so they were dropped, and
 * the graph rendered without the LoRA: measured on a MiniMax-H3 workflow whose
 * only LoRA is the 4-step turbo one, so the render silently became an 8-step
 * model asked for 4 steps.
 *
 * Empty objects and empty strings are the pack's own furniture (headers, the
 * "＋ Add Lora" button) and say nothing. Neither do ARRAYS: every multiline text
 * widget in the current frontend trails a `[false, true]` pair of its own —
 * counting those reported 84 nodes across the corpus, 83 of them fine, which is
 * how a warning gets trained out of existence. Only a keyed object is a setting
 * with a name we failed to learn.
 */
function unnameableWidgets(leftover: unknown[]): boolean {
  return leftover.some(
    (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
      && Object.keys(v as Record<string, unknown>).length > 0,
  );
}

function nodeInputs(
  n: FlatNode,
  info: NodeInfo,
  incoming: Map<number, FlatLink>,
): NodeInputs {
  const inputs: Record<string, unknown> = {};
  const linkedByName = new Map<string, FlatLink>();
  for (const [slot, l] of incoming) {
    const name = (n.inputs ?? [])[slot]?.name;
    if (name) linkedByName.set(name, l);
  }

  const positional = Array.isArray(n.widgets_values) ? n.widgets_values : null;
  const byName = !positional && n.widgets_values && typeof n.widgets_values === 'object'
    ? (n.widgets_values as Record<string, unknown>)
    : null;

  let wi = 0;
  const take = (name: string, spec: unknown[]): unknown => {
    if (byName) return byName[name];
    if (!positional || wi >= positional.length) return undefined;
    const val = positional[wi++];
    /*
     * Seed-like widgets carry an extra "randomize"/"fixed" slot in the
     * editor that has no counterpart in the schema — skip it.
     *
     * The schema flag alone does not find them all. The editor also attaches
     * the control to any INT widget it recognises as a seed by name, and
     * plenty of nodes declare one without the flag —
     * `ElevenLabsSpeechToSpeech.seed` is `["INT", {min, max, default}]` yet
     * its file holds `…, 3280698246, "randomize", false`. Missing that slot
     * shifted the boolean after it onto the string "randomize".
     */
    const opts = spec?.[1] as Record<string, unknown> | undefined;
    const seedLike = opts?.control_after_generate === true
      || (typeof val === 'number' && SEED_NAMES.test(name));
    if (seedLike && typeof positional[wi] === 'string'
        && CONTROL_VALUES.has(positional[wi] as string)) {
      wi++;
    }

    /*
     * A file picker brings its own furniture: the upload button, and on audio
     * and video the preview player beside it. They are widgets like any other
     * to the editor, so they hold slots — `LoadImage` saves
     * `["photo.png", "image"]`, `LoadAudio` saves `["clip.mp3", null, null]`.
     * The schema names none of them, and reading past them put the marker
     * string "image" into `LoadImageWithSwitch.enabled`, a boolean.
     */
    const uploads = opts
      && Object.entries(opts).some(([k, v]) => k.endsWith('_upload') && v === true);
    if (uploads) {
      while (wi < positional.length
             && (positional[wi] === null
                 || (typeof positional[wi] === 'string'
                     && UPLOAD_MARKERS.has(positional[wi] as string)))) {
        wi++;
      }
    }
    return val;
  };

  const walk = (specs: Array<[string, unknown[]]>, prefix: string): void => {
    for (const [rawName, spec] of specs) {
      const name = prefix ? `${prefix}.${rawName}` : rawName;
      const isW = isWidgetSpec(spec, name, n);
      const val = isW ? take(name, spec) : undefined;

      const link = linkedByName.get(name);
      if (link && link.origin.fid !== undefined) {
        inputs[name] = [String(link.origin.fid), link.origin.slot ?? 0];
      } else if (isW && val !== undefined) {
        inputs[name] = val;
      }
      if (isW) walk(dynamicOptionSpecs(spec, val), name);
    }
  };
  walk(widgetSpecs(info), '');
  // Wires whose name isn't in the schema order (custom nodes with dynamic inputs).
  for (const [name, l] of linkedByName) {
    if (!(name in inputs) && l.origin.fid !== undefined) {
      inputs[name] = [String(l.origin.fid), l.origin.slot ?? 0];
    }
  }

  /*
   * Name-keyed extras, passed through.
   *
   * When a node saves its widgets by name instead of by position, widgets the
   * schema never declares are still readable — and some of them are read by the
   * node itself. `VHS_VideoCombine` declares seven inputs but grows more once a
   * format is chosen (`pix_fmt`, `crf`, `save_metadata`, `trim_to_audio`), and
   * its Python reaches into `prompt[unique_id]['inputs']` for them rather than
   * taking them as arguments. Dropping them was invisible — the render worked —
   * and quietly encoded at the node's defaults instead of the file's settings.
   * Confirmed against ComfyUI's own `graphToPrompt`, which sends all four.
   *
   * Only primitives: the object-valued keys are editor state (`videopreview`
   * holds the player's paused flag), and ComfyUI leaves those out too.
   */
  let unnameable = false;
  if (byName) {
    for (const [name, val] of Object.entries(byName)) {
      if (name in inputs || linkedByName.has(name)) continue;
      if (val === null || typeof val === 'object') continue;
      inputs[name] = val;
    }
  } else if (positional) {
    unnameable = unnameableWidgets(positional.slice(wi));
  }
  return { inputs, unnameable };
}

/* ─── Entry point ───────────────────────────────────────────────────── */

export interface ConvertResult {
  api: WorkflowJson;
  /** Human-readable notes — missing node types, unresolvable wires. */
  problems: string[];
  /**
   * Node types this server does not have, and which the graph actually
   * consumes. Named separately from `problems` because they are a ROOT CAUSE:
   * a node that is not installed cannot be in the graph, so everything it fed
   * then reports as a missing input too. Being able to tell the cause from its
   * consequences is what stops one absent custom node from looking like six
   * unrelated faults.
   */
  missingNodeTypes: string[];
  /** False when the input was already in API format and passed straight through. */
  converted: boolean;
}

/**
 * Convert a workflow to API format. Accepts either format; an API-format input
 * is returned untouched so callers can pass anything the user threw at them.
 */
export function convertUiToApi(input: unknown, objectInfo: ObjectInfo): ConvertResult {
  if (isApiFormat(input)) return { api: input, problems: [], missingNodeTypes: [], converted: false };
  if (!isUiFormat(input)) {
    throw new Error(
      'Unrecognised workflow file — it is neither the editor format (a "nodes" array) '
      + 'nor the API format (an object keyed by node id).',
    );
  }

  const flat = resolveVirtual(flatten(input));

  const incoming = new Map<string, Map<number, FlatLink>>();
  for (const l of flat.links) {
    if (!incoming.has(l.target.fid)) incoming.set(l.target.fid, new Map());
    incoming.get(l.target.fid)!.set(l.target.slot, l);
  }

  /** Node ids that something downstream actually consumes. */
  const consumed = new Set(
    flat.links.map((l) => l.origin.fid).filter((f): f is string => f !== undefined),
  );

  const api: WorkflowJson = {};
  const problems: string[] = [];
  const missingNodeTypes = new Set<string>();
  const unnameableNodes = new Set<string>();
  for (const n of flat.nodes) {
    const info = objectInfo[n.type];
    if (!info) {
      // A node type this server doesn't have is only a problem if the graph
      // depends on it. Packs like rgthree ship editor-only panels (group
      // muters, labels) that feed nothing — they can't affect execution, so
      // dropping them quietly is right, and reporting them would train the
      // user to ignore the warning that matters.
      if (consumed.has(n._fid)) {
        missingNodeTypes.add(n.type);
      }
      continue;
    }
    const { inputs, unnameable } = nodeInputs(n, info, incoming.get(n._fid) ?? new Map());
    api[n._fid] = {
      class_type: n.type,
      inputs,
      _meta: { title: n.title ?? n.type },
    };
    if (unnameable) unnameableNodes.add(n._fid);
  }

  // Boundary constants (subgraph widget values, primitives).
  for (const c of flat.constants) {
    const node = api[c.fid];
    if (!node) continue;
    const flatNode = flat.nodes.find((x) => x._fid === c.fid);
    const name = (flatNode?.inputs ?? [])[c.slot]?.name;
    if (!name) continue;
    if (!Array.isArray(node.inputs[name]) || c.viaInstance) node.inputs[name] = c.value;
  }

  /*
   * Only complain about the half of the graph that runs.
   *
   * Real workflows carry switched-off branches on purpose — an AIO file with
   * three of its four pipelines unwired, an extension workflow with stages 2
   * and 3 muted. ComfyUI validates backwards from the output nodes and never
   * looks at the rest, and a panel that reports all of it teaches the user to
   * ignore the report. Both loops below still FIX what they find; they just
   * stay quiet about a branch nothing consumes.
   */
  const live = nodesFeedingOutputs(api, objectInfo);

  // A node with dynamic inputs (autogrow lists, dynamic combos) expands into
  // dotted slot ids at execution time — `variables.a`, not `variables`. A file
  // saved before the node grew them keeps its links on the old bare names, and
  // ComfyUI will reject it. Say so here rather than let it fail on the server.
  for (const [id, node] of Object.entries(api)) {
    const info = objectInfo[node.class_type];
    for (const [name, spec] of Object.entries(info?.input?.required ?? {})) {
      const type = Array.isArray(spec) ? (spec as unknown[])[0] : undefined;
      if (typeof type !== 'string' || !type.startsWith('COMFY_')) continue;
      if (name in node.inputs) continue;
      if (Object.keys(node.inputs).some((k) => k.startsWith(`${name}.`))) continue;
      if (!live.has(id)) continue;
      problems.push(
        `Node ${id} (${node.class_type}) has a dynamic input "${name}" with nothing wired into its `
        + 'slots — the file predates that node\'s current shape. Open it in the editor and reconnect it.',
      );
    }
  }

  // A wire pointing at a node we dropped would make ComfyUI reject the graph.
  for (const [id, node] of Object.entries(api)) {
    for (const [field, value] of Object.entries(node.inputs)) {
      if (Array.isArray(value) && typeof value[0] === 'string' && !api[value[0]]) {
        delete node.inputs[field];
        if (live.has(id)) {
          problems.push(`Dropped a dangling wire on node ${id} (${node.class_type}) input "${field}".`);
        }
      }
    }
  }

  /*
   * Say it when a node's settings could not be read at all.
   *
   * This one is worth a line precisely because nothing breaks: the graph
   * converts, validates and runs — with the pack's defaults where the file had
   * the user's choices. Silence there is the worst outcome, since the only clue
   * is that the render came back subtly wrong.
   */
  for (const id of unnameableNodes) {
    if (!live.has(id)) continue;
    problems.push(
      `Node ${id} (${api[id]?.class_type}) keeps settings this ComfyUI does not describe, so they `
      + 'could not be read from the file — the node will run on its own defaults. Run it once in '
      + 'the editor and let the panel adopt that graph instead.',
    );
  }

  for (const type of missingNodeTypes) {
    problems.push(`Node type not installed on this ComfyUI: ${type}`);
  }

  return { api, problems, missingNodeTypes: [...missingNodeTypes], converted: true };
}
