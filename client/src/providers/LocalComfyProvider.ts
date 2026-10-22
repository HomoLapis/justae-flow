/**
 * Local ComfyUI — a ComfyUI you started yourself (default 127.0.0.1:8188).
 * No auth, everything else is the stock protocol, so it's ComfyHttpProvider
 * with the URL filled in.
 */

import { ComfyHttpProvider } from './ComfyHttpProvider';

export class LocalComfyProvider extends ComfyHttpProvider {
  constructor(baseUrl: string) {
    super({
      id: 'local-comfy',
      label: 'Local ComfyUI',
      requiresApiKey: false,
      baseUrl,
      offlineHint: `Cannot reach ${baseUrl} — is ComfyUI running? Start it with `
        + '`python main.py --listen 127.0.0.1`.',
    });
  }
}
