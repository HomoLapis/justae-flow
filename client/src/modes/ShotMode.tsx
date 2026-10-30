/**
 * The shot list — Marker and Storyboard are the same screen with a different
 * source of slots, so they're one component.
 *
 *   marker       pairs of comp markers, taken in time order: (1,2), (3,4). Made
 *                for transitions, where the clip has to cover a specific gap.
 *   placeholder  the visible empty adjustment layers. Made for a cut that's
 *                already blocked out, where each layer is a shot with its own
 *                in/out and label colour.
 *
 * One row per shot: colour dot, tick, label and range, and its own **workflow
 * dropdown** — a different model for one clip is a dropdown on the row, not a
 * mode switch. Opening a row reveals that shot's prompt and that workflow's
 * inputs.
 *
 * The list is polled rather than refreshed by a button, because the user is
 * dragging markers and layers in AE while this panel is open, and a stale list
 * is worse than no list. Ticks and prompts survive each poll.
 */

import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { selectProvenCeiling, selectQueuedShots, useApp } from '../state/store';
import { deriveSegments, formatSeconds, type Segment } from '../state/segments';
import { shotLabelHex } from '../lib/labels';
import { ae, isErr } from '../bridge/extendscript';
import type { CompInfo } from '../bridge/extendscript';
import {
  promptFieldChoices, promptFieldOf, shotPlan, type AeContext, type FormField,
} from '../workflows/form';
import { useLibrary } from '../workflows/useLibrary';
import { DynamicForm } from '../components/DynamicForm';
import { computeAutoFill } from '../workflows/form';
import { PromptBox } from '../components/PromptBox';
import { GenerateButton } from '../components/GenerateButton';
import { CostEstimateLine } from '../components/CostEstimateLine';
import { ResourceChooser } from '../components/ResourceChooser';
import { JobProgress } from '../components/JobProgress';
import { SetupBar } from '../components/SetupBar';
import { useGenerate } from '../generate/useGenerate';
import { initialValues } from '../workflows/library';

interface Props {
  source: 'marker' | 'placeholder';
}

/** Only the comp properties the panel actually reads. */
function sameComp(a: CompInfo | null, b: CompInfo | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.name === b.name && a.width === b.width && a.height === b.height
    && a.frameRate === b.frameRate;
}

