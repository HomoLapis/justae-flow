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
  | { kind: 'selection'; channel: string; box: Box };

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
  /** An image the user attached instead of the frame under the marker (relative to the media folder). */
  attachment?: string;
  versions: Version[];
  activeVersion: number | null;
  /** The item and layer a result was placed on (markers: created on first run). */
  placed?: { itemId: number; layerId: number };
  status: CardStatus;
  error?: string;
  progress?: { value: number; max: number; phase: string; startedAt: number };
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
  return layerIn ?? 0;
}
