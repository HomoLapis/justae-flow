/**
 * Featured — the workflows JustAE Flow ships, built from official ComfyUI templates, in two groups: Generate
 * (stills and shots) and Edit & finish (work on what is there).
 *
 * Each card is one line: the name, what it does, ONE status for the resource the Generate button uses ("Running
 * on", above) — Ready · Missing 2 models · 28.6 GB · Needs the ComfyUI-LTXVideo pack · Not on this resource ·
 * Unknown here — and "Use it" (or "Get them" when the local ComfyUI lacks files). Everything else is behind ▸: the
 * other resources, the files with their sizes and sources, the node packs, the licence in one line. The statuses
 * are the server's (GET /api/readiness, from the capability probes — never guessed).
 *
 * MiniMax H3 has Draft / Final on its line: Draft is its own workflow (the 4-step turbo LoRA the official template
 * names); Final is the base model, then a second job on its result — "+ SeedVR2 ×2" or "+ LTX Refine". LTX Refine
 * runs from the Comp tab: its "Use it" opens that card.
 */

import { useState } from 'react';
import { useApp } from '../state/store';
import { useComp, draftOf } from '../lib/comp';
import { formatBytes, useReadiness, type ReadinessEntry, type ReadyStatus } from '../lib/readiness';

const TONE: Record<ReadyStatus, string> = {
  ready: 'border-ok/40 bg-ok/10 text-ok',
  'missing-models': 'border-warn/40 bg-warn/10 text-warn',
  'missing-nodes': 'border-warn/40 bg-warn/10 text-warn',
  'not-on-this-resource': 'border-line bg-bg-subtle text-ink-mute',
  unknown: 'border-line bg-bg-subtle text-ink-mute',
};

export function StatusChip({ status, text, title, testId }: { status: ReadyStatus; text: string; title?: string; testId?: string }): JSX.Element {
  return (
    <span className={'inline-flex shrink-0 items-center whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[10px] font-medium ' + TONE[status]}
      title={title} data-status={status} data-testid={testId}>
      {text}
    </span>
  );
}

