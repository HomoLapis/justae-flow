/**
 * The workflow's own controls, rendered natively.
 *
 * Every row comes from workflows/form.ts, which prefers the arrangement the
 * workflow's author built in ComfyUI's App Builder and falls back to reading
 * the graph. Fields After Effects can answer for itself — canvas size, clip
 * length, frame rate — are filled in and marked, with the reason on the badge,
 * and a click hands the field back to the user.
 */

import { useMemo } from 'react';
import { useApp } from '../state/store';
import type { AeContext, FormField } from '../workflows/form';
import { computeAutoFill } from '../workflows/form';
import { FilePickerRow } from './FilePickerRow';

/**
 * Stable empty default. A selector must never allocate: React's
 * useSyncExternalStore needs a referentially stable snapshot when nothing
 * changed, and `?? { pinned: [], hidden: [] }` builds a new object every call.
 */
const EMPTY_PREFS: { pinned: string[]; hidden: string[] } = Object.freeze({
  pinned: Object.freeze([]) as unknown as string[],
  hidden: Object.freeze([]) as unknown as string[],
});

interface Props {
  /** Values live per workflow, so a batch can mix workflows across shots. */
  workflowId: string;
  fields: FormField[];
  aeContext: AeContext;
  /**
   * The field the shot row's own prompt box owns, so it is not shown twice.
   * An id rather than a flag, because the user can point the prompt at a
   * different box than the inspector chose.
   */
  hidePromptId?: string | null;
}

export function DynamicForm({ workflowId, fields, aeContext, hidePromptId }: Props): JSX.Element | null {
  const values = useApp((s) => s.values[workflowId]);
  const setValue = useApp((s) => s.setValue);
  const unlocked = useApp((s) => s.unlockedFields);
  const toggleLock = useApp((s) => s.toggleFieldLock);
  const autoFillOn = useApp((s) => s.settings.defaults.aeAutoFill);
  const prefs = useApp((s) => s.fieldPrefs[workflowId]) ?? EMPTY_PREFS;
  const togglePin = useApp((s) => s.toggleFieldPin);
  const toggleHidden = useApp((s) => s.toggleFieldHidden);
  const resetPrefs = useApp((s) => s.resetFieldPrefs);

  const auto = useMemo(
    () => (autoFillOn ? computeAutoFill(fields, aeContext) : { values: {}, reasons: {} }),
    [fields, aeContext, autoFillOn],
  );

  const visible = fields.filter((f) => f.id !== hidePromptId);

  /*
   * The user's own arrangement wins over ours.
   *
   * The ranking in form.ts reads the graph and is right often enough to be
   * useful and wrong often enough to be annoying — it cannot know that this
   * user only ever touches three of the fifteen it chose, or that the knob
   * they need is the one it filed under "All controls". Pinning promotes,
   * hiding demotes, both stick to this workflow, and neither ever deletes: a
   * hidden field is still in the list below, still sent, still editable.
   */
  const pinned = new Set(prefs.pinned);
  const hidden = new Set(prefs.hidden);
  const inMain = (f: FormField): boolean =>
    pinned.has(f.id) || (!f.advanced && !hidden.has(f.id));

  const main = visible.filter(inMain)
    // Pinned first, and in the order they were pinned, so the list the user
    // built stays the list they see.
    .sort((a, b) => (pinned.has(b.id) ? 1 : 0) - (pinned.has(a.id) ? 1 : 0));
  const advanced = visible.filter((f) => !inMain(f));

  if (visible.length === 0) return null;

  // Lock state is keyed by workflow too: two workflows can both hold a field
  // called "6.width", and taking one over must not silently take the other.
  const lockKey = (f: FormField): string => `${workflowId}::${f.id}`;

  const row = (f: FormField): JSX.Element => {
    const isAuto = f.id in auto.values && !unlocked.includes(lockKey(f));
    const shown = isAuto ? auto.values[f.id] : values?.[f.id] ?? f.value;
    return (
      <FieldRow
        key={f.id}
        field={f}
        value={shown}
        auto={isAuto ? auto.reasons[f.id] : null}
        canAuto={f.id in auto.values}
        onChange={(v) => setValue(workflowId, f.id, v)}
        onToggleLock={() => toggleLock(lockKey(f))}
        pinned={pinned.has(f.id)}
        inMain={inMain(f)}
        onTogglePlacement={() => (inMain(f)
          ? toggleHidden(workflowId, f.id)
          : togglePin(workflowId, f.id))}
      />
    );
  };

  const curated = prefs.pinned.length + prefs.hidden.length > 0;

  return (
    <div className="space-y-2.5">
      {main.map(row)}

      {advanced.length > 0 && (
        <details className="card group">
          <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-[11px] text-ink-dim hover:text-ink">
            <span className="section-label">All controls ({advanced.length})</span>
            <span className="text-ink-mute transition-transform group-open:rotate-180">⌄</span>
          </summary>
          <div className="divider space-y-2.5 px-3 pb-3 pt-3">
            <p className="text-[10px] leading-snug text-ink-mute">
              Every control this workflow has. Use ↑ to keep one at the top for this workflow;
              the ones marked <em>no effect</em> sit on a branch nothing outputs, so changing
              them does nothing.
            </p>
            {advanced.map(row)}
          </div>
        </details>
      )}

      {curated && (
        <button
          type="button"
          className="text-[10px] text-ink-mute underline-offset-2 hover:text-ink hover:underline"
          onClick={() => resetPrefs(workflowId)}
        >
          Reset this workflow&rsquo;s field layout
        </button>
      )}
    </div>
  );
}

