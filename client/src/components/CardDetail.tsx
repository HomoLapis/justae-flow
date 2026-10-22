import { useEffect, useRef, useState } from 'react';
import { api, mediaUrl, type CardView, type WorkflowInfo } from '../api.ts';
import { act, useUi } from '../store.ts';
import { fmtDuration, fmtTime, Icon, Kbd, Section, StatusChip } from './ui.tsx';

export function CardDetail() {
  const s = useUi((u) => u.server)!;
  const activeId = useUi((u) => u.active);
  const open = useUi((u) => u.open);
  const card = s.cards.find((c) => c.id === activeId);
  if (!card) return null;
  const n = s.cards.indexOf(card) + 1;
  const wf = s.workflows.find((w) => w.id === card.workflowId);
  return (
    <aside className="flex w-[380px] shrink-0 flex-col border-l border-ink-800 bg-ink-900">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-ink-800 px-3">
        <span className="font-semibold">Card {String(n).padStart(2, '0')}</span>
        <span className="text-ink-400">· {card.label} @ {fmtTime(card.at)}</span>
        <div className="ml-auto flex items-center gap-1"><StatusChip status={card.status} /><button className="btn-ghost !px-1" onClick={() => open(null)}><Icon name="x" /></button></div>
      </div>
      <div className="flex-1 space-y-5 overflow-y-auto p-3">
        <Preview card={card} />
        {card.status === 'error' && (
          <div className="rounded-md border border-st-error/40 bg-[#e04fd112] p-2.5 text-[12px] text-ink-100">
            <div className="mb-1 flex items-center gap-1.5 font-semibold text-st-error"><Icon name="alert" />Generation failed</div>
            <p className="whitespace-pre-wrap break-words text-ink-200">{card.error}</p>
          </div>
        )}
        <PromptBox card={card} wf={wf} />
        <WorkflowPicker card={card} workflows={s.workflows} />
        {wf?.input === 'image' && <InputImage card={card} />}
        <Shot card={card} wf={wf} />
        <Versions card={card} />
        {(card.orphan || card.origin.kind !== 'marker') && card.status !== 'running' && card.status !== 'queued' && (
          <button className="btn-danger" title="The project is not touched; generated versions stay on disk"
            onClick={() => act(api.remove(card.id), 'Card removed from the storyboard')}>
            <Icon name="x" />Remove card from the storyboard
          </button>
        )}
      </div>
      <Actions card={card} />
    </aside>
  );
}

function Preview({ card }: { card: CardView }) {
  const v = card.versions.find((x) => x.n === card.activeVersion);
  const live = card.status === 'running' && card.previewRev > 0 ? mediaUrl(`${card.id}/preview.jpg`, card.previewRev) : undefined;
  return (
    <div className="overflow-hidden rounded-md border border-ink-800 bg-ink-950">
      <div className="aspect-video">
        {live ? <img src={live} className="h-full w-full object-contain" alt="live preview" />
          : card.status === 'running' ? (
            <div className="relative h-full w-full">
              {card.thumb && <img src={mediaUrl(card.thumb, card.previewRev)} className="h-full w-full object-contain opacity-40" alt="" />}
              <div className="absolute inset-0 flex items-center justify-center text-ink-300">Generating — the preview appears once sampling starts</div>
            </div>
          )
          : v?.kind === 'video' ? <video key={v.file} src={mediaUrl(v.file)} className="h-full w-full object-contain" controls loop muted autoPlay playsInline />
          : v?.kind === 'image' ? <img src={mediaUrl(v.file)} className="h-full w-full object-contain" alt="" />
          : card.thumb ? <img src={mediaUrl(card.thumb, card.previewRev)} className="h-full w-full object-contain" alt="" />
          : <div className="flex h-full items-center justify-center text-ink-600">No preview yet</div>}
      </div>
      {card.status === 'running' && card.progress && (
        <div className="border-t border-ink-800 px-2.5 py-2">
          <div className="mb-1 flex justify-between text-[11px] text-ink-300">
            <span>{card.progress.phase}</span>
            <span className="font-mono">{card.progress.max > 1 ? `${card.progress.value}/${card.progress.max} · ` : ''}{fmtDuration(Date.now() - card.progress.startedAt)}</span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-ink-700"><div className="h-full bg-st-running transition-all" style={{ width: `${card.progress.max ? (card.progress.value / card.progress.max) * 100 : 0}%` }} /></div>
        </div>
      )}
    </div>
  );
}

