import { useRef, useState } from 'react';
import { api, mediaUrl, type CardView } from '../api.ts';
import { act, useUi } from '../store.ts';
import { fmtDuration, fmtTime, Icon, Kbd, StatusChip } from './ui.tsx';

export function Storyboard() {
  const s = useUi((u) => u.server)!;
  if (s.host.ok && s.host.comp && s.cards.length === 0) return <Empty />;
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(232px,1fr))] gap-3 p-3">
      {s.cards.map((c, i) => <CardTile key={c.id} card={c} n={i + 1} />)}
    </div>
  );
}

function Empty() {
  const canvas = useUi((u) => u.server!.host.kind === 'canvas');
  const hasSelection = useUi((u) => !!u.server!.host.selection);
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-md space-y-4 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-ink-850 text-accent"><Icon name={canvas ? 'selection' : 'marker'} className="h-6 w-6" /></div>
        <h2 className="text-[16px] font-semibold">Your storyboard builds itself</h2>
        {canvas ? (
          <p className="leading-relaxed text-ink-300">
            Select an area in PhotoCraft and make it a <b className="text-ink-100">card</b>: the change you describe lands on a new layer, masked to it.
            Or add a <b className="text-ink-100">placeholder</b> layer and move and resize it: its box is the image to generate.
          </p>
        ) : (
          <p className="leading-relaxed text-ink-300">
            Add a <b className="text-ink-100">marker</b> in EffectCraft and type the shot as its comment — it shows up here as a card.
            Or add a <b className="text-ink-100">placeholder</b> layer and move and scale it: its size and length are the shot.
          </p>
        )}
        <div className="flex justify-center gap-2">
          {canvas
            ? <button className="btn-outline" disabled={!hasSelection} onClick={() => act(api.selectionCard())}><Icon name="selection" />Card from selection <Kbd>S</Kbd></button>
            : <button className="btn-outline" onClick={() => act(api.marker(''))}><Icon name="marker" />Marker at playhead</button>}
          <button className="btn-outline" onClick={() => act(api.placeholder())}><Icon name="box" />Placeholder <Kbd>M</Kbd></button>
        </div>
      </div>
    </div>
  );
}

function originIcon(card: CardView): string {
  return card.origin.kind === 'marker' ? 'marker' : card.origin.kind === 'placeholder' ? 'box' : card.origin.kind === 'selection' ? 'selection' : 'layers';
}

function boxText(card: CardView): string {
  const box = card.origin.kind === 'marker' ? undefined : card.origin.box;
  return box ? `${Math.round(box[2])}×${Math.round(box[3])}` : card.label;
}

