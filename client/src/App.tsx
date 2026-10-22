import { useEffect } from 'react';
import { useApp, type Tab } from './state/store';
import { ProviderPill, ProviderBanner } from './components/ProviderPill';
import { WorkflowTab } from './components/WorkflowTab';
import { ShotMode } from './modes/ShotMode';
import { SettingsDrawer } from './components/SettingsDrawer';
import { HistoryDrawer } from './components/HistoryDrawer';
import { ae } from './bridge/extendscript';
import { isInCEP } from './bridge/csInterface';

const TABS: Array<{ id: Tab; label: string; hint: string }> = [
  { id: 'workflow', label: 'Workflow', hint: 'Pick, edit and save ComfyUI workflows' },
  { id: 'marker', label: 'Marker', hint: 'Fill the gaps between pairs of comp markers' },
  { id: 'storyboard', label: 'Storyboard', hint: 'Fill the empty adjustment-layer placeholders' },
];

export function App(): JSX.Element {
  const tab = useApp((s) => s.tab);
  const setTab = useApp((s) => s.setTab);
  const openSettings = useApp((s) => s.setSettingsOpen);
  const openHistory = useApp((s) => s.setHistoryOpen);
  const historyCount = useApp((s) => s.history.length);
  const activeName = useApp((s) => s.active?.name ?? null);

  useEffect(() => {
    if (!isInCEP()) return;
    void ae.checkReady();
    // The Flow window drives EffectCraft; set to PhotoCraft, the server's storyboard page is the one that applies.
    void fetch('/api/panel').then((r) => r.json()).then((s: { host?: { app?: string } }) => {
      if (s.host?.app === 'PhotoCraft') window.location.replace('/storyboard/');
    }).catch(() => undefined);
  }, []);

  return (
    <div className="relative flex h-full flex-col bg-bg text-ink">
      <header className="flex h-12 items-center justify-between gap-2 border-b border-line bg-bg px-3.5">
        <div className="flex min-w-0 items-center gap-2">
          <img
            src="justae-logo-white.svg"
            className="jae-logo jae-logo-white"
            alt="JustAE"
            onError={(e) => { (e.currentTarget as HTMLImageElement).src = 'justae-logo-white.png'; }}
          />
          <img
            src="justae-logo.svg"
            className="jae-logo jae-logo-color"
            alt="JustAE"
            onError={(e) => { (e.currentTarget as HTMLImageElement).src = 'justae-logo.png'; }}
          />
          <span className="jae-badge jae-badge-accent">FLOW</span>
          {activeName && (
            <span className="hidden truncate text-[10px] leading-tight text-ink-mute md:inline" title={activeName}>
              {activeName}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <ProviderPill />
          <IconButton label="History" onClick={() => openHistory(true)} badge={historyCount}>
            <ClockIcon />
          </IconButton>
          <IconButton label="Settings" onClick={() => openSettings(true)}>
            <GearIcon />
          </IconButton>
        </div>
      </header>

      <nav className="flex gap-1 px-3.5 pt-3">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            title={t.hint}
            onClick={() => setTab(t.id)}
            className={'flex-1 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors '
              + (tab === t.id
                ? 'bg-brand text-white'
                : 'bg-bg-subtle text-ink-dim hover:text-ink')}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <ProviderBanner />

      <main className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'workflow' && <WorkflowTab />}
        {tab === 'marker' && <ShotMode source="marker" />}
        {tab === 'storyboard' && <ShotMode source="placeholder" />}
      </main>

      <SettingsDrawer />
      <HistoryDrawer />
    </div>
  );
}

function IconButton({
  label, onClick, children, badge,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  badge?: number;
}): JSX.Element {
  return (
    <button
      className="relative grid h-8 w-8 place-items-center rounded-lg text-ink-dim transition-colors hover:bg-bg-subtle hover:text-ink"
      onClick={onClick}
      title={label}
      aria-label={label}
    >
      {children}
      {badge !== undefined && badge > 0 && (
        <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-brand px-1 text-[9px] font-semibold text-white">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </button>
  );
}

function ClockIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function GearIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