export function ShotMode({ source }: Props): JSX.Element {
  const segments = useApp((s) => (source === 'marker' ? s.segments : s.storyboardSegments));
  const selected = useApp((s) => (source === 'marker' ? s.selectedSegmentIds : s.selectedStoryboardIds));
  const toggle = useApp((s) => (source === 'marker' ? s.toggleSelectedSegment : s.toggleSelectedStoryboard));
  const selectAll = useApp((s) => (source === 'marker' ? s.selectAllSegments : s.selectAllStoryboard));
  const clearAll = useApp((s) => (source === 'marker' ? s.clearSelectedSegments : s.clearSelectedStoryboard));
  const setSegments = useApp((s) => s.setSegments);
  const syncLayers = useApp((s) => s.syncStoryboardLayers);
  const storyboardInfo = useApp((s) => s.storyboardInfo);
  const setStoryboardInfo = useApp((s) => s.setStoryboardInfo);
  const usePlayhead = useApp((s) => s.usePlayheadFallback);
  const setUsePlayhead = useApp((s) => s.setUsePlayheadFallback);
  const library = useApp((s) => s.library);
  const job = useApp((s) => s.job);
  const queued = useApp(useShallow(selectQueuedShots));

  const [comp, setComp] = useState<CompInfo | null>(null);
  const [hostError, setHostError] = useState<string | null>(null);

  const { ensureRecord } = useLibrary();
  const { generate, cancel } = useGenerate();
  const shotWorkflowsAll = useApp((s) => s.shotWorkflows);
  const activeIdAll = useApp((s) => s.activeId);

  /* Follow the timeline and the active comp. */
  useEffect(() => {
    let alive = true;
    const poll = async (): Promise<void> => {
      const c = await ae.activeComp();
      if (!alive) return;
      const next = c && typeof c === 'object' && 'width' in c ? c : null;
      // Same reason as the shot list: a fresh object every tick would re-render
      // every row and every form below it, for no change at all.
      setComp((prev) => (sameComp(prev, next) ? prev : next));

      if (source === 'marker') {
        const r = await ae.markers();
        if (!alive) return;
        // Surface what the host said instead of quietly showing an empty list:
        // "no markers" and "the bridge is broken" look identical otherwise.
        if (isErr(r)) { setHostError(r.error); setSegments([]); return; }
        setHostError(null);
        setSegments(deriveSegments(r.markers));
      } else {
        const r = await ae.visibleAdjustmentLayers();
        if (!alive) return;
        if (isErr(r)) { setHostError(r.error); setStoryboardInfo({ count: 0, adjustmentTotal: 0 }); return; }
        setHostError(null);
        syncLayers(r.layers, r.adjustmentCount);
      }
    };
    void poll();
    const t = setInterval(poll, 1200);
    return () => { alive = false; clearInterval(t); };
  }, [source, setSegments, syncLayers, setStoryboardInfo]);

  const idle = job.phase === 'idle' || job.phase === 'done'
    || job.phase === 'error' || job.phase === 'cancelled';
  const playheadMode = source === 'marker' && (segments.length === 0 || usePlayhead);
  const shotCount = playheadMode ? 1 : queued.length;
  const totalSeconds = segments
    .filter((s) => selected.includes(s.id))
    .reduce((sum, s) => sum + s.duration, 0);

  const canGenerate = idle && shotCount > 0 && library.length > 0;

  // What the estimate line and the resource chooser price: the ticked shots, each with its own workflow.
  const recordKinds = useApp(useShallow((s) => Object.fromEntries(Object.entries(s.records).map(([id, r]) => [id, r.inspected.primaryOutputKind]))));
  const estimateShots = useMemo(() => {
    const list = playheadMode
      ? [{ workflowId: activeIdAll, seconds: null as number | null }]
      : segments.filter((sg) => selected.includes(sg.id)).map((sg) => ({ workflowId: shotWorkflowsAll[sg.id] || activeIdAll, seconds: sg.duration as number | null }));
    return list.filter((x) => x.workflowId).map((x) => ({ ...x, scaleWithSlot: recordKinds[x.workflowId] !== 'image' }));
  }, [playheadMode, segments, selected, shotWorkflowsAll, activeIdAll, recordKinds]);

  return (
    <div className="flex h-full flex-col gap-3 px-3.5 pb-10 pt-3.5">
      {hostError && (
        <p className="rounded-lg border border-err/40 bg-err/10 px-2.5 py-2 text-[11px] leading-snug text-ink">
          EffectCraft said: <span className="font-mono text-err">{hostError}</span>
        </p>
      )}

      {library.length === 0 && (
        <p className="text-[11px] leading-snug text-ink-mute">
          No workflows in the library yet — the Workflow tab lists what's on your ComfyUI server.
        </p>
      )}

      {segments.length > 0 && (
        <div className="flex items-center justify-between">
          <span className="section-label">
            {source === 'marker' ? 'Marker shots' : 'Placeholders'} · {selected.length}/{segments.length}
            {selected.length > 0 && ` · ${totalSeconds.toFixed(1)}s`}
          </span>
          <div className="flex items-center gap-1">
            <button className="chip" onClick={selectAll}>All</button>
            <button className="chip" onClick={clearAll}>None</button>
          </div>
        </div>
      )}

      <div className="space-y-1.5">
        {segments.map((seg, i) => (
          <ShotRow
            key={seg.id}
            seg={seg}
            index={i + 1}
            checked={selected.includes(seg.id)}
            comp={comp}
            onToggle={() => toggle(seg.id)}
            onEnsureRecord={ensureRecord}
          />
        ))}
      </div>

      {segments.length === 0 && !hostError && (
        <EmptyState
          source={source}
          info={storyboardInfo}
          usePlayhead={usePlayhead}
          setUsePlayhead={setUsePlayhead}
        />
      )}

      {playheadMode && <PlayheadShot comp={comp} onEnsureRecord={ensureRecord} />}

      {/* Below the list rather than above it: saving is something you do after
          the work, and a Load button at the top of an empty panel invites
          loading a setup before there are any slots to match it against. */}
      <SetupBar
        mode={source === 'marker' ? 'marker' : 'storyboard'}
        segments={segments}
        comp={comp}
      />

      <div className="space-y-2 pt-1">
        <div className="flex items-stretch gap-1.5">
          <div className="min-w-0 flex-1">
            <GenerateButton
              phase={job.phase}
              disabled={!canGenerate}
              onGenerate={() => void generate()}
              onCancel={cancel}
              customIdleLabel={shotCount > 1 ? `Generate ${shotCount} clips` : 'Generate clip'}
            />
          </div>
          <ResourceChooser shots={estimateShots} disabled={!idle} />
        </div>
        {idle && <CostEstimateLine shots={estimateShots} />}
        <JobProgress job={job} />
      </div>
    </div>
  );
}

