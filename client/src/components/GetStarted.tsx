/**
 * Get started — three steps, each one line and one action, with live checks from the server:
 *
 *   ① Where to run   your ComfyUI found (or how to get one) · or the Comfy Developer Platform, by the README
 *   ② What's ready   "7 of 9 ready · 1 needs models (28.6 GB)" → Choose what to download; the suggested start:
 *                    "Start with Z-Image · 1 workflow · 20.7 GB · not gated", then LTX-2.5 image to video (gated)
 *   ③ Try it         a Z-Image still on your ComfyUI, placed in the open comp
 *
 * Shown at the top of the Workflow tab on the first run, when no resource can take a job, or when fewer than half
 * of the Featured workflows are ready where the Generate button sends them (server/readiness.ts); hidden with one
 * click, back from Settings or the header pill.
 */

import { useState } from 'react';
import { serverJson } from '../bridge/server';
import { useApp } from '../state/store';
import { useResources } from '../lib/resources';
import { mediaUrl } from '../lib/comp';
import { formatBytes, makeTestImage, suggestionText, useReadiness } from '../lib/readiness';

/** The README section with the Comfy Developer Platform setup (Comfy Cloud with an API key, or a deployment). */
export const PLATFORM_README = 'no-gpu-the-comfy-developer-platform';
const DESKTOP_URL = 'https://comfy.org/download';

function Step({ n, title, ok, children }: { n: string; title: string; ok: boolean | null; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex gap-2.5" data-step={n}>
      <span className={'mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10px] font-semibold '
        + (ok === true ? 'bg-ok/20 text-ok' : ok === false ? 'bg-warn/20 text-warn' : 'bg-bg-subtle text-ink-mute')}>
        {ok === true ? '✓' : n}
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="text-[11px] font-semibold text-ink">{title}</div>
        {children}
      </div>
    </div>
  );
}

