/**
 * Save the shot list to a file, and put it back.
 *
 * The Save half is trivial. The Load half is the whole feature, and it is not
 * a button — it is a review. `state/setupFile.ts` explains why the slots in a
 * comp cannot be identified by id and have to be matched again from where they
 * are and what they are called; the consequence lives here, on screen: the
 * panel shows what it matched and HOW before it changes anything, and the user
 * presses Apply or walks away.
 *
 * Applying quietly was the tempting version and it is the dangerous one. A
 * prompt restored onto the wrong shot does not look wrong: it looks like a
 * filled-in row, and the mistake surfaces an hour later as a clip describing
 * somebody else's scene.
 */

import { useState } from 'react';
import { useApp } from '../state/store';
import type { Segment } from '../state/segments';
import {
  buildSetup, describePlan, matchSetup, parseSetup,
  type MatchKind, type MatchPlan, type SetupFile, type SetupWorkflow,
} from '../state/setupFile';
import { ae, isErr, type CompInfo } from '../bridge/extendscript';
import { fileExists, nodeAvailable, readTextFile, writeTextFile } from '../lib/fs';

interface Props {
  mode: 'marker' | 'storyboard';
  segments: Segment[];
  comp: CompInfo | null;
}

/** What the review is holding while the user decides. */
interface Pending {
  setup: SetupFile;
  plan: MatchPlan;
  path: string;
}

const HOW: Record<MatchKind, { label: string; tone: string; why: string }> = {
  exact: { label: 'exact', tone: 'text-ok', why: 'Same start and same length.' },
  name: { label: 'by name', tone: 'text-ink-dim', why: 'The name matches but the slot has moved.' },
  time: { label: 'by time', tone: 'text-ink-dim', why: 'It starts at the same moment but has been renamed or resized.' },
  ordinal: {
    label: 'by position',
    tone: 'text-warn',
    why: 'Nothing about this shot matched — it was paired by its place in the list, '
      + 'because both lists are the same length. Worth checking.',
  },
};

