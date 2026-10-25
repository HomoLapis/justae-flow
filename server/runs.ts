/**
 * The run history estimates are made from: one line per finished run, kept in
 * the user's config folder (runs.json) — never in the project or the repo.
 *
 * Every place a job finishes writes here: the engine (layer tools, PhotoCraft
 * storyboard), the server-side Comfy API v2 path (Cloud, deployments, the
 * proxy), and the Flow window for runs on a local ComfyUI (POST /api/runs).
 * The shot's own job.json carries the same numbers next to the clip.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunRecord } from '../core/cost/estimate.ts';

const KEEP = 1000;

export class RunLog {
  private file: string;
  private runs: RunRecord[] = [];
  private listeners = new Set<(r: RunRecord) => void>();

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'runs.json');
    if (existsSync(this.file)) {
      try {
        const data = JSON.parse(readFileSync(this.file, 'utf8')) as { runs?: RunRecord[] };
        this.runs = Array.isArray(data.runs) ? data.runs : [];
      } catch { /* unreadable: start a fresh history, the old file is overwritten on the next run */ }
    }
  }

  add(r: RunRecord): void {
    // The same job reported twice (a poll and a client report) is one run.
    if (r.jobId && this.runs.some((x) => x.jobId === r.jobId && x.resourceId === r.resourceId)) return;
    this.runs.push(r);
    if (this.runs.length > KEEP) this.runs = this.runs.slice(-KEEP);
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, JSON.stringify({ schema: 1, runs: this.runs }, null, 1));
    renameSync(tmp, this.file);
    for (const fn of this.listeners) fn(r);
  }

  /** Runs of one workflow on one resource (and GPU, when it bills by GPU). */
  of(workflowId: string, resourceId: string, gpu?: string | null): RunRecord[] {
    return this.runs.filter((r) => r.workflowId === workflowId && r.resourceId === resourceId && (gpu === undefined || (r.gpu ?? null) === (gpu ?? null)));
  }

  /** Has this workflow ever finished on this resource? (A deployment has no node catalogue; a run is the proof.) */
  provenOn(resourceId: string): Map<string, string> {
    const m = new Map<string, string>();
    for (const r of this.runs) if (r.resourceId === resourceId) m.set(r.workflowId, r.at);
    return m;
  }

  recent(n = 50): RunRecord[] {
    return this.runs.slice(-n).reverse();
  }

  onAdd(fn: (r: RunRecord) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
