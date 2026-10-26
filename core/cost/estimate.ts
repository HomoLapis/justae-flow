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
 *   after   (execution seconds + what the worker billed around them) × the
 *           GPU's rate                                         ("≈", always)
 *   before  earlier runs of the same workflow on the same resource and GPU,
 *           scaled by the slot for video, as a range from the fastest to the
 *           slowest, plus the same allowance; with none on record, just the
 *           rate per minute (and the allowance)
 *
 * "What the worker billed around them": a deployment's flex worker bills "per
 * second from the moment it starts, including startup and model loading, plus
 * a short idle window (currently 30 seconds)" (docs.comfy.org, Serverless
 * overview), none of which is inside the job's started_at → completed_at. See
 * `overheadFor`. When the hourly billing report has the hour, the run also
 * carries the billed figure (server/credits.ts, `attributeBilled`).
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

/** Millionths of a dollar as credits: the hourly report's `cost_micros` are real micro-dollars (measured 26 Oct 2026), unlike its balance fields. */
export function microsToCredits(micros: number): number {
  return (micros / 1_000_000) * CREDITS_PER_USD;
}

/* ─── A deployment's worker, around the job ─────────────────────────── */

/** The idle window a flex worker bills after its last job (docs.comfy.org, Serverless overview: "currently 30 seconds"). */
export const IDLE_SECONDS = 30;

/**
 * What a cold job on a scale-to-zero deployment is billed beyond its own
 * execution time: worker start-up and model loading, plus the 30 s idle window.
 * Measured on 25 Oct 2026 on an RTX PRO 6000 with 55 GB of models: two cold
 * jobs ran 260.1 s and 284.1 s (started_at → completed_at), and the hourly
 * billing report's "Serverless GPU" for that hour came to about twice what
 * that time alone gives at 736.39 cr/h — 265 s more per job. Editable per
 * deployment (Settings ▸ Resources).
 */
export const COLD_START_DEFAULT_SECONDS = 265;

/** A job finished on the same deployment this recently: its worker is still up (the idle window plus a margin). */
export const WARM_WINDOW_MS = 60_000;

/** Network storage for a deployment's staged models (`comfy deploy refs compute`, comfy-cli 1.23.0, read 25 Oct 2026). */
export const STORAGE_CREDITS_PER_GB_MONTH = 42.2;
/** Measured: the "Serverless Network Volume" line of the hourly report, every hour, for the 55 GB build. */
export const MEASURED_STORAGE_CREDITS_PER_HOUR = 3.35;
export const MEASURED_STORAGE_GB = 55;
const HOURS_PER_MONTH = (365 * 24) / 12;

/** Storage while a deployment exists, credits per hour: from its staged size when known, else the measured figure. */
export function storagePerHour(stagedGb: number | null | undefined): { creditsPerHour: number; basis: 'staged' | 'measured' } {
  return typeof stagedGb === 'number' && stagedGb > 0
    ? { creditsPerHour: (stagedGb * STORAGE_CREDITS_PER_GB_MONTH) / HOURS_PER_MONTH, basis: 'staged' }
    : { creditsPerHour: MEASURED_STORAGE_CREDITS_PER_HOUR, basis: 'measured' };
}

/**
 * GPU time a run is billed beyond its own execution, and why.
 *
 *   cold       min workers 0 and no job here in the last minute: start-up, model loading and the idle window
 *   warm       min workers 0, a job here in the last minute: the worker is up; the idle window after this one
 *   always-on  min workers 1 or more: nothing on top (the worker bills continuously instead; Settings says how much)
 *   none       not a deployment (Comfy Cloud bills the job; your GPU bills nothing)
 */
export interface Overhead {
  kind: 'cold' | 'warm' | 'always-on' | 'none';
  seconds: number;
  basis: string;
}

export const BASIS = {
  cold: 'GPU time of the job + worker start-up (measured) + 30 s idle',
  warm: 'GPU time of the job + 30 s idle (the worker was already up)',
  alwaysOn: 'GPU time of the job (min workers 1 or more: the worker bills continuously instead)',
  none: 'GPU time of the job',
} as const;

export function overheadFor(r: { kind: string; minWorkers?: number; coldStartSeconds?: number }, cold: boolean): Overhead {
  if (r.kind !== 'deployment') return { kind: 'none', seconds: 0, basis: BASIS.none };
  if ((r.minWorkers ?? 0) >= 1) return { kind: 'always-on', seconds: 0, basis: BASIS.alwaysOn };
  if (!cold) return { kind: 'warm', seconds: IDLE_SECONDS, basis: BASIS.warm };
  // The allowance is what was measured per cold job, idle window included; never less than the idle window.
  const total = typeof r.coldStartSeconds === 'number' && r.coldStartSeconds >= 0 ? r.coldStartSeconds : COLD_START_DEFAULT_SECONDS;
  return { kind: 'cold', seconds: Math.max(total, IDLE_SECONDS), basis: BASIS.cold };
}

/** The derived credits of one finished job: its execution time plus the overhead, at the rate. */
export function jobCredits(executionMs: number, creditsPerHour: number, overhead: Overhead): number {
  return creditsFor(executionMs + overhead.seconds * 1000, creditsPerHour);
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
  /** (execution + overhead) seconds × the GPU's rate, when the resource bills (see costBasis). */
  derivedCredits: number | null;
  creditsPerHour: number | null;
  jobId?: string;
  /** What derivedCredits counts, in words (BASIS). Absent on runs recorded before the start-up allowance. */
  costBasis?: string;
  /** The overhead derivedCredits includes (see Overhead), and its seconds. */
  overhead?: Overhead['kind'];
  overheadMs?: number;
  /** Execution time × rate alone — what derivedCredits was before the start-up allowance (kept for comparison). */
  executionCredits?: number | null;
  /** How long the submit waited for the job to be accepted (a deployment answers 429 while it starts a worker). */
  submitWaitMs?: number;
  /** The hourly billing report's GPU amount attributed to this run (server/credits.ts), and the report's as_of. */
  billedCredits?: number;
  billedAsOf?: string;
}

