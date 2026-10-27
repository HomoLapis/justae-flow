/**
 * Readiness: for each Featured workflow and the resource it would run on, one status a first-time user can act on —
 *
 *   ready                 every node and model is there (its probe), or a run of it finished there (a deployment)
 *   missing-models        the local ComfyUI (or the proxy in front of it) lacks model files: which, how big, from where
 *   missing-nodes         …lacks a custom-node pack: its name, to install with ComfyUI Manager
 *   not-on-this-resource  the resource cannot run it (Comfy Cloud lacks it, it refuses jobs, LTX finishing elsewhere)
 *   unknown               nobody can tell yet (a deployment that never ran it, a ComfyUI that does not answer)
 *
 * — and the "Get started" card's rules. Everything comes from the capability cache (server/capabilities.ts), the
 * manifests and the Hugging Face size cache (server/models.ts): nothing here probes a resource. The file lists are
 * always the LOCAL ComfyUI's, since that is the only place files can be downloaded to.
 *
 *   GET /api/readiness?resource=<id|default>   (server/api-setup.ts)
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatBytes, parseHfUrl } from '../core/workflows/hf.ts';
import { packsOf } from '../core/workflows/packs.ts';
import { comboOptions, type NodeCatalog } from '../core/finishing/models.ts';
import type { ModelFile } from '../core/workflows/manifest.ts';
import { FEATURED, type FeaturedDef } from './api-featured.ts';
import type { WorkflowLibrary } from './library.ts';
import { checkModelsFolder, FolderIndex, ModelMeta } from './models.ts';
import { taskOf, type Resource } from './resources.ts';
import type { Services } from './services.ts';

export type ReadyStatus = 'ready' | 'missing-models' | 'missing-nodes' | 'not-on-this-resource' | 'unknown';

export interface ReadinessFile {
  key: string;
  name: string;
  directory: string;
  repo: string;
  /** The manifest's URL (the official template's). */
  url: string;
  /** The repo's page (licence, and the terms of a gated repo). */
  pageUrl: string;
  size: number | null;
  sha256: boolean;
  /** The repo asks to accept its terms before a download (Hugging Face `gated`). */
  gated: boolean | null;
  /**
   * On the local ComfyUI: present · variant (another precision of the same weights, used instead) · missing ·
   * unknown (ComfyUI not reachable and no models folder set).
   */
  state: 'present' | 'variant' | 'missing' | 'unknown';
  /** How `state` was found: ComfyUI's own list (object_info), or the models folder on disk. */
  basis: 'comfyui' | 'folder' | null;
  using?: string;
  /** In the models folder although ComfyUI does not list it (yet). */
  onDisk?: boolean;
  /** Bytes of an interrupted download (.part) waiting to resume. */
  partial?: number;
  /** Only the Draft tier's workflow needs it (MiniMax H3's turbo LoRA). */
  draftOnly?: boolean;
  /** Not needed: an alternative for some users (the manifest's `optional`, e.g. "for GPUs with 32 GB or more"). Never counted as missing. */
  optional?: string;
}

export interface ReadinessPack { id: string; name: string; repo: string; classes: string[]; installed: boolean | null }

export interface ReadinessEntry {
  id: string;
  name: string;
  line: string;
  group: FeaturedDef['group'];
  title: string;
  /** On the selected resource ("Running on"), or the one Default routes it to. */
  status: ReadyStatus;
  chip: string;
  note?: string;
  on: { id: string; label: string; kind: Resource['kind'] } | null;
  /** On the local ComfyUI, whatever is selected: what downloading changes. */
  local: { status: ReadyStatus; chip: string; note?: string };
  files: ReadinessFile[];
  missing: { count: number; bytes: number; unknownSizes: number };
  packs: ReadinessPack[];
  licence: FeaturedDef['licence'];
  licenceNote?: string;
  tiers?: FeaturedDef['tiers'];
  draftName?: string;
  comp?: FeaturedDef['comp'];
  /** Elsewhere: every resource's status, for the card's details. */
  elsewhere: Array<{ id: string; label: string; kind: Resource['kind']; status: ReadyStatus; chip: string; note?: string }>;
}

