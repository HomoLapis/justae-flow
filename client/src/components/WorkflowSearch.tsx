/**
 * Choosing a workflow by name.
 *
 * The tab used to offer a plain `<select>` holding the whole library in two
 * optgroups. On a real ComfyUI that is hundreds of entries in one scrolling
 * menu, with no way to type — to reach "Krea2_PRO_InstructionEdit" you scrolled
 * past two hundred others.
 *
 * So the picker IS the search: type a few letters, the matches appear right
 * under the box, click one. The list is drawn inline rather than as a floating
 * menu — in a docked AE panel a few hundred pixels wide, an overlay would cover
 * the very field you are typing in.
 *
 * IT IS STILL A DROPDOWN, though, and the first version of this forgot it: the
 * list only appeared once you had typed something, so someone who wanted to see
 * what was there found a `<select>` replaced by a box that showed nothing.
 * Browsing is not a fallback for search, it is how you use a library you have
 * not memorised. Clicking the current selection opens the whole list, exactly
 * like the menu this replaced; typing narrows it.
 *
 * Ported from JustPhotoshop, which solved the same problem against the same
 * kind of library. The ranking lives in `workflows/wfsearch.ts`, kept byte-
 * identical to that plugin's copy so the two behave the same way.
 */

import { useMemo, useState } from 'react';
import type { WorkflowSummary } from '../workflows/library';
import { searchWorkflows, termsOf, type SearchHit } from '../workflows/wfsearch';

/** How many matches to draw at once — enough to choose, short enough to scan. */
const SHOWN = 40;

/**
 * What the ranker sees.
 *
 * `WorkflowSummary` carries neither a label nor a folder, so both are derived
 * here rather than by widening that type: `ref` already holds the path, and
 * this is the only place that needs it split. `name` is the summary id because
 * the ranker only ever scores `label` and `folder` — it wants a key, not a
 * second name.
 */
interface Entry {
  name: string;
  label: string;
  folder: string;
  summary: WorkflowSummary;
}

/** "video/ltx-i2v.json" → "video". Absolute project paths have no useful folder. */
function folderOf(s: WorkflowSummary): string {
  if (s.origin !== 'server') return '';
  const parts = s.ref.replace(/\\/g, '/').split('/');
  parts.pop();
  return parts.join('/');
}

function toEntry(s: WorkflowSummary): Entry {
  return { name: s.id, label: s.name, folder: folderOf(s), summary: s };
}

/** The matched run, drawn bright — plain spans, no pseudo-elements. */
function Highlight({ text, hit }: { text: string; hit: [number, number] | null }): JSX.Element {
  if (!hit) return <>{text}</>;
  return (
    <>
      {text.slice(0, hit[0])}
      <span className="text-brand font-semibold">{text.slice(hit[0], hit[1])}</span>
      {text.slice(hit[1])}
    </>
  );
}

