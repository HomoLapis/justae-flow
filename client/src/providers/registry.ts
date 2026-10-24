import type { ProviderId, V2Target, VideoProvider } from './types';
import type { Settings } from '../state/store';
import { ComfyCloudProvider } from './ComfyCloudProvider';
import { LocalComfyProvider } from './LocalComfyProvider';
import { ComfyV2Provider } from './ComfyV2Provider';

export interface ProviderConfig {
  comfyCloud: { apiKey: string };
  localComfy: { url: string };
  comfyV2: { url: string; token: string };
}

/**
 * The three places Comfy API v2 is served, from docs.comfy.org
 * (development/api-development/sdks, "Base URLs"). One protocol, so switching
 * between them is a base URL and a key.
 */
export const V2_TARGETS: Record<V2Target, { label: string; url: string; placeholder: string }> = {
  deployment: { label: 'Your deployment', url: '', placeholder: 'https://<deployment>.run.comfy.app' },
  cloud: { label: 'Comfy Cloud', url: 'https://cloud.comfy.org', placeholder: 'https://cloud.comfy.org' },
  proxy: { label: 'Your ComfyUI', url: 'http://127.0.0.1:8189', placeholder: 'http://127.0.0.1:8189' },
};

/**
 * The one place settings become provider config.
 *
 * Cloud and deployments take the same platform API key; the proxy takes its own
 * `--token`, if it was started with one. Kept apart so switching target never
 * sends one where the other was meant to go.
 */
export function providerConfig(s: Settings): ProviderConfig {
  return {
    comfyCloud: { apiKey: s.comfyCloudApiKey },
    localComfy: { url: s.localComfyUrl },
    comfyV2: {
      url: s.comfyV2Url,
      token: s.comfyV2Target === 'proxy' ? s.comfyV2ProxyToken : s.comfyV2Token,
    },
  };
}

/** Loopback: the only place a key may travel over plain http. */
function isLoopback(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === '127.0.0.1' || h === 'localhost' || h === '[::1]';
  } catch {
    return false;
  }
}

export function buildProvider(id: ProviderId, cfg: ProviderConfig): VideoProvider {
  switch (id) {
    case 'comfy-cloud':
      return new ComfyCloudProvider(cfg.comfyCloud.apiKey);
    case 'local-comfy':
      return new LocalComfyProvider(cfg.localComfy.url);
    case 'comfy-v2':
      if (!cfg.comfyV2.url) {
        throw new Error('Comfy API v2 has no endpoint URL yet — add it under Settings.');
      }
      if (cfg.comfyV2.token && cfg.comfyV2.url.startsWith('http://') && !isLoopback(cfg.comfyV2.url)) {
        throw new Error('Refusing to send the key over plain http to another machine — use https.');
      }
      return new ComfyV2Provider({
        id: 'comfy-v2', label: 'Comfy API v2', baseUrl: cfg.comfyV2.url, token: cfg.comfyV2.token,
      });
  }
}

export const PROVIDERS: { id: ProviderId; label: string; hint: string }[] = [
  { id: 'local-comfy', label: 'Local ComfyUI', hint: 'A ComfyUI running on this machine or your LAN' },
  {
    id: 'comfy-v2',
    label: 'Comfy Developer Platform',
    hint: 'Comfy API v2: your own deployment, Comfy Cloud, or your ComfyUI behind comfy-api-proxy',
  },
  {
    id: 'comfy-cloud',
    label: 'ComfyCloud (v1 API)',
    hint: 'cloud.comfy.org through the v1 Cloud API, which Comfy has deprecated in favour of v2',
  },
];

/** True when the provider speaks the plain ComfyUI protocol (editor, userdata, object_info). */
export function isComfyProtocol(id: ProviderId): boolean {
  return id === 'local-comfy';
}
