/**
 * Checks every bundled workflow against a live ComfyUI, read-only:
 * node classes installed, model files present (or a local precision of them).
 *
 *   node scripts/verify-workflows.ts [http://127.0.0.1:8188]
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ComfyClient } from '../core/comfy/client.ts';
import { missingNodes, resolveModels } from '../core/workflows/manifest.ts';
import { WorkflowLibrary } from '../server/library.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const base = process.argv[2] ?? process.env.COMFY_URL ?? 'http://127.0.0.1:8188';
const comfy = new ComfyClient(base);
const h = await comfy.health();
if (!h.online) { console.error(h.message); process.exit(1); }
console.log(`ComfyUI ${h.version} at ${base} · ${h.device ?? ''}\n`);
const oi = await comfy.objectInfo();
let bad = 0;
for (const m of new WorkflowLibrary(join(root, 'workflows')).list()) {
  const api = new WorkflowLibrary(join(root, 'workflows')).graph(m.id)!;
  const nodes = missingNodes(api, oi);
  const models = resolveModels(api, oi, m.models);
  const ok = nodes.length === 0 && models.missing.length === 0;
  if (!ok) bad++;
  console.log(`${ok ? '✔' : '✖'} ${m.id.padEnd(18)} ${m.title}`);
  for (const n of nodes) console.log(`    node not installed: ${n}`);
  for (const x of models.missing) console.log(`    model missing: ${x.wanted} → models/${x.directory ?? '?'}\n      ${x.url ?? ''}`);
  for (const r of models.remaps) console.log(`    uses local variant: ${r.wanted} → ${r.using}`);
}
console.log(bad ? `\n${bad} workflow(s) cannot run on this server yet.` : '\nEvery bundled workflow can run on this server.');
process.exit(bad ? 1 : 0);