function CardTile({ card, n }: { card: CardView; n: number }) {
  const selected = useUi((u) => u.selected.includes(card.id));
  const active = useUi((u) => u.active === card.id);
  const select = useUi((u) => u.select);
  const open = useUi((u) => u.open);
  const workflows = useUi((u) => u.server!.workflows);
  const wf = workflows.find((w) => w.id === card.workflowId);
  const version = card.versions.find((v) => v.n === card.activeVersion);
  const [hover, setHover] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvas = useUi((u) => u.server!.host.kind === 'canvas');

  const running = card.status === 'running';
  const pct = card.progress && card.progress.max > 0 ? card.progress.value / card.progress.max : 0;
  const preview = running && card.previewRev > 0 ? mediaUrl(`${card.id}/preview.jpg`, card.previewRev) : undefined;
  const still = version?.kind === 'image' ? mediaUrl(version.file, card.previewRev) : mediaUrl(card.thumb, card.previewRev);

  const onClick = (e: React.MouseEvent): void => {
    if (e.shiftKey) select(card.id, 'range');
    else if (e.ctrlKey || e.metaKey) select(card.id, 'toggle');
    else { select(card.id, 'only'); open(card.id); }
  };

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => { setHover(true); void videoRef.current?.play().catch(() => undefined); }}
      onMouseLeave={() => { setHover(false); videoRef.current?.pause(); }}
      className={`group relative cursor-pointer overflow-hidden rounded-lg border bg-ink-900 transition
        ${active ? 'border-accent' : selected ? 'border-accent/60' : 'border-ink-800 hover:border-ink-600'}
        ${selected ? 'ring-2 ring-accent/40' : ''} ${card.orphan ? 'opacity-50' : ''}`}
    >
      <div className="relative aspect-video bg-ink-950">
        {preview ? <img src={preview} className="h-full w-full object-contain" alt="" />
          : version?.kind === 'video' && hover ? (
            <video ref={videoRef} src={mediaUrl(version.file)} className="h-full w-full object-contain" muted loop playsInline autoPlay />
          ) : still ? <img src={still} className="h-full w-full object-contain" alt="" />
          : <div className="flex h-full items-center justify-center text-ink-600"><Icon name={wf?.output === 'image' ? 'image' : 'film'} className="h-7 w-7" /></div>}

        <div className="absolute left-2 top-2 flex items-center gap-1">
          <StatusChip status={card.status} extra={card.versions.length ? ` · v${card.activeVersion}` : undefined} />
        </div>
        <div className="absolute right-2 top-2 rounded bg-ink-950/80 px-1.5 py-0.5 font-mono text-[10.5px] text-ink-200">
          {String(n).padStart(2, '0')} · {canvas ? boxText(card) : fmtTime(card.at)}
        </div>
        {running && (
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-ink-950/90 to-transparent px-2 pb-1.5 pt-5">
            <div className="mb-1 flex justify-between text-[10.5px] text-ink-200">
              <span className="truncate">{card.progress?.phase ?? 'Starting'}</span>
              <span className="font-mono">{card.progress && card.progress.max > 1 ? `${card.progress.value}/${card.progress.max}` : ''}</span>
            </div>
            <div className="h-1 overflow-hidden rounded-full bg-ink-700"><div className="h-full bg-st-running transition-all" style={{ width: `${Math.round(pct * 100)}%` }} /></div>
          </div>
        )}
        {card.status === 'queued' && <div className="absolute inset-0 bg-ink-950/40" />}
        {!running && (
          <div className="absolute bottom-2 right-2 hidden gap-1 group-hover:flex" onClick={(e) => e.stopPropagation()}>
            {card.status === 'queued'
              ? <button className="btn-outline !bg-ink-900 !py-1" onClick={() => act(api.cancel(card.id))}><Icon name="stop" className="h-3 w-3" />Cancel</button>
              : !card.orphan && <button className="btn-primary !py-1 shadow-lg" onClick={() => act(api.generate([card.id]))}><Icon name="play" className="h-3 w-3" />{card.versions.length ? 'New version' : 'Generate'}</button>}
          </div>
        )}
        {running && (
          <button className="btn-outline absolute right-2 top-9 hidden !bg-ink-900/90 !py-1 group-hover:flex" onClick={(e) => { e.stopPropagation(); void act(api.cancel(card.id)); }}>
            <Icon name="stop" className="h-3 w-3" />Cancel
          </button>
        )}
      </div>

      <div className="space-y-1.5 p-2.5">
        <p className={`line-clamp-2 min-h-[2.6em] leading-snug ${card.prompt ? 'text-ink-100' : 'italic text-ink-500'}`}>
          {card.prompt || (wf?.task.startsWith('upscale') || wf?.task === 'remove-bg' ? 'No prompt needed'
            : wf?.task === 'matte-video' ? 'Name the subject to cut out'
            : wf?.task === 'reframe' ? 'Name the subject the frame follows'
            : card.origin.kind === 'selection' ? 'Describe the change for the selected area'
            : canvas ? 'Describe the image for this box' : 'Write the shot — here or as the marker text')}
        </p>
        <div className="flex items-center gap-1.5 text-[11px] text-ink-400">
          <Icon name={originIcon(card)} className="h-3 w-3" />
          <span className="truncate">{wf?.title ?? card.workflowId}</span>
          <span className="ml-auto shrink-0 font-mono">{canvas ? '' : card.seconds ? `${card.seconds}s` : card.slotSeconds ? `${card.slotSeconds.toFixed(1)}s` : ''}</span>
        </div>
        {card.status === 'error' && <p className="line-clamp-2 text-[11px] text-st-error" title={card.error}>{card.error}</p>}
        {card.orphan && <p className="text-[11px] text-ink-400">Its {card.origin.kind === 'selection' ? 'saved selection' : card.origin.kind} is gone from the {canvas ? 'document' : 'comp'} — versions are kept.</p>}
        {version && card.status !== 'error' && <p className="text-[10.5px] text-ink-500">v{version.n} of {card.versions.length} · {fmtDuration(version.elapsedMs)}{version.seed !== null ? ` · seed ${version.seed}` : ''}</p>}
      </div>
    </div>
  );
}
