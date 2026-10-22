import { useEffect, useRef } from 'react';

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSubmit?: () => void;
  placeholder?: string;
  disabled?: boolean;
}

export function PromptBox({ value, onChange, onSubmit, placeholder, disabled }: Props): JSX.Element {
  const ref = useRef<HTMLTextAreaElement>(null);

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

  return (
    <div className="relative">
      <textarea
        ref={ref}
        rows={3}
        value={value}
        disabled={disabled}
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
      <div className="mt-1.5 flex items-center justify-between text-[11px] text-ink-mute">
        <span>⌘/Ctrl + ↵ to generate</span>
        <span>{value.length} chars</span>
      </div>
    </div>
  );
}
