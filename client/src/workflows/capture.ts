/**
 * Adopting the graph ComfyUI itself compiled.
 *
 * The panel's own `uiconvert.ts` reads the editor format and rebuilds the API
 * graph. It is a careful piece of work and it is still an approximation:
 * measured over twenty real workflows from a live server, two failed outright
 * and several silently dropped links. Both failures were files full of
 * bypassed and muted nodes, where the right answer is not "drop the wire" but
 * "re-route it through the node by type" — a rule ComfyUI's front-end has and
 * we re-derived.
 *
 * There is no need to re-derive it. When the user runs a workflow in the
 * editor, ComfyUI compiles the graph itself, in a current browser, with every
 * custom node installed, and keeps the result in `/history`. That graph is
 * correct by construction. This module takes it.
 *
 * The join is deliberately NOT automatic. A workflow file carries an `id`, and
 * it looked like the obvious key until it was counted: across 281 workflow
 * files on a real server there were 104 distinct ids, 45 files with none at
 * all, one id shared by 47 files and another by 41 — ComfyUI copies the id when
 * a workflow is duplicated, so it identifies a lineage, not a file. Guessing
 * with it would attach a captured graph to the wrong workflow, which is worse
 * than not capturing at all: the panel would then run something the user never
 * chose. So the user says which workflow the run belongs to, by having it
 * selected, and this module's job is to CHECK that claim and store the result.
 */

import type { RecentRun, WorkflowJson } from '../providers/types';
import { inspectWorkflow, type OutputKind } from './inspector';
import { lsGet, lsSet } from '../state/persistence';
import {
  deleteFile, ensureDir, fileExists, nodeAvailable, pathJoin, readTextFile, writeTextFile,
} from '../lib/fs';

/* ─── Comparing two graphs ──────────────────────────────────────────── */

/** How well a captured run matches the workflow it is being attached to. */
export type MatchVerdict = 'identical' | 'same-shape' | 'similar' | 'different';

export interface GraphComparison {
  verdict: MatchVerdict;
  /** Node types present in both, counted. */
  shared: number;
  /** Node types the selected workflow has and the run doesn't. */
  missing: string[];
  /** Node types the run has and the selected workflow doesn't. */
  extra: string[];
}

