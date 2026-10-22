import type { ReactNode } from 'react';
import type { CardView } from '../api.ts';
import { useUi } from '../store.ts';

type Status = CardView['status'];

const STATUS_TEXT: Record<Status, string> = {
  idle: 'Draft', queued: 'Queued', running: 'Generating', done: 'Done', error: 'Error', canceled: 'Canceled',
};
/** The label each host paints for a state (EffectCraft: After Effects' names; PhotoCraft: its own). */
const HOST_LABEL: Record<'effectcraft' | 'photocraft', Partial<Record<Status, string>>> = {
  effectcraft: { queued: 'Yellow', running: 'Cyan', done: 'Green', error: 'Fuchsia' },
  photocraft: { queued: 'yellow', running: 'seafoam', done: 'green', error: 'fuchsia' },
};
export const STATUS_COLOR: Record<Status, string> = {
  idle: 'bg-st-idle', queued: 'bg-st-queued', running: 'bg-st-running', done: 'bg-st-done', error: 'bg-st-error', canceled: 'bg-st-idle',
};

export function StatusChip({ status, extra }: { status: Status; extra?: string }) {
  const host = useUi((u) => u.server?.host);
  const label = host ? HOST_LABEL[host.id][status] : undefined;
  return (
    <span
      title={label && host ? `${host.app} shows this as the ${label} label on the ${host.kind === 'timeline' ? 'marker or layer' : 'layer'}` : undefined}
      className="inline-flex items-center gap-1.5 rounded-full bg-ink-950/80 px-2 py-0.5 text-[10.5px] font-semibold text-ink-100 backdrop-blur"
    >
      <span className={`h-2 w-2 rounded-full ${STATUS_COLOR[status]} ${status === 'running' ? 'animate-pulseRing' : ''}`} />
      {STATUS_TEXT[status]}{extra ? <span className="font-normal text-ink-300">{extra}</span> : null}
    </span>
  );
}

export function Dot({ ok, warn }: { ok: boolean; warn?: boolean }) {
  return <span className={`inline-block h-2 w-2 rounded-full ${ok ? (warn ? 'bg-st-queued' : 'bg-st-done') : 'bg-st-error'}`} />;
}

export function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec.toFixed(2).padStart(5, '0')}`;
}

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

const paths: Record<string, string> = {
  play: 'M7 5v14l11-7z',
  stop: 'M6 6h12v12H6z',
  x: 'M6 6l12 12M18 6L6 18',
  marker: 'M12 3l6 6-6 12-6-12z',
  box: 'M4 6h16v12H4z M4 6l16 12 M20 6L4 18',
  layers: 'M12 3l9 5-9 5-9-5 9-5z M3 13l9 5 9-5',
  gear: 'M12 15a3 3 0 100-6 3 3 0 000 6z M19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-1.8-.3 1.6 1.6 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.6 1.6 0 00-1-1.5 1.6 1.6 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.6 1.6 0 00.3-1.8 1.6 1.6 0 00-1.5-1H3a2 2 0 110-4h.1a1.6 1.6 0 001.5-1 1.6 1.6 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.6 1.6 0 001.8.3H9a1.6 1.6 0 001-1.5V3a2 2 0 114 0v.1a1.6 1.6 0 001 1.5 1.6 1.6 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 00-.3 1.8V9a1.6 1.6 0 001.5 1H21a2 2 0 110 4h-.1a1.6 1.6 0 00-1.5 1z',
  refresh: 'M4 4v6h6 M20 20v-6h-6 M5.6 15a8 8 0 0013.1 3.3L20 14 M18.4 9A8 8 0 005.3 5.7L4 10',
  dice: 'M5 5h14v14H5z M9 9h.01 M15 15h.01 M15 9h.01 M9 15h.01 M12 12h.01',
  image: 'M4 5h16v14H4z M4 16l5-5 4 4 3-3 4 4 M15 9h.01',
  film: 'M4 5h16v14H4z M8 5v14 M16 5v14 M4 9h4 M4 15h4 M16 9h4 M16 15h4',
  keyboard: 'M3 7h18v10H3z M7 11h.01 M11 11h.01 M15 11h.01 M7 14h10',
  check: 'M5 12l5 5 9-10',
  alert: 'M12 4l9 16H3z M12 10v4 M12 17h.01',
  clip: 'M16 6l-8.5 8.5a2.1 2.1 0 003 3L19 9a3.5 3.5 0 00-5-5l-8.5 8.5a5 5 0 007 7L20 12',
  chevron: 'M9 6l6 6-6 6',
  lock: 'M6 11h12v9H6z M9 11V8a3 3 0 016 0v3',
  selection: 'M4 7V4h3 M10 4h4 M17 4h3v3 M20 10v4 M20 17v3h-3 M14 20h-4 M7 20H4v-3 M4 14v-4',
};

export function Icon({ name, className = 'h-3.5 w-3.5' }: { name: keyof typeof paths | string; className?: string }) {
  const filled = name === 'play' || name === 'stop';
  return (
    <svg viewBox="0 0 24 24" className={className} fill={filled ? 'currentColor' : 'none'} stroke={filled ? 'none' : 'currentColor'} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={paths[name] ?? ''} />
    </svg>
  );
}

export function Section({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between"><h3 className="label">{title}</h3>{right}</div>
      {children}
    </section>
  );
}
