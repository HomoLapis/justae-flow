/**
 * Get the models — you choose what goes on your ComfyUI.
 *
 * The Featured workflows, grouped as on the Workflow tab, each with a box to tick, its status on your local ComfyUI
 * and, under it, the model files it needs: name · folder · size · source · licence. A file two workflows share is
 * listed under both and counted once. Nothing is ticked to begin with; the suggested pair (a still and a shot) is
 * one click. The total says files, gigabytes and the time at the last measured speed; "Download selected" fetches
 * only what was ticked, into the models folder you set — and nowhere else. Every file can also be fetched alone, or
 * copied as a comfy-cli command.
 *
 * Custom nodes are never installed from here: the pack is named, to install with ComfyUI Manager. Gated files (the
 * Lightricks repos) link to the page where their terms are accepted; a Hugging Face token, if needed, goes in
 * Settings ▸ Resources.
 */

import { useState } from 'react';
import { copyText } from '../lib/clipboard';
import {
  comfyCommand, etaText, filesToGet, formatBytes, putModelsFolder, useReadiness,
  type DownloadItem, type ReadinessEntry,
} from '../lib/readiness';
import { StatusChip } from './FeaturedSection';

export function ModelPicker(): JSX.Element | null {
  const open = useReadiness((s) => s.pickerOpen);
  const setOpen = useReadiness((s) => s.setOpen);
  const data = useReadiness((s) => s.data);
  const picked = useReadiness((s) => s.picked);
  const setPicked = useReadiness((s) => s.setPicked);
  const downloads = useReadiness((s) => s.downloads);
  const download = useReadiness((s) => s.download);
  const cancel = useReadiness((s) => s.cancel);
  const load = useReadiness((s) => s.load);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  if (!open) return null;
  const close = (): void => setOpen(false);
  if (!data) {
    return (
      <Shell onClose={close}>
        <p className="text-[11px] text-ink-mute">Reading what your ComfyUI has…</p>
      </Shell>
    );
  }
  const folderOk = !!data.local.modelsDir && !!data.local.folder?.ok;
  const toGet = filesToGet(data.entries, picked);
  const bytes = toGet.reduce((a, f) => a + (f.size ?? 0), 0);
  const unknown = toGet.filter((f) => f.size === null).length;
  const running = !!downloads?.running;
  const toggle = (id: string): void => setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]);
  const start = async (files: Array<{ directory: string; name: string; url: string }>): Promise<void> => {
    setError(null);
    try { await download(files); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const copy = async (key: string, text: string): Promise<void> => {
    const ok = await copyText(text);
    setCopied(ok ? key : null);
    if (!ok) setError('The command could not be copied here; it is in the tooltip of the button.');
  };
  const sug = data.suggestion;

  return (
    <Shell onClose={close}>
      <FolderLine onSaved={() => void load()} />

      {sug.files > 0 && (
        <button type="button" className="flex w-full items-center gap-2 rounded-lg border border-brand/40 bg-brand/5 px-2.5 py-2 text-left hover:bg-brand/10"
          onClick={() => setPicked([...new Set([...picked, ...sug.ids])])} data-testid="pick-suggested">
          <span className="text-brand">＋</span>
          <span className="min-w-0 flex-1 text-[11px] text-ink">
            {sug.label} · {sug.ids.length} workflows · {formatBytes(sug.bytes)}{sug.unknownSizes ? '+' : ''}
          </span>
          <span className="shrink-0 text-[10px] text-ink-mute">tick these</span>
        </button>
      )}

      {(['generate', 'edit'] as const).map((g) => (
        <section key={g} className="space-y-1.5">
          <span className="section-label">{g === 'generate' ? 'Generate' : 'Edit & finish'}</span>
          <ul className="space-y-1.5">
            {data.entries.filter((e) => e.group === g).map((e) => (
              <PickRow key={e.id} e={e} ticked={picked.includes(e.id)} onToggle={() => toggle(e.id)}
                folderOk={folderOk} modelsDir={data.local.modelsDir} running={running} copied={copied}
                onDownload={(f) => void start([f])} onCopy={(k, t) => void copy(k, t)} />
            ))}
          </ul>
        </section>
      ))}

      <p className="text-[10px] leading-snug text-ink-mute">
        Sizes from the Hugging Face API; each file is checked against the sha256 Hugging Face gives for it. A file two
        workflows share is downloaded once. If your ComfyUI has another precision of the same weights, it is used and the
        file is not needed (&ldquo;yours:&rdquo;).
      </p>

      {downloads && <Progress d={downloads} onCancel={() => void cancel()} />}

      <div className="sticky bottom-0 -mx-3.5 space-y-1.5 border-t border-line bg-bg px-3.5 py-2.5" data-testid="picker-total">
        <p className="text-[11px] leading-snug text-ink-dim">
          {picked.length === 0
            ? 'Nothing ticked yet.'
            : <>
              <span className="text-ink">{picked.length} workflow{picked.length === 1 ? '' : 's'} selected · {toGet.length} file{toGet.length === 1 ? '' : 's'} · {formatBytes(bytes)}{unknown ? ` + ${unknown} of unknown size` : ''}</span>
              {toGet.length > 0 && (data.speed
                ? <> · {etaText(bytes, data.speed.bytesPerSec)} at your last measured speed ({formatBytes(data.speed.bytesPerSec)}/s, {new Date(data.speed.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })})</>
                : ' · no download measured yet, so no time estimate')}
            </>}
        </p>
        <div className="flex items-center gap-2">
          <button className="btn-primary h-8 px-3 text-xs" disabled={!folderOk || toGet.length === 0 || running}
            onClick={() => void start(toGet.map((f) => ({ directory: f.directory, name: f.name, url: f.url })))} data-testid="download-selected">
            Download selected
          </button>
          {picked.length > 0 && <button className="btn-quiet h-8 px-2 text-xs" onClick={() => setPicked([])}>Clear</button>}
          <span className="min-w-0 flex-1 text-right text-[10px] leading-snug text-ink-mute">
            {!folderOk ? 'Set your models folder above first.' : running ? 'A download is running.' : `Into ${data.local.modelsDir}`}
          </span>
        </div>
        {error && <p className="text-[11px] leading-snug text-err">{error}</p>}
      </div>
    </Shell>
  );
}

