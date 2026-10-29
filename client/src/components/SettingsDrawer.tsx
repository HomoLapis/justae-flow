/**
 * Settings — where workflows run (Settings ▸ Resources, kept by the server),
 * and how the panel behaves on the timeline.
 */

import { useApp } from '../state/store';
import { useReadiness } from '../lib/readiness';
import { ResourcesSettings } from './ResourcesSettings';
import { DraftDelivery } from './PipelineLibrary';

export function SettingsDrawer(): JSX.Element | null {
  const open = useApp((s) => s.settingsOpen);
  const setOpen = useApp((s) => s.setSettingsOpen);
  const settings = useApp((s) => s.settings);
  const setSettings = useApp((s) => s.setSettings);
  const setDefaults = useApp((s) => s.setSettingsDefaults);

  if (!open) return null;

  return (
    <div className="absolute inset-0 z-50 flex flex-col bg-bg">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-line px-3.5">
        <h2 className="text-sm font-semibold text-ink">Settings</h2>
        <button className="btn-quiet h-8 px-3 text-xs" onClick={() => setOpen(false)}>Done</button>
      </header>

      <div className="flex-1 space-y-5 overflow-y-auto px-3.5 py-4">
        <GetStartedRow onShow={() => setOpen(false)} />
        <ResourcesSettings />

        {/* ── Timeline behaviour ───────────────────────────── */}
        <section className="space-y-2">
          <h3 className="section-label">On the timeline</h3>

          <Toggle
            checked={settings.defaults.aeAutoFill}
            onChange={(v) => setDefaults({ aeAutoFill: v })}
            label="Let EffectCraft fill size and length"
            hint="Canvas size and shot duration go into the workflow's matching fields — including when they are wired in from a primitive or a resizer. Any field can still be taken over one at a time."
          />

          {/*
            The escape hatch for a graph nobody can read.
            The panel follows the wires back from the video node's own inputs,
            which covers the usual shapes; a workflow that computes its size or
            its length some other way needs one word from its author, and this
            is where that word is documented.
          */}
          <p className="rounded-lg border border-line bg-bg-subtle px-2.5 py-2 text-[10px] leading-snug text-ink-mute">
            When a shot row says the size or the length is <em>not driven</em>, put a tag in that
            node&rsquo;s title in ComfyUI and the panel will fill it:{' '}
            <code className="text-ink">[AE_WIDTH]</code>, <code className="text-ink">[AE_HEIGHT]</code>,{' '}
            <code className="text-ink">[AE_LONGEST]</code>, <code className="text-ink">[AE_SHORTEST]</code>,{' '}
            <code className="text-ink">[AE_SECONDS]</code>, <code className="text-ink">[AE_FRAMES]</code>,{' '}
            <code className="text-ink">[AE_FPS]</code>. A tag always wins over the panel&rsquo;s own reading.
          </p>

          <DraftDelivery />

          <Toggle
            checked={settings.defaults.autoImport}
            onChange={(v) => setDefaults({ autoImport: v })}
            label="Place the clip when it's done"
            hint="Off means the file is saved to the shot folder and nothing is added to the comp."
          />

          <Field label="Scale generated clips">
            <select
              className="input text-xs"
              value={settings.defaults.fitMode}
              onChange={(e) => setDefaults({ fitMode: e.target.value as 'none' | 'fit' | 'fill' })}
            >
              <option value="fill">Fill the comp (default)</option>
              <option value="fit">Fit inside the comp</option>
              <option value="none">Don't scale (1:1)</option>
            </select>
          </Field>
          <p className="text-[10px] leading-snug text-ink-mute">
            A shot is generated at the comp's aspect, as large as its model allows, then scaled to cover the comp;
            only the model's rounding (a few pixels) is cropped. 1:1 keeps the clip at its generated size.
          </p>

          <Toggle
            checked={settings.defaults.upscaleToComp}
            onChange={(v) => setDefaults({ upscaleToComp: v })}
            label="Upscale to the comp size when the clip comes out smaller"
            hint="The tick a shot row shows under its size when its model stops below the comp (MiniMax H3 at 1344 px, LTX-2.5 at 1280). On: SeedVR2 ×2 runs on the result first, a second job on the same resource; the first result stays in the shot folder. Off: the clip is enlarged as it is."
          />

          <Field label="Seed">
            <div className="flex gap-2">
              <select
                className="input flex-1 text-xs"
                value={settings.defaults.seedMode}
                onChange={(e) => setDefaults({ seedMode: e.target.value as 'random' | 'fixed' })}
              >
                <option value="random">New each time</option>
                <option value="fixed">Fixed</option>
              </select>
              {settings.defaults.seedMode === 'fixed' && (
                <input
                  className="input w-28 text-xs"
                  type="number"
                  value={settings.defaults.fixedSeed}
                  onChange={(e) => setDefaults({ fixedSeed: parseInt(e.target.value, 10) || 0 })}
                />
              )}
            </div>
          </Field>

          <Field label="Work-area render cap (seconds) — also the longest render the Comp tab makes of a work area or a whole comp">
            <input
              id="work-area-cap"
              className="input text-xs"
              type="number"
              min={1}
              max={60}
              value={settings.defaults.workAreaMaxDuration}
              onChange={(e) => setDefaults({ workAreaMaxDuration: parseInt(e.target.value, 10) || 8 })}
            />
          </Field>
        </section>

        {/* ── Where files go ───────────────────────────────── */}
        <section className="space-y-2">
          <h3 className="section-label">Where files go</h3>
          <Field label="Override folder (optional)">
            <input
              className="input text-xs"
              value={settings.outputDir}
              placeholder="Leave empty to keep everything next to the project"
              onChange={(e) => setSettings({ outputDir: e.target.value })}
            />
          </Field>
          <p className="text-[10px] leading-snug text-ink-mute">
            By default each generation gets its own folder next to the .ecproj:
            {' '}<span className="font-mono text-ink-dim">&lt;Project&gt;_JustAE-Flow/&lt;Comp&gt;/shot_001_…/</span>
            {' '}with its inputs, its output, the workflow that ran and a job.json recording every
            value used. If the project has never been saved there's nowhere sensible to put that, so
            it goes to a temp folder and the panel says so.
          </p>
        </section>

        <p className="pb-4 text-[10px] leading-snug text-ink-mute">
          The API key and the proxy token are kept by the JustAE Flow server in your user folder (the files
          named above), never in this page or the project, and only ever sent to the resource they are for —
          over https, or over plain http to this machine.
        </p>
      </div>
    </div>
  );
}

