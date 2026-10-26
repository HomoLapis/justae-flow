/**
 * A Hugging Face file URL, as the official templates write them in the manifests:
 *
 *   https://huggingface.co/<owner>/<repo>/resolve/<revision>/<path>[?download=true]
 *   https://huggingface.co/<owner>/<repo>/blob/<revision>/<path>      (the file's page; the LTX-2.5 manifests)
 *
 * Both name the same file. The download goes to the `resolve` form (Hugging Face's own download URL for a file —
 * comfy-cli reads both forms the same way, check_huggingface_url); the repo's page is where gated terms are accepted.
 */

export interface HfFile {
  repo: string;
  revision: string;
  /** The file's path inside the repo (decoded). */
  path: string;
  /** Where the bytes come from. */
  downloadUrl: string;
  /** The repo's page: its card, its licence, and the "Agree and access" button of a gated repo. */
  pageUrl: string;
}

export function parseHfUrl(url: string, base = 'https://huggingface.co'): HfFile | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.hostname !== 'huggingface.co' && u.hostname !== 'huggingface.com') return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length < 5 || (parts[2] !== 'resolve' && parts[2] !== 'blob')) return null;
  const repo = `${parts[0]}/${parts[1]}`;
  const revision = parts[3];
  const path = parts.slice(4).map((p) => decodeURIComponent(p)).join('/');
  const enc = path.split('/').map(encodeURIComponent).join('/');
  return { repo, revision, path, downloadUrl: `${base}/${repo}/resolve/${revision}/${enc}`, pageUrl: `https://huggingface.co/${repo}` };
}

/** "8.04 GB" · "243 MB" — decimal units, as Hugging Face shows sizes. */
export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'size unknown';
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e11 ? 0 : 1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} kB`;
  return `${n} B`;
}
