import { useEffect, useState } from 'react';
import { api, mediaUrl } from '../api.ts';
import { act, useUi } from '../store.ts';
import { Dot, Icon, Kbd } from './ui.tsx';

const STEPS = ['Host', 'Connect', 'ComfyUI', 'Test', 'Ready'];

export function Wizard() {
  const s = useUi((u) => u.server)!;
  const set = useUi((u) => u.set);
  const [step, setStep] = useState(0);
  const finish = async (): Promise<void> => {
    await act(api.settings({ setupDone: true }));
    set({ wizardOpen: false });
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/80 backdrop-blur-sm">
      <div className="w-[600px] overflow-hidden rounded-xl border border-ink-700 bg-ink-900 shadow-2xl">
        <div className="flex items-center gap-2 border-b border-ink-800 px-5 py-3">
          <span className="font-semibold">Set up Shiftfield</span>
          <div className="ml-auto flex items-center gap-1.5">
            {STEPS.map((t, i) => (
              <span key={t} className={`rounded-full px-2 py-0.5 text-[10.5px] ${i === step ? 'bg-accent text-ink-950' : i < step ? 'bg-ink-700 text-ink-200' : 'text-ink-500'}`}>{i + 1}. {t}</span>
            ))}
          </div>
        </div>
        <div className="min-h-[300px] p-5">
          {step === 0 && <StepHost />}
          {step === 1 && (s.settings.host === 'photocraft' ? <StepPhotoCraft /> : <StepEffectCraft port={s.settings.effectcraftPort} />)}
          {step === 2 && <StepComfy url={s.settings.comfyUrl} />}
          {step === 3 && <StepTest />}
          {step === 4 && <StepReady />}
        </div>
        <div className="flex items-center gap-2 border-t border-ink-800 px-5 py-3">
          {step > 0 && <button className="btn-ghost" onClick={() => setStep(step - 1)}>Back</button>}
          <button className="btn-ghost ml-auto" onClick={finish}>Skip setup</button>
          {step < STEPS.length - 1
            ? <button className="btn-primary" onClick={() => setStep(step + 1)}>Next <Icon name="chevron" className="h-3 w-3" /></button>
            : <button className="btn-primary" onClick={finish}>Open the storyboard</button>}
        </div>
      </div>
    </div>
  );
}

function StepHost() {
  const host = useUi((u) => u.server!.settings.host);
  const pick = (h: 'effectcraft' | 'photocraft'): void => { if (h !== host) void act(api.settings({ host: h })); };
  const card = (h: 'effectcraft' | 'photocraft', icon: string, title: string, text: string) => (
    <button onClick={() => pick(h)} className={`rounded-lg border p-3 text-left transition ${host === h ? 'border-accent/60 bg-accent-soft' : 'border-ink-700 hover:border-ink-500'}`}>
      <div className="mb-1 flex items-center gap-2 font-semibold"><Icon name={icon} />{title}{host === h && <Icon name="check" className="ml-auto h-3.5 w-3.5 text-accent" />}</div>
      <p className="text-[12px] text-ink-300">{text}</p>
    </button>
  );
  return (
    <div className="space-y-4">
      <h2 className="text-[17px] font-semibold">The AI tools, inside your open-source apps</h2>
      <p className="leading-relaxed text-ink-300">
        Shiftfield turns the markers, placeholders, selections and layers of your project into a storyboard, generates every card on
        <b className="text-ink-100"> your own ComfyUI</b>, and puts each result back in its place — as a new version, never over the old one.
      </p>
      <div className="grid grid-cols-2 gap-3">
        {card('effectcraft', 'film', 'EffectCraft', 'Motion graphics & VFX. Markers, placeholders, footage layers.')}
        {card('photocraft', 'image', 'PhotoCraft', 'Image editing. Selections, placeholder layers, layers.')}
      </div>
      <p className="text-[11.5px] text-ink-500">Nothing leaves your computer unless your ComfyUI does. No account, no telemetry. You can switch app later in Settings.</p>
    </div>
  );
}

