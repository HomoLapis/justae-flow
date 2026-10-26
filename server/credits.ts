/**
 * The Comfy account's credit balance, for the header pill and the panel.
 *
 * The only endpoint that states it is the v1 Cloud billing report,
 * `GET https://cloud.comfy.org/api/billing/usage/timeseries` with `X-API-Key`
 * (openapi-cloud.yaml, operation getBillingUsageTimeSeries). Its
 * `summary.balance` fields are cents despite their `_micros` suffix (the
 * spec says so), and its figures "are drawn from your invoices rather than
 * from live request traffic" — so the balance is shown with the time it was
 * read and the word "invoices", never as a live meter.
 *
 * Read on demand, kept five minutes, and read again after every finished job
 * on Comfy Cloud or a deployment (they draw on the same credits: PLAN v3 §1,
 * comfy.org/cloud/pricing). If it has not moved yet, the view says so.
 *
 * The same report, by the hour and grouped by product, also says what the GPU
 * of a deployment was billed in each hour ("Serverless GPU", in `cost_micros`
 * of a dollar). `reconcile` reads it for the hours of deployment runs, at most
 * every ten minutes, and gives each run its share of its hours (pro rata to
 * its derived GPU time there): `billedCredits` with the report's `as_of`. The
 * report lags, so a run's hours are read until they have settled. Figures go
 * to runs.json in the user's folder only — never to a log.
 */

import { centsToCredits, CREDITS_PER_USD, IDLE_SECONDS, microsToCredits, type RunRecord } from '../core/cost/estimate.ts';
import { CLOUD_BASE, type ResourceRegistry } from './resources.ts';
import type { RunLog } from './runs.ts';

export interface CreditsView {
  ok: boolean;
  /** Why there is no balance: no key, the key refused, the report unreachable. */
  error?: string;
  balanceCents: number | null;
  prepaidCents: number | null;
  planCents: number | null;
  currency: string | null;
  credits: number | null;
  prepaidCredits: number | null;
  planCredits: number | null;
  creditsPerUsd: number;
  /** When this server read it. */
  asOf: string | null;
  source: 'invoices';
  /** The reading before this one, to say whether a finished job shows yet. */
  previous: { credits: number; asOf: string } | null;
  /** Spend in the reported range, millionths of a dollar (summary.spend_micros). */
  spendMicros: number | null;
  range: { from: string; to: string } | null;
  /** A refresh after a job is still due. */
  pendingRefresh: boolean;
}

const TTL = 5 * 60_000;

/* ─── The hourly report, given to runs ─────────────────────────────── */

/** A deployment's GPU in the hourly report grouped by product (its `group_key`, read 26 Oct 2026). */
export const DEPLOYMENT_GPU_PRODUCT = 'Serverless GPU';
/** The report is read for runs at most this often. */
export const RECONCILE_EVERY_MS = 10 * 60_000;
/** Runs older than this without a settled figure are left as derived. */
const LOOKBACK_MS = 3 * 24 * 3_600_000;
/** A figure read this long after the end of the run's last hour is taken as settled: its hours are not read again. */
const SETTLED_MS = 6 * 3_600_000;
const HOUR = 3_600_000;

export interface HourBucket { cost_micros?: number; group_key?: string; period_start?: string; period_end?: string }

/** The span a run was billed over, as derived: start-up and execution before it finished, its idle window after. */
export function billedSpan(r: RunRecord): { from: number; to: number } | null {
  const end = Date.parse(r.at);
  if (r.executionMs === null || !Number.isFinite(end)) return null;
  const idle = r.overhead === 'cold' || r.overhead === 'warm' ? IDLE_SECONDS * 1000 : 0;
  const before = Math.max(0, (r.overheadMs ?? 0) - idle);
  return { from: end - r.executionMs - before, to: end + idle };
}

/**
 * The report's GPU amount of each hour, shared among the deployment runs billed in that hour, pro rata to their
 * derived GPU time in it (time × rate). A run gets a figure only when every hour it spans had ended by the
 * report's as_of, at least one of them carries a GPU amount, and its span lies inside `window` (the hours read).
 * Pure: the selftest feeds it a made-up report.
 */
