/**
 * "Running on: Local ComfyUI ▾" — the Generate button's pick (the same choice, kept by the server), at the top of
 * the Workflow tab: the status chips of the Featured cards are for this resource.
 */

import { useEffect, useRef, useState } from 'react';
import { useResources } from '../lib/resources';

const ICON: Record<string, string> = { local: '⌂', cloud: '☁', deployment: '▣', proxy: '⇄' };

export function RunningOn(): JSX.Element | null {
  const data = useResources((s) => s.data);
  const choose = useResources((s) => s.choose);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const close = (e: MouseEvent): void => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  if (!data) return null;
  const choice = data.choice;
  const picked = data.resources.find((r) => r.id === choice);
  const listed = data.resources.filter((r) => r.enabled || r.kind === 'cloud');
  const label = picked ? `${ICON[picked.kind] ?? ''} ${picked.label}` : 'Default — each task’s row in Settings';

  return (
    <div className="relative flex items-center gap-2" ref={box}>
      <span className="text-[11px] text-ink-mute">Running on</span>
      <button type="button" className="flex min-w-0 items-center gap-1.5 rounded-md border border-line bg-bg-raised px-2 py-1 text-[11px] text-ink hover:bg-bg-hover"
        onClick={() => setOpen(!open)} data-testid="running-on" title="The resource the Generate button uses; the cards below say what is ready there">
        <span className="truncate">{label}</span>
        {picked && !picked.usable && <span className="shrink-0 text-warn" title={picked.reason}>· not usable</span>}
        <span className="shrink-0 text-ink-mute">▾</span>
      </button>
      {open && (
        <div className="absolute left-16 top-full z-30 mt-1 w-[300px] space-y-0.5 rounded-lg border border-line bg-bg-raised p-1 shadow-lg" data-testid="running-on-menu">
          <button type="button" className={'flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left ' + (choice === 'default' ? 'bg-brand/10' : 'hover:bg-bg-subtle')}
            onClick={() => { void choose('default'); setOpen(false); }} data-resource="default">
            <span className="mt-0.5 w-3 shrink-0 text-[10px] text-brand">{choice === 'default' ? '●' : ''}</span>
            <span className="min-w-0 flex-1">
              <span className="block text-xs text-ink">Default</span>
              <span className="block text-[10px] text-ink-mute">each task&rsquo;s row in Settings ▸ Resources</span>
            </span>
          </button>
          <div className="divider my-1" />
          {listed.map((r) => (
            <button key={r.id} type="button" disabled={!r.usable}
              className={'flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left disabled:opacity-40 ' + (choice === r.id ? 'bg-brand/10' : 'hover:bg-bg-subtle')}
              onClick={() => { void choose(r.id); setOpen(false); }} data-resource={r.id} title={r.usable ? '' : r.reason}>
              <span className="mt-0.5 w-3 shrink-0 text-[10px] text-brand">{choice === r.id ? '●' : ''}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs text-ink">{ICON[r.kind]} {r.label}</span>
                <span className="block truncate text-[10px] text-ink-mute">
                  {!r.usable ? r.reason : r.creditsPerHour === null ? 'your GPU, no credits' : `${r.gpuLabel ?? ''} · ${r.creditsPerHour} cr/h while a job runs`}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