function PromptBox({ card, wf }: { card: CardView; wf?: WorkflowInfo }) {
  const [text, setText] = useState(card.prompt);
  const dirty = useRef(false);
  useEffect(() => { if (!dirty.current) setText(card.prompt); }, [card.prompt, card.id]);
  const save = (): void => {
    if (!dirty.current) return;
    dirty.current = false;
    if (text !== card.prompt) void act(api.update(card.id, { prompt: text }));
  };
  if (wf && !wf.bindings.prompt) return <Section title="Prompt"><p className="text-ink-400">{wf.title} does not take a prompt.</p></Section>;
  return (
    <Section title="Prompt" right={card.origin.kind === 'marker' ? <span className="text-[10.5px] text-ink-500">mirrors the marker text</span> : undefined}>
      <textarea
        data-prompt
        className="field min-h-[96px] resize-y leading-relaxed"
        value={text}
        placeholder="Describe the shot: subject, action, camera, light…"
        onChange={(e) => { dirty.current = true; setText(e.target.value); }}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            save();
            void act(api.generate([card.id]));
          }
          e.stopPropagation();
        }}
      />
      <p className="text-[10.5px] text-ink-500"><Kbd>Ctrl Enter</Kbd> saves and generates</p>
    </Section>
  );
}

function WorkflowPicker({ card, workflows }: { card: CardView; workflows: WorkflowInfo[] }) {
  const wf = workflows.find((w) => w.id === card.workflowId);
  const groups: Array<[string, WorkflowInfo[]]> = [
    ['Video', workflows.filter((w) => w.output === 'video' && !w.input?.startsWith('video'))],
    ['Image', workflows.filter((w) => w.output === 'image' && w.task !== 'remove-bg')],
    ['From the layer', workflows.filter((w) => w.input === 'video' || w.task === 'remove-bg')],
  ];
  return (
    <Section title="Workflow">
      <select className="field" value={card.workflowId} onChange={(e) => act(api.update(card.id, { workflowId: e.target.value }))}>
        {groups.map(([g, ws]) => ws.length > 0 && <optgroup key={g} label={g}>{ws.map((w) => <option key={w.id} value={w.id}>{w.title}</option>)}</optgroup>)}
      </select>
      {wf && (
        <div className="space-y-1 text-[11.5px] text-ink-400">
          <p>{wf.description}</p>
          <p className="flex flex-wrap items-center gap-1.5">
            {wf.license.openWeights && <span className="rounded bg-[#5fd37a1c] px-1.5 py-px text-[10.5px] font-semibold text-st-done">Open weights</span>}
            <span title={wf.license.weights}>{wf.license.weights.split(' — ')[0]}</span>
            <span className="text-ink-500">· template {wf.source.template}</span>
          </p>
        </div>
      )}
    </Section>
  );
}

function InputImage({ card }: { card: CardView }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const src = card.attachment ? mediaUrl(card.attachment, card.previewRev) : mediaUrl(card.thumb, card.previewRev);
  return (
    <Section title="Start image" right={
      <div className="flex gap-1">
        <button className="btn-ghost !py-0.5" onClick={() => fileRef.current?.click()}><Icon name="clip" />Attach</button>
        {card.attachment && <button className="btn-ghost !py-0.5" onClick={() => act(api.detach(card.id))}><Icon name="x" />Use the frame</button>}
      </div>}>
      <div className="flex items-center gap-2.5">
        <div className="h-14 w-24 shrink-0 overflow-hidden rounded border border-ink-700 bg-ink-950">{src && <img src={src} className="h-full w-full object-cover" alt="" />}</div>
        <p className="text-[11.5px] text-ink-400">{card.attachment ? 'Your attached image.' : `The frame under the ${card.origin.kind} at ${fmtTime(card.at)}, as the comp shows it.`}</p>
      </div>
      <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void act(api.attach(card.id, f), 'Image attached'); e.target.value = ''; }} />
    </Section>
  );
}