function StepPhotoCraft() {
  const st = useUi((u) => u.server!.settings);
  const [port, setPort] = useState(String(st.photocraftPort));
  const [root, setRoot] = useState(st.photocraftRoot);
  const [r, setR] = useState<Awaited<ReturnType<typeof api.testHost>> | null>(null);
  useEffect(() => {
    let stop = false;
    const tick = async (): Promise<void> => {
      const res = await api.testHost({ host: 'photocraft', photocraftPort: Number(port), photocraftRoot: root }).catch(() => null);
      if (!stop) { setR(res); if (!res?.ok) setTimeout(tick, 2000); }
    };
    void tick();
    return () => { stop = true; };
  }, [port, root]);
  const q = (p: string): string => (/\s/.test(p) ? `"${p}"` : p);
  const line = `photocraft --control ${port} --control-token-file ${q(st.photocraftTokenFile)} --automation-read-root ${q(root)} --automation-write-root ${q(root)}`;
  return (
    <div className="space-y-3.5">
      <h2 className="text-[17px] font-semibold">Connect PhotoCraft</h2>
      <p className="text-ink-300">Start PhotoCraft with its control channel. It listens on this computer only, asks for the token in the file below, and may read and write only inside its automation folder — where Shiftfield keeps the storyboard and the generated images:</p>
      <CopyLine text={line} />
      <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1.5">
        <span className="text-ink-400">Port</span>
        <input className="field !w-24 font-mono" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} />
        <span className="text-ink-400">Folder</span>
        <input className="field font-mono" value={root} onChange={(e) => setRoot(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      </div>
      <button className="btn-outline" onClick={() => act(api.settings({ photocraftPort: Number(port), photocraftRoot: root }), 'Saved')}>Use these</button>
      <div className="flex items-center gap-2 rounded-md border border-ink-700 bg-ink-850 px-3 py-2.5">
        <Dot ok={!!r?.ok} />
        {r?.ok ? <span>Connected to <b>PhotoCraft</b> · {r.comp ? <>document “{r.comp}”, {r.layers} layer{r.layers === 1 ? '' : 's'}</> : 'no document open yet'}</span>
          : <span className="text-ink-300">Waiting for PhotoCraft on port {port}… <span className="text-ink-500">{r?.error ? r.error.slice(0, 140) : '(checks every 2 s)'}</span></span>}
      </div>
    </div>
  );
}

function StepEffectCraft({ port }: { port: number }) {
  const [p, setP] = useState(String(port));
  const [r, setR] = useState<Awaited<ReturnType<typeof api.testHost>> | null>(null);
  useEffect(() => {
    let stop = false;
    const tick = async (): Promise<void> => {
      const res = await api.testHost({ host: 'effectcraft', effectcraftPort: Number(p) }).catch(() => null);
      if (!stop) { setR(res); if (!res?.ok) setTimeout(tick, 2000); }
    };
    void tick();
    return () => { stop = true; };
  }, [p]);
  return (
    <div className="space-y-4">
      <h2 className="text-[17px] font-semibold">Connect EffectCraft</h2>
      <p className="text-ink-300">Start EffectCraft with its control channel. It listens on this computer only, and only while you ask for it:</p>
      <CopyLine text={`"C:\\Program Files\\EffectCraft\\effectcraft.exe" --control ${p}`} />
      <p className="text-[11.5px] text-ink-500">macOS / Linux: <code className="font-mono">effectcraft --control {p}</code> · or set <code className="font-mono">EFFECTCRAFT_CONTROL_PORT={p}</code></p>
      <div className="flex items-center gap-2">
        <span className="text-ink-400">Port</span>
        <input className="field !w-24 font-mono" value={p} onChange={(e) => setP(e.target.value.replace(/\D/g, ''))} />
        <button className="btn-outline" onClick={() => act(api.settings({ effectcraftPort: Number(p) }), 'Saved')}>Use this port</button>
      </div>
      <div className="flex items-center gap-2 rounded-md border border-ink-700 bg-ink-850 px-3 py-2.5">
        <Dot ok={!!r?.ok} />
        {r?.ok ? <span>Connected to <b>EffectCraft {r.version}</b> · {r.comp ? <>comp “{r.comp}”, {r.markers} marker{r.markers === 1 ? '' : 's'}</> : 'no composition open yet'}</span>
          : <span className="text-ink-300">Waiting for EffectCraft on port {p}… <span className="text-ink-500">(checks every 2 s)</span></span>}
      </div>
    </div>
  );
}

function StepComfy({ url }: { url: string }) {
  const [u, setU] = useState(url);
  const [r, setR] = useState<Awaited<ReturnType<typeof api.testComfy>> | null>(null);
  const [busy, setBusy] = useState(false);
  const test = async (): Promise<void> => {
    setBusy(true);
    setR(await api.testComfy(u).catch((e) => ({ online: false, message: String(e) })));
    setBusy(false);
  };
  useEffect(() => { void test(); }, []);
  return (
    <div className="space-y-4">
      <h2 className="text-[17px] font-semibold">Connect ComfyUI</h2>
      <p className="text-ink-300">Your own ComfyUI — on this machine, on your network, or behind <code className="font-mono">comfy-api-proxy</code>. The bundled workflows are official ComfyUI templates with open weights.</p>
      <div className="flex gap-2">
        <input className="field font-mono" value={u} onChange={(e) => setU(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        <button className="btn-outline" disabled={busy} onClick={test}>{busy ? 'Testing…' : 'Test'}</button>
        <button className="btn-primary" disabled={!r?.online} onClick={() => act(api.settings({ comfyUrl: u }), 'ComfyUI saved')}>Use</button>
      </div>
      <div className="flex items-center gap-2 rounded-md border border-ink-700 bg-ink-850 px-3 py-2.5">
        <Dot ok={!!r?.online} />
        {r?.online ? <span>ComfyUI <b>{r.version}</b> · {r.device}</span> : <span className="text-ink-300">{r?.message ?? 'Not tested yet.'}</span>}
      </div>
    </div>
  );
}

function StepTest() {
  const [state, setState] = useState<'idle' | 'busy' | 'ok' | 'error'>('idle');
  const [res, setRes] = useState<{ file: string; seconds: number } | null>(null);
  const [err, setErr] = useState('');
  const run = async (): Promise<void> => {
    setState('busy');
    try { setRes(await api.testGenerate()); setState('ok'); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setState('error'); }
  };
  return (
    <div className="space-y-4">
      <h2 className="text-[17px] font-semibold">A test image</h2>
      <p className="text-ink-300">One small still with Z-Image-Turbo, to prove the whole chain. It is not placed in your project.</p>
      <button className="btn-primary" disabled={state === 'busy'} onClick={run}><Icon name="play" className="h-3 w-3" />{state === 'busy' ? 'Generating…' : 'Generate a test image'}</button>
      {state === 'ok' && res && (
        <div className="flex items-center gap-3">
          <img src={mediaUrl(res.file)} className="h-28 rounded border border-ink-700" alt="test" />
          <span className="text-st-done">✔ Done in {res.seconds.toFixed(1)}s — the chain works.</span>
        </div>
      )}
      {state === 'error' && <p className="whitespace-pre-wrap break-words rounded-md border border-st-error/40 bg-[#e04fd112] p-2.5 text-[12px]">{err}</p>}
    </div>
  );
}

function StepReady() {
  const canvas = useUi((u) => u.server!.settings.host === 'photocraft');
  if (canvas) {
    return (
      <div className="space-y-4">
        <h2 className="text-[17px] font-semibold">How it works</h2>
        <ol className="space-y-2.5 text-ink-200">
          <li><b>1.</b> In PhotoCraft, select an area and press <b>Card from selection</b> (<Kbd>S</Kbd>) — or add a <b>placeholder</b> (<Kbd>M</Kbd>) and move and resize it.</li>
          <li><b>2.</b> Describe the change, or the image. Select layers and press <b>Use selected layers</b> to cut out or upscale them.</li>
          <li><b>3.</b> <Kbd>Ctrl G</Kbd> generates them all. Placeholders turn <span className="text-st-queued">yellow</span>, <span className="text-st-running">seafoam</span>, results <span className="text-st-done">green</span> in the Layers panel.</li>
          <li><b>4.</b> Each result is a new layer above, masked to the selection or the box. Every version stays in the document, hidden; switch any time.</li>
        </ol>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <h2 className="text-[17px] font-semibold">How it works</h2>
      <ol className="space-y-2.5 text-ink-200">
        <li><b>1.</b> In EffectCraft, add a <b>marker</b> and type the shot as its comment — or add a <b>placeholder</b> (<Kbd>M</Kbd>) and move and scale it.</li>
        <li><b>2.</b> Every marker and placeholder is a card here, in time order. Pick a workflow; select several to change them together.</li>
        <li><b>3.</b> <Kbd>Ctrl G</Kbd> generates them all. Markers turn <span className="text-st-queued">yellow</span>, <span className="text-st-running">cyan</span>, then <span className="text-st-done">green</span> on the timeline.</li>
        <li><b>4.</b> Each result lands at its time. Generate again for a new version; switch versions any time — nothing is overwritten.</li>
      </ol>
    </div>
  );
}

function CopyLine({ text }: { text: string }) {
  const toast = useUi((u) => u.toast);
  return (
    <div className="flex items-center gap-2 rounded-md border border-ink-700 bg-ink-950 px-3 py-2">
      <code className="flex-1 truncate font-mono text-[11.5px] text-ink-100">{text}</code>
      <button className="btn-ghost !py-0.5" onClick={() => { void navigator.clipboard.writeText(text); toast('Copied', 'ok'); }}>Copy</button>
    </div>
  );
}
