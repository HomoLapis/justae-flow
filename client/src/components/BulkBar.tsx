import { useState } from 'react';
import { api } from '../api.ts';
import { act, useUi } from '../store.ts';
import { Icon, Kbd } from './ui.tsx';

/** Same workflow, same seed policy, same length — for every selected card at once. */
export function BulkBar() {
  const selected = useUi((u) => u.selected);
  const workflows = useUi((u) => u.server!.workflows);
  const clear = useUi((u) => u.clearSelection);
  const [workflowId, setWorkflowId] = useState('');
  const [seed, setSeed] = useState<'' | 'random' | 'fixed'>('');
  const [seconds, setSeconds] = useState('');
  if (selected.length < 2) return null;

  const apply = async (): Promise<void> => {
    const patch: Record<string, unknown> = {};
    if (workflowId) patch.workflowId = workflowId;
    if (seed === 'random') patch.seed = null;
    if (seed === 'fixed') patch.seed = Math.floor(Math.random() * 2 ** 31);
    if (seconds !== '') patch.seconds = Number(seconds) || 0;
    if (Object.keys(patch).length === 0) return;
    await act(api.bulk(selected, patch), `Applied to ${selected.length} cards`);
    setWorkflowId(''); setSeed(''); setSeconds('');
  };

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-accent/40 bg-ink-850 px-3 py-2">
      <span className="font-semibold text-accent">{selected.length} selected</span>
      <span className="text-ink-500">→</span>
      <select className="field !w-auto" value={workflowId} onChange={(e) => setWorkflowId(e.target.value)}>
        <option value="">Workflow: keep</option>
        {workflows.map((w) => <option key={w.id} value={w.id}>{w.title}</option>)}
      </select>
      <select className="field !w-auto" value={seed} onChange={(e) => setSeed(e.target.value as typeof seed)}>
        <option value="">Seed: keep</option>
        <option value="random">Seed: random each run</option>
        <option value="fixed">Seed: one shared fixed seed</option>
      </select>
      <div className="flex items-center gap-1">
        <input className="field !w-24 font-mono" placeholder="Length: keep" value={seconds} onChange={(e) => setSeconds(e.target.value.replace(/[^\d.]/g, ''))} onKeyDown={(e) => e.stopPropagation()} />
        <span className="text-ink-500">s</span>
      </div>
      <button className="btn-outline" onClick={apply}>Apply to {selected.length}</button>
      <div className="ml-auto flex items-center gap-2">
        <button className="btn-primary" onClick={() => act(api.generate(selected))}><Icon name="play" className="h-3 w-3" />Generate {selected.length} <Kbd>Ctrl G</Kbd></button>
        <button className="btn-ghost" onClick={clear}>Clear</button>
      </div>
    </div>
  );
}
