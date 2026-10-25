/**
 * The Comp tab: tools that work on the whole composition — its work area, all
 * of it, or the selected layer — and always make something new beside it: a
 * new comp ("<Comp> · 9:16"), or a layer above with the original kept.
 *
 * Everything shown comes from the JustAE Flow server (GET /api/comp, polled
 * while the tab is open; POST /api/comp/plan for what a run will make). The
 * tool list is the server's (core/comp/tools.ts): a tool that is not there is
 * not shown. Each card: closed, a line; open, its few controls, "Advanced" for
 * the technical ones, the resource and the estimate, one button.
 *
 * Keys: G runs the open card, Esc cancels the running run, Tab compares the
 * last result (original ⇄ result).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../state/store';
import { formatCredits, useResources } from '../lib/resources';
import {
  clockTime, compApi, draftOf, effectiveSource, mediaUrl, pickedLayer, seconds, useComp,
  type CompRun, type CompState, type CompToolInfo, type SourceKind, type ToolDraft, type ToolOptions, type ToolPlan,
} from '../lib/comp';
import { ResourceChooser } from '../components/ResourceChooser';
import { CostEstimateLine } from '../components/CostEstimateLine';

const ASPECTS = ['9:16', '4:5', '1:1', '16:9', '21:9', '4:3'];

/** The open card's primary action, for the G key. */
let runOpenCard: (() => void) | null = null;

export function CompMode(): JSX.Element {
  const state = useComp((s) => s.state);
  const error = useComp((s) => s.error);
  const load = useComp((s) => s.load);
  const openTool = useComp((s) => s.openTool);
  const setOpenTool = useComp((s) => s.setOpenTool);
  const pick = useComp((s) => s.source);
  const layerPick = useComp((s) => s.layerPick);
  const cap = useApp((s) => s.settings.defaults.workAreaMaxDuration);

  // Follow the host while the tab is open: once a second, and at once after every action.
  useEffect(() => {
    let alive = true;
    const tick = (): void => { if (alive && document.visibilityState !== 'hidden') void load(); };
    tick();
    const t = setInterval(tick, 1000);
    return () => { alive = false; clearInterval(t); };
  }, [load]);

  useShortcuts(state);

  if (!state) {
    return <div className="px-3.5 py-6 text-[11px] text-ink-mute">{error ? <>The JustAE Flow server said: <span className="font-mono text-err">{error}</span></> : 'Reading the comp…'}</div>;
  }
  if (!state.host.ok) {
    return (
      <div className="space-y-2 px-3.5 py-4">
        <p className="rounded-lg border border-err/40 bg-err/10 px-2.5 py-2 text-[11px] leading-snug text-ink">
          {state.host.app} is not answering: <span className="font-mono text-err">{state.host.error}</span>
        </p>
      </div>
    );
  }
  if (state.host.kind !== 'timeline') {
    return <EmptyState title="The Comp tab works on an EffectCraft comp" body="This JustAE Flow server drives PhotoCraft, which has no timeline." />;
  }
  if (!state.comp) {
    return (
      <div className="flex h-full flex-col gap-3 px-3.5 pb-10 pt-3.5">
        <EmptyState
          title="Open a composition"
          body="The Comp tab works on the comp open in EffectCraft — its work area, all of it, or the selected layer. It shows up here as soon as one is open."
        />
        {state.runs.length > 0 && <Results state={state} />}
      </div>
    );
  }

  const source = effectiveSource(state, pick, layerPick);
  return (
    <div className="flex h-full flex-col gap-3 px-3.5 pb-10 pt-3.5" data-testid="comp-tab">
      <CompHeader state={state} />
      <SourcePicker state={state} source={source} cap={cap} />
      <div className="space-y-1.5">
        {state.tools.map((t) => (
          <ToolCard
            key={t.id}
            tool={t}
            state={state}
            source={source}
            cap={cap}
            open={openTool === t.id}
            onToggle={() => setOpenTool(openTool === t.id ? null : t.id)}
          />
        ))}
      </div>
      <Results state={state} />
      <p className="text-[10px] leading-snug text-ink-mute">
        <Kbd>G</Kbd> runs the open card · <Kbd>Esc</Kbd> cancels the running one · <Kbd>Tab</Kbd> compares the last result.
        Nothing in your comp is deleted: results are new comps, or a layer above with the original kept.
      </p>
    </div>
  );
}

/* ─── Header and source ─────────────────────────────────────────────── */

function CompHeader({ state }: { state: CompState }): JSX.Element {
  const c = state.comp!;
  const load = useComp((s) => s.load);
  return (
    <div className="space-y-1">
      <div className="flex items-baseline gap-2">
        <span className="section-label shrink-0">Comp</span>
        <span className="min-w-0 truncate text-xs font-medium text-ink" title={c.name}>{c.name}</span>
        <span className="ml-auto shrink-0 font-mono text-[10px] text-ink-mute">
          {c.width}×{c.height} · {Math.round(c.fps * 100) / 100} fps · {seconds(c.duration)}
        </span>
      </div>
      {state.resultOf && (
        <p className="flex items-center gap-1.5 text-[10px] text-ink-mute">
          <span>A result of {state.resultOf.compName ? <>&ldquo;{state.resultOf.compName}&rdquo;</> : 'another comp'}.</span>
          <button className="text-brand hover:underline" onClick={() => void compApi.open(state.resultOf!.cardId, undefined, 'source').then(load)}>Back to it</button>
        </p>
      )}
    </div>
  );
}