interface RowProps {
  field: FormField;
  value: string | number | boolean;
  /** Why After Effects filled this in, when it did. */
  auto: string | null;
  canAuto: boolean;
  onChange: (v: string | number | boolean) => void;
  onToggleLock: () => void;
  pinned: boolean;
  /** Whether this row is currently in the top list rather than All controls. */
  inMain: boolean;
  onTogglePlacement: () => void;
}

function FieldRow({
  field, value, auto, canAuto, onChange, onToggleLock, pinned, inMain, onTogglePlacement,
}: RowProps): JSX.Element {
  const label = (
    <div className="mb-1 flex items-center gap-1.5">
      <span className="truncate text-[11px] text-ink-dim" title={`${field.nodeId} · ${field.field}`}>
        {field.label}
      </span>
      {field.inactive && (
        <span
          className="shrink-0 rounded bg-bg-subtle px-1.5 py-px text-[9px] uppercase tracking-wide text-ink-mute"
          title="This node feeds nothing the workflow outputs, so this control has no effect on the result."
        >
          no effect
        </span>
      )}
      <button
        type="button"
        onClick={onTogglePlacement}
        title={inMain
          ? 'Move this control into All controls for this workflow'
          : 'Keep this control at the top for this workflow'}
        className={
          'ml-auto shrink-0 rounded px-1.5 py-px text-[10px] leading-none transition-colors '
          + (pinned ? 'bg-brand/15 text-brand hover:bg-brand/25' : 'text-ink-mute hover:text-ink')
        }
      >
        {inMain ? '↓' : '↑'}
      </button>
      {canAuto && (
        <button
          type="button"
          onClick={onToggleLock}
          title={auto ?? 'EffectCraft can fill this in — click to hand it back'}
          className={
            'shrink-0 rounded px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide transition-colors '
            + (auto
              ? 'bg-brand/15 text-brand hover:bg-brand/25'
              : 'bg-bg-subtle text-ink-mute hover:text-ink')
          }
        >
          {auto ? 'from comp' : 'manual'}
        </button>
      )}
    </div>
  );

  const help = field.help ? (
    <p className="mt-1 text-[10px] leading-snug text-ink-mute">{field.help}</p>
  ) : null;

  if (field.kind === 'image' || field.kind === 'video' || field.kind === 'audio') {
    return (
      <div>
        {label}
        <FilePickerRow field={field} />
        {help}
      </div>
    );
  }

  if (field.kind === 'boolean') {
    // Header first, like every other kind, so a switch can be pinned or
    // demoted too — on some workflows the switch IS the control that matters.
    return (
      <div>
        {label}
        <label className="flex cursor-pointer items-center justify-between gap-2 rounded-lg border border-line bg-bg p-2 transition-colors hover:bg-bg-subtle">
          <span className="truncate text-xs text-ink">{value ? 'On' : 'Off'}</span>
          <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
        </label>
        {help}
      </div>
    );
  }

  if (field.kind === 'combo') {
    const options = field.options ?? [];
    // A combo whose choices we couldn't read (offline, custom node) still has
    // to be editable, or the workflow becomes unusable — fall back to text.
    if (options.length === 0) {
      return (
        <label className="block">
          {label}
          <input className="input text-xs" value={String(value)} onChange={(e) => onChange(e.target.value)} />
          {help}
        </label>
      );
    }
    return (
      <label className="block">
        {label}
        <select className="input text-xs" value={String(value)} onChange={(e) => onChange(e.target.value)}>
          {!options.includes(String(value)) && <option value={String(value)}>{String(value)}</option>}
          {options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
        {help}
      </label>
    );
  }

  if (field.kind === 'int' || field.kind === 'float') {
    return (
      <label className="block">
        {label}
        <input
          type="number"
          className={'input text-xs' + (auto ? ' text-brand' : '')}
          readOnly={!!auto}
          step={field.step ?? (field.kind === 'int' ? 1 : 0.01)}
          min={field.min}
          max={field.max}
          value={Number(value)}
          onChange={(e) => {
            const n = field.kind === 'int' ? parseInt(e.target.value, 10) : parseFloat(e.target.value);
            if (Number.isFinite(n)) onChange(n);
          }}
          title={auto ?? undefined}
        />
        {auto ? <p className="mt-1 text-[10px] leading-snug text-brand/80">{auto}</p> : help}
      </label>
    );
  }

  if (field.kind === 'multiline') {
    return (
      <label className="block">
        {label}
        <textarea
          className="input min-h-[70px] resize-y text-xs leading-relaxed"
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
        />
        {help}
      </label>
    );
  }

  return (
    <label className="block">
      {label}
      <input className="input text-xs" value={String(value)} onChange={(e) => onChange(e.target.value)} />
      {help}
    </label>
  );
}