export function GetStarted(): JSX.Element | null {
  const data = useReadiness((s) => s.data);
  const load = useReadiness((s) => s.load);
  const setOnboarding = useReadiness((s) => s.setOnboarding);
  const openPicker = useReadiness((s) => s.setOpen);
  const setPicked = useReadiness((s) => s.setPicked);
  const setReadme = useReadiness((s) => s.setReadme);
  const resources = useResources((s) => s.data);
  const choose = useResources((s) => s.choose);
  const reloadResources = useResources((s) => s.load);
  const openSettings = useApp((s) => s.setSettingsOpen);
  const [checking, setChecking] = useState(false);
  const [test, setTest] = useState<{ busy: boolean; error?: string; done?: { file: string; seconds: number; placed?: { comp: string; at: number } } }>({ busy: false });

  // After a test image the card stays for this session, to say what happened (the first-run flag is set by then).
  if (!data || (!data.onboarding.show && !test.done)) return null;
  const local = data.local;
  const choice = resources?.choice ?? 'default';
  const others = data.usable.filter((r) => r.kind !== 'local');
  const z = data.entries.find((e) => e.id === 'zimage-t2i');
  const zLocal = z?.local.status;
  const where = data.resource.kind === 'default' ? 'where Default sends each one' : data.resource.label;

  const check = async (): Promise<void> => {
    setChecking(true);
    try { await serverJson(`/api/resources/${encodeURIComponent(local.id)}/check`, {}); } catch { /* the line says what the probe found */ }
    await reloadResources();
    await load();
    setChecking(false);
  };
  const runTest = async (): Promise<void> => {
    setTest({ busy: true });
    try {
      const r = await makeTestImage();
      setTest({ busy: false, done: r });
    } catch (e) {
      setTest({ busy: false, error: e instanceof Error ? e.message : String(e) });
    }
  };

  const c = data.counts;
  const sug = data.suggestion;
  const missingParts = [
    c.missingModels ? `${c.missingModels} need${c.missingModels === 1 ? 's' : ''} models${data.missing.bytes ? ` (${formatBytes(data.missing.bytes)}${data.missing.unknownSizes ? '+' : ''})` : ''}` : '',
    ...data.entries.filter((e) => e.status === 'missing-nodes').map((e) => `${e.name.split(' · ')[0]} needs ${e.packs.filter((p) => p.installed === false).map((p) => p.name).join(' + ') || 'custom nodes'}`),
    c.unknown ? `${c.unknown} unknown until they have run there` : '',
    c.notHere ? `${c.notHere} not on this resource` : '',
  ].filter(Boolean);

  return (
    <section className="space-y-3 rounded-xl border border-brand/40 bg-brand/5 p-3" data-testid="get-started">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-ink">Get started</span>
        <button className="text-[10px] text-ink-mute hover:text-ink" onClick={() => void setOnboarding('hidden')} data-testid="get-started-hide">
          Hide — reopen from Settings
        </button>
      </div>

      <Step n="1" title="Where to run" ok={local.online === true || others.length > 0 ? true : local.online === false ? false : null}>
        {local.online === true ? (
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 text-[11px] leading-snug text-ink-dim" data-testid="step1-local">
              Your ComfyUI answers at <span className="font-mono">{local.url}</span>
              {local.version ? <> — ComfyUI {local.version}{local.device ? ` · ${local.device}` : ''}</> : null}. Free: it runs on your GPU.
            </p>
            {choice !== local.id
              ? <button className="chip h-6 shrink-0 px-2 py-0 text-[11px]" onClick={() => void choose(local.id).then(load)}>Run here</button>
              : <span className="shrink-0 text-[10px] text-ok">running here</span>}
          </div>
        ) : (
          <div className="space-y-1.5 text-[11px] leading-snug text-ink-dim" data-testid="step1-none">
            <p>
              No ComfyUI answers at <span className="font-mono">{local.url}</span>
              {local.online === null ? ' yet (checking…)' : '.'}{' '}
              <button className="text-brand hover:underline" onClick={() => void check()} disabled={checking}>{checking ? 'Checking…' : 'Check again'}</button>
            </p>
            <p>
              <span className="text-ink">Have a GPU?</span> Install ComfyUI Desktop from{' '}
              <a className="text-brand underline" href={DESKTOP_URL} target="_blank" rel="noreferrer">comfy.org/download</a>, start it, then
              Check again. Installed somewhere else? Its address goes in{' '}
              <button className="text-brand hover:underline" onClick={() => openSettings(true)}>Settings ▸ Resources</button>.
            </p>
            <p>
              <span className="text-ink">No GPU?</span> Comfy Developer Platform (Comfy Cloud with an API key, or your own deployment) — see{' '}
              <button className="text-brand hover:underline" onClick={() => setReadme(PLATFORM_README)} data-testid="readme-platform">Setup in the README</button>;
              the key goes in <button className="text-brand hover:underline" onClick={() => openSettings(true)}>Settings ▸ Resources</button>.
            </p>
          </div>
        )}
        {/* Without a local ComfyUI, the resources that can take a job instead (their pick is "Running on", below). */}
        {local.online !== true && others.map((r) => (
          <div key={r.id} className="flex items-center gap-2 text-[11px] text-ink-dim">
            <span className="min-w-0 flex-1 truncate">{r.label} can take jobs.</span>
            {choice !== r.id
              ? <button className="chip h-6 shrink-0 px-2 py-0 text-[11px]" onClick={() => void choose(r.id).then(load)}>Run there</button>
              : <span className="shrink-0 text-[10px] text-ok">running there</span>}
          </div>
        ))}
      </Step>

      <Step n="2" title="What's ready" ok={c.total > 0 && c.ready === c.total ? true : local.online === true || others.length ? false : null}>
        {local.online === true || others.length ? (
          <div className="flex items-start gap-2">
            <p className="min-w-0 flex-1 text-[11px] leading-snug text-ink-dim" data-testid="step2-counts">
              <span className="text-ink">{c.ready} of {c.total} ready</span> on {where}
              {missingParts.length ? <> · {missingParts.join(' · ')}</> : '.'}
            </p>
            <button className="chip h-6 shrink-0 px-2 py-0 text-[11px]" onClick={() => openPicker(true)} data-testid="open-picker">
              {data.missing.files ? 'Get the missing models' : 'Models…'}
            </button>
          </div>
        ) : (
          <p className="text-[11px] leading-snug text-ink-mute">Once a ComfyUI answers (①), this says which workflows are ready and what to download.</p>
        )}
        {/* The suggested start, on your ComfyUI: Z-Image alone (not gated), then LTX-2.5 image to video (gated). */}
        {local.online === true && (sug.files > 0 || sug.then.files > 0) && (
          <div className="space-y-0.5 text-[11px] leading-snug" data-testid="step2-suggestion">
            {sug.files > 0 && (
              <button className="block text-left text-brand hover:underline" onClick={() => { setPicked(sug.ids); openPicker(true); }} data-testid="step2-start">
                {suggestionText(sug)}
              </button>
            )}
            {sug.then.files > 0 && (
              <p className="text-ink-mute" data-testid="step2-then">
                <button className="text-left hover:text-ink hover:underline" onClick={() => { setPicked(sug.files > 0 ? [...sug.ids, ...sug.then.ids] : sug.then.ids); openPicker(true); }}>
                  {sug.files > 0 ? sug.then.label : sug.then.label.replace(/^then /, 'Next: ')}
                </button>
                {sug.then.pages.length > 0 && <> — {sug.then.pages.map((u, i) => (
                  <span key={u}>{i > 0 && ', '}<a className="underline hover:text-ink" href={u} target="_blank" rel="noreferrer">{u.replace('https://huggingface.co/', '')}</a></span>
                ))}</>}
              </p>
            )}
          </div>
        )}
      </Step>

      <Step n="3" title="Try it" ok={test.done ? true : null}>
        {test.done ? (
          <div className="flex items-start gap-2" data-testid="step3-done">
            <img src={mediaUrl(test.done.file)} alt="" className="h-14 w-14 shrink-0 rounded border border-line object-cover" />
            <p className="min-w-0 flex-1 text-[11px] leading-snug text-ink-dim">
              {test.done.placed
                ? <>A Z-Image still ({Math.round(test.done.seconds)} s) is in &ldquo;{test.done.placed.comp}&rdquo; at {test.done.placed.at.toFixed(1)} s, as &ldquo;Flow · test image&rdquo;. </>
                : null}
              <span className="text-ink">You&rsquo;re set</span> — pick a workflow below, or add a marker pair / placeholder and generate.
            </p>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            {zLocal === 'ready' ? (
              <button className="btn-primary h-7 px-3 text-[11px]" onClick={() => void runTest()} disabled={test.busy} data-testid="make-test-image">
                {test.busy ? 'Making it…' : 'Make a test image'}
              </button>
            ) : zLocal === 'missing-models' ? (
              <button className="btn-ghost h-7 px-3 text-[11px]" onClick={() => { setPicked(['zimage-t2i']); openPicker(true); }} data-testid="get-zimage">
                Get Z-Image first{z?.missing.bytes ? ` (${formatBytes(z.missing.bytes)})` : ''}
              </button>
            ) : (
              <button className="btn-ghost h-7 px-3 text-[11px]" disabled>Make a test image</button>
            )}
            <p className="min-w-0 flex-1 text-[10px] leading-snug text-ink-mute">
              {test.busy ? 'A 512×512 still from Z-Image on your ComfyUI, then into the open comp at the playhead…'
                : zLocal === 'ready' ? 'A 512×512 Z-Image still on your ComfyUI, placed in the open comp at the playhead.'
                  : zLocal === 'missing-models' ? 'The test uses Z-Image-Turbo on your ComfyUI.'
                    : 'Needs your ComfyUI (①).'}
            </p>
          </div>
        )}
        {test.error && <p className="text-[11px] leading-snug text-err">{test.error}</p>}
      </Step>
    </section>
  );
}