function SourcePicker({ state, source, cap }: { state: CompState; source: SourceKind; cap: number }): JSX.Element {
  const setSource = useComp((s) => s.setSource);
  const layerPick = useComp((s) => s.layerPick);
  const pickLayer = useComp((s) => s.pickLayer);
  const openSettings = useApp((s) => s.setSettingsOpen);
  const c = state.comp!;
  const wa = c.workArea ?? [0, c.duration];
  // The layer source is the one picked, kept while EffectCraft selects other layers (it selects every result it places).
  const picked = pickedLayer(state, layerPick);
  const sel = state.selected;
  const span = source === 'workArea' ? wa[1] - wa[0] : source === 'comp' ? c.duration : picked?.seconds ?? 0;
  const over = source !== 'layer' && span > cap + 1e-3;
  const usePick = (): void => { if (sel) pickLayer({ compId: c.id, layerId: sel.layerId, name: sel.name }); };
  const chip = (kind: SourceKind, label: React.ReactNode, title: string, onClick: () => void, disabled = false): JSX.Element => (
    <button
      type="button"
      className={'chip ' + (kind === 'layer' ? 'min-w-0 ' : 'shrink-0 ') + (source === kind ? '!border-brand/70 !bg-brand/15 !text-ink' : '')}
      onClick={onClick}
      disabled={disabled}
      title={title}
      data-source={kind}
    >
      <span className="truncate">{label}</span>
    </button>
  );
  // A selection that is not the picked layer is offered, never taken.
  const offer = sel && (!picked || picked.layerId !== sel.layerId) ? sel : null;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <span className="section-label shrink-0">Source</span>
        <div className="flex min-w-0 flex-1 gap-1">
          {chip('workArea', <>Work area <span className="font-mono text-[10px] text-ink-mute">{(Math.round(wa[0] * 10) / 10).toFixed(1)}–{seconds(wa[1])}</span></>,
            c.workAreaSet ? 'The work area, rendered by EffectCraft when the run starts' : 'No work area is set: it is the whole comp (B / N in EffectCraft set one)', () => setSource('workArea'))}
          {chip('comp', 'Whole comp', 'All of the comp, rendered by EffectCraft when the run starts', () => setSource('comp'))}
          {chip('layer', picked ? <>Layer: {picked.name}</> : sel ? <>Layer: {sel.name}</> : 'Selected layer',
            picked ? `The layer you picked: ${picked.path ?? 'no file'} (${picked.width}×${picked.height}). It stays the source until you pick another.`
              : sel ? `Use the selected layer's own file: ${sel.path ?? 'none'} (${sel.width}×${sel.height})` : 'Select a layer in EffectCraft',
            () => { if (picked) setSource('layer'); else usePick(); }, !picked && !sel)}
        </div>
      </div>
      <p className="text-[10px] leading-snug text-ink-mute">
        {source === 'layer' && picked
          ? <>The clip&rsquo;s own file, {picked.width}×{picked.height}, {seconds(picked.seconds)}{picked.media !== 'video' ? <span className="text-warn"> — {picked.media === 'image' ? 'a still' : 'no footage file'}</span> : null}.</>
          : <>A render of the {source === 'workArea' ? 'work area' : 'comp'} ({c.width}×{c.height}, {seconds(Math.min(span, cap))}) made by EffectCraft when the run starts, kept next to the project.</>}
      </p>
      {source === 'layer' && offer && (
        <p className="flex items-center gap-1.5 text-[10px] leading-snug text-ink-mute" data-testid="selection-offer">
          <span className="min-w-0 truncate">EffectCraft has &ldquo;{offer.name}&rdquo; selected now; the source stays &ldquo;{picked?.name}&rdquo;.</span>
          <button className="shrink-0 text-brand hover:underline" onClick={usePick}>Use it instead</button>
        </p>
      )}
      {over && (
        <div className="flex items-center gap-2 rounded-lg border border-warn/40 bg-warn/10 px-2.5 py-1.5 text-[11px] leading-snug text-ink" data-testid="cap-warning">
          <span className="text-warn">●</span>
          <span className="min-w-0 flex-1">
            The {source === 'workArea' ? 'work area' : 'comp'} lasts {seconds(span)}: the render stops at {cap} s (Work-area render cap).
          </span>
          <button
            className="chip h-6 shrink-0 px-2 py-0 text-[11px]"
            onClick={() => { openSettings(true); setTimeout(() => { const el = document.getElementById('work-area-cap'); el?.scrollIntoView({ block: 'center' }); el?.focus(); }, 80); }}
          >
            Change the cap
          </button>
        </div>
      )}
    </div>
  );
}

/* ─── A tool ────────────────────────────────────────────────────────── */

function usePlan(tool: string, source: SourceKind, options: ToolOptions, cap: number, state: CompState, enabled: boolean): { plan: ToolPlan | null; error: string | null } {
  const [plan, setPlan] = useState<ToolPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const c = state.comp;
  const layer = source === 'layer' ? state.picked : null;
  const key = JSON.stringify([tool, source, options, cap, c?.id, c?.width, c?.height, c?.fps, c?.duration, c?.workArea, layer ? [layer.layerId, layer.path, layer.in, layer.out] : null]);
  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    const t = setTimeout(() => {
      compApi.plan({ tool, source, layerId: layer?.layerId, options, cap })
        .then((p) => { if (alive) { setPlan(p); setError(null); } })
        .catch((e) => { if (alive) { setPlan(null); setError(e instanceof Error ? e.message : String(e)); } });
    }, 200);
    return () => { alive = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);
  return { plan, error };
}

/** The comp's frame at the playhead, captured by EffectCraft (render.frame), refreshed when the playhead moves. */
function useFrame(state: CompState, enabled: boolean): { url: string | null; refresh: () => void } {
  const [url, setUrl] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const compId = state.comp?.id;
  const time = Math.round((state.time ?? 0) * (state.comp?.fps || 24));
  const force = useRef(false);
  useEffect(() => {
    if (!enabled || compId === undefined) return undefined;
    let alive = true;
    const t = setTimeout(() => {
      const f = force.current;
      force.current = false;
      compApi.frame(f).then((r) => { if (alive) setUrl(mediaUrl(r.file, r.rev)); }).catch(() => undefined);
    }, 500);
    return () => { alive = false; clearTimeout(t); };
  }, [enabled, compId, time, nonce]);
  return { url, refresh: () => { force.current = true; setNonce((n) => n + 1); } };
}

