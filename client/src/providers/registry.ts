import type { ProviderId, VideoProvider } from './types';
import { ComfyCloudProvider } from './ComfyCloudProvider';
import { LocalComfyProvider } from './LocalComfyProvider';
import { ComfyV2Provider } from './ComfyV2Provider';

export interface ProviderConfig {
  comfyCloud: { apiKey: string };
  localComfy: { url: string };
  comfyV2: { url: string; token: string };
}

export function buildProvider(id: ProviderId, cfg: ProviderConfig): VideoProvider {
  switch (id) {
    case 'comfy-cloud':
      return new ComfyCloudProvider(cfg.comfyCloud.apiKey);
    case 'local-comfy':
      return new LocalComfyProvider(cfg.localComfy.url);
    case 'comfy-v2':
      if (!cfg.comfyV2.url) {
        throw new Error('Comfy API v2 has no Base URL yet — add it under Settings → Provider.');
      }
      return new ComfyV2Provider({
        id: 'comfy-v2', label: 'Comfy API v2', baseUrl: cfg.comfyV2.url, token: cfg.comfyV2.token,
      });
  }
}

export const PROVIDERS: { id: ProviderId; label: string; hint: string }[] = [
  { id: 'local-comfy', label: 'Local ComfyUI', hint: 'A ComfyUI running on this machine or your LAN' },
  { id: 'comfy-cloud', label: 'ComfyCloud', hint: 'The hosted service at cloud.comfy.org — an API key from platform.comfy.org' },
  {
    id: 'comfy-v2',
    label: 'Comfy API v2 (Developer Platform)',
    hint: 'Comfy Cloud, a serverless deployment, or comfy-api-proxy in front of your own ComfyUI',
  },
];

/** True when the provider speaks the plain ComfyUI protocol (editor, userdata, object_info). */
export function isComfyProtocol(id: ProviderId): boolean {
  return id === 'local-comfy';
}
