/**
 * Model files for the local ComfyUI: what the bundled workflows need, how big each file is, and the download into the
 * models folder the user set — nowhere else.
 *
 *   ModelMeta   sizes and sha256 of the manifests' files, from the Hugging Face API
 *               (GET https://huggingface.co/api/models/<repo>?blobs=true → siblings[].size, siblings[].lfs.sha256,
 *               and `gated`), read only for files a workflow lacks and kept a week in model-meta.json in the
 *               user's config folder, with the last measured download speed.
 *   Downloads   one queue, a file at a time: <models folder>/<directory>/<name>.part, resumed with a Range request,
 *               checked against the size and the sha256 Hugging Face gives, renamed on success; a mismatch is removed.
 *               The files come from the manifests only (the official templates' URLs); the route refuses any other.
 *
 * Gated repos (the Lightricks LTX-2.5 ones): their file lists are public, the bytes are not until the user accepts
 * the terms on the repo's page; a Hugging Face token, if the user gives one, is kept in hf-token.txt beside the
 * Comfy key and sent to huggingface.co only (fetch drops it on the redirect to the CDN).
 */

import { createHash, type Hash } from 'node:crypto';
import {
  createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync,
  statfsSync, writeFileSync,
} from 'node:fs';
import { once } from 'node:events';
import { dirname, join, resolve, sep } from 'node:path';
import { formatBytes, parseHfUrl } from '../core/workflows/hf.ts';
import { readSecret } from './resources.ts';

const WEEK = 7 * 24 * 3600_000;
const RETRY_AFTER_FAILURE = 10 * 60_000;

export interface RepoMeta {
  at: string;
  /** Hugging Face's `gated`: false, 'auto' (accept the terms, granted at once) or 'manual' (reviewed). */
  gated: false | 'auto' | 'manual' | null;
  /** The repo's current name when the manifest's one redirects (Comfy-Org renamed several). */
  resolved?: string;
  files: Record<string, { size: number; sha256?: string }>;
}

interface MetaFile {
  schema: 1;
  repos: Record<string, RepoMeta>;
  /** The last download's measured speed, for "≈ N min at your last measured speed". */
  speed?: { bytesPerSec: number; bytes: number; at: string };
}

export interface FileMeta {
  size: number | null;
  sha256: string | null;
  gated: boolean | null;
  /** When the size was read from Hugging Face. */
  at: string | null;
}

export class ModelMeta {
  readonly hfBase: string;
  private file: string;
  private data: MetaFile;
  private failed = new Map<string, number>();
  private inflight = new Map<string, Promise<void>>();