export function WorkflowSearch({
  library,
  activeId,
  activeName,
  serverLabel,
  onPick,
  busy = false,
}: {
  library: WorkflowSummary[];
  activeId: string;
  /**
   * The selected workflow's name even when it is NOT in the library — a graph
   * taken off the editor canvas is not a file, so it has no summary, but it IS
   * what is selected and a picker that shows blank while something is selected
   * is a lie.
   */
  activeName: string | null;
  serverLabel: string;
  onPick: (id: string) => void;
  busy?: boolean;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const [browsing, setBrowsing] = useState(false);

  const entries = useMemo(() => library.map(toEntry), [library]);
  const active = useMemo(() => library.find((w) => w.id === activeId) ?? null, [library, activeId]);
  const terms = useMemo(() => termsOf(query), [query]);

  const matches: Array<SearchHit<Entry>> = useMemo(() => {
    if (!terms.length) {
      return browsing
        ? entries
          .map((item) => ({ item, score: 0, hit: null as [number, number] | null }))
          .sort((a, b) => `${a.item.folder}/${a.item.label}`.localeCompare(`${b.item.folder}/${b.item.label}`))
        : [];
    }
    return searchWorkflows(entries, query);
  }, [entries, terms, browsing, query]);

  /*
   * Once open, the list stays open until something closes it deliberately —
   * picking, Escape, or the same control that opened it. Emptying the search
   * box used to close it, which meant deleting a typo collapsed the list you
   * were reading.
   */
  const pick = (id: string): void => {
    onPick(id);
    setQuery('');
    setBrowsing(false);
  };

  const showList = terms.length > 0 || browsing;
  const shown = matches.slice(0, SHOWN);
  const label = active ? active.name : activeName;

  return (
    <div className="space-y-1.5">
      {/* What is loaded right now, always visible — and the way into the list,
          because this is the line everyone clicks on expecting a menu. */}
      <button
        type="button"
        className="flex w-full items-baseline gap-2 rounded-lg border border-line/70 bg-bg-raised px-3 py-2 text-left hover:bg-bg-hover"
        disabled={busy}
        title={showList ? 'Close the list' : `Show all ${library.length} workflows`}
        onClick={() => { if (query) setQuery(''); setBrowsing((v) => !v); }}
      >
        <span className={'min-w-0 flex-1 truncate text-sm ' + (label ? 'text-ink' : 'text-ink-mute')}>
          {label ?? 'no workflow selected'}
        </span>
        {active && (
          <span className="shrink-0 text-[10px] text-ink-mute">
            {active.origin === 'server' ? serverLabel : active.origin === 'bundled' ? 'JustAE Flow' : 'project'}
          </span>
        )}
        <span className={'shrink-0 text-[9px] text-ink-mute transition-transform ' + (showList ? 'rotate-180' : '')}>
          ▼
        </span>
      </button>

      <div className="flex items-center gap-1.5">
        <input
          className="input flex-1"
          placeholder="Search workflows by name…"
          value={query}
          disabled={busy}
          onChange={(e) => setQuery(e.target.value)}
          // Landing in the box means you are looking for something: show what
          // there is straight away rather than waiting for the first keystroke.
          onFocus={() => setBrowsing(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && shown.length) {
              e.preventDefault();
              pick(shown[0].item.summary.id);
            } else if (e.key === 'Escape') {
              setQuery('');
              setBrowsing(false);
            }
          }}
        />
        <button
          className={'chip shrink-0' + (browsing ? ' bg-bg-hover text-ink' : '')}
          disabled={busy}
          title="Show every workflow in the library"
          onClick={() => {
            if (query) setQuery('');
            setBrowsing((v) => !v);
          }}
        >
          {browsing ? 'Close' : `All ${library.length}`}
        </button>
      </div>

      {terms.length > 0 && (
        <p className="text-[10px] leading-snug text-ink-mute">
          {matches.length === 0
            ? 'No workflow with that name.'
            : `${matches.length} match${matches.length === 1 ? '' : 'es'}`
              + (matches.length > SHOWN ? ` · showing the first ${SHOWN}, narrow the search` : '')
              + ' · Enter picks the first'}
        </p>
      )}

      {showList && shown.length > 0 && (
        <div className="max-h-64 overflow-y-auto rounded-lg border border-line/70 bg-bg-raised">
          {shown.map(({ item, hit }) => (
            <button
              key={item.summary.id}
              className={'flex w-full items-baseline gap-2 px-3 py-1.5 text-left hover:bg-bg-hover '
                + (item.summary.id === activeId ? 'bg-bg-hover' : '')}
              title={item.summary.ref}
              onClick={() => pick(item.summary.id)}
            >
              <span className="min-w-0 flex-1 truncate text-[12px] text-ink">
                <Highlight text={item.label} hit={hit} />
              </span>
              {/* Where it lives decides whether the editor can open it, so it
                  travels with the name rather than being a separate section. */}
              <span className="shrink-0 text-[10px] text-ink-mute">
                {item.summary.origin === 'server' ? (item.folder || serverLabel) : item.summary.origin === 'bundled' ? 'JustAE Flow' : 'project'}
              </span>
            </button>
          ))}
        </div>
      )}

      {showList && shown.length === 0 && browsing && (
        <p className="text-[10px] leading-snug text-ink-mute">The library is empty.</p>
      )}
    </div>
  );
}
