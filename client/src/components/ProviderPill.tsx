import { useEffect, useState } from 'react';
import { useApp } from '../state/store';
import { buildProvider, PROVIDERS } from '../providers/registry';

interface ProbeState {
  status: 'unknown' | 'online' | 'offline';
  message: string;
}

/**
 * Header pill: which backend is live, with a dot you can read at a glance.
 * The reason it's down is worth more than the fact, so the message shows in
 * the tooltip and again in a banner for anyone who doesn't hover.
 */
export function ProviderPill(): JSX.Element {
  const probe = useProviderProbe();
  const openSettings = useApp((s) => s.setSettingsOpen);
  const provider = useApp((s) => s.settings.provider);

  const dot =
    probe.status === 'online' ? 'bg-ok'
    : probe.status === 'offline' ? 'bg-err'
    : 'bg-ink-mute animate-pulse';

  const label = providerLabel(provider);
  const suffix = '';

  return (
    <button
      type="button"
      onClick={() => openSettings(true)}
      className="pill transition-colors hover:bg-bg-hover"
      title={probe.status === 'unknown' ? `Checking ${label}…` : probe.message || `Provider: ${label}`}
    >
      <span className={`h-2 w-2 rounded-full ${dot}`} />
      <span className="text-ink">{label}{suffix}</span>
    </button>
  );
}

/** Shown under the header when the backend can't be reached. */
export function ProviderBanner(): JSX.Element | null {
  const probe = useProviderProbe();
  const provider = useApp((s) => s.settings.provider);
  const openSettings = useApp((s) => s.setSettingsOpen);

  if (probe.status !== 'offline') return null;

  return (
    <div className="flex items-start gap-2 border-b border-err/40 bg-err/10 px-3 py-2 text-xs">
      <span className="mt-0.5 text-err">●</span>
      <div className="min-w-0 flex-1">
        <p className="text-ink">
          <strong>{providerLabel(provider)} unreachable</strong>
          {probe.message && <> — <span className="font-mono text-ink-dim">{probe.message}</span></>}
        </p>
        {provider === 'local-comfy' && (
          <p className="mt-0.5 text-ink-mute">
            Start ComfyUI and check that <span className="font-mono text-ink">http://127.0.0.1:8188</span>{' '}
            opens in a browser, then come back.
          </p>
        )}
      </div>
      <button className="btn-quiet h-6 px-2 text-xs" onClick={() => openSettings(true)}>Settings</button>
    </div>
  );
}

function providerLabel(id: string): string {
  return PROVIDERS.find((p) => p.id === id)?.label ?? id;
}

/*
 * ONE probe, shared.
 *
 * The comment above this used to say "shared by the pill and the banner" while
 * the hook was called once in each — two independent states, two 30 s timers,
 * two requests, and no reason for them to agree. The pill could sit green while
 * the banner shouted that the server was unreachable, and each could flip on its
 * own schedule. So the state lives outside React and both components subscribe
 * to it: there is exactly one answer on screen at a time because there is
 * exactly one answer.
 */
let shared: ProbeState = { status: 'unknown', message: '' };
const listeners = new Set<() => void>();
let subscribers = 0;
let stopProbe: (() => void) | null = null;

function publish(next: ProbeState): void {
  if (next.status === shared.status && next.message === shared.message) return;
  shared = next;
  for (const l of listeners) l();
}

function useProviderProbe(): ProbeState {
  const provider = useApp((s) => s.settings.provider);
  const apiKey = useApp((s) => s.settings.comfyCloudApiKey);
  const localUrl = useApp((s) => s.settings.localComfyUrl);
  const v2Url = useApp((s) => s.settings.comfyV2Url);
  const v2Token = useApp((s) => s.settings.comfyV2Token);
  const [, force] = useState(0);

  // Re-render this component whenever the shared verdict changes.
  useEffect(() => {
    const notify = (): void => force((n) => n + 1);
    listeners.add(notify);
    return () => { listeners.delete(notify); };
  }, []);

  useEffect(() => {
    subscribers++;

    // Only the first subscriber drives the loop; the rest just watch. Both the
    // pill and the banner mount with identical config, so without this they
    // would each start one.
    if (subscribers === 1) {
      let cancelled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const probe = async (): Promise<void> => {
        const missing =
          provider === 'comfy-cloud' && !apiKey ? 'No API key set'
          : provider === 'comfy-v2' && !v2Url ? 'No base URL set'
          : null;

        if (missing) {
          if (!cancelled) publish({ status: 'offline', message: missing });
        } else {
          try {
            const p = buildProvider(provider, {
              comfyCloud: { apiKey },
              localComfy: { url: localUrl },
              comfyV2: { url: v2Url, token: v2Token },
            });
            const h = await p.health();
            if (!cancelled) publish({ status: h.online ? 'online' : 'offline', message: h.message ?? '' });
          } catch (e) {
            if (!cancelled) {
              publish({ status: 'offline', message: e instanceof Error ? e.message : 'Unavailable' });
            }
          }
        }
        // Re-probe often enough to notice a server come up, not so often that it is noise.
        if (!cancelled) timer = setTimeout(probe, 30_000);
      };

      // Wait for typing to settle. Without this, every keystroke in the token
      // field fires a probe, and the "rejected" answer to a half-typed token
      // lands after the good one — leaving a wrong error on screen.
      //
      // The verdict is NOT cleared here any more. It used to be, so that a
      // stale "rejected" would not outlive a fixed token — but the same line
      // also blanked a perfectly good "online" every time this effect re-ran,
      // which is what made the banner flash away and come back. A verdict is
      // only replaced by another verdict now; `status: 'unknown'` survives just
      // as the initial value, before anything has been measured.
      timer = setTimeout(() => void probe(), 700);

      stopProbe = () => { cancelled = true; if (timer) clearTimeout(timer); };
    }

    return () => {
      subscribers--;
      if (subscribers === 0 && stopProbe) { stopProbe(); stopProbe = null; }
    };
  }, [provider, apiKey, localUrl, v2Url, v2Token]);

  return shared;
}
