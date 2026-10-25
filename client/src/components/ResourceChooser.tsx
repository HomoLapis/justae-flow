/**
 * The resource on the Generate button: where this batch goes.
 *
 *   [ ▶ Generate 3 clips ][ ☁ Comfy Cloud ≈ 7.4 cr ▾ ]
 *      Default — each task's row in Settings (now: Local ComfyUI)
 *      Local ComfyUI · no credits · ~32 s
 *      Comfy Cloud · ≈ 7.4 cr · ~36 s
 *      Deployment · first run: 12.3 cr/min
 *
 * The pick goes to the server (it is what the panel in EffectCraft shows) and
 * into each shot's job.json. Every figure is the server's estimate, with "≈".
 */

import { useEffect, useRef, useState } from 'react';
import { formatCredits, useResources, type EstimateAnswer, type ResourceView } from '../lib/resources';
import { useActiveRoute, useEstimate, type ShotForEstimate } from '../lib/useRoute';

function short(a: EstimateAnswer | null, metered: boolean): string {
  if (!a) return '';
  const t = a.total;
  const secs = t.secondsHigh !== null ? (t.secondsHigh < 60 ? `~${Math.round(t.secondsHigh)} s` : `~${Math.round(t.secondsHigh / 60)} min`) : '';
  if (!metered) return ['no credits', secs].filter(Boolean).join(' · ');
  if (t.creditsHigh !== null) return [`≈ ${formatCredits(t.creditsHigh)} cr`, secs].filter(Boolean).join(' · ');
  return t.creditsPerMinute !== null ? `first run: ${t.creditsPerMinute.toFixed(1)} cr/min` : '';
}

function Option({ r, shots, picked, onPick }: { r: ResourceView; shots: ShotForEstimate[]; picked: boolean; onPick: () => void }): JSX.Element {
  const est = useEstimate(r.usable ? shots : [], r.id);
  return (
    <button
      type="button"
      disabled={!r.usable}
      onClick={onPick}
      data-resource={r.id}
      className={'flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors disabled:opacity-40 '
        + (picked ? 'bg-brand/10' : 'hover:bg-bg-subtle')}
      title={r.usable ? est?.total.text ?? '' : r.reason}
    >
      <span className="mt-0.5 w-3 shrink-0 text-[10px] text-brand">{picked ? '●' : ''}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs text-ink">{r.kind === 'local' ? '⌂ ' : r.kind === 'cloud' ? '☁ ' : r.kind === 'deployment' ? '▣ ' : '⇄ '}{r.label}</span>
        <span className="block truncate font-mono text-[10px] text-ink-mute">
          {r.usable ? short(est, r.creditsPerHour !== null) || '…' : r.reason}
        </span>
      </span>
    </button>
  );
}

export function ResourceChooser({ shots, disabled }: { shots: ShotForEstimate[]; disabled?: boolean }): JSX.Element | null {
  const data = useResources((s) => s.data);
  const choose = useResources((s) => s.choose);
  const route = useActiveRoute();
  const byDefault = useActiveRoute(true);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const current = useEstimate(shots, data?.choice ?? 'default');

  useEffect(() => {
    if (!open) return undefined;
    const close = (e: MouseEvent): void => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  if (!data) return null;
  const choice = data.choice;
  const listed = data.resources.filter((r) => r.enabled || r.kind === 'cloud');
  const picked = choice === 'default' ? null : data.resources.find((r) => r.id === choice);
  const where = picked ?? data.resources.find((r) => r.id === route?.resource);
  const metered = (where?.creditsPerHour ?? null) !== null;

  return (
    <div className="relative shrink-0" ref={box}>
      <button
        type="button"
        className="btn-ghost h-12 w-[176px] flex-col items-start justify-center gap-0 px-2.5 text-left"
        onClick={() => setOpen(!open)}
        disabled={disabled}
        data-testid="resource-chooser"
        title={route?.why ?? ''}
      >
        <span className="flex w-full items-center gap-1 text-xs">
          {/* A pick that cannot take jobs (no key, refused) is said, with where the batch goes instead. */}
          <span className="truncate" title={picked && !picked.usable ? `${picked.label}: ${picked.reason ?? 'not usable'}` : undefined}>
            {picked ? (picked.usable ? picked.label : `${route?.label ?? '…'} · ${picked.label} unavailable`) : `Default · ${route?.label ?? '…'}`}
          </span>
          <span className="ml-auto text-ink-mute">▾</span>
        </span>
        <span className="w-full truncate font-mono text-[10px] font-normal text-ink-mute">{short(current, metered) || (metered ? '' : 'no credits')}</span>
      </button>
      {open && (
        <div className="absolute bottom-full right-0 z-30 mb-1 w-[300px] space-y-0.5 rounded-lg border border-line bg-bg-raised p-1 shadow-lg" data-testid="resource-menu">
          <button
            type="button"
            className={'flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left ' + (choice === 'default' ? 'bg-brand/10' : 'hover:bg-bg-subtle')}
            onClick={() => { void choose('default'); setOpen(false); }}
            data-resource="default"
          >
            <span className="mt-0.5 w-3 shrink-0 text-[10px] text-brand">{choice === 'default' ? '●' : ''}</span>
            <span className="min-w-0 flex-1">
              <span className="block text-xs text-ink">Default — each task&rsquo;s row in Settings</span>
              <span className="block truncate font-mono text-[10px] text-ink-mute">{byDefault ? `now: ${byDefault.why}` : '…'}</span>
            </span>
          </button>
          <div className="divider my-1" />
          {listed.map((r) => (
            <Option key={r.id} r={r} shots={shots} picked={choice === r.id} onPick={() => { void choose(r.id); setOpen(false); }} />
          ))}
          <p className="px-2 pb-1 pt-1.5 text-[10px] leading-snug text-ink-mute">
            ≈ from earlier runs of this workflow there (execution time × the GPU&rsquo;s rate). The pick stays until you change it.
          </p>
        </div>
      )}
    </div>
  );
}
