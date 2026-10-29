/**
 * Running shots.
 *
 * One pipeline serves both modes, because a "shot" is the same thing either
 * way — a slice of the timeline with a start, a length and a prompt. Markers
 * define it by a pair of times; a Storyboard placeholder defines it by an
 * adjustment layer's in/out. Everything after that is identical.
 *
 * Per shot:
 *   1. Work out the shot's folder next to the project.
 *   2. Upload its attachments (frames grabbed from AE, images edited in
 *      Photoshop, work-area clips) and copy them into the shot's inputs/.
 *   3. Take the form's values, let After Effects fill canvas size and clip
 *      length over them, write the result into a clone of the workflow.
 *   4. Queue it, follow the progress, save what comes back into output/.
 *   5. Drop the clip on the timeline at the shot's start — trimmed to the slot
 *      and never stretched — and record job.json next to it.
 *
 * Shots run one at a time. That is not a limitation to work around: every
 * ComfyUI backend here executes one graph at a time anyway, and a serial batch
 * keeps the model warm between clips instead of reloading it.
 */

import { useRef } from 'react';
import { useApp, type AttachmentRef, type HistoryEntry } from '../state/store';
import { estimate as estimateRuns, reportRun, resolveRun, useResources, type EstimateAnswer, type ResourceView } from '../lib/resources';
import { RunError } from '../providers/ServerV2Provider';
import { outputProfile } from '../pipeline/catalog';
import { applyPreset } from '../pipeline/apply';
import { makeProRes4444, makePng16Sequence } from '../lib/master';
import { addLosslessSave, LOSSLESS_EXT } from '../pipeline/losslessSave';
import type { Segment } from '../state/segments';
import { buildProvider } from '../providers/registry';
import type { OutputFile, VideoProvider } from '../providers/types';
import {
  applyFormValues, computeAutoFill, promptFieldOf, shotPlan, type AeContext, type FormField,
} from '../workflows/form';
import { pickPrimaryOutput } from '../workflows/inspector';
import type { WorkflowRecord } from '../workflows/library';
import { defaultOutputName, layerNameFromPrompt } from '../lib/filenames';
import { panelClientId } from '../lib/clientId';
import {
  nodeAvailable, writeBlobToFile, pathJoin, copyFile, basename,
  readFileAsBlob, mimeForPath, ensureDir,
} from '../lib/fs';
import {
  resolveFlowRoot, ensureShotFolders, writeJobManifest, writeWorkflowSnapshot,
  type JobManifest, type ShotFolders,
} from '../lib/assets';
import { ae, isErr, type CompInfo, type FitMode } from '../bridge/extendscript';
import { serverHeaders } from '../bridge/server';
import { useReadiness } from '../lib/readiness';

interface UseGenerate {
  generate: () => Promise<void>;
  cancel: () => void;
}

/** One unit of work. */
interface ShotSpec {
  index: number;
  label: string;
  prompt: string;
  attachments: AttachmentRef[];
  segment: Segment | null;
  /** Where the clip goes on the timeline; null = at the playhead. */
  anchorTime: number | null;
  durationSeconds: number;
  /** The workflow this shot runs through — chosen per row. */
  workflowId: string;
}

export function useGenerate(): UseGenerate {
  const unsubRef = useRef<(() => void) | null>(null);
  const providerRef = useRef<VideoProvider | null>(null);
  const jobIdRef = useRef<string | null>(null);
  const cancelledRef = useRef(false);

  const generate = async (): Promise<void> => {
    const state = useApp.getState();
    const { setJob } = state;

    // Missing node types are surfaced when the workflow is read, not enforced
    // here. Our catalogue is a snapshot and can be stale — a ComfyUI that is
    // still starting reports a partial node list — whereas the server itself
    // answers a genuinely unrunnable graph with a 400 naming the exact node,
    // which we pass through verbatim. Blocking on our own copy would refuse
    // work that would in fact run.

    const shots = buildShots(state);
    if ('error' in shots) { setJob({ phase: 'error', error: shots.error }); return; }

    // Every shot names its own workflow, so check they're all readable before
    // starting: finding out at clip 7 of 9 wastes the six that already ran.
    const missing = shots.list.filter((s) => !s.workflowId || !state.records[s.workflowId]);
    if (missing.length > 0) {
      setJob({
        phase: 'error',
        error: missing.some((s) => !s.workflowId)
          ? 'Some shots have no workflow selected — pick one in the dropdown on each row.'
          : `Still reading the workflow for: ${missing.map((s) => s.label).join(', ')}. Try again in a moment.`,
      });
      return;
    }

    /*
     * A prompt with nowhere to go is a failure, not a detail.
     *
     * The panel used to accept the text, show it on the row, and then find no
     * field to write it into — so the shot rendered from whatever prompt was
     * baked into the workflow file and nothing said a word. Stopping here
     * costs one message; not stopping cost a batch of clips that described
     * something else entirely.
     */
    const homeless = shots.list.filter((s) => {
      if (!s.prompt) return false;
      const rec = state.records[s.workflowId];
      return !!rec && !promptFieldOf(rec.form, state.promptTargets[s.workflowId]);
    });
    if (homeless.length > 0) {
      setJob({
        phase: 'error',
        error: `Nothing to write the prompt into for: ${homeless.map((s) => s.label).join(', ')}. `
          + 'Open the shot and pick the prompt field under "Prompt goes to", or clear the prompt '
          + 'to run the workflow as it is.',
      });
      return;
    }

    /*
     * Where each shot runs: the Generate button's pick for this batch, else
     * the row of its task in Settings ▸ Resources (video or image), else Auto.
     * Decided by the server, which knows what each resource has; said on the
     * job and kept in job.json.
     */
    if (!useResources.getState().data) await useResources.getState().load();
    const choice = useResources.getState().data?.choice ?? 'default';
    const routes: Array<{ resource: ResourceView; provider: VideoProvider; why: string }> = [];
    try {
      for (const spec of shots.list) {
        const record = state.records[spec.workflowId];
        const res = await resolveRun({
          task: record.inspected.primaryOutputKind === 'video' ? 'video' : 'image',
          override: choice === 'default' ? null : choice, workflowId: record.id, graph: record.api,
        });
        const resource = useResources.getState().data?.resources.find((r) => r.id === res.resource);
        if (!resource) throw new Error(`The server chose "${res.resource}", which this page does not know — reopen Settings.`);
        routes.push({ resource, provider: buildProvider(resource), why: res.why });
      }
    } catch (e) {
      setJob({ phase: 'error', error: e instanceof Error ? e.message : String(e) });
      return;
    }

    let comp: CompInfo | null = null;
    const compResp = await ae.activeComp();
    if (compResp && typeof compResp === 'object' && 'width' in compResp) comp = compResp;
    if (!comp) {
      setJob({ phase: 'error', error: 'No active composition — open the comp you want to fill.' });
      return;
    }

    let root: string;
    let rootInProject: boolean;
    try {
      const resolved = await resolveFlowRoot(state.settings);
      root = resolved.dir;
      rootInProject = resolved.inProject;
    } catch (e) {
      setJob({ phase: 'error', error: e instanceof Error ? e.message : String(e) });
      return;
    }

    cancelledRef.current = false;
    for (let i = 0; i < shots.list.length; i++) {
      if (cancelledRef.current) break;
      const spec = shots.list[i];
      providerRef.current = routes[i].provider;
      await runShot({
        record: useApp.getState().records[spec.workflowId],
        provider: routes[i].provider, resource: routes[i].resource, why: routes[i].why, comp, root, rootInProject,
        spec, batchIndex: i, batchTotal: shots.list.length,
        unsubRef, jobIdRef, cancelledRef,
      });
    }
  };

  const cancel = (): void => {
    cancelledRef.current = true;
    const id = jobIdRef.current;
    const p = providerRef.current;
    if (id && p) void p.cancel(id).catch(() => { /* best effort */ });
    if (unsubRef.current) unsubRef.current();
    useApp.getState().setJob({ phase: 'cancelled', message: 'Stopped.' });
  };

  return { generate, cancel };
}

