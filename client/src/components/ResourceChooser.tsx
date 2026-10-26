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
import { formatCredits, useResources, type Capabilities, type EstimateAnswer, type ResourceView } from '../lib/resources';
import { useActiveRoute, useEstimate, useWorkflowRoute, type ShotForEstimate } from '../lib/useRoute';

function short(a: EstimateAnswer | null, metered: boolean): string {
  if (!a) return '';
  const t = a.total;
  const secs = t.secondsHigh !== null ? (t.secondsHigh < 60 ? `~${Math.round(t.secondsHigh)} s` : `~${Math.round(t.secondsHigh / 60)} min`) : '';
  if (!metered) return ['no credits', secs].filter(Boolean).join(' · ');
  if (t.creditsHigh !== null) return [`≈ ${formatCredits(t.creditsHigh)} cr`, secs, t.overhead === 'cold' ? 'incl. start-up' : ''].filter(Boolean).join(' · ');
  return t.creditsPerMinute !== null ? `first run: ${t.creditsPerMinute.toFixed(1)} cr/min${t.overhead === 'cold' && t.overheadCredits !== null ? ` + ≈ ${formatCredits(t.overheadCredits)} cr start-up` : ''}` : '';
}

/** What the capability probe knows about this workflow on this resource, in a few words. */
function capWord(caps: Capabilities | null | undefined, workflowId: string | undefined): { text: string; tone: 'ok' | 'warn' | 'mute' } | null {
  if (!caps || !workflowId) return null;
  const w = caps.workflows[workflowId];
  if (!w) return null;
  if (w.status === 'proven') return { text: `✓ ran here ${w.provenAt ? new Date(w.provenAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : ''}`.trim(), tone: 'ok' };
  if (w.status === 'ok') return { text: '✓ has it', tone: 'ok' };
  if (w.status === 'missing') return { text: `missing ${[...w.missingNodes, ...w.missingModels].slice(0, 1).join('')}`, tone: 'warn' };
  return { text: caps.kind === 'deployment' || caps.kind === 'proxy' ? 'not run here yet' : 'unknown', tone: 'mute' };
}

function Option({ r, shots, picked, onPick, workflowId }: { r: ResourceView; shots: ShotForEstimate[]; picked: boolean; onPick: () => void; workflowId?: string }): JSX.Element {
  const est = useEstimate(r.usable ? shots : [], r.id);
  const caps = useResources((s) => s.data?.capabilities[r.id]);
  const cap = r.usable ? capWord(caps, workflowId) : null;
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
          {cap && <span className={cap.tone === 'ok' ? 'text-ok' : cap.tone === 'warn' ? 'text-warn' : ''} data-testid={`cap-${r.id}`}> · {cap.text}</span>}
        </span>
      </span>
    </button>
  );
}

interface Props {
  shots: ShotForEstimate[];
  disabled?: boolean;
  /**
   * A pick of its own (the Comp tab keeps one per tool), instead of the Generate
   * button's pick that the server keeps for the panel.
   */
  value?: string;
  onChange?: (choice: string) => void;
  /** Route "Default" by this bundled workflow's task row (the Comp tab), instead of the Workflow tab's workflow. */
  workflowId?: string;
}

export function ResourceChooser({ shots, disabled, value, onChange, workflowId }: Props): JSX.Element | null {
  const data = useResources((s) => s.data);
  const choose = useResources((s) => s.choose);
  const choice = value ?? data?.choice ?? 'default';
  const activeRoute = useActiveRoute();
  const activeDefault = useActiveRoute(true);
  const toolRoute = useWorkflowRoute(workflowId, choice);
  const toolDefault = useWorkflowRoute(workflowId, 'default');
  const route = workflowId ? toolRoute : activeRoute;
  const byDefault = workflowId ? toolDefault : activeDefault;
  const pick = (id: string): void => { if (onChange) onChange(id); else void choose(id); };
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const current = useEstimate(shots, choice);

  useEffect(() => {
    if (!open) return undefined;
    const close = (e: MouseEvent): void => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  if (!data) return null;
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
            onClick={() => { pick('default'); setOpen(false); }}
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
            <Option key={r.id} r={r} shots={shots} picked={choice === r.id} onPick={() => { pick(r.id); setOpen(false); }} workflowId={workflowId ?? shots[0]?.workflowId} />
          ))}
          <p className="px-2 pb-1 pt-1.5 text-[10px] leading-snug text-ink-mute">
            ≈ from earlier runs of this workflow there (execution time × the GPU&rsquo;s rate, plus a deployment&rsquo;s worker
            start-up when it would be cold). The pick stays until you change it.
          </p>
        </div>
      )}
    </div>
  );
}
