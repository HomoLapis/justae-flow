/**
 * The resource services, wired once: the registry, the run history, the
 * capability probe, the v2 job runner and the credit balance. index.ts builds
 * them on the user's config folder; the selftest on a temporary one, so a test
 * run never writes into the user's history.
 */

import type { Settings } from './config.ts';
import { CapabilityProbe } from './capabilities.ts';
import { Credits } from './credits.ts';
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

/** `cloudBase` stands in for https://cloud.comfy.org in the selftest, so it never leaves loopback. */
export function makeServices(dir: string, settings: () => Pick<Settings, 'comfyUrl' | 'comfyToken' | 'comfyGpu'>, library: WorkflowLibrary, cloudBase?: string): Services {
  const resources = new ResourceRegistry(dir, settings().comfyUrl);
  const runs = new RunLog(dir);
  const caps = new CapabilityProbe(resources, library, runs, () => ({ token: settings().comfyToken, gpu: settings().comfyGpu }), cloudBase);
  const v2 = new V2Jobs(resources, runs);
  const credits = new Credits(resources, cloudBase);
  // Comfy Cloud and deployments draw on the same credits: read the balance again after every job there.
  v2.onFinished((r) => { if (resources.creditsPerHour(r) !== null) credits.refreshAfterJob(); });
  return { resources, runs, caps, v2, credits };
}