/** Settings ▸ Get started: the card back on the Workflow tab, and the model list. */
function GetStartedRow({ onShow }: { onShow: () => void }): JSX.Element {
  const setOnboarding = useReadiness((s) => s.setOnboarding);
  const openPicker = useReadiness((s) => s.setOpen);
  const setTab = useApp((s) => s.setTab);
  const mode = useReadiness((s) => s.data?.onboarding.mode);
  return (
    <section className="space-y-2" data-testid="settings-get-started">
      <h3 className="section-label">Get started</h3>
      <div className="flex flex-wrap items-center gap-1.5">
        <button className="chip" onClick={() => { void setOnboarding('open'); setTab('workflow'); onShow(); }} data-testid="show-get-started">
          Show the Get started card
        </button>
        <button className="chip" onClick={() => { onShow(); openPicker(true); }}>Get the models…</button>
        {mode === 'open' && <span className="text-[10px] text-ink-mute">shown on the Workflow tab until you hide it</span>}
      </div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] text-ink-dim">{label}</span>
      {children}
    </label>
  );
}

function Toggle({
  checked, onChange, label, hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}): JSX.Element {
  return (
    <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-line p-2.5 transition-colors hover:bg-bg-subtle">
      <input type="checkbox" className="mt-0.5" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="min-w-0">
        <span className="block text-xs text-ink">{label}</span>
        {hint && <span className="block text-[10px] leading-snug text-ink-mute">{hint}</span>}
      </span>
    </label>
  );
}
