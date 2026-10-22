/**
 * ComfyUI App Mode — reading the workflow author's own UI configuration.
 *
 * App Mode (official since 10 March 2026, front-end ≥ 1.41.13) lets a workflow
 * author pick, in App Builder, exactly which node inputs an end user should
 * see, in which order, and which outputs to show. That choice is persisted
 * *inside the workflow file*:
 *
 *   graph.extra.linearData = {
 *     inputs:  [ [widgetId, widgetName, config?], … ],   // display order
 *     outputs: [ nodeId, … ]
 *   }
 *
 * where `widgetId` is `"<graphId>:<nodeId>:<widgetName>"` with the last two
 * segments URI-encoded (older files may store a bare node id, or a
 * `"instance:node"` locator). `config` is `{ height?, description? }`.
 *
 * This is the whole point of the Workflow tab: the user arranges the panel
 * once, in ComfyUI's own builder, and the AE panel renders that arrangement
 * natively — no second configuration UI to keep in sync.
 *
 * Field names and shapes verified against ComfyUI_frontend
 * (src/stores/appModeStore.ts, src/types/widgetId.ts,
 * src/platform/workflow/management/stores/comfyWorkflow.ts).
 */

import type { WorkflowJson } from '../providers/types';
import type { UiWorkflow } from './uiconvert';

export interface AppModeInputRef {
  /** Node id in the *API* graph — already mapped through subgraph expansion. */
  nodeId: string;
  /** Input name on that node. */
  field: string;
  /** Label to show, as close to what App Builder shows as the file allows. */
  label: string;
  /** Author's note for this field, when they wrote one. */
  description?: string;
  /** Position in the author's arrangement. */
  order: number;
}

export interface AppModeConfig {
  inputs: AppModeInputRef[];
  /** Output node ids, mapped into the API graph. */
  outputs: string[];
  /** Entries we could not map — surfaced so the user isn't silently short of fields. */
  unmapped: string[];
  /** 'app' when the author set App Mode as the default view. */
  defaultView: 'app' | 'graph' | null;
}

const WIDGET_ID_RE = /^(?<graphId>[^:]+):(?<nodeId>[^:]+):(?<name>[^:]+)$/u;

interface LinearData {
  inputs?: unknown[];
  outputs?: unknown[];
}

