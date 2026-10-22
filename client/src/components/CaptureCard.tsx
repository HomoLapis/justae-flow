/**
 * "Use the graph ComfyUI actually ran."
 *
 * The panel converts the editor format itself, and on real workflows that
 * conversion is not reliable enough to stake a render on — bypassed and muted
 * nodes are where it breaks, and those are everywhere in workflows people
 * actually use. ComfyUI does the same job correctly every time it runs one, and
 * keeps the result. This is the button that goes and gets it.
 *
 * The flow is: pick the workflow here, open it in the browser editor, press Run
 * once, come back. The panel reads the server's history, compares what ran to
 * what it has, and offers to adopt it.
 *
 * Nothing here guesses which workflow a run belongs to — see capture.ts for why
 * the file's own id cannot be trusted for that. The user's selection is the
 * claim; this component's job is to check it out loud before acting on it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RecentRun, VideoProvider } from '../providers/types';
import type { WorkflowRecord } from '../workflows/library';
import {
  captureFor, compareGraphs, describeRun, forgetCapture, pickRunToOffer, rememberCapture,
  type GraphComparison, type RunDescription,
} from '../workflows/capture';
import { panelClientId } from '../lib/clientId';
import { resolveFlowRoot } from '../lib/assets';
import { useApp } from '../state/store';

interface Found {
  run: RecentRun;
  described: RunDescription;
  comparison: GraphComparison | null;
}

export function CaptureCard({
  provider,
  active,
  onAdopted,
}: {
  provider: VideoProvider | null;
  active: WorkflowRecord | null;
  onAdopted: () => Promise<void> | void;
}): JSX.Element | null {
  const settings = useApp((s) => s.settings);
  const editorOpened = useApp((s) => s.editorOpened);

  const [found, setFound] = useState<Found | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Existing capture, re-read after every change so the card never lies. */
  const [existing, setExisting] = useState(() => (active ? captureFor(active.id) : null));

  useEffect(() => { setExisting(active ? captureFor(active.id) : null); setFound(null); }, [active]);

  const canCapture = typeof provider?.recentRuns === 'function';

  const check = useCallback(async (quiet: boolean): Promise<void> => {
    if (!provider?.recentRuns) return;
    setBusy(true);
    if (!quiet) { setMessage(null); setError(null); }
    try {
      // Five rather than one: the user's editor run may sit behind a couple of
      // prompts from another API client on the same server.
      const runs = await provider.recentRuns(5);
      const mine = panelClientId();
      const candidate = pickRunToOffer(runs, mine);
      if (!candidate) {
        setFound(null);
        if (!quiet) setMessage('This server has not run anything yet.');
        return;
      }
      setFound({
        run: candidate,
        described: describeRun(candidate, mine),
        comparison: active ? compareGraphs(active.api, candidate.api) : null,
      });
    } catch (e) {
      if (!quiet) setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [provider, active]);

  /**
   * One automatic look, when the user comes back having opened the editor.
   *
   * Deliberately not a poll. Every history entry carries a whole graph — a few
   * hundred kilobytes for a large workflow — and on a cloud-hosted server each
   * request also reloads a volume. Once per visit costs nothing when nobody is
   * working; a 15-second loop would cost that all day.
   */
  const checkedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!canCapture || !editorOpened || !active) return;
    if (checkedFor.current === active.id) return;
    checkedFor.current = active.id;
    void check(true);
  }, [canCapture, editorOpened, active, check]);

  const adopt = async (): Promise<void> => {
    if (!found || !active) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      let flowRootDir: string | null = null;
      try {
        flowRootDir = (await resolveFlowRoot(settings)).dir;
      } catch {
        // No project folder (unsaved project, or running outside AE). The
        // capture still works for this session; say so rather than refuse.
        flowRootDir = null;
      }
      const meta = rememberCapture({
        workflowId: active.id,
        api: found.run.api,
        promptId: found.run.promptId,
        verdict: found.comparison?.verdict ?? 'similar',
        flowRootDir,
      });
      setExisting(meta);
      setFound(null);
      await onAdopted();
      setMessage(meta.path
        ? `"${active.name}" now runs the graph ComfyUI compiled, ${meta.nodeCount} nodes. Its inputs `
          + 'have been re-read, so check the fields before generating.'
        : `"${active.name}" now runs the graph ComfyUI compiled, ${meta.nodeCount} nodes — but the `
          + 'project has never been saved, so this is only kept for this session. Save the project '
          + 'and capture again to keep it.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const forget = async (): Promise<void> => {
    if (!active) return;
    setBusy(true); setError(null);
    try {
      forgetCapture(active.id);
      setExisting(null);
      await onAdopted();
      setMessage(`"${active.name}" is back to the panel's own conversion of the file.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!active) return null;

  return (
    <div className="card space-y-2 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="section-label">Graph in use</span>
        {canCapture && (
          <button className="chip shrink-0" onClick={() => void check(false)} disabled={busy}>
            {busy ? 'Reading…' : 'Check for a run'}
          </button>
        )}
      </div>

      <SourceLine record={active} capturedAt={existing?.capturedAt ?? null} />

      {!canCapture && (
        <p className="text-[10px] leading-snug text-ink-mute">
          {provider?.label ?? 'This provider'} does not expose ComfyUI's run history, so a graph
          cannot be captured from it. Import an API-format export instead.
        </p>
      )}

      {found && <RunOffer found={found} workflowName={active.name} busy={busy} onAdopt={() => void adopt()} />}

      {existing && (
        <button className="chip" onClick={() => void forget()} disabled={busy}>
          Go back to converting the file
        </button>
      )}

      {message && <p className="text-[10px] leading-snug text-ink-dim">{message}</p>}
      {error && <p className="text-[10px] leading-snug text-err">{error}</p>}
    </div>
  );
}

/** Which of the three graphs the panel is about to send, in plain words. */
function SourceLine({
  record, capturedAt,
}: { record: WorkflowRecord; capturedAt: number | null }): JSX.Element {
  if (record.apiSource === 'captured') {
    const when = capturedAt ? new Date(capturedAt).toLocaleString() : 'earlier';
    return (
      <p className="text-[11px] leading-snug text-ok">
        Running the graph ComfyUI compiled, captured {when}. This is the same graph the editor
        executed — bypassed nodes, subgraphs and custom nodes included.
      </p>
    );
  }
  if (record.apiSource === 'file') {
    return (
      <p className="text-[11px] leading-snug text-ink-dim">
        This workflow is already in API format, so it is sent exactly as it is on disk.
      </p>
    );
  }
  return (
    <p className="text-[11px] leading-snug text-ink-dim">
      Running the panel's own conversion of the editor file. That is an approximation: on graphs
      with bypassed or muted nodes it can drop a connection. Run this workflow once in the editor
      and capture it to remove the guesswork.
    </p>
  );
}

/** The run we found, what it looks like, and whether it plausibly belongs here. */
function RunOffer({
  found, workflowName, busy, onAdopt,
}: { found: Found; workflowName: string; busy: boolean; onAdopt: () => void }): JSX.Element {
  const { described, comparison } = found;
  const when = described.createdAt ? new Date(described.createdAt).toLocaleString() : 'unknown time';
  const origin = described.mine
    ? 'submitted by this panel'
    : described.fromEditor
      ? 'run from the ComfyUI editor'
      : 'submitted by another API client';

  return (
    <div className="space-y-1.5 rounded-lg border border-line bg-bg/60 p-2">
      <p className="text-[11px] leading-snug text-ink">
        {described.nodeCount} nodes, {described.outputKind} output, {when} — {origin}.
      </p>
      {!described.hasEditorGraph && (
        <p className="text-[10px] leading-snug text-ink-mute">
          This run carries no editor graph, so the executed graph is adopted on its own: the
          workflow will still run correctly, but its App Mode layout cannot come with it and the
          fields are read from the graph instead.
        </p>
      )}
      {comparison && <Verdict comparison={comparison} workflowName={workflowName} />}
      <button className="chip" onClick={onAdopt} disabled={busy}>
        Use this graph for &ldquo;{workflowName}&rdquo;
      </button>
    </div>
  );
}

/**
 * Say how well the run matches, and never hide a bad match behind a button.
 *
 * `different` is not blocked, because there is a legitimate reason for it — the
 * user may have rebuilt the workflow in the editor and want the panel to follow
 * — but it is the one case where adopting silently would run something they
 * did not choose, so it is stated first and plainly.
 */
function Verdict({
  comparison, workflowName,
}: { comparison: GraphComparison; workflowName: string }): JSX.Element {
  const { verdict, missing, extra } = comparison;

  if (verdict === 'identical' || verdict === 'same-shape') {
    return (
      <p className="text-[10px] leading-snug text-ok">
        Same nodes as &ldquo;{workflowName}&rdquo; — this is that workflow.
      </p>
    );
  }
  const detail = [
    missing.length > 0 ? `${missing.length} node type${missing.length === 1 ? '' : 's'} in the file are not in the run (${missing.slice(0, 4).join(', ')}${missing.length > 4 ? '…' : ''})` : '',
    extra.length > 0 ? `${extra.length} in the run are not in the file (${extra.slice(0, 4).join(', ')}${extra.length > 4 ? '…' : ''})` : '',
  ].filter(Boolean).join('; ');

  if (verdict === 'similar') {
    return (
      <p className="text-[10px] leading-snug text-warn">
        Mostly the same workflow, with differences: {detail}. Bypassing a node in the editor does
        exactly this, so it is often right — check it is what you changed.
      </p>
    );
  }
  return (
    <p className="text-[10px] leading-snug text-err">
      This run does not look like &ldquo;{workflowName}&rdquo;: {detail}. If you ran a different
      workflow in the editor, select that one here first.
    </p>
  );
}
