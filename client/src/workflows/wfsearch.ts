// Finding one flow among hundreds, by name — pure, so the self-test can pin it.
//
// The library measured on a real ComfyUI holds 271 workflows across nested
// folders. Two properties decide whether the search is usable there:
//
//  • EVERY term must match, in any order. Nobody remembers whether the file
//    is "Krea2_PRO_InstructionEdit" or "InstructionEdit_Krea2_PRO", but
//    everybody remembers "krea" and "edit".
//  • A hit in the NAME outranks a hit in the folder. A folder called
//    "krea2ProGrade_v703" holds nine flows; typing "krea" must not bury the
//    one actually called Krea2 under its own neighbours.
//
// No imports: the self-test compiles this file alone.

export type Searchable = { name: string; label: string; folder?: string };

export type SearchHit<T> = {
  item: T;
  /** Lower is better. */
  score: number;
  /** [start, end) of the first term inside the label, for highlighting. */
  hit: [number, number] | null;
};

/** Split a query into the terms that must all be present. */
export function termsOf(query: string): string[] {
  return String(query ?? "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Rank one item, or return null when it does not match every term.
 *
 * Ranks, best first:
 *   0 — the label starts with the first term
 *   1 — a word inside the label starts with it
 *   2 — it appears anywhere in the label
 *   3 — it appears only in the folder
 * Within a rank the shorter label wins: it is the more specific hit.
 */
export function scoreItem<T extends Searchable>(item: T, terms: string[]): SearchHit<T> | null {
  const label = String(item.label ?? "").toLowerCase();
  const folder = String(item.folder ?? "").toLowerCase();
  const hay = `${folder}/${label}`;
  for (const t of terms) if (!hay.includes(t)) return null;
  if (!terms.length) return { item, score: 0, hit: null };

  const first = terms[0];
  const at = label.indexOf(first);
  let rank: number;
  if (at === 0) rank = 0;
  else if (at > 0 && /[^a-z0-9]/.test(label.charAt(at - 1))) rank = 1;
  else if (at > 0) rank = 2;
  else rank = 3;

  return {
    item,
    score: rank * 1000 + Math.min(999, label.length),
    hit: at >= 0 ? [at, at + first.length] : null,
  };
}

/** Every match, best first. An empty query matches everything, unranked. */
export function searchWorkflows<T extends Searchable>(items: T[], query: string): SearchHit<T>[] {
  const terms = termsOf(query);
  const out: SearchHit<T>[] = [];
  for (const item of items ?? []) {
    const s = scoreItem(item, terms);
    if (s) out.push(s);
  }
  out.sort((a, b) => a.score - b.score || String(a.item.label).localeCompare(String(b.item.label)));
  return out;
}
