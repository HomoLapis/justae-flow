/**
 * Which parts of a graph actually matter.
 *
 * A workflow people really use is bigger than the thing it produces. An "AIO"
 * file carries four alternative pipelines with three of them switched off; an
 * extension workflow has stages 2 and 3 muted until they are needed; a big
 * graph accumulates half-wired experiments off to one side. ComfyUI runs such a
 * file happily, because it validates from the OUTPUT nodes backwards and never
 * looks at what nothing consumes.
 *
 * The panel has to do the same or it cries wolf. Reporting every unwired input
 * in the file produced eight errors on a workflow whose live branch was
 * complete — and an error the user learns to ignore is worse than no error,
 * because it hides the one that matters.
 *
 * `output_node` is the server's own marker, present in `/object_info` (595 of
 * 6689 types on the test server carry it), so which nodes are endpoints is read
 * rather than guessed from names.
 */

import type { ComfyNode, NodeInfo, ObjectInfo, WorkflowJson } from '../providers/types';

/**
 * The schema for one input, including the ones a dynamic combo opened up.
 *
 * `COMFY_DYNAMICCOMBO_V3` is a widget that grows more widgets, and the API
 * graph names them with a dot: `MinimaxHailuo03FirstLastFrameNode.model.prompt`
 * is the prompt, `model.duration` is the clip length. Neither exists as a
 * top-level key in `/object_info` — they live under whichever option the
 * parent widget is currently set to — so looking them up the obvious way finds
 * nothing, and the panel treated the prompt and the duration of every ComfyUI
 * API node as fields it knew nothing about.
 *
 * Shared by the form and the inspector because both ask the same question of
 * the same names.
 */
export function resolveInputSpec(
  info: NodeInfo | undefined,
  field: string,
  node?: ComfyNode,
): unknown[] | null {
  if (!info?.input) return null;

  const segments = field.split('.');
  let section: NodeInfo['input'] | undefined = info.input;
  let spec: unknown[] | null = null;
  let path = '';

  for (const segment of segments) {
    const found = section?.required?.[segment] ?? section?.optional?.[segment];
    if (!Array.isArray(found)) return null;
    spec = found;
    path = path ? `${path}.${segment}` : segment;

    // Descend only if there is another segment to place: the chosen option of
    // this combo is what carries the nested inputs, and which option is chosen
    // is a fact about THIS node, not about the schema.
    if (path === field) break;
    const type = spec[0];
    if (typeof type !== 'string' || !type.startsWith('COMFY_DYNAMICCOMBO')) return null;
    const options = (spec[1] as { options?: unknown[] } | undefined)?.options;
    if (!Array.isArray(options)) return null;
    const current = node?.inputs?.[path];
    const chosen = options.find(
      (o) => o && typeof o === 'object' && (o as { key?: unknown }).key === current,
    ) as { inputs?: NodeInfo['input'] } | undefined;
    if (!chosen?.inputs) return null;
    section = chosen.inputs;
  }

  return spec;
}

/** Node ids the server considers endpoints — SaveImage, VHS_VideoCombine, … */
export function outputNodeIds(api: WorkflowJson, objectInfo: ObjectInfo | null): Set<string> {
  const out = new Set<string>();
  if (!objectInfo) return out;
  for (const [id, node] of Object.entries(api)) {
    if (objectInfo[node.class_type]?.output_node === true) out.add(id);
  }
  return out;
}

/**
 * Every node an output depends on, directly or transitively.
 *
 * Without a node catalogue there is no way to tell an endpoint from anything
 * else, and guessing wrong would silence a real error — so in that case every
 * node counts, which is the cautious answer rather than the convenient one.
 */
export function nodesFeedingOutputs(api: WorkflowJson, objectInfo: ObjectInfo | null): Set<string> {
  if (!objectInfo) return new Set(Object.keys(api));

  const outputs = outputNodeIds(api, objectInfo);
  // A graph with nothing marked as an output is one we cannot reason about —
  // an unusual custom endpoint, or a fragment. Treat it all as live.
  if (outputs.size === 0) return new Set(Object.keys(api));

  const live = new Set<string>();
  const queue = [...outputs];
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (live.has(id)) continue;
    live.add(id);
    for (const value of Object.values(api[id]?.inputs ?? {})) {
      if (Array.isArray(value) && typeof value[0] === 'string' && api[value[0]]) {
        queue.push(value[0]);
      }
    }
  }
  return live;
}
