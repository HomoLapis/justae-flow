/**
 * Where generated work lands on disk.
 *
 * Everything a generation touched stays together, next to the project, in a
 * shape you can hand to someone else six months later:
 *
 *   <project folder>/<Project>_JustAE-Flow/
 *   ├── workflows/                          the workflows used, editable
 *   └── <Comp name>/
 *       ├── shot_001_00-00-04-06/
 *       │   ├── inputs/                     frames grabbed from AE, images
 *       │   │                               edited in Photoshop, work-area clips
 *       │   ├── output/                     what came back
 *       │   └── job.json                    workflow, values, provider, timing
 *       └── shot_002_.../
 *
 * The shot folder is named after the shot's index AND its timecode, so the
 * folder order on disk matches the order on the timeline, and a folder can
 * still be traced back to the exact frame it came from after the markers move.
 *
 * When the project has never been saved there is nowhere sensible to put this,
 * so it goes to a temp folder and the panel says so — silently scattering
 * renders into %TEMP% is how work gets lost.
 */

import { ae } from '../bridge/extendscript';
import type { Settings } from '../state/store';
import { ensureDir, pathJoin, nodeAvailable, writeTextFile } from './fs';
import { timecode } from './filenames';

export interface FlowRoot {
  dir: string;
  /** False when we fell back to a temp folder because the project is unsaved. */
  inProject: boolean;
  /** Short path to show in the UI. */
  label: string;
}

/** Replace filesystem-hostile characters in a project / composition name. */
export function sanitizeName(name: string): string {
  return name
    .replace(/\.aep$/i, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'project';
}

/** The plugin's root folder for this project. */
export async function resolveFlowRoot(settings: Settings): Promise<FlowRoot> {
  if (!nodeAvailable()) {
    throw new Error('File access is only available inside the After Effects panel.');
  }

  if (settings.outputDir) {
    ensureDir(settings.outputDir);
    return { dir: settings.outputDir, inProject: false, label: settings.outputDir };
  }

  const info = await ae.projectInfo();
  if ('isSaved' in info && info.isSaved && info.dir && info.name) {
    const safe = sanitizeName(info.name);
    const dir = pathJoin(info.dir, `${safe}_JustAE-Flow`);
    ensureDir(dir);
    return { dir, inProject: true, label: `${safe}_JustAE-Flow` };
  }

  const td = await ae.tempDir();
  const tempPath = 'path' in td && td.path ? td.path : '';
  if (!tempPath) throw new Error('No usable folder — save the project, or set one in Settings.');
  const dir = pathJoin(tempPath, 'JustAE-Flow');
  ensureDir(dir);
  return { dir, inProject: false, label: 'temp/JustAE-Flow' };
}

export interface ShotFolders {
  /** The shot folder itself. */
  root: string;
  /** Inputs the generation consumed. */
  inputs: string;
  /** Files the generation produced. */
  output: string;
  /** Name of the folder, e.g. "shot_003_00-00-12-15". */
  name: string;
}

export interface ShotKey {
  compName: string;
  /** 1-based position in the batch / on the timeline. */
  index: number;
  /** Start time on the timeline, for the folder's timecode. */
  startSeconds: number;
  fps: number;
  /** Optional slug from the shot's label, e.g. the placeholder layer name. */
  label?: string;
}

export function shotFolderName(key: ShotKey): string {
  const idx = String(key.index).padStart(3, '0');
  const tc = timecode(key.startSeconds, key.fps);
  const slug = key.label
    ? '_' + key.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24)
    : '';
  return `shot_${idx}_${tc}${slug}`;
}

/** Create (and return) the folders for one shot. */
export function ensureShotFolders(root: string, key: ShotKey): ShotFolders {
  const name = shotFolderName(key);
  const shotRoot = pathJoin(root, sanitizeName(key.compName), name);
  const inputs = pathJoin(shotRoot, 'inputs');
  const output = pathJoin(shotRoot, 'output');
  ensureDir(inputs);
  ensureDir(output);
  return { root: shotRoot, inputs, output, name };
}

/**
 * A scratch folder for material captured before a shot exists — a frame grab
 * taken while the user is still deciding which workflow to run. Moved into the
 * shot's inputs/ when the generation actually happens.
 */
export function ensureCaptureFolder(root: string, compName: string): string {
  const dir = pathJoin(root, sanitizeName(compName), '_captures');
  ensureDir(dir);
  return dir;
}

/* ─── The job manifest ──────────────────────────────────────────────── */

export interface JobManifest {
  generatedAt: string;
  comp: { name: string; width: number; height: number; fps: number };
  shot: {
    index: number;
    label: string;
    startSeconds: number;
    endSeconds: number;
    durationSeconds: number;
    source: 'marker' | 'placeholder' | 'playhead';
  };
  workflow: {
    id: string;
    name: string;
    origin: string;
    ref: string;
    formSource: 'appmode' | 'inspector';
  };
  provider: { id: string; label: string; gpu?: string };
  /** Where it ran (Settings ▸ Resources) and why there: this run's pick, the task's row, or Auto. */
  resource?: { id: string; kind: string; label: string; why: string; gpu: string | null; creditsPerHour: number | null };
  /** GPU execution time the server reported (v2: metrics.execution_ms; local: its history), ms. */
  executionMs?: number | null;
  /** executionMs × the resource's rate (≈); null on your own GPU. */
  derivedCredits?: number | null;
  /** Every value the panel sent, including the ones AE filled in. */
  values: Record<string, string | number | boolean>;
  /** Which values came from After Effects rather than the user, and why. */
  aeFilled: Record<string, string>;
  /** Where the shot's prompt was written, or null when there was no prompt. */
  promptField: string | null;
  /**
   * What the panel could not take over for this shot — an unset frame size, an
   * unset clip length. Kept with the render because "why is this clip short"
   * is asked long after the panel has been closed.
   */
  warnings?: string[];
  inputs: Array<{ field: string; file: string }>;
  outputs: Array<{ file: string; nodeId: string; bucket: string }>;
  timing: { submittedAt: string; finishedAt: string; seconds: number };
  jobId: string;
  /** Conversion notes carried from the workflow, if any. */
  notes?: string[];
  /** Delivery profile applied to the save node (pipeline/catalog.ts). */
  outputProfile?: string;
  /** Draft or final render. */
  tier?: 'draft' | 'final';
  /**
   * What it cost, derived (execution seconds × the GPU's rate — no endpoint
   * returns a job's cost), next to the estimate shown before launch, so
   * estimates can be checked against reality later.
   */
  cost?: {
    derivedCredits: number | null;
    basis: string;
    gpuSeconds: number | null;
    gpu: string | null;
    estimatedCredits: [number, number | null] | null;
    estimateBasis: string | null;
    estimateText: string | null;
  };
}

/**
 * The manifest is written next to a snapshot of the exact graph that ran:
 * values without the graph they applied to aren't evidence of anything.
 */
export function writeJobManifest(shot: ShotFolders, manifest: JobManifest): string {
  const path = pathJoin(shot.root, 'job.json');
  writeTextFile(path, JSON.stringify(manifest, null, 2));
  return path;
}

export function writeWorkflowSnapshot(shot: ShotFolders, api: unknown): string {
  const path = pathJoin(shot.root, 'workflow.api.json');
  writeTextFile(path, JSON.stringify(api, null, 2));
  return path;
}
