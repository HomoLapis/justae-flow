/**
 * The Workflow tab — pick one, or go build one.
 *
 * Flow 1 embedded the real ComfyUI in an iframe here. That was the right idea
 * and the wrong container: CEP 12 renders in Chromium 99, and the ComfyUI
 * frontend this panel talks to (1.49.6) is built on Tailwind v4 and PrimeVue 4
 * — 407 `color-mix()` declarations, `:has()`, `@container`, and bundles that
 * call `Array.prototype.toSorted`. Chromium 99 discards the first three and
 * throws on the last. The editor could load and never look or behave right, and
 * no amount of code in this file changes that.
 *
 * So the editor opens in a browser window, where it is current — but a window
 * the panel LAUNCHED and can still talk to over its debug port, so "open this
 * one" survives the move out of the iframe. See workflows/editorWindow.ts.
 *
 * The rest of the tab is the library and the round trip: save in ComfyUI, the
 * workflow appears in the list; select it and its inputs become the fields in
 * the Marker and Storyboard tabs. If the author set up App Mode, those are
 * exactly the fields they chose to expose.
 */

import { useState } from 'react';
import { PipelineLibrary } from './PipelineLibrary';
import { useApp } from '../state/store';
import { useLibrary } from '../workflows/useLibrary';
import {
  removeWorkflow, saveToProject, saveToServer, toFileName,
} from '../workflows/library';
import { resolveFlowRoot } from '../lib/assets';
import { nodeAvailable, pathJoin, readTextFile } from '../lib/fs';
import { openInBrowser } from '../bridge/csInterface';
import { loadIntoWindow, openEditorWindow } from '../workflows/editorWindow';
import { CaptureCard } from './CaptureCard';
import { WorkflowSearch } from './WorkflowSearch';

