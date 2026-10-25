/**
 * The storyboard: every place in the project where something will be
 * generated, as a card. A card is born from a marker, a placeholder layer, an
 * existing layer the user hands over, or (PhotoCraft) a selection.
 *
 * Cards live in a sidecar file next to the project — the host project stays a
 * plain project that opens fine without this app — and every generation is
 * kept as a numbered version, never overwritten.
 */

export type CardStatus = 'idle' | 'queued' | 'running' | 'done' | 'error' | 'canceled';

export type CardOrigin =
  /** A composition marker. Identified by the card id we store in its cue point; time and text are mirrors. */
  | { kind: 'marker'; time: number; comment: string }
  /** A placeholder we created (timeline: an item on a layer; canvas: a filled layer), which the user moves and scales. */
  | { kind: 'placeholder'; layerId: number; itemId: number; width?: number; height?: number; box?: Box }
  /** Any existing layer the user turned into a card (its media is the input). */
  | { kind: 'layer'; layerId: number; itemId: number; sourcePath: string | null; width?: number; height?: number; labelBefore?: string; box?: Box }
  /** Canvas hosts: a selection, saved in the document as an alpha channel so it outlives the next click. */
  | { kind: 'selection'; channel: string; box: Box }
  /**
   * Timeline hosts, the Comp tab: the composition itself — its work area or all of it, `start`…`end`
   * in comp seconds. It is rendered by the host each time the card runs (so the run sees the comp as it
   * is then), and the render is imported next to the result.
   */
  | { kind: 'comp'; range: 'workArea' | 'comp'; start: number; end: number; width?: number; height?: number; box?: never };

/** Which Comp tab tool made a card, from where, with which choices. */
export interface CompTool {
  /** The tool's id in core/comp/tools.ts (reframe, upscale, matte, …). */
  id: string;
  /** Where its input comes from: a render of the work area or of the whole comp, or the selected layer's own file. */
  source: 'workArea' | 'comp' | 'layer';
  /** The tool's choices as the Comp tab sent them (format, quality, scale, mode…). */
  options: Record<string, string | number | boolean>;
  /** Longest render of the comp, seconds (the Flow window's "Work-area render cap"). */
  cap?: number;
  /** One card per tool, variant ("draft:9:16", "x2") and source; a second run of the same thing is its next version. */
  variant?: string;
  /** The source comp's name when the run was queued (the result comps are named after it). */
  compName?: string;
  /** What the run was said to make when it was queued (core/comp/tools.ts). */
  plan?: { makes: string; width?: number; height?: number; seconds?: number; note?: string };
  /** The result's name: "<Comp> · 9:16". */
  label?: string;
  /** A run queued by a pack (the Social pack): the pack's id and name; Results shows its runs together. */
  group?: { id: string; label: string; at: string };
  /** What follows when this run is done (the Social pack): an upscale of its result comp, and a master of the last comp. */
  then?: { upscale?: boolean; masters?: 'none' | 'prores4444' | 'png16' };
}

/** Original/result, switched by showing and hiding layers (and a track matte), never by deleting anything. */
export interface CompareState {
  compId: number;
  showing: 'result' | 'original';
  /** Layer id → visible, for each state. */
  result: Array<[number, boolean]>;
  original: Array<[number, boolean]>;
  /** A matte: the result is the layer with its track matte set, the original the layer without it. */
  matte?: { layer: number; matte: number };
  /** Nothing to hide (a crop): the original is this comp, opened in turn with the result's. */
  openOriginal?: number;
}

export type Box = [x: number, y: number, w: number, h: number];

export interface Version {
  n: number;
  /** Relative to the media folder. */
  file: string;
  kind: 'image' | 'video';
  workflowId: string;
  prompt: string;
  seed: number | null;
  width?: number;
  height?: number;
  seconds?: number;
  jobId: string;
  createdAt: string;
  elapsedMs: number;
  /** Model files swapped for a local variant, said rather than hidden. */
  remaps: string[];
  /** Canvas hosts: every version is its own layer; the active one is visible. */
  layerId?: number;
  /** A reframe: every version is its own comp; choosing it opens that comp. */
  compId?: number;
  /** Where it ran (a resource id: local, cloud, deployment…). Absent on versions made before resources. */
  resource?: string;
  /** GPU execution time the server reported, summed over the version's jobs; null when it reported none. */
  executionMs?: number | null;
  /** Credits derived from that time at the resource's rate (≈); null where nothing bills. */
  derivedCredits?: number | null;
  /** The footage item the version's file became in the project (a generated fill, an upscale), so it can be relinked. */
  itemId?: number;
  /** A frame of the result (its comp, when it has one), relative to the media folder. */
  thumb?: string;
  /** The Comp tab: the input it was made from — the render of the comp (and its item), or the layer's file. */
  source?: { kind: 'workArea' | 'comp' | 'layer'; file: string | null; start?: number; end?: number; itemId?: number; name?: string };
  /** The Comp tab: the result comp's name (or the comp the result went into). */
  compName?: string;
  compare?: CompareState;
  /** Masters written from this version (ProRes 4444 with alpha). */
  exports?: Array<{ kind: string; path: string; at: string }>;
}

export interface Card {
  id: string;
  compId: number;
  origin: CardOrigin;
  prompt: string;
  workflowId: string;
  /** null = a new random seed on every run. */
  seed: number | null;
  /** Slot length override in seconds (markers: default is until the next marker). */
  seconds?: number;
  /** Values for the workflow's extra params, keyed by field ref. */
  params: Record<string, string | number | boolean>;
  /** Where the next run goes: a resource id, 'auto', or absent for the task's row in Settings ▸ Resources. */
  resource?: string;
  /** An image the user attached instead of the frame under the marker (relative to the media folder). */
  attachment?: string;
  versions: Version[];
  activeVersion: number | null;
  /** The item and layer a result was placed on (markers: created on first run). */
  placed?: { itemId: number; layerId: number };
  /** The version whose file `placed` shows (a reframe version opens its own comp and leaves `placed` as it was). */
  placedVersion?: number;
  /** A card the Comp tab made: its tool, source and choices. Such a card is never part of "Generate all". */
  tool?: CompTool;
  status: CardStatus;
  error?: string;
  progress?: { value: number; max: number; phase: string; startedAt: number; resource?: string; credits?: number | null };
  /** Frame under the card, relative to the media folder. */
  thumb?: string;
  /** The marker or layer is gone from the project; the card keeps its versions. */
  orphan?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Sidecar {
  schema: 1;
  /** 'shiftfield' in storyboards written before the rename. */
  app: 'justae-flow' | 'shiftfield';
  host: 'effectcraft' | 'photocraft';
  project: string | null;
  cards: Card[];
}

export function newCardId(): string {
  return 'c_' + crypto.randomUUID().replace(/-/g, '').slice(0, 10);
}

/** Where a card sits on the timeline, for ordering and display. */
export function cardTime(card: Card, layerIn?: number): number {
  if (card.origin.kind === 'marker') return card.origin.time;
  if (card.origin.kind === 'comp') return card.origin.start;
  return layerIn ?? 0;
}
