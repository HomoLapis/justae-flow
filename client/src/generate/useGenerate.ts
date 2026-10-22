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
import type { CostEstimate } from '../lib/costEstimate';
import { outputProfile } from '../pipeline/catalog';
import { applyPreset } from '../pipeline/apply';
import { makeProRes4444, makePng16Sequence } from '../lib/master';
import { addLosslessSave, LOSSLESS_EXT } from '../pipeline/losslessSave';
import type { Segment } from '../state/segments';
import { buildProvider } from '../providers/registry';
import type { OutputFile, VideoProvider } from '../providers/types';
import {
  applyFormValues, computeAutoFill, promptFieldOf, shotPlan, type AeContext,
} from '../workflows/form';
import { pickPrimaryOutput } from '../workflows/inspector';
import type { WorkflowRecord } from '../workflows/library';
import { defaultOutputName, layerNameFromPrompt } from '../lib/filenames';
import { panelClientId } from '../lib/clientId';
import {
  nodeAvailable, writeBlobToFile, pathJoin, copyFile, basename,
  readFileAsBlob, mimeForPath,
} from '../lib/fs';
import {
  resolveFlowRoot, ensureShotFolders, writeJobManifest, writeWorkflowSnapshot,
  type JobManifest, type ShotFolders,
} from '../lib/assets';
import { ae, isErr, type CompInfo, type FitMode } from '../bridge/extendscript';

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

    let provider: VideoProvider;
    try {
      provider = buildProvider(state.settings.provider, {
        comfyCloud: { apiKey: state.settings.comfyCloudApiKey },
        localComfy: { url: state.settings.localComfyUrl },
        comfyV2: { url: state.settings.comfyV2Url, token: state.settings.comfyV2Token },
      });
    } catch (e) {
      setJob({ phase: 'error', error: e instanceof Error ? e.message : String(e) });
      return;
    }
    providerRef.current = provider;

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
      await runShot({
        record: useApp.getState().records[spec.workflowId],
        provider, comp, root, rootInProject,
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
    const { record, provider, comp, spec, batchIndex, batchTotal } = ctx;
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
    });

    void (async (): Promise<void> => {
      // The estimate shown before launch, kept so job.json can set it against what was billed.
      const estimate: CostEstimate | null = null;
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
      const wsCtx = { clientId: panelClientId() };
      let jobId: string;
      try {
        setJob({ message: `${tag}Queueing "${spec.label}"…` });
        const submitted = await provider.submit(workflow, {
          ...wsCtx,
          onRetry: (n, max, why) => setJob({
            message: `${tag}Server not answering (${why}) — checked the job is not queued, retrying ${n}/${max}…`,
          }),
        });
        jobId = submitted.jobId;
        ctx.jobIdRef.current = jobId;
      } catch (e) {
        setJob({ phase: 'error', error: describe(e) });
        resolve();
        return;
      }
      setJob({ id: jobId, phase: 'queued', message: `${tag}Queued on ${provider.label}` });

      /* 4. Follow it. */
      let collected: OutputFile[] = [];
      let finished = false;
      let costTimer: ReturnType<typeof setInterval> | null = null;

      // What the backend billed, when it says (none of the backends here does yet).
      const billed: { usd: number | null; gpuSeconds: number | null; gpu: string | null } = { usd: null, gpuSeconds: null, gpu: null };
      const stopCostTimer = (): void => { if (costTimer) clearInterval(costTimer); costTimer = null; };

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
            stopCostTimer();
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
        stopCostTimer();
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

          setJ({ resultPath: primary.path, resultIsVideo: primary.isVideo, message: `${tag}Saved · placing…` });

          if (s.defaults.autoImport) {
            const placed = await place(primary, spec, s.defaults.fitMode, seqFps);
            if (placed) { setJ({ phase: 'error', error: placed }); unsub(); resolve(); return; }
          }

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
              gpu: undefined,
            },
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
            notes: record.problems.length > 0 || masterNote
              ? [...record.problems, ...(masterNote ? [masterNote] : [])]
              : undefined,
            outputProfile: profile.id !== 'as-workflow' ? profile.id : undefined,
            tier: state.settings.pipeline.tier,
            cost: billed.usd !== null || estimate
              ? {
                  usd: billed.usd,
                  gpuSeconds: billed.gpuSeconds,
                  gpu: billed.gpu,
                  estimatedUsd: estimate && estimate.usdLow !== null ? [estimate.usdLow, estimate.usdHigh] : null,
                  estimateBasis: estimate ? estimate.basis : null,
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
            costUsd: billed.usd ?? undefined,
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
            useApp.getState().recordRunCost(record.id, provider.id, {
              slotSeconds: spec.durationSeconds,
              renderSeconds: Math.round((Date.now() - submittedAt) / 1000),
              at: Date.now(),
              costUsd: billed.usd ?? undefined,
              gpuSeconds: billed.gpuSeconds ?? undefined,
              gpu: billed.gpu ?? undefined,
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
): Promise<string | null> {
  const layerName = layerNameFromPrompt(spec.prompt || spec.label);
  const isPlaceholder = spec.segment?.source === 'adj';
  const labelColor = isPlaceholder ? (spec.segment?.labelColor ?? 0) : 0;

  const resp = spec.anchorTime !== null
    ? await ae.insertVideoAtTime(primary.path, spec.anchorTime, layerName, fitMode, labelColor, seqFps)
    : primary.isVideo
      ? await ae.importVideo(primary.path, layerName, fitMode, seqFps)
      : await ae.importImage(primary.path, layerName, 5, fitMode);

  if (isErr(resp)) return `Saved to disk, but placing it failed: ${resp.error}`;

  if (spec.segment && spec.durationSeconds > 0 && resp.layerIndex) {
    // Trim to the slot when the clip overruns it — an out-point cut, lossless.
    const generated = resp.duration ?? spec.durationSeconds;
    const trimTo = Math.min(spec.durationSeconds, generated);
    if (trimTo > 0 && generated > spec.durationSeconds + 0.001) {
      try { await ae.trimLayerDuration(resp.layerIndex, trimTo); } catch { /* non-fatal */ }
    }
  }
  if (isPlaceholder && spec.segment?.layerName) {
    // The placeholder has been filled; switch its eye off rather than delete it,
    // so the user can bring it back and regenerate.
    try { await ae.disableAdjustmentLayer(spec.segment.layerName, spec.segment.startTime); } catch { /* non-fatal */ }
  }
  return null;
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
