import { useEffect, useState } from 'react';
import { useApp } from '../state/store';
import { ae, isErr } from '../bridge/extendscript';
import { layerNameFromPrompt } from '../lib/filenames';
import { providerLabel } from '../providers/registry';
import { formatCredits, loadRuns, useResources, type RunEntry } from '../lib/resources';
import { revealInFileManager } from '../lib/external';
import { copyText } from '../lib/clipboard';

/** "billed ≈ 107 cr (hourly report)" once the hourly billing report has the run's hour, else "≈ 107 cr" (derived). */
function costWords(run: RunEntry | undefined, fallback: number | null | undefined): { text: string; title: string } | null {
  if (run && typeof run.billedCredits === 'number') {
    return {
      text: `billed ≈ ${formatCredits(run.billedCredits)} cr (hourly report)`,
      title: `The hourly billing report's GPU amount for the hour, shared among the runs of that hour (report as of ${when(run.billedAsOf)}).`
        + (run.derivedCredits !== null ? ` Derived ≈ ${formatCredits(run.derivedCredits)} cr: ${run.costBasis ?? 'GPU time of the job'} × the GPU's rate.` : ''),
    };
  }
  const derived = run ? run.derivedCredits : fallback;
  if (typeof derived !== 'number') return null;
  return {
    text: `≈ ${formatCredits(derived)} cr`,
    title: `Derived, not billed: ${run?.costBasis ?? 'execution time the server reported'} × the GPU's rate. The billed figure follows when the hourly billing report has the hour.`,
  };
}

function when(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
}