export interface Readiness {
  resource: { id: string; label: string; kind: Resource['kind'] | 'default'; usable: boolean; online: boolean | null; reason?: string };
  entries: ReadinessEntry[];
  counts: { total: number; ready: number; missingModels: number; missingNodes: number; notHere: number; unknown: number };
  /** Files the local ComfyUI lacks across all entries, each counted once. */
  missing: { files: number; bytes: number; unknownSizes: number };
  local: {
    id: string; url: string; online: boolean | null; version?: string; device?: string; message?: string;
    modelsDir: string | null; folder: { ok: boolean; message?: string } | null;
  };
  /** Resources that can take a job now and answered their probe. */
  usable: Array<{ id: string; label: string; kind: Resource['kind'] }>;
  speed: { bytesPerSec: number; at: string } | null;
  sizes: { pending: boolean; basis: string };
  /**
   * The suggested first download: Z-Image alone (one workflow, not gated); then, as a second step, LTX-2.5 image to
   * video, whose repo is gated (its terms first). `gated`: true when a file of it is gated, false when none is, null
   * while Hugging Face has not said.
   */
  suggestion: SuggestionPart & { then: SuggestionPart & { pages: string[] } };
  onboarding: { show: boolean; mode: OnboardingMode; reasons: string[]; firstRun: boolean; testImageAt: string | null; nothingUsable: boolean };
}

export interface SuggestionPart { ids: string[]; label: string; files: number; bytes: number; unknownSizes: number; gated: boolean | null }

/* ─── Get started: the user's flag ─────────────────────────────────── */

/** auto: shown when a rule asks · hidden: the user hid it (Settings or the pill bring it back) · open: shown until hidden. */
export type OnboardingMode = 'auto' | 'hidden' | 'open';

export class Onboarding {
  private file: string;
  private data: { mode?: OnboardingMode; testImageAt?: string; hiddenAt?: string };

  constructor(dir: string) {
    this.file = join(dir, 'onboarding.json');
    try { this.data = JSON.parse(readFileSync(this.file, 'utf8')) as typeof this.data; } catch { this.data = {}; }
  }

  private save(): void {
    writeFileSync(this.file + '.tmp', JSON.stringify(this.data, null, 2));
    renameSync(this.file + '.tmp', this.file);
  }

  mode(): OnboardingMode {
    return this.data.mode ?? 'auto';
  }

  /** No flag written yet: the first run. */
  firstRun(): boolean {
    return !this.data.mode && !this.data.testImageAt;
  }

  testImageAt(): string | null {
    return this.data.testImageAt ?? null;
  }

  setMode(mode: OnboardingMode): void {
    this.data.mode = mode;
    if (mode === 'hidden') this.data.hiddenAt = new Date().toISOString();
    this.save();
  }

  noteTestImage(): void {
    this.data.testImageAt = new Date().toISOString();
    this.save();
  }
}

/** The suggested first download: Z-Image alone (not gated), then LTX-2.5 image to video (gated: its terms first). */
export const SUGGESTED = {
  ids: ['zimage-t2i'], label: 'Start with Z-Image',
  then: { ids: ['ltx25-i2v'], label: 'then LTX-2.5 image to video (accept the Hugging Face terms first)' },
};

/* ─── Readiness ────────────────────────────────────────────────────── */

const CHIP: Record<ReadyStatus, string> = {
  ready: 'Ready', 'missing-models': 'Missing models', 'missing-nodes': 'Needs custom nodes', 'not-on-this-resource': 'Not on this resource', unknown: 'Unknown here',
};

export interface ReadinessDeps {
  services: Services;
  library: WorkflowLibrary;
  meta: ModelMeta;
  folders: FolderIndex;
  onboarding: Onboarding;
}

/**
 * The manifest files a workflow's graph uses (a manifest may list a file only another precision of the graph names),
 * and the ones it lists as optional (not in the graph: an alternative for some users).
 */
function graphFiles(library: WorkflowLibrary, id: string): ModelFile[] {
  const e = library.get(id);
  const g = library.graph(id);
  if (!e || !g) return [];
  const text = JSON.stringify(g);
  return e.manifest.models.filter((x) => x.optional || text.includes(JSON.stringify(x.name)));
}

/** True when one of the graph's loader nodes offers the file (an optional file: the probe never looked for it). */
function listedBy(oi: NodeCatalog, classes: Set<string>, name: string): boolean {
  for (const c of classes) {
    const spec = oi[c]?.input;
    if (!spec) continue;
    for (const field of Object.keys({ ...(spec.required ?? {}), ...(spec.optional ?? {}) })) {
      if (comboOptions(oi, c, field).some((o) => o === name || o.split('/').pop() === name)) return true;
    }
  }
  return false;
}