export function attributeBilled(runs: readonly RunRecord[], buckets: HourBucket[], asOf: number, window: { from: number; to: number }, product = DEPLOYMENT_GPU_PRODUCT): Map<RunRecord, number> {
  const gpu = buckets
    .filter((b) => b.group_key === product && typeof b.cost_micros === 'number' && b.cost_micros > 0 && b.period_start && b.period_end)
    .map((b) => ({ from: Date.parse(b.period_start!), to: Date.parse(b.period_end!), credits: microsToCredits(b.cost_micros!) }))
    .filter((b) => Number.isFinite(b.from) && Number.isFinite(b.to) && b.to > b.from);
  const runsHere = runs
    .filter((r) => r.resourceKind === 'deployment' && r.creditsPerHour !== null && r.executionMs !== null)
    .map((r) => ({ r, span: billedSpan(r) }))
    .filter((x): x is { r: RunRecord; span: { from: number; to: number } } => x.span !== null);
  const got = new Map<RunRecord, number>();
  for (const b of gpu) {
    const weights = runsHere.map((x) => Math.max(0, Math.min(x.span.to, b.to) - Math.max(x.span.from, b.from)) * x.r.creditsPerHour!);
    const total = weights.reduce((n, w) => n + w, 0);
    if (total <= 0) continue;
    runsHere.forEach((x, i) => { if (weights[i] > 0) got.set(x.r, (got.get(x.r) ?? 0) + (b.credits * weights[i]) / total); });
  }
  const out = new Map<RunRecord, number>();
  for (const x of runsHere) {
    const v = got.get(x.r);
    if (v === undefined || x.span.from < window.from || x.span.to > window.to) continue;
    if (Math.ceil(x.span.to / HOUR) * HOUR > asOf) continue;
    out.set(x.r, v);
  }
  return out;
}

const isoSeconds = (ms: number): string => new Date(ms).toISOString().slice(0, 19) + 'Z';

interface Balance {
  amount_micros?: number; prepaid_balance_micros?: number; cloud_credit_balance_micros?: number; currency?: string;
  amount_cents?: number; prepaid_balance_cents?: number; cloud_credit_balance_cents?: number;
}

export class Credits {
  private registry: ResourceRegistry;
  private cache: CreditsView | null = null;
  private readAt = 0;
  private inflight: Promise<CreditsView> | null = null;
  private pending: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<(v: CreditsView) => void>();

  private base: string;
  private runs: RunLog | null;
  private reconciledAt = 0;
  private reconciling: Promise<number> | null = null;

  /** `base`: Comfy Cloud, or a stand-in for the selftest. `runs`: the history the hourly report is given to. */
  constructor(registry: ResourceRegistry, base = CLOUD_BASE, runs: RunLog | null = null) {
    this.registry = registry;
    this.base = base;
    this.runs = runs;
    registry.onChange(() => { this.readAt = 0; });
  }

  /**
   * Give deployment runs their share of the hourly report, when it has their hours. Reads the report at most
   * every ten minutes (`force` skips that, for the selftest), and only while some run in the last three days has
   * no settled figure. Returns how many runs got a figure.
   */
  async reconcile(force = false): Promise<number> {
    if (!this.runs) return 0;
    if (this.reconciling) return this.reconciling;
    if (!force && Date.now() - this.reconciledAt < RECONCILE_EVERY_MS) return 0;
    this.reconciling = this.reconcileNow().finally(() => { this.reconciling = null; });
    return this.reconciling;
  }

