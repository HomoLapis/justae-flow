import { api } from '../api.ts';
import { act, useUi } from '../store.ts';
import { Icon } from './ui.tsx';

function Banner({ tone, children, actions }: { tone: 'warn' | 'info' | 'error'; children: React.ReactNode; actions?: React.ReactNode }) {
  const color = tone === 'error' ? 'border-st-error/40 bg-[#e04fd112]' : tone === 'warn' ? 'border-st-queued/40 bg-[#e6c84f10]' : 'border-accent/30 bg-accent-soft';
  return (
    <div className={`flex items-center gap-3 border-b px-3 py-2 ${color}`}>
      <Icon name={tone === 'info' ? 'check' : 'alert'} className="h-4 w-4 shrink-0 text-ink-200" />
      <div className="min-w-0 flex-1 text-ink-100">{children}</div>
      {actions && <div className="flex shrink-0 gap-1">{actions}</div>}
    </div>
  );
}

export function Banners() {
  const s = useUi((u) => u.server)!;
  const set = useUi((u) => u.set);
  return (
    <>
      {!s.host.ok && (
        <Banner tone="error" actions={<button className="btn-outline" onClick={() => set({ wizardOpen: true })}>Connection guide</button>}>
          <b>{s.host.app} is not connected.</b>{' '}
          {s.host.kind === 'canvas'
            ? <>Start it with its control channel, a token file and its automation folder (the connection guide has the full line). <span className="text-ink-400">{s.host.error}</span></>
            : <>Start it with its control channel on:{' '}
              <code className="rounded bg-ink-950 px-1.5 py-0.5 font-mono text-[11px]">effectcraft --control {s.settings.effectcraftPort}</code>
              <span className="text-ink-400"> — it listens on this computer only and is off unless you ask for it.</span></>}
        </Banner>
      )}
      {s.host.ok && !s.host.comp && (
        <Banner tone="warn">{s.host.kind === 'canvas'
          ? 'Open or create a document in PhotoCraft: its placeholders, selections and layers become the storyboard.'
          : 'Open a composition in EffectCraft: its markers and placeholders become the storyboard.'}</Banner>
      )}
      {!s.comfy.online && (
        <Banner tone="error" actions={<button className="btn-outline" onClick={() => set({ settingsOpen: true })}>Settings</button>}>
          <b>ComfyUI is not reachable</b> at <code className="font-mono text-[11px]">{s.comfy.url}</code>. Start it, or point Shiftfield at another server.
        </Banner>
      )}
      {s.queue.recovered > 0 && (
        <Banner tone="warn" actions={<><button className="btn-primary" onClick={() => act(api.resume())}>Resume</button><button className="btn-ghost" onClick={() => act(api.discard())}>Discard</button></>}>
          {s.queue.recovered} card{s.queue.recovered > 1 ? 's were' : ' was'} queued when Shiftfield last stopped.
        </Banner>
      )}
      {s.host.ok && s.host.kind === 'timeline' && s.host.unsaved && s.cards.length > 0 && (
        <Banner tone="info">
          This EffectCraft project is not saved yet: the storyboard is kept in <code className="font-mono text-[11px]">Documents/Shiftfield</code> and moves next to the project as soon as you save it.
        </Banner>
      )}
      {s.notice && (
        <Banner tone="info" actions={<button className="btn-ghost" onClick={() => act(api.dismissNotice())}><Icon name="x" /></button>}>{s.notice}</Banner>
      )}
    </>
  );
}
