import { useState } from 'react';
import { api } from '../api.ts';
import { act, useUi } from '../store.ts';
import { Icon, Kbd } from './ui.tsx';

export function Settings() {
  const s = useUi((u) => u.server)!;
  const set = useUi((u) => u.set);
  const [comfyUrl, setComfyUrl] = useState(s.settings.comfyUrl);
  const [port, setPort] = useState(String(s.settings.effectcraftPort));
  const [secs, setSecs] = useState(String(s.settings.placeholderSeconds));
  const video = s.workflows.filter((w) => w.output === 'video' && !w.input?.startsWith('video'));
  return (
    <Drawer title="Settings" onClose={() => set({ settingsOpen: false })}>
      <Row label="ComfyUI address">
        <input className="field font-mono" value={comfyUrl} onChange={(e) => setComfyUrl(e.target.value)} onBlur={() => comfyUrl !== s.settings.comfyUrl && act(api.settings({ comfyUrl }), 'Saved')} onKeyDown={(e) => e.stopPropagation()} />
      </Row>
      <Row label="EffectCraft control port">
        <input className="field font-mono" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} onBlur={() => Number(port) !== s.settings.effectcraftPort && act(api.settings({ effectcraftPort: Number(port) }), 'Saved')} onKeyDown={(e) => e.stopPropagation()} />
      </Row>
      <Row label="New marker cards use">
        <select className="field" value={s.settings.markerWorkflow} onChange={(e) => act(api.settings({ markerWorkflow: e.target.value }))}>
          {s.workflows.map((w) => <option key={w.id} value={w.id}>{w.title}</option>)}
        </select>
      </Row>
      <Row label="New placeholders use">
        <select className="field" value={s.settings.placeholderWorkflow} onChange={(e) => act(api.settings({ placeholderWorkflow: e.target.value }))}>
          {video.map((w) => <option key={w.id} value={w.id}>{w.title}</option>)}
        </select>
      </Row>
      <Row label="Placeholder length (s)">
        <input className="field font-mono" value={secs} onChange={(e) => setSecs(e.target.value.replace(/[^\d.]/g, ''))} onBlur={() => act(api.settings({ placeholderSeconds: Number(secs) || 4 }))} onKeyDown={(e) => e.stopPropagation()} />
      </Row>
      <div className="space-y-2 border-t border-ink-800 pt-4">
        <p className="label">Storage</p>
        <p className="break-all font-mono text-[11px] text-ink-400">{s.mediaDir}</p>
        <p className="text-[11.5px] text-ink-500">Every version and its job record (workflow, seed, models, timings) lives here, next to the project. Settings live in your user folder, never in the project or the repository.</p>
      </div>
      <button className="btn-outline" onClick={() => set({ settingsOpen: false, wizardOpen: true })}>Run the setup again</button>
    </Drawer>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block space-y-1"><span className="text-[11.5px] text-ink-300">{label}</span>{children}</label>;
}

function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-ink-950/60" onClick={onClose}>
      <div className="h-full w-[380px] space-y-4 overflow-y-auto border-l border-ink-700 bg-ink-900 p-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center"><h2 className="text-[15px] font-semibold">{title}</h2><button className="btn-ghost ml-auto !px-1" onClick={onClose}><Icon name="x" /></button></div>
        {children}
      </div>
    </div>
  );
}

const SHORTCUTS: Array<[string, string]> = [
  ['G', 'Generate the open card (a new version if it has one)'],
  ['Ctrl G', 'Generate all cards — or the selected ones'],
  ['V', 'New version with a fresh random seed'],
  ['Esc', 'Cancel the running card · close panels'],
  ['Tab', 'Swap the previous and the active version in the comp'],
  ['M', 'New placeholder at the playhead'],
  ['1 – 9', 'Open card n'],
  ['← →', 'Previous / next card'],
  ['Ctrl A', 'Select all cards'],
  ['Ctrl click · Shift click', 'Add to the selection · select a range'],
  ['Ctrl Enter', 'In the prompt: save and generate'],
  ['Ctrl ,', 'Settings'],
  ['?', 'This list'],
];

export function Help() {
  const set = useUi((u) => u.set);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/70" onClick={() => set({ helpOpen: false })}>
      <div className="w-[460px] rounded-xl border border-ink-700 bg-ink-900 p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-3 text-[15px] font-semibold">Keyboard</h2>
        <table className="w-full">
          <tbody>{SHORTCUTS.map(([k, d]) => (
            <tr key={k} className="border-t border-ink-800"><td className="py-1.5 pr-3"><Kbd>{k}</Kbd></td><td className="py-1.5 text-ink-200">{d}</td></tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}

export function Toasts() {
  const toasts = useUi((u) => u.toasts);
  return (
    <div className="pointer-events-none fixed bottom-4 left-1/2 z-[60] flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((t) => (
        <div key={t.id} className={`max-w-[560px] rounded-md border px-3 py-2 text-[12px] shadow-xl ${t.tone === 'error' ? 'border-st-error/50 bg-[#2a1228]' : t.tone === 'ok' ? 'border-st-done/40 bg-[#132a1a]' : 'border-ink-600 bg-ink-800'}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
