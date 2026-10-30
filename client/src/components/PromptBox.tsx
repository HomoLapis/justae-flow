import { useEffect, useRef, useState } from 'react';
import { useApp } from '../state/store';
import { useAssist, type AssistContext } from '../lib/assist';

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSubmit?: () => void;
  placeholder?: string;
  disabled?: boolean;
  /** Given, the box offers ✦ Improve: the prompt assistant rewrites the text for this shot. */
  assist?: AssistContext;
}

export function PromptBox({ value, onChange, onSubmit, placeholder, disabled, assist }: Props): JSX.Element {
  const ref = useRef<HTMLTextAreaElement>(null);
  const provider = useAssist((s) => s.view?.provider ?? null);
  const loadAssist = useAssist((s) => s.load);
  const improve = useAssist((s) => s.improve);
  const openSettings = useApp((s) => s.setSettingsOpen);
  const [busy, setBusy] = useState(false);
  const [before, setBefore] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  // Autosize: grow with content up to ~6 lines
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [value]);

  useEffect(() => {
    if (assist && provider === null) void loadAssist();
  }, [assist, provider, loadAssist]);

  const run = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const out = await improve(value, assist ?? {});
      setBefore(value);
      onChange(out);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative">
      <textarea
        ref={ref}
        rows={3}
        value={value}
        disabled={disabled || busy}
        placeholder={placeholder ?? 'Describe what you want to generate…'}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            onSubmit?.();
          }
        }}
        className="input jae-stable-text resize-none leading-relaxed min-h-[88px]"
      />
      <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] text-ink-mute">
        <span>⌘/Ctrl + ↵ to generate</span>
        {assist && provider !== null && (
          <span className="flex items-center gap-2" data-testid="prompt-assist">
            {provider === 'off' ? (
              <button type="button" className="hover:text-ink" onClick={() => openSettings(true)} title="Settings ▸ Prompt assistant">
                ✦ assistant off
              </button>
            ) : (
              <>
                {before !== null && !busy && (
                  <button type="button" className="hover:text-ink" onClick={() => { onChange(before); setBefore(null); }}>Undo</button>
                )}
                <button
                  type="button"
                  className="text-ink-dim hover:text-ink disabled:opacity-50"
                  disabled={busy || disabled || value.trim().length < 3}
                  onClick={() => void run()}
                  title="Rewrite this as a prompt the model can use"
                >
                  ✦ {busy ? 'Writing…' : 'Improve'}
                </button>
              </>
            )}
          </span>
        )}
        <span>{value.length} chars</span>
      </div>
      {error && <p className="mt-1 text-[11px] leading-snug text-err">{error}</p>}
    </div>
  );
}
