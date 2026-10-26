/**
 * verify-h3-chain — MiniMax H3 Draft (the 4-step turbo LoRA) from two generated stills, then, optionally, the
 * "+ LTX Refine" step on its result, both on your own ComfyUI. This QUEUES work (H3 Draft ≈ minutes on 16 GB).
 *
 *   node scripts/verify-h3-chain.ts <comfyUrl> <first.png> <last.png> <outDir> [--refine <justaeFlowUrl>] [--seconds 5]
 *
 * The H3 graph is the bundled h3-flf-draft (official template video_minimax_h3_i2v, its turbo branch on), with the
 * server's own precision of each model swapped in, the same way the Flow window does. With --refine, the H3 clip is
 * planned by the JustAE Flow server (POST /api/finishing/graph, needs its page token, read from its page) and run on the
 * same ComfyUI: what the Flow window's Final ▸ + LTX Refine does, without the window.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { resolveModels } from '../core/workflows/manifest.ts';
import { WorkflowLibrary } from '../server/library.ts';
import type { ObjectInfo } from '../core/comfy/types.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [baseArg, first, last, outDir, ...rest] = process.argv.slice(2);
if (!baseArg || !first || !last || !outDir) { console.error('usage: verify-h3-chain <comfyUrl> <first.png> <last.png> <outDir> [--refine <justaeFlowUrl>] [--seconds 5]'); process.exit(2); }
const base = baseArg.replace(/\/+$/, '');
const flag = (k: string): string | undefined => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : undefined; };
mkdirSync(outDir, { recursive: true });

async function upload(file: string, name: string): Promise<string> {
  const fd = new FormData();
  fd.append('image', new Blob([readFileSync(file)]), name);
  fd.append('type', 'input');
  fd.append('overwrite', 'true');
  const r = await fetch(`${base}/upload/image`, { method: 'POST', body: fd });
  if (!r.ok) throw new Error(`upload ${name}: HTTP ${r.status}`);
  return ((await r.json()) as { name: string }).name;
}

async function run(graph: Record<string, unknown>, label: string): Promise<{ seconds: number; outputs: Array<{ nodeId: string; filename: string; subfolder: string }>; minFreeGb: number | null }> {
  const id = randomUUID();
  const t0 = Date.now();
  const r = await fetch(`${base}/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: graph, client_id: 'justae-h3-verify', prompt_id: id }) });
  if (!r.ok) throw new Error(`${label}: ${await r.text()}`);
  let minFree = Infinity;
  for (;;) {
    await new Promise((res) => setTimeout(res, 5000));
    try {
      const s = await (await fetch(`${base}/system_stats`)).json() as { devices: Array<{ vram_free: number }> };
      minFree = Math.min(minFree, s.devices[0].vram_free);
    } catch { /* a nicety */ }
    const h = await (await fetch(`${base}/history/${id}`)).json() as Record<string, { status?: { status_str?: string; messages?: Array<[string, { timestamp?: number }]> }; outputs?: Record<string, Record<string, Array<{ filename: string; subfolder: string; type: string }>>> }>;
    const job = h[id];
    if (!job) continue;
    if (job.status?.status_str === 'error') throw new Error(`${label} failed: ${JSON.stringify(job.status.messages?.at(-1)).slice(0, 800)}`);
    if (job.status?.status_str === 'success') {
      const msgs = job.status.messages ?? [];
      const start = msgs.find((m) => m[0] === 'execution_start')?.[1].timestamp;
      const end = msgs.find((m) => m[0] === 'execution_success')?.[1].timestamp;
      const outputs = Object.entries(job.outputs ?? {}).flatMap(([nodeId, o]) => Object.values(o).flatMap((items) => (Array.isArray(items) ? items : []).filter((x) => x?.filename && x.type === 'output').map((x) => ({ nodeId, filename: x.filename, subfolder: x.subfolder }))));
      return { seconds: start && end ? (end - start) / 1000 : (Date.now() - t0) / 1000, outputs, minFreeGb: Number.isFinite(minFree) ? Math.round((minFree / 2 ** 30) * 10) / 10 : null };
    }
  }
}

async function download(o: { filename: string; subfolder: string }, to: string): Promise<void> {
  const q = new URLSearchParams({ filename: o.filename, subfolder: o.subfolder, type: 'output' });
  writeFileSync(to, Buffer.from(await (await fetch(`${base}/view?${q}`)).arrayBuffer()));
}

