/**
 * What a shot will cost before it is queued — as a range, with its basis said.
 *
 * Built only from things the panel has measured or the server has stated:
 *   1. finished runs of THIS workflow on THIS backend that recorded what they
 *      were billed (a metered backend's estimate) — dollars per second of slot, same GPU
 *      preferred;
 *   2. otherwise finished runs' wall-clock time × the GPU's price per second
 *      (an upper bound: wall-clock includes queue wait and cold start);
 *   3. otherwise just the price per minute of the chosen GPU.
 * Never a curve fitted past the data: a slot longer than anything that has
 * come back is flagged, because on this hardware time per step jumps once the
 * working set stops fitting in VRAM (see RunCost in the store).
 */
import type { RunCost } from '../state/store';

export interface CostEstimate {
  basis: 'billed' | 'timed' | 'rate' | 'none';
  usdLow: number | null;
  usdHigh: number | null;
  /** Runs the estimate is based on. */
  runs: number;
  usdPerMinute: number | null;
  /** The slot is longer than any run on record — the high end is not reliable. */
  beyondHistory: boolean;
}

export function estimateShot(
  runs: RunCost[],
  slotSeconds: number,
  usdPerSec: number | null,
  gpu?: string,
): CostEstimate {
  const perMin = usdPerSec !== null ? usdPerSec * 60 : null;
  const maxSlot = runs.reduce((m, r) => Math.max(m, r.slotSeconds), 0);
  const beyondHistory = runs.length > 0 && slotSeconds > maxSlot + 0.01;
  const usable = runs.filter((r) => r.slotSeconds > 0);

  const billed = usable.filter((r) => typeof r.costUsd === 'number' && r.costUsd > 0);
  const sameGpu = gpu !== undefined ? billed.filter((r) => (r.gpu ?? '') === gpu) : billed;
  const pool = sameGpu.length ? sameGpu : billed;
  if (pool.length) {
    const rates = pool.map((r) => (r.costUsd as number) / r.slotSeconds);
    return {
      basis: 'billed', runs: pool.length, usdPerMinute: perMin, beyondHistory,
      usdLow: Math.min(...rates) * slotSeconds, usdHigh: Math.max(...rates) * slotSeconds,
    };
  }
  if (usable.length && usdPerSec !== null) {
    const rates = usable.map((r) => (r.gpuSeconds ?? r.renderSeconds) / r.slotSeconds);
    return {
      basis: 'timed', runs: usable.length, usdPerMinute: perMin, beyondHistory,
      usdLow: Math.min(...rates) * slotSeconds * usdPerSec, usdHigh: Math.max(...rates) * slotSeconds * usdPerSec,
    };
  }
  return { basis: perMin !== null ? 'rate' : 'none', runs: 0, usdPerMinute: perMin, beyondHistory: false, usdLow: null, usdHigh: null };
}

export function formatUsd(v: number): string {
  return v < 0.1 ? `$${v.toFixed(3)}` : `$${v.toFixed(2)}`;
}

/** One line for the UI. */
export function describeEstimate(e: CostEstimate): string {
  if (e.basis === 'none') return '';
  if (e.basis === 'rate') return `GPU ${formatUsd(e.usdPerMinute ?? 0)}/min · no finished run of this workflow yet`;
  const range = e.usdLow !== null && e.usdHigh !== null
    ? (Math.abs(e.usdHigh - e.usdLow) < 0.0005 ? `~${formatUsd(e.usdLow)}` : `${formatUsd(e.usdLow)}–${formatUsd(e.usdHigh)}`)
    : '';
  const basis = e.basis === 'billed' ? `billed runs: ${e.runs}` : `timed runs: ${e.runs}, includes queue/start-up`;
  return `est. ${range}${e.beyondHistory ? '+' : ''} (${basis})${e.beyondHistory ? ' · longer than any run so far' : ''}`;
}
