/**
 * Saving and restoring the work that is NOT in the workflow file.
 *
 * A shot list is hours of typing — a prompt per slot, a reference frame per
 * slot, sometimes a different model on one row — and until now all of it lived
 * in the panel's memory and a couple of localStorage keys. Close the project,
 * come back tomorrow, and it was gone. This is the file that carries it.
 *
 * The whole difficulty is in one line of the request: *the markers and the
 * adjustment layers have to correspond*. They do not, and cannot be made to.
 *
 *   - A marker shot's id is `seg-0`, `seg-1`… — its POSITION in the sorted list
 *     of marker pairs. Insert one marker at the head of the comp and every id
 *     after it means a different shot. The ids are also not namespaced by comp,
 *     so `seg-0` of one comp and `seg-0` of another are the same key: the
 *     per-shot workflow override already leaks between comps because of it.
 *   - A placeholder's id is `adj-{inPointMs}-{slug of the layer name}`, which
 *     is stable until somebody nudges the layer or renames it — i.e. until
 *     somebody edits, which is the point of a storyboard.
 *
 * So the file stores NO ids. It stores what a person would use to recognise a
 * shot — where it starts, how long it is, what it is called, what colour it is
 * — and the match is made again at load time against whatever is in the comp
 * then, best evidence first, each slot claimed once. Anything the matcher had
 * to guess at is reported, and nothing is applied until the user says so.
 *
 * Restoring silently would be the worse failure: a prompt landing on the wrong
 * shot is invisible until the render comes back describing something else.
 */

/*
 * This module imports nothing, on purpose.
 *
 * Same reason as `workflows/wfsearch.ts`: the matcher is the part that can go
 * wrong quietly — it keeps returning pairs, just the wrong ones — so it has to
 * be testable on its own, and `scripts/selftest.mjs` compiles a leaf file in
 * isolation. The two shapes it needs from elsewhere are declared structurally
 * below; TypeScript checks them against the real `Segment` and `AttachmentRef`
 * at every call site, so they cannot drift without the build saying so. It also
 * keeps a serialised FORMAT from being defined by a UI type that is free to
 * change.
 */

/** A slot in the comp — structurally what `state/segments.ts` produces. */
export interface SlotLike {
  id: string;
  startTime: number;
  endTime: number;
  duration: number;
  label: string;
  source?: 'marker' | 'adj';
  labelColor?: number;
  layerName?: string;
  startMarkerName?: string;
  endMarkerName?: string;
}

/** A file the user attached to a shot — structurally `store.AttachmentRef`. */
export interface AttachmentLike {
  fieldId: string;
  kind: 'image' | 'video' | 'audio';
  localPath: string;
  filename: string;
}

export const SETUP_FORMAT = 'justae-flow2-setup';
export const SETUP_VERSION = 1;

/** How the file records one slot, and what the user attached to it. */
export interface SetupShot {
  /** Position in the list at save time — the last-resort match, and a label. */
  ordinal: number;
  source: 'marker' | 'adj';
  slot: { start: number; end: number; duration: number };
  /** What a person would use to recognise it. */
  identity: {
    label: string;
    /** Placeholder only: the adjustment layer's name and AE label colour. */
    layerName?: string;
    labelColor?: number;
    /** Marker only: the comments on the pair, which are the shot's name. */
    startMarkerName?: string;
    endMarkerName?: string;
  };
  selected: boolean;
  prompt: string;
  /**
   * The workflow this row runs, or '' to follow the default.
   *
   * The library's own id, which is `origin:path` — "server:H3 First Last Frame
   * to Video.json". Readable, and stable across sessions as long as the file
   * stays where it is; when it does not, the load says which one it could not
   * find instead of silently falling back to whatever is selected.
   */
  workflowId: string;
  attachments: AttachmentLike[];
}

/** Per-workflow settings, saved alongside because a prompt alone is half the work. */
export interface SetupWorkflow {
  values: Record<string, string | number | boolean>;
  promptTarget?: string;
  fieldPrefs?: { pinned: string[]; hidden: string[] };
}

export interface SetupFile {
  format: typeof SETUP_FORMAT;
  version: number;
  savedAt: string;
  /**
   * The comp this was made against.
   *
   * Recorded to be SHOWN, not enforced. Loading a setup into a different comp
   * is a real thing to want — the same shot list against a re-cut edit — and
   * refusing it would be the panel deciding for the user. But a 25 fps setup
   * dropped into a 30 fps comp shifts every frame boundary, and that is worth
   * a sentence before it happens.
   */
  comp: { name: string; width: number; height: number; fps: number } | null;
  mode: 'marker' | 'storyboard';
  shots: SetupShot[];
  /** Keyed by workflow id, and only the ones this setup's shots name. */
  workflows: Record<string, SetupWorkflow>;
}

/* ─── Writing ────────────────────────────────────────────────────────── */

