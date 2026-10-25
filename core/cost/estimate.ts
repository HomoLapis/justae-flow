/**
 * What a run will cost before it is queued, and what it cost after — both
 * derived, and both said with their basis.
 *
 * Neither number exists as an API answer. Comfy Cloud and a Comfy API
 * deployment bill GPU time from one pool of credits, but no endpoint returns
 * the cost of a job: a v2 job carries `metrics.execution_ms` (SDK 0.5.0,
 * `types.gen.d.ts`), and the account's balance comes from a billing report
 * that is drawn from invoices, not live usage (openapi-cloud.yaml,
 * `/api/billing/usage/timeseries`). So:
 *
 *   after   execution seconds × the GPU's rate                 ("≈", always)
 *   before  earlier runs of the same workflow on the same resource and GPU,
 *           scaled by the slot for video, as a range from the fastest to the
 *           slowest; with none on record, just the rate per minute
 *
 * Never a curve fitted past the data: a slot longer than any run on record is
 * flagged, because time per step jumps once a working set stops fitting in
 * VRAM (measured on a 16 GB card; see RunCost in client/src/state/store.ts).
 *
 * Moved here from the Flow window's costEstimate.ts so the server can answer
 * `POST /api/estimate` from its own run history.
 */

/** 211 credits = 1 US dollar (comfy.org/cloud/pricing, read 25 Oct 2026). */
export const CREDITS_PER_USD = 211;

/**
 * GPU rates of Comfy API deployments, credits per hour of GPU time
 * (comfy.org/cloud/pricing, "Comfy API" section, read 25 Oct 2026). Comfy Cloud
 * itself runs on the RTX PRO 6000 (same page), so its jobs are derived at that
 * rate too.
 */
export const GPUS = {
  'rtx-pro-6000': { label: 'RTX PRO 6000', vramGb: 96, creditsPerHour: 736.39 },
  h100: { label: 'H100', vramGb: 80, creditsPerHour: 1314.53 },
  h200: { label: 'H200', vramGb: 141, creditsPerHour: 1626.81 },
  b200: { label: 'B200', vramGb: 180, creditsPerHour: 2369.53 },
} as const;
export type GpuId = keyof typeof GPUS;
export const DEFAULT_GPU: GpuId = 'rtx-pro-6000';

export function isGpuId(v: unknown): v is GpuId {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(GPUS, v);
}

/** Credits for this much GPU time at this rate. */
export function creditsFor(ms: number, creditsPerHour: number): number {
  return (ms / 3_600_000) * creditsPerHour;
}

export function usdFor(credits: number): number {
  return credits / CREDITS_PER_USD;
}

/** Cents of balance (the billing report's unit) as credits. */
export function centsToCredits(cents: number): number {
  return (cents / 100) * CREDITS_PER_USD;
}

/** One finished run, as the run history keeps it. */
export interface RunRecord {
  at: string;
  workflowId: string;
  resourceId: string;
  resourceKind: string;
  /** The GPU it was billed on; null for a resource that does not bill (your own GPU). */
  gpu: string | null;
  /** GPU execution time as the server reported it; null when it reported none. */
  executionMs: number | null;
  /** Where executionMs came from. */
  timing: 'execution_ms' | 'started→completed' | 'history' | 'wall';
  /** From submit to result, as the plugin saw it (includes queue, cold start, transfer). */
  wallMs: number;
  /** The slot the output had to fill, seconds (video), or null. */
  slotSeconds: number | null;
  /** The output scales with the slot (video), or is one thing per run (a still). */
  scaleWithSlot: boolean;
  /** execution seconds × the GPU's rate, when the resource bills. */
  derivedCredits: number | null;
  creditsPerHour: number | null;
  jobId?: string;
}

export interface EstimateInput {
  slotSeconds: number | null;
  scaleWithSlot: boolean;
  /** Null for a resource that does not bill (a local GPU, the proxy). */
  creditsPerHour: number | null;
  gpuLabel: string | null;
}