function ToolCard({ tool, state, source, cap, open, onToggle }: {
  tool: CompToolInfo; state: CompState; source: SourceKind; cap: number; open: boolean; onToggle: () => void;
}): JSX.Element {
  const drafts = useComp((s) => s.drafts);
  const setDraft = useComp((s) => s.setDraft);
  const load = useComp((s) => s.load);
  const setFocusRun = useComp((s) => s.setFocusRun);
  const draft = draftOf(drafts, tool.id, tool.defaults);
  const usable = tool.sources.includes(source);
  const { plan, error } = usePlan(tool.id, source, draft.options, cap, state, open && usable);
  const frame = useFrame(state, open);
  const [busy, setBusy] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const set = (patch: Partial<ToolDraft>): void => setDraft(tool.id, patch);
  const setOpt = (k: string, v: string | number | boolean): void => set({ options: { ...draft.options, [k]: v } });

  // The same tool and variant from the same source already in the queue: its card is in Results. A pack: any of its runs.
  const inQueue = tool.id === 'social'
    ? state.runs.find((r) => !!r.group && r.source === source && (r.status === 'queued' || r.status === 'running'))
    : state.runs.find((r) => r.tool === tool.id && r.source === source && (r.status === 'queued' || r.status === 'running')
      && (!plan || variantOf(r) === plan.variant));
  const needsPrompt = !!plan?.prompt;
  const ready = !!plan?.ok && !busy && !inQueue && (!needsPrompt || draft.prompt.trim() !== '');

  const run = async (): Promise<void> => {
    if (!plan?.ok || busy) return;
    if (needsPrompt && !draft.prompt.trim()) { setRunError(`Write the ${plan.prompt!.label.toLowerCase()} first.`); return; }
    setBusy(true);
    setRunError(null);
    try {
      const r = await compApi.run({
        tool: tool.id, source, layerId: source === 'layer' ? state.picked?.layerId : undefined, options: draft.options, cap, prompt: draft.prompt,
        resource: draft.resource === 'default' ? null : draft.resource, seed: draft.seed,
      });
      setFocusRun(r.id);
      await load();
    } catch (e) {
      setRunError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  // G runs the card that is open.
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    if (!open) return undefined;
    runOpenCard = () => void runRef.current();
    return () => { if (runOpenCard) runOpenCard = null; };
  }, [open]);

  const shots = useMemo(() => (plan?.ok ? plan.jobs.map((j) => ({ workflowId: j.workflowId, seconds: j.seconds, scaleWithSlot: true })) : []), [plan]);

  return (
    <div className={'overflow-hidden rounded-lg border bg-bg-raised ' + (open ? 'border-brand/50' : 'border-line')} data-tool={tool.id}>
      <button type="button" className="flex w-full items-center gap-2.5 px-2.5 py-2 text-left hover:bg-bg-subtle/60" onClick={onToggle} aria-expanded={open}>
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-brand/15 text-sm text-brand">{tool.icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-medium text-ink">{tool.name}</span>
          <span className="block truncate text-[10px] text-ink-mute">{tool.promise}</span>
        </span>
        <span className={'shrink-0 text-[10px] text-ink-mute transition-transform ' + (open ? 'rotate-90' : '')}>▶</span>
      </button>

      {open && (
        <div className="divider space-y-3 bg-bg px-2.5 py-3">
          {!usable && <p className="text-[11px] text-warn">{tool.name} does not work from this source.</p>}
          <Preview tool={tool.id} state={state} source={source} options={draft.options} plan={plan} frame={frame.url} onRefresh={frame.refresh} />

          {tool.id === 'reframe' && <ReframeControls options={draft.options} setOpt={setOpt} />}
          {tool.id === 'upscale' && <UpscaleControls options={draft.options} setOpt={setOpt} plan={plan} />}
          {tool.id === 'extend' && <ExtendControls options={draft.options} setOpt={setOpt} />}
          {tool.id === 'slowmo' && <SlowmoControls options={draft.options} setOpt={setOpt} plan={plan} fps={source === 'layer' ? state.picked?.fps ?? state.comp!.fps : state.comp!.fps} />}
          {tool.id === 'social' && <SocialControls options={draft.options} setOpt={setOpt} />}

          {plan?.prompt && (
            <label className="block">
              <span className="flex items-center justify-between gap-2">
                <span className="field-label">{plan.prompt.label}</span>
                {(plan.prompt.label === 'What happens next' || plan.prompt.label === 'Scene') && state.describe?.available && (
                  <DescribeButton
                    tool={tool.id} source={source} layerId={source === 'layer' ? state.picked?.layerId : undefined} cap={cap}
                    model={state.describe.model} prompt={draft.prompt} setPrompt={(p) => set({ prompt: p })}
                  />
                )}
              </span>
              <textarea
                className="input resize-none text-xs leading-relaxed"
                rows={plan.prompt.label === 'Scene' || plan.prompt.label === 'What happens next' ? 3 : 1}
                value={draft.prompt}
                placeholder={plan.prompt.placeholder}
                onChange={(e) => set({ prompt: e.target.value })}
                onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); void run(); } }}
                data-testid={`prompt-${tool.id}`}
              />
            </label>
          )}

          <Advanced tool={tool.id} draft={draft} set={set} setOpt={setOpt} plan={plan} />

          {error && <p className="text-[11px] leading-snug text-err">{error}</p>}
          {plan && !plan.ok && <p className="rounded-lg border border-warn/40 bg-warn/10 px-2.5 py-2 text-[11px] leading-snug text-ink">{plan.reason}</p>}
          {plan?.ok && (
            <div className="space-y-1" data-testid={`plan-${tool.id}`}>
              <p className="text-[11px] leading-snug text-ink-dim">{plan.makes}</p>
              {plan.notes.map((n) => <p key={n} className="text-[10px] leading-snug text-ink-mute">{n}</p>)}
              {plan.warnings.map((w) => <p key={w} className="text-[10px] leading-snug text-warn">⚠ {w}</p>)}
            </div>
          )}

          <div className="space-y-2">
            <div className="flex items-stretch gap-1.5">
              <button type="button" className="btn-primary h-12 min-w-0 flex-1 text-base" disabled={!ready} onClick={() => void run()} data-testid={`run-${tool.id}`}>
                {busy ? 'Queuing…' : inQueue ? (inQueue.status === 'running' ? 'Running — see Results' : 'Queued — see Results') : `▶ ${plan?.action ?? tool.name}`}
              </button>
              <ResourceChooser shots={shots} value={draft.resource} onChange={(id) => set({ resource: id })} workflowId={plan?.workflowId} disabled={!plan?.ok} />
            </div>
            {plan?.ok && <CostEstimateLine shots={shots} resource={draft.resource} onSwitchLocal={() => set({ resource: 'local' })} />}
            {runError && <p className="text-[11px] leading-snug text-err">{runError}</p>}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * "Describe the clip": Qwen3-VL on the local ComfyUI reads four frames of the source (the last 3 s for Extend, the
 * whole span for a scene) and writes a paragraph into the prompt, for the user to edit. Nothing leaves the machine.
 */
