import { api } from '../api.ts';
import { act, useUi } from '../store.ts';
import { Dot, Icon, Kbd } from './ui.tsx';

export function Header() {
  const s = useUi((u) => u.server)!;
  const selected = useUi((u) => u.selected);
  const set = useUi((u) => u.set);
  const running = s.cards.find((c) => c.id === s.queue.running);
  const pending = s.queue.pending.length;
  const total = pending + (running ? 1 : 0);
  const projectName = s.host.project ? s.host.project.split(/[\\/]/).pop() : 'Unsaved project';
  const runPct = running?.progress && running.progress.max > 0 ? running.progress.value / running.progress.max : 0;

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-ink-800 bg-ink-900 px-3">
      <div className="flex items-center gap-2 pr-2">
        <svg viewBox="0 0 32 32" className="h-6 w-6"><rect width="32" height="32" rx="7" fill="#1c2025" /><path d="M8 22 L16 8 L24 22" stroke="#7c9cff" strokeWidth="3" fill="none" strokeLinejoin="round" /><circle cx="16" cy="20" r="2.5" fill="#5fd37a" /></svg>
        <span className="text-[14px] font-semibold tracking-tight">Shiftfield</span>
      </div>

      <div className="flex min-w-0 items-center gap-1.5 text-ink-300">
        <span className="truncate font-medium text-ink-100" title={s.host.project ?? undefined}>{projectName}</span>
        {s.host.comp && <><Icon name="chevron" className="h-3 w-3 text-ink-500" /><span className="truncate">{s.host.comp.name}</span>
          <span className="text-ink-500">· {s.host.comp.width}×{s.host.comp.height} · {+s.host.comp.fps.toFixed(3)} fps</span></>}
      </div>

      <div className="ml-auto flex items-center gap-2">
        {total > 0 && (
          <div className="flex items-center gap-2 rounded-md border border-ink-700 bg-ink-850 px-2 py-1">
            <span className="text-ink-300">{s.queue.paused ? 'Queue paused' : running ? `Generating ${s.cards.findIndex((c) => c.id === running.id) + 1}` : 'Queued'}</span>
            <div className="h-1.5 w-24 overflow-hidden rounded-full bg-ink-700">
              <div className="h-full bg-st-running transition-all" style={{ width: `${Math.round(runPct * 100)}%` }} />
            </div>
            <span className="font-mono text-[11px] text-ink-300">{pending} waiting</span>
            <button className="btn-ghost !px-1.5 !py-0.5" title="Stop the whole queue (Esc stops the running card)" onClick={() => act(api.cancel())}><Icon name="stop" className="h-3 w-3" /></button>
          </div>
        )}
        <button
          className="btn-primary"
          disabled={selected.length < 2 && s.queue.ready === 0}
          title={selected.length > 1 ? 'Generate the selected cards — a new version for those already done (Ctrl+G)'
            : 'Generate every card that has a prompt and no result yet (Ctrl+G). To redo finished cards, select them.'}
          onClick={() => act(api.generate(selected.length > 1 ? selected : undefined))}
        >
          <Icon name="play" className="h-3 w-3" />
          {selected.length > 1 ? `Generate ${selected.length} selected` : s.queue.ready > 0 ? `Generate all · ${s.queue.ready}` : 'All generated'}
          <Kbd>Ctrl G</Kbd>
        </button>
        <Pill ok={s.host.ok} label={s.host.ok ? `EffectCraft ${s.host.version ?? ''}` : 'EffectCraft offline'} title={s.host.error ?? 'Control channel connected'} />
        <Pill ok={s.comfy.online} label={s.comfy.online ? `ComfyUI ${s.comfy.version ?? ''}` : 'ComfyUI offline'} title={s.comfy.online ? `${s.comfy.url} · ${s.comfy.device ?? ''}${s.comfy.vramFreeGb ? ` · ${s.comfy.vramFreeGb} GB free` : ''}` : s.comfy.message} />
        <button className="btn-ghost !px-1.5" title="Keyboard shortcuts (?)" onClick={() => set({ helpOpen: true })}><Icon name="keyboard" className="h-4 w-4" /></button>
        <button className="btn-ghost !px-1.5" title="Settings (Ctrl+,)" onClick={() => set({ settingsOpen: true })}><Icon name="gear" className="h-4 w-4" /></button>
      </div>
    </header>
  );
}

function Pill({ ok, label, title }: { ok: boolean; label: string; title?: string }) {
  return (
    <span title={title} className="flex items-center gap-1.5 rounded-md border border-ink-700 px-2 py-1 text-[11.5px] text-ink-200">
      <Dot ok={ok} />{label}
    </span>
  );
}

export function Toolbar() {
  const s = useUi((u) => u.server)!;
  const selectAll = useUi((u) => u.selectAll);
  const counts = { all: s.cards.filter((c) => !c.orphan).length, done: s.cards.filter((c) => c.status === 'done').length, error: s.cards.filter((c) => c.status === 'error').length };
  const disabled = !s.host.ok || !s.host.comp;
  const errorIds = s.cards.filter((c) => c.status === 'error').map((c) => c.id);
  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b border-ink-800 bg-ink-900/60 px-3">
      <button className="btn-ghost" disabled={disabled} title="Add a marker at the playhead — its text is the prompt" onClick={() => act(api.marker(''))}><Icon name="marker" />Marker at playhead</button>
      <button className="btn-ghost" disabled={disabled} title="Add a placeholder layer at the playhead (M). Move and scale it in EffectCraft: its size and length are the shot" onClick={() => act(api.placeholder(), 'Placeholder added at the playhead')}><Icon name="box" />Placeholder<Kbd>M</Kbd></button>
      <button className="btn-ghost" disabled={disabled || s.host.selectedLayers.length === 0} title="Turn the layers selected in EffectCraft into cards (upscale, remove background…)" onClick={() => act(api.adopt())}><Icon name="layers" />Use selected layers{s.host.selectedLayers.length ? ` (${s.host.selectedLayers.length})` : ''}</button>
      <div className="mx-2 h-5 w-px bg-ink-700" />
      <span className="text-ink-400">{counts.all} cards · {counts.done} done{counts.error ? ` · ${counts.error} failed` : ''}</span>
      {errorIds.length > 0 && <button className="btn-ghost text-st-error" onClick={() => act(api.generate(errorIds))}><Icon name="refresh" />Retry failed</button>}
      <div className="ml-auto flex items-center gap-1">
        <button className="btn-ghost" onClick={selectAll} title="Select all cards (Ctrl+A)">Select all</button>
      </div>
    </div>
  );
}