export interface Estimate {
  /**
   *   timed  from runs of this workflow on this resource
   *   rate   no run on record: the GPU's rate only
   *   free   your own GPU: no credits; time from runs on record, if any
   */
  basis: 'timed' | 'rate' | 'free';
  runs: number;
  /** Which time the runs gave: GPU execution time, or wall-clock (an upper bound: queue and start-up included). */
  timing: 'execution' | 'wall' | null;
  secondsLow: number | null;
  secondsHigh: number | null;
  creditsLow: number | null;
  creditsHigh: number | null;
  creditsPerMinute: number | null;
  gpuLabel: string | null;
  /** The slot is longer than any run on record: the high end is not reliable. */
  beyondHistory: boolean;
}

/** Seconds a run would take for this slot, from one run on record. */
function scaled(r: RunRecord, seconds: number, input: EstimateInput): number {
  if (input.scaleWithSlot && r.scaleWithSlot && input.slotSeconds && r.slotSeconds && r.slotSeconds > 0) {
    return (seconds / r.slotSeconds) * input.slotSeconds;
  }
  return seconds;
}

/**
 * The estimate for one run. `runs` must already be this workflow on this
 * resource (and this GPU); the newest twelve are used.
 */
export function estimateRun(runs: RunRecord[], input: EstimateInput): Estimate {
  const recent = [...runs].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 12);
  const exec = recent.filter((r) => typeof r.executionMs === 'number' && r.executionMs > 0);
  // GPU time is what bills; wall-clock only when no run reported it.
  const pool = exec.length ? exec : recent.filter((r) => r.wallMs > 0);
  const timing: Estimate['timing'] = pool.length ? (exec.length ? 'execution' : 'wall') : null;
  const secs = pool.map((r) => scaled(r, (timing === 'execution' ? r.executionMs! : r.wallMs) / 1000, input));
  const maxSlot = pool.reduce((m, r) => Math.max(m, r.slotSeconds ?? 0), 0);
  const beyondHistory = input.scaleWithSlot && pool.length > 0 && (input.slotSeconds ?? 0) > maxSlot + 0.01;
  const secondsLow = secs.length ? Math.min(...secs) : null;
  const secondsHigh = secs.length ? Math.max(...secs) : null;
  const perMin = input.creditsPerHour !== null ? input.creditsPerHour / 60 : null;
  if (input.creditsPerHour === null) {
    return { basis: 'free', runs: pool.length, timing, secondsLow, secondsHigh, creditsLow: null, creditsHigh: null, creditsPerMinute: null, gpuLabel: input.gpuLabel, beyondHistory };
  }
  if (!pool.length) {
    return { basis: 'rate', runs: 0, timing: null, secondsLow: null, secondsHigh: null, creditsLow: null, creditsHigh: null, creditsPerMinute: perMin, gpuLabel: input.gpuLabel, beyondHistory: false };
  }
  return {
    basis: 'timed', runs: pool.length, timing, secondsLow, secondsHigh,
    creditsLow: creditsFor(secondsLow! * 1000, input.creditsPerHour),
    creditsHigh: creditsFor(secondsHigh! * 1000, input.creditsPerHour),
    creditsPerMinute: perMin, gpuLabel: input.gpuLabel, beyondHistory,
  };
}

