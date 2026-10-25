import { useApp } from '../state/store';
import { ae, isErr } from '../bridge/extendscript';
import { layerNameFromPrompt } from '../lib/filenames';
import { providerLabel } from '../providers/registry';
import { formatCredits } from '../lib/resources';
import { revealInFileManager } from '../lib/external';
import { copyText } from '../lib/clipboard';

export function HistoryDrawer(): JSX.Element | null {
  const open = useApp((s) => s.historyOpen);
  const setOpen = useApp((s) => s.setHistoryOpen);
  const history = useApp((s) => s.history);
  const clearHistory = useApp((s) => s.clearHistory);

  if (!open) return null;

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
          {history.length === 0 && (
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
              {(typeof h.credits === 'number' || typeof h.seconds === 'number') && (
                <p
                  className="mt-0.5 font-mono text-[10px] text-ink-dim"
                  title={typeof h.credits === 'number' ? 'Execution time the server reported × the GPU\'s rate — derived, not a billed amount' : 'Execution time (no credits on your own GPU)'}
                  data-testid="history-cost"
                >
                  {typeof h.seconds === 'number' ? `${h.seconds.toFixed(1)} s` : ''}
                  {typeof h.credits === 'number' ? ` · ≈ ${formatCredits(h.credits)} cr` : ' · no credits'}
                </p>
              )}
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