/* ─── Deciding what to run ──────────────────────────────────────────── */

function buildShots(state: ReturnType<typeof useApp.getState>): { list: ShotSpec[] } | { error: string } {
  const promptFor = (segId: string | null): string =>
    (segId ? state.segmentPrompts[segId] ?? '' : state.playheadPrompt).trim();
  const workflowFor = (segId: string | null): string =>
    (segId ? state.shotWorkflows[segId] : '') || state.activeId;

  if (state.tab === 'storyboard') {
    const selected = state.storyboardSegments
      .filter((s) => state.selectedStoryboardIds.includes(s.id))
      .sort((a, b) => a.startTime - b.startTime);
    if (selected.length === 0) {
      return {
        error: 'No shots ticked. Storyboard shots are the VISIBLE empty adjustment layers — '
          + 'switch an eye back on, then tick at least one.',
      };
    }
    return {
      list: selected.map((seg, i) => ({
        index: i + 1,
        label: seg.label,
        prompt: promptFor(seg.id),
        attachments: state.segmentAttachments[seg.id] ?? [],
        segment: seg,
        anchorTime: seg.startTime,
        durationSeconds: seg.duration,
        workflowId: workflowFor(seg.id),
      })),
    };
  }

  const useSegments = !state.usePlayheadFallback && state.segments.length > 0;
  if (useSegments) {
    const selected = state.segments
      .filter((s) => state.selectedSegmentIds.includes(s.id))
      .sort((a, b) => a.startTime - b.startTime);
    if (selected.length === 0) {
      return { error: 'No segments ticked. Each pair of comp markers is one segment — tick the ones to fill.' };
    }
    return {
      list: selected.map((seg, i) => ({
        index: i + 1,
        label: seg.label,
        prompt: promptFor(seg.id),
        attachments: state.segmentAttachments[seg.id] ?? [],
        segment: seg,
        anchorTime: seg.startTime,
        durationSeconds: seg.duration,
        workflowId: workflowFor(seg.id),
      })),
    };
  }

  return {
    list: [{
      index: 1,
      label: 'Playhead',
      prompt: promptFor(null),
      attachments: state.playheadAttachments,
      segment: null,
      anchorTime: null,
      durationSeconds: 0,
      workflowId: workflowFor(null),
    }],
  };
}

/* ─── Running one shot ──────────────────────────────────────────────── */

interface RunCtx {
  record: WorkflowRecord;
  provider: VideoProvider;
  /** Where it runs, and why there (Settings row, this run's pick, Auto). */
  resource: ResourceView;
  why: string;
  comp: CompInfo;
  root: string;
  rootInProject: boolean;
  spec: ShotSpec;
  batchIndex: number;
  batchTotal: number;
  unsubRef: React.MutableRefObject<(() => void) | null>;
  jobIdRef: React.MutableRefObject<string | null>;
  cancelledRef: React.MutableRefObject<boolean>;
}