  constructor(dir: string, hfBase = 'https://huggingface.co') {
    this.hfBase = hfBase.replace(/\/+$/, '');
    this.file = join(dir, 'model-meta.json');
    this.data = { schema: 1, repos: {} };
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<MetaFile>;
      if (saved && typeof saved.repos === 'object') this.data = { schema: 1, repos: saved.repos ?? {}, speed: saved.speed };
    } catch { /* first use */ }
  }

  private save(): void {
    try {
      writeFileSync(this.file + '.tmp', JSON.stringify(this.data, null, 1));
      renameSync(this.file + '.tmp', this.file);
    } catch { /* the cache is a convenience */ }
  }

  /** A manifest file's size, sha256 and whether its repo is gated, from the cache (null: not read yet). */
  of(url: string): FileMeta {
    const f = parseHfUrl(url);
    const r = f ? this.data.repos[f.repo] : undefined;
    const x = f && r ? r.files[f.path] : undefined;
    return { size: x?.size ?? null, sha256: x?.sha256 ?? null, gated: r ? r.gated !== false && r.gated !== null : null, at: r?.at ?? null };
  }

  /** Whether a read of some of these repos is under way. */
  pending(urls: string[]): boolean {
    return urls.some((u) => { const f = parseHfUrl(u); return !!f && this.inflight.has(f.repo); });
  }

  /** Read the repos of these files that are not cached (or older than a week). Failures wait ten minutes. */
  ensure(urls: string[]): Promise<void> {
    const repos = new Set<string>();
    for (const u of urls) {
      const f = parseHfUrl(u);
      if (!f) continue;
      const r = this.data.repos[f.repo];
      const fresh = !!r && Date.now() - Date.parse(r.at) < WEEK && f.path in r.files;
      const recentFail = Date.now() - (this.failed.get(f.repo) ?? 0) < RETRY_AFTER_FAILURE;
      if (!fresh && !recentFail) repos.add(f.repo);
    }
    return Promise.all([...repos].map((r) => this.read(r))).then(() => undefined);
  }

  private read(repo: string): Promise<void> {
    const running = this.inflight.get(repo);
    if (running) return running;
    const p = (async () => {
      try {
        const res = await fetch(`${this.hfBase}/api/models/${repo}?blobs=true`, { signal: AbortSignal.timeout(20_000), redirect: 'follow' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = await res.json() as { id?: string; gated?: false | 'auto' | 'manual'; siblings?: Array<{ rfilename: string; size?: number; lfs?: { sha256?: string; size?: number } }> };
        const files: RepoMeta['files'] = {};
        for (const s of j.siblings ?? []) {
          const size = s.lfs?.size ?? s.size;
          if (typeof size === 'number') files[s.rfilename] = { size, ...(s.lfs?.sha256 ? { sha256: s.lfs.sha256 } : {}) };
        }
        this.data.repos[repo] = { at: new Date().toISOString(), gated: j.gated ?? false, ...(j.id && j.id !== repo ? { resolved: j.id } : {}), files };
        this.failed.delete(repo);
        this.save();
      } catch {
        this.failed.set(repo, Date.now());
      } finally {
        this.inflight.delete(repo);
      }
    })();
    this.inflight.set(repo, p);
    return p;
  }

  speed(): MetaFile['speed'] | null {
    return this.data.speed ?? null;
  }

  noteSpeed(bytes: number, ms: number): void {
    if (bytes < 1e6 || ms < 1000) return;
    this.data.speed = { bytesPerSec: Math.round(bytes / (ms / 1000)), bytes, at: new Date().toISOString() };
    this.save();
  }
}

/* ─── The models folder ────────────────────────────────────────────── */

/**
 * The folder the user named as their ComfyUI models folder: it must exist and hold `checkpoints/` or
 * `diffusion_models/` (any ComfyUI's models folder has them). A ComfyUI folder (or Comfy Desktop's shared library)
 * whose `models/` has them is taken as that `models/`, and said.
 */
export function checkModelsFolder(p: string): { ok: true; path: string; note?: string } | { ok: false; message: string } {
  const raw = p.trim().replace(/^"(.*)"$/, '$1').replace(/[\\/]+$/, '');
  if (!raw) return { ok: false, message: 'No folder given.' };
  const looks = (d: string): boolean => ['checkpoints', 'diffusion_models'].some((x) => {
    try { return statSync(join(d, x)).isDirectory(); } catch { return false; }
  });
  let st;
  try { st = statSync(raw); } catch { return { ok: false, message: `There is no folder at ${raw}.` }; }
  if (!st.isDirectory()) return { ok: false, message: `${raw} is a file, not a folder.` };
  if (looks(raw)) return { ok: true, path: raw };
  const inner = join(raw, 'models');
  if (looks(inner)) return { ok: true, path: inner, note: `Using its models folder: ${inner}` };
  return { ok: false, message: `${raw} has no checkpoints/ or diffusion_models/ folder — is it ComfyUI's models folder?` };
}

/** <folder>/<directory>/<name>, refused if it would land anywhere but inside the folder. */
export function modelPath(folder: string, directory: string, name: string): string {
  if (/(^|[\\/])\.\.([\\/]|$)/.test(directory) || /[\\/]/.test(name) || name === '..' || !name) throw new Error(`Refusing the path ${directory}/${name}.`);
  const base = resolve(folder);
  const out = resolve(base, directory, name);
  if (!out.startsWith(base + sep)) throw new Error(`Refusing the path ${directory}/${name}.`);
  return out;
}

/**
 * The file names under each model directory of the folder (sub-folders included, three deep: ComfyUI lists
 * `loras/LTX2.5/x.safetensors` as well), kept 20 s — what the folder holds when ComfyUI cannot be asked.
 */
export class FolderIndex {
  private cache = new Map<string, { at: number; names: Map<string, number> }>();

  names(folder: string, directory: string): Map<string, number> {
    const key = `${folder}|${directory}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 20_000) return hit.names;
    const names = new Map<string, number>();
    const walk = (d: string, depth: number): void => {
      let list: string[];
      try { list = readdirSync(d); } catch { return; }
      for (const n of list) {
        const abs = join(d, n);
        let st;
        try { st = statSync(abs); } catch { continue; }
        if (st.isDirectory()) { if (depth < 3) walk(abs, depth + 1); } else names.set(n, st.size);
      }
    };
    walk(join(folder, directory), 0);
    this.cache.set(key, { at: Date.now(), names });
    return names;
  }

  forget(): void {
    this.cache.clear();
  }
}

/* ─── Downloads ────────────────────────────────────────────────────── */

export interface DownloadRequest { name: string; directory: string; url: string; workflows: string[] }

export interface DownloadItem {
  key: string;
  name: string;
  directory: string;
  repo: string;
  url: string;
  pageUrl: string;
  workflows: string[];
  size: number | null;
  sha256: string | null;
  received: number;
  status: 'queued' | 'downloading' | 'verifying' | 'done' | 'skipped' | 'error' | 'cancelled';
  message?: string;
  /** 401/403 from Hugging Face: the repo's terms are not accepted (or no token). */
  gated?: boolean;
  /** Bytes already on disk from an earlier attempt, resumed with a Range request. */
  resumedFrom?: number;
  bytesPerSec?: number;
  /** The sha256 was compared with Hugging Face's (false: Hugging Face gave none; the size was checked). */
  shaChecked?: boolean;
}

export interface DownloadState {
  id: string;
  folder: string;
  items: DownloadItem[];
  running: boolean;
  startedAt: string;
  finishedAt?: string;
  /** After the queue: the local ComfyUI read again; the files it still does not list. */
  reprobe?: { at: string; stillMissing: string[]; online: boolean } | null;
}

async function hashFile(file: string, h: Hash): Promise<void> {
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
}

export class Downloads {
  private meta: ModelMeta;
  private tokenFile: string;
  private current: DownloadState | null = null;
  private abort: AbortController | null = null;
  private after: (s: DownloadState) => Promise<DownloadState['reprobe']>;
  private finished: Promise<void> = Promise.resolve();

  constructor(meta: ModelMeta, dir: string, after: (s: DownloadState) => Promise<DownloadState['reprobe']>) {
    this.meta = meta;
    this.tokenFile = join(dir, 'hf-token.txt');
    this.after = after;
  }

  /* The optional Hugging Face token: write-only, like the Comfy key. */
  hfToken(): string {
    return readSecret(this.tokenFile);
  }

  tokenView(): { set: boolean; file: string } {
    return { set: !!this.hfToken(), file: this.tokenFile };
  }

  setToken(v: string | null): void {
    const t = v?.trim() ?? '';
    if (!t) { rmSync(this.tokenFile, { force: true }); return; }
    if (/\s/.test(t)) throw new Error('A token is one line without spaces.');
    writeFileSync(this.tokenFile, t + '\n', { mode: 0o600 });
  }

  state(): DownloadState | null {
    return this.current;
  }

  /** Resolves when the queue started last has ended (the selftest waits on it). */
  done(): Promise<void> {
    return this.finished;
  }

  start(folder: string, files: DownloadRequest[]): DownloadState {
    if (this.current?.running) throw new Error('A download is already running: wait for it, or cancel it.');
    if (!files.length) throw new Error('Nothing to download.');
    const items: DownloadItem[] = [];
    for (const f of files) {
      const hf = parseHfUrl(f.url);
      if (!hf) throw new Error(`${f.name}: not a Hugging Face file URL.`);
      modelPath(folder, f.directory, f.name);
      const key = `${f.directory}/${f.name}`;
      if (items.some((x) => x.key === key)) continue;
      const m = this.meta.of(f.url);
      items.push({
        key, name: f.name, directory: f.directory, repo: hf.repo, url: f.url, pageUrl: hf.pageUrl, workflows: f.workflows,
        size: m.size, sha256: m.sha256, received: 0, status: 'queued',
      });
    }
    this.current = { id: `dl-${Date.now().toString(36)}`, folder, items, running: true, startedAt: new Date().toISOString(), reprobe: null };
    this.abort = new AbortController();
    this.finished = this.run(this.current, this.abort.signal);
    return this.current;
  }

  cancel(): void {
    this.abort?.abort();
  }

  private async run(st: DownloadState, signal: AbortSignal): Promise<void> {
    // The sizes and checksums, if they were not read yet (the list shows them; a download needs them).
    await this.meta.ensure(st.items.map((i) => i.url)).catch(() => undefined);
    for (const it of st.items) {
      const m = this.meta.of(it.url);
      it.size = m.size;
      it.sha256 = m.sha256;
    }
    for (const it of st.items) {
      if (signal.aborted) { it.status = 'cancelled'; continue; }
      try {
        await this.one(st.folder, it, signal);
      } catch (e) {
        if (signal.aborted) {
          it.status = 'cancelled';
          it.message = 'Cancelled — the part already downloaded is kept and resumes next time.';
          continue;
        }
        it.status = 'error';
        it.message = e instanceof Error ? e.message : String(e);
      }
    }
    st.running = false;
    st.finishedAt = new Date().toISOString();
    if (st.items.some((i) => i.status === 'done')) {
      try { st.reprobe = await this.after(st); } catch { st.reprobe = null; }
    }
  }

  private async one(folder: string, it: DownloadItem, signal: AbortSignal): Promise<void> {
    const target = modelPath(folder, it.directory, it.name);
    if (existsSync(target)) {
      const size = statSync(target).size;
      it.received = size;
      if (it.size === null || size === it.size) { it.status = 'skipped'; it.message = 'Already in the folder.'; return; }
      it.status = 'error';
      it.message = `A file of another size (${formatBytes(size)}, expected ${formatBytes(it.size)}) is already at ${target}: left as it is.`;
      return;
    }
    mkdirSync(dirname(target), { recursive: true });
    const part = `${target}.part`;
    let start = existsSync(part) ? statSync(part).size : 0;
    if (it.size !== null && start > it.size) { rmSync(part, { force: true }); start = 0; }
    if (it.size !== null) {
      const need = it.size - start;
      let free: number | null = null;
      try {
        const fs = statfsSync(dirname(target));
        free = Number(fs.bavail) * Number(fs.bsize);
      } catch { /* the disk could not be asked (a network share): the write itself will say */ }
      if (free !== null && free < need + 256e6) throw new Error(`Not enough space in ${dirname(target)}: ${formatBytes(need)} to write, ${formatBytes(free)} free.`);
    }
    let hash = createHash('sha256');
    it.status = 'downloading';
    // Resuming: the bytes already on disk go through the checksum first.
    if (start > 0 && it.sha256) await hashFile(part, hash);
    const hf = parseHfUrl(it.url, this.meta.hfBase)!;
    const headers: Record<string, string> = {};
    if (start > 0) headers.Range = `bytes=${start}-`;
    const token = this.hfToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(hf.downloadUrl, { headers, signal, redirect: 'follow' });
    if (res.status === 401 || res.status === 403) {
      it.gated = true;
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`This file is gated: accept the terms on Hugging Face (${hf.pageUrl}) and, if needed, paste a Hugging Face token in Settings ▸ Resources.`);
    }
    if (res.status === 416 && it.size !== null && start === it.size) {
      // Everything was already there: only the check is left.
      await res.body?.cancel().catch(() => undefined);
    } else {
      if (!res.ok || !res.body) throw new Error(`Hugging Face answered HTTP ${res.status} for ${it.name}.`);
      const append = start > 0 && res.status === 206;
      // A server that sends the whole file again (200 to a Range): start over.
      if (start > 0 && !append) { start = 0; hash = createHash('sha256'); }
      it.resumedFrom = append ? start : 0;
      it.received = start;
      const ws = createWriteStream(part, { flags: append ? 'a' : 'w' });
      const t0 = Date.now();
      let got = 0;
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          hash.update(chunk);
          got += chunk.length;
          it.received += chunk.length;
          it.bytesPerSec = Math.round(got / Math.max(0.5, (Date.now() - t0) / 1000));
          if (!ws.write(chunk)) await once(ws, 'drain');
        }
      } finally {
        ws.end();
        await once(ws, 'close').catch(() => undefined);
      }
      this.meta.noteSpeed(got, Date.now() - t0);
    }
    it.status = 'verifying';
    const size = statSync(part).size;
    it.received = size;
    if (it.size !== null && size !== it.size) {
      if (size > it.size) rmSync(part, { force: true });
      throw new Error(`The download stopped at ${formatBytes(size)} of ${formatBytes(it.size)}${size > it.size ? ' (more than expected: removed)' : ' — it resumes from there next time'}.`);
    }
    if (it.sha256) {
      const digest = hash.digest('hex');
      if (digest !== it.sha256) {
        rmSync(part, { force: true });
        throw new Error(`The file's sha256 does not match Hugging Face's (${it.sha256.slice(0, 12)}…): the download was removed. Try again.`);
      }
      it.shaChecked = true;
    } else {
      it.shaChecked = false;
    }
    renameSync(part, target);
    it.status = 'done';
    it.message = it.shaChecked
      ? `sha256 matches Hugging Face's (${it.sha256!.slice(0, 12)}…).`
      : 'Size checked (Hugging Face gives no sha256 for this file).';
  }
}
