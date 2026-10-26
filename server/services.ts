/**
 * The resource services, wired once: the registry, the run history, the
 * capability probe, the v2 job runner and the credit balance. index.ts builds
 * them on the user's config folder; the selftest on a temporary one, so a test
 * run never writes into the user's history.
 */

import { creditsFor, jobCredits, WARM_WINDOW_MS } from '../core/cost/estimate.ts';
import type { Settings } from './config.ts';
import { CapabilityProbe } from './capabilities.ts';
import { Credits, RECONCILE_EVERY_MS } from './credits.ts';
import type { WorkflowLibrary } from './library.ts';
import { ResourceRegistry } from './resources.ts';
import { RunLog } from './runs.ts';
import { V2Jobs } from './v2run.ts';

export interface Services {
  resources: ResourceRegistry;
  runs: RunLog;
  caps: CapabilityProbe;
  v2: V2Jobs;
  credits: Credits;
}

/**
 * Runs on a deployment recorded before the start-up allowance, derived again once: cold when no run ended there in
 * the minute before it was submitted. The figure they had (execution time × rate) is kept as executionCredits.
 */
export function rederiveDeploymentRuns(runs: RunLog, resources: ResourceRegistry): number {
  const all = runs.all();
  const changes = [];
  for (let i = 0; i < all.length; i++) {
    const r = all[i];
    if (r.resourceKind !== 'deployment' || r.costBasis || r.creditsPerHour === null || r.executionMs === null) continue;
    const res = resources.get(r.resourceId);
    if (!res) continue;
    const submitted = Date.parse(r.at) - r.wallMs;
    let prev = -Infinity;
    for (let j = 0; j < i; j++) {
      const t = Date.parse(all[j].at);
      if (all[j].resourceId === r.resourceId && t <= submitted) prev = Math.max(prev, t);
    }
    const ov = resources.overhead(res, submitted - prev > WARM_WINDOW_MS);
    changes.push({ run: r, set: {
      executionCredits: creditsFor(r.executionMs, r.creditsPerHour), derivedCredits: jobCredits(r.executionMs, r.creditsPerHour, ov),
      costBasis: ov.basis, overhead: ov.kind, overheadMs: ov.seconds * 1000,
    } });
  }
  runs.patch(changes);
  return changes.length;
}

/** `cloudBase` stands in for https://cloud.comfy.org in the selftest, so it never leaves loopback (and nothing runs on a timer). */
export function makeServices(dir: string, settings: () => Pick<Settings, 'comfyUrl' | 'comfyToken' | 'comfyGpu'>, library: WorkflowLibrary, cloudBase?: string): Services {
  const resources = new ResourceRegistry(dir, settings().comfyUrl);
  const runs = new RunLog(dir);
  rederiveDeploymentRuns(runs, resources);
  const caps = new CapabilityProbe(resources, library, runs, () => ({ token: settings().comfyToken, gpu: settings().comfyGpu }), cloudBase);
  const v2 = new V2Jobs(resources, runs);
  const credits = new Credits(resources, cloudBase, runs);
  // Comfy Cloud and deployments draw on the same credits: read the balance again after every job there.
  v2.onFinished((r) => { if (resources.creditsPerHour(r) !== null) credits.refreshAfterJob(); });
  if (!cloudBase) {
    // The hourly report, given to deployment runs once it has their hours: soon after start, then every ten minutes
    // (a read happens only while some run lacks a settled figure).
    setTimeout(() => void credits.reconcile().catch(() => undefined), 5_000).unref?.();
    setInterval(() => void credits.reconcile().catch(() => undefined), RECONCILE_EVERY_MS).unref?.();
  }
  return { resources, runs, caps, v2, credits };
}
