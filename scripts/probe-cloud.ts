/**
 * What Comfy Cloud offers this account, read-only: no job is submitted, so
 * nothing here costs a credit.
 *
 *   node scripts/probe-cloud.ts [--out <folder>]
 *
 * The key is read from the user's config folder (`comfy-api-key.txt` next to
 * settings.json, one line) and is never printed, logged or written anywhere.
 * Without it only the public endpoints are probed (model folders, system stats,
 * feature flags) and the rest is reported as skipped.
 *
 * Endpoints, from the v1 Cloud OpenAPI document (docs.comfy.org/openapi-cloud.yaml)
 * and the v2 SDK (@comfyorg/sdk 0.5.0):
 *   v1, header X-API-Key   GET /api/billing/usage/timeseries  GET /api/object_info  GET /api/user
 *                          GET /api/features  GET /api/jobs?limit=1
 *   v1, public             GET /api/experiment/models  GET /api/experiment/models/{folder}  GET /api/system_stats
 *   v2, Bearer             GET /api/v2/jobs?limit=1  ·  SDK listJobs() and jobs.get(<unknown id>)
 *
 * Raw answers go to --out (default: <temp>/JustAE Flow/cloud-probe); the summary
 * goes to stdout. Balance and spend are printed: they are this account's, so
 * keep the output out of the repository.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDir } from '../server/config.ts';

const CLOUD_BASE = 'https://cloud.comfy.org';

/**
 * Node classes worth asking about beyond the bundled workflows: the ones the
 * pipeline catalogue requires (client/src/pipeline/catalog.ts) and the ones
 * the roadmap tools would use (PLAN v3 §4.2). Names as the local ComfyUI 0.38
 * object_info spells them.
 */
const CATALOG_NODES = [
  'SAM3_VideoTrack', 'SAM3_TrackToMask', 'SAM3_Detect',
  'WanVaceToVideo',
  'SeedVR2Conditioning', 'SeedVR2Preprocess', 'SeedVR2PostProcessing', 'SeedVR2TemporalChunk', 'SeedVR2TemporalMerge', 'SeedVR2VideoUpscaler',
  'MiniMaxH3ImageToVideo', 'MiniMaxH3ReferenceToVideo', 'MiniMaxH3AddGuide', 'EmptyMiniMaxH3LatentAV',
  'LTXVImgToVideo', 'LTXVImgToVideoInplace', 'EmptyLTXVLatentVideo', 'LTXVAddGuide', 'LTXVLatentUpsampler', 'LTXVDualCFGGuider', 'TextGenerateLTX2Prompt',
  'RIFE VFI', 'GIMMVFI_interpolate',
  'WanFirstLastFrameToVideo', 'Wan22ImageToVideoLatent', 'Wan22FunControlToVideo',
  'RemoveBackground', 'LoadBackgroundRemovalModel',
  'TextEncodeQwenImageEditPlus', 'FluxKontextMultiReferenceLatentMethod',
  'WanVideoFlashVSRDecoderLoader', 'SmartUpscaledTilePlanner',
];

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outArg = process.argv.indexOf('--out');
const out = outArg > 0 ? process.argv[outArg + 1] : join(tmpdir(), 'JustAE Flow', 'cloud-probe');
mkdirSync(out, { recursive: true });

const keyFile = join(configDir(), 'comfy-api-key.txt');
const key = existsSync(keyFile) ? readFileSync(keyFile, 'utf8').split(/\r?\n/)[0].trim() : '';

interface Answer { path: string; status: number; ms: number; body: unknown; text: string }

async function get(path: string, auth: 'none' | 'v1' | 'v2'): Promise<Answer> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (auth === 'v1') headers['X-API-Key'] = key;
  if (auth === 'v2') headers.Authorization = `Bearer ${key}`;
  const t0 = Date.now();
  const r = await fetch(CLOUD_BASE + path, { headers, signal: AbortSignal.timeout(240_000) });
  const text = await r.text();
  let body: unknown = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  const a = { path, status: r.status, ms: Date.now() - t0, body, text: body === null ? text.slice(0, 300) : '' };
  const file = path.replace(/^\/api\//, '').replace(/[^\w.-]+/g, '_').slice(0, 120) || 'root';
  writeFileSync(join(out, `${auth}_${file}.json`), body === null ? text : JSON.stringify(body, null, 1));
  return a;
}

/** The shape of a JSON value: keys and types, arrays as their length and first item. */
function shape(v: unknown, depth = 0): unknown {
  if (depth > 5) return '…';
  if (Array.isArray(v)) return v.length ? [`${v.length} items`, shape(v[0], depth + 1)] : ['0 items'];
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = shape(x, depth + 1);
    return o;
  }
  return v === null ? 'null' : typeof v;
}

function line(a: Answer): string {
  return `${String(a.status).padEnd(4)} ${String(a.ms).padStart(6)} ms  ${a.path}`;
}