const lib = new WorkflowLibrary(join(root, 'workflows'));
const m = lib.get('h3-flf-draft')!.manifest;
const g = lib.graph('h3-flf-draft')! as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
const oi = await (await fetch(`${base}/object_info`)).json() as ObjectInfo;
const models = resolveModels(g as never, oi, m.models);
if (models.missing.length) { console.error('missing:', models.missing.map((x) => x.wanted).join(', ')); process.exit(2); }
for (const r of models.remaps) console.log(`  uses local ${r.using} for ${r.wanted}`);
const set = (ref: string | undefined, v: unknown): void => { if (!ref) return; const dot = ref.indexOf('.', ref.lastIndexOf(':') + 1); g[ref.slice(0, dot)].inputs[ref.slice(dot + 1)] = v; };
const seconds = Number(flag('--seconds') ?? 5);
set(m.bindings.image, await upload(first, `jae_h3_first_${basename(first)}`));
g['130'].inputs.image = await upload(last, `jae_h3_last_${basename(last)}`);
set(m.bindings.prompt, 'A small wooden sailboat with a white sail glides slowly across a calm mountain lake at dawn, thin mist over the water, the camera follows it gently. Quiet water lapping, a soft breeze.');
set(m.bindings.seed, 42);
set(m.bindings.width, 1344);
set(m.bindings.height, 768);
set(m.bindings.seconds, seconds);
writeFileSync(join(outDir, 'h3_draft.api.json'), JSON.stringify(g, null, 1));
console.log(`H3 Draft: 4-step turbo LoRA ${String(Object.values(g).find((n) => n.class_type === 'LoraLoaderModelOnly')?.inputs.lora_name)}, steps ${String(g['105:125']?.inputs.value)}, 1344×768, ${seconds} s`);
const h3 = await run(g, 'H3 Draft');
const vid = h3.outputs.find((o) => /\.mp4$/i.test(o.filename));
if (!vid) throw new Error('H3 Draft: no MP4');
const h3File = join(outDir, 'h3_draft.mp4');
await download(vid, h3File);
console.log(`H3 Draft done: ${h3.seconds.toFixed(1)} s execution, lowest free VRAM ${h3.minFreeGb} GiB → ${h3File}`);
writeFileSync(join(outDir, 'h3_draft.json'), JSON.stringify({ seconds: h3.seconds, minFreeGb: h3.minFreeGb, remaps: models.remaps, file: h3File }, null, 1));

const flow = flag('--refine');
if (flow) {
  const page = await (await fetch(`${flow}/`)).text();
  const token = /name="flow-token" content="([^"]+)"/.exec(page)?.[1] ?? '';
  const r = await fetch(`${flow}/api/finishing/graph`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-flow-token': token }, body: JSON.stringify({ file: h3File, size: 'fhd' }) });
  const d = await r.json() as { error?: string; graph: Record<string, { class_type: string; inputs: Record<string, unknown> }>; loadNode: string; saveNode: string; previewNode: string; plan: unknown; estimate: { seconds: number; line: string } };
  if (!r.ok) throw new Error(`plan: ${d.error}`);
  console.log(`LTX Refine plan: ${JSON.stringify(d.plan)}\n  ${d.estimate.line}`);
  d.graph[d.loadNode].inputs.file = await upload(h3File, `jae_h3_refine_${Date.now()}.mp4`);
  const rf = await run(d.graph, 'LTX Refine');
  const mp4 = rf.outputs.find((o) => o.nodeId === d.previewNode);
  const pngs = rf.outputs.filter((o) => o.nodeId === d.saveNode).sort((a, b) => a.filename.localeCompare(b.filename));
  if (mp4) await download(mp4, join(outDir, 'h3_draft_ltx-fhd.mp4'));
  const master = join(outDir, 'h3_draft_ltx-fhd_png16');
  mkdirSync(master, { recursive: true });
  for (let i = 0; i < pngs.length; i++) await download(pngs[i], join(master, `h3_draft_ltx-fhd_${String(i).padStart(5, '0')}.png`));
  console.log(`LTX Refine done: ${rf.seconds.toFixed(1)} s execution (estimate ${Math.round(d.estimate.seconds)} s), lowest free VRAM ${rf.minFreeGb} GiB, ${pngs.length} PNG 16-bit frames + ${mp4 ? 'MP4' : 'no MP4'}`);
  writeFileSync(join(outDir, 'h3_refine.json'), JSON.stringify({ seconds: rf.seconds, estimate: d.estimate, minFreeGb: rf.minFreeGb, plan: d.plan, frames: pngs.length }, null, 1));
}