function runShot(ctx: RunCtx): Promise<void> {
  return new Promise<void>((resolve) => {
    const { record, provider, resource, comp, spec, batchIndex, batchTotal } = ctx;
    const scaleWithSlot = record.inspected.primaryOutputKind === 'video';
    const slotSeconds = spec.durationSeconds > 0 ? spec.durationSeconds : null;
    const state = useApp.getState();
    const { setJob } = state;
    const tag = batchTotal > 1 ? `[${batchIndex + 1}/${batchTotal}] ` : '';
    const submittedAt = Date.now();

    setJob({
      phase: 'submitting',
      id: null,
      prompt: spec.prompt,
      workflowId: record.id,
      progress: { value: 0, max: 1 },
      message: `${tag}Preparing "${spec.label}"…`,
      previewUrl: null,
      resultPath: null,
      resultIsVideo: record.inspected.primaryOutputKind === 'video',
      error: null,
      startedAt: submittedAt,
      costUsd: null,
      lastEventAt: submittedAt,
      lastEventLabel: 'submitted',
      device: null,
      stage: null,
      resourceId: resource.id,
      resourceLabel: resource.label,
      creditsPerHour: resource.creditsPerHour,
      execStartedAt: null,
      executionMs: null,
      derivedCredits: null,
      costBasis: null,
      timing: null,
      action: null,
    });

    void (async (): Promise<void> => {
      // The estimate shown before launch, kept so job.json can set it against what it cost.
      let estimate: EstimateAnswer['total'] | null = null;
      try {
        estimate = (await estimateRuns({ resource: resource.id, shots: [{ workflowId: record.id, seconds: slotSeconds, scaleWithSlot }] })).total;
      } catch { /* an estimate is a courtesy */ }
      if (!nodeAvailable()) {
        setJob({ phase: 'error', error: 'The JustAE Flow server is not answering — saving assets needs it.' });
        resolve();
        return;
      }

      let shot: ShotFolders;
      try {
        shot = ensureShotFolders(ctx.root, {
          compName: comp.name,
          index: spec.index,
          startSeconds: spec.anchorTime ?? comp.time,
          fps: comp.frameRate,
          label: spec.segment?.source === 'adj' ? spec.label : undefined,
        });
      } catch (e) {
        setJob({ phase: 'error', error: `Could not create the shot folder: ${describe(e)}` });
        resolve();
        return;
      }

      /* 1. Values: the form, then AE on top, then the prompt. */
      const fields = record.form.fields;
      const values: Record<string, string | number | boolean> = { ...(state.values[record.id] ?? {}) };

      const aeCtx: AeContext = {
        width: comp.width,
        height: comp.height,
        fps: comp.frameRate,
        seconds: spec.durationSeconds > 0 ? spec.durationSeconds : undefined,
        maxLongSide: state.settings.pipeline.tier === 'draft' ? state.settings.pipeline.draftLongSide : undefined,
      };
      const auto = state.settings.defaults.aeAutoFill
        ? computeAutoFill(fields, aeCtx)
        : { values: {}, reasons: {} };
      const aeFilled: Record<string, string> = {};
      for (const [fieldId, v] of Object.entries(auto.values)) {
        if (state.unlockedFields.includes(`${record.id}::${fieldId}`)) continue;  // the user took this one over
        values[fieldId] = v;
        aeFilled[fieldId] = auto.reasons[fieldId] ?? 'from the composition';
      }

      const promptField = promptFieldOf(record.form, state.promptTargets[record.id]);
      if (promptField && spec.prompt) values[promptField.id] = spec.prompt;

      // What the comp could not take over for this shot. Recorded with the
      // render rather than only shown in the panel, because "why is this clip
      // short" gets asked long after the panel has been closed.
      const planWarnings = shotPlan(
        record.form, aeCtx, spec.durationSeconds > 0 ? spec.durationSeconds : null,
      ).warnings;

      // The delivery profile: make the workflow's save node lossless (PNG 16 /
      // FFV1) when one is chosen. Applied per submit, never stored, and what
      // could not be applied is kept with the render.
      const profile = outputProfile(state.settings.pipeline.outputProfile);
      let profileSkips: string[] = [];
      if (profile.preset.length) {
        const pr = applyPreset(profile.preset, fields, record.api, values);
        Object.assign(values, pr.values);
        profileSkips = pr.skipped.map((sk) => `Output profile "${profile.label}": ${sk.reason}`);
      }

      const seedField = fields.find((f) => f.aeRole === 'seed');
      if (seedField) {
        values[seedField.id] = state.settings.defaults.seedMode === 'random'
          ? Math.floor(Math.random() * 0xffffffff)
          : state.settings.defaults.fixedSeed;
      }

      /* 2. Attachments: upload, and keep a copy in the shot folder. */
      const manifestInputs: Array<{ field: string; file: string }> = [];
      /**
       * Inputs that are not a filename.
       *
       * Kept beside `values` rather than in it because `values` is the UI's
       * own map of what the user typed — strings, numbers, booleans — and an
       * asset reference is an object the graph needs and no field can show.
       * Applied straight onto the graph once the form values are in.
       */
      const assetRefs = new Map<string, unknown>();
      try {
        for (const att of spec.attachments) {
          const field = fields.find((f) => f.id === att.fieldId);
          if (!field) continue;
          setJob({ message: `${tag}Uploading ${att.filename}…` });
          const blob = readFileAsBlob(att.localPath, mimeForPath(att.localPath));
          const up = await provider.uploadInput(blob, att.filename);
          values[field.id] = up.name;
          if (up.reference !== undefined) assetRefs.set(field.id, up.reference);

          const kept = pathJoin(shot.inputs, basename(att.localPath));
          try { copyFile(att.localPath, kept); } catch { /* already there, or locked */ }
          manifestInputs.push({ field: field.label, file: basename(kept) });
        }
      } catch (e) {
        setJob({ phase: 'error', error: `Upload failed: ${describe(e)}` });
        resolve();
        return;
      }

      const workflow = applyFormValues(record.api, fields, values);
      // No VHS save to switch to FFV1? Add a lossless save beside SaveVideo.
      if (profile.master && profileSkips.length) {
        const ls = addLosslessSave(workflow, 'video/ffv1-mkv', `JustAE/${record.name.replace(/[^\w-]+/g, '_').slice(0, 40)}_master`);
        if (ls.added.length) {
          Object.assign(workflow, ls.workflow);
          profileSkips = [];
        } else {
          profileSkips.push(`Output profile "${profile.label}": ${ls.reason}`);
        }
      }
      planWarnings.push(...profileSkips);
      for (const [fieldId, reference] of assetRefs) {
        const cut = fieldId.lastIndexOf('.');
        const node = workflow[fieldId.slice(0, cut)];
        if (node) node.inputs[fieldId.slice(cut + 1)] = reference as never;
      }
      try { writeWorkflowSnapshot(shot, workflow); } catch { /* non-fatal */ }

      /* 3. Queue it. */
      // The panel's own id, stable for the life of the install — that is what
      // lets the Workflow tab tell our runs apart from the ones the user made
      // in the browser editor. See lib/clientId.ts.
      const wsCtx = { clientId: panelClientId(), meta: { workflowId: record.id, slotSeconds, scaleWithSlot } };
      let jobId: string;
      try {
        setJob({ message: `${tag}Queueing "${spec.label}" on ${resource.label}…` });
        const submitted = await provider.submit(workflow, {
          ...wsCtx,
          onRetry: (n, max, why) => setJob({
            message: `${tag}Server not answering (${why}) — checked the job is not queued, retrying ${n}/${max}…`,
          }),
        });
        jobId = submitted.jobId;
        ctx.jobIdRef.current = jobId;
      } catch (e) {
        // 402 insufficient_credits says what to do about it: run this one locally.
        setJob({ phase: 'error', error: describe(e), action: e instanceof RunError ? e.action ?? null : null });
        resolve();
        return;
      }
      setJob({ id: jobId, phase: 'queued', message: `${tag}Queued on ${provider.label}` });

      /* 4. Follow it. */
      let collected: OutputFile[] = [];
      let finished = false;

      /*
       * How much room is left on the card, while the card is busy.
       *
       * Fifteen seconds, and only until the job ends. It is one small JSON off
       * a server that is already answering /queue twice as often, and it is the
       * number that turns "the bar hasn't moved in an hour" into a diagnosis:
       * measured on a stalled-looking run, 246 MiB free of 16303.
       */
      let deviceTimer: ReturnType<typeof setInterval> | null = null;
      if (typeof provider.deviceStats === 'function') {
        const readDevice = (): void => {
          void provider.deviceStats?.().then((d) => {
            if (!d) return;
            const live = useApp.getState().job;
            if (live.id !== jobId) return;   // a later shot owns the panel now
            useApp.getState().setJob({
              device: { name: d.name, freeBytes: d.vramFreeBytes, totalBytes: d.vramTotalBytes },
            });
          }).catch(() => { /* the meter is never worth an error */ });
        };
        readDevice();
        deviceTimer = setInterval(readDevice, 15_000);
      }
      const stopDeviceTimer = (): void => {
        if (deviceTimer) clearInterval(deviceTimer);
        deviceTimer = null;
      };

      const unsub = provider.watch(jobId, wsCtx, (ev) => {
        const setJ = useApp.getState().setJob;
        // Every word from the server is a heartbeat, whatever it says. This is
        // read by JobProgress to tell a grinding render from a dead one.
        setJ({ lastEventAt: Date.now(), lastEventLabel: ev.kind });
        switch (ev.kind) {
          case 'meter':
            // The server's own account: started executing at, and once done the time and derived credits.
            setJ({
              execStartedAt: ev.startedAt ? Date.parse(ev.startedAt) : null,
              executionMs: ev.executionMs, timing: ev.timing, derivedCredits: ev.derivedCredits, costBasis: ev.costBasis ?? null,
              stage: ev.status === 'queued' ? 'queued' : ev.status === 'running' ? 'running' : useApp.getState().job.stage,
            });
            break;
          case 'queued':
            setJ({ phase: 'queued', message: `${tag}Queued on ${provider.label}` });
            break;
          case 'executing':
            setJ({ phase: 'running', message: `${tag}${ev.nodeId ? nodeLabel(record, ev.nodeId) : 'Running'}` });
            break;
          case 'progress':
            setJ({ phase: 'running', progress: { value: ev.value, max: ev.max } });
            break;
          case 'preview': {
            const url = URL.createObjectURL(ev.blob);
            const prev = useApp.getState().job.previewUrl;
            setJ({ previewUrl: url });
            if (prev) URL.revokeObjectURL(prev);
            break;
          }
          case 'output':
            collected = collected.concat(ev.outputs);
            break;
          case 'done':
            if (finished) break;
            finished = true;
            void finish();
            break;
          case 'error':
            if (finished) break;
            finished = true;
            stopDeviceTimer();
            setJ({ phase: 'error', error: ev.message, message: 'Execution failed' });
            unsub();
            resolve();
            break;
        }
      });
      ctx.unsubRef.current = unsub;

      /* 5. Collect, save, place. */
      async function finish(): Promise<void> {
        const setJ = useApp.getState().setJob;
        const s = useApp.getState().settings;
        stopDeviceTimer();

        let outputs = collected;
        // The completion signal can beat the payload that carries the file
        // list, so give the history endpoint a few chances before concluding
        // there is nothing.
        for (let attempt = 0; attempt < 4 && outputs.length === 0; attempt++) {
          if (attempt > 0) {
            setJ({ message: `${tag}Finishing — waiting for the file list (${attempt}/3)…` });
            await new Promise((r) => setTimeout(r, 2000));
          }
          if (collected.length > 0) { outputs = collected; break; }
          try {
            const fetched = await provider.fetchOutputs(jobId);
            if (fetched.length > 0) { outputs = fetched; break; }
          } catch { /* keep trying */ }
        }

        if (outputs.length === 0) {
          setJ({
            phase: 'error',
            error: 'The job finished but no files came back. Check that the workflow ends in a '
              + 'Save node (SaveImage, SaveVideo, VHS_VideoCombine…) — a Preview-only graph '
              + 'produces nothing to import.',
          });
          unsub();
          resolve();
          return;
        }

        try {
          const saved: Array<{ out: OutputFile; path: string; isVideo: boolean }> = [];
          const capped = outputs.slice(0, 20);
          for (let i = 0; i < capped.length; i++) {
            const out = capped[i];
            setJ({ message: `${tag}Downloading ${i + 1}/${capped.length}…` });
            const blob = await provider.download(out);
            const ext = out.filename.split('.').pop() ?? 'png';
            const suffix = capped.length > 1 ? String(i + 1).padStart(2, '0') : undefined;
            const path = pathJoin(shot.output, defaultOutputName(spec.prompt || spec.label, ext, suffix));
            await writeBlobToFile(blob, path);
            saved.push({ out, path, isVideo: isVideoFile(out.filename) });
          }

          const preferred = pickPrimaryOutput(saved.map((x) => x.out), record.inspected);
          let primary = saved.find((x) => x.out === preferred) ?? saved[saved.length - 1];

          /*
           * The master: from the lossless save (FFV1, 16-bit RGBA), a PNG 16-bit
           * sequence or a ProRes 4444 is made here and imported in place of the
           * preview. Falls back to the preview with a note in job.json.
           */
          let masterNote: string | null = null;
          let seqFps = 0;
          if (profile.master) {
            const lossless = saved.find((x) => LOSSLESS_EXT.test(x.path));
            if (!lossless) {
              masterNote = `Output profile "${profile.label}": no lossless file came back — imported the workflow's own output.`;
            } else {
              const fpsField = fields.find((f) => f.aeRole === 'fps');
              const fpsValue = fpsField ? Number(values[fpsField.id] ?? fpsField.value) : comp.frameRate;
              const fps = fpsValue > 0 ? fpsValue : comp.frameRate;
              setJ({ message: `${tag}Writing the ${profile.master === 'png16' ? 'PNG 16-bit sequence' : 'ProRes 4444 master'}…` });
              const m = profile.master === 'png16' ? await makePng16Sequence(lossless.path) : await makeProRes4444(lossless.path, fps);
              if (m.ok && m.path) {
                primary = { ...lossless, path: m.path, isVideo: true };
                if (profile.master === 'png16') seqFps = fps;
              } else {
                masterNote = m.reason ?? 'master not written';
              }
            }
          }

          /*
           * "Final" (the Featured section): a second job on this result before it is placed — MiniMax H3, then
           * SeedVR2 ×2 — on the same resource, as the Comp tab's ×4 feeds its second pass with the first's result.
           * The draft stays in the shot folder beside it.
           */
          let chain = useApp.getState().chains[record.id];
          let chainNote: string | null = null;
          // Every tool takes the comp's size. A clip its model stopped well below the comp (H3 at 1344 px in a
          // 1920×1080 comp) would be enlarged soft: SeedVR2 ×2 runs on it first, unless a Final chain is set
          // already, the setting is off, or SeedVR2 is not ready where this run went.
          let autoPass = false;
          if (!chain && primary.isVideo && s.defaults.upscaleToComp) {
            const small = belowComp(fields, values, comp);
            if (small) {
              if (seedvr2ReadyOn(resource.id)) { chain = { then: 'seedvr2-upscale', scale: 2 }; autoPass = true; }
              else chainNote = `Placed at ${small.w}×${small.h} in the ${comp.width}×${comp.height} comp, enlarged ${Math.round(small.factor * 100)} %: SeedVR2 is not ready on ${resource.label} (Workflow ▸ Featured ▸ SeedVR2 says what it needs).`;
            }
          }
          if (chain && primary.isVideo) {
            try {
              if (chain.then === 'ltx25-refine') {
                // The Matt Hallett pipeline: the H3 result, then LTX-2.5 Refine Details on it (local only: the models are there).
                if (resource.kind !== 'local') throw new Error(`LTX Refine runs on your local ComfyUI, and this run went to ${resource.label}.`);
                const up = await runLtxRefine(provider, primary.path, shot.output, (m) => setJ({ message: `${tag}${m}` }), {
                  ...wsCtx, meta: { workflowId: chain.then, slotSeconds, scaleWithSlot: true },
                });
                primary = { ...primary, path: up.path };
                chainNote = `Final: LTX Refine to ${up.size} on the draft (job ${up.jobId}); the PNG 16-bit master is ${up.master}; the draft is ${basename(saved.find((x) => x.isVideo)?.path ?? '')}.`;
              } else {
                const up = await runChained(provider, chain, primary.path, shot.output, (m) => setJ({ message: `${tag}${m}` }), {
                  ...wsCtx, meta: { workflowId: chain.then, slotSeconds, scaleWithSlot: true },
                });
                primary = { ...primary, path: up.path };
                chainNote = `${autoPass ? 'Upscaled to the comp size' : 'Final'}: ${chain.then} ×${chain.scale} on the ${autoPass ? 'result' : 'draft'} (job ${up.jobId}); the ${autoPass ? 'first result' : 'draft'} is ${basename(saved.find((x) => x.isVideo)?.path ?? '')}.`;
              }
            } catch (e) {
              chainNote = `${autoPass ? 'Upscale to the comp size' : 'Final'}: the second step (${chain.then}) failed — placed the ${autoPass ? 'result as it came' : 'draft'}. ${describe(e)}`;
            }
          }

          setJ({ resultPath: primary.path, resultIsVideo: primary.isVideo, message: `${tag}Saved · placing…` });

          if (s.defaults.autoImport) {
            // Into the comp that was active when Generate was pressed, not whichever is open now (25 Oct: an image
            // landed in another comp the user opened during the 30 s of generation).
            const placed = await place(primary, spec, s.defaults.fitMode, seqFps, comp.id ?? 0);
            if (placed) { setJ({ phase: 'error', error: placed }); unsub(); resolve(); return; }
          }

          /*
           * What it took. On Comfy API v2 the server reported the execution
           * time and derived the credits from it; on a local ComfyUI the time
           * comes from its history (execution_start → execution_success).
           * Derived, never billed: no endpoint returns the cost of a job.
           */
          const wallMs = Date.now() - submittedAt;
          const live = useApp.getState().job;
          const executionMs = live.executionMs ?? (await provider.executionMs?.(jobId).catch(() => null)) ?? null;
          const derivedCredits = resource.creditsPerHour === null ? null
            : live.derivedCredits ?? (executionMs !== null ? (executionMs / 3_600_000) * resource.creditsPerHour : null);
          setJ({ executionMs, derivedCredits, timing: live.executionMs !== null ? live.timing : executionMs !== null ? 'history' : null });
          // v2 runs are in the server's history already; a local run is reported, for the next estimate.
          if (resource.kind === 'local') void reportRun({ workflowId: record.id, resourceId: resource.id, wallMs, executionMs, slotSeconds, scaleWithSlot, jobId });
          // The balance is read again after a job that bills; the billing report follows invoices, so it may not move yet.
          if (resource.creditsPerHour !== null) void useResources.getState().loadCredits(true);

          const manifest: JobManifest = {
            generatedAt: new Date().toISOString(),
            comp: { name: comp.name, width: comp.width, height: comp.height, fps: comp.frameRate },
            shot: {
              index: spec.index,
              label: spec.label,
              startSeconds: spec.anchorTime ?? comp.time,
              endSeconds: (spec.anchorTime ?? comp.time) + spec.durationSeconds,
              durationSeconds: spec.durationSeconds,
              source: spec.segment ? (spec.segment.source === 'adj' ? 'placeholder' : 'marker') : 'playhead',
            },
            workflow: {
              id: record.id, name: record.name, origin: record.origin,
              ref: record.ref, formSource: record.form.source,
            },
            provider: {
              id: provider.id,
              label: provider.label,
              gpu: resource.gpuLabel ?? undefined,
            },
            resource: {
              id: resource.id, kind: resource.kind, label: resource.label, why: ctx.why,
              gpu: resource.gpuLabel, creditsPerHour: resource.creditsPerHour,
            },
            executionMs,
            derivedCredits,
            values,
            aeFilled,
            promptField: promptField ? `${promptField.nodeId}.${promptField.field}` : null,
            warnings: planWarnings.length > 0 ? planWarnings : undefined,
            inputs: manifestInputs,
            outputs: saved.map((x) => ({
              file: basename(x.path), nodeId: x.out.nodeId, bucket: x.out.bucket,
            })),
            timing: {
              submittedAt: new Date(submittedAt).toISOString(),
              finishedAt: new Date().toISOString(),
              seconds: Math.round((Date.now() - submittedAt) / 100) / 10,
            },
            jobId,
            notes: record.problems.length > 0 || masterNote || chainNote
              ? [...record.problems, ...(masterNote ? [masterNote] : []), ...(chainNote ? [chainNote] : [])]
              : undefined,
            outputProfile: profile.id !== 'as-workflow' ? profile.id : undefined,
            tier: state.settings.pipeline.tier,
            cost: resource.creditsPerHour !== null || estimate
              ? {
                  derivedCredits,
                  basis: resource.creditsPerHour !== null ? `(${live.costBasis ?? 'GPU time of the job'}) × rate (≈), not a billed amount` : 'your own GPU: no credits',
                  gpuSeconds: executionMs !== null ? executionMs / 1000 : null,
                  gpu: resource.gpuLabel,
                  estimatedCredits: estimate && estimate.creditsLow !== null ? [estimate.creditsLow, estimate.creditsHigh] : null,
                  estimateBasis: estimate ? estimate.basis : null,
                  estimateText: estimate?.text ?? null,
                }
              : undefined,
          };
          try { writeJobManifest(shot, manifest); } catch { /* non-fatal */ }

          const last = batchIndex + 1 === batchTotal;
          setJ({
            phase: last ? 'done' : 'running',
            message: batchTotal > 1
              ? (last ? `Done — ${batchTotal} clips placed` : `${tag}Done · next…`)
              : 'Done',
            progress: { value: 1, max: 1 },
          });

          const entry: HistoryEntry = {
            id: jobId,
            prompt: spec.prompt,
            workflowId: record.id,
            workflowLabel: record.name,
            providerId: provider.id,
            resultPath: primary.path,
            resultIsVideo: primary.isVideo,
            shotFolder: shot.root,
            createdAt: Date.now(),
            resourceId: resource.id,
            resourceLabel: resource.label,
            credits: derivedCredits,
            seconds: Math.round((executionMs ?? wallMs) / 100) / 10,
          };
          useApp.getState().pushHistory(entry);

          /*
           * Remember what this cost, so the next shot can be warned.
           *
           * Only on the way out of a SUCCESS, and only when the shot had a real
           * slot — a playhead clip has no length to compare against. See
           * RunCost in the store for the measurements that make this worth
           * keeping.
           */
          if (spec.durationSeconds > 0) {
            useApp.getState().recordRunCost(record.id, resource.id, {
              slotSeconds: spec.durationSeconds,
              renderSeconds: Math.round(wallMs / 1000),
              at: Date.now(),
              gpuSeconds: executionMs !== null ? executionMs / 1000 : undefined,
              gpu: resource.gpuLabel ?? undefined,
            });
          }
        } catch (e) {
          setJ({ phase: 'error', error: describe(e) });
        } finally {
          unsub();
          resolve();
        }
      }
    })();
  });
}