function DescribeButton({ tool, source, layerId, cap, model, prompt, setPrompt }: {
  tool: string; source: SourceKind; layerId?: number; cap: number; model?: string; prompt: string; setPrompt: (p: string) => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ before: string; secs: number | null; frames: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const go = async (e: React.MouseEvent): Promise<void> => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await compApi.describe({ source, layerId, focus: tool === 'extend' ? 'end' : 'whole', cap });
      setDone({ before: prompt, secs: r.executionMs !== null ? r.executionMs / 1000 : null, frames: r.frames });
      setPrompt(tool === 'extend' ? `${r.text} Then: ` : r.text);
    } catch (x) {
      setErr(x instanceof Error ? x.message : String(x));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-[10px] text-ink-mute">
      {done && !busy && (
        <span className="truncate" data-testid="describe-done">
          from {done.frames} frame{done.frames === 1 ? '' : 's'}{done.secs !== null ? ` · ${done.secs.toFixed(1)} s` : ''}
          {' · '}<button type="button" className="underline hover:text-ink" onClick={(e) => { e.preventDefault(); setPrompt(done.before); setDone(null); }}>undo</button>
        </span>
      )}
      {err && <span className="truncate text-err" title={err}>{err}</span>}
      <button
        type="button"
        className="chip h-6 shrink-0 px-2 py-0 text-[11px]"
        disabled={busy}
        onClick={(e) => void go(e)}
        title={`${tool === 'extend' ? 'Four frames of the last 3 s' : 'Four frames of the whole source'} → ${model ?? 'Qwen3-VL'} on your local ComfyUI writes what it sees into the prompt, for you to edit. Nothing leaves this machine.`}
        data-testid="describe-clip"
      >
        {busy ? 'Describing…' : '✦ Describe the clip'}
      </button>
    </span>
  );
}

function variantOf(r: CompRun): string {
  if (r.tool === 'reframe') return r.options.mode === 'crop' ? `crop:${String(r.options.aspect)}` : `${String(r.options.quality ?? 'draft')}:${String(r.options.aspect)}`;
  if (r.tool === 'upscale') return `x${Number(r.options.scale) === 4 ? 4 : 2}`;
  if (r.tool === 'extend') return r.variant ?? `+${Number(r.options.seconds) || 2}`;
  if (r.tool === 'slowmo') return String(r.options.mode ?? 'slow2');
  return r.tool;
}

/* ─── Controls ──────────────────────────────────────────────────────── */