function Shot({ card, wf }: { card: CardView; wf?: WorkflowInfo }) {
  const comp = useUi((u) => u.server!.host.comp);
  const [seconds, setSeconds] = useState(card.seconds ? String(card.seconds) : '');
  useEffect(() => setSeconds(card.seconds ? String(card.seconds) : ''), [card.seconds, card.id]);
  const video = wf?.output === 'video' && !wf.input?.startsWith('video');
  return (
    <Section title="Shot">
      <div className="grid grid-cols-2 gap-2">
        {video && (
          <label className="space-y-1">
            <span className="text-[11px] text-ink-400">Length</span>
            <div className="flex items-center gap-1">
              <input className="field font-mono" inputMode="decimal" placeholder={card.slotSeconds ? card.slotSeconds.toFixed(2) : String(wf?.defaults?.seconds ?? 5)} value={seconds}
                onChange={(e) => setSeconds(e.target.value)}
                onBlur={() => act(api.update(card.id, { seconds: seconds ? Number(seconds) : 0 }))}
                onKeyDown={(e) => e.stopPropagation()} />
              <span className="text-ink-500">s</span>
            </div>
            <span className="block text-[10.5px] text-ink-500">{card.seconds ? 'set by you' : card.origin.kind === 'marker' ? 'until the next marker' : 'the layer\'s length'}</span>
          </label>
        )}
        <div className="space-y-1">
          <span className="text-[11px] text-ink-400">Size</span>
          <p className="field font-mono !text-ink-300">{comp ? `${card.origin.kind === 'marker' ? comp.width : card.origin.width ?? comp.width}×${card.origin.kind === 'marker' ? comp.height : card.origin.height ?? comp.height}` : '—'}</p>
          <span className="block text-[10.5px] text-ink-500">{card.origin.kind === 'marker' ? 'the comp' : card.origin.kind === 'placeholder' ? 'the placeholder' : 'the layer'}</span>
        </div>
      </div>
      <div className="flex items-start gap-2 rounded-md bg-ink-850 px-2.5 py-2 text-[11.5px]">
        <Icon name="check" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
        <p className="text-ink-300">
          Will render <b className="font-mono text-ink-100">{card.plan.width ? `${card.plan.width}×${card.plan.height}` : card.plan.sizeNote ?? '—'}</b>
          {card.plan.seconds ? <> · <b className="font-mono text-ink-100">{card.plan.seconds}s</b></> : null}
          {card.plan.width && card.plan.sizeNote ? <span className="text-ink-500"> ({card.plan.sizeNote}{card.origin.kind === 'marker' ? ', scaled to cover the comp' : ', fitted to the placeholder'})</span> : null}
          {card.plan.lengthNote ? <span className="text-ink-500"> · {card.plan.lengthNote}</span> : null}
        </p>
      </div>
      {wf?.bindings.seed && <Seed card={card} />}
      {(wf?.params ?? []).map((p) => <Param key={p.ref} card={card} refId={p.ref} label={p.label} />)}
    </Section>
  );
}

function Seed({ card }: { card: CardView }) {
  const [v, setV] = useState(card.seed === null ? '' : String(card.seed));
  useEffect(() => setV(card.seed === null ? '' : String(card.seed)), [card.seed, card.id]);
  const last = card.versions.find((x) => x.n === card.activeVersion)?.seed;
  return (
    <div className="flex items-center gap-2">
      <span className="w-14 text-[11px] text-ink-400">Seed</span>
      <input className="field font-mono" placeholder="random each time" value={v} onChange={(e) => setV(e.target.value.replace(/\D/g, ''))}
        onBlur={() => act(api.update(card.id, { seed: v ? Number(v) : null }))} onKeyDown={(e) => e.stopPropagation()} />
      {last != null && card.seed === null && <button className="btn-ghost shrink-0" title="Keep the seed of the active version" onClick={() => act(api.update(card.id, { seed: last }))}><Icon name="lock" />Keep</button>}
      {card.seed !== null && <button className="btn-ghost shrink-0" title="Random seed on every run" onClick={() => act(api.update(card.id, { seed: null }))}><Icon name="dice" />Random</button>}
    </div>
  );
}

