/**
 * What the running job is doing — and, when it looks like nothing, whether it
 * really is nothing.
 *
 * A bar alone cannot answer that. Measured on a MiniMax-H3 shot whose slot
 * asked for 260 frames: an hour and twenty-seven minutes, the first hour of it
 * on step zero of eight, with the bar frozen at 2% and the card down to 246 MiB
 * free of 16303. The render was fine. There was no way to know. So three
 * numbers sit next to the bar now — which step, how long since the server last
 * said anything, and how much room is left on the GPU — and none of them is a
 * guess: they are the server's own words.
 */

import { useEffect, useState } from 'react';
import type { JobState } from '../state/store';

interface Props {
  job: JobState;
}

/** Past this much silence, say so in words rather than in a timestamp. */
const QUIET_SECONDS = 180;

function hms(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

function gb(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

export function JobProgress({ job }: Props): JSX.Element | null {
  /*
   * The clocks below tick on their own.
   *
   * Everything here is derived from `Date.now()`, and the store only changes
   * when the server speaks — which during the hour-long step is never. Without
   * a tick of its own the "quiet for…" line would freeze at the exact moment it
   * became worth reading. One second is cheap: this component is three spans.
   */
  const [, tick] = useState(0);
  const live = job.phase === 'submitting' || job.phase === 'queued' || job.phase === 'running';
  useEffect(() => {
    if (!live) return undefined;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [live]);

  if (job.phase === 'idle') return null;

  const pct = job.progress.max > 0 ? (job.progress.value / job.progress.max) * 100 : 0;
  const dotColor =
    job.phase === 'error' ? 'bg-err'
    : job.phase === 'done' ? 'bg-ok'
    : job.phase === 'cancelled' ? 'bg-ink-mute'
    : 'bg-brand animate-pulse-soft';

  const elapsed = job.startedAt ? (Date.now() - job.startedAt) / 1000 : null;
  const quietFor = live && job.lastEventAt ? (Date.now() - job.lastEventAt) / 1000 : null;
  const quiet = quietFor !== null && quietFor > QUIET_SECONDS;

  // "step 3 of 8" only once the server has actually reported a step: max is 1
  // until then, and "0 of 1" would be an invention.
  const steps = job.progress.max > 1
    ? `${Math.round(job.progress.value)}/${Math.round(job.progress.max)}`
    : null;

  const device = job.device;
  const vramTight = device !== null && device.totalBytes > 0
    && device.freeBytes / device.totalBytes < 0.05;

  return (
    <div className="rounded-xl border border-line bg-bg-raised p-3 space-y-2">
      <div className="flex items-center justify-between gap-2 text-xs">
        <div className="flex min-w-0 items-center gap-2">
          <span className={`h-2 w-2 shrink-0 rounded-full ${dotColor}`} />
          <span className="shrink-0 text-ink-dim capitalize">{job.phase}</span>
          {live && job.stage === 'gpu-starting' && (
            <span className="shrink-0 rounded bg-warn/15 px-1.5 py-0.5 text-[10px] font-medium text-warn" title="The server is starting a GPU worker for this job (cold start). GPU billing starts when it runs.">
              starting GPU
            </span>
          )}
          {live && job.stage === 'queued' && (
            <span className="shrink-0 rounded bg-bg-subtle px-1.5 py-0.5 text-[10px] text-ink-dim" title="Waiting in the server queue — one GPU job runs at a time">
              in queue
            </span>
          )}
          {job.message && <span className="truncate text-ink-mute">· {job.message}</span>}
        </div>
        <span className="flex shrink-0 items-center gap-2 font-mono text-ink-mute">
          {steps && <span title="Sampling steps reported by the server">step {steps}</span>}
          {/* GPU time is billed by the second on a self-hosted cloud, so the
              meter is shown while it runs, not after the fact. */}
          {job.costUsd !== null && <span title="Cost so far on this job">${job.costUsd.toFixed(3)}</span>}
          {elapsed !== null && <span title="Since this shot was submitted">{hms(elapsed)}</span>}
        </span>
      </div>

      {(job.phase === 'running' || job.phase === 'queued') && (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg-subtle">
          <div
            className="h-full bg-brand transition-all duration-200"
            style={{ width: `${Math.max(2, pct)}%` }}
          />
        </div>
      )}

      {live && (device || quietFor !== null) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-ink-mute">
          {quietFor !== null && (
            <span
              className={quiet ? 'text-warn' : undefined}
              title="Time since the server last reported anything about this job"
            >
              last word from the server {hms(quietFor)} ago
            </span>
          )}
          {device && (
            <span
              className={vramTight ? 'text-warn' : undefined}
              title={device.name ?? 'Render device'}
            >
              VRAM {gb(device.freeBytes)} free of {gb(device.totalBytes)}
            </span>
          )}
        </div>
      )}

      {/*
        The sentence that was missing.

        Two facts the panel already has — a long silence and a card with nothing
        left on it — mean one specific thing, and saying it costs a line. When
        only one of the two is true it says less, because it knows less.
      */}
      {quiet && (
        <p className="rounded-lg border border-warn/40 bg-warn/10 px-2.5 py-2 text-[11px] leading-snug text-ink">
          {vramTight
            ? 'Still running, but the GPU is full and no step has been reported for a while. '
              + 'A clip this long may not fit: on this hardware the time per step climbs steeply '
              + 'once the working set stops fitting in VRAM. Cancel and shorten the slot, or leave '
              + 'it — it does finish, just slowly.'
            : 'Still running, and the server has not reported a step for a while. That is normal '
              + 'for a long clip on a busy card; it is not a crash unless the elapsed time stops '
              + 'making sense.'}
        </p>
      )}

      {job.previewUrl && (
        <img
          src={job.previewUrl}
          alt="Preview"
          className="w-full rounded-md border border-line object-contain max-h-48 bg-black"
        />
      )}

      {job.error && (
        <p className="text-xs text-err font-mono whitespace-pre-wrap break-all">{job.error}</p>
      )}

      {job.phase === 'done' && job.resultPath && (
        <p className="text-xs text-ok font-mono truncate" title={job.resultPath}>
          ✓ {job.resultPath}
        </p>
      )}
    </div>
  );
}
