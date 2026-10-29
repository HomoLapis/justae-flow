import { useEffect, useRef, useState } from 'react';
import { serverJson } from '../bridge/server';

interface PanelHost { ok: boolean; app: string; kind: string; error: string | null }
interface Diagnosis { port: number; listening: boolean; running: boolean; exe: string | null; userPort: string | null }

/**
 * Under the tabs, on every tab: the host app cannot be reached, why, and what
 * to do about it. Without it the Workflow tab looks fine (ComfyUI answers)
 * while nothing can reach the timeline — the most common first-run failure,
 * an EffectCraft opened from its own icon, without its control channel.
 */
export function HostBanner(): JSX.Element | null {
  const [host, setHost] = useState<PanelHost | null>(null);
  const [diag, setDiag] = useState<Diagnosis | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const misses = useRef(0);

  useEffect(() => {
    let alive = true;
    const tick = async (): Promise<void> => {
      try {
        const p = await fetch('/api/panel').then((r) => r.json()) as { host: PanelHost };
        if (!alive) return;
        // The first reads after the server starts say "Connecting…": wait for two misses before saying anything.
        misses.current = p.host.ok ? 0 : misses.current + 1;
        setHost(p.host);
        if (p.host.ok) { setDiag(null); setNote(null); return; }
        if (p.host.app === 'EffectCraft') {
          const d = await fetch('/api/effectcraft/diagnose').then((r) => r.json()) as Diagnosis;
          if (alive) setDiag(d);
        }
      } catch { /* the server itself is down: the page cannot say so from here */ }
    };
    void tick();
    const t = setInterval(() => void tick(), 4000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (!host || host.ok || misses.current < 2) return null;

  const start = async (): Promise<void> => {
    setNote('Starting EffectCraft…');
    try {
      const r = await serverJson<{ ok: boolean; how?: string; error?: string }>('/api/effectcraft/start', {});
      if (!r.ok) setNote(r.error ?? 'EffectCraft did not start.');
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  };

  let title: string;
  let what: JSX.Element | string;
  let button: JSX.Element | null = null;
  if (host.app === 'EffectCraft' && diag && diag.running) {
    title = 'EffectCraft is open without its control channel';
    what = 'Save your work, close EffectCraft and start it again. The launcher starts it with the channel; on Windows, after the launcher has run once, the Start menu does too.';
  } else if (host.app === 'EffectCraft' && diag && !diag.exe) {
    title = 'EffectCraft not found';
    what = <>Install it from <span className="font-mono text-ink">github.com/storytold/effectcraft</span>, or set <span className="font-mono text-ink">EFFECTCRAFT_EXE</span> to its effectcraft.exe and run the launcher again.</>;
  } else if (host.app === 'EffectCraft' && diag) {
    title = 'EffectCraft is not open';
    what = `Start it here with its control channel (port ${diag.port}), or with the launcher.`;
    button = <button className="btn-quiet h-6 px-2 text-xs" onClick={() => void start()} disabled={note === 'Starting EffectCraft…'}>Start EffectCraft</button>;
  } else {
    title = `${host.app} is not answering`;
    what = <span className="font-mono text-ink-dim">{host.error}</span>;
  }

  return (
    <div className="flex items-start gap-2 border-b border-warn/40 bg-warn/10 px-3 py-2 text-xs" data-testid="host-banner">
      <span className="mt-0.5 text-warn">●</span>
      <div className="min-w-0 flex-1">
        <p className="text-ink"><strong>{title}</strong></p>
        <p className="mt-0.5 text-ink-mute">{what}</p>
        {note && <p className="mt-0.5 text-ink">{note}</p>}
      </div>
      {button}
    </div>
  );
}