export function readiness(d: ReadinessDeps, resourceParam?: string | null): Readiness {
  const { services: s, library } = d;
  const reg = s.resources;
  const local = reg.local();
  const localCaps = s.caps.cached(local.id);
  const folderRaw = local.modelsDir ?? null;
  const folderCheck = folderRaw ? checkModelsFolder(folderRaw) : null;
  const folder = folderCheck?.ok ? folderCheck.path : null;
  const choice = resourceParam && resourceParam !== '' ? resourceParam : reg.choice();
  const picked = choice !== 'default' && choice !== 'auto' ? reg.get(choice) : undefined;
  const fronting = (r: Resource): boolean => r.kind === 'local' || (r.kind === 'proxy' && r.fronts === local.id);

  /** One workflow on one resource. */
  const statusOn = (id: string, r: Resource): { status: ReadyStatus; note?: string } => {
    const m = library.get(id)?.manifest;
    const can = reg.canTakeJobs(r);
    if (!can.ok) return { status: 'not-on-this-resource', note: `${r.label}: ${can.reason}` };
    if (m?.task === 'finish-video' && !fronting(r) && s.caps.has(r, id) !== 'ok') {
      return { status: 'not-on-this-resource', note: 'LTX finishing runs on your local ComfyUI (no LTX-2.5 model is known here).' };
    }
    const caps = s.caps.cached(r.id);
    if (!caps) return { status: 'unknown', note: `${r.label} has not been checked yet.` };
    const w = caps.workflows[id];
    if (w?.status === 'proven') return { status: 'ready', note: `A run of it finished here${w.provenAt ? ` on ${w.provenAt.slice(0, 10)}` : ''}.` };
    if (!caps.online) return { status: 'unknown', note: `${r.label} does not answer${caps.message ? `: ${caps.message}` : ''}.` };
    if (!w || w.status === 'unknown') {
      return {
        status: 'unknown',
        note: r.kind === 'deployment' || r.kind === 'proxy'
          ? 'Not run here yet: a deployment has no list of its nodes and models, so it is known once a run of it has finished here.'
          : caps.nodes.known ? caps.models.basis : caps.nodes.basis,
      };
    }
    if (w.status === 'ok') {
      return { status: 'ready', note: w.remaps.length ? `Uses your own precision of ${w.remaps.length} file${w.remaps.length === 1 ? '' : 's'} (Files, below).` : undefined };
    }
    if (fronting(r)) {
      if (w.missingNodes.length) return { status: 'missing-nodes', note: `Node classes not installed: ${w.missingNodes.join(', ')}.` };
      return { status: 'missing-models', note: `Model files not on this ComfyUI: ${w.missingModels.join(', ')}.` };
    }
    return { status: 'not-on-this-resource', note: `${r.label} lacks ${[...w.missingNodes, ...w.missingModels].slice(0, 3).join(', ')}.` };
  };

  const localOi = s.caps.objectInfo(local.id);
  const urls: string[] = [];
  const entries: ReadinessEntry[] = [];
  const uniqueMissing = new Map<string, number | null>();

  for (const f of FEATURED) {
    const entry = library.get(f.id);
    if (!entry) continue;
    const m = entry.manifest;
    const ids = [f.id, ...(f.tiers ? [f.tiers.draft.workflow] : [])];
    // Files: the entry's, then the Draft tier's own (H3's turbo LoRA).
    const files: ReadinessFile[] = [];
    for (const wid of ids) {
      const w = localCaps?.workflows[wid];
      const classes = new Set(Object.values(library.graph(wid) ?? {}).map((n) => n.class_type));
      for (const x of graphFiles(library, wid)) {
        const key = `${x.directory}/${x.name}`;
        if (files.some((y) => y.key === key)) continue;
        const hf = parseHfUrl(x.url);
        const meta = d.meta.of(x.url);
        let state: ReadinessFile['state'] = 'unknown';
        let basis: ReadinessFile['basis'] = null;
        let using: string | undefined;
        const onDiskSize = folder ? d.folders.names(folder, x.directory).get(x.name) : undefined;
        const partial = folder ? d.folders.names(folder, x.directory).get(`${x.name}.part`) : undefined;
        if (x.optional && localCaps?.online && localOi) {
          basis = 'comfyui';
          state = listedBy(localOi as unknown as NodeCatalog, classes, x.name) ? 'present' : 'missing';
        } else if (x.optional && folder) {
          basis = 'folder';
          state = onDiskSize !== undefined ? 'present' : 'missing';
        } else if (x.optional) {
          // unknown: no ComfyUI to ask, no folder to look in
        } else if (localCaps?.online && w && localCaps.models.known) {
          basis = 'comfyui';
          const remap = w.remaps.find((r) => r.startsWith(`${x.name} → `));
          if (w.missingModels.includes(x.name)) state = 'missing';
          else if (remap) { state = 'variant'; using = remap.split(' → ')[1]; }
          else state = 'present';
        } else if (folder) {
          basis = 'folder';
          state = onDiskSize !== undefined ? 'present' : 'missing';
        }
        urls.push(x.url);
        files.push({
          key, name: x.name, directory: x.directory, repo: hf?.repo ?? '', url: x.url, pageUrl: hf?.pageUrl ?? x.url,
          size: meta.size, sha256: !!meta.sha256, gated: meta.gated, state, basis, using,
          ...(onDiskSize !== undefined && state === 'missing' && basis === 'comfyui' ? { onDisk: true } : {}),
          ...(partial !== undefined ? { partial } : {}),
          ...(wid !== f.id ? { draftOnly: true } : {}),
          ...(x.optional ? { optional: x.optional } : {}),
        });
      }
    }
    const missingFiles = files.filter((x) => x.state === 'missing' && !x.onDisk && !x.optional);
    for (const x of missingFiles) uniqueMissing.set(x.key, x.size);
    const missing = {
      count: missingFiles.length,
      bytes: missingFiles.reduce((a, x) => a + (x.size ?? 0), 0),
      unknownSizes: missingFiles.filter((x) => x.size === null).length,
    };

    // Packs: those the graphs use, installed or not on the local ComfyUI.
    const classes = new Set<string>();
    for (const wid of ids) for (const n of Object.values(library.graph(wid) ?? {})) classes.add(n.class_type);
    const packs: ReadinessPack[] = packsOf(classes).map((p) => ({
      id: p.id, name: p.name, repo: p.repo, classes: p.used, installed: localOi ? p.used.every((c) => !!localOi[c]) : null,
    }));

    const chipOf = (st: { status: ReadyStatus; note?: string }): string => {
      if (st.status === 'missing-models') {
        const n = missing.count;
        if (!n) return 'Missing models';
        return `Missing ${n} model${n === 1 ? '' : 's'}${missing.bytes ? ` · ${formatBytes(missing.bytes)}${missing.unknownSizes ? '+' : ''}` : ''}`;
      }
      if (st.status === 'missing-nodes') {
        const lacking = packs.filter((p) => p.installed === false);
        return lacking.length === 1 ? `Needs the ${lacking[0].name} pack` : lacking.length ? `Needs ${lacking.length} node packs` : CHIP['missing-nodes'];
      }
      return CHIP[st.status];
    };

    const route = picked ?? reg.resolve(taskOf(m.task, m.id), choice === 'auto' ? 'auto' : null, (r) => s.caps.has(r, f.id)).resource;
    const sel = statusOn(f.id, route);
    const loc = statusOn(f.id, local);
    const elsewhere = reg.list().filter((r) => r.enabled || r.kind === 'local').map((r) => {
      const st = statusOn(f.id, r);
      return { id: r.id, label: r.label, kind: r.kind, status: st.status, chip: chipOf(st), note: st.note };
    });
    entries.push({
      id: f.id, name: f.name, line: f.line, group: f.group, title: m.title,
      status: sel.status, chip: chipOf(sel), note: sel.note, on: { id: route.id, label: route.label, kind: route.kind },
      local: { status: loc.status, chip: chipOf(loc), note: loc.note },
      files, missing, packs, licence: f.licence, licenceNote: f.licenceNote, tiers: f.tiers, comp: f.comp,
      draftName: f.tiers ? library.get(f.tiers.draft.workflow)?.manifest.title : undefined,
      elsewhere,
    });
  }

  // Sizes, checksums and gating: read from Hugging Face's public API (one call per repo, kept a week).
  const wanted = entries.flatMap((e) => e.files.map((x) => x.url));
  void d.meta.ensure(wanted).catch(() => undefined);

  const count = (st: ReadyStatus): number => entries.filter((e) => e.status === st).length;
  const counts = {
    total: entries.length, ready: count('ready'), missingModels: count('missing-models'), missingNodes: count('missing-nodes'),
    notHere: count('not-on-this-resource'), unknown: count('unknown'),
  };
  const missingAll = {
    files: uniqueMissing.size,
    bytes: [...uniqueMissing.values()].reduce<number>((a, v) => a + (v ?? 0), 0),
    unknownSizes: [...uniqueMissing.values()].filter((v) => v === null).length,
  };

  /** One part of the suggestion: what its workflows lack (each file once), and whether any of their repos is gated. */
  const part = (ids: string[], label: string): SuggestionPart & { pages: string[] } => {
    const need = new Map<string, number | null>();
    const all: ReadinessFile[] = [];
    for (const id of ids) {
      for (const x of entries.find((e) => e.id === id)?.files ?? []) {
        if (x.draftOnly || x.optional) continue;
        all.push(x);
        if (x.state === 'missing' && !x.onDisk) need.set(x.key, x.size);
      }
    }
    const gated = all.some((x) => x.gated === true) ? true : all.length && all.every((x) => x.gated === false) ? false : null;
    return {
      ids, label, files: need.size, bytes: [...need.values()].reduce<number>((a, v) => a + (v ?? 0), 0),
      unknownSizes: [...need.values()].filter((v) => v === null).length, gated,
      pages: [...new Set(all.filter((x) => x.gated).map((x) => x.pageUrl))],
    };
  };
  const { pages: _pages, ...first } = part(SUGGESTED.ids, SUGGESTED.label);

  const usable = reg.list().filter((r) => reg.canTakeJobs(r).ok && s.caps.cached(r.id)?.online === true).map((r) => ({ id: r.id, label: r.label, kind: r.kind }));
  const reasons: string[] = [];
  if (d.onboarding.firstRun()) reasons.push('first-run');
  if (!usable.length) reasons.push('nothing-usable');
  if (counts.ready < counts.total / 2) reasons.push('few-ready');
  const mode = d.onboarding.mode();
  const show = mode === 'open' || (mode === 'auto' && reasons.length > 0);

  const sp = d.meta.speed();
  const pickedCan = picked ? reg.canTakeJobs(picked) : null;
  return {
    resource: picked
      ? { id: picked.id, label: picked.label, kind: picked.kind, usable: !!pickedCan?.ok, online: s.caps.cached(picked.id)?.online ?? null, reason: pickedCan?.reason }
      : { id: 'default', label: 'Default', kind: 'default', usable: true, online: null },
    entries,
    counts,
    missing: missingAll,
    local: {
      id: local.id, url: local.url, online: localCaps ? localCaps.online : null, version: localCaps?.version, device: localCaps?.device, message: localCaps?.message,
      modelsDir: folderRaw, folder: folderCheck ? (folderCheck.ok ? { ok: true, message: folderCheck.note } : { ok: false, message: folderCheck.message }) : null,
    },
    usable,
    speed: sp ? { bytesPerSec: sp.bytesPerSec, at: sp.at } : null,
    sizes: { pending: d.meta.pending(wanted), basis: 'Hugging Face API (file sizes, sha256 and gating of each repo), kept a week' },
    suggestion: { ...first, then: part(SUGGESTED.then.ids, SUGGESTED.then.label) },
    onboarding: { show, mode, reasons, firstRun: d.onboarding.firstRun(), testImageAt: d.onboarding.testImageAt(), nothingUsable: !usable.length },
  };
}

/**
 * A download request, checked: only files a bundled manifest names, with the URL that manifest gives (when the request
 * names the URL — a file two manifests take from two repos — it must be one of theirs).
 */
export function catalogueFiles(library: WorkflowLibrary, want: Array<{ directory: string; name: string; url?: string }>): Array<{ name: string; directory: string; url: string; workflows: string[] }> {
  const out: Array<{ name: string; directory: string; url: string; workflows: string[] }> = [];
  for (const w of want) {
    const same = (x: { name: string; directory: string; url: string }): boolean => x.name === w.name && x.directory === w.directory && (!w.url || x.url === w.url);
    const users = library.list().filter((m) => m.models.some(same));
    const file = users[0]?.models.find(same);
    if (!file) throw new Error(`${w.directory}/${w.name} is not a file of a bundled workflow.`);
    out.push({ name: file.name, directory: file.directory, url: file.url, workflows: users.map((m) => m.id) });
  }
  return out;
}