function Shell({ children, onClose }: { children: React.ReactNode; onClose: () => void }): JSX.Element {
  return (
    <div className="absolute inset-0 z-50 flex flex-col bg-bg" data-testid="model-picker">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-line px-3.5">
        <h2 className="text-sm font-semibold text-ink">Get the models</h2>
        <button className="btn-quiet h-8 px-3 text-xs" onClick={onClose}>Done</button>
      </header>
      <div className="flex-1 space-y-3 overflow-y-auto px-3.5 pt-3">{children}</div>
    </div>
  );
}

/** Where downloads go: the folder the user set, or the field to set it (with the usual places). */
export function FolderLine({ onSaved, compact = false }: { onSaved: () => void; compact?: boolean }): JSX.Element | null {
  const data = useReadiness((s) => s.data);
  const [draft, setDraft] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [editing, setEditing] = useState(false);
  if (!data) return null;
  const dir = data.local.modelsDir;
  const ok = !!dir && !!data.local.folder?.ok;
  const save = async (): Promise<void> => {
    const v = (draft ?? dir ?? '').trim();
    try {
      const r = await putModelsFolder(v || null);
      setMsg({ ok: true, text: r.path ? (r.note ?? `Saved: ${r.path}`) : 'Cleared.' });
      setDraft(null);
      setEditing(false);
      onSaved();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    }
  };
  if (ok && !editing) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-line bg-bg-raised px-2.5 py-1.5" data-testid="models-folder">
        <span className="text-[11px] text-ink-dim">Models folder</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink" title={dir!}>{dir}</span>
        <button className="btn-quiet h-6 shrink-0 px-2 text-[11px]" onClick={() => { setEditing(true); setDraft(dir); }}>Change</button>
      </div>
    );
  }
  return (
    <div className="space-y-1.5 rounded-lg border border-line bg-bg-raised p-2.5" data-testid="models-folder">
      <span className="block text-[11px] text-ink-dim">Your ComfyUI&rsquo;s models folder — downloads go there and nowhere else</span>
      <div className="flex items-center gap-1.5">
        <input className="input h-8 min-h-0 flex-1 py-1 font-mono text-[11px]" value={draft ?? dir ?? ''} placeholder="Paste the folder's path"
          onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void save(); }} data-testid="models-folder-field" />
        <button className="btn-ghost h-8 px-2.5 text-[11px]" onClick={() => void save()} disabled={(draft ?? dir ?? '').trim() === ''}>Save</button>
        {editing && <button className="btn-quiet h-8 px-2 text-[11px]" onClick={() => { setEditing(false); setDraft(null); }}>Cancel</button>}
      </div>
      {!compact && (
        <ul className="list-disc space-y-0.5 pl-4 text-[10px] leading-snug text-ink-mute">
          <li>ComfyUI Desktop on Windows keeps its shared model library in <span className="font-mono">%LOCALAPPDATA%\Comfy-Desktop\ComfyUI-Shared</span> (docs.comfy.org; the models folder inside it: to be verified — paste that folder and JustAE Flow looks for its <span className="font-mono">models</span>).</li>
          <li>A ComfyUI you installed yourself: <span className="font-mono">ComfyUI\models</span> in its folder.</li>
          <li>ComfyUI in WSL: <span className="font-mono">\\wsl.localhost\&lt;distro&gt;\home\&lt;user&gt;\ComfyUI\models</span>.</li>
        </ul>
      )}
      {dir && !data.local.folder?.ok && !msg && <p className="text-[10px] text-err">{data.local.folder?.message}</p>}
      {msg && <p className={'text-[10px] leading-snug ' + (msg.ok ? 'text-ok' : 'text-err')}>{msg.text}</p>}
    </div>
  );
}

