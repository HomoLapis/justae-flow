/**
 * The workflow library.
 *
 * A workflow can come from three places, and the panel treats them alike:
 *
 *   server   the ComfyUI server's own `user/default/workflows` folder — the
 *            same list the editor's Open dialog shows. Anything saved from the
 *            embedded editor lands here, so "edit it, save it, use it next
 *            time" needs no export step at all.
 *   project  `<project>/JustAE-Flow/workflows/` next to the .aep, so a project
 *            handed to someone else carries the workflows that made it.
 *   builtin  the one bundled round-trip test.
 *   bundled  the Featured workflows the JustAE Flow server ships (workflows/*.json),
 *            built from official ComfyUI templates; read from GET /api/featured.
 *
 * Whatever the source, a record ends up holding both formats: the editor graph
 * (what you can reopen and edit) and the API graph (what /prompt accepts),
 * plus the App Mode layout when the author configured one.
 */

import type { ObjectInfo, VideoProvider, WorkflowJson } from '../providers/types';
import { convertUiToApi, isApiFormat, isUiFormat, type UiWorkflow } from './uiconvert';
import { readAppModeConfig, type AppModeConfig } from './appmode';
import { inspectWorkflow, type InspectedWorkflow } from './inspector';
import { buildForm, type WorkflowForm } from './form';
import { loadCapturedApi } from './capture';
import { listFiles, readTextFile, writeTextFile, deleteFile, pathJoin, nodeAvailable } from '../lib/fs';
import { serverHeaders } from '../bridge/server';

export type WorkflowOrigin = 'server' | 'project' | 'builtin' | 'bundled';

/** What the picker lists — cheap, no parsing. */
export interface WorkflowSummary {
  id: string;
  name: string;
  origin: WorkflowOrigin;
  /** server: path under workflows/. project: absolute path. builtin: the id. */
  ref: string;
  modified?: number;
}

/**
 * Where the API graph in a record came from. Worth naming, because the three
 * differ in how much they can be trusted: a file exported in API format and a
 * graph captured from a real run are what ComfyUI itself produced, while a
 * converted one is our reading of the editor format.
 */
export type ApiSource = 'file' | 'captured' | 'converted';

/** A workflow that has been read, converted and understood. */
export interface WorkflowRecord {
  id: string;
  name: string;
  origin: WorkflowOrigin;
  ref: string;
  /** Editor format — present unless the source was an API-format export. */
  ui: UiWorkflow | null;
  api: WorkflowJson;
  apiSource: ApiSource;
  appMode: AppModeConfig | null;
  inspected: InspectedWorkflow;
  form: WorkflowForm;
  description?: string;
  /** Conversion notes worth showing (missing node types, dropped wires). */
  problems: string[];
  loadedAt: number;
}

/* ─── Identity ──────────────────────────────────────────────────────── */

export function summaryId(origin: WorkflowOrigin, ref: string): string {
  return `${origin}:${ref}`;
}

/** "video/ltx-i2v.json" → "ltx-i2v" — what the editor shows as the tab name. */
export function displayName(ref: string): string {
  const base = ref.replace(/\\/g, '/').split('/').pop() ?? ref;
  return base.replace(/\.json$/i, '');
}

/* ─── Listing ───────────────────────────────────────────────────────── */

export async function listServerWorkflows(provider: VideoProvider): Promise<WorkflowSummary[]> {
  const store = provider.workflows?.();
  if (!store) return [];
  const files = await store.list();
  return files.map((f) => ({
    id: summaryId('server', f.path),
    name: displayName(f.path),
    origin: 'server' as const,
    ref: f.path,
    modified: f.modified,
  }));
}

/** The server's Featured workflows, as library entries ("★ LTX-2.5 · image to video"). */
export async function listBundledWorkflows(): Promise<WorkflowSummary[]> {
  const r = await fetch('/api/featured', { headers: serverHeaders() });
  if (!r.ok) return [];
  const { entries } = await r.json() as { entries: Array<{ id: string; name: string; tiers?: { draft: { workflow: string } }; draftName?: string }> };
  const out: WorkflowSummary[] = [];
  for (const e of entries) {
    out.push({ id: summaryId('bundled', e.id), name: `★ ${e.name}`, origin: 'bundled' as const, ref: e.id });
    // A Draft with a workflow of its own (MiniMax H3: the turbo 4-step LoRA) is listed beside it.
    if (e.tiers?.draft) out.push({ id: summaryId('bundled', e.tiers.draft.workflow), name: `★ ${e.name} · Draft`, origin: 'bundled' as const, ref: e.tiers.draft.workflow });
  }
  return out;
}

export function projectWorkflowDir(projectAssetsDir: string): string {
  return pathJoin(projectAssetsDir, 'workflows');
}

export function listProjectWorkflows(projectAssetsDir: string): WorkflowSummary[] {
  if (!nodeAvailable() || !projectAssetsDir) return [];
  const dir = projectWorkflowDir(projectAssetsDir);
  return listFiles(dir, /\.json$/i).map((f) => ({
    id: summaryId('project', f.path),
    name: displayName(f.name),
    origin: 'project' as const,
    ref: f.path,
    modified: f.modified,
  }));
}

/* ─── Reading ───────────────────────────────────────────────────────── */

async function readRaw(summary: WorkflowSummary, provider: VideoProvider | null): Promise<unknown> {
  if (summary.origin === 'server') {
    const store = provider?.workflows?.();
    if (!store) throw new Error('This provider has no workflow folder to read from.');
    return await store.read(summary.ref);
  }
  if (summary.origin === 'project') {
    return JSON.parse(readTextFile(summary.ref)) as unknown;
  }
  if (summary.origin === 'bundled') {
    const r = await fetch(`/api/featured/${encodeURIComponent(summary.ref)}/graph`, { headers: serverHeaders() });
    if (!r.ok) throw new Error(`The JustAE Flow server did not give "${summary.name}" (HTTP ${r.status}).`);
    return await r.json() as unknown;
  }
  throw new Error(`Unknown workflow source: ${summary.origin}`);
}

