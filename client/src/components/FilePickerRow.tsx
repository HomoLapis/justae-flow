/**
 * One file input of a workflow, filled from wherever the shot's material is.
 *
 * The point of this row is that the material is usually already in
 * EffectCraft: the frame under the playhead, or the work area as a clip. Grabbing
 * it here means the reference the model sees is exactly the frame the editor
 * is looking at — no export step, no mismatch.
 *
 * The Photoshop round-trip works the same way. The file opens in Photoshop,
 * the user paints on it, saves over it, and the panel notices the file changed
 * and picks the new version up. Nothing to re-import.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { selectActiveShot, useApp } from '../state/store';
import type { FormField } from '../workflows/form';
import { ae, isErr } from '../bridge/extendscript';
import {
  basename, copyFile, fileMtime, fileSize, humanSize, nodeAvailable, pathJoin, pathToFileUrl, writeBlobToFile,
} from '../lib/fs';
import { captureFrameName, captureWorkAreaName } from '../lib/filenames';
import { ensureCaptureFolder, resolveFlowRoot, sanitizeName } from '../lib/assets';
import { isPhotoshopOpenSupported, openInPhotoshop } from '../lib/external';
import { AssetPreview } from './AssetPreview';

interface Props {
  field: FormField;
}

type Kind = 'image' | 'video' | 'audio';

export function FilePickerRow({ field }: Props): JSX.Element {
  const kind = field.kind as Kind;
  const shot = useApp(useShallow(selectActiveShot));
  const setSegmentAttachment = useApp((s) => s.setSegmentAttachment);
  const setPlayheadAttachment = useApp((s) => s.setPlayheadAttachment);
  const settings = useApp((s) => s.settings);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [editedAt, setEditedAt] = useState<number | null>(null);
  const [bust, setBust] = useState(0);

  const att = shot.attachments.find((a) => a.fieldId === field.id);
  const size = useMemo(() => (att ? fileSize(att.localPath) : null), [att?.localPath, bust]);

  const set = (a: { kind: Kind; localPath: string; filename: string } | null): void => {
    if (shot.scope === 'segment' && shot.scopeId) setSegmentAttachment(shot.scopeId, field.id, a);
    else setPlayheadAttachment(field.id, a);
    setEditedAt(null);
  };

  /* Notice a Photoshop save: same path, new mtime. */
  const watchRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => { if (watchRef.current) clearInterval(watchRef.current); }, []);

  const watchForEdit = (path: string): void => {
    const start = fileMtime(path);
    if (watchRef.current) clearInterval(watchRef.current);
    watchRef.current = setInterval(() => {
      const now = fileMtime(path);
      if (now !== null && start !== null && now > start) {
        setEditedAt(now);
        setBust((b) => b + 1);
        if (watchRef.current) clearInterval(watchRef.current);
        watchRef.current = null;
      }
    }, 1500);
  };

  const captureDir = async (compName: string): Promise<string> => {
    const root = await resolveFlowRoot(settings);
    return ensureCaptureFolder(root.dir, sanitizeName(compName));
  };

  const useAeFrame = async (): Promise<void> => {
    setError(null); setBusy(true);
    try {
      if (!nodeAvailable()) throw new Error('The JustAE Flow server is not answering.');
      const comp = await ae.activeComp();
      if (!comp || typeof comp !== 'object' || !('name' in comp)) throw new Error('No active composition.');
      const dir = await captureDir(comp.name);
      const target = pathJoin(dir, captureFrameName(comp.name, comp.time, comp.frameRate, 'png'));
      const r = await ae.captureFrame(target);
      if (isErr(r)) throw new Error(r.error);
      set({ kind: 'image', localPath: r.path, filename: basename(r.path) });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const useWorkArea = async (): Promise<void> => {
    setError(null); setBusy(true);
    try {
      if (!nodeAvailable()) throw new Error('The JustAE Flow server is not answering.');
      const comp = await ae.activeComp();
      const compName = comp && typeof comp === 'object' && 'name' in comp ? comp.name : 'Composition';
      const r = await ae.renderWorkArea(settings.defaults.workAreaMaxDuration);
      if (isErr(r)) throw new Error(r.error);
      // The host renders to its own temp path — move it somewhere findable.
      const dir = await captureDir(compName);
      const ext = (r.path.split('.').pop() ?? 'mp4').toLowerCase();
      const dest = pathJoin(dir, captureWorkAreaName(compName, ext));
      let finalPath = r.path;
      try { copyFile(r.path, dest); finalPath = dest; } catch { /* keep the temp path */ }
      set({ kind: 'video', localPath: finalPath, filename: basename(finalPath) });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  /** A picked or dropped file, copied next to the captures so the workflow can upload it from disk. */
  const adoptFile = async (f: File): Promise<void> => {
    setError(null); setBusy(true);
    try {
      const comp = await ae.activeComp();
      const compName = comp && typeof comp === 'object' && 'name' in comp ? comp.name : 'Composition';
      const dest = pathJoin(await captureDir(compName), f.name.replace(/[<>:"/\\|?*]+/g, '_'));
      await writeBlobToFile(f, dest);
      set({ kind, localPath: dest, filename: f.name });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  };

  const browse = (): void => {
    setError(null);
    const el = document.createElement('input');
    el.type = 'file';
    el.accept = kind === 'image' ? 'image/*' : kind === 'video' ? 'video/*' : 'audio/*';
    el.onchange = () => {
      const f = el.files?.[0];
      if (f) void adoptFile(f);
    };
    el.click();
  };

  const editInPhotoshop = (): void => {
    if (!att) return;
    setError(null);
    const r = openInPhotoshop(att.localPath);
    if (!r.ok) { setError(r.error ?? 'Could not open Photoshop.'); return; }
    watchForEdit(att.localPath);
  };

  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault(); e.stopPropagation(); setDragOver(false);
    const f = e.dataTransfer?.files?.[0];
    if (f) void adoptFile(f);
  };

  const baked = typeof field.value === 'string' && field.value ? field.value : null;

  return (
    <div
      className={'jae-stable space-y-2 rounded-lg border p-2.5 transition-colors '
        + (dragOver ? 'border-brand bg-brand/5' : 'border-line bg-bg')}
      onDrop={onDrop}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragEnter={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={(e) => { e.preventDefault(); setDragOver(false); }}
    >
      {att ? (
        <>
          <button
            type="button"
            className="block w-full overflow-hidden rounded-md border border-line bg-bg-subtle"
            onClick={() => setPreview(true)}
            title="Click to preview"
          >
            <Thumb kind={att.kind} path={att.localPath} bust={bust} />
          </button>
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate font-mono text-[10px] text-ink-mute" title={att.localPath}>
              {att.filename}{size !== null ? ` · ${humanSize(size)}` : ''}
            </span>
            <button className="btn-quiet h-6 shrink-0 px-2 text-[11px]" onClick={() => set(null)} title="Remove">✕</button>
          </div>
          {editedAt && (
            <p className="text-[10px] text-ok">
              Updated in Photoshop at {new Date(editedAt).toLocaleTimeString()} — the new version will be used.
            </p>
          )}
        </>
      ) : (
        <p className="text-[11px] text-ink-mute">
          {baked
            ? <>Using the file baked into the workflow: <span className="font-mono text-ink-dim">{baked}</span></>
            : 'Drop a file here, or pick one below.'}
        </p>
      )}

      <div className="flex flex-wrap gap-1.5">
        {kind === 'image' && (
          <button className="chip" onClick={() => void useAeFrame()} disabled={busy}>
            {busy ? '…' : 'Frame from comp'}
          </button>
        )}
        {kind === 'video' && (
          <button className="chip" onClick={() => void useWorkArea()} disabled={busy}>
            {busy ? '…' : 'Work area as clip'}
          </button>
        )}
        <button className="chip" onClick={browse} disabled={busy}>Browse…</button>
        {att && kind === 'image' && isPhotoshopOpenSupported() && (
          <button className="chip" onClick={editInPhotoshop} disabled={busy}>Edit in Photoshop</button>
        )}
      </div>

      {error && <p className="text-[11px] leading-snug text-err">{error}</p>}

      {preview && att && (
        <AssetPreview
          kind={att.kind}
          path={att.localPath}
          filename={att.filename}
          onClose={() => setPreview(false)}
        />
      )}
    </div>
  );
}

function Thumb({ kind, path, bust }: { kind: Kind; path: string; bust: number }): JSX.Element {
  // The cache-buster matters after a Photoshop save: same URL, new bytes.
  const src = `${pathToFileUrl(path)}${bust > 0 ? `?v=${bust}` : ''}`;
  if (kind === 'image') {
    return <img src={src} alt="" className="h-24 w-full object-contain" />;
  }
  if (kind === 'video') {
    return <video src={src} className="h-24 w-full object-contain" muted preload="metadata" />;
  }
  return (
    <div className="grid h-16 w-full place-items-center text-[11px] text-ink-mute">audio file</div>
  );
}