function PickRow({ e, ticked, onToggle, folderOk, modelsDir, running, copied, onDownload, onCopy }: {
  e: ReadinessEntry; ticked: boolean; onToggle: () => void; folderOk: boolean; modelsDir: string | null; running: boolean; copied: string | null;
  onDownload: (f: { directory: string; name: string; url: string }) => void; onCopy: (key: string, text: string) => void;
}): JSX.Element {
  const [showAll, setShowAll] = useState(false);
  const missing = e.files.filter((f) => f.state === 'missing' && !f.onDisk);
  const nothing = missing.length === 0;
  const gatedMissing = [...new Set(missing.filter((f) => f.gated).map((f) => f.pageUrl))];
  // The gated repos are said where something is to download from them, and always on LTX finishing (its IC-LoRAs).
  const gatedAny = e.comp || gatedMissing.length ? [...new Set(e.files.filter((f) => f.gated).map((f) => f.pageUrl))] : [];
  const have = e.files.filter((f) => f.state === 'present' || f.state === 'variant' || f.onDisk);
  const shown = showAll ? e.files : e.files.filter((f) => !have.includes(f));
  const haveBytes = have.reduce((a, f) => a + (f.size ?? 0), 0);
  return (
    <li className={'rounded-lg border px-2.5 py-2 ' + (ticked ? 'border-brand/60 bg-brand/5' : 'border-line bg-bg-raised')} data-pick={e.id}>
      <label className={'flex items-center gap-2 ' + (nothing ? 'cursor-default' : 'cursor-pointer')}>
        <input type="checkbox" checked={ticked && !nothing} disabled={nothing} onChange={onToggle} data-testid={`pick-${e.id}`} />
        <span className="min-w-0 flex-1 truncate text-xs text-ink">{e.name}</span>
        <StatusChip status={e.local.status} text={e.local.chip} title={e.local.note} />
      </label>
      <ul className="mt-1 space-y-0.5 pl-6">
        {have.length > 0 && !showAll && (
          <li className="text-[10px] leading-snug text-ink-mute">
            <button type="button" className="hover:text-ink" onClick={() => setShowAll(true)}>
              <span className="text-ok">✓</span>{' '}
              {have.length === e.files.length ? (have.length === 1 ? 'Its file is' : `All ${have.length} files are`) : `${have.length} file${have.length === 1 ? ' is' : 's are'} already`} on your
              ComfyUI{haveBytes ? ` (${formatBytes(haveBytes)})` : ''} ▸
            </button>
          </li>
        )}
        {shown.map((f) => {
          const need = f.state === 'missing' && !f.onDisk;
          const cmd = comfyCommand(f, modelsDir);
          return (
            <li key={f.key} className={'flex items-baseline gap-1.5 text-[10px] leading-snug ' + (need ? 'text-ink-dim' : 'text-ink-mute')} data-file={f.key}>
              <span className={'w-3 shrink-0 ' + (need ? 'text-warn' : f.state === 'unknown' ? '' : 'text-ok')}>{need ? '↓' : f.state === 'unknown' ? '?' : '✓'}</span>
              <span className="min-w-0 flex-1">
                <span className={'font-mono ' + (need ? 'text-ink' : '')}>{f.name}</span>
                {' · '}{f.directory} · {formatBytes(f.size)} · <a className="underline hover:text-ink" href={f.pageUrl} target="_blank" rel="noreferrer">{f.repo}</a>
                {f.gated ? ' · gated' : ''}
                {f.draftOnly ? ' · Draft only' : ''}
                {f.state === 'variant' && f.using ? <> · yours: <span className="font-mono">{f.using}</span></> : null}
                {f.state === 'present' ? ' · on your ComfyUI' : null}
                {f.onDisk ? ' · in your folder; ComfyUI does not list it yet — restart it or press Refresh in its UI' : null}
                {f.partial ? ` · ${formatBytes(f.partial)} already downloaded, resumes` : null}
              </span>
              {need && (
                <span className="flex shrink-0 gap-1">
                  <button className="chip h-5 px-1.5 py-0 text-[10px]" disabled={!folderOk || running} onClick={() => onDownload({ directory: f.directory, name: f.name, url: f.url })}
                    title={folderOk ? `Download ${f.name} into ${modelsDir}\\${f.directory}` : 'Set your models folder first'} data-testid={`dl-${f.key}`}>
                    Download
                  </button>
                  <button className="chip h-5 px-1.5 py-0 text-[10px]" title={cmd} onClick={() => onCopy(f.key, cmd)}>
                    {copied === f.key ? 'Copied' : 'Copy command'}
                  </button>
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {e.packs.length > 0 && (
        <p className="mt-1 pl-6 text-[10px] leading-snug text-ink-mute" data-testid={`packs-${e.id}`}>
          Custom nodes: {e.packs.map((p, i) => (
            <span key={p.id}>{i > 0 && ', '}
              <a className="underline hover:text-ink" href={p.repo} target="_blank" rel="noreferrer">{p.name}</a>
              {p.installed === false ? <span className="text-warn"> (not installed)</span> : p.installed ? ' ✓' : ''}
            </span>
          ))} — JustAE Flow never installs nodes: install a missing pack with ComfyUI Manager, then restart ComfyUI.
        </p>
      )}
      {gatedAny.length > 0 && (
        <p className={'mt-0.5 pl-6 text-[10px] leading-snug ' + (gatedMissing.length ? 'text-warn' : 'text-ink-mute')}>
          Gated on Hugging Face: accept the terms on {gatedAny.map((u, i) => <span key={u}>{i > 0 && ', '}<a className="underline" href={u} target="_blank" rel="noreferrer">{u.replace('https://huggingface.co/', '')}</a></span>)} before
          downloading (signed in); a Hugging Face token, if needed, goes in Settings ▸ Resources.
        </p>
      )}
      <p className="mt-0.5 pl-6 text-[10px] leading-snug text-ink-mute">
        Licence: {e.licence.text}{e.licence.url && <> — <a className="underline hover:text-ink" href={e.licence.url} target="_blank" rel="noreferrer">text</a></>}
      </p>
    </li>
  );
}

function Progress({ d, onCancel }: { d: NonNullable<ReturnType<typeof useReadiness.getState>['downloads']>; onCancel: () => void }): JSX.Element {
  const label = (i: DownloadItem): string => {
    switch (i.status) {
      case 'queued': return 'waiting';
      case 'downloading': return `${formatBytes(i.received)} of ${formatBytes(i.size)}${i.bytesPerSec ? ` · ${formatBytes(i.bytesPerSec)}/s` : ''}${i.resumedFrom ? ` · resumed from ${formatBytes(i.resumedFrom)}` : ''}`;
      case 'verifying': return 'checking the sha256…';
      case 'done': return `done · ${i.message ?? ''}`;
      case 'skipped': return i.message ?? 'already there';
      case 'cancelled': return i.message ?? 'cancelled';
      case 'error': return i.message ?? 'failed';
    }
  };
  return (
    <section className="space-y-1.5 rounded-lg border border-line bg-bg-raised p-2.5" data-testid="downloads">
      <div className="flex items-center justify-between">
        <span className="section-label">{d.running ? 'Downloading' : 'Last download'}</span>
        {d.running && <button className="btn-quiet h-6 px-2 text-[11px]" onClick={onCancel}>Cancel</button>}
      </div>
      <ul className="space-y-1">
        {d.items.map((i) => {
          const pct = i.size ? Math.min(100, (i.received / i.size) * 100) : 0;
          return (
            <li key={i.key} className="space-y-0.5" data-download={i.key} data-status={i.status}>
              <div className="flex items-baseline gap-1.5 text-[10px]">
                <span className="min-w-0 flex-1 truncate font-mono text-ink">{i.directory}/{i.name}</span>
                <span className={'shrink-0 ' + (i.status === 'error' ? 'text-err' : i.status === 'done' ? 'text-ok' : 'text-ink-mute')}>
                  {i.status === 'downloading' ? `${pct.toFixed(0)} %` : i.status}
                </span>
              </div>
              <div className="h-1 overflow-hidden rounded bg-bg-subtle">
                <div className={'h-full ' + (i.status === 'error' ? 'bg-err' : i.status === 'done' || i.status === 'skipped' ? 'bg-ok' : 'bg-brand')} style={{ width: `${i.status === 'done' || i.status === 'skipped' ? 100 : pct}%` }} />
              </div>
              <p className={'text-[10px] leading-snug ' + (i.status === 'error' ? 'text-err' : 'text-ink-mute')}>
                {label(i)}{i.gated ? <> — <a className="underline" href={i.pageUrl} target="_blank" rel="noreferrer">{i.pageUrl.replace('https://', '')}</a></> : null}
              </p>
            </li>
          );
        })}
      </ul>
      {!d.running && d.reprobe && (
        <p className={'text-[10px] leading-snug ' + (d.reprobe.stillMissing.length || !d.reprobe.online ? 'text-warn' : 'text-ok')} data-testid="reprobe">
          {d.reprobe.stillMissing.length
            ? `Your ComfyUI does not list ${d.reprobe.stillMissing.join(', ')} yet: restart ComfyUI or press Refresh in its UI, then Check in Settings ▸ Resources.`
            : d.reprobe.online ? 'Your ComfyUI was read again: it lists the new files, and the cards are updated.' : 'Your ComfyUI did not answer when it was read again: the cards update once it does.'}
        </p>
      )}
      {!d.running && d.items.some((i) => i.status === 'done') && !d.reprobe && <p className="text-[10px] text-ink-mute">Reading your ComfyUI again…</p>}
    </section>
  );
}