/** Several runs in a row (a Storyboard series): the ranges add up; the basis is the weakest one. */
export function sumEstimates(list: Estimate[]): Estimate & { shots: number; unknown: number } {
  const known = list.filter((e) => e.secondsLow !== null);
  const add = (k: 'secondsLow' | 'secondsHigh' | 'creditsLow' | 'creditsHigh'): number | null =>
    known.length && known.every((e) => e[k] !== null) ? known.reduce((n, e) => n + (e[k] as number), 0) : null;
  const basis: Estimate['basis'] = list.some((e) => e.basis === 'rate') ? 'rate' : list.every((e) => e.basis === 'free') ? 'free' : 'timed';
  return {
    // The weakest basis: a series is "based on N runs" only as far as its least-known shot.
    basis, runs: list.length ? Math.min(...list.map((e) => e.runs)) : 0,
    timing: list.some((e) => e.timing === 'wall') ? 'wall' : known.length ? 'execution' : null,
    secondsLow: add('secondsLow'), secondsHigh: add('secondsHigh'), creditsLow: add('creditsLow'), creditsHigh: add('creditsHigh'),
    creditsPerMinute: list[0]?.creditsPerMinute ?? null, gpuLabel: list[0]?.gpuLabel ?? null,
    beyondHistory: list.some((e) => e.beyondHistory), shots: list.length, unknown: list.length - known.length,
  };
}

/* ─── Words ─────────────────────────────────────────────────────────── */

export function formatCredits(v: number): string {
  if (v < 10) return v.toFixed(1);
  return Math.round(v).toLocaleString('en-US');
}

export function formatUsd(v: number): string {
  return v < 0.1 ? `$${v.toFixed(3)}` : `$${v.toFixed(2)}`;
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}:${String(s % 60).padStart(2, '0')} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

function range(lo: number, hi: number, f: (v: number) => string): string {
  return Math.abs(hi - lo) / Math.max(hi, 1e-9) < 0.05 ? f(hi) : `${f(lo)}–${f(hi)}`;
}

/** "30–45 s", "4:00–4:48 min": one unit when both ends share it. */
function durationRange(lo: number, hi: number): string {
  if (Math.abs(hi - lo) / Math.max(hi, 1e-9) < 0.05) return formatDuration(hi);
  const a = formatDuration(lo);
  const b = formatDuration(hi);
  const unit = (x: string): string => x.replace(/^[\d:]+ /, '');
  return unit(a) === unit(b) && !/ h /.test(a) ? `${a.replace(/ [a-z]+$/, '')}–${b}` : `${a}–${b}`;
}

/** One line under a Generate button. Every number carries its basis; estimates always carry "≈". */
export function describeEstimate(e: Estimate & { shots?: number; unknown?: number }, where: string): string {
  const shots = e.shots && e.shots > 1 ? `${e.shots} shots · ` : '';
  const time = e.secondsLow !== null && e.secondsHigh !== null ? `~${durationRange(e.secondsLow, e.secondsHigh)}` : '';
  const basisRuns = `${e.runs} run${e.runs === 1 ? '' : 's'}${e.timing === 'wall' ? ', wall-clock incl. queue' : ''}`;
  if (e.basis === 'free') {
    return `${shots}${where} · no credits${time ? ` · ${time}${e.beyondHistory ? '+' : ''} (based on ${basisRuns})` : ' · no run of this workflow here yet'}`;
  }
  const rate = e.creditsPerMinute !== null ? `${e.creditsPerMinute.toFixed(1)} cr/min on ${e.gpuLabel ?? 'the GPU'}` : '';
  if (e.basis === 'rate' || e.creditsLow === null || e.creditsHigh === null) {
    const partial = e.unknown && e.shots && e.unknown < e.shots ? ` (${e.unknown} of ${e.shots} without a run yet)` : '';
    return `${shots}${where} · first run: ${rate} · no run of this workflow here yet${partial}`;
  }
  const cr = range(e.creditsLow, e.creditsHigh, formatCredits);
  const usd = formatUsd(usdFor((e.creditsLow + e.creditsHigh) / 2));
  return `${shots}≈ ${cr}${e.beyondHistory ? '+' : ''} cr (~${usd}) · ${time} on ${where} · based on ${basisRuns} on ${e.gpuLabel ?? 'this GPU'}`
    + (e.beyondHistory ? ' · longer than any run so far' : '');
}
