/**
 * Settings ▸ Resources: where workflows run, one API key for all of Comfy's
 * platform, and which resource each task uses (PLAN v3 §2.1).
 *
 * Everything here lives on the JustAE Flow server, in the user's config
 * folder — the key in a file of its own. This page sends a key once and never
 * gets it back: it is shown as "set · ends ab12". Nothing here creates,
 * builds, starts, scales or stops anything on the platform.
 */

import { useEffect, useState } from 'react';
import { serverJson } from '../bridge/server';
import { putHfToken, useReadiness } from '../lib/readiness';
import { FolderLine } from './ModelPicker';
import {
  clock, creditsTooltip, formatCredits, useResources,
  type Capabilities, type ResourcePatch, type ResourceView,
} from '../lib/resources';

const ICON: Record<ResourceView['kind'], string> = { local: '⌂', cloud: '☁', deployment: '▣', proxy: '⇄' };

export function ResourcesSettings(): JSX.Element {
  const data = useResources((s) => s.data);
  const save = useResources((s) => s.save);
  const load = useResources((s) => s.load);
  const [error, setError] = useState<string | null>(null);

  if (!data) {
    return (
      <section className="space-y-2">
        <h3 className="section-label">Resources</h3>
        <p className="text-[11px] text-ink-mute">Reading them from the JustAE Flow server…</p>
      </section>
    );
  }

  const apply = async (patch: ResourcePatch): Promise<void> => {
    setError(null);
    try { await save(patch); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const local = data.resources.find((r) => r.kind === 'local')!;
  const cloud = data.resources.find((r) => r.kind === 'cloud')!;
  const deployments = data.resources.filter((r) => r.kind === 'deployment');
  const proxy = data.resources.find((r) => r.kind === 'proxy')!;

  return (
    <div className="space-y-5" data-testid="settings-resources">
      <section className="space-y-2">
        <h3 className="section-label">Resources</h3>
        <ResourceCard r={local} caps={data.capabilities[local.id]} onCheck={load}>
          <UrlField value={local.url} placeholder="http://127.0.0.1:8188" onSave={(url) => apply({ resources: [{ id: local.id, url }] })} />
          <p className="text-[10px] leading-snug text-ink-mute">
            Your GPU, no credits. The Workflow tab lists this ComfyUI&rsquo;s workflow folder and opens its editor.
          </p>
          <FolderLine onSaved={() => void useReadiness.getState().load()} />
          <HfTokenField />
        </ResourceCard>
      </section>

      <section className="space-y-2">
        <h3 className="section-label">Comfy account</h3>
        <KeyField
          set={data.key.set} tail={data.key.tail} file={data.key.file}
          label="API key" placeholder="From platform.comfy.org → API Keys"
          onSave={(k) => apply({ apiKey: k })}
        />
        <p className="text-[10px] leading-snug text-ink-mute">
          One key for Comfy Cloud and your deployments (v2 as a bearer token, v1 as X-API-Key). It is kept in
          the file above, on this machine only, and never sent to this page again. How to set up the Comfy Developer
          Platform (no GPU here): <button className="text-brand hover:underline" onClick={() => useReadiness.getState().setReadme('no-gpu-the-comfy-developer-platform')}>Setup guide</button>.
        </p>

        <ResourceCard r={cloud} caps={data.capabilities[cloud.id]} onCheck={load} toggle={(on) => apply({ resources: [{ id: cloud.id, enabled: on }] })}>
          <CloudBalance />
          <p className="text-[10px] leading-snug text-ink-mute">
            {cloud.gpuLabel} · {cloud.creditsPerHour} cr/h of GPU time while a job runs (comfy.org/cloud/pricing; 211 cr = $1).
            Cost per job is derived: execution time × that rate.
          </p>
        </ResourceCard>

        {deployments.map((d) => (
          <ResourceCard key={d.id} r={d} caps={data.capabilities[d.id]} onCheck={load} toggle={(on) => apply({ resources: [{ id: d.id, enabled: on }] })}
            remove={() => apply({ resources: [{ id: d.id, remove: true }] })}>
            <UrlField value={d.url} placeholder="https://<deployment>.run.comfy.app" onSave={(url) => apply({ resources: [{ id: d.id, url }] })} />
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
              <label className="flex items-center gap-1.5 text-[11px] text-ink-dim">
                GPU
                <select className="input h-7 min-h-0 w-auto py-0 text-[11px]" value={d.gpu ?? 'rtx-pro-6000'}
                  onChange={(e) => void apply({ resources: [{ id: d.id, gpu: e.target.value }] })}>
                  {data.gpus.map((g) => <option key={g.id} value={g.id}>{g.label} · {g.creditsPerHour} cr/h</option>)}
                </select>
              </label>
              <label className="flex items-center gap-1.5 text-[11px] text-ink-dim">
                min workers
                <input className="input h-7 min-h-0 w-14 py-0 text-[11px]" type="number" min={0} value={d.minWorkers ?? 0}
                  onChange={(e) => void apply({ resources: [{ id: d.id, minWorkers: Number(e.target.value) || 0 }] })} />
              </label>
              <label className="flex items-center gap-1.5 text-[11px] text-ink-dim" title="What a cold job is billed beyond its own run: worker start-up, model loading and the 30 s idle window. Empty = the measured default.">
                start-up
                <NumberField value={d.coldStartSeconds ?? d.coldStart?.seconds ?? null} placeholder="265" disabled={(d.minWorkers ?? 0) > 0}
                  onSave={(v) => apply({ resources: [{ id: d.id, coldStartSeconds: v }] })} testId="cold-start-field" />
                s
              </label>
              <label className="flex items-center gap-1.5 text-[11px] text-ink-dim" title="The size of the models staged for this deployment, if you know it (comfy build): the storage line is computed from it.">
                staged
                <NumberField value={d.stagedGb ?? null} placeholder="GB" onSave={(v) => apply({ resources: [{ id: d.id, stagedGb: v }] })} />
                GB
              </label>
            </div>
            <p className={'text-[10px] leading-snug ' + ((d.minWorkers ?? 0) > 0 ? 'text-warn' : 'text-ink-mute')} data-testid="deployment-billing-note">
              {d.creditsPerHour} cr/h while a worker runs.
              {(d.minWorkers ?? 0) > 0
                ? ` With --min ${d.minWorkers} a worker stays up and bills while idle too: about ${Math.round((d.creditsPerHour ?? 0) * 24 * (d.minWorkers ?? 0)).toLocaleString('en-US')} cr a day. No start-up allowance is added to a job: the worker bills continuously instead.`
                : ` With --min 0 it scales to zero between jobs: a cold job (none here in the last minute) is billed about ${d.coldStart?.seconds ?? 265} s more than its own run — worker start-up, model loading and the 30 s idle window (${d.coldStart?.isDefault === false ? `set here; ${d.coldStart.measured}` : d.coldStart?.measured ?? 'measured'}). Estimates and costs add it; a job right after another adds only the idle window.`}
              {' '}Use the GPU and minimum you deployed with (<span className="font-mono">comfy deploy status</span>); JustAE Flow never starts, scales or stops it.
            </p>
            {d.storage && (
              <p className="text-[10px] leading-snug text-ink-mute" data-testid="deployment-storage" title="Network storage for the staged models (comfy deploy refs compute: 42.2 cr per GB per month). The hourly billing report shows it every hour, with or without jobs (measured 25 Oct 2026); whether a stopped deployment still bills it is to be verified.">
                storage ≈ {d.storage.creditsPerHour.toFixed(2)} cr/h while the deployment exists
                {d.storage.basis === 'staged' ? ` (${d.storage.gb} GB × 42.2 cr/GB/month)` : ` — measured for a ${d.storage.gb} GB build (42.2 cr/GB/month)`}
              </p>
            )}
          </ResourceCard>
        ))}
        <button className="chip" onClick={() => void apply({ resources: [{ id: 'new', label: 'Deployment', url: '', enabled: true }] })} data-testid="add-deployment">
          + Add a deployment
        </button>

        <ResourceCard r={proxy} caps={data.capabilities[proxy.id]} onCheck={load} toggle={(on) => apply({ resources: [{ id: proxy.id, enabled: on }] })}>
          <UrlField value={proxy.url} placeholder="http://127.0.0.1:8189" onSave={(url) => apply({ resources: [{ id: proxy.id, url }] })} />
          <KeyField
            set={data.proxyToken.set} tail={null} file={data.proxyToken.file}
            label="Proxy token (optional)" placeholder="Only if comfy-api-proxy was started with --token"
            onSave={(k) => apply({ proxyToken: k })}
          />
          <label className="flex cursor-pointer items-start gap-2 text-[11px] text-ink-dim">
            <input type="checkbox" className="mt-0.5" checked={proxy.fronts === local.id}
              onChange={(e) => void apply({ resources: [{ id: proxy.id, fronts: e.target.checked ? local.id : '' }] })} />
            <span>It stands in front of the Local ComfyUI above (comfy-api-proxy&rsquo;s default: 127.0.0.1:8188) — that
              ComfyUI&rsquo;s node catalogue answers for it, and its model precisions are used.</span>
          </label>
          <p className="text-[10px] leading-snug text-ink-mute">
            Your own ComfyUI speaking Comfy API v2 (<span className="font-mono">pip install comfy-api-proxy</span>) — your GPU,
            no credits, the protocol a deployment speaks.
          </p>
        </ResourceCard>
      </section>

      <TaskTable />
      {error && <p className="whitespace-pre-line text-[11px] text-err">{error}</p>}
    </div>
  );
}

function ResourceCard({ r, caps, children, toggle, remove, onCheck }: {
  r: ResourceView; caps: Capabilities | null | undefined; children: React.ReactNode;
  toggle?: (on: boolean) => void; remove?: () => void; onCheck: () => Promise<void>;
}): JSX.Element {
  const [checking, setChecking] = useState(false);
  const check = async (): Promise<void> => {
    setChecking(true);
    try { await serverJson(`/api/resources/${encodeURIComponent(r.id)}/check`, {}); } catch { /* the card shows the probe */ }
    await onCheck();
    setChecking(false);
  };
  const dot = !r.enabled ? 'bg-ink-mute' : caps ? (caps.online ? 'bg-ok' : 'bg-err') : 'bg-ink-mute animate-pulse';
  return (
    <div className={'space-y-1.5 rounded-lg border p-2.5 ' + (r.enabled ? 'border-line bg-bg-raised' : 'border-line/60 opacity-70')} data-resource-card={r.id}>
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
        <span className="text-xs text-ink">{ICON[r.kind]} {r.label}</span>
        <span className="min-w-0 truncate font-mono text-[10px] text-ink-mute">
          {!r.enabled ? 'off' : !r.usable ? r.reason : caps ? (caps.online ? [caps.version, caps.device].filter(Boolean).join(' · ') || 'online' : caps.message ?? 'unreachable') : 'not checked yet'}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <button className="btn-quiet h-6 px-2 text-[11px]" onClick={() => void check()} disabled={checking || !r.enabled}>{checking ? 'Checking…' : 'Check'}</button>
          {remove && <button className="btn-quiet h-6 px-2 text-[11px]" onClick={remove}>Remove</button>}
          {toggle && (
            <label className="flex cursor-pointer items-center gap-1 text-[11px] text-ink-dim">
              <input type="checkbox" checked={r.enabled} onChange={(e) => toggle(e.target.checked)} /> on
            </label>
          )}
        </span>
      </div>
      {children}
      {r.enabled && caps && <CapsLine caps={caps} />}
    </div>
  );
}

/** "Bundled: 10 run here · 1 missing (vace-reframe: …) · nodes from object_info (5,412)"; a deployment: which ones have run there. */
function CapsLine({ caps }: { caps: Capabilities }): JSX.Element | null {
  const ws = Object.entries(caps.workflows);
  if (!ws.length) return null;
  const ok = ws.filter(([, w]) => w.status === 'ok');
  // No node catalogue (a deployment, a proxy): a workflow that finished there is known to run there.
  const proven = ws.filter(([, w]) => w.status === 'proven');
  const missing = ws.filter(([, w]) => w.status === 'missing');
  const unknown = ws.filter(([, w]) => w.status === 'unknown');
  const day = (iso?: string): string => (iso ? `${new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${clock(iso)}` : '');
  return (
    <div className="space-y-0.5" data-testid={`caps-${caps.resourceId}`}>
      <p className="text-[10px] leading-snug text-ink-mute" title={`${caps.nodes.basis}\n${caps.models.basis}\nchecked ${clock(caps.checkedAt)}`}>
        Bundled workflows: {ok.length > 0 && <span className="text-ok">{ok.length} run here</span>}
        {ok.length > 0 && proven.length > 0 && ' · '}
        {proven.length > 0 && <span className="text-ok">{proven.length} known from a finished run</span>}
        {ok.length + proven.length === 0 && <span>none known yet</span>}
        {missing.length > 0 && (
          <> · <span className="text-warn">{missing.length} missing something</span> ({missing.map(([id, w]) => `${id}: ${[...w.missingNodes, ...w.missingModels].slice(0, 2).join(', ')}`).join('; ')})</>
        )}
        {unknown.length > 0 && <> · {unknown.length} unknown {caps.kind === 'deployment' || caps.kind === 'proxy' ? 'until they have run here once' : `(${caps.nodes.known ? caps.models.basis : caps.nodes.basis})`}</>}
        {caps.nodes.known && caps.nodes.count ? <> · {caps.nodes.count.toLocaleString('en-US')} node classes</> : null}
      </p>
      {proven.length > 0 && (
        <p className="text-[10px] leading-snug text-ink-mute">
          ✓ {proven.map(([id, w]) => `${id} (ran here ${day(w.provenAt)})`).join(' · ')}
        </p>
      )}
    </div>
  );
}

function CloudBalance(): JSX.Element {
  const credits = useResources((s) => s.credits);
  const loadCredits = useResources((s) => s.loadCredits);
  if (!credits) return <p className="text-[11px] text-ink-mute">Balance not read yet.</p>;
  return (
    <div className="flex items-center gap-2">
      <p className={'min-w-0 flex-1 text-[11px] leading-snug ' + (credits.ok ? 'text-ink' : 'text-ink-mute')} title={creditsTooltip(credits)} data-testid="cloud-balance">
        {credits.ok && credits.credits !== null ? (
          <>
            <span className="font-mono">{formatCredits(credits.credits)} cr</span>
            {credits.balanceCents !== null && <span className="text-ink-dim"> (≈ ${(credits.balanceCents / 100).toFixed(2)})</span>}
            {credits.planCredits !== null && credits.prepaidCredits !== null && (
              <span className="text-ink-dim"> · {formatCredits(credits.planCredits)} plan + {formatCredits(credits.prepaidCredits)} top-ups</span>
            )}
            <span className="text-ink-mute"> · read {clock(credits.asOf)} from the billing report (invoices)</span>
          </>
        ) : credits.error}
      </p>
      <button className="btn-quiet h-6 shrink-0 px-2 text-[11px]" onClick={() => void loadCredits(true)}>Read again</button>
    </div>
  );
}

/**
 * An optional Hugging Face token, for gated files (the Lightricks LTX-2.5 repos) once their terms are accepted on
 * their pages: kept by the server in hf-token.txt in your user folder, sent to huggingface.co only, never shown again.
 */
function HfTokenField(): JSX.Element {
  const [view, setView] = useState<{ set: boolean; file: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void serverJson<{ set: boolean; file: string }>('/api/models/hf-token').then(setView).catch(() => undefined);
  }, []);
  const save = async (v: string | null): Promise<void> => {
    setError(null);
    try { setView(await putHfToken(v)); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  return (
    <div className="space-y-1" data-testid="hf-token">
      <KeyField set={!!view?.set} tail={null} file={view?.file ?? ''} label="Hugging Face token (optional)"
        placeholder="Only for gated files, after accepting their terms on Hugging Face" onSave={save} />
      {error && <p className="text-[10px] text-err">{error}</p>}
    </div>
  );
}

/** A number saved on blur or Enter (not on every keystroke); empty saves null (the default). */
function NumberField({ value, placeholder, disabled, onSave, testId }: {
  value: number | null; placeholder: string; disabled?: boolean; onSave: (v: number | null) => Promise<void>; testId?: string;
}): JSX.Element {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (): void => {
    if (draft === null) return;
    const t = draft.trim();
    const v = t === '' ? null : Number(t);
    if (v === null || (Number.isFinite(v) && v >= 0)) { if (v !== value) void onSave(v); }
    setDraft(null);
  };
  return (
    <input
      className="input h-7 min-h-0 w-[4.5rem] py-0 text-[11px]"
      type="number" min={0} disabled={disabled} placeholder={placeholder} data-testid={testId}
      value={draft ?? (value ?? '')}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
    />
  );
}

export function UrlField({ value, placeholder, onSave }: { value: string; placeholder: string; onSave: (v: string) => Promise<void> }): JSX.Element {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      className="input h-8 min-h-0 py-1 font-mono text-[11px]"
      value={draft ?? value}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { if (draft !== null && draft.trim() !== value) void onSave(draft.trim().replace(/\/+$/, '')); setDraft(null); }}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
    />
  );
}

export function KeyField({ set, tail, file, label, placeholder, onSave }: {
  set: boolean; tail: string | null; file: string; label: string; placeholder: string; onSave: (v: string | null) => Promise<void>;
}): JSX.Element {
  const [draft, setDraft] = useState('');
  return (
    <div className="space-y-1">
      <span className="block text-[11px] text-ink-dim">{label}</span>
      <div className="flex items-center gap-1.5">
        <input
          className="input h-8 min-h-0 flex-1 py-1 text-[11px]"
          type="password"
          autoComplete="off"
          value={draft}
          placeholder={set ? `set${tail ? ` · ends …${tail}` : ''} — type a new one to replace it` : placeholder}
          onChange={(e) => setDraft(e.target.value.trim())}
          data-testid={label === 'API key' ? 'api-key-field' : /Hugging Face/.test(label) ? 'hf-token-field' : 'proxy-token-field'}
        />
        <button className="btn-ghost h-8 px-2.5 text-[11px]" disabled={!draft} onClick={() => { void onSave(draft); setDraft(''); }}>Save</button>
        {set && <button className="btn-quiet h-8 px-2 text-[11px]" onClick={() => void onSave(null)}>Remove</button>}
      </div>
      <p className="truncate font-mono text-[10px] text-ink-mute" title={file}>{set ? '✔ ' : ''}{file}</p>
    </div>
  );
}

/** Settings ▸ Resources ▸ "Where each task runs": one row per task, a column per resource, and Auto. */
function TaskTable(): JSX.Element {
  const data = useResources((s) => s.data)!;
  const save = useResources((s) => s.save);
  const cols = [
    ...data.resources.filter((r) => r.kind === 'local' || r.kind === 'cloud' || r.enabled).map((r) => ({ id: r.id, label: r.kind === 'local' ? 'Local' : r.kind === 'cloud' ? 'Cloud' : r.kind === 'proxy' ? 'Proxy' : r.label, usable: r.usable })),
    { id: 'auto', label: 'Auto', usable: true },
  ];
  return (
    <section className="space-y-2" data-testid="task-table">
      <h3 className="section-label">Where each task runs</h3>
      <table className="w-full table-fixed border-collapse text-[11px]">
        <thead>
          <tr className="text-[10px] text-ink-mute">
            <th className="w-[44%] pb-1 text-left font-normal" />
            {cols.map((c) => <th key={c.id} className="truncate pb-1 text-center font-normal" title={c.usable ? c.label : `${c.label}: not set up — a task here falls back to Auto`}>{c.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {data.taskRows.map((t) => (
            <tr key={t.id} className="border-t border-line/50">
              <td className="truncate py-1 pr-1 text-ink-dim" title={t.label}>{t.label}</td>
              {cols.map((c) => (
                <td key={c.id} className="py-1 text-center">
                  <input
                    type="radio" name={`task-${t.id}`} checked={data.tasks[t.id] === c.id}
                    onChange={() => void save({ tasks: { [t.id]: c.id } })}
                    className={c.usable ? '' : 'opacity-50'}
                    title={c.usable ? '' : 'Not set up yet: runs fall back to Auto'}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[10px] leading-snug text-ink-mute">
        Auto = Local when it has the workflow&rsquo;s nodes and models, else the first other resource that has
        them. A row on a resource that is not set up falls back to Auto. The resource on the Generate button
        overrides this for a batch; each shot&rsquo;s job.json records where it ran and why.
      </p>
    </section>
  );
}
