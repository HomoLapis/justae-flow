/**
 * This panel's identity on the ComfyUI server.
 *
 * Flow 1 minted a fresh uuid for every job, which was fine when the client id
 * only had to route WebSocket messages for the job that had just been queued.
 * Capturing runs needs more than that: `/history` records who submitted each
 * prompt, and the panel has to be able to tell "a run I made" from "a run the
 * user made in the browser editor" — which is exactly the kind it wants to
 * offer to capture. A per-job uuid makes every past run look like a stranger's.
 *
 * So the id is minted once and kept. ComfyUI's own frontend does the same
 * (one id per browser session), and nothing about the protocol expects it to
 * change between prompts.
 */

import { uuid } from './filenames';
import { lsGet, lsSet } from '../state/persistence';

let cached: string | null = null;

export function panelClientId(): string {
  if (cached) return cached;
  const stored = lsGet<string>('clientId', '');
  if (stored) {
    cached = stored;
    return stored;
  }
  const fresh = uuid();
  lsSet('clientId', fresh);
  cached = fresh;
  return fresh;
}
