/**
 * The workflows a card can use: the bundled ones (workflows/*.json, each a
 * manifest beside its API graph) and, later, the user's own folder.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkflowJson } from '../core/comfy/types.ts';
import type { WorkflowManifest } from '../core/workflows/manifest.ts';

export interface LibraryEntry {
  manifest: WorkflowManifest;
  api: WorkflowJson;
}

export class WorkflowLibrary {
  private entries = new Map<string, LibraryEntry>();
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    this.reload();
  }

  reload(): void {
    this.entries.clear();
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.json') || f.endsWith('.api.json')) continue;
      try {
        const manifest = JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as WorkflowManifest;
        const api = JSON.parse(readFileSync(join(this.dir, manifest.api), 'utf8')) as WorkflowJson;
        this.entries.set(manifest.id, { manifest, api });
      } catch (e) {
        console.warn(`[library] skipped ${f}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  get(id: string): LibraryEntry | undefined {
    return this.entries.get(id);
  }

  /** A fresh copy of the graph, safe to fill in. */
  graph(id: string): WorkflowJson | null {
    const e = this.entries.get(id);
    return e ? structuredClone(e.api) : null;
  }

  list(): WorkflowManifest[] {
    return [...this.entries.values()].map((e) => e.manifest);
  }
}