/**
 * Put the clip on the timeline.
 *
 * A generated clip is never stretched to fill its slot: if it came back
 * shorter than the gap between the markers, it stays its own length and the
 * gap stays visible. Stretching would be a quality change the user didn't ask
 * for and wouldn't see until they looked closely.
 */
async function place(
  primary: { path: string; isVideo: boolean },
  spec: ShotSpec,
  fitMode: FitMode,
  seqFps = 0,
  compId = 0,
): Promise<string | null> {
  const layerName = layerNameFromPrompt(spec.prompt || spec.label);
  const isPlaceholder = spec.segment?.source === 'adj';
  const labelColor = isPlaceholder ? (spec.segment?.labelColor ?? 0) : 0;

  const resp = spec.anchorTime !== null
    ? await ae.insertVideoAtTime(primary.path, spec.anchorTime, layerName, fitMode, labelColor, seqFps, compId)
    : primary.isVideo
      ? await ae.importVideo(primary.path, layerName, fitMode, seqFps, compId)
      : await ae.importImage(primary.path, layerName, 5, fitMode, compId);

  if (isErr(resp)) return `Saved to disk, but placing it failed: ${resp.error}`;

  if (spec.segment && spec.durationSeconds > 0 && resp.layerIndex) {
    // Trim to the slot when the clip overruns it — an out-point cut, lossless.
    const generated = resp.duration ?? spec.durationSeconds;
    const trimTo = Math.min(spec.durationSeconds, generated);
    if (trimTo > 0 && generated > spec.durationSeconds + 0.001) {
      try { await ae.trimLayerDuration(resp.layerIndex, trimTo, compId); } catch { /* non-fatal */ }
    }
  }
  if (isPlaceholder && spec.segment?.layerName) {
    // The placeholder has been filled; switch its eye off rather than delete it,
    // so the user can bring it back and regenerate.
    try { await ae.disableAdjustmentLayer(spec.segment.layerName, spec.segment.startTime, compId); } catch { /* non-fatal */ }
  }
  return null;
}