/* ─── One shot ──────────────────────────────────────────────────────── */

interface RowProps {
  seg: Segment;
  index: number;
  checked: boolean;
  comp: CompInfo | null;
  onToggle: () => void;
  onEnsureRecord: (id: string) => Promise<void>;
}

function ShotRow({ seg, index, checked, comp, onToggle, onEnsureRecord }: RowProps): JSX.Element {
  const library = useApp((s) => s.library);
  const activeId = useApp((s) => s.activeId);
  const shotWorkflows = useApp((s) => s.shotWorkflows);
  const setShotWorkflow = useApp((s) => s.setShotWorkflow);
  const clearShotWorkflow = useApp((s) => s.clearShotWorkflow);
  const expandedId = useApp((s) => s.expandedShotId);
  const setExpanded = useApp((s) => s.setExpandedShotId);
  const prompts = useApp((s) => s.segmentPrompts);
  const setSegmentPrompt = useApp((s) => s.setSegmentPrompt);
  const setActiveSegmentId = useApp((s) => s.setActiveSegmentId);
  const setActiveStoryboardId = useApp((s) => s.setActiveStoryboardId);
  const workflowId = shotWorkflows[seg.id] || activeId;
  const isOverride = !!shotWorkflows[seg.id] && shotWorkflows[seg.id] !== activeId;
  const defaultName = library.find((w) => w.id === activeId)?.name ?? 'none';
  // Subscribe to this row's record only: watching the whole map re-rendered
  // every row whenever any one of them finished loading.
  const record = useApp((s) => s.records[workflowId] ?? null);
  const readError = useApp((s) => s.recordErrors[workflowId] ?? null);
  const isLoaded = record !== null;
  const open = expandedId === seg.id;
  const prompt = prompts[seg.id] ?? '';
  const color = seg.labelColor ? shotLabelHex(seg.labelColor) : null;

  // Read the workflow this row points at, so its fields are ready when opened.
  useEffect(() => {
    if (workflowId && !isLoaded) void onEnsureRecord(workflowId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowId]);

  const openRow = (): void => {
    setExpanded(open ? null : seg.id);
    if (seg.source === 'adj') setActiveStoryboardId(seg.id);
    else setActiveSegmentId(seg.id);
  };

  const draftSide = useApp((s) => (s.settings.pipeline.tier === 'draft' ? s.settings.pipeline.draftLongSide : undefined));
  const aeContext: AeContext = useMemo(() => ({
    width: comp?.width,
    height: comp?.height,
    fps: comp?.frameRate,
    seconds: seg.duration,
    maxLongSide: draftSide,
  }), [comp?.width, comp?.height, comp?.frameRate, seg.duration, draftSide]);

  const promptTarget = useApp((s) => s.promptTargets[workflowId]);
  const setPromptTarget = useApp((s) => s.setPromptTarget);
  const promptField = record ? promptFieldOf(record.form, promptTarget) : null;

  /**
   * What the workflow will actually be asked to produce for this slot. Shown on
   * the row because the two numbers are not always the same: a model that only
   * accepts every 4th frame cannot hit 4.00s exactly, and seeing "4.17s" here
   * beats discovering it after the render — and when the panel can drive
   * neither the size nor the length, saying nothing was the bug.
   */
  const plan = useMemo(
    () => (record ? shotPlan(record.form, aeContext, seg.duration) : null),
    [record, aeContext, seg.duration],
  );

  /**
   * Whether anything this long has ever come back from this backend.
   *
   * Not a prediction and not a limit — the panel still queues whatever the slot
   * says. It is a fact the user already owns and cannot see: on this machine a
   * 6.32 s slot rendered in 2 m 53 s and a 10.44 s one took 1 h 27 m, because
   * somewhere between the two the model stopped fitting in VRAM. Where that
   * happens is a property of the card and the workflow, so it is learned from
   * finished clips rather than assumed. See RunCost in the store.
   */
  const ceiling = useApp((s) => selectProvenCeiling(s, workflowId));
  const beyondProven = ceiling !== null && seg.duration > ceiling.slotSeconds + 0.01;

  return (
    <div className="jae-stable overflow-hidden rounded-lg border border-line bg-bg-raised">
      <div className="flex flex-wrap items-center gap-2 px-2.5 py-2">
        {color && (
          <span
            className="h-2.5 w-2.5 shrink-0 rounded-sm"
            style={{ backgroundColor: color, boxShadow: 'inset 0 0 0 1px rgba(0,0,0,.3)' }}
            title={`AE label colour ${seg.labelColor}`}
          />
        )}
        <input type="checkbox" checked={checked} onChange={onToggle} title="Include in the batch" />

        <button type="button" onClick={openRow} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <span className={'shrink-0 text-ink-mute transition-transform ' + (open ? 'rotate-90' : '')}>▶</span>
          <span className="shrink-0 font-mono text-[10px] text-ink-mute">{String(index).padStart(2, '0')}</span>
          <span className="shrink-0 truncate text-xs text-ink">{seg.label}</span>
          <span className="shrink-0 font-mono text-[10px] text-ink-mute">
            {formatSeconds(seg.startTime)}→{formatSeconds(seg.endTime)} · slot {seg.duration.toFixed(2)}s
          </span>
          {plan?.lengthText && (
            <span
              className={'shrink-0 font-mono text-[10px] ' + (plan.over ? 'text-warn' : 'text-ok')}
              title={plan.over
                ? 'The model cannot hit the slot exactly, so it generates slightly over and the clip is trimmed when placed.'
                : 'Matches the slot exactly.'}
            >
              → {plan.lengthText}
            </span>
          )}
          {plan?.sizeText && (
            <span className="shrink-0 font-mono text-[10px] text-ok" title="Frame size taken from the composition">
              {plan.sizeText}
            </span>
          )}
          {plan && plan.warnings.length > 0 && (
            <span
              className="shrink-0 font-mono text-[10px] text-warn"
              title={plan.warnings.join('\n\n')}
            >
              ⚠ {plan.warnings.length}
            </span>
          )}
          {beyondProven && ceiling && (
            <span
              className="shrink-0 font-mono text-[10px] text-warn"
              title={`The longest clip this workflow has finished on this backend is `
                + `${ceiling.slotSeconds.toFixed(2)}s, and it took `
                + `${Math.floor(ceiling.renderSeconds / 60)}m ${ceiling.renderSeconds % 60}s.\n\n`
                + `This slot is ${seg.duration.toFixed(2)}s. Render time does not grow smoothly `
                + `with length — once the model stops fitting in VRAM it can jump by an order of `
                + `magnitude. Nothing is capped: this is what has actually worked here so far.`}
            >
              ⏱ &gt; {ceiling.slotSeconds.toFixed(1)}s proven
            </span>
          )}
          <span className="min-w-0 flex-1 truncate text-[10px] text-ink-mute">{prompt || '—'}</span>
        </button>

        {/*
          Rows follow the workflow chosen in the Workflow tab. Picking a
          different one here overrides it for this clip only, and the row says
          so in the accent colour — otherwise a batch of ten would give no clue
          that one of them is running something else.
        */}
        <div className="flex shrink-0 items-center gap-1">
          <select
            className={'input h-7 w-[150px] py-0 text-[11px] '
              + (isOverride ? 'border-brand text-brand' : '')}
            value={workflowId}
            onChange={(e) => { setShotWorkflow(seg.id, e.target.value); void onEnsureRecord(e.target.value); }}
            onClick={(e) => e.stopPropagation()}
            title={isOverride
              ? `This clip uses its own workflow. The default is "${defaultName}".`
              : 'Following the workflow selected in the Workflow tab'}
          >
            {!workflowId && <option value="">— workflow —</option>}
            {library.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
          {isOverride && (
            <button
              type="button"
              className="shrink-0 px-1 text-[11px] text-brand hover:text-ink"
              title={`Back to the default (${defaultName})`}
              onClick={(e) => { e.stopPropagation(); clearShotWorkflow(seg.id); }}
            >
              ↺
            </button>
          )}
        </div>

        <span
          className={'shrink-0 text-[10px] ' + (prompt.trim() ? 'text-ok' : 'text-ink-mute')}
          title={prompt.trim() ? 'Has a prompt' : 'No prompt yet'}
        >
          {prompt.trim() ? '✓' : '—'}
        </span>
      </div>

      {open && (
        <div className="divider space-y-3 bg-bg px-2.5 py-3">
          {!record ? (
            readError ? (
              <div className="space-y-1.5">
                <p className="text-[11px] leading-snug text-err">{readError}</p>
                <button
                  className="chip"
                  onClick={() => void onEnsureRecord(workflowId)}
                >
                  Try again
                </button>
              </div>
            ) : (
              <p className="text-[11px] text-ink-mute">
                Reading the workflow… the node list is a few megabytes and the first read after the
                server has been idle can take a minute.
              </p>
            )
          ) : (
            <>
              {plan && plan.warnings.length > 0 && (
                <ul className="space-y-1 rounded-lg border border-warn/40 bg-warn/10 px-2.5 py-2">
                  {plan.warnings.map((w) => (
                    <li key={w} className="text-[11px] leading-snug text-ink">{w}</li>
                  ))}
                </ul>
              )}
              {promptField ? (
                <PromptBox
                  value={prompt}
                  onChange={(v) => setSegmentPrompt(seg.id, v)}
                  placeholder={`What happens in "${seg.label}"?`}
                  assist={{
                    kind: record?.inspected.primaryOutputKind === 'image' ? 'image' : 'video',
                    seconds: typeof seg.duration === 'number' ? seg.duration : undefined,
                    workflow: record?.name, width: comp?.width, height: comp?.height,
                  }}
                />
              ) : (
                <p className="rounded-lg border border-warn/40 bg-warn/10 px-2.5 py-2 text-[11px] leading-snug text-ink">
                  The panel found no text field in this workflow to write a prompt into, so a prompt
                  typed here would not reach the render. Pick the right box below if there is one.
                </p>
              )}
              <PromptTargetRow
                record={record}
                chosen={promptField}
                overridden={!!promptTarget}
                onPick={(id) => setPromptTarget(workflowId, id)}
              />
              <WorkflowInputs
                record={record}
                aeContext={aeContext}
                hidePromptId={promptField?.id ?? null}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Where the prompt lands, stated and correctable.
 *
 * Which text box is "the prompt" is read off somebody else's graph, and no
 * reading of a graph is certain. Showing the answer — node, class and field —
 * turns a silent wrong guess into a visible one, and the dropdown makes it a
 * five-second fix instead of a mystery.
 */
function PromptTargetRow({
  record, chosen, overridden, onPick,
}: {
  record: NonNullable<ReturnType<typeof useApp.getState>['active']>;
  chosen: FormField | null;
  overridden: boolean;
  onPick: (fieldId: string) => void;
}): JSX.Element | null {
  const choices = promptFieldChoices(record.form);
  if (choices.length === 0) return null;
  const evidence = record.inspected.positivePrompt?.evidence;

  return (
    <details className="text-[10px]">
      <summary className="cursor-pointer list-none text-ink-mute hover:text-ink">
        Prompt goes to:{' '}
        <span className={chosen ? 'text-ink-dim' : 'text-warn'}>
          {chosen ? `${chosen.nodeId} · ${chosen.field}` : 'nothing'}
        </span>
        {overridden && <span className="text-brand"> · your choice</span>} ⌄
      </summary>
      <div className="mt-1.5 space-y-1">
        <select
          className="input text-xs"
          value={chosen?.id ?? ''}
          onChange={(e) => onPick(e.target.value)}
        >
          {!chosen && <option value="">— pick the prompt field —</option>}
          {choices.map((f) => (
            <option key={f.id} value={f.id}>
              {f.nodeId} · {f.field}{f.inactive ? ' (no effect)' : ''}
            </option>
          ))}
        </select>
        {!overridden && evidence && (
          <p className="leading-snug text-ink-mute">Found because it is {evidence}.</p>
        )}
      </div>
    </details>
  );
}

/** The one-off shot at the playhead, when a comp has no markers. */
function PlayheadShot({
  comp, onEnsureRecord,
}: {
  comp: CompInfo | null;
  onEnsureRecord: (id: string) => Promise<void>;
}): JSX.Element {
  const activeId = useApp((s) => s.activeId);
  const records = useApp((s) => s.records);
  const library = useApp((s) => s.library);
  const setActiveId = useApp((s) => s.setActiveId);
  const prompt = useApp((s) => s.playheadPrompt);
  const setPrompt = useApp((s) => s.setPlayheadPrompt);
  const promptTarget = useApp((s) => s.promptTargets[activeId]);
  const setPromptTarget = useApp((s) => s.setPromptTarget);

  const record = records[activeId] ?? null;
  const promptField = record ? promptFieldOf(record.form, promptTarget) : null;
  useEffect(() => {
    if (activeId && !records[activeId]) void onEnsureRecord(activeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  const draftSide = useApp((s) => (s.settings.pipeline.tier === 'draft' ? s.settings.pipeline.draftLongSide : undefined));
  const aeContext: AeContext = useMemo(() => ({
    width: comp?.width, height: comp?.height, fps: comp?.frameRate, maxLongSide: draftSide,
  }), [comp?.width, comp?.height, comp?.frameRate, draftSide]);

  return (
    <section className="space-y-2.5 rounded-lg border border-line bg-bg-raised p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="section-label">One clip at the playhead</span>
        <select
          className="input h-7 w-[150px] py-0 text-[11px]"
          value={activeId}
          onChange={(e) => { setActiveId(e.target.value); void onEnsureRecord(e.target.value); }}
        >
          {!activeId && <option value="">— workflow —</option>}
          {library.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
      </div>
      {promptField && (
        <PromptBox
          value={prompt}
          onChange={setPrompt}
          placeholder="Describe the clip…"
          assist={{ kind: record?.inspected.primaryOutputKind === 'image' ? 'image' : 'video', workflow: record?.name, width: comp?.width, height: comp?.height }}
        />
      )}
      {record && (
        <PromptTargetRow
          record={record}
          chosen={promptField}
          overridden={!!promptTarget}
          onPick={(id) => setPromptTarget(activeId, id)}
        />
      )}
      {record && (
        <WorkflowInputs record={record} aeContext={aeContext} hidePromptId={promptField?.id ?? null} />
      )}
    </section>
  );
}

/** A workflow's inputs, plus the controls that persist them as its defaults. */
function WorkflowInputs({
  record, aeContext, hidePromptId,
}: {
  record: NonNullable<ReturnType<typeof useApp.getState>['active']>;
  aeContext: AeContext;
  hidePromptId?: string | null;
}): JSX.Element {
  const values = useApp((s) => s.values[record.id]);
  const setValues = useApp((s) => s.setValues);
  const savePreset = useApp((s) => s.savePreset);
  const presets = useApp((s) => s.presets);
  const [note, setNote] = useState<string | null>(null);

  const flash = (msg: string): void => { setNote(msg); setTimeout(() => setNote(null), 4000); };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="section-label">
          {record.form.source === 'appmode' ? 'Inputs · App Mode' : 'Inputs'}
        </span>
        <div className="flex items-center gap-1">
          <button
            className="chip"
            onClick={() => { savePreset(record.id, values ?? {}); flash('Saved as this workflow\'s defaults.'); }}
          >
            Save defaults
          </button>
          {presets[record.id] && (
            <button
              className="chip"
              onClick={() => { setValues(record.id, initialValues(record, undefined)); flash('Back to the values in the workflow file.'); }}
            >
              Reset
            </button>
          )}
        </div>
      </div>
      <DynamicForm
        workflowId={record.id}
        fields={record.form.fields}
        aeContext={aeContext}
        hidePromptId={hidePromptId}
      />
      <SizeLine record={record} aeContext={aeContext} />
      {note && <p className="text-[10px] text-ok">{note}</p>}
    </div>
  );
}

/**
 * Under the inputs, one line: the size the shot is made at and what happens to it on the way into the comp — the
 * model's cap, the SeedVR2 pass when the comp is well above it, the scaling at placement. The notes under the width
 * and height fields say where each number came from; this says what the user will get.
 */
function SizeLine({ record, aeContext }: {
  record: NonNullable<ReturnType<typeof useApp.getState>['active']>;
  aeContext: AeContext;
}): JSX.Element | null {
  const values = useApp((s) => s.values[record.id]);
  const unlocked = useApp((s) => s.unlockedFields);
  const autoFillOn = useApp((s) => s.settings.defaults.aeAutoFill);
  const fitMode = useApp((s) => s.settings.defaults.fitMode);
  const upscale = useApp((s) => s.settings.defaults.upscaleToComp);
  const setDefaults = useApp((s) => s.setSettingsDefaults);
  const fields = record.form.fields;
  const auto = useMemo(() => (autoFillOn ? computeAutoFill(fields, aeContext) : { values: {}, reasons: {} }), [fields, aeContext, autoFillOn]);
  const size = (role: 'width' | 'height'): number | null => {
    const f = fields.find((x) => x.aeRole === role);
    if (!f) return null;
    const own = f.id in auto.values && !unlocked.includes(`${record.id}::${f.id}`);
    const v = Number(own ? auto.values[f.id] : values?.[f.id] ?? f.value);
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  const w = size('width');
  const h = size('height');
  const cw = aeContext.width;
  const ch = aeContext.height;
  if (!w || !h || !cw || !ch || (w === cw && h === ch)) return null;
  const video = record.inspected.primaryOutputKind !== 'image';
  const factor = Math.max(cw / w, ch / h);
  const placed = (f: number): string => (fitMode === 'fill' ? `scaled ${Math.round(f * 100)} % to fill the ${cw}×${ch} comp`
    : fitMode === 'fit' ? `fitted inside the ${cw}×${ch} comp` : `placed 1:1 in the ${cw}×${ch} comp`);
  // Well below the comp: the user's tick, the same switch as Settings ▸ Upscale to the comp size.
  const offer = video && factor > 1.15;
  const text = offer && upscale
    ? `Made at ${w}×${h} (this model's size), then SeedVR2 ×2 → ${w * 2}×${h * 2}, ${placed(factor / 2)}.`
    : offer
      ? `Made at ${w}×${h} (this model's size), ${placed(factor)}: soft.`
      : `Made at ${w}×${h}, ${placed(factor)}.`;
  return (
    <div className="space-y-1" data-testid="size-line">
      <p className="text-[10px] leading-snug text-ink-mute">{text}</p>
      {offer && (
        <label className="flex items-center gap-1.5 text-[10px] leading-snug text-ink-dim">
          <input type="checkbox" checked={upscale} onChange={(e) => setDefaults({ upscaleToComp: e.target.checked })} />
          Upscale to the comp size (SeedVR2 ×2, a second job on the same resource)
        </label>
      )}
    </div>
  );
}

/* ─── Nothing found ─────────────────────────────────────────────────── */

function EmptyState({
  source, info, usePlayhead, setUsePlayhead,
}: {
  source: 'marker' | 'placeholder';
  info: { count: number; adjustmentTotal: number; error?: string } | null;
  usePlayhead: boolean;
  setUsePlayhead: (v: boolean) => void;
}): JSX.Element {
  if (source === 'marker') {
    return (
      <section className="card space-y-2 p-3">
        <p className="text-[11px] leading-snug text-ink-dim">
          No comp markers yet. Add a pair of markers around each gap you want filled — the panel
          reads them in time order and treats each pair as one shot, so the clip comes out exactly
          as long as the gap. Markers on a layer aren't read; they have to be on the composition
          (press <span className="font-mono text-ink">*</span> with no layer selected).
        </p>
        <label className="flex cursor-pointer items-center gap-2 text-[11px] text-ink-dim">
          <input type="checkbox" checked={usePlayhead} onChange={(e) => setUsePlayhead(e.target.checked)} />
          Generate one clip at the playhead instead
        </label>
      </section>
    );
  }

  return (
    <section className="card space-y-1.5 p-3">
      <p className="text-[11px] leading-snug text-ink-dim">
        No placeholders visible. A placeholder is an <strong>adjustment layer</strong> with its eye
        switched on: its in and out points are the slot, and its label colour comes back on the
        generated clip.
      </p>
      {info && info.adjustmentTotal > 0 && info.count === 0 && (
        <p className="text-[11px] text-warn">
          {info.adjustmentTotal} adjustment layer{info.adjustmentTotal === 1 ? '' : 's'} in this comp,
          but none visible — switch an eye back on to use it as a slot.
        </p>
      )}
    </section>
  );
}
