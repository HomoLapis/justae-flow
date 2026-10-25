import type { ProviderId, VideoProvider } from './types';
import { LocalComfyProvider } from './LocalComfyProvider';
import { ServerV2Provider } from './ServerV2Provider';
import { localResource, type ResourceView } from '../lib/resources';

/**
 * Resources become providers here, and only here.
 *
 * The resources themselves — addresses, which one each task uses, the one
 * platform API key — live on the JustAE Flow server (Settings ▸ Resources,
 * server/resources.ts). This page reads them from /api/resources and never
 * holds a key:
 *
 *   local                      LocalComfyProvider — the classic protocol, relayed by the server
 *   cloud, deployment, proxy   ServerV2Provider — Comfy API v2, run by the server through the SDK
 */
export function buildProvider(r: ResourceView): VideoProvider {
  if (r.kind === 'local') return new LocalComfyProvider(r.url);
  if (!r.usable) throw new Error(`${r.label}: ${r.reason ?? 'not set up'} — see Settings ▸ Resources.`);
  return new ServerV2Provider(r);
}

/**
 * Where the Workflow tab reads workflows from: the local ComfyUI's workflow
 * folder and node catalogue. A workflow authored there runs on any resource:
 * it goes out as an API-format graph.
 */
export function libraryProvider(): VideoProvider | null {
  const local = localResource();
  return local && local.enabled ? new LocalComfyProvider(local.url) : null;
}

const LABELS: Record<ProviderId, string> = {
  'local-comfy': 'Local ComfyUI',
  'comfy-v2': 'Comfy API v2',
  'comfy-cloud': 'ComfyCloud (v1)',
};

export function providerLabel(id: ProviderId | string): string {
  return LABELS[id as ProviderId] ?? id;
}

/** True when the provider speaks the plain ComfyUI protocol (editor, userdata, object_info). */
export function isComfyProtocol(id: ProviderId): boolean {
  return id === 'local-comfy';
}