function Segmented<T extends string | number>({ value, options, onChange, label }: { value: T; options: Array<{ v: T; label: string; title?: string }>; onChange: (v: T) => void; label: string }): JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <span className="w-[54px] shrink-0 text-[11px] text-ink-dim">{label}</span>
      <div className="flex flex-wrap gap-1">
        {options.map((o) => (
          <button
            key={String(o.v)}
            type="button"
            title={o.title}
            className={'chip px-2 py-1 ' + (value === o.v ? '!border-brand/70 !bg-brand !text-white' : '')}
            onClick={() => onChange(o.v)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function ReframeControls({ options, setOpt }: { options: ToolOptions; setOpt: (k: string, v: string | number | boolean) => void }): JSX.Element {
  const crop = options.mode === 'crop';
  return (
    <div className="space-y-2">
      <Segmented label="Format" value={String(options.aspect ?? '9:16')} options={ASPECTS.map((a) => ({ v: a, label: a }))} onChange={(v) => setOpt('aspect', v)} />
      {!crop && (
        <Segmented
          label="Quality"
          value={String(options.quality ?? 'draft')}
          options={[
            { v: 'draft', label: 'Draft', title: 'Wan VACE 1.3B at 480p: minutes on a 16 GB card' },
            { v: 'final', label: 'Final', title: 'Wan VACE 14B at 720p (lightx2v 4-step LoRA)' },
          ]}
          onChange={(v) => setOpt('quality', v)}
        />
      )}
      {crop && <p className="text-[10px] text-ink-mute">Crop with tracking: nothing is generated (Advanced ▸ Mode).</p>}
    </div>
  );
}

function UpscaleControls({ options, setOpt, plan }: { options: ToolOptions; setOpt: (k: string, v: string | number | boolean) => void; plan: ToolPlan | null }): JSX.Element {
  const keep = options.colour !== 'model';
  return (
    <div className="space-y-1.5">
      <Segmented
        label="Scale"
        value={Number(options.scale) === 4 ? 4 : 2}
        options={[{ v: 2, label: '×2', title: 'One SeedVR2 pass' }, { v: 4, label: '×4', title: 'Two SeedVR2 ×2 passes, the second on the first\'s result' }]}
        onChange={(v) => setOpt('scale', v)}
      />
      {plan?.output && (
        <p className="pl-[62px] font-mono text-[11px] text-ink">
          {plan.source.width}×{plan.source.height} → <span className="text-ok">{plan.output.width}×{plan.output.height}</span>
        </p>
      )}
      <label className="flex cursor-pointer items-center gap-2 pl-[62px] text-[11px] text-ink-dim" data-testid="keep-colours"
        title="SeedVR2 raises contrast and saturation on its own; its colour correction matches the result to your original">
        <input type="checkbox" checked={keep} onChange={(e) => setOpt('colour', e.target.checked ? 'keep' : 'model')} />
        Keep original colours
      </label>
    </div>
  );
}

function ExtendControls({ options, setOpt }: { options: ToolOptions; setOpt: (k: string, v: string | number | boolean) => void }): JSX.Element {
  return (
    <Segmented
      label="Length"
      value={Number(options.seconds) || 2}
      options={[2, 4, 5].map((s) => ({ v: s, label: `+${s} s`, title: `${s} more seconds after the out point` }))}
      onChange={(v) => setOpt('seconds', v)}
    />
  );
}

function SlowmoControls({ options, setOpt, plan, fps }: { options: ToolOptions; setOpt: (k: string, v: string | number | boolean) => void; plan: ToolPlan | null; fps: number }): JSX.Element {
  const f = Math.round((plan?.source.fps ?? fps) * 100) / 100;
  return (
    <div className="space-y-2">
      <Segmented
        label="Make"
        value={String(options.mode ?? 'slow2')}
        options={[
          { v: 'slow2', label: '×2 slow', title: 'Twice as long, at the same frame rate' },
          { v: 'slow4', label: '×4 slow', title: 'Four times as long, at the same frame rate' },
          { v: 'fps2', label: `${f} → ${Math.round(f * 200) / 100} fps`, title: 'The same length at twice the frame rate (25 → 50, 24 → 48, 30 → 60)' },
        ]}
        onChange={(v) => setOpt('mode', v)}
      />
      <Segmented
        label="Engine"
        value={String(options.engine ?? 'rife')}
        options={[
          { v: 'rife', label: 'RIFE', title: 'Fast, good on most shots (MIT)' },
          { v: 'film', label: 'FILM', title: 'The official ComfyUI template: core nodes, Google\'s FILM (Apache-2.0)' },
        ]}
        onChange={(v) => setOpt('engine', v)}
      />
      {plan?.output && (
        <p className="pl-[62px] font-mono text-[11px] text-ink">
          {seconds(plan.source.seconds)} at {f} fps → <span className="text-ok">{seconds(plan.output.seconds)} at {Math.round((plan.output.fps ?? f) * 100) / 100} fps</span>
        </p>
      )}
    </div>
  );
}

const SOCIAL_FORMATS = ['9:16', '1:1', '4:5', '16:9', '21:9', '4:3'];

function SocialControls({ options, setOpt }: { options: ToolOptions; setOpt: (k: string, v: string | number | boolean) => void }): JSX.Element {
  const picked = String(options.formats ?? '').split(',').filter(Boolean);
  const toggle = (a: string): void => {
    const next = picked.includes(a) ? picked.filter((x) => x !== a) : [...picked, a];
    setOpt('formats', SOCIAL_FORMATS.filter((x) => next.includes(x)).join(','));
  };
  return (
    <div className="space-y-2" data-testid="social-controls">
      <div className="flex items-center gap-2">
        <span className="w-[54px] shrink-0 text-[11px] text-ink-dim">Formats</span>
        <div className="flex flex-wrap gap-1">
          {SOCIAL_FORMATS.map((a) => (
            <button key={a} type="button" data-format={a}
              className={'chip px-2 py-1 ' + (picked.includes(a) ? '!border-brand/70 !bg-brand !text-white' : '')}
              onClick={() => toggle(a)}>{picked.includes(a) ? '✓ ' : ''}{a}</button>
          ))}
        </div>
      </div>
      <Segmented
        label="Quality"
        value={String(options.quality ?? 'draft')}
        options={[{ v: 'draft', label: 'Draft', title: 'Wan VACE 1.3B at 480p' }, { v: 'final', label: 'Final', title: 'Wan VACE 14B at 720p' }]}
        onChange={(v) => setOpt('quality', v)}
      />
      <label className="flex cursor-pointer items-center gap-2 pl-[62px] text-[11px] text-ink-dim">
        <input type="checkbox" checked={options.upscale === true} onChange={(e) => setOpt('upscale', e.target.checked)} />
        + Upscale ×2 (SeedVR2, original colours kept)
      </label>
      <Segmented
        label="Masters"
        value={String(options.masters ?? 'none')}
        options={[
          { v: 'none', label: 'None' },
          { v: 'prores4444', label: 'ProRes 4444', title: 'A .mov of each final comp, next to the project' },
          { v: 'png16', label: 'PNG 16-bit', title: 'A 16-bit PNG sequence of each final comp' },
        ]}
        onChange={(v) => setOpt('masters', v)}
      />
    </div>
  );
}

function Advanced({ tool, draft, set, setOpt, plan }: {
  tool: string; draft: ToolDraft; set: (p: Partial<ToolDraft>) => void; setOpt: (k: string, v: string | number | boolean) => void; plan: ToolPlan | null;
}): JSX.Element {
  const o = draft.options;
  return (
    <details className="text-[11px]" data-testid={`advanced-${tool}`}>
      <summary className="cursor-pointer list-none text-ink-mute hover:text-ink">Advanced ⌄</summary>
      <div className="mt-2 space-y-2 rounded-lg border border-line bg-bg-subtle/40 p-2.5">
        {tool === 'reframe' && (
          <>
            <Segmented
              label="Mode"
              value={String(o.mode ?? 'generate')}
              options={[
                { v: 'generate', label: 'Generate the space', title: 'Wan VACE outpainting: nothing of your frame is lost' },
                { v: 'crop', label: 'Crop with tracking', title: 'SAM 3 follows the subject; the frame is cropped, nothing generated' },
              ]}
              onChange={(v) => setOpt('mode', v)}
            />
            {o.mode === 'crop' && (
              <Segmented
                label="Follow"
                value={String(o.smooth ?? 'gentle')}
                options={[{ v: 'gentle', label: 'Gentle' }, { v: 'steady', label: 'Steady' }, { v: 'locked', label: 'Locked' }]}
                onChange={(v) => setOpt('smooth', v)}
              />
            )}
          </>
        )}
        {tool === 'upscale' && (plan?.choices?.method?.length ?? 0) > 0 && (
          <div className="flex items-center gap-2">
            <span className="w-[54px] shrink-0 text-[11px] text-ink-dim">Colour</span>
            <select
              className="input h-7 w-auto py-0 text-xs"
              value={String(o.method ?? plan!.choices!.method[0])}
              disabled={o.colour === 'model'}
              onChange={(e) => setOpt('method', e.target.value)}
              data-testid="colour-method"
            >
              {plan!.choices!.method.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
            <span className="text-[10px] text-ink-mute">SeedVR2&rsquo;s colour correction (its own choices); wavelet matched best when measured</span>
          </div>
        )}
        {tool !== 'matte' && tool !== 'social' && (
          <div className="flex items-center gap-2">
            <span className="w-[54px] shrink-0 text-[11px] text-ink-dim">Seed</span>
            <input
              className="input h-7 w-32 py-0 text-xs"
              type="number"
              placeholder="random"
              value={draft.seed ?? ''}
              onChange={(e) => set({ seed: e.target.value === '' ? null : Math.max(0, Math.round(Number(e.target.value))) })}
            />
            <span className="text-[10px] text-ink-mute">{draft.seed === null ? 'a new one each run (recorded in job.json)' : 'the same every run'}</span>
          </div>
        )}
        <p className="text-[10px] leading-snug text-ink-mute">
          Workflow: <span className="font-mono text-ink-dim">{plan?.workflowId ?? '—'}</span>
          {tool === 'reframe' && ' · official template video_wan_vace_outpainting'}
          {tool === 'upscale' && ' · official template utility_seedvr2_3b_int8_upscale_video'}
          {tool === 'matte' && ' · official template utility_video_segment_sam3 (tracking)'}
          {tool === 'extend' && (plan?.workflowId === 'ltx25-extend'
            ? ' · from the official template video_ltx2_5_flf2v: the last frames as a video guide (LTXVAddGuide at frame 0, LTXVCropGuides)'
            : ' · official template video_ltx2_5_i2v, from the last frame')}
          {tool === 'slowmo' && ' · official template utility_video_frame_interpolation (RIFE in place of its interpolator; FILM as it ships)'}
          {tool === 'social' && ' · one Reframe per format (video_wan_vace_outpainting), then SeedVR2'}
          . Every run keeps the graph it submitted and a job.json next to the project.
        </p>
      </div>
    </details>
  );
}

/* ─── Previews from the comp itself ─────────────────────────────────── */

function ratio(a: string): number {
  const [w, h] = a.split(':').map(Number);
  return w / h;
}

function fit(ar: number, maxW: number, maxH: number): [number, number] {
  return ar >= maxW / maxH ? [maxW, maxW / ar] : [maxH * ar, maxH];
}

function Preview({ tool, state, source, options, plan, frame, onRefresh }: {
  tool: string; state: CompState; source: SourceKind; options: ToolOptions; plan: ToolPlan | null; frame: string | null; onRefresh: () => void;
}): JSX.Element {
  const c = state.comp!;
  const srcW = plan?.source.width || (source === 'layer' ? state.picked?.width : c.width) || c.width;
  const srcH = plan?.source.height || (source === 'layer' ? state.picked?.height : c.height) || c.height;
  const srcAr = srcW / srcH;
  const H = 96;
  const [fw, fh] = fit(srcAr, 150, H);
  const img = frame
    ? <img src={frame} alt="" className="absolute inset-0 h-full w-full object-cover" draggable={false} />
    : <span className="absolute inset-0 grid place-items-center text-[10px] text-ink-mute">frame…</span>;
  const from = (
    <figure className="shrink-0">
      <div className="relative overflow-hidden rounded border border-line bg-black" style={{ width: fw, height: fh }}>{img}</div>
      <figcaption className="mt-0.5 font-mono text-[9px] text-ink-mute">{srcW}×{srcH} · at the playhead</figcaption>
    </figure>
  );
  let to: JSX.Element | null = null;
  if (tool === 'reframe') {
    const aspect = String(options.aspect ?? '9:16');
    const ar = ratio(aspect);
    if (options.mode === 'crop') {
      // The crop window inside the frame; what falls outside is dimmed.
      const [cw, ch] = ar <= srcAr ? [fh * ar, fh] : [fw, fw / ar];
      to = (
        <figure className="shrink-0">
          <div className="relative overflow-hidden rounded border border-line bg-black" style={{ width: fw, height: fh }}>
            {img}
            <div className="absolute border border-brand" style={{ width: cw, height: ch, left: (fw - cw) / 2, top: (fh - ch) / 2, boxShadow: '0 0 0 999px rgba(0,0,0,.6)' }} />
          </div>
          <figcaption className="mt-0.5 font-mono text-[9px] text-ink-mute">{aspect} crop · follows the subject</figcaption>
        </figure>
      );
    } else {
      const [tw, th] = fit(ar, 150, H);
      const [iw, ih] = fit(srcAr, tw, th);
      to = (
        <figure className="shrink-0">
          <div
            className="relative overflow-hidden rounded border border-brand/70"
            style={{ width: tw, height: th, backgroundImage: 'repeating-linear-gradient(135deg, rgb(var(--jae-accent) / .35) 0 4px, rgb(var(--jae-accent) / .12) 4px 9px)' }}
            title="Hatched: the space the model generates"
          >
            <div className="absolute overflow-hidden" style={{ width: iw, height: ih, left: (tw - iw) / 2, top: (th - ih) / 2 }}>{img}</div>
          </div>
          <figcaption className="mt-0.5 font-mono text-[9px] text-ink-mute">{aspect}{plan?.output ? ` · ${plan.output.width}×${plan.output.height}` : ''} · <span className="text-brand">▨ generated</span></figcaption>
        </figure>
      );
    }
  } else if (tool === 'upscale') {
    const k = Number(options.scale) === 4 ? 4 : 2;
    to = (
      <div className="flex flex-col justify-center gap-1 text-[11px]">
        <span className="font-mono text-ink">×{k}</span>
        <span className="font-mono text-ok">{srcW * k}×{srcH * k}</span>
        <span className="text-[10px] text-ink-mute">a new comp at that size</span>
      </div>
    );
  } else if (tool === 'matte') {
    to = (
      <div className="flex flex-col justify-center gap-1 text-[10px] text-ink-mute">
        <span>→ a luma track matte</span>
        <span>→ ProRes 4444 with alpha</span>
      </div>
    );
  } else if (tool === 'extend') {
    const s = Number(options.seconds) || 2;
    const motion = plan?.ok ? plan.motion : undefined;
    to = (
      <div className="flex flex-col justify-center gap-1 text-[11px]" data-testid="extend-motion">
        <span className="font-mono text-ok">+{s} s</span>
        {motion
          ? <span className="text-[10px] text-ink">continues the last {(Math.round(motion.seconds * 10) / 10).toFixed(1)} s of motion</span>
          : <span className="text-[10px] text-ink-mute">from the last frame</span>}
        <span className="text-[10px] text-ink-mute">a new layer from the out point</span>
      </div>
    );
  } else if (tool === 'slowmo') {
    to = (
      <div className="flex flex-col justify-center gap-1 text-[11px]">
        <span className="font-mono text-ok">{options.mode === 'fps2' ? '2× fps' : options.mode === 'slow4' ? '×4 slow' : '×2 slow'}</span>
        <span className="text-[10px] text-ink-mute">new frames in between</span>
      </div>
    );
  } else if (tool === 'social') {
    const formats = String(options.formats ?? '').split(',').filter(Boolean);
    to = (
      <div className="flex items-end gap-1">
        {formats.slice(0, 6).map((a) => {
          const [tw, th] = fit(ratio(a), 40, 56);
          return (
            <div key={a} className="flex flex-col items-center gap-0.5">
              <div className="rounded-sm border border-brand/70" style={{ width: tw, height: th, backgroundImage: 'repeating-linear-gradient(135deg, rgb(var(--jae-accent) / .35) 0 3px, rgb(var(--jae-accent) / .12) 3px 7px)' }} />
              <span className="font-mono text-[8px] text-ink-mute">{a}</span>
            </div>
          );
        })}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2.5">
      {from}
      <span className="text-ink-mute">→</span>
      {to}
      <button type="button" className="ml-auto self-start text-[10px] text-ink-mute hover:text-ink" title="Capture the frame at the playhead again" onClick={onRefresh}>↻</button>
    </div>
  );
}

/* ─── Results ───────────────────────────────────────────────────────── */

function Results({ state }: { state: CompState }): JSX.Element | null {
  if (state.runs.length === 0) {
    return (
      <div className="space-y-1.5">
        <span className="section-label">Results</span>
        <p className="text-[10px] text-ink-mute">Nothing yet. Each run lands here, with its comp, its time and what it cost.</p>
      </div>
    );
  }
  const waiting = state.queue.pending.length;
  // A pack's runs show as one result, where its newest run would be.
  const shown = new Set<string>();
  const items: Array<{ key: string; runs: CompRun[] }> = [];
  for (const r of state.runs) {
    if (!r.group) { items.push({ key: r.id, runs: [r] }); continue; }
    if (shown.has(r.group.id)) continue;
    shown.add(r.group.id);
    items.push({ key: r.group.id, runs: state.runs.filter((x) => x.group?.id === r.group!.id).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)) });
  }
  return (
    <div className="space-y-1.5" data-testid="comp-results">
      <div className="flex items-center justify-between">
        <span className="section-label">Results · {items.length}</span>
        {waiting > 0 && <span className="text-[10px] text-ink-mute">{waiting} waiting in the queue (one at a time)</span>}
      </div>
      {items.map((it) => (it.runs[0].group ? <PackResult key={it.key} runs={it.runs} state={state} /> : <ResultCard key={it.key} run={it.runs[0]} state={state} />))}
    </div>
  );
}

/** A Social pack: its runs together, with how far it has got. */
function PackResult({ runs, state }: { runs: CompRun[]; state: CompState }): JSX.Element {
  const g = runs[0].group!;
  const done = runs.filter((r) => r.status === 'done' && r.versions.length > 0).length;
  const live = runs.some((r) => r.status === 'running' || r.status === 'queued');
  const failed = runs.filter((r) => r.status === 'error').length;
  const formats = runs.filter((r) => r.tool === 'reframe').map((r) => String(r.options.aspect)).join(' + ');
  const exports = runs.flatMap((r) => r.versions.flatMap((v) => v.exports ?? []));
  return (
    <div className="space-y-1.5 rounded-lg border border-brand/40 bg-bg-raised/60 p-2" data-testid="pack-result" data-group={g.id}>
      <div className="flex items-center gap-2">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-brand/15 text-xs text-brand">☰</span>
        <span className="min-w-0 flex-1 truncate text-xs text-ink">{g.label} · {formats}</span>
        <span className={'shrink-0 font-mono text-[10px] ' + (failed ? 'text-err' : live ? 'text-ink-dim' : 'text-ok')}>
          {done}/{runs.length} done{failed ? ` · ${failed} failed` : ''}{live ? ' · in the queue' : ''}
        </span>
      </div>
      {exports.length > 0 && <p className="truncate pl-8 font-mono text-[9px] text-ok" title={exports.map((x) => x.path).join('\n')}>✔ {exports.length} master{exports.length === 1 ? '' : 's'} written next to the project</p>}
      <div className="space-y-1.5 pl-2">
        {runs.map((r) => <ResultCard key={r.id} run={r} state={state} />)}
      </div>
    </div>
  );
}

function useTick(on: boolean): void {
  const [, set] = useState(0);
  useEffect(() => {
    if (!on) return undefined;
    const t = setInterval(() => set((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [on]);
}

const SOURCE_WORD: Record<SourceKind, string> = { workArea: 'work area', comp: 'whole comp', layer: 'layer' };

/** What tells two runs of one tool apart: Draft or Final, a crop, the engine. */
function tagOf(r: CompRun): string | null {
  if (r.tool === 'slowmo') return r.options.engine === 'gimm' ? 'GIMM-VFI (no longer offered)' : r.options.engine === 'film' ? 'FILM' : 'RIFE';
  // Runs made before the colour option (25 Oct) kept the template's "none": no tag rather than a wrong one.
  if (r.tool === 'upscale') return r.options.colour === undefined ? null : r.options.colour === 'model' ? 'Model colours' : 'Colours kept';
  if (r.tool !== 'reframe') return null;
  if (r.options.mode === 'crop') return 'Crop';
  return r.options.quality === 'final' ? 'Final' : 'Draft';
}

function ResultCard({ run, state }: { run: CompRun; state: CompState }): JSX.Element {
  const load = useComp((s) => s.load);
  const focus = useComp((s) => s.focusRun);
  const setFocus = useComp((s) => s.setFocusRun);
  const resources = useResources((s) => s.data?.resources);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const live = run.status === 'running' || run.status === 'queued';
  useTick(run.status === 'running');
  const v = run.versions.find((x) => x.n === run.activeVersion) ?? run.versions.at(-1);
  const res = resources?.find((r) => r.id === v?.resource);
  const metered = res ? res.creditsPerHour !== null : false;
  const act = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(name);
    setErr(null);
    setFocus(run.id);
    try { await fn(); await load(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  };
  const p = run.progress;
  const pct = p && p.max > 1 ? Math.min(100, (p.value / p.max) * 100) : null;
  const position = run.status === 'queued' ? state.queue.pending.indexOf(run.id) + 1 : 0;
  const dot = run.status === 'done' ? 'bg-ok' : run.status === 'error' ? 'bg-err' : live ? 'bg-brand animate-pulse-soft' : 'bg-ink-mute';
  const exp = v?.exports?.at(-1);

  return (
    <div
      className={'rounded-lg border bg-bg-raised p-2.5 ' + (focus === run.id ? 'border-brand/50' : 'border-line')}
      onMouseDown={() => setFocus(run.id)}
      data-run={run.id}
    >
      <div className="flex gap-2.5">
        <div className="relative h-[54px] w-[72px] shrink-0 overflow-hidden rounded border border-line bg-black">
          {v?.thumb ? <img src={mediaUrl(v.thumb, v.n)} alt="" className="h-full w-full object-contain" draggable={false} /> : <span className="grid h-full place-items-center text-[9px] text-ink-mute">{live ? '…' : '—'}</span>}
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-1.5">
            <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
            <span className="min-w-0 truncate text-xs text-ink" title={v?.compName ? `In the comp "${v.compName}"` : run.label}>{run.label}{v && v.n > 1 ? ` v${v.n}` : ''}</span>
            {v && !live && (
              <span className="ml-auto shrink-0 font-mono text-[10px] text-ink-mute" title={`wall-clock ${clockTime(v.elapsedMs)}${v.executionMs !== null ? ` · GPU execution ${clockTime(v.executionMs)}` : ''} · ${res?.label ?? v.resource ?? ''}`}>
                {clockTime(v.executionMs ?? v.elapsedMs)} · {v.derivedCredits !== null ? `≈ ${formatCredits(v.derivedCredits)} cr` : metered ? '— cr' : 'no credits'}
              </span>
            )}
          </div>
          <p className="truncate text-[10px] text-ink-mute">
            {tagOf(run) ? <span className="text-ink-dim">{tagOf(run)} · </span> : null}{SOURCE_WORD[run.source]}{run.prompt ? ` · “${run.prompt}”` : ''}{v?.width ? ` · ${v.width}×${v.height}` : ''}{run.runsOn && live ? ` · on ${run.runsOn.label}` : res ? ` · ${res.label}` : ''}
          </p>

          {run.status === 'running' && (
            <div className="space-y-1">
              <div className="h-1 overflow-hidden rounded bg-bg-subtle">
                <div className={'h-full bg-brand transition-all ' + (pct === null ? 'w-1/3 animate-pulse' : '')} style={pct !== null ? { width: `${pct}%` } : undefined} />
              </div>
              <div className="flex items-center gap-2 text-[10px]">
                <span className="min-w-0 truncate text-ink-dim">{p?.phase ?? 'Starting'}{p && p.max > 1 ? ` ${Math.round(p.value)}/${Math.round(p.max)}` : ''}</span>
                <span className="ml-auto shrink-0 font-mono text-ink-mute">{p ? clockTime(Date.now() - p.startedAt) : ''}</span>
                <button className="chip h-6 shrink-0 px-2 py-0 text-[11px]" onClick={() => void act('cancel', () => compApi.cancel(run.id))}>✕ Cancel</button>
              </div>
            </div>
          )}
          {run.status === 'queued' && (
            <div className="flex items-center gap-2 text-[10px] text-ink-dim">
              <span>Queued{position > 0 ? ` · ${position} in line` : ''}</span>
              <button className="chip ml-auto h-6 px-2 py-0 text-[11px]" onClick={() => void act('cancel', () => compApi.cancel(run.id))}>✕ Cancel</button>
            </div>
          )}
          {!v && !live && run.status !== 'error' && (
            <div className="flex items-center gap-2 text-[10px] text-ink-mute">
              <span>Canceled — nothing was made.</span>
              <button className="chip ml-auto h-6 px-2 py-0 text-[11px]" onClick={() => void act('retry', () => compApi.retry(run.id))}>Run again</button>
              <button className="px-1 text-[11px] text-ink-mute hover:text-ink" title="Remove from this list" onClick={() => void act('remove', () => compApi.remove(run.id))}>✕</button>
            </div>
          )}
          {run.status === 'error' && (
            <div className="flex items-start gap-2">
              <p className="min-w-0 flex-1 text-[10px] leading-snug text-err">{run.error}</p>
              <button className="chip h-6 shrink-0 px-2 py-0 text-[11px]" onClick={() => void act('retry', () => compApi.retry(run.id))}>Retry</button>
            </div>
          )}

          {v && !live && (
            <div className="flex flex-wrap items-center gap-1 pt-0.5">
              <button className="chip h-6 px-2 py-0 text-[11px]" disabled={!!busy} onClick={() => void act('open', () => compApi.open(run.id, v.n))} title="Open the result in EffectCraft">Open comp</button>
              {v.showing && (
                <button
                  className={'chip h-6 px-2 py-0 text-[11px] ' + (v.showing === 'original' ? '!border-warn/60 !text-warn' : '')}
                  disabled={!!busy}
                  onClick={() => void act('compare', () => compApi.compare(run.id, v.n))}
                  title="Original ⇄ result: shows and hides layers in EffectCraft, nothing is deleted (Tab)"
                  data-testid="compare"
                >
                  ⇄ {v.showing === 'original' ? 'Showing the original' : 'Compare'}
                </button>
              )}
              {v.canExport && (
                <button className="chip h-6 px-2 py-0 text-[11px]" disabled={!!busy} onClick={() => void act('export', () => compApi.exportAlpha(run.id, v.n))} title="ProRes 4444 with the matte as alpha, next to the project">
                  {busy === 'export' ? 'Exporting…' : 'Export with alpha'}
                </button>
              )}
              {exp && <button className="chip h-6 px-2 py-0 text-[11px]" onClick={() => void compApi.reveal(exp.path)} title={exp.path}>Reveal .mov</button>}
              {run.versions.length > 1 && (
                <select
                  className="input h-6 w-auto py-0 pl-2 pr-6 text-[11px]"
                  value={v.n}
                  onChange={(e) => void act('version', () => compApi.version(run.id, Number(e.target.value)))}
                  title="Versions: each run is kept"
                >
                  {run.versions.map((x) => <option key={x.n} value={x.n}>v{x.n}</option>)}
                </select>
              )}
              <button
                className="ml-auto px-1 text-[11px] text-ink-mute hover:text-ink"
                title="Remove from this list (the comps and files stay)"
                onClick={() => void act('remove', () => compApi.remove(run.id))}
              >
                ✕
              </button>
            </div>
          )}
          {exp && <p className="truncate font-mono text-[9px] text-ok" title={exp.path}>✔ {exp.path.split(/[\\/]/).pop()}</p>}
          {err && <p className="text-[10px] leading-snug text-err">{err}</p>}
        </div>
      </div>
    </div>
  );
}

/* ─── Bits ──────────────────────────────────────────────────────────── */

function EmptyState({ title, body }: { title: string; body: string }): JSX.Element {
  return (
    <div className="rounded-xl border border-dashed border-line bg-bg-raised px-4 py-6 text-center" data-testid="comp-empty">
      <p className="text-sm font-medium text-ink">{title}</p>
      <p className="mx-auto mt-1.5 max-w-[380px] text-[11px] leading-snug text-ink-mute">{body}</p>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }): JSX.Element {
  return <kbd className="rounded border border-line bg-bg-subtle px-1 font-mono text-[9px] text-ink-dim">{children}</kbd>;
}

/** G · Esc · Tab, while the Comp tab is in front and no field has the keyboard. */
function useShortcuts(state: CompState | null): void {
  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const app = useApp.getState();
      if (app.tab !== 'comp' || app.settingsOpen || app.historyOpen) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) {
        if (e.key === 'Escape') t.blur();
        return;
      }
      const s = stateRef.current;
      if (!s) return;
      if (e.key === 'g' || e.key === 'G') {
        e.preventDefault();
        runOpenCard?.();
      } else if (e.key === 'Escape') {
        const running = s.runs.find((r) => r.status === 'running') ?? [...s.runs].reverse().find((r) => r.status === 'queued');
        if (running) { e.preventDefault(); void compApi.cancel(running.id).then(() => useComp.getState().load()); }
      } else if (e.key === 'Tab') {
        const focus = useComp.getState().focusRun;
        const pickRun = (r: CompRun): boolean => r.status === 'done' && r.versions.some((v) => v.showing !== null);
        const r = s.runs.find((x) => x.id === focus && pickRun(x)) ?? s.runs.find(pickRun);
        if (!r) return;
        e.preventDefault();
        const v = r.versions.find((x) => x.n === r.activeVersion) ?? r.versions.at(-1);
        useComp.getState().setFocusRun(r.id);
        void compApi.compare(r.id, v?.n).then(() => useComp.getState().load()).catch(() => undefined);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