console.log(`Comfy Cloud probe · ${new Date().toISOString()} · key ${key ? 'present (not shown)' : 'ABSENT: public endpoints only'}`);
console.log(`raw answers → ${out}\n`);

/* ── public ─────────────────────────────────────────────────────────── */

const stats = await get('/api/system_stats', 'none');
console.log(line(stats));
const sys = (stats.body as { system?: Record<string, unknown> } | null)?.system ?? {};
console.log(`     comfyui_version ${String(sys.comfyui_version)} · cloud_version ${String(sys.cloud_version)} · templates ${String(sys.workflow_templates_version)}`);

const folders = await get('/api/experiment/models', 'none');
console.log(line(folders));
const folderNames = new Set(((folders.body as Array<{ name: string }> | null) ?? []).map((f) => f.name));
console.log(`     ${folderNames.size} model folders`);

/* ── what our workflows need ────────────────────────────────────────── */

interface Need { workflow: string; nodes: string[]; models: Array<{ name: string; directory: string }> }
const needs: Need[] = [];
const wfDir = join(root, 'workflows');
for (const f of readdirSync(wfDir).filter((x) => x.endsWith('.json') && !x.endsWith('.api.json')).sort()) {
  const m = JSON.parse(readFileSync(join(wfDir, f), 'utf8')) as { id: string; api: string; models?: Array<{ name: string; directory: string }> };
  const api = JSON.parse(readFileSync(join(wfDir, m.api), 'utf8')) as Record<string, { class_type: string }>;
  // A manifest lists every file of its template; only the ones the graph names are needed.
  const text = JSON.stringify(api);
  const used = (m.models ?? []).filter((x) => text.includes(JSON.stringify(x.name)));
  needs.push({ workflow: m.id, nodes: [...new Set(Object.values(api).map((n) => n.class_type))].sort(), models: used });
}

// Model files, folder by folder (public).
const inFolder = new Map<string, Set<string>>();
for (const dir of [...new Set(needs.flatMap((n) => n.models.map((x) => x.directory)))].sort()) {
  if (!folderNames.has(dir)) { inFolder.set(dir, new Set()); console.log(`     folder ${dir}: not on Cloud`); continue; }
  const a = await get(`/api/experiment/models/${encodeURIComponent(dir)}`, 'none');
  const names = new Set(((a.body as Array<{ name: string }> | null) ?? []).map((x) => x.name));
  inFolder.set(dir, names);
  console.log(`${line(a)}  · ${names.size} files`);
}
const hasModel = (dir: string, name: string): string | null => {
  const names = inFolder.get(dir) ?? new Set<string>();
  if (names.has(name)) return name;
  // Cloud may keep a file in a subfolder of the model folder.
  for (const n of names) if (n.split('/').pop() === name) return n;
  return null;
};

/* ── with the key ───────────────────────────────────────────────────── */

const report: Record<string, unknown> = { at: new Date().toISOString(), system: sys, folders: folderNames.size };
let nodes: Set<string> | null = null;