export function HistoryDrawer(): JSX.Element | null {
  const open = useApp((s) => s.historyOpen);
  const setOpen = useApp((s) => s.setHistoryOpen);
  const history = useApp((s) => s.history);
  const clearHistory = useApp((s) => s.clearHistory);
  const resources = useResources((s) => s.data?.resources);
  // The server's run history: every tab's runs, with the derived figure and, once the report has the hour, the billed one.
  const [runs, setRuns] = useState<RunEntry[] | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    void loadRuns().then((r) => { if (live) setRuns(r); }).catch(() => undefined);
    return () => { live = false; };
  }, [open]);

  if (!open) return null;
  const runOf = (jobId: string, resourceId?: string): RunEntry | undefined => runs?.find((r) => r.jobId === jobId && (!resourceId || r.resourceId === resourceId));
  const metered = (runs ?? []).filter((r) => r.creditsPerHour !== null && r.derivedCredits !== null).slice(0, 20);
  const labelOf = (id: string): string => resources?.find((r) => r.id === id)?.label ?? id;

  const reimport = async (path: string, isVideo: boolean, prompt: string): Promise<void> => {
    if (!path) return;
    const label = layerNameFromPrompt(prompt);
    const r = isVideo ? await ae.importVideo(path, label) : await ae.importImage(path, label, 5);
    if (isErr(r)) alert(`Reimport failed: ${r.error}`);
  };

  return (
    <div className="absolute inset-0 z-40 flex" role="dialog" aria-modal="true">
      <div className="flex-1 bg-black/60" onClick={() => setOpen(false)} aria-hidden />
      <aside className="w-[360px] max-w-full bg-bg-raised border-l border-line h-full flex flex-col">
        <header className="flex items-center justify-between px-4 py-3 border-b border-line">
          <h2 className="text-sm font-semibold tracking-wide">History</h2>
          <div className="flex items-center gap-1">
            {history.length > 0 && (
              <button
                className="btn-quiet h-7 px-2 text-xs"
                onClick={() => { if (confirm('Clear all history?')) clearHistory(); }}
              >
                Clear
              </button>
            )}
            <button className="btn-quiet h-7 px-2" onClick={() => setOpen(false)}>Close</button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
          {history.length === 0 && metered.length === 0 && (
            <p className="text-xs text-ink-mute text-center py-12">
              Nothing here yet. Generations land here as they complete.
            </p>
          )}
          {history.map((h) => (
            <article
              key={h.id}
              className="rounded-lg border border-line bg-bg p-2.5 text-xs hover:bg-bg-subtle transition-colors group"
            >
              <header className="flex items-center justify-between gap-2 mb-1">
                <span className="text-ink-mute font-mono text-[10px]">
                  {formatAgo(h.createdAt)} · {h.resourceLabel ?? providerLabel(h.providerId)}
                </span>
                <span className="text-[10px] text-ink-mute uppercase tracking-wider">
                  {h.resultIsVideo ? 'video' : 'image'}
                </span>
              </header>
              <p className="text-ink leading-snug line-clamp-2" title={h.prompt}>{h.prompt}</p>
              <p className="text-[10px] text-ink-mute mt-1 truncate" title={h.workflowLabel}>
                {h.workflowLabel}
              </p>
              {(typeof h.credits === 'number' || typeof h.seconds === 'number') && (() => {
                const cost = typeof h.credits === 'number' ? costWords(runOf(h.id, h.resourceId), h.credits) : null;
                return (
                  <p
                    className="mt-0.5 font-mono text-[10px] text-ink-dim"
                    title={cost ? cost.title : 'Execution time (no credits on your own GPU)'}
                    data-testid="history-cost"
                  >
                    {typeof h.seconds === 'number' ? `${h.seconds.toFixed(1)} s` : ''}
                    {cost ? ` · ${cost.text}` : ' · no credits'}
                  </p>
                );
              })()}
              {h.resultPath && (
                <div className="mt-2 flex items-center gap-1.5 opacity-50 group-hover:opacity-100 transition-opacity">
                  <button
                    className="chip"
                    onClick={() => void reimport(h.resultPath!, h.resultIsVideo, h.prompt)}
                  >
                    Reimport
                  </button>
                  <button
                    className="chip"
                    onClick={() => { void copyText(h.prompt); }}
                    title="Copy prompt"
                  >
                    Copy prompt
                  </button>
                  {h.shotFolder && (
                    <button
                      className="chip"
                      onClick={() => revealInFileManager(h.shotFolder!)}
                      title={h.shotFolder}
                    >
                      Show files
                    </button>
                  )}
                </div>
              )}
            </article>
          ))}
          {metered.length > 0 && (
            <section className="space-y-1.5 pt-2" data-testid="history-metered">
              <h3 className="section-label">On Comfy&rsquo;s GPUs</h3>
              <p className="text-[10px] leading-snug text-ink-mute">
                Runs on Comfy Cloud and your deployments, from every tab. &ldquo;≈&rdquo; is derived (GPU time × rate, with a
                deployment&rsquo;s worker start-up when it was cold); &ldquo;billed&rdquo; is the hourly billing report&rsquo;s GPU amount,
                shared among the runs of its hour, once the report has it.
              </p>
              {metered.map((r) => {
                const cost = costWords(r, null);
                return (
                  <div key={`${r.resourceId}-${r.jobId ?? r.at}`} className="rounded-lg border border-line bg-bg px-2.5 py-1.5 text-[11px]">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 truncate text-ink">{r.workflowId}</span>
                      <span className="ml-auto shrink-0 font-mono text-[10px] text-ink-mute">{when(r.at)}</span>
                    </div>
                    <p className="font-mono text-[10px] text-ink-dim" title={cost?.title} data-testid="history-metered-cost">
                      {labelOf(r.resourceId)}{r.executionMs !== null ? ` · ${(r.executionMs / 1000).toFixed(1)} s GPU` : ''}{r.overhead === 'cold' ? ' + start-up' : ''}
                      {cost ? ` · ${cost.text}` : ''}
                    </p>
                  </div>
                );
              })}
            </section>
          )}
        </div>
      </aside>
    </div>
  );
}

function formatAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
