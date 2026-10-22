import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { pathToFileUrl } from '../lib/fs';

interface Props {
  kind: 'image' | 'video' | 'audio';
  path: string;
  filename: string;
  onClose: () => void;
}

/**
 * Full-panel preview of an attached asset.
 * Image  → centered <img>, shrunk until the whole frame fits.
 * Video  → <video controls> autoplaying with audio.
 * Audio  → centered card with <audio controls>.
 * ESC or backdrop click dismisses.
 *
 * This must mount in a PORTAL on <body>, not where it is used. The file row
 * carries `.jae-stable`, i.e. `contain: layout paint style`, and that `paint`
 * does two things to a positioned descendant: it becomes its containing block
 * *and* it clips it to the row's box. The preview sized itself against the
 * panel and was then cut off at the row's height — the image showed up
 * enlarged but chopped.
 *
 * For the same reason the media is measured as a percentage of the space that
 * is left, not in `vh`/`vw`: a CEP panel is often narrow and short, and an
 * image 80vh tall would not fit under the title bar anyway.
 */
export function AssetPreview({ kind, path, filename, onClose }: Props): JSX.Element {
  const src = pathToFileUrl(path);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex flex-col bg-black/85 p-3 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 pb-2">
        <span className="min-w-0 truncate font-mono text-[11px] text-ink-dim" title={path}>
          {filename}
        </span>
        <button
          type="button"
          className="btn-ghost h-7 shrink-0 px-2.5 text-[11px]"
          onClick={onClose}
        >
          Close (esc)
        </button>
      </div>

      {/*
        `min-h-0` on the box matters as much as `max-h-full` on the media:
        without it a flex child never shrinks below its natural size, and a
        large image would blow past the panel instead of scaling down.
      */}
      <div
        className="flex min-h-0 flex-1 items-center justify-center"
        onClick={(e) => e.stopPropagation()}
      >
        {kind === 'image' && (
          <img
            src={src}
            alt={filename}
            className="max-h-full max-w-full rounded-md border border-line bg-black object-contain"
          />
        )}
        {kind === 'video' && (
          <video
            src={src}
            controls
            autoPlay
            className="max-h-full max-w-full rounded-md border border-line bg-black"
          />
        )}
        {kind === 'audio' && (
          <div className="flex max-w-full flex-col items-center gap-3 rounded-md border border-line bg-bg-raised p-5">
            <AudioGlyph />
            <audio src={src} controls className="w-[260px] max-w-full" />
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

function AudioGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 64 64" width="64" height="64" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden className="text-ink-dim">
      <rect x="6"  y="22" width="4" height="20" rx="1" />
      <rect x="16" y="14" width="4" height="36" rx="1" />
      <rect x="26" y="18" width="4" height="28" rx="1" />
      <rect x="36" y="10" width="4" height="44" rx="1" />
      <rect x="46" y="18" width="4" height="28" rx="1" />
      <rect x="56" y="22" width="4" height="20" rx="1" />
    </svg>
  );
}