/** Multiset of class_types, as a sorted "type×count" list. */
function classCounts(wf: WorkflowJson): Map<string, number> {
  const counts = new Map<string, number>();
  for (const node of Object.values(wf)) {
    const t = node?.class_type;
    if (typeof t !== 'string') continue;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return counts;
}

/**
 * Is this run plausibly the workflow the user has selected?
 *
 * Compared by node type and count rather than by node id or value, because the
 * two graphs legitimately differ: the panel's conversion numbers nodes its own
 * way, and the user will have typed a different prompt or seed before running.
 * What must not differ is what the graph is made of.
 *
 * A bypassed node is the interesting case and the reason `different` is not
 * simply "any mismatch": bypassing a LoRA in the editor genuinely removes it
 * from the executed graph, so a run can honestly have fewer node types than the
 * file. That shows up as `missing`, and the caller says so rather than refusing.
 */
export function compareGraphs(selected: WorkflowJson, run: WorkflowJson): GraphComparison {
  const a = classCounts(selected);
  const b = classCounts(run);

  const missing: string[] = [];
  const extra: string[] = [];
  let shared = 0;

  for (const [type, count] of a) {
    const other = b.get(type) ?? 0;
    shared += Math.min(count, other);
    if (other === 0) missing.push(type);
  }
  for (const [type] of b) if (!a.has(type)) extra.push(type);

  const sizeA = [...a.values()].reduce((n, x) => n + x, 0);
  const sizeB = [...b.values()].reduce((n, x) => n + x, 0);
  const union = sizeA + sizeB - shared;
  const overlap = union === 0 ? 0 : shared / union;

  let verdict: MatchVerdict;
  if (missing.length === 0 && extra.length === 0 && sizeA === sizeB) {
    verdict = a.size === b.size && [...a].every(([t, n]) => b.get(t) === n)
      ? 'identical'
      : 'same-shape';
  } else if (overlap >= 0.6) {
    verdict = 'similar';
  } else {
    verdict = 'different';
  }

  return { verdict, shared, missing: missing.sort(), extra: extra.sort() };
}

/* ─── Describing a run for the UI ───────────────────────────────────── */

export interface RunDescription {
  promptId: string;
  /** True when this panel submitted it — those are not worth offering back. */
  mine: boolean;
  /** Somebody pressed Run in the ComfyUI editor. */
  fromEditor: boolean;
  nodeCount: number;
  /** Present only when the client sent the editor graph along. */
  hasEditorGraph: boolean;
  outputKind: OutputKind;
  createdAt: number | null;
}

export function describeRun(run: RecentRun, ourClientId: string): RunDescription {
  let outputKind: OutputKind = 'image';
  try {
    outputKind = inspectWorkflow(run.api).primaryOutputKind;
  } catch {
    /* a graph we can't read is still a graph we can capture */
  }
  return {
    promptId: run.promptId,
    mine: !!run.clientId && run.clientId === ourClientId,
    fromEditor: run.usageSource === 'comfyui-frontend',
    nodeCount: Object.keys(run.api).length,
    hasEditorGraph: !!run.ui,
    outputKind,
    createdAt: run.createdAt,
  };
}

/**
 * Which run to offer, out of the last few.
 *
 * Not simply "the newest one that isn't ours". A busy server has other API
 * clients on it — another panel, a script — and their prompts are in the same
 * history. The run the user means is the one they just pressed Run on in the
 * editor, and the server labels exactly that: `comfy_usage_source` is
 * `comfyui-frontend` for those and absent for everything POSTing to /prompt
 * (measured across ten consecutive runs on a live server, where only the
 * editor's carried the label — and only that one carried the editor graph too).
 *
 * The fallbacks still exist, because a run without the label is a real graph
 * and adopting it is legitimate; it just isn't the first guess.
 */
export function pickRunToOffer(runs: RecentRun[], ourClientId: string): RecentRun | null {
  const notMine = runs.filter((r) => r.clientId !== ourClientId);
  return notMine.find((r) => r.usageSource === 'comfyui-frontend')
    ?? notMine[0]
    ?? runs[0]
    ?? null;
}

/* ─── Storing what was captured ─────────────────────────────────────── */

export interface CaptureMeta {
  workflowId: string;
  promptId: string;
  capturedAt: number;
  nodeCount: number;
  verdict: MatchVerdict;
  /** Absolute path of the stored graph. Null when it lives only in memory. */
  path: string | null;
}

type CaptureIndex = Record<string, CaptureMeta>;

const INDEX_KEY = 'captures';

/**
 * Session-only home for captured graphs.
 *
 * Used when there is no filesystem — the panel running in a browser for
 * development — and as the read cache in every case, because a captured graph
 * is read on every workflow selection and can be a few hundred kilobytes.
 */
const memory = new Map<string, WorkflowJson>();

export function captureIndex(): CaptureIndex {
  return lsGet<CaptureIndex>(INDEX_KEY, {});
}

export function captureFor(workflowId: string): CaptureMeta | null {
  return captureIndex()[workflowId] ?? null;
}

/** A workflow id ("server:video/ltx.json") as something a filesystem accepts. */
function captureFileName(workflowId: string): string {
  const safe = workflowId.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
  return `${safe}.api.json`;
}

export function captureDir(flowRootDir: string): string {
  return pathJoin(flowRootDir, 'workflows', 'captured');
}

/**
 * Keep a captured graph, on disk when there is one.
 *
 * Disk rather than localStorage: these are whole graphs, a few hundred
 * kilobytes each for the large workflows, and localStorage is a few megabytes
 * for everything the panel stores put together. The index stays in
 * localStorage because it is small and has to be readable before any path is
 * resolved.
 */
export function rememberCapture(args: {
  workflowId: string;
  api: WorkflowJson;
  promptId: string;
  verdict: MatchVerdict;
  /** Where the project's JustAE folder is, when the project has been saved. */
  flowRootDir: string | null;
}): CaptureMeta {
  const { workflowId, api, promptId, verdict, flowRootDir } = args;

  let path: string | null = null;
  if (flowRootDir && nodeAvailable()) {
    const dir = captureDir(flowRootDir);
    ensureDir(dir);
    path = pathJoin(dir, captureFileName(workflowId));
    writeTextFile(path, JSON.stringify(api, null, 2));
  }
  memory.set(workflowId, api);

  const meta: CaptureMeta = {
    workflowId,
    promptId,
    capturedAt: Date.now(),
    nodeCount: Object.keys(api).length,
    verdict,
    path,
  };
  lsSet(INDEX_KEY, { ...captureIndex(), [workflowId]: meta });
  return meta;
}

/**
 * The captured graph for a workflow, if there is one.
 *
 * Never throws: a capture that cannot be read is a capture that isn't there,
 * and the caller falls back to converting. Losing the file is not a reason to
 * make the workflow unusable.
 */
export function loadCapturedApi(workflowId: string): WorkflowJson | null {
  const cached = memory.get(workflowId);
  if (cached) return cached;

  const meta = captureFor(workflowId);
  if (!meta?.path || !nodeAvailable()) return null;
  try {
    if (!fileExists(meta.path)) return null;
    const api = JSON.parse(readTextFile(meta.path)) as WorkflowJson;
    if (!api || typeof api !== 'object') return null;
    memory.set(workflowId, api);
    return api;
  } catch {
    return null;
  }
}

/** Drop a capture and go back to converting the file. */
export function forgetCapture(workflowId: string): void {
  const meta = captureFor(workflowId);
  memory.delete(workflowId);
  const next = { ...captureIndex() };
  delete next[workflowId];
  lsSet(INDEX_KEY, next);
  if (meta?.path && nodeAvailable()) {
    try { deleteFile(meta.path); } catch { /* already gone — nothing to undo */ }
  }
}
