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
 */

import { centsToCredits, CREDITS_PER_USD } from '../core/cost/estimate.ts';
import { CLOUD_BASE, type ResourceRegistry } from './resources.ts';

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

  /** `base`: Comfy Cloud, or a stand-in for the selftest. */
  constructor(registry: ResourceRegistry, base = CLOUD_BASE) {
    this.registry = registry;
    this.base = base;
    registry.onChange(() => { this.readAt = 0; });
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
