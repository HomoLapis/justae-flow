/**
 * A section of the guide (docs/GUIDE.md), shown in the window — the setup instructions live there and only there (the
 * Comfy Developer Platform: Comfy Cloud with an API key, or your own deployment). The server reads the section from the
 * guide the user has (GET /api/readme?section=<anchor>); links to other sections open those, here.
 *
 * The Markdown is drawn by a small reader that knows what the guide uses: headings, paragraphs, lists, tables,
 * code blocks, `code`, **bold**, *emphasis* and links.
 */

import { useEffect, useState } from 'react';
import { serverJson } from '../bridge/server';

export function ReadmeSection({ anchor, onClose }: { anchor: string; onClose: () => void }): JSX.Element {
  const [stack, setStack] = useState<string[]>([anchor]);
  const current = stack[stack.length - 1];
  const [sec, setSec] = useState<{ title: string; markdown: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setSec(null);
    serverJson<{ title: string; markdown: string }>(`/api/readme?section=${encodeURIComponent(current)}`)
      .then((s) => { if (alive) { setSec(s); setError(null); } })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [current]);

  return (
    <div className="absolute inset-0 z-[60] flex flex-col bg-bg" data-testid="readme-section">
      <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-line px-3.5">
        <div className="flex min-w-0 items-center gap-2">
          {stack.length > 1 && <button className="btn-quiet h-8 px-2 text-xs" onClick={() => setStack(stack.slice(0, -1))}>← Back</button>}
          <h2 className="truncate text-sm font-semibold text-ink">Guide ▸ {sec?.title ?? '…'}</h2>
        </div>
        <button className="btn-quiet h-8 px-3 text-xs" onClick={onClose}>Done</button>
      </header>
      <div className="flex-1 overflow-y-auto px-3.5 py-3 text-[12px] leading-relaxed text-ink-dim">
        {error && <p className="text-err">{error}</p>}
        {sec && <Markdown text={sec.markdown} onAnchor={(a) => setStack([...stack, a])} />}
      </div>
    </div>
  );
}

function Inline({ text, onAnchor }: { text: string; onAnchor: (a: string) => void }): JSX.Element {
  const out: React.ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[([^\]]+)\]\(([^)\s]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(<code key={k++} className="rounded bg-bg-subtle px-1 font-mono text-[11px] text-ink">{m[1].slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k++} className="text-ink">{m[2].slice(2, -2)}</strong>);
    else if (m[3]) out.push(<em key={k++}>{m[3].slice(1, -1)}</em>);
    else if (m[4]) {
      const href = m[6];
      const label = m[5];
      out.push(href.startsWith('#')
        ? <button key={k++} type="button" className="text-brand underline" onClick={() => onAnchor(href.slice(1))}>{label}</button>
        : <a key={k++} className="text-brand underline" href={href} target="_blank" rel="noreferrer">{label}</a>);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

/** The guide's Markdown, block by block. */
export function Markdown({ text, onAnchor }: { text: string; onAnchor: (a: string) => void }): JSX.Element {
  const lines = text.split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
      i++;
      blocks.push(<pre key={k++} className="my-2 overflow-x-auto rounded-lg bg-bg-subtle p-2 font-mono text-[10.5px] leading-snug text-ink">{body.join('\n')}</pre>);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(l);
    if (h) {
      blocks.push(<h3 key={k++} className="mb-1 mt-3 text-[13px] font-semibold text-ink"><Inline text={h[2]} onAnchor={onAnchor} /></h3>);
      i++;
      continue;
    }
    if (/^\|/.test(l)) {
      const rows: string[][] = [];
      while (i < lines.length && /^\|/.test(lines[i])) {
        if (!/^\|[\s:|-]+\|$/.test(lines[i])) rows.push(lines[i].replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
        i++;
      }
      blocks.push(
        <table key={k++} className="my-2 w-full border-collapse text-[11px]">
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri} className={ri === 0 ? 'text-ink' : 'border-t border-line/60'}>
                {r.map((c, ci) => <td key={ci} className="py-1 pr-2 align-top"><Inline text={c} onAnchor={onAnchor} /></td>)}
              </tr>
            ))}
          </tbody>
        </table>,
      );
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
      const items: string[] = [];
      const ordered = /^\s*\d+\./.test(l);
      while (i < lines.length && lines[i].trim() !== '' && !/^```|^#/.test(lines[i])) {
        if (/^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ''));
        else items[items.length - 1] += ` ${lines[i].trim()}`;
        i++;
      }
      const List = ordered ? 'ol' : 'ul';
      blocks.push(<List key={k++} className={'my-1.5 space-y-1 pl-5 ' + (ordered ? 'list-decimal' : 'list-disc')}>{items.map((x, xi) => <li key={xi}><Inline text={x} onAnchor={onAnchor} /></li>)}</List>);
      continue;
    }
    if (l.trim() === '' || /^<!--/.test(l)) { i++; continue; }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && !/^```|^#|^\||^\s*([-*]|\d+\.)\s+/.test(lines[i])) para.push(lines[i++].trim());
    blocks.push(<p key={k++} className="my-1.5"><Inline text={para.join(' ')} onAnchor={onAnchor} /></p>);
  }
  return <>{blocks}</>;
}