  private async reconcileNow(): Promise<number> {
    const key = this.registry.key();
    if (!key || !this.runs) return 0;
    const now = Date.now();
    const deployed = this.runs.all().filter((r) => r.resourceKind === 'deployment' && r.creditsPerHour !== null && r.executionMs !== null && now - Date.parse(r.at) < LOOKBACK_MS);
    const pending = deployed.filter((r) => {
      const span = billedSpan(r)!;
      return !r.billedAsOf || Date.parse(r.billedAsOf) < Math.ceil(span.to / HOUR) * HOUR + SETTLED_MS;
    });
    if (!pending.length) return 0;
    this.reconciledAt = now;
    // The hours of the pending runs, widened to every run that shares them (each hour is shared among all its runs).
    let from = Math.min(...pending.map((r) => billedSpan(r)!.from));
    let to = Math.max(...pending.map((r) => billedSpan(r)!.to));
    for (const r of deployed) {
      const s = billedSpan(r)!;
      if (s.to > from && s.from < to) { from = Math.min(from, s.from); to = Math.max(to, s.to); }
    }
    const start = Math.floor(from / HOUR) * HOUR;
    // And the hour after: the report lags, and an idle window can end past the hour.
    const end = Math.min(Math.ceil(to / HOUR) * HOUR + HOUR, Math.ceil(now / HOUR) * HOUR);
    const q = new URLSearchParams({ granularity: 'hour', group_by: 'product', starting_on: isoSeconds(start), ending_before: isoSeconds(end) });
    let body: { buckets?: HourBucket[]; as_of?: string };
    try {
      const r = await fetch(`${this.base}/api/billing/usage/timeseries?${q}`, { headers: { 'X-API-Key': key, Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
      if (!r.ok) return 0;
      body = await r.json() as typeof body;
    } catch {
      return 0;
    }
    const asOf = body.as_of && !Number.isNaN(Date.parse(body.as_of)) ? Date.parse(body.as_of) : now;
    const billed = attributeBilled(deployed, Array.isArray(body.buckets) ? body.buckets : [], asOf, { from: start, to: end });
    const billedAsOf = new Date(asOf).toISOString();
    const changes = [...billed].map(([run, credits]) => ({ run, set: { billedCredits: Math.round(credits * 100) / 100, billedAsOf } }));
    this.runs.patch(changes);
    return changes.length;
  }

  onChange(fn: (v: CreditsView) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  cached(): CreditsView | null {
    return this.cache;
  }

  private empty(error: string): CreditsView {
    return {
      ok: false, error, balanceCents: null, prepaidCents: null, planCents: null, currency: null, credits: null, prepaidCredits: null,
      planCredits: null, creditsPerUsd: CREDITS_PER_USD, asOf: null, source: 'invoices', previous: null, spendMicros: null, range: null,
      pendingRefresh: !!this.pending,
    };
  }

  async get(force = false): Promise<CreditsView> {
    if (!force && this.cache && Date.now() - this.readAt < TTL) return { ...this.cache, pendingRefresh: !!this.pending };
    if (this.inflight) return this.inflight;
    this.inflight = this.read().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async read(): Promise<CreditsView> {
    const key = this.registry.key();
    if (!key) { this.cache = this.empty('No API key yet.'); this.readAt = Date.now(); return this.cache; }
    const before = this.cache?.ok && this.cache.credits !== null && this.cache.asOf ? { credits: this.cache.credits, asOf: this.cache.asOf } : this.cache?.previous ?? null;
    let view: CreditsView;
    try {
      // One month in one bucket: the smallest report that still carries summary.balance.
      const r = await fetch(`${this.base}/api/billing/usage/timeseries?granularity=month&months=1`, {
        headers: { 'X-API-Key': key, Accept: 'application/json' }, signal: AbortSignal.timeout(20_000),
      });
      const text = await r.text();
      if (!r.ok) {
        view = this.empty(r.status === 401 ? 'The key was not accepted (401).' : r.status === 429 ? 'The key is on an inactive subscription (429).' : `The billing report answered HTTP ${r.status}.`);
      } else {
        const body = JSON.parse(text) as { summary?: { spend_micros?: number; balance?: Balance }; starting_on?: string; ending_before?: string; as_of?: string };
        const b = body.summary?.balance;
        // Measured 25 Oct 2026: the balance also comes as *_cents fields, equal to the *_micros ones (which the
        // spec says are cents). The *_cents names are preferred when present; the spec's names otherwise.
        const pick = (c?: number, m?: number): number | null => (typeof c === 'number' ? c : typeof m === 'number' ? m : null);
        const cents = pick(b?.amount_cents, b?.amount_micros);
        const prepaid = pick(b?.prepaid_balance_cents, b?.prepaid_balance_micros);
        const plan = pick(b?.cloud_credit_balance_cents, b?.cloud_credit_balance_micros);
        view = {
          ok: cents !== null, error: cents === null ? 'The report has no balance (summary.balance is omitted when none could be read).' : undefined,
          balanceCents: cents, prepaidCents: prepaid, planCents: plan,
          currency: b?.currency ?? null,
          credits: cents !== null ? centsToCredits(cents) : null,
          prepaidCredits: prepaid !== null ? centsToCredits(prepaid) : null,
          planCredits: plan !== null ? centsToCredits(plan) : null,
          // The report's own `as_of` (not in the OpenAPI document; measured), else when this server read it.
          creditsPerUsd: CREDITS_PER_USD, asOf: body.as_of && !Number.isNaN(Date.parse(body.as_of)) ? new Date(Date.parse(body.as_of)).toISOString() : new Date().toISOString(), source: 'invoices', previous: before,
          spendMicros: body.summary?.spend_micros ?? null,
          range: body.starting_on && body.ending_before ? { from: body.starting_on, to: body.ending_before } : null,
          pendingRefresh: !!this.pending,
        };
      }
    } catch (e) {
      view = this.empty(`The billing report could not be reached: ${e instanceof Error ? e.message : e}`);
    }
    // A failed read keeps the last good balance visible, with its own time.
    if (!view.ok && this.cache?.ok) view = { ...this.cache, error: view.error, pendingRefresh: !!this.pending };
    this.cache = view;
    this.readAt = Date.now();
    for (const fn of this.listeners) fn(view);
    return view;
  }

  /**
   * After a job on Comfy Cloud or a deployment: read now, and once more a
   * minute later — the report follows invoices, so the first read may not
   * show the job yet.
   */
  refreshAfterJob(): void {
    void this.get(true);
    if (this.pending) clearTimeout(this.pending);
    this.pending = setTimeout(() => { this.pending = null; void this.get(true); }, 60_000);
    this.pending.unref?.();
  }
}