function decodeSegment(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** Pull linearData out of a saved editor-format workflow. */
export function readLinearData(ui: unknown): LinearData | null {
  if (!ui || typeof ui !== 'object') return null;
  const extra = (ui as UiWorkflow).extra;
  if (!extra || typeof extra !== 'object') return null;
  const ld = (extra as Record<string, unknown>).linearData;
  if (!ld || typeof ld !== 'object') return null;
  return ld as LinearData;
}

/**
 * Resolve a node id from the editor graph to its id in the converted API
 * graph. Root-graph nodes keep their id; nodes that came out of a subgraph
 * carry an `instancePath:innerId` flat id, so we look for the unique key that
 * ends with the id we're after.
 */
function resolveApiNodeId(localId: string, api: WorkflowJson): string | null {
  if (api[localId]) return localId;
  const suffix = `:${localId}`;
  const matches = Object.keys(api).filter((k) => k.endsWith(suffix));
  return matches.length === 1 ? matches[0] : null;
}

/** Parse one `LinearInput` tuple into (localNodeId, widgetName). */
function parseInputTuple(entry: unknown): {
  localNodeId: string;
  field: string;
  description?: string;
} | null {
  if (!Array.isArray(entry) || entry.length < 2) return null;
  const [rawId, rawName, config] = entry as [unknown, unknown, unknown];
  const field = typeof rawName === 'string' ? rawName : null;
  if (!field) return null;

  let localNodeId: string | null = null;
  if (typeof rawId === 'string') {
    const m = WIDGET_ID_RE.exec(rawId);
    if (m?.groups) {
      localNodeId = decodeSegment(m.groups.nodeId);
    } else if (rawId.includes(':')) {
      // Legacy NodeLocatorId "<instance>:<node>" — the node is the last hop.
      localNodeId = rawId.slice(rawId.lastIndexOf(':') + 1);
    } else {
      localNodeId = rawId;
    }
  } else if (typeof rawId === 'number') {
    localNodeId = String(rawId);
  }
  if (!localNodeId) return null;

  const description =
    config && typeof config === 'object' && typeof (config as { description?: unknown }).description === 'string'
      ? (config as { description: string }).description
      : undefined;

  return { localNodeId, field, description };
}

/** Title of a node in the API graph, for labelling. */
function nodeTitle(api: WorkflowJson, nodeId: string): string {
  const n = api[nodeId];
  return n?._meta?.title || n?.class_type || `node ${nodeId}`;
}

/**
 * Build the App Mode view of a workflow. Returns null when the author never
 * configured one — callers then fall back to the heuristic inspector.
 */
export function readAppModeConfig(ui: unknown, api: WorkflowJson): AppModeConfig | null {
  const ld = readLinearData(ui);
  if (!ld) return null;
  const rawInputs = Array.isArray(ld.inputs) ? ld.inputs : [];
  const rawOutputs = Array.isArray(ld.outputs) ? ld.outputs : [];
  if (rawInputs.length === 0 && rawOutputs.length === 0) return null;

  const inputs: AppModeInputRef[] = [];
  const unmapped: string[] = [];

  rawInputs.forEach((entry, order) => {
    const parsed = parseInputTuple(entry);
    if (!parsed) { unmapped.push(JSON.stringify(entry).slice(0, 60)); return; }
    const nodeId = resolveApiNodeId(parsed.localNodeId, api);
    if (!nodeId) { unmapped.push(`${parsed.localNodeId}.${parsed.field}`); return; }
    // A widget the author exposed but that carries a wire in the API graph is
    // not user-editable — it's driven by another node.
    if (Array.isArray(api[nodeId].inputs[parsed.field])) {
      unmapped.push(`${parsed.localNodeId}.${parsed.field} (driven by a wire)`);
      return;
    }
    inputs.push({
      nodeId,
      field: parsed.field,
      // App Builder's rename is a display-only concern the file doesn't hand
      // us back, so the label is built from what it does: node title + widget.
      label: labelFor(nodeTitle(api, nodeId), parsed.field),
      description: parsed.description,
      order,
    });
  });

  const outputs: string[] = [];
  for (const raw of rawOutputs) {
    const local = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw : null;
    if (!local) continue;
    const nodeId = resolveApiNodeId(local, api);
    if (nodeId) outputs.push(nodeId);
    else unmapped.push(`output ${local}`);
  }

  const defaultView = readDefaultView(ui);

  if (inputs.length === 0 && outputs.length === 0) return null;
  return { inputs, outputs, unmapped, defaultView };
}

/**
 * `initialMode` on the workflow says which view the author wanted on open.
 * Values seen in the front-end: 'graph' | 'app' | 'builder:*'.
 */
function readDefaultView(ui: unknown): 'app' | 'graph' | null {
  if (!ui || typeof ui !== 'object') return null;
  const o = ui as Record<string, unknown>;
  const mode = typeof o.initialMode === 'string' ? o.initialMode : null;
  if (!mode) return null;
  return mode === 'app' || mode.startsWith('builder') ? 'app' : 'graph';
}

/**
 * "CLIP Text Encode (Prompt)" + "text" → "CLIP Text Encode (Prompt)".
 * When the title is generic, keep the widget name so two knobs on the same
 * node don't render as two identical rows.
 */
function labelFor(title: string, field: string): string {
  const t = title.trim();
  const f = field.replace(/_/g, ' ').trim();
  if (!t) return f;
  if (t.toLowerCase() === f.toLowerCase()) return t;
  return `${t} · ${f}`;
}