export interface EstimateInput {
  slotSeconds: number | null;
  scaleWithSlot: boolean;
  /** Null for a resource that does not bill (a local GPU, the proxy). */
  creditsPerHour: number | null;
  gpuLabel: string | null;
  /** What the worker would bill around this run (a deployment); absent = nothing. */
  overhead?: Overhead | null;
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
  /** The worker's overhead included in the seconds and credits above ('cold': start-up included), and how much. */
  overhead: Overhead['kind'] | null;
  overheadSeconds: number;
  overheadCredits: number | null;
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
  // What the worker bills around the job (a deployment's start-up, its idle window) comes on top of every run's time.
  const ov = input.overhead && input.overhead.kind !== 'none' ? input.overhead : null;
  const extra = ov?.seconds ?? 0;
  const secondsLow = secs.length ? Math.min(...secs) + extra : null;
  const secondsHigh = secs.length ? Math.max(...secs) + extra : null;
  const perMin = input.creditsPerHour !== null ? input.creditsPerHour / 60 : null;
  const over = { overhead: ov?.kind ?? null, overheadSeconds: extra, overheadCredits: ov && input.creditsPerHour !== null ? creditsFor(extra * 1000, input.creditsPerHour) : null };
  if (input.creditsPerHour === null) {
    return { basis: 'free', runs: pool.length, timing, secondsLow, secondsHigh, creditsLow: null, creditsHigh: null, creditsPerMinute: null, gpuLabel: input.gpuLabel, beyondHistory, ...over };
  }
  if (!pool.length) {
    return { basis: 'rate', runs: 0, timing: null, secondsLow: null, secondsHigh: null, creditsLow: null, creditsHigh: null, creditsPerMinute: perMin, gpuLabel: input.gpuLabel, beyondHistory: false, ...over };
  }
  return {
    basis: 'timed', runs: pool.length, timing, secondsLow, secondsHigh,
    creditsLow: creditsFor(secondsLow! * 1000, input.creditsPerHour),
    creditsHigh: creditsFor(secondsHigh! * 1000, input.creditsPerHour),
    creditsPerMinute: perMin, gpuLabel: input.gpuLabel, beyondHistory, ...over,
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
    // A series starts its worker once: the cold shot carries the start-up, the others only the idle window.
    overhead: list.some((e) => e.overhead === 'cold') ? 'cold' : list.find((e) => e.overhead)?.overhead ?? null,
    overheadSeconds: list.reduce((n, e) => n + e.overheadSeconds, 0),
    overheadCredits: list.some((e) => e.overheadCredits !== null) ? list.reduce((n, e) => n + (e.overheadCredits ?? 0), 0) : null,
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

/**
 * One line under a Generate button. Every number carries its basis; estimates always carry "≈".
 * A cold deployment's line says that its time and credits include the worker's start-up:
 *   ≈ 107 cr (~$0.51) · ~8:45 min incl. worker start-up on JustAE Flow heavy · based on 1 run on RTX PRO 6000
 */
export function describeEstimate(e: Estimate & { shots?: number; unknown?: number }, where: string): string {
  const shots = e.shots && e.shots > 1 ? `${e.shots} shots · ` : '';
  const cold = e.overhead === 'cold';
  const time = e.secondsLow !== null && e.secondsHigh !== null ? `~${durationRange(e.secondsLow, e.secondsHigh)}${cold ? ' incl. worker start-up' : ''}` : '';
  const basisRuns = `${e.runs} run${e.runs === 1 ? '' : 's'}${e.timing === 'wall' ? ', wall-clock incl. queue' : ''}`;
  if (e.basis === 'free') {
    return `${shots}${where} · no credits${time ? ` · ${time}${e.beyondHistory ? '+' : ''} (based on ${basisRuns})` : ' · no run of this workflow here yet'}`;
  }
  const rate = e.creditsPerMinute !== null ? `${e.creditsPerMinute.toFixed(1)} cr/min on ${e.gpuLabel ?? 'the GPU'}` : '';
  if (e.basis === 'rate' || e.creditsLow === null || e.creditsHigh === null) {
    const partial = e.unknown && e.shots && e.unknown < e.shots ? ` (${e.unknown} of ${e.shots} without a run yet)` : '';
    const startUp = cold && e.overheadCredits !== null ? ` + ≈ ${formatCredits(e.overheadCredits)} cr worker start-up (~${formatDuration(e.overheadSeconds)})` : '';
    return `${shots}${where} · first run: ${rate}${startUp} · no run of this workflow here yet${partial}`;
  }
  const cr = range(e.creditsLow, e.creditsHigh, formatCredits);
  const usd = formatUsd(usdFor((e.creditsLow + e.creditsHigh) / 2));
  return `${shots}≈ ${cr}${e.beyondHistory ? '+' : ''} cr (~${usd}) · ${time} on ${where} · based on ${basisRuns} on ${e.gpuLabel ?? 'this GPU'}`
    + (e.beyondHistory ? ' · longer than any run so far' : '');
}
