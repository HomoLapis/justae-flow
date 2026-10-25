/**
 * Featured — a few workflows the JustAE Flow server ships, built from official
 * ComfyUI templates, above the library (PLAN v3 §4.3).
 *
 * Each one says where it runs, from the server's capability probes: Local ✓ when
 * the local ComfyUI has every node and model, a deployment ✓ once a run of it
 * finished there (a deployment has no node catalogue), ✗ with what is missing,
 * ? when nothing is known yet. An entry that runs nowhere stays listed, greyed,
 * with the files it lacks and where the template downloads them. "Use it" makes
 * it the workflow of the Marker and Storyboard tabs. MiniMax H3 has Draft / Final: Draft is its own workflow (the
 * 4-step turbo LoRA the official template names); Final is the base model, then a second job on its result —
 * "+ SeedVR2 ×2" or "+ LTX Refine" (to Full HD, with a PNG 16-bit master).
 */

import { useEffect, useState } from 'react';
import { useApp } from '../state/store';
import { useResources } from '../lib/resources';

interface RunsOn { resource: string; kind: string; label: string; status: 'ok' | 'proven' | 'missing' | 'unknown' | 'unusable'; note?: string }
interface Entry {
  id: string; name: string; line: string; title: string; task: string; input?: string; output: string; template: string;
  licence: string; licenceNote?: string;
  tiers?: { draft: { workflow: string; note: string }; finals: Array<{ id: 'seedvr2' | 'ltx'; label: string; then: string; scale: number; note: string }> };
  draftName?: string;
  runsOn: RunsOn[];
  missing: Array<{ kind: 'node' | 'model'; name: string; directory?: string; url?: string }>;
  runnable: boolean;
}

function short(r: RunsOn): string {
  if (r.kind === 'local') return 'Local';
  if (r.kind === 'cloud') return 'Cloud';
  if (r.kind === 'proxy') return 'Proxy';
  return r.label.length > 22 ? `${r.label.slice(0, 21)}…` : r.label;
}

function Badge({ r }: { r: RunsOn }): JSX.Element {
  const good = r.status === 'ok' || r.status === 'proven';
  const bad = r.status === 'missing' || r.status === 'unusable';
  const mark = good ? '✓' : bad ? '✗' : '?';
  const why = r.status === 'ok' ? 'every node and model is there (its probe)'
    : r.status === 'proven' ? `a run of it finished there${r.note ? ` (${r.note})` : ''}`
      : r.status === 'missing' ? `missing: ${r.note ?? ''}`
        : r.status === 'unusable' ? (r.note ?? 'not usable now')
          : r.note ?? 'not known yet';
  return (
    <span className={'whitespace-nowrap ' + (good ? 'text-ok' : bad ? 'text-warn' : 'text-ink-mute')} title={`${r.label}: ${why}`} data-runs-on={r.resource} data-status={r.status}>
      {short(r)} {mark}
    </span>
  );
}