export interface BuildInput {
  mode: 'marker' | 'storyboard';
  comp: { name: string; width: number; height: number; fps: number } | null;
  segments: SlotLike[];
  selectedIds: string[];
  prompts: Record<string, string>;
  attachments: Record<string, AttachmentLike[]>;
  /** Segment id → workflow id. */
  shotWorkflows: Record<string, string>;
  /** Workflow id → what the user set on it. */
  workflows: Record<string, SetupWorkflow>;
}

export function buildSetup(input: BuildInput): SetupFile {
  const shots: SetupShot[] = input.segments.map((seg, i) => ({
    ordinal: i + 1,
    source: seg.source === 'adj' ? 'adj' : 'marker',
    slot: {
      start: round3(seg.startTime),
      end: round3(seg.endTime),
      duration: round3(seg.duration),
    },
    identity: {
      label: seg.label,
      ...(seg.source === 'adj'
        ? { layerName: seg.layerName ?? seg.label, labelColor: seg.labelColor ?? 0 }
        : { startMarkerName: seg.startMarkerName, endMarkerName: seg.endMarkerName }),
    },
    selected: input.selectedIds.includes(seg.id),
    prompt: input.prompts[seg.id] ?? '',
    workflowId: input.shotWorkflows[seg.id] ?? '',
    attachments: input.attachments[seg.id] ?? [],
  }));

  /*
   * Only the workflows this setup actually mentions.
   *
   * The panel's `values` map accumulates every workflow opened this session;
   * writing all of it would put a stranger's settings in a file named after
   * this shot list, and restoring it would quietly change workflows the user
   * did not think they were touching.
   */
  const mentioned = new Set(shots.map((s) => s.workflowId).filter(Boolean));
  const workflows: Record<string, SetupWorkflow> = {};
  for (const ref of mentioned) {
    const w = input.workflows[ref];
    if (w) workflows[ref] = w;
  }

  return {
    format: SETUP_FORMAT,
    version: SETUP_VERSION,
    savedAt: new Date().toISOString(),
    comp: input.comp,
    mode: input.mode,
    shots,
    workflows,
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/* ─── Reading ────────────────────────────────────────────────────────── */

/**
 * Parse and check, with a reason when it is not one of ours.
 *
 * A wrong file picked from a folder of JSON is the likely mistake, and "not a
 * shot setup" beats a stack trace or, worse, half an application.
 */
export function parseSetup(text: string): { setup: SetupFile } | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: 'That file is not JSON.' };
  }
  if (!raw || typeof raw !== 'object') return { error: 'That file is not a shot setup.' };
  const o = raw as Partial<SetupFile>;
  if (o.format !== SETUP_FORMAT) {
    return { error: 'That is a JSON file, but not a JustAE shot setup — it may be a ComfyUI workflow.' };
  }
  if (typeof o.version !== 'number' || o.version > SETUP_VERSION) {
    return { error: `That setup was written by a newer version of the panel (v${String(o.version)}).` };
  }
  if (!Array.isArray(o.shots)) return { error: 'That setup has no shots in it.' };
  return {
    setup: {
      format: SETUP_FORMAT,
      version: o.version,
      savedAt: typeof o.savedAt === 'string' ? o.savedAt : '',
      comp: o.comp ?? null,
      mode: o.mode === 'storyboard' ? 'storyboard' : 'marker',
      shots: o.shots,
      workflows: o.workflows ?? {},
    },
  };
}

/* ─── Matching ───────────────────────────────────────────────────────── */

/** How a saved shot found its slot — weakest last, and shown to the user. */
export type MatchKind = 'exact' | 'name' | 'time' | 'ordinal';

export interface Match {
  shot: SetupShot;
  segment: SlotLike;
  how: MatchKind;
}

export interface MatchPlan {
  matched: Match[];
  /** Saved shots with nowhere to go. */
  orphans: SetupShot[];
  /** Slots in the comp that the setup says nothing about. */
  untouched: SlotLike[];
  /** Workflow refs the setup names that the library does not have. */
  missingWorkflows: string[];
  /** Attachments whose file is no longer on disk, as "shot label → filename". */
  missingFiles: string[];
}

/**
 * Half a frame, in seconds — the tolerance for "the same start".
 *
 * After Effects reports times as floats and the last digits jitter between
 * reads; the panel's own segment comparison already rounds to milliseconds for
 * that reason. Half a frame is tight enough that two adjacent shots can never
 * both claim one slot and loose enough to survive the jitter.
 */
function tolerance(fps: number | undefined): number {
  return 0.5 / (fps && fps > 0 ? fps : 25);
}

/**
 * Pair every saved shot with a slot in the comp, best evidence first.
 *
 * Four passes, each over the shots not yet placed and the slots not yet taken.
 * The order is the order of confidence, and it is what makes the result
 * explainable — "matched by name" tells the user the layer moved, "matched by
 * position" tells them to check.
 *
 *   1. exact    same kind, same start AND same length
 *   2. name     same kind, same name, and that name is unique on both sides
 *   3. time     same kind, same start — the slot was renamed
 *   4. ordinal  same place in the list, and only when the two lists are the
 *               same length. Without that condition it is not evidence at all.
 */
