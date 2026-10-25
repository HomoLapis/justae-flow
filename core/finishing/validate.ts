/**
 * Check an API graph against a server's /object_info before anything is
 * uploaded.
 *
 * A finishing job uploads hundreds of frames before the graph reaches the
 * server; a typo in an input name found AFTER that costs the whole upload. The
 * server's own validation stays the authority (it runs again on submit) — this
 * catches what can be known offline: node types, required inputs, links,
 * combo values, numeric ranges, and the dotted sub-inputs of dynamic combos
 * (SaveImageAdvanced's `format.bit_depth`).
 */

import type { ApiGraph } from './graph.ts';
import type { NodeCatalog } from './models.ts';

type Spec = unknown[];

interface NodeSchema {
  input?: { required?: Record<string, Spec>; optional?: Record<string, Spec> };
  output?: string[];
}

function isLink(v: unknown): v is [string, number] {
  return Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'number';
}

function optionsOf(spec: Spec): string[] | null {
  if (Array.isArray(spec[0])) return (spec[0] as unknown[]).map(String);
  if (spec[0] === 'COMBO') {
    const o = (spec[1] as { options?: unknown[] } | undefined)?.options;
    return Array.isArray(o) ? o.map(String) : null;
  }
  return null;
}

/** Options of a dynamic combo: key → its own inputs. */
function dynamicOptions(spec: Spec): Map<string, NodeSchema['input']> | null {
  if (spec[0] !== 'COMFY_DYNAMICCOMBO_V3') return null;
  const o = (spec[1] as { options?: Array<{ key: string; inputs?: NodeSchema['input'] }> } | undefined)?.options;
  if (!Array.isArray(o)) return null;
  return new Map(o.map((x) => [x.key, x.inputs]));
}

function checkValue(name: string, spec: Spec, v: unknown, where: string, problems: string[]): void {
  const opts = optionsOf(spec);
  if (opts) {
    if (!opts.includes(String(v))) {
      problems.push(`${where}: ${name} = "${String(v)}" is not one of the server's options${opts.length <= 8 ? ` (${opts.join(', ')})` : ` (${opts.length} options)`}`);
    }
    return;
  }
  const type = spec[0];
  const meta = (spec[1] ?? {}) as { min?: number; max?: number };
  if (type === 'INT' || type === 'FLOAT') {
    if (typeof v !== 'number' || !Number.isFinite(v)) { problems.push(`${where}: ${name} must be a number, got ${JSON.stringify(v)}`); return; }
    if (type === 'INT' && !Number.isInteger(v)) problems.push(`${where}: ${name} must be an integer, got ${v}`);
    if (typeof meta.min === 'number' && v < meta.min) problems.push(`${where}: ${name} = ${v} is below ${meta.min}`);
    if (typeof meta.max === 'number' && v > meta.max) problems.push(`${where}: ${name} = ${v} is above ${meta.max}`);
  } else if (type === 'BOOLEAN' && typeof v !== 'boolean') {
    problems.push(`${where}: ${name} must be true/false, got ${JSON.stringify(v)}`);
  } else if (type === 'STRING' && typeof v !== 'string') {
    problems.push(`${where}: ${name} must be text, got ${JSON.stringify(v)}`);
  }
}

/**
 * Problems, in plain words; empty when the graph would be accepted as far as
 * can be told. `ignore` lists "nodeId.input" values not to check — the frames
 * folder, before the upload that creates it.
 */
export function validateGraph(graph: ApiGraph, oi: NodeCatalog, ignore: string[] = []): string[] {
  const problems: string[] = [];
  for (const [id, node] of Object.entries(graph)) {
    const schema = oi[node.class_type] as NodeSchema | undefined;
    const where = `node ${id} (${node.class_type})`;
    if (!schema) { problems.push(`${where}: not installed on this server`); continue; }
    const req = schema.input?.required ?? {};
    const opt = schema.input?.optional ?? {};
    const all: Record<string, Spec> = { ...req, ...opt };

    // Dynamic combos bring their own inputs under "<name>.<input>".
    for (const [name, spec] of Object.entries(all)) {
      const dyn = dynamicOptions(spec);
      if (!dyn) continue;
      const chosen = node.inputs[name];
      if (chosen === undefined) continue;
      const sub = dyn.get(String(chosen));
      if (!dyn.has(String(chosen))) { problems.push(`${where}: ${name} = "${String(chosen)}" is not one of ${[...dyn.keys()].join(', ')}`); continue; }
      for (const [subName, subSpec] of Object.entries({ ...(sub?.required ?? {}), ...(sub?.optional ?? {}) })) {
        const key = `${name}.${subName}`;
        all[key] = subSpec;
        if (sub?.required && subName in sub.required && !(key in node.inputs)) problems.push(`${where}: missing ${key}`);
      }
    }

    for (const name of Object.keys(req)) {
      if (!(name in node.inputs)) problems.push(`${where}: missing required input ${name}`);
    }
    for (const [name, v] of Object.entries(node.inputs)) {
      if (ignore.includes(`${id}.${name}`)) continue;
      const spec = all[name];
      if (!spec) { problems.push(`${where}: ${name} is not an input of ${node.class_type}`); continue; }
      if (isLink(v)) {
        const src = graph[v[0]];
        if (!src) { problems.push(`${where}: ${name} links to missing node ${v[0]}`); continue; }
        const outs = (oi[src.class_type] as NodeSchema | undefined)?.output;
        if (outs && v[1] >= outs.length) problems.push(`${where}: ${name} links to output ${v[1]} of ${src.class_type}, which has ${outs.length}`);
        const want = spec[0];
        const got = outs?.[v[1]];
        if (typeof want === 'string' && got && want !== '*' && got !== '*' && want !== got
          && !(want === 'COMBO' || Array.isArray(want)) && !want.includes(',') && !got.includes(',')) {
          problems.push(`${where}: ${name} wants ${want}, gets ${got} from node ${v[0]}`);
        }
        continue;
      }
      if (Array.isArray(spec[0]) || typeof spec[0] === 'string') {
        if (spec[0] === 'COMFY_DYNAMICCOMBO_V3') continue;
        // Asset references (Comfy API v2) stand where a filename would.
        if (typeof v === 'object' && v !== null && (v as { __type?: string }).__type === 'core/ASSET') continue;
        checkValue(name, spec, v, where, problems);
      }
    }
  }
  return problems;
}