export function FeaturedSection({ onUse }: { onUse: (libraryId: string) => Promise<void> }): JSX.Element | null {
  const caps = useResources((s) => s.data?.capabilities);
  const activeId = useApp((s) => s.activeId);
  const chains = useApp((s) => s.chains);
  const setChain = useApp((s) => s.setChain);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tier, setTier] = useState<Record<string, 'draft' | 'final'>>({});
  const [finalPick, setFinalPick] = useState<Record<string, 'seedvr2' | 'ltx'>>({});

  // Read again when the probes change (Settings ▸ Resources ▸ Check, a run that finished on a deployment).
  useEffect(() => {
    let alive = true;
    fetch('/api/featured')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { entries: Entry[] }) => { if (alive) { setEntries(d.entries); setError(null); } })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [caps]);

  if (error) return <p className="text-[11px] text-ink-mute">Featured workflows: the server did not answer ({error}).</p>;
  if (!entries) return null;

  /** The tier an entry shows: the pick on the card, else what the Flow window uses now (a chain = Final). */
  const tierOf = (e: Entry): 'draft' | 'final' => tier[e.id] ?? (chains[`bundled:${e.id}`] ? 'final' : 'draft');
  const finalOf = (e: Entry): NonNullable<Entry['tiers']>['finals'][number] | undefined => {
    const pick = finalPick[e.id] ?? (chains[`bundled:${e.id}`]?.then === 'ltx25-refine' ? 'ltx' : 'seedvr2');
    return e.tiers?.finals.find((x) => x.id === pick) ?? e.tiers?.finals[0];
  };
  const use = async (e: Entry, t: 'draft' | 'final' = tierOf(e), fin = finalOf(e)): Promise<void> => {
    const id = `bundled:${e.id}`;
    setBusy(e.id);
    try {
      if (e.tiers && t === 'draft') {
        // Draft: its own workflow, nothing chained after it.
        const draft = `bundled:${e.tiers.draft.workflow}`;
        setChain(id, null);
        setChain(draft, null);
        await onUse(draft);
      } else {
        if (e.tiers) setChain(id, fin ? { then: fin.then, scale: fin.scale } : null);
        await onUse(id);
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="space-y-2" data-testid="featured">
      <div className="flex items-center justify-between">
        <span className="section-label">Featured</span>
        <span className="text-[10px] text-ink-mute">official ComfyUI templates, shipped with JustAE Flow</span>
      </div>
      <ul className="space-y-1.5">
        {entries.map((e) => {
          const id = `bundled:${e.id}`;
          const t = tierOf(e);
          const fin = finalOf(e);
          const active = activeId === id || (!!e.tiers && activeId === `bundled:${e.tiers.draft.workflow}`);
          return (
            <li key={e.id} data-featured={e.id}
              className={'space-y-1 rounded-lg border px-2.5 py-2 ' + (active ? 'border-brand/60 bg-brand/5' : 'border-line bg-bg-raised') + (e.runnable ? '' : ' opacity-60')}>
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-ink" title={`${e.title} · template ${e.template}`}>{e.name}</span>
                  <span className="block truncate text-[10px] text-ink-mute">{e.line}</span>
                </span>
                {e.tiers && (
                  <div className="flex shrink-0 overflow-hidden rounded-md border border-line text-[10px]" title={t === 'draft' ? e.tiers.draft.note : fin?.note}>
                    {(['draft', 'final'] as const).map((x) => (
                      <button key={x} type="button" data-tier={x}
                        className={'px-2 py-0.5 ' + (t === x ? 'bg-brand text-white' : 'text-ink-dim hover:bg-bg-subtle')}
                        onClick={() => {
                          setTier({ ...tier, [e.id]: x });
                          if (active) void use(e, x, fin);
                        }}>
                        {x === 'draft' ? 'Draft' : 'Final'}
                      </button>
                    ))}
                  </div>
                )}
                <button type="button" className="chip h-6 shrink-0 px-2 py-0 text-[11px]" disabled={busy !== null} onClick={() => void use(e)} data-testid={`use-${e.id}`}>
                  {busy === e.id ? '…' : active ? 'In use' : 'Use it'}
                </button>
              </div>
              <p className="flex flex-wrap gap-x-2 font-mono text-[10px] text-ink-mute">
                <span>runs on:</span>
                {e.runsOn.map((r, i) => <span key={r.resource}>{i > 0 && <span className="pr-2 text-ink-mute">·</span>}<Badge r={r} /></span>)}
              </p>
              {e.tiers && t === 'final' && (
                <div className="flex flex-wrap items-center gap-1" data-testid={`finals-${e.id}`}>
                  {e.tiers.finals.map((x) => (
                    <button key={x.id} type="button" data-final={x.id} title={x.note}
                      className={'chip h-6 px-2 py-0 text-[10px] ' + (fin?.id === x.id ? '!border-brand/70 !bg-brand/15 !text-ink' : '')}
                      onClick={() => {
                        setFinalPick({ ...finalPick, [e.id]: x.id });
                        if (active) void use(e, 'final', x);
                      }}>
                      {x.label}
                    </button>
                  ))}
                </div>
              )}
              {e.tiers && <p className="text-[10px] leading-snug text-ink-mute">{t === 'draft' ? e.tiers.draft.note : fin?.note}</p>}
              {e.missing.length > 0 && (
                <ul className="space-y-0.5 text-[10px] leading-snug text-warn" data-testid={`missing-${e.id}`}>
                  {e.missing.slice(0, 4).map((x) => (
                    <li key={x.name} className="truncate" title={x.url ?? ''}>
                      missing: {x.kind === 'node' ? `node ${x.name}` : x.name}
                      {x.url ? <> → <span className="font-mono">{x.url}</span></> : null}
                      {x.directory ? <span className="text-ink-mute"> (models/{x.directory})</span> : null}
                    </li>
                  ))}
                  {e.missing.length > 4 && <li className="text-ink-mute">…and {e.missing.length - 4} more</li>}
                </ul>
              )}
              {(e.licenceNote || /non-commercial|Community License/i.test(e.licence)) && (
                <LicenceLine text={e.licenceNote ?? e.licence} title={e.licence} id={e.id} />
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** "Licence: …", with the licence's own link when the text carries one (LTX-2.x: its LICENSE-2_x on GitHub). */
function LicenceLine({ text, title, id }: { text: string; title: string; id: string }): JSX.Element {
  const m = /^(.*?)\s*—\s*(https:\/\/\S+)\s*$/.exec(text);
  return (
    <p className="text-[10px] leading-snug text-ink-mute" title={title} data-testid={`licence-${id}`}>
      Licence: {m ? <>{m[1]} — <a className="underline hover:text-ink" href={m[2]} target="_blank" rel="noreferrer">{m[2].replace(/^https:\/\//, '')}</a></> : text}
    </p>
  );
}
