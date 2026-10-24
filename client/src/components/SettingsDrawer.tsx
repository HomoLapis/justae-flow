/**
 * Settings — which server runs the workflows, and how the panel behaves on
 * the timeline.
 */

import { useState } from 'react';
import { useApp } from '../state/store';
import { buildProvider, providerConfig, PROVIDERS, V2_TARGETS } from '../providers/registry';
import type { V2Target } from '../providers/types';

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
        {/* ── Provider ─────────────────────────────────────── */}
        <section className="space-y-2">
          <h3 className="section-label">Where workflows run</h3>
          <div className="space-y-1">
            {PROVIDERS.map((p) => (
              <label
                key={p.id}
                className={'flex cursor-pointer items-start gap-2 rounded-lg border p-2.5 transition-colors '
                  + (settings.provider === p.id ? 'border-brand bg-brand/5' : 'border-line hover:bg-bg-subtle')}
              >
                <input
                  type="radio"
                  className="mt-0.5"
                  checked={settings.provider === p.id}
                  onChange={() => setSettings({ provider: p.id })}
                />
                <span className="min-w-0">
                  <span className="block text-xs text-ink">{p.label}</span>
                  <span className="block text-[10px] leading-snug text-ink-mute">{p.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </section>

        {settings.provider === 'local-comfy' && (
          <section className="space-y-2">
            <h3 className="section-label">Local ComfyUI</h3>
            <Field label="Address">
              <input
                className="input text-xs"
                value={settings.localComfyUrl}
                placeholder="http://127.0.0.1:8188"
                onChange={(e) => setSettings({ localComfyUrl: e.target.value })}
              />
            </Field>
            <p className="text-[10px] leading-snug text-ink-mute">
              Start ComfyUI with <span className="font-mono text-ink-dim">python main.py --listen 127.0.0.1</span>.
              The Workflow tab reads its workflow folder directly and opens its editor in a new tab.
            </p>
          </section>
        )}

        {settings.provider === 'comfy-v2' && <DeveloperPlatformSection />}

        {settings.provider === 'comfy-cloud' && (
          <section className="space-y-2">
            <h3 className="section-label">ComfyCloud (v1 API)</h3>
            <p className="text-[10px] leading-snug text-warn">
              Comfy has deprecated the v1 Cloud API in favour of v2. The same Comfy Cloud is under
              Comfy Developer Platform → Comfy Cloud; this stays for workflows that already use it.
            </p>
            <Field label="API key">
              <input
                className="input text-xs"
                type="password"
                value={settings.comfyCloudApiKey}
                placeholder="comfyui-…"
                onChange={(e) => setSettings({ comfyCloudApiKey: e.target.value })}
              />
            </Field>
            <p className="text-[10px] leading-snug text-ink-mute">
              From platform.comfy.org → API Keys. ComfyCloud's editor lives on its own signed-in
              domain, so it can't be embedded here — export a workflow there and import the file in
              the Workflow tab.
            </p>
          </section>
        )}

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
              <option value="none">Don't scale (1:1)</option>
              <option value="fit">Fit inside the comp</option>
              <option value="fill">Fill the comp (crops)</option>
            </select>
          </Field>
          <p className="text-[10px] leading-snug text-ink-mute">
            1:1 is the default on purpose. Scaling a generated clip costs quality in a way that's
            hard to spot on a small preview, so it only happens if you ask for it.
          </p>

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

          <Field label="Work-area render cap (seconds)">
            <input
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
          Keys and tokens are kept in this browser's local storage for this page, unencrypted, and
          only ever sent to the server you chose here. Treat this machine as trusted, or clear them
          when you're done.
        </p>
      </div>
    </div>
  );
}

/**
 * Comfy API v2, on whichever of its three surfaces the user runs.
 *
 * Nothing here creates, builds or starts anything on the platform: the panel
 * only talks to an endpoint the user already has, with the key they paste.
 */
function DeveloperPlatformSection(): JSX.Element {
  const settings = useApp((s) => s.settings);
  const setSettings = useApp((s) => s.setSettings);
  const target = settings.comfyV2Target;
  const [check, setCheck] = useState<{ busy: boolean; text: string; ok: boolean | null }>(
    { busy: false, text: '', ok: null },
  );

  const pick = (next: V2Target): void => {
    if (next === target) return;
    // A preset URL follows its target; a pasted deployment URL is not thrown away
    // by a click, only replaced when another preset takes its place.
    const presets = Object.values(V2_TARGETS).map((t) => t.url).filter(Boolean);
    const keep = next === 'deployment' && !presets.includes(settings.comfyV2Url);
    setSettings({
      comfyV2Target: next,
      comfyV2Url: keep ? settings.comfyV2Url : V2_TARGETS[next].url,
    });
    setCheck({ busy: false, text: '', ok: null });
  };

  const runCheck = async (): Promise<void> => {
    setCheck({ busy: true, text: 'Checking…', ok: null });
    try {
      const h = await buildProvider('comfy-v2', providerConfig(useApp.getState().settings)).health();
      setCheck({ busy: false, ok: h.online, text: h.online ? 'Connected — the endpoint accepted the key.' : (h.message ?? 'Unavailable') });
    } catch (e) {
      setCheck({ busy: false, ok: false, text: e instanceof Error ? e.message : String(e) });
    }
  };

  const isProxy = target === 'proxy';
  const deploymentUrlOdd = target === 'deployment' && settings.comfyV2Url !== ''
    && !/^https:\/\/[^/]+\.run\.comfy\.app$/.test(settings.comfyV2Url);

  return (
    <section className="space-y-2">
      <h3 className="section-label">Comfy Developer Platform</h3>

      <div className="grid grid-cols-3 gap-1">
        {(Object.keys(V2_TARGETS) as V2Target[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => pick(t)}
            className={'rounded-lg px-2 py-1.5 text-[11px] font-medium transition-colors '
              + (target === t ? 'bg-brand text-white' : 'bg-bg-subtle text-ink-dim hover:text-ink')}
          >
            {V2_TARGETS[t].label}
          </button>
        ))}
      </div>

      <Field label="Endpoint URL">
        <input
          className="input text-xs"
          value={settings.comfyV2Url}
          placeholder={V2_TARGETS[target].placeholder}
          onChange={(e) => setSettings({ comfyV2Url: e.target.value.trim().replace(/\/+$/, '') })}
        />
      </Field>
      {deploymentUrlOdd && (
        <p className="text-[10px] leading-snug text-warn">
          Deployment endpoints look like <span className="font-mono">https://&lt;deployment&gt;.run.comfy.app</span>.
          This one doesn&rsquo;t — fine if you know why, otherwise check it against{' '}
          <span className="font-mono">comfy deploy status</span>.
        </p>
      )}

      {isProxy ? (
        <Field label="Proxy token (optional)">
          <input
            className="input text-xs"
            type="password"
            value={settings.comfyV2ProxyToken}
            placeholder="Only if the proxy was started with --token"
            onChange={(e) => setSettings({ comfyV2ProxyToken: e.target.value.trim() })}
          />
        </Field>
      ) : (
        <Field label="API key">
          <input
            className="input text-xs"
            type="password"
            value={settings.comfyV2Token}
            placeholder="From platform.comfy.org → API Keys"
            onChange={(e) => setSettings({ comfyV2Token: e.target.value.trim() })}
          />
        </Field>
      )}

      <div className="flex items-center gap-2">
        <button className="btn-quiet h-7 px-3 text-xs" disabled={check.busy || !settings.comfyV2Url} onClick={() => void runCheck()}>
          Check connection
        </button>
        {check.text && (
          <span className={'min-w-0 text-[10px] leading-snug ' + (check.ok === true ? 'text-ok' : check.ok === false ? 'text-err' : 'text-ink-mute')}>
            {check.text}
          </span>
        )}
      </div>

      {target === 'deployment' && (
        <>
          <p className="text-[10px] leading-snug text-ink-mute">
            The endpoint of a deployment you made on the{' '}
            <ExternalLink href="https://platform.comfy.org">Comfy Developer Platform</ExternalLink>
            {' '}— <span className="font-mono text-ink-dim">comfy deploy status</span> prints it as{' '}
            <span className="font-mono text-ink-dim">endpointUrl</span>. The key comes from{' '}
            <ExternalLink href="https://platform.comfy.org/profile/api-keys">API Keys</ExternalLink> and
            works for Comfy Cloud too. A deployment runs against the environment it was built from,
            so a workflow has to use the nodes and models that build packed. How to make one:{' '}
            <ExternalLink href="https://docs.comfy.org/development/serverless/quickstart">quickstart</ExternalLink>.
          </p>
          <p className="text-[10px] leading-snug text-warn">
            A deployment bills for as long as it is running, not per job. Started with{' '}
            <span className="font-mono">--min 0</span> it scales to zero between jobs (the next one waits
            for a worker to start); <span className="font-mono">comfy deploy stop</span> ends the charge
            and keeps the endpoint URL. The panel never starts, scales or stops it for you.
          </p>
        </>
      )}
      {target === 'cloud' && (
        <p className="text-[10px] leading-snug text-ink-mute">
          Comfy&rsquo;s hosted ComfyUI, with the same platform{' '}
          <ExternalLink href="https://platform.comfy.org/profile/api-keys">API key</ExternalLink>. Jobs draw
          on the same credits as the Comfy Cloud web app.
        </p>
      )}
      {isProxy && (
        <p className="text-[10px] leading-snug text-ink-mute">
          Your own ComfyUI, speaking v2 through{' '}
          <ExternalLink href="https://docs.comfy.org/development/comfyui-server/api-proxy">comfy-api-proxy</ExternalLink>:
          {' '}<span className="font-mono text-ink-dim">pip install comfy-api-proxy</span>, then{' '}
          <span className="font-mono text-ink-dim">comfy-api-proxy</span> next to ComfyUI. It proxies{' '}
          <span className="font-mono text-ink-dim">127.0.0.1:8188</span> and serves{' '}
          <span className="font-mono text-ink-dim">127.0.0.1:8189</span>. Runs on your GPU — the same
          protocol a deployment speaks, so a workflow tested here moves there unchanged.
        </p>
      )}

      <p className="text-[10px] leading-snug text-ink-mute">
        Uploads are deduplicated by content hash, so a frame sent once is not sent again. In
        exchange v2 has no node catalogue and no workflow folder: a workflow must already be in
        API format — captured from a run, or exported from ComfyUI in API format — and live
        previews are not shown.
      </p>
    </section>
  );
}

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }): JSX.Element {
  return (
    <a className="text-brand underline-offset-2 hover:underline" href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
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