function Param({ card, refId, label }: { card: CardView; refId: string; label: string }) {
  const value = card.params[refId];
  if (typeof value === 'boolean' || /enhanc|switch|enable/i.test(label)) {
    const on = value === true;
    return (
      <label className="flex cursor-pointer items-center gap-2 text-[12px] text-ink-200">
        <input type="checkbox" className="accent-[#7c9cff]" checked={on} onChange={(e) => act(api.update(card.id, { params: { [refId]: e.target.checked } }))} />{label}
      </label>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <span className="w-14 text-[11px] text-ink-400">{label}</span>
      <input className="field font-mono" placeholder="workflow default" defaultValue={value === undefined ? '' : String(value)}
        onBlur={(e) => act(api.update(card.id, { params: { [refId]: e.target.value === '' ? undefined : Number(e.target.value) } }))} onKeyDown={(e) => e.stopPropagation()} />
    </div>
  );
}

function Versions({ card }: { card: CardView }) {
  if (card.versions.length === 0) return null;
  return (
    <Section title={`Versions · ${card.versions.length}`} right={<span className="text-[10.5px] text-ink-500"><Kbd>Tab</Kbd> previous ↔ active</span>}>
      <div className="space-y-1">
        {[...card.versions].reverse().map((v) => {
          const active = v.n === card.activeVersion;
          return (
            <button key={v.n} onClick={() => !active && act(api.version(card.id, v.n), `v${v.n} is now in the comp`)}
              className={`flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left transition ${active ? 'border-accent/60 bg-accent-soft' : 'border-ink-800 hover:border-ink-600'}`}>
              <span className={`font-mono text-[11px] ${active ? 'text-accent' : 'text-ink-300'}`}>v{String(v.n).padStart(3, '0')}</span>
              <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-200" title={v.prompt}>{v.prompt || '—'}</span>
              <span className="shrink-0 text-[10.5px] text-ink-500">{v.width ? `${v.width}×${v.height}` : ''}{v.seconds ? ` · ${v.seconds}s` : ''} · {fmtDuration(v.elapsedMs)}</span>
              {active && <Icon name="check" className="h-3.5 w-3.5 shrink-0 text-accent" />}
            </button>
          );
        })}
      </div>
      {card.versions.find((v) => v.n === card.activeVersion)?.remaps.length ? (
        <p className="text-[10.5px] text-ink-500" title={card.versions.find((v) => v.n === card.activeVersion)!.remaps.join('\n')}>
          Ran on your ComfyUI's own variant of {card.versions.find((v) => v.n === card.activeVersion)!.remaps.length} model file(s) — hover for details.
        </p>
      ) : null}
    </Section>
  );
}

function Actions({ card }: { card: CardView }) {
  const busy = card.status === 'running' || card.status === 'queued';
  return (
    <div className="flex shrink-0 items-center gap-2 border-t border-ink-800 p-3">
      {busy ? (
        <button className="btn-outline flex-1 justify-center" onClick={() => act(api.cancel(card.id))}><Icon name="stop" className="h-3 w-3" />Cancel <Kbd>Esc</Kbd></button>
      ) : (
        <>
          <button className="btn-primary flex-1 justify-center" disabled={card.orphan} onClick={() => act(api.generate([card.id]))}>
            <Icon name="play" className="h-3 w-3" />{card.versions.length ? 'New version' : 'Generate'} <Kbd>G</Kbd>
          </button>
          {card.versions.length > 0 && (
            <button className="btn-outline" disabled={card.orphan} title="New version with a fresh random seed (V)"
              onClick={async () => { await act(api.update(card.id, { seed: null })); await act(api.generate([card.id])); }}>
              <Icon name="dice" />Vary <Kbd>V</Kbd>
            </button>
          )}
        </>
      )}
    </div>
  );
}