export function matchSetup(
  setup: SetupFile,
  segments: SlotLike[],
  fps: number | undefined,
  opts: { knownWorkflows?: Set<string>; fileExists?: (path: string) => boolean } = {},
): MatchPlan {
  const tol = tolerance(fps);
  const wantKind = (s: SetupShot): 'marker' | 'adj' => s.source;
  const gotKind = (s: SlotLike): 'marker' | 'adj' => (s.source === 'adj' ? 'adj' : 'marker');
  const nameOf = (s: SetupShot): string =>
    (s.source === 'adj' ? s.identity.layerName ?? s.identity.label : s.identity.label).trim();
  const segName = (s: SlotLike): string =>
    (s.source === 'adj' ? s.layerName ?? s.label : s.label).trim();

  const remainingShots = [...setup.shots].sort((a, b) => a.ordinal - b.ordinal);
  const remainingSegs = [...segments];
  const matched: Match[] = [];

  const take = (shot: SetupShot, segment: SlotLike, how: MatchKind): void => {
    matched.push({ shot, segment, how });
    remainingShots.splice(remainingShots.indexOf(shot), 1);
    remainingSegs.splice(remainingSegs.indexOf(segment), 1);
  };

  const sweep = (how: MatchKind, pick: (shot: SetupShot) => SlotLike | null): void => {
    // A copy, because `take` mutates the list underneath.
    for (const shot of [...remainingShots]) {
      const seg = pick(shot);
      if (seg) take(shot, seg, how);
    }
  };

  sweep('exact', (shot) => remainingSegs.find((seg) => gotKind(seg) === wantKind(shot)
    && Math.abs(seg.startTime - shot.slot.start) <= tol
    && Math.abs(seg.duration - shot.slot.duration) <= tol) ?? null);

  sweep('name', (shot) => {
    const want = nameOf(shot);
    if (!want) return null;
    const hits = remainingSegs.filter((seg) => gotKind(seg) === wantKind(shot) && segName(seg) === want);
    if (hits.length !== 1) return null;
    // Unique on the saved side too, or two identically named shots would both
    // grab the same slot and the second would silently lose its prompt.
    const twins = remainingShots.filter((s) => wantKind(s) === wantKind(shot) && nameOf(s) === want);
    return twins.length === 1 ? hits[0] : null;
  });

  sweep('time', (shot) => remainingSegs.find((seg) => gotKind(seg) === wantKind(shot)
    && Math.abs(seg.startTime - shot.slot.start) <= tol) ?? null);

  /*
   * Position, and only when the two lists are the same length.
   *
   * With different lengths the ordinals line up by accident at best: a setup of
   * nine dropped into a comp of eight would shift every prompt by one from the
   * first insertion onwards, which is precisely the failure this whole file
   * exists to avoid. Better to hand back orphans and let the user look.
   */
  if (setup.shots.length === segments.length) {
    sweep('ordinal', (shot) => {
      const seg = segments[shot.ordinal - 1];
      return seg && remainingSegs.includes(seg) && gotKind(seg) === wantKind(shot) ? seg : null;
    });
  }

  const missingWorkflows = opts.knownWorkflows
    ? [...new Set(setup.shots.map((s) => s.workflowId).filter(
      (ref) => ref && !opts.knownWorkflows?.has(ref),
    ))]
    : [];

  const missingFiles: string[] = [];
  if (opts.fileExists) {
    for (const m of matched) {
      for (const att of m.shot.attachments) {
        if (!opts.fileExists(att.localPath)) missingFiles.push(`${m.segment.label} → ${att.filename}`);
      }
    }
  }

  return {
    matched: matched.sort((a, b) => a.segment.startTime - b.segment.startTime),
    orphans: remainingShots,
    untouched: remainingSegs,
    missingWorkflows,
    missingFiles,
  };
}

/** One line of plain English for the review panel. */
export function describePlan(plan: MatchPlan): string {
  const byKind = (k: MatchKind): number => plan.matched.filter((m) => m.how === k).length;
  const bits: string[] = [`${plan.matched.length} matched`];
  const weak = byKind('name') + byKind('time') + byKind('ordinal');
  if (weak > 0) {
    const parts: string[] = [];
    if (byKind('name') > 0) parts.push(`${byKind('name')} by name`);
    if (byKind('time') > 0) parts.push(`${byKind('time')} by start time`);
    if (byKind('ordinal') > 0) parts.push(`${byKind('ordinal')} by position`);
    bits.push(`of which ${parts.join(', ')}`);
  }
  if (plan.orphans.length > 0) bits.push(`${plan.orphans.length} saved shot(s) with no slot`);
  if (plan.untouched.length > 0) bits.push(`${plan.untouched.length} slot(s) left as they are`);
  return `${bits.join(' · ')}.`;
}
