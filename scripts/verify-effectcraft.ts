/**
 * Drives the engine against a live EffectCraft, headless, and prints what it
 * sees — the storyboard as the UI would show it.
 *
 *   node scripts/verify-effectcraft.ts            # sync only
 *   node scripts/verify-effectcraft.ts --generate <cardId|first> [workflowId]
 *
 * EffectCraft must be running with `--control 9877`; generation also needs ComfyUI.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSettings } from '../server/config.ts';
import { Engine } from '../server/engine.ts';
import { WorkflowLibrary } from '../server/library.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const settings = loadSettings(root);
const engine = new Engine(settings, new WorkflowLibrary(join(root, 'workflows')));
const args = process.argv.slice(2);

await engine.checkComfy();
await engine.sync();
await engine.sync();
const s = engine.state();
console.log(`host: ${s.host.ok ? `EffectCraft ${s.host.version}` : `✖ ${s.host.error}`}`);
console.log(`project: ${s.host.project ?? '(unsaved)'} · comp: ${s.host.comp ? `${s.host.comp.name} ${s.host.comp.width}×${s.host.comp.height} @${s.host.comp.fps}` : '—'}`);
console.log(`comfy: ${s.comfy.online ? `${s.comfy.version} on ${s.comfy.device}` : `✖ ${s.comfy.message}`}`);
console.log(`media: ${s.mediaDir}`);
for (const c of s.cards) {
  console.log(`  ${c.id}  ${c.label.padEnd(11)} @${c.at.toFixed(2)}s slot=${c.slotSeconds?.toFixed(2) ?? '—'}s  ${c.status.padEnd(7)} ${c.workflowId.padEnd(16)} "${c.prompt.slice(0, 50)}"${c.orphan ? '  (orphan)' : ''}`);
}

const gi = args.indexOf('--generate');
if (gi >= 0) {
  const want = args[gi + 1];
  const card = want === 'first' ? s.cards.find((c) => !c.orphan) : s.cards.find((c) => c.id === want);
  if (!card) { console.error('no such card'); process.exit(1); }
  if (args[gi + 2]) await engine.updateCards([card.id], { workflowId: args[gi + 2] });
  const t0 = Date.now();
  let last = '';
  engine.onChange(() => {
    const c = engine.state().cards.find((x) => x.id === card.id)!;
    const line = `${c.status} ${c.progress ? `${c.progress.phase} ${c.progress.value}/${c.progress.max}` : ''}`;
    if (line !== last) { last = line; console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)}s] ${line}`); }
  });
  engine.enqueue([card.id]);
  await new Promise<void>((resolve) => {
    const iv = setInterval(() => {
      const c = engine.state().cards.find((x) => x.id === card.id)!;
      if (c.status === 'done' || c.status === 'error' || c.status === 'idle') { clearInterval(iv); resolve(); }
    }, 500);
  });
  const c = engine.state().cards.find((x) => x.id === card.id)!;
  console.log(`result: ${c.status}${c.error ? ` — ${c.error}` : ''}`);
  if (c.versions.length) console.log(JSON.stringify(c.versions.at(-1), null, 2), '\nplaced:', JSON.stringify(c.placed));
}
engine.stop();
process.exit(0);