/* ─── The Final step of a Featured workflow ─────────────────────────── */

/**
 * SeedVR2 ×N on a result, as a job of its own: the server's bundled graph (official template
 * utility_seedvr2_3b_int8_upscale_video), the result uploaded as its video, the colours kept with SeedVR2's own
 * "wavelet" correction (measured closest to the original, core/comp/tools.ts KEEP_COLOUR_DEFAULT), 8-bit output
 * (EffectCraft decodes 8-bit H.264 only). Written beside the draft as "<name>_x2.mp4".
 */
/**
 * The generated size against the comp's: the width and height the run used (the comp's, scaled to the model's cap
 * and rounded), and how much the comp would enlarge the clip. Below 15 % the fill is not worth a second job.
 */
function belowComp(
  fields: FormField[], values: Record<string, string | number | boolean>, comp: { width: number; height: number },
): { w: number; h: number; factor: number } | null {
  const num = (role: 'width' | 'height'): number | null => {
    const f = fields.find((x) => x.aeRole === role);
    if (!f) return null;
    const v = Number(values[f.id] ?? f.value);
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  const w = num('width');
  const h = num('height');
  if (!w || !h || !comp.width || !comp.height) return null;
  const factor = Math.max(comp.width / w, comp.height / h);
  return factor > 1.15 ? { w, h, factor } : null;
}

/** Is the SeedVR2 preset ready on this resource, as far as the readiness probe knows? Unknown counts as ready: the run says otherwise. */
function seedvr2ReadyOn(resourceId: string): boolean {
  const e = useReadiness.getState().data?.entries.find((x) => x.id === 'seedvr2-upscale');
  if (!e) return true;
  const status = resourceId === 'local' ? e.local.status
    : e.on?.id === resourceId ? e.status
      : e.elsewhere.find((x) => x.id === resourceId)?.status ?? 'unknown';
  return status === 'ready' || status === 'unknown';
}

async function runChained(
  provider: VideoProvider, chain: { then: string; scale: number }, file: string, dir: string,
  say: (m: string) => void, ctx: { clientId: string; meta: { workflowId: string; slotSeconds: number | null; scaleWithSlot: boolean } },
): Promise<{ path: string; jobId: string }> {
  const r = await fetch(`/api/featured/${encodeURIComponent(chain.then)}/graph`, { headers: serverHeaders() });
  if (!r.ok) throw new Error(`the server has no "${chain.then}" graph (HTTP ${r.status})`);
  const graph = await r.json() as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
  say(`Final: uploading the draft for ${chain.then} ×${chain.scale}…`);
  const up = await provider.uploadInput(readFileAsBlob(file, mimeForPath(file)), basename(file));
  for (const n of Object.values(graph)) {
    if (n.class_type === 'LoadVideo') n.inputs.file = up.reference ?? up.name;
    if (n.class_type === 'ResizeImageMaskNode' && 'resize_type.multiplier' in n.inputs) n.inputs['resize_type.multiplier'] = chain.scale;
    if (n.class_type === 'SeedVR2PostProcessing') n.inputs.color_correction_method = 'wavelet';
    if (n.class_type === 'CreateVideo') n.inputs.bit_depth = 8;
  }
  const { jobId } = await provider.submit(graph as never, ctx);
  say(`Final: ${chain.then} ×${chain.scale} queued…`);
  const outputs = await new Promise<OutputFile[]>((resolve, reject) => {
    let got: OutputFile[] = [];
    const stop = provider.watch(jobId, ctx, (ev) => {
      if (ev.kind === 'progress') say(`Final: ${chain.then} ×${chain.scale} · ${Math.round(ev.value)}/${Math.round(ev.max)}`);
      if (ev.kind === 'output') got = got.concat(ev.outputs);
      if (ev.kind === 'done') { stop(); resolve(got); }
      if (ev.kind === 'error') { stop(); reject(new Error(ev.message)); }
    });
  });
  const all = outputs.length ? outputs : await provider.fetchOutputs(jobId);
  const out = all.filter((o) => isVideoFile(o.filename)).pop();
  if (!out) throw new Error(`${chain.then} finished without a video`);
  const path = pathJoin(dir, basename(file).replace(/\.[^.]+$/, '') + `_x${chain.scale}.${out.filename.split('.').pop() ?? 'mp4'}`);
  await writeBlobToFile(await provider.download(out), path);
  return { path, jobId };
}

/**
 * LTX Refine on a result, as a job of its own on the local ComfyUI: the server plans it from the file itself
 * (POST /api/finishing/graph — the Tiled Fusion planner and graph of core/finishing, checked against the local
 * catalogue), the file goes up into its LoadVideo, and two things come back: an 8-bit MP4 (placed, as every result)
 * and the 16-bit PNG frames (the master), written beside the draft as "<name>_ltx-fhd.mp4" and "<name>_ltx-fhd_png16/".
 */
async function runLtxRefine(
  provider: VideoProvider, file: string, dir: string,
  say: (m: string) => void, ctx: { clientId: string; meta: { workflowId: string; slotSeconds: number | null; scaleWithSlot: boolean } },
): Promise<{ path: string; jobId: string; master: string; size: string }> {
  const r = await fetch('/api/finishing/graph', { method: 'POST', headers: { ...serverHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ file, size: 'fhd' }) });
  const d = await r.json() as {
    error?: string; graph: Record<string, { class_type: string; inputs: Record<string, unknown> }>; loadNode: string; saveNode: string; previewNode: string;
    plan: { delivery: { w: number; h: number } | null; tiles: number | null }; estimate: { line: string };
  };
  if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
  // Sizes and tiles are the LTX pack's (LTXVGetTilingSizes); when the local ComfyUI could not say them yet, they come at run time.
  const size = d.plan.delivery ? `${d.plan.delivery.w}×${d.plan.delivery.h}` : 'Full HD (the LTX pack sets the size)';
  say(`Final: uploading the draft for LTX Refine to ${size} (${d.plan.tiles ?? 'the pack’s'} tiles; ${d.estimate.line.split(' (')[0]})…`);
  const up = await provider.uploadInput(readFileAsBlob(file, mimeForPath(file)), basename(file));
  d.graph[d.loadNode].inputs.file = up.reference ?? up.name;
  const { jobId } = await provider.submit(d.graph as never, ctx);
  say('Final: LTX Refine queued…');
  const outputs = await new Promise<OutputFile[]>((resolve, reject) => {
    let got: OutputFile[] = [];
    const stop = provider.watch(jobId, ctx, (ev) => {
      if (ev.kind === 'progress') say(`Final: LTX Refine · ${Math.round(ev.value)}/${Math.round(ev.max)}`);
      if (ev.kind === 'output') got = got.concat(ev.outputs);
      if (ev.kind === 'done') { stop(); resolve(got); }
      if (ev.kind === 'error') { stop(); reject(new Error(ev.message)); }
    });
  });
  const all = outputs.length ? outputs : await provider.fetchOutputs(jobId);
  const mp4 = all.filter((o) => o.nodeId === d.previewNode && isVideoFile(o.filename)).pop();
  if (!mp4) throw new Error('LTX Refine finished without its MP4');
  const stem = basename(file).replace(/\.[^.]+$/, '') + '_ltx-fhd';
  const path = pathJoin(dir, `${stem}.mp4`);
  await writeBlobToFile(await provider.download(mp4), path);
  const frames = all.filter((o) => o.nodeId === d.saveNode && /\.png$/i.test(o.filename)).sort((a, b) => a.filename.localeCompare(b.filename));
  const master = pathJoin(dir, `${stem}_png16`);
  ensureDir(master);
  for (let i = 0; i < frames.length; i++) {
    if (i % 8 === 0) say(`Final: the PNG 16-bit master, frame ${i + 1}/${frames.length}…`);
    await writeBlobToFile(await provider.download(frames[i]), pathJoin(master, `${stem}_${String(i).padStart(5, '0')}.png`));
  }
  return { path, jobId, master, size };
}

/* ─── small helpers ─────────────────────────────────────────────────── */

function isVideoFile(filename: string): boolean {
  return /\.(mp4|mov|webm|mkv|avi|m4v|gif|webp)$/i.test(filename);
}

function nodeLabel(record: WorkflowRecord, nodeId: string): string {
  const node = record.api[nodeId];
  const title = node?._meta?.title ?? node?.class_type;
  return title ? `Running ${title}` : `Running node ${nodeId}`;
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
