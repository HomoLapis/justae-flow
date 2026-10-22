import { useEffect, useRef } from 'react';
import { api, subscribe } from './api.ts';
import { act, useUi } from './store.ts';
import { Banners } from './components/Banners.tsx';
import { BulkBar } from './components/BulkBar.tsx';
import { CardDetail } from './components/CardDetail.tsx';
import { Header, Toolbar } from './components/Header.tsx';
import { Help, Settings, Toasts } from './components/Overlays.tsx';
import { Storyboard } from './components/Storyboard.tsx';
import { Wizard } from './components/Wizard.tsx';

export function App() {
  const server = useUi((u) => u.server);
  const serverUp = useUi((u) => u.serverUp);
  const ui = useUi();
  useEffect(() => subscribe(useUi.getState().setServer, useUi.getState().setServerUp), []);
  useShortcuts();

  if (!server) {
    return <div className="flex h-full items-center justify-center text-ink-400">{serverUp ? 'Loading…' : 'Connecting to the JustAE Flow server…'}</div>;
  }
  return (
    <div className="flex h-full flex-col">
      <Header />
      <Toolbar />
      <Banners />
      {!serverUp && <div className="bg-st-error/20 px-3 py-1.5 text-[12px]">Lost the JustAE Flow server — reconnecting…</div>}
      <div className="flex min-h-0 flex-1">
        <main className="min-w-0 flex-1 overflow-y-auto" onClick={(e) => { if (e.target === e.currentTarget) ui.clearSelection(); }}>
          <Storyboard />
        </main>
        <CardDetail />
      </div>
      <BulkBar />
      {ui.settingsOpen && <Settings />}
      {ui.wizardOpen && <Wizard />}
      {ui.helpOpen && <Help />}
      <Toasts />
    </div>
  );
}

function useShortcuts(): void {
  const previous = useRef(new Map<string, number>());
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const st = useUi.getState();
      const s = st.server;
      if (!s) return;
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return;
      if (st.wizardOpen) return;
      const card = s.cards.find((c) => c.id === st.active);
      const ctrl = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();

      if (ctrl && k === 'g') {
        e.preventDefault();
        void act(api.generate(st.selected.length > 1 ? st.selected : undefined));
      } else if (ctrl && k === 'a') {
        e.preventDefault();
        st.selectAll();
      } else if (ctrl && e.key === ',') {
        e.preventDefault();
        st.set({ settingsOpen: true });
      } else if (e.key === 'Escape') {
        if (st.helpOpen || st.settingsOpen) return st.set({ helpOpen: false, settingsOpen: false });
        const busy = card && (card.status === 'running' || card.status === 'queued') ? card : s.cards.find((c) => c.id === s.queue.running);
        if (busy) void act(api.cancel(busy.id), 'Canceled');
        else if (st.selected.length) st.clearSelection();
        else st.open(null);
      } else if (ctrl) {
        return;
      } else if (k === 'g' && card && !card.orphan) {
        void act(api.generate([card.id]));
      } else if (k === 'v' && card && !card.orphan && card.versions.length) {
        void (async () => { await act(api.update(card.id, { seed: null })); await act(api.generate([card.id])); })();
      } else if (e.key === 'Tab' && card && card.versions.length > 1) {
        e.preventDefault();
        const prev = previous.current.get(card.id) ?? card.versions.filter((v) => v.n !== card.activeVersion).at(-1)?.n;
        if (prev !== undefined && card.activeVersion !== null) {
          previous.current.set(card.id, card.activeVersion);
          void act(api.version(card.id, prev), `v${prev} in the comp`);
        }
      } else if (k === 'm' && s.host.comp) {
        void act(api.placeholder(), 'Placeholder added');
      } else if (k === 's' && s.host.kind === 'canvas' && s.host.selection) {
        void act(api.selectionCard(), 'Selection saved as a card');
      } else if (/^[1-9]$/.test(e.key)) {
        const c = s.cards[Number(e.key) - 1];
        if (c) st.select(c.id, 'only');
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const i = s.cards.findIndex((c) => c.id === st.active);
        const c = s.cards[Math.max(0, Math.min(s.cards.length - 1, i + (e.key === 'ArrowRight' ? 1 : -1)))];
        if (c) st.select(c.id, 'only');
      } else if (e.key === '?') {
        st.set({ helpOpen: true });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
