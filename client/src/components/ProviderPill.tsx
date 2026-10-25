import { useApp } from '../state/store';
import { clock, creditsTooltip, formatCredits, useResources } from '../lib/resources';
import { useActiveRoute } from '../lib/useRoute';

/**
 * Header pill: the resource the next Generate goes to, with a dot you can
 * read at a glance — and, when that resource bills (Comfy Cloud, a
 * deployment), the account's balance with the time it was read. The balance
 * comes from the billing report, which follows invoices: the tooltip says so
 * and never drops the time.
 */
export function ProviderPill(): JSX.Element {
  const openSettings = useApp((s) => s.setSettingsOpen);
  const route = useActiveRoute();
  const data = useResources((s) => s.data);
  const credits = useResources((s) => s.credits);
  const caps = route ? data?.capabilities[route.resource] : null;
  const online = caps ? caps.online : null;

  const dot = online === true ? 'bg-ok' : online === false ? 'bg-err' : 'bg-ink-mute animate-pulse';
  const label = route?.label ?? 'Resources';
  const showCredits = !!route?.metered;
  const tip = [
    route ? `Next Generate: ${route.why}` : 'Reading the resources…',
    caps?.message,
    showCredits && credits ? creditsTooltip(credits) : null,
  ].filter(Boolean).join('\n');

  return (
    <button
      type="button"
      onClick={() => openSettings(true)}
      className="pill max-w-[260px] transition-colors hover:bg-bg-hover"
      title={tip}
      data-testid="resource-pill"
    >
      <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
      <span className="truncate text-ink">{label}</span>
      {showCredits && (
        <span className="shrink-0 font-mono text-[10px] text-ink-dim">
          {credits?.ok && credits.credits !== null
            ? <>☁ {formatCredits(credits.credits)} cr <span className="text-ink-mute">· {clock(credits.asOf)}</span></>
            : '☁ — cr'}
        </span>
      )}
    </button>
  );
}

/** Shown under the header when the resource the next Generate uses can't be reached. */
export function ProviderBanner(): JSX.Element | null {
  const route = useActiveRoute();
  const data = useResources((s) => s.data);
  const openSettings = useApp((s) => s.setSettingsOpen);
  const caps = route ? data?.capabilities[route.resource] : null;
  if (!route || !caps || caps.online) return null;

  return (
    <div className="flex items-start gap-2 border-b border-err/40 bg-err/10 px-3 py-2 text-xs">
      <span className="mt-0.5 text-err">●</span>
      <div className="min-w-0 flex-1">
        <p className="text-ink">
          <strong>{route.label} unreachable</strong>
          {caps.message && <> — <span className="font-mono text-ink-dim">{caps.message}</span></>}
        </p>
        {route.kind === 'local' && (
          <p className="mt-0.5 text-ink-mute">
            Start ComfyUI and check that its address in Settings ▸ Resources opens in a browser, then come back.
          </p>
        )}
        {route.kind === 'deployment' && (
          <p className="mt-0.5 text-ink-mute">
            <span className="font-mono text-ink">comfy deploy status</span> shows whether the deployment is running.
          </p>
        )}
        {route.kind === 'proxy' && (
          <p className="mt-0.5 text-ink-mute">
            Check that <span className="font-mono text-ink">comfy-api-proxy</span> is running next to your ComfyUI.
          </p>
        )}
      </div>
      <button className="btn-quiet h-6 px-2 text-xs" onClick={() => openSettings(true)}>Settings</button>
    </div>
  );
}
