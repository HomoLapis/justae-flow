import type { JobPhase } from '../state/store';

interface Props {
  phase: JobPhase;
  disabled?: boolean;
  onGenerate: () => void;
  onCancel: () => void;
  /** Override the "idle" / "done" label — useful when running a batch. */
  customIdleLabel?: string;
}

const LABELS: Record<JobPhase, string> = {
  idle: 'Generate',
  submitting: 'Submitting…',
  queued: 'Queued — cancel',
  running: 'Generating — cancel',
  done: 'Generate again',
  error: 'Retry',
  cancelled: 'Generate',
};

export function GenerateButton({ phase, disabled, onGenerate, onCancel, customIdleLabel }: Props): JSX.Element {
  const isBusy = phase === 'queued' || phase === 'running' || phase === 'submitting';
  const onClick = isBusy ? onCancel : onGenerate;
  const label =
    isBusy || !customIdleLabel || phase === 'error'
      ? LABELS[phase]
      : customIdleLabel;

  return (
    <button
      type="button"
      className={isBusy ? 'btn-ghost w-full h-12 text-base' : 'btn-primary w-full h-12 text-base'}
      onClick={onClick}
      disabled={disabled && !isBusy}
    >
      {isBusy && <Spinner />}
      {label}
    </button>
  );
}

function Spinner(): JSX.Element {
  return (
    <svg
      className="h-4 w-4 animate-spin"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
