/**
 * Filesystem helpers. In After Effects these ran on CEP's Node; here the
 * JustAE Flow server does the work, and the page asks it. The synchronous
 * ones stay synchronous (the callers were written for Node's sync fs), which is
 * fine against a server on this same machine.
 */

import { base64FromBytes, bytesFromBase64, bytesFromBinaryString, serverHeaders, serverSync, serverUrl } from '../bridge/server';

function call(op: string, params: Record<string, unknown>): unknown {
  const r = serverSync('POST', `/api/fs/${op}`, JSON.stringify(params));
  const data = r.text ? JSON.parse(r.text) as { error?: string; result?: unknown } : {};
  if (r.status !== 200) throw new Error(data.error ?? `File operation ${op} failed (HTTP ${r.status}).`);
  return data.result;
}

export function nodeAvailable(): boolean {
  return true;
}

export function ensureDir(dir: string): void {
  call('mkdir', { path: dir });
}

export function pathJoin(...segments: string[]): string {
  const sep = segments.some((s) => s.includes('\\')) || /^[A-Za-z]:/.test(segments[0] ?? '') ? '\\' : '/';
  const parts: string[] = [];
  segments.forEach((s, i) => {
    if (!s) return;
    let p = s.replace(/[\\/]+/g, sep);
    if (i > 0) p = p.replace(new RegExp(`^\\${sep}+`), '');
    if (i < segments.length - 1) p = p.replace(new RegExp(`\\${sep}+$`), '');
    parts.push(p);
  });
  return parts.join(sep);
}

export async function writeBlobToFile(blob: Blob, filePath: string): Promise<void> {
  const r = await fetch(serverUrl('/api/fs/write-bytes', { path: filePath }), {
    method: 'POST', headers: serverHeaders({ 'Content-Type': 'application/octet-stream' }), body: blob,
  });
  if (!r.ok) throw new Error(`Could not write ${filePath}: ${(await r.text()).slice(0, 200)}`);
}

/** Read a file from disk into a Blob with the given MIME type. */
export function readFileAsBlob(filePath: string, mimeType: string): Blob {
  const r = serverSync('GET', serverUrl('/api/fs/read-bytes', { path: filePath }), undefined, true);
  if (r.status !== 200) throw new Error(`Could not read ${filePath} (HTTP ${r.status}).`);
  const bytes = bytesFromBinaryString(r.text);
  return new Blob([bytes], { type: mimeType });
}

/** A file's bytes as base64 (no `data:` prefix). */
export function readFileAsBase64(filePath: string): string {
  const r = serverSync('GET', serverUrl('/api/fs/read-bytes', { path: filePath }), undefined, true);
  if (r.status !== 200) throw new Error(`Could not read ${filePath} (HTTP ${r.status}).`);
  return base64FromBytes(bytesFromBinaryString(r.text));
}

export function readFileAsDataUrl(filePath: string, mimeType: string): string {
  return `data:${mimeType};base64,${readFileAsBase64(filePath)}`;
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  wav: 'audio/wav',
  aif: 'audio/aiff',
  aiff: 'audio/aiff',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
};

export function mimeForPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

export function basename(filePath: string): string {
  const norm = filePath.replace(/\\/g, '/');
  return norm.slice(norm.lastIndexOf('/') + 1);
}

export function copyFile(src: string, dest: string): void {
  call('copy', { src, dest });
}

/** A URL an <img>/<video> can load: the server streams the file. */
export function pathToFileUrl(absPath: string): string {
  return serverUrl('/api/fs/raw', { path: absPath });
}

export function fileSize(absPath: string): number | null {
  try {
    const st = call('stat', { path: absPath }) as { size: number } | null;
    return st ? st.size : null;
  } catch {
    return null;
  }
}

export function readTextFile(absPath: string): string {
  return call('read-text', { path: absPath }) as string;
}

export function writeTextFile(absPath: string, text: string): void {
  call('write-text', { path: absPath, text });
}

/** Files directly inside `dir` matching `filter`, newest first. [] when the dir is absent. */
export function listFiles(dir: string, filter?: RegExp): Array<{ name: string; path: string; modified: number; size: number }> {
  const all = call('list', { path: dir }) as Array<{ name: string; path: string; modified: number; size: number }>;
  return all.filter((f) => !filter || filter.test(f.name)).sort((a, b) => b.modified - a.modified);
}

export function deleteFile(absPath: string): void {
  try { call('delete', { path: absPath }); } catch { /* already gone */ }
}

export function fileMtime(absPath: string): number | null {
  try {
    const st = call('stat', { path: absPath }) as { mtime: number } | null;
    return st ? st.mtime : null;
  } catch {
    return null;
  }
}

export function fileExists(absPath: string): boolean {
  try { return call('stat', { path: absPath }) !== null; } catch { return false; }
}

export function humanSize(bytes: number | null): string {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export { bytesFromBase64 };