if (key) {
  console.log('\nBilling (v1, X-API-Key)');
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  const queries = [
    '', 'granularity=day', 'group_by=product', 'granularity=day&group_by=product', 'granularity=hour&group_by=endpoint',
    `starting_on=${encodeURIComponent(weekAgo.toISOString().slice(0, 19) + 'Z')}&ending_before=${encodeURIComponent(now.toISOString().slice(0, 13) + ':00:00Z')}&granularity=day&group_by=product`,
    'months=1', 'granularity=week',
  ];
  const billing: Record<string, unknown> = {};
  for (const q of queries) {
    const a = await get(`/api/billing/usage/timeseries${q ? `?${q}` : ''}`, 'v1');
    console.log(line(a));
    const b = a.body as { summary?: { balance?: Record<string, unknown>; spend_micros?: number }; buckets?: unknown[]; breakdown?: unknown[]; groups?: unknown[]; granularity?: string; group_by?: string; starting_on?: string; ending_before?: string } | null;
    if (a.status === 200 && b) {
      console.log(`     echo: group_by=${b.group_by} granularity=${b.granularity} ${b.starting_on} → ${b.ending_before}`);
      console.log(`     groups ${b.groups?.length ?? '-'} · buckets ${b.buckets?.length ?? '-'} · breakdown ${b.breakdown?.length ?? '-'} · spend_micros ${b.summary?.spend_micros}`);
      console.log(`     balance ${JSON.stringify(b.summary?.balance ?? null)}`);
    } else {
      console.log(`     ${JSON.stringify(a.body ?? a.text).slice(0, 300)}`);
    }
    billing[q || '(none)'] = { status: a.status, shape: shape(a.body) };
  }
  report.billing = billing;

  console.log('\nAccount and features (v1)');
  for (const p of ['/api/user', '/api/features', '/api/jobs?limit=1']) {
    const a = await get(p, 'v1');
    console.log(line(a));
    console.log(`     shape ${JSON.stringify(shape(a.body)).slice(0, 600)}`);
    report[p] = { status: a.status, shape: shape(a.body) };
  }

  console.log('\nNodes (v1 object_info)');
  const oi = await get('/api/object_info', 'v1');
  console.log(line(oi));
  if (oi.status === 200 && oi.body && typeof oi.body === 'object') {
    nodes = new Set(Object.keys(oi.body as object));
    console.log(`     ${nodes.size} node classes`);
  }

  console.log('\nComfy API v2 (Bearer)');
  const v2 = await get('/api/v2/jobs?limit=1', 'v2');
  console.log(line(v2));
  console.log(`     ${JSON.stringify(v2.body ?? v2.text).slice(0, 300)}`);
  report.v2jobs = { status: v2.status, shape: shape(v2.body) };
  try {
    const { Comfy } = await import('@comfyorg/sdk');
    const saved = { base: process.env.COMFY_BASE_URL, key: process.env.COMFY_API_KEY };
    delete process.env.COMFY_BASE_URL;
    delete process.env.COMFY_API_KEY;
    const client = new Comfy({ apiKey: key, clientInfo: 'justae-flow-probe' });
    if (saved.base !== undefined) process.env.COMFY_BASE_URL = saved.base;
    if (saved.key !== undefined) process.env.COMFY_API_KEY = saved.key;
    try {
      for await (const j of client.listJobs({ limit: 1 })) { console.log(`     SDK listJobs → a job (${j.status})`); break; }
      console.log('     SDK listJobs → ok');
      report.sdkList = 'ok';
    } catch (e) {
      const err = e as { code?: string; httpStatus?: number; name?: string };
      console.log(`     SDK listJobs → ${err.name} code=${err.code} http=${err.httpStatus}`);
      report.sdkList = { name: err.name, code: err.code, http: err.httpStatus };
    }
    try {
      await client.jobs.get('00000000-0000-4000-8000-000000000000');
      console.log('     SDK jobs.get(unknown id) → found?!');
    } catch (e) {
      const err = e as { code?: string; httpStatus?: number; name?: string };
      console.log(`     SDK jobs.get(unknown id) → ${err.name} code=${err.code} http=${err.httpStatus}`);
      report.sdkGet = { name: err.name, code: err.code, http: err.httpStatus };
    }
  } catch (e) {
    console.log(`     SDK not usable: ${e instanceof Error ? e.message : e}`);
  }
} else {
  console.log('\nNo key: billing, object_info, user, jobs and v2 skipped.');
}

/* ── the tables ─────────────────────────────────────────────────────── */

const mark = (b: boolean | null): string => (b === null ? '?' : b ? 'yes' : 'no');
console.log('\nNode classes the catalogue and the brief name');
const nodeRows: Array<{ node: string; cloud: boolean | null }> = [];
for (const n of CATALOG_NODES) {
  const cloud = nodes ? nodes.has(n) : null;
  nodeRows.push({ node: n, cloud });
  console.log(`  ${n.padEnd(34)} ${mark(cloud)}`);
}
if (nodes) {
  for (const re of [/SAM3/i, /SeedVR2/i, /Vace/i, /MiniMaxH3|H3/, /FirstLast|Wan22/i, /RIFE|GIMM|VFI/i, /RemoveBackground|BiRefNet/i, /QwenImageEdit/i, /^LTXV/]) {
    console.log(`  matching ${String(re).padEnd(26)} ${[...nodes].filter((x) => re.test(x)).sort().join(', ') || '—'}`);
  }
}

console.log('\nBundled workflows on Cloud');
const wfRows: unknown[] = [];
for (const n of needs) {
  const missingNodes = nodes ? n.nodes.filter((x) => !nodes!.has(x)) : null;
  const models = n.models.map((x) => ({ ...x, found: hasModel(x.directory, x.name) }));
  const missingModels = models.filter((x) => !x.found);
  const runs = missingNodes === null ? null : missingNodes.length === 0 && missingModels.length === 0;
  wfRows.push({ workflow: n.workflow, missingNodes, models });
  console.log(`  ${n.workflow.padEnd(22)} nodes ${missingNodes === null ? '?' : missingNodes.length ? `missing ${missingNodes.join(', ')}` : 'all'} · models ${models.length - missingModels.length}/${models.length}${runs === null ? '' : runs ? ' → runs as-is' : ''}`);
  for (const x of models) console.log(`      ${x.found ? '✔' : '✖'} ${x.directory}/${x.name}${x.found && x.found !== x.name ? ` (as ${x.found})` : ''}`);
}
report.nodes = nodeRows;
report.workflows = wfRows;
writeFileSync(join(out, 'probe-summary.json'), JSON.stringify(report, null, 1));
console.log(`\nsummary → ${join(out, 'probe-summary.json')}`);
