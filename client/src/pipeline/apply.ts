/**
 * Applying the catalog to real workflows: is it installed, which workflows
 * implement it, and setting draft/final values on the fields that exist.
 *
 * Everything here reports what it did NOT do as carefully as what it did — a
 * preset that silently half-applies is how a "final" goes out at draft steps.
 */
import type { ObjectInfo, WorkflowJson } from '../providers/types';
import type { WorkflowSummary } from '../workflows/library';
import type { FormField } from '../workflows/form';
import type { CatalogEntry, PresetValue } from './catalog';

export interface Availability {
  /** null = no node catalogue to check against (e.g. Comfy API v2). */
  available: boolean | null;
  /** Requirement groups none of whose node types exist. */
  missing: string[][];
}

export function availability(entry: CatalogEntry, info: ObjectInfo | null): Availability {
  if (!info) return { available: null, missing: [] };
  const missing = entry.requires.filter((group) => !group.some((t) => t in info));
  return { available: missing.length === 0, missing };
}

/** Workflows in the library whose name matches the entry, best match first. */
export function matchingWorkflows(entry: CatalogEntry, library: WorkflowSummary[]): WorkflowSummary[] {
  const scored: Array<{ w: WorkflowSummary; score: number }> = [];
  for (const w of library) {
    const name = `${w.name} ${w.ref}`;
    const i = entry.match.findIndex((re) => new RegExp(re, 'i').test(name));
    if (i >= 0) scored.push({ w, score: i });
  }
  return scored.sort((a, b) => a.score - b.score || a.w.name.localeCompare(b.w.name)).map((x) => x.w);
}

export interface AppliedValue {
  fieldId: string;
  label: string;
  from: string | number | boolean;
  to: string | number | boolean;
  why?: string;
}

export interface PresetResult {
  values: Record<string, string | number | boolean>;
  applied: AppliedValue[];
  /** Presets with no matching field in this workflow, or a value the node won't take. */
  skipped: Array<{ preset: PresetValue; reason: string }>;
}

/**
 * Compute the values a preset sets on this workflow. Pure: the caller decides
 * whether to store them (Workflow tab) or merge them for one submit (output
 * profile at generate time).
 */
export function applyPreset(
  presets: PresetValue[],
  fields: FormField[],
  api: WorkflowJson,
  current: Record<string, string | number | boolean>,
): PresetResult {
  const values: Record<string, string | number | boolean> = {};
  const applied: AppliedValue[] = [];
  const skipped: PresetResult['skipped'] = [];
  for (const p of presets) {
    const re = new RegExp(p.node);
    const targets = fields.filter((f) => f.field === p.input && re.test(api[f.nodeId]?.class_type ?? ''));
    if (!targets.length) {
      skipped.push({ preset: p, reason: `no ${p.node.replace(/[\^$]/g, '')}.${p.input} in this workflow` });
      continue;
    }
    for (const f of targets) {
      const allowed = f.optionValues ?? f.options;
      if (allowed && allowed.length && !allowed.some((o) => o === p.value)) {
        skipped.push({ preset: p, reason: `"${String(p.value)}" is not one of ${f.label}'s options here` });
        continue;
      }
      const from = f.id in current ? current[f.id] : f.value;
      values[f.id] = p.value;
      applied.push({ fieldId: f.id, label: f.label, from, to: p.value, why: p.why });
    }
  }
  return { values, applied, skipped };
}

/** Of the matching workflows, those whose name suits a tier (draft/final variant). */
export function variantFor(entry: CatalogEntry, tier: 'draft' | 'final', matches: WorkflowSummary[]): WorkflowSummary[] {
  const res = entry.variants?.[tier];
  if (!res || !res.length) return [];
  return matches.filter((w) => res.some((re) => new RegExp(re, 'i').test(`${w.name} ${w.ref}`)));
}