/**
 * Turn a raw file into a usable record: convert to API format if needed,
 * read the App Mode layout, inspect, and assemble the form.
 *
 * `objectInfo` is what makes the conversion possible — widget values in the
 * editor format are positional, and only the server's node schema knows which
 * input each position belongs to. Without it we can still accept a workflow
 * that was already exported in API format.
 */
export function buildRecord(args: {
  id: string;
  name: string;
  origin: WorkflowOrigin;
  ref: string;
  raw: unknown;
  objectInfo: ObjectInfo | null;
  /**
   * A graph captured from a real run of this workflow, when the user has
   * attached one. It wins over converting the file: ComfyUI compiled it, we
   * only approximate that. The editor format is still read alongside it, for
   * the App Mode layout and the description.
   */
  capturedApi?: WorkflowJson | null;
}): WorkflowRecord {
  const { id, name, origin, ref, raw, objectInfo, capturedApi } = args;

  let ui: UiWorkflow | null = null;
  let api: WorkflowJson;
  let apiSource: ApiSource;
  const problems: string[] = [];

  if (isApiFormat(raw)) {
    api = raw;
    apiSource = 'file';
  } else if (isUiFormat(raw)) {
    ui = raw;
    if (capturedApi) {
      api = capturedApi;
      apiSource = 'captured';
    } else {
      if (!objectInfo) {
        throw new Error(
          `"${name}" is in the editor format, which has to be converted before it can run. `
          + 'That needs the node list from the server — connect the provider and try again.',
        );
      }
      const converted = convertUiToApi(raw, objectInfo);
      api = converted.api;
      apiSource = 'converted';
      problems.push(...converted.problems);
    }
  } else {
    throw new Error(`"${name}" is not a ComfyUI workflow (neither editor nor API format).`);
  }

  const inspected = inspectWorkflow(api, objectInfo);
  const appMode = ui ? readAppModeConfig(ui, api) : null;
  const form = buildForm({ api, objectInfo, appMode, inspected });

  const description = ui && typeof ui.extra === 'object' && ui.extra
    ? (ui.extra as { description?: unknown }).description
    : undefined;

  return {
    id, name, origin, ref, ui, api, apiSource, appMode, inspected, form,
    description: typeof description === 'string' ? description : undefined,
    problems,
    loadedAt: Date.now(),
  };
}

export async function materialize(
  summary: WorkflowSummary,
  provider: VideoProvider | null,
  objectInfo: ObjectInfo | null,
): Promise<WorkflowRecord> {
  const raw = await readRaw(summary, provider);
  return buildRecord({
    id: summary.id,
    name: summary.name,
    origin: summary.origin,
    ref: summary.ref,
    raw,
    objectInfo,
    // Every caller gets this, not just the Workflow tab: a shot row reading its
    // own workflow must run the same graph the user captured, or a batch would
    // quietly execute a different one from the panel's preview.
    capturedApi: loadCapturedApi(summary.id),
  });
}

/* ─── Writing ───────────────────────────────────────────────────────── */

/** Sanitise a user-typed workflow name into a filename. */
export function toFileName(name: string): string {
  const clean = name
    .replace(/\.json$/i, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim()
    .slice(0, 90) || 'workflow';
  return `${clean}.json`;
}

/**
 * Save an editor-format workflow into the server's own folder, so it shows up
 * in the embedded editor's Open dialog exactly like one saved from ComfyUI.
 */
export async function saveToServer(
  provider: VideoProvider,
  name: string,
  ui: unknown,
): Promise<WorkflowSummary> {
  const store = provider.workflows?.();
  if (!store) throw new Error('This provider has no workflow folder to save into.');
  const path = toFileName(name);
  await store.save(path, ui);
  return { id: summaryId('server', path), name: displayName(path), origin: 'server', ref: path };
}

/** Save next to the .aep so the workflow travels with the project. */
export function saveToProject(
  projectAssetsDir: string,
  name: string,
  data: unknown,
): WorkflowSummary {
  const dir = projectWorkflowDir(projectAssetsDir);
  const path = pathJoin(dir, toFileName(name));
  writeTextFile(path, JSON.stringify(data, null, 2));
  return { id: summaryId('project', path), name: displayName(path), origin: 'project', ref: path };
}

export async function removeWorkflow(
  summary: WorkflowSummary,
  provider: VideoProvider | null,
): Promise<void> {
  if (summary.origin === 'server') {
    const store = provider?.workflows?.();
    if (store) await store.remove(summary.ref);
    return;
  }
  if (summary.origin === 'project') deleteFile(summary.ref);
}

/* ─── Presets ───────────────────────────────────────────────────────── */

/**
 * Values the user typed last time, per workflow. Saved so "set it up once,
 * reuse it for the next shots" holds across panel reloads and AE restarts.
 */
export type WorkflowPreset = Record<string, string | number | boolean>;

/** Start from the workflow's own values, then lay the saved preset on top. */
export function initialValues(record: WorkflowRecord, preset: WorkflowPreset | undefined): WorkflowPreset {
  const out: WorkflowPreset = {};
  for (const f of record.form.fields) out[f.id] = f.value;
  if (preset) {
    for (const [k, v] of Object.entries(preset)) {
      if (k in out) out[k] = v;   // ignore stale ids from an older version of the workflow
    }
  }
  return out;
}
