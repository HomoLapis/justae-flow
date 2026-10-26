/**
 * Pipeline — the professional workflow library on top of the server's own
 * workflows: draft locally, approve, final in the cloud, deliver lossless.
 *
 * Per catalog entry: what it is for, where draft and final should run, VRAM,
 * licence, whether its nodes are installed on the current server, which of
 * the server's workflows implement it — and a button that applies the draft
 * or final values to the selected workflow, listing what it changed and what
 * it could not.
 *
 * It lives inside "Your ComfyUI workflows" on the Workflow tab; the draft
 * canvas and the delivery profile it used to carry are Settings ▸ On the
 * timeline (DraftDelivery, below) — they apply to every run, not to a card.
 */
import { useEffect, useState } from 'react';
import { useApp } from '../state/store';
import type { VideoProvider, ObjectInfo } from '../providers/types';
import { CATALOG, OUTPUT_PROFILES, outputProfile, type CatalogEntry } from '../pipeline/catalog';
import { availability, matchingWorkflows, applyPreset, variantFor, type PresetResult } from '../pipeline/apply';

const TARGET_LABEL = { local: 'local', cloud: 'cloud', both: 'local or cloud' } as const;

/** Settings ▸ On the timeline: Draft (a smaller canvas) or Final, and how a result is delivered. */
export function DraftDelivery(): JSX.Element {
  const pipe = useApp((s) => s.settings.pipeline);
  const setSettings = useApp((s) => s.setSettings);
  const setPipe = (patch: Partial<typeof pipe>): void => setSettings({ pipeline: { ...pipe, ...patch } });
  return (
    <div className="space-y-2 rounded-lg border border-line p-2.5" data-testid="draft-delivery">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-ink">Canvas for your own workflows</span>
        <div className="flex overflow-hidden rounded-md border border-line text-[11px]">
          {(['draft', 'final'] as const).map((t) => (
            <button key={t} type="button"
              className={`px-2.5 py-1 ${pipe.tier === t ? 'bg-brand text-white' : 'text-ink-dim hover:bg-bg-subtle'}`}
              onClick={() => setPipe({ tier: t })}
              title={t === 'draft' ? 'Smaller canvas, draft presets — iterate locally' : 'Full canvas from the comp, final presets — usually in the cloud'}>
              {t === 'draft' ? 'Draft' : 'Final'}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="text-[11px] text-ink-dim">
          Draft long side (px)
          <input className="input mt-0.5 font-mono text-xs" inputMode="numeric" value={pipe.draftLongSide}
            onChange={(e) => { const n = parseInt(e.target.value, 10); if (n >= 256 && n <= 8192) setPipe({ draftLongSide: n }); }} />
        </label>
        <label className="text-[11px] text-ink-dim">
          Delivery
          <select className="input mt-0.5 text-xs" value={pipe.outputProfile} onChange={(e) => setPipe({ outputProfile: e.target.value })}>
            {OUTPUT_PROFILES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </label>
      </div>
      <p className="text-[10px] leading-snug text-ink-mute">
        {pipe.tier === 'draft'
          ? `Draft: the canvas the comp supplies is scaled to a ${pipe.draftLongSide} px long side (the "from comp" badge says so). `
          : 'Final: full canvas from the comp. '}
        {OUTPUT_PROFILES.find((p) => p.id === pipe.outputProfile)?.description}
        {' '}MiniMax H3 has its own Draft / Final on its card.
      </p>
    </div>
  );
}

export function PipelineLibrary({ provider, onPick }: { provider: VideoProvider | null; onPick: (id: string) => void }): JSX.Element {
  const settings = useApp((s) => s.settings);
  const openSettings = useApp((s) => s.setSettingsOpen);
  const library = useApp((s) => s.library);
  const active = useApp((s) => s.active);
  const values = useApp((s) => (s.active ? s.values[s.active.id] : undefined));
  const setValues = useApp((s) => s.setValues);
  const [info, setInfo] = useState<ObjectInfo | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [result, setResult] = useState<{ entry: string; tier: string; r: PresetResult } | null>(null);
  const pipe = settings.pipeline;

  useEffect(() => {
    let alive = true;
    setInfo(null);
    if (provider?.objectInfo) void provider.objectInfo().then((o) => { if (alive) setInfo(o); }).catch(() => {});
    return () => { alive = false; };
  }, [provider]);

  const apply = (entry: CatalogEntry, tier: 'draft' | 'final'): void => {
    if (!active) return;
    const r = applyPreset(tier === 'draft' ? entry.draft : entry.final, active.form.fields, active.api, values ?? {});
    setValues(active.id, { ...(values ?? {}), ...r.values });
    setResult({ entry: entry.id, tier, r });
  };

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="section-label">Draft / final presets</span>
        <button type="button" className="truncate text-[10px] text-ink-mute hover:text-ink" onClick={() => openSettings(true)}
          title="The draft canvas and the delivery profile are in Settings ▸ On the timeline">
          now: {pipe.tier === 'draft' ? `Draft (${pipe.draftLongSide} px)` : 'Final'} · {outputProfile(pipe.outputProfile).label} — Settings
        </button>
      </div>
      <p className="text-[10px] leading-snug text-ink-mute">
        The stages of a production, whether their nodes are on this server, and the draft or final values to apply to the selected workflow.
      </p>

      <ul className="space-y-1.5">
        {CATALOG.map((e) => {
          const av = availability(e, info);
          const matches = matchingWorkflows(e, library);
          const isOpen = open === e.id;
          return (
            <li key={e.id} className="rounded-lg border border-line bg-bg-raised">
              <button type="button" className="flex w-full items-center gap-2 px-2.5 py-2 text-left" onClick={() => setOpen(isOpen ? null : e.id)}>
                <span className={'text-ink-mute transition-transform ' + (isOpen ? 'rotate-90' : '')}>▶</span>
                <span className="min-w-0 flex-1 truncate text-xs text-ink">{e.name}</span>
                <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${av.available === true ? 'bg-ok/15 text-ok' : av.available === false ? 'bg-warn/15 text-warn' : 'bg-bg-subtle text-ink-mute'}`}
                  title={av.available === false ? 'Missing on this server: ' + av.missing.map((g) => g.join(' or ')).join(', ') : ''}>
                  {av.available === true ? 'installed' : av.available === false ? 'nodes missing' : '—'}
                </span>
              </button>
              {isOpen && (
                <div className="space-y-2 border-t border-line px-2.5 py-2 text-[11px] leading-snug">
                  <p className="text-ink-dim">{e.purpose}</p>
                  <div className="flex flex-wrap gap-1.5 font-mono text-[10px] text-ink-mute">
                    <span className="rounded bg-bg-subtle px-1.5 py-0.5">draft: {TARGET_LABEL[e.draftTarget]} · {e.vram.draft}</span>
                    <span className="rounded bg-bg-subtle px-1.5 py-0.5">final: {TARGET_LABEL[e.finalTarget]} · {e.vram.final}</span>
                    <span className="rounded bg-bg-subtle px-1.5 py-0.5" title="Where the VRAM figures come from">VRAM {e.vram.basis}</span>
                  </div>
                  {av.available === false && (
                    <p className="text-warn">Missing on this server: {av.missing.map((g) => g.join(' or ')).join(', ')}.</p>
                  )}
                  {e.licence && <p className="text-ink-mute">Licence: {e.licence}</p>}
                  <ul className="list-disc space-y-0.5 pl-4 text-ink-mute">
                    {e.notes.map((n) => <li key={n}>{n}</li>)}
                  </ul>
                  <div>
                    <div className="mb-1 text-ink-dim">Workflows on this server that look like it:</div>
                    {matches.length ? (
                      <div className="flex flex-wrap gap-1">
                        {matches.slice(0, 10).map((w) => {
                          const suits = variantFor(e, pipe.tier, matches).some((v) => v.id === w.id);
                          return (
                            <button key={w.id}
                              className={`chip ${active?.id === w.id ? 'border-brand/60 text-ink' : ''} ${suits ? 'text-ok' : ''}`}
                              title={suits ? `Suits a ${pipe.tier}` : ''}
                              onClick={() => onPick(w.id)}>
                              {suits ? '★ ' : ''}{w.name}
                            </button>
                          );
                        })}
                      </div>
                    ) : <p className="text-ink-mute">None found by name — build one from the ComfyUI templates and save it with a matching name.</p>}
                  </div>
                  {e.variants && (
                    <p className="text-ink-mute">★ = the variant that suits a {pipe.tier}: {pipe.tier === 'draft' ? 'distilled / turbo / fast' : 'full model, two-stage or refine'} — for this model the difference between draft and final is the workflow you pick, not a step count.</p>
                  )}
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button className="chip" disabled={!active || !e.draft.length} onClick={() => apply(e, 'draft')}>Apply draft values</button>
                    <button className="chip" disabled={!active || !e.final.length} onClick={() => apply(e, 'final')}>Apply final values</button>
                    {!active && <span className="text-ink-mute">select a workflow first</span>}
                  </div>
                  {result && result.entry === e.id && (
                    <div className="rounded border border-line bg-bg p-2 font-mono text-[10px]">
                      <div className="text-ink-dim">{result.tier} values on "{active?.name}":</div>
                      {result.r.applied.map((a) => (
                        <div key={a.fieldId} className="text-ok">✓ {a.label}: {String(a.from)} → {String(a.to)}{a.why ? ` (${a.why})` : ''}</div>
                      ))}
                      {result.r.skipped.map((s, i) => (
                        <div key={i} className="text-warn">– {s.reason}</div>
                      ))}
                      {!result.r.applied.length && !result.r.skipped.length && <div className="text-ink-mute">nothing to apply</div>}
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