export function WorkflowTab(): JSX.Element {
  const library = useApp((s) => s.library);
  const activeId = useApp((s) => s.activeId);
  const active = useApp((s) => s.active);
  const loading = useApp((s) => s.libraryLoading);
  const error = useApp((s) => s.libraryError);
  const editorOpened = useApp((s) => s.editorOpened);
  const setEditorOpened = useApp((s) => s.setEditorOpened);
  const settings = useApp((s) => s.settings);
  const setTab = useApp((s) => s.setTab);
  const openSettings = useApp((s) => s.setSettingsOpen);

  const { provider, providerError, refresh, select } = useLibrary();
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const editorUrl = provider?.editorUrl?.() ?? null;
  /** Whether saving in the editor can find its way back to us on its own. */
  const roundTrips = !!provider?.workflows?.();

  /**
   * Open the editor — and, when we can, ON the selected workflow.
   *
   * Two roads, and the better one is not always available. A browser launched
   * by the panel with a debug port can be told which workflow to put on the
   * canvas, which is what makes "pick it here, edit it there" one motion. When
   * that is not possible — no Node, no Chrome or Edge installed, the window
   * refusing to answer — the panel still opens the editor through CEP's own
   * call, and says plainly that finding the file is now the user's job.
   */
  const openEditor = async (): Promise<void> => {
    if (!editorUrl) return;
    setBusy(true);
    setNotice('Opening the editor…');
    try {
      let profileDir: string | null = null;
      try {
        profileDir = pathJoin((await resolveFlowRoot(settings)).dir, 'editor-profile');
      } catch {
        // No project folder yet — fall through to the plain open below.
      }

      if (profileDir) {
        const result = await openEditorWindow(editorUrl, profileDir);
        if (result.ok) {
          setEditorOpened(true);
          if (!active) {
            setNotice('The editor is open. Pick a workflow here and press Edit to put it on the canvas.');
            return;
          }
          /*
           * The wait is reported while it happens.
           *
           * A cold editor window needs about twenty-five seconds before it can
           * build a node — measured — and the panel now holds the load until
           * then rather than putting a canvas of red placeholders on screen.
           * Twenty-five silent seconds read as a hang, so say what is going on.
           */
          const loaded = await loadIntoWindow(
            active.ref, undefined, result.started === true, (m) => setNotice(m),
          );
          setNotice(
            loaded === 'identity'
              ? `"${active.name}" is open in the editor. Ctrl+S there saves back to this same file — `
                + 'the panel picks the change up on Refresh.'
              : loaded === 'graph-only'
                ? `A copy of "${active.name}" is on the canvas: the editor did not offer it from its own `
                  + 'workflow list, so Ctrl+S will ask for a new name rather than overwrite the file.'
                : `The editor is open, but the panel could not put "${active.name}" on the canvas. `
                  + 'Open it from the Workflows sidebar there.',
          );
          return;
        }
        setNotice(`${result.reason} Opening it in your default browser instead.`);
      }

      openInBrowser(editorUrl);
      setEditorOpened(true);
      setNotice((prev) => `${prev ? `${prev} ` : ''}${roundTrips
        ? 'Save there (Ctrl+S) and the workflow shows up in the list above on its own.'
        : `${provider?.label ?? 'This server'} does not expose its workflow folder, so export the `
          + 'workflow and bring it back with "Import file…".'}`);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const importFile = (): void => {
    setNotice(null);
    const el = document.createElement('input');
    el.type = 'file';
    el.accept = 'application/json,.json';
    el.onchange = () => {
      const f = el.files?.[0];
      if (!f) return;
      const path = (f as File & { path?: string }).path ?? '';
      void (async (): Promise<void> => {
        setBusy(true);
        try {
          const text = path && nodeAvailable() ? readTextFile(path) : await f.text();
          const data = JSON.parse(text) as unknown;
          const name = f.name.replace(/\.json$/i, '');

          // Prefer the server: a workflow saved there is one the editor can
          // open, which is the whole point of the round trip.
          if (provider?.workflows?.()) {
            const summary = await saveToServer(provider, name, data);
            await refresh();
            await select(summary.id);
            setNotice(`Imported "${summary.name}" into ${provider.label}.`);
            return;
          }
          const root = await resolveFlowRoot(settings);
          const summary = saveToProject(root.dir, name, data);
          await refresh();
          await select(summary.id);
          setNotice(`Imported "${summary.name}" next to the project.`);
        } catch (e) {
          setNotice(e instanceof Error ? e.message : String(e));
        } finally { setBusy(false); }
      })();
    };
    el.click();
  };

  /** Keep a copy next to the .aep so the project travels with its workflows. */
  const copyToProject = async (): Promise<void> => {
    if (!active) return;
    setNotice(null); setBusy(true);
    try {
      const root = await resolveFlowRoot(settings);
      saveToProject(root.dir, active.name, active.ui ?? active.api);
      await refresh();
      setNotice(`Saved a copy in ${root.label}/workflows/${toFileName(active.name)}.`);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const remove = async (): Promise<void> => {
    if (!active) return;
    const summary = library.find((w) => w.id === active.id);
    if (!summary) return;
    setBusy(true);
    try {
      await removeWorkflow(summary, provider);
      useApp.getState().setActive(null);
      useApp.getState().setActiveId('');
      await refresh();
      setNotice(`Deleted "${summary.name}".`);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto px-3.5 pb-8 pt-3.5">
      {/* ── The library ────────────────────────────────────── */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="section-label">Workflows</span>
          <div className="flex items-center gap-1">
            <button className="chip" onClick={() => void refresh()} disabled={loading}>
              {loading ? 'Reading…' : 'Refresh'}
            </button>
            <button className="chip" onClick={importFile} disabled={busy}>Import file…</button>
          </div>
        </div>

        <WorkflowSearch
          library={library}
          activeId={activeId}
          activeName={active ? active.name : null}
          serverLabel={provider?.label ?? 'server'}
          busy={busy}
          onPick={(id) => { setNotice(null); void select(id); }}
        />

        {library.length === 0 && !loading && (
          <p className="text-[11px] leading-snug text-ink-mute">
            {providerError
              ? providerError
              : provider
                ? 'No workflows on this server yet. Open the editor below and save one, or import a .json.'
                : 'Pick a provider in Settings first.'}
          </p>
        )}

        {active && <ActiveSummary />}
        <CaptureCard
          provider={provider}
          active={active}
          onAdopted={() => (active ? select(active.id) : undefined)}
        />
        {error && <p className="whitespace-pre-line text-[11px] leading-snug text-err">{error}</p>}
        {notice && <p className="text-[11px] leading-snug text-ink-dim">{notice}</p>}

        {active && (
          <div className="flex flex-wrap gap-1.5">
            <button className="chip" onClick={() => setTab('marker')}>Use it →</button>
            <button className="chip" onClick={() => void openEditor()} disabled={busy || !editorUrl}>
              Edit in ComfyUI
            </button>
            <button className="chip" onClick={() => void copyToProject()} disabled={busy}>
              Copy next to project
            </button>
            <button className="chip" onClick={() => void remove()} disabled={busy}>Delete</button>
          </div>
        )}
      </section>

      {/* ── The professional pipeline (catalog + draft/final + delivery) ── */}
      <PipelineLibrary provider={provider} onPick={(id) => { setNotice(null); void select(id); }} />

      {/* ── The editor ─────────────────────────────────────── */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="section-label">ComfyUI editor</span>
          {editorUrl ? (
            <button className="chip" onClick={() => void openEditor()} disabled={busy}>
              {active ? 'Open this workflow' : 'Open editor'}
            </button>
          ) : settings.provider !== 'comfy-v2' && (
            <button className="chip" onClick={() => openSettings(true)}>Set a provider…</button>
          )}
        </div>

        {editorUrl ? (
          <div className="card space-y-1.5 p-2.5">
            <p className="text-[11px] leading-snug text-ink-dim">
              {roundTrips
                ? 'Build and edit in the real ComfyUI, in a window the panel opens for you — with the '
                  + "selected workflow already on the canvas. Ctrl+S there writes to the server's own "
                  + 'workflow folder, and this panel picks the change up: the same file on both sides.'
                : 'Build and edit in the real ComfyUI, in your browser. This provider keeps its '
                  + 'workflows behind a sign-in rather than in a folder the panel can read, so bring '
                  + 'one back with "Import file…" above.'}
            </p>
            <code className="block truncate rounded bg-bg px-2 py-1 font-mono text-[10px] text-ink-mute">
              {editorUrl}
            </code>
            {editorOpened && roundTrips && (
              <p className="text-[10px] leading-snug text-ink-mute">
                Watching the workflow folder — a save made in the editor appears above within about
                fifteen seconds. Refresh forces it.
              </p>
            )}
          </div>
        ) : settings.provider === 'comfy-v2' ? (
          <p className="text-[11px] leading-snug text-ink-mute">
            Comfy API v2 has no editor of its own. Build the workflow in a ComfyUI — the one behind
            your deployment&rsquo;s build, or your own — export it in API format, and bring it in
            with &ldquo;Import file…&rdquo; above.
          </p>
        ) : (
          <p className="text-[11px] leading-snug text-ink-mute">
            Add the server's address in Settings to open its editor.
          </p>
        )}

        <p className="text-[10px] leading-snug text-ink-mute">
          The editor runs in its own window, driven from here: picking a workflow above and
          pressing Edit puts that one on its canvas, and Ctrl+S there saves back to the same file.
        </p>
      </section>
    </div>
  );
}

/** What we understood about the selected workflow — stated, not assumed. */
function ActiveSummary(): JSX.Element | null {
  const active = useApp((s) => s.active);
  if (!active) return null;

  const f = active.form;
  const files = f.fields.filter((x) => ['image', 'video', 'audio'].includes(x.kind));
  const aeDriven = f.fields.filter((x) => x.aeRole && x.aeRole !== 'seed');

  return (
    <div className="card space-y-1.5 p-2.5">
      {active.description && (
        <p className="text-[11px] leading-snug text-ink-dim">{active.description}</p>
      )}
      <p className="font-mono text-[10px] leading-relaxed text-ink-mute">
        {f.source === 'appmode'
          ? `App Mode layout · ${f.fields.length} field${f.fields.length === 1 ? '' : 's'} as the author arranged them`
          : `${f.fields.filter((x) => !x.advanced).length} main field${f.fields.length === 1 ? '' : 's'} · ${f.fields.filter((x) => x.advanced).length} more under All controls`}
        {files.length > 0 && ` · ${files.length} file input${files.length === 1 ? '' : 's'}`}
        {` · output: ${active.inspected.primaryOutputKind}`}
      </p>
      {aeDriven.length > 0 && <AeDrivenNote fields={aeDriven} />}
      {active.problems.length > 0 && (
        <p className="whitespace-pre-line text-[10px] leading-snug text-warn">
          {active.problems.join('\n')}
        </p>
      )}
      {f.unmapped.length > 0 && (
        <p className="text-[10px] leading-snug text-warn">
          {f.unmapped.length} App Mode field{f.unmapped.length === 1 ? '' : 's'} could not be matched to a
          node in the converted graph and {f.unmapped.length === 1 ? 'is' : 'are'} not shown:{' '}
          {f.unmapped.join(', ')}.
        </p>
      )}
    </div>
  );
}

/**
 * Which fields After Effects will write into — and, when a role appears on
 * more than one node, say so.
 *
 * Big graphs legitimately carry several width/height/fps knobs (a sampler, an
 * upscale, a video muxer) and filling them all is usually what you want: the
 * whole chain then agrees with the comp. But "usually" isn't "always", so the
 * duplicates are named here and every field can be switched back to manual
 * individually in the Inputs list.
 */
function AeDrivenNote({ fields }: { fields: Array<{ aeRole: string | null; label: string }> }): JSX.Element {
  const byRole = new Map<string, string[]>();
  for (const f of fields) {
    if (!f.aeRole) continue;
    byRole.set(f.aeRole, [...(byRole.get(f.aeRole) ?? []), f.label]);
  }
  const duplicated = [...byRole.entries()].filter(([, labels]) => labels.length > 1);

  return (
    <>
      <p className="text-[10px] leading-snug text-brand/80">
        EffectCraft will set: {[...byRole.keys()].join(', ')}.
      </p>
      {duplicated.length > 0 && (
        <p className="text-[10px] leading-snug text-ink-mute">
          {duplicated.map(([role, labels]) => `${role} appears on ${labels.length} nodes (${labels.join(', ')})`)
            .join('; ')}
          {' '}— all of them get the value. Switch any of them to manual in Inputs if that's wrong.
        </p>
      )}
    </>
  );
}