export function FeaturedSection({ onUse }: { onUse: (libraryId: string) => Promise<void> }): JSX.Element | null {
  const data = useReadiness((s) => s.data);
  const error = useReadiness((s) => s.error);
  const openPicker = useReadiness((s) => s.setOpen);
  const setPicked = useReadiness((s) => s.setPicked);
  const activeId = useApp((s) => s.activeId);
  const chains = useApp((s) => s.chains);
  const setChain = useApp((s) => s.setChain);
  const setTab = useApp((s) => s.setTab);
  const [busy, setBusy] = useState<string | null>(null);
  const [tier, setTier] = useState<Record<string, 'draft' | 'final'>>({});
  const [finalPick, setFinalPick] = useState<Record<string, 'seedvr2' | 'ltx'>>({});
  const [open, setOpen] = useState<string | null>(null);

  if (error && !data) return <p className="text-[11px] text-ink-mute">Featured workflows: the server did not answer ({error}).</p>;
  if (!data) return null;

  /** The tier an entry shows: the pick on the card, else what the Flow window uses now (a chain = Final). */
  const tierOf = (e: ReadinessEntry): 'draft' | 'final' => tier[e.id] ?? (chains[`bundled:${e.id}`] ? 'final' : 'draft');
  const finalOf = (e: ReadinessEntry): NonNullable<ReadinessEntry['tiers']>['finals'][number] | undefined => {
    const pick = finalPick[e.id] ?? (chains[`bundled:${e.id}`]?.then === 'ltx25-refine' ? 'ltx' : 'seedvr2');
    return e.tiers?.finals.find((x) => x.id === pick) ?? e.tiers?.finals[0];
  };
  const use = async (e: ReadinessEntry, t: 'draft' | 'final' = tierOf(e), fin = finalOf(e)): Promise<void> => {
    if (e.comp) {
      // A Comp tab card: open it, on the engine this entry is.
      const comp = useComp.getState();
      const tools = comp.state?.tools ?? [];
      const d = draftOf(comp.drafts, e.comp.tool, tools.find((x) => x.id === e.comp!.tool)?.defaults ?? {});
      if (e.comp.engine) comp.setDraft(e.comp.tool, { options: { ...d.options, engine: e.comp.engine } });
      comp.setOpenTool(e.comp.tool);
      setTab('comp');
      return;
    }
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
  const getThem = (e: ReadinessEntry): void => { setPicked([e.id]); openPicker(true); };

  const groups: Array<{ id: ReadinessEntry['group']; label: string; hint: string }> = [
    { id: 'generate', label: 'Generate', hint: 'stills and shots, from a prompt or your frames' },
    { id: 'edit', label: 'Edit & finish', hint: 'work on an image or a clip you have' },
  ];

  return (
    <div className="space-y-3" data-testid="featured">
      {groups.map((g) => (
        <section key={g.id} className="space-y-1.5" data-group={g.id}>
          <div className="flex items-baseline justify-between gap-2">
            <span className="section-label">{g.label}</span>
            <span className="truncate text-[10px] text-ink-mute">{g.hint}</span>
          </div>
          <ul className="space-y-1.5">
            {data.entries.filter((e) => e.group === g.id).map((e) => {
              const t = tierOf(e);
              const fin = finalOf(e);
              const active = activeId === `bundled:${e.id}` || (!!e.tiers && activeId === `bundled:${e.tiers.draft.workflow}`);
              const isOpen = open === e.id;
              // "Get them" when the local ComfyUI lacks files and the pick runs there (or Default sends it there).
              const needsFiles = e.status === 'missing-models' && e.missing.count > 0;
              return (
                <li key={e.id} data-featured={e.id}
                  className={'rounded-lg border ' + (active ? 'border-brand/60 bg-brand/5' : 'border-line bg-bg-raised')}>
                  <div className="flex items-center gap-2 px-2 py-1.5">
                    <button type="button" className={'grid h-5 w-5 shrink-0 place-items-center rounded text-[10px] text-ink-mute transition-transform hover:bg-bg-subtle hover:text-ink ' + (isOpen ? 'rotate-90' : '')}
                      onClick={() => setOpen(isOpen ? null : e.id)} title={isOpen ? 'Hide the details' : 'Details: where it runs, its files, its licence'} aria-label="Details" data-testid={`details-${e.id}`}>
                      ▶
                    </button>
                    <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setOpen(isOpen ? null : e.id)} title={`${e.title}`}>
                      <span className="block truncate text-xs text-ink">{e.name}</span>
                      <span className="block truncate text-[10px] text-ink-mute">{e.line}</span>
                    </button>
                    {e.tiers && (
                      <div className="flex shrink-0 overflow-hidden rounded-md border border-line text-[10px]" title={t === 'draft' ? e.tiers.draft.note : fin?.note}>
                        {(['draft', 'final'] as const).map((x) => (
                          <button key={x} type="button" data-tier={x}
                            className={'px-1.5 py-0.5 ' + (t === x ? 'bg-brand text-white' : 'text-ink-dim hover:bg-bg-subtle')}
                            onClick={() => {
                              setTier({ ...tier, [e.id]: x });
                              if (active) void use(e, x, fin);
                            }}>
                            {x === 'draft' ? 'Draft' : 'Final'}
                          </button>
                        ))}
                      </div>
                    )}
                    <StatusChip status={e.status} text={e.chip} testId={`chip-${e.id}`}
                      title={`${e.on ? `On ${e.on.label}` : ''}${e.note ? `: ${e.note}` : ''}`} />
                    {needsFiles ? (
                      <button type="button" className="chip h-6 shrink-0 px-2 py-0 text-[11px]" onClick={() => getThem(e)} data-testid={`get-${e.id}`}
                        title="Choose the files to download into your ComfyUI's models folder">
                        Get them
                      </button>
                    ) : (
                      <button type="button" className="chip h-6 shrink-0 px-2 py-0 text-[11px]" disabled={busy !== null} onClick={() => void use(e)} data-testid={`use-${e.id}`}
                        title={e.comp ? `Opens ${e.comp.label}` : 'Makes it the workflow of the Marker and Storyboard tabs'}>
                        {busy === e.id ? '…' : active ? 'In use' : 'Use it'}
                      </button>
                    )}
                  </div>
                  {e.tiers && t === 'final' && (
                    <div className="flex flex-wrap items-center gap-1 px-2 pb-1.5 pl-9" data-testid={`finals-${e.id}`}>
                      <span className="text-[10px] text-ink-mute">then</span>
                      {e.tiers.finals.map((x) => (
                        <button key={x.id} type="button" data-final={x.id} title={x.note}
                          className={'chip h-5 px-1.5 py-0 text-[10px] ' + (fin?.id === x.id ? '!border-brand/70 !bg-brand/15 !text-ink' : '')}
                          onClick={() => {
                            setFinalPick({ ...finalPick, [e.id]: x.id });
                            if (active) void use(e, 'final', x);
                          }}>
                          {x.label}
                        </button>
                      ))}
                    </div>
                  )}
                  {isOpen && <Details e={e} tierNote={e.tiers ? (t === 'draft' ? e.tiers.draft.note : fin?.note) : undefined} onGet={() => getThem(e)} />}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

const ICON: Record<string, string> = { local: '⌂', cloud: '☁', deployment: '▣', proxy: '⇄' };

/** Behind ▸: where else it runs, the files and packs it needs on your ComfyUI, its licence. */
function Details({ e, tierNote, onGet }: { e: ReadinessEntry; tierNote?: string; onGet: () => void }): JSX.Element {
  return (
    <div className="space-y-2 border-t border-line px-2.5 py-2 text-[10px] leading-snug" data-testid={`detail-panel-${e.id}`}>
      {tierNote && <p className="text-ink-mute">{tierNote}</p>}
      {e.note && <p className="text-ink-dim">{e.on ? `${e.on.label}: ` : ''}{e.note}</p>}
      <div>
        <div className="mb-0.5 text-ink-dim">Where it runs</div>
        <ul className="space-y-0.5">
          {e.elsewhere.map((r) => (
            <li key={r.id} className="flex items-center gap-1.5" data-runs-on={r.id} data-status={r.status}>
              <span className="w-3 shrink-0 text-ink-mute">{ICON[r.kind] ?? '·'}</span>
              <span className="min-w-0 flex-1 truncate text-ink-dim" title={r.note}>{r.label}</span>
              <StatusChip status={r.status} text={r.chip} title={r.note} />
            </li>
          ))}
        </ul>
      </div>
      <div data-testid={`missing-${e.id}`}>
        <div className="mb-0.5 flex items-center justify-between text-ink-dim">
          <span>Files on your ComfyUI{e.missing.count ? ` · ${e.missing.count} missing${e.missing.bytes ? `, ${formatBytes(e.missing.bytes)}` : ''}` : ''}</span>
          {e.missing.count > 0 && <button type="button" className="text-brand hover:underline" onClick={onGet}>Get them…</button>}
        </div>
        <ul className="space-y-0.5 font-mono">
          {e.files.map((f) => (
            <li key={f.key} className="flex items-baseline gap-1.5" title={f.url}>
              <span className={'w-3 shrink-0 ' + (f.state === 'missing' && !f.onDisk ? 'text-warn' : f.state === 'unknown' ? 'text-ink-mute' : 'text-ok')}>
                {f.state === 'missing' && !f.onDisk ? '✗' : f.state === 'unknown' ? '?' : '✓'}
              </span>
              <span className="min-w-0 flex-1 truncate text-ink-dim">
                {f.directory}/{f.name}{f.draftOnly ? ' (Draft)' : ''}
                {f.state === 'variant' && f.using ? <span className="text-ink-mute"> → yours: {f.using}</span> : null}
                {f.onDisk ? <span className="text-warn"> — in your folder, not listed by ComfyUI yet: restart it or press Refresh in its UI</span> : null}
              </span>
              <span className="shrink-0 text-ink-mute">{f.size !== null ? formatBytes(f.size) : ''}</span>
              <a className="shrink-0 text-ink-mute underline hover:text-ink" href={f.pageUrl} target="_blank" rel="noreferrer">{f.repo || 'source'}</a>
            </li>
          ))}
        </ul>
      </div>
      {e.packs.length > 0 && (
        <div>
          <div className="mb-0.5 text-ink-dim">Custom nodes</div>
          <ul className="space-y-0.5">
            {e.packs.map((p) => (
              <li key={p.id} className="flex items-baseline gap-1.5" data-pack={p.id}>
                <span className={'w-3 shrink-0 ' + (p.installed === false ? 'text-warn' : p.installed ? 'text-ok' : 'text-ink-mute')}>{p.installed === false ? '✗' : p.installed ? '✓' : '?'}</span>
                <span className="min-w-0 flex-1 text-ink-dim">
                  {p.name}{p.installed === false ? ' — install it with ComfyUI Manager, then restart ComfyUI' : p.installed ? ' installed' : ''}
                </span>
                <a className="shrink-0 text-ink-mute underline hover:text-ink" href={p.repo} target="_blank" rel="noreferrer">source</a>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-ink-mute" data-testid={`licence-${e.id}`}>
        Licence: {e.licence.text}
        {e.licence.url && <> — <a className="underline hover:text-ink" href={e.licence.url} target="_blank" rel="noreferrer">text</a></>}
      </p>
    </div>
  );
}