export function SetupBar({ mode, segments, comp }: Props): JSX.Element | null {
  /*
   * Read the store field by field rather than whole.
   *
   * `useApp()` with no selector re-renders on every change, and while a job is
   * running the job slice changes once a second — this bar would repaint under
   * the user's cursor for no reason. The write side goes through
   * `useApp.getState()` inside the handlers, which needs no subscription at all.
   */
  const selectedSegmentIds = useApp((s) => s.selectedSegmentIds);
  const selectedStoryboardIds = useApp((s) => s.selectedStoryboardIds);
  const library = useApp((s) => s.library);
  const applySetupAction = useApp((s) => s.applySetup);

  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);

  if (segments.length === 0 && !pending) return null;

  const selectedIds = mode === 'storyboard' ? selectedStoryboardIds : selectedSegmentIds;

  const compForFile = comp
    ? { name: comp.name, width: comp.width, height: comp.height, fps: comp.frameRate }
    : null;

  const save = async (): Promise<void> => {
    if (!nodeAvailable()) { setNote('Saving a setup needs the JustAE Flow server.'); return; }
    setBusy(true);
    setNote(null);
    try {
      /*
       * Only the workflows these shots name, and only what the user changed on
       * them — see buildSetup. `values` is per workflow and shared across every
       * shot using it, which is why it is stored once here rather than copied
       * onto each row.
       */
      const s = useApp.getState();
      const workflows: Record<string, SetupWorkflow> = {};
      for (const seg of segments) {
        const id = s.shotWorkflows[seg.id] || s.activeId;
        if (!id || workflows[id]) continue;
        workflows[id] = {
          values: s.values[id] ?? {},
          promptTarget: s.promptTargets[id],
          fieldPrefs: s.fieldPrefs[id],
        };
      }

      const setup = buildSetup({
        mode,
        comp: compForFile,
        segments,
        selectedIds,
        prompts: s.segmentPrompts,
        attachments: s.segmentAttachments,
        // Rows following the default still record WHICH workflow that was, so
        // the setup restores what actually ran rather than what happens to be
        // selected the day it is loaded.
        shotWorkflows: Object.fromEntries(
          segments.map((seg) => [seg.id, s.shotWorkflows[seg.id] || s.activeId]),
        ),
        workflows,
      });

      const suggestion = `${(comp?.name ?? mode).replace(/[^A-Za-z0-9._-]+/g, '-')}-setup.json`;
      const dir = await ae.projectDir();
      const chosen = await ae.pickSetupSavePath(
        suggestion,
        !isErr(dir) && dir.path ? dir.path : null,
      );
      if (isErr(chosen)) { setNote(chosen.error); return; }
      if (!chosen.path) return;   // cancelled — not a failure

      writeTextFile(chosen.path, JSON.stringify(setup, null, 2));
      setNote(`Saved ${setup.shots.length} shot(s) to ${chosen.path}`);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const load = async (): Promise<void> => {
    if (!nodeAvailable()) { setNote('Loading a setup needs the JustAE Flow server.'); return; }
    setBusy(true);
    setNote(null);
    try {
      const dir = await ae.projectDir();
      const chosen = await ae.pickSetupOpenPath(!isErr(dir) && dir.path ? dir.path : null);
      if (isErr(chosen)) { setNote(chosen.error); return; }
      if (!chosen.path) return;

      const parsed = parseSetup(readTextFile(chosen.path));
      if ('error' in parsed) { setNote(parsed.error); return; }

      const plan = matchSetup(parsed.setup, segments, comp?.frameRate, {
        knownWorkflows: new Set(library.map((w) => w.id)),
        fileExists,
      });
      setPending({ setup: parsed.setup, plan, path: chosen.path });
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const apply = (): void => {
    if (!pending) return;
    /*
     * A row may not point at a workflow that is no longer there.
     *
     * `buildShots` refuses to run a shot whose workflow has not been read, and
     * one that is not in the library never will be — so restoring the dead id
     * would leave that row permanently unrunnable behind a message about
     * "still reading the workflow". Clearing it puts the row back on the
     * default, which is what an empty override means, and the review above
     * names the ones this happened to.
     */
    const gone = new Set(pending.plan.missingWorkflows);
    applySetupAction({
      mode,
      shots: pending.plan.matched.map((m) => ({
        segmentId: m.segment.id,
        prompt: m.shot.prompt,
        attachments: m.shot.attachments,
        workflowId: gone.has(m.shot.workflowId) ? '' : m.shot.workflowId,
        selected: m.shot.selected,
      })),
      workflows: pending.setup.workflows,
    });
    setNote(`Restored ${pending.plan.matched.length} shot(s).`);
    setPending(null);
  };

  const mismatchedComp = pending?.setup.comp && comp
    && (pending.setup.comp.name !== comp.name
      || Math.abs(pending.setup.comp.fps - comp.frameRate) > 0.01
      || pending.setup.comp.width !== comp.width
      || pending.setup.comp.height !== comp.height)
    ? pending.setup.comp
    : null;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="section-label">Setup</span>
        <div className="flex items-center gap-1">
          <button
            className="chip"
            disabled={busy || segments.length === 0}
            onClick={() => void save()}
            title="Write these prompts, inputs and per-shot workflows to a .json you can keep"
          >
            Save setup…
          </button>
          <button
            className="chip"
            disabled={busy}
            onClick={() => void load()}
            title="Read a saved setup back and match it against the shots in this comp"
          >
            Load setup…
          </button>
        </div>
      </div>

      {note && <p className="text-[10px] leading-snug text-ink-mute">{note}</p>}

      {pending && (
        <section className="space-y-2 rounded-lg border border-brand/50 bg-bg-raised p-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-ink">
              {describePlan(pending.plan)}
            </span>
            <div className="flex shrink-0 items-center gap-1">
              <button
                className="chip"
                onClick={apply}
                disabled={pending.plan.matched.length === 0}
              >
                Apply
              </button>
              <button className="chip" onClick={() => setPending(null)}>Cancel</button>
            </div>
          </div>

          {mismatchedComp && (
            <p className="rounded-lg border border-warn/40 bg-warn/10 px-2.5 py-1.5 text-[10px] leading-snug text-ink">
              This setup was made in <span className="font-mono">{mismatchedComp.name}</span> at{' '}
              {mismatchedComp.width}×{mismatchedComp.height} @{mismatchedComp.fps}fps, and this comp
              is <span className="font-mono">{comp?.name}</span> at {comp?.width}×{comp?.height} @
              {comp?.frameRate}fps. The prompts still fit; the slot times may not line up.
            </p>
          )}

          <ul className="max-h-52 space-y-0.5 overflow-y-auto">
            {pending.plan.matched.map((m) => (
              <li key={m.segment.id} className="flex items-center gap-2 text-[10px]">
                <span className={`w-[62px] shrink-0 font-mono ${HOW[m.how].tone}`} title={HOW[m.how].why}>
                  {HOW[m.how].label}
                </span>
                <span className="shrink-0 truncate text-ink-dim">{m.segment.label}</span>
                <span className="min-w-0 flex-1 truncate text-ink-mute">
                  {m.shot.prompt || '(no prompt)'}
                </span>
              </li>
            ))}
            {pending.plan.orphans.map((o) => (
              <li key={`orphan-${o.ordinal}`} className="flex items-center gap-2 text-[10px]">
                <span className="w-[62px] shrink-0 font-mono text-err">no slot</span>
                <span className="shrink-0 truncate text-ink-dim">{o.identity.label}</span>
                <span className="min-w-0 flex-1 truncate text-ink-mute">
                  {o.slot.start.toFixed(2)}s · {o.slot.duration.toFixed(2)}s long
                </span>
              </li>
            ))}
          </ul>

          {pending.plan.missingWorkflows.length > 0 && (
            <p className="text-[10px] leading-snug text-warn">
              Not in the library any more, so those rows go back to the default workflow instead:{' '}
              {pending.plan.missingWorkflows.join(', ')}
            </p>
          )}
          {pending.plan.missingFiles.length > 0 && (
            <p className="text-[10px] leading-snug text-warn">
              {pending.plan.missingFiles.length} attached file(s) are no longer on disk. They are
              restored as references so you can see what was there, but they will not upload:{' '}
              {pending.plan.missingFiles.slice(0, 3).join(', ')}
              {pending.plan.missingFiles.length > 3 ? '…' : ''}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
