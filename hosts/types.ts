/**
 * What the storyboard needs from a host application, and nothing more.
 * Every method maps onto commands the host documents and exposes over its own
 * control channel; the adapters say which.
 *
 * Two shapes of host: a timeline (EffectCraft — markers, comps, footage) and a
 * canvas (PhotoCraft — a document, its layers and its selection).
 */

import type { CardStatus } from '../core/storyboard/types.ts';

export type HostId = 'effectcraft' | 'photocraft';
export type Box = [x: number, y: number, w: number, h: number];

export interface HostMarker {
  index: number;
  time: number;
  duration: number;
  comment: string;
  label: string;
  /** The card id stored in the marker's cue point, when this app tagged it. */
  cardId: string | null;
}

export interface HostLayer {
  id: number;
  /** 1-based, top first. */
  index: number;
  name: string;
  in: number;
  out: number;
  start: number;
  label: string;
  type: string;
  /** Canvas hosts: where the layer's pixels are. */
  bounds?: Box | null;
  visible?: boolean;
}

/** The composition (timeline host) or the document (canvas host). */
export interface HostComp {
  id: number;
  name: string;
  width: number;
  height: number;
  fps: number;
  duration: number;
  /** Timeline hosts: the work area, comp seconds [start, end] (the whole comp when none was set). */
  workArea?: [number, number];
}

export interface HostSnapshot {
  app: HostId;
  version: string;
  project: { path: string | null; dirty: boolean };
  comp: HostComp | null;
  markers: HostMarker[];
  layers: HostLayer[];
  selectedLayers: number[];
  time: number;
  /** Canvas hosts: the active selection's bounds, and the saved selections (alpha channels) by name. */
  selection?: Box | null;
  channels?: string[];
}

export interface ItemInfo {
  id: number;
  name: string;
  path: string | null;
  kind: string;
  width: number;
  height: number;
  duration: number;
  frameRate: number;
  comment: string;
}

export interface PlaceRequest {
  file: string;
  /** Comp time of the in-point, seconds. */
  time: number;
  /** Trim the layer so it ends here (comp seconds). */
  endTime?: number;
  name: string;
  comment: string;
  position?: [number, number];
  /** 1-based stack position (1 = top); the new layer goes there, the rest move down. */
  index?: number;
  /**
   * Comp time of the media's first frame, when the result is frame-for-frame
   * the source clip (an upscale, a matte): the layer then starts there and is
   * trimmed to `time`…`endTime`, so every frame lands on its source frame.
   */
  sourceStart?: number;
}

export interface ReframeRequest {
  name: string;
  width: number;
  height: number;
  fps: number;
  duration: number;
  /** The footage item to frame; it goes in at 100%, from time 0. */
  itemId: number;
  layerName: string;
  comment: string;
  keys: Array<{ t: number; x: number; y: number }>;
}

export interface OutpaintRequest {
  name: string;
  width: number;
  height: number;
  fps: number;
  duration: number;
  /** The generated video: it fills the comp. */
  file: string;
  fillScale: number;
  fillName: string;
  /** The original clip on top, untouched: its scale (%), centre (comp px) and soft-edged mask (layer px). */
  itemId: number;
  clipName: string;
  clipScale: number;
  clipCentre: [number, number];
  mask: [number, number, number, number];
  feather: number;
  comment: string;
}

/** A span of the active comp rendered to a video file. */
export interface RenderRequest {
  /** Comp seconds. */
  start: number;
  duration: number;
  /** Seconds the render may last at most (the Flow window's "Work-area render cap"). */
  cap: number;
  /** Folder to write into, and the file's name without extension. */
  dir: string;
  name: string;
  /** h264: a small movie; prores: ProRes (the Comp tab — the render is the untouched middle of its result). Default h264. */
  format?: 'h264' | 'prores';
}

export interface RenderResult {
  path: string;
  start: number;
  /** Seconds rendered: the span, or the cap when the span is longer. */
  duration: number;
  /** The span was longer than the cap. */
  capped: boolean;
}

/** A new comp holding items as layers, from 0 s, listed top first. */
export interface CompRequest {
  name: string;
  width: number;
  height: number;
  fps: number;
  duration: number;
  layers: Array<{
    itemId: number;
    name: string;
    comment?: string;
    /** Uniform scale, %. */
    scale?: number;
    /** Comp px; default the centre. */
    position?: [number, number];
    /** false: added with its video switched off. */
    visible?: boolean;
  }>;
}

interface HostBase {
  readonly id: HostId;
  readonly label: string;
  /** Throws a readable error when the host is unreachable. */
  snapshot(): Promise<HostSnapshot>;
  setStatus(target: { markerIndex?: number; layerId?: number }, status: CardStatus): Promise<void>;
  /** Show or hide a layer — how a source is set aside without deleting it. */
  setLayerVisible(layerId: number, visible: boolean): Promise<void>;
  setLayerLabel(layerId: number, label: string): Promise<void>;
  renameLayer(layerId: number, name: string): Promise<void>;
  close(): void;
}

export interface TimelineHost extends HostBase {
  readonly kind: 'timeline';
  /** Writes the composited frame at `time` to a PNG at `outPath`. */
  frameAt(time: number, outPath: string): Promise<string>;
  tagMarker(index: number, cardId: string): Promise<void>;
  setMarkerComment(index: number, comment: string): Promise<void>;
  place(req: PlaceRequest): Promise<{ itemId: number; layerId: number }>;
  /** Swap the file under an item; the listed layers keep their on-screen box. */
  replaceFootage(itemId: number, file: string, layerIds?: number[]): Promise<void>;
  /** Lay a result exactly over its source layer (position, rotation, scale for the new size). */
  matchLayer(targetLayer: number, targetItem: number, sourceLayer: number, sourceItem: number): Promise<void>;
  /** Scale a placed layer so its media covers the comp frame. */
  coverComp(layerId: number, itemId: number, compW: number, compH: number): Promise<void>;
  createPlaceholder(req: { name: string; width: number; height: number; fps: number; duration: number; time: number }): Promise<{ itemId: number; layerId: number }>;
  sourceOfLayer(layerId: number): Promise<number | null>;
  itemInfo(itemId: number): Promise<ItemInfo | null>;
  addMarker(time: number, comment: string): Promise<void>;
  setLayerComment(layerId: number, comment: string): Promise<void>;
  /** Point a footage item at its file's new location. */
  relink(itemId: number, path: string): Promise<void>;
  /** `layerId` shows only where `matteLayerId` is bright (luma) or opaque (alpha); null takes the track matte off. */
  setTrackMatte(layerId: number, matteLayerId: number | null, kind: 'luma' | 'alpha'): Promise<void>;
  /** A new comp holding the footage with keyed Position; it is left open. */
  buildReframe(req: ReframeRequest): Promise<{ compId: number; layerId: number }>;
  /** A new comp: the generated frame below, the original clip above it; it is left open. */
  buildOutpaint(req: OutpaintRequest): Promise<{ compId: number; fillLayer: number; fillItem: number; clipLayer: number }>;
  openComp(compId: number): Promise<void>;
  /** Lengthen (or shorten) the active comp, seconds — Extend makes room after the last frame. */
  setCompDuration(seconds: number): Promise<void>;
  /** Render a span of the active comp to an H.264 file with the host's own render queue. */
  renderRange(req: RenderRequest): Promise<RenderResult>;
  /** Import a file into the project; its footage item id. */
  importFile(path: string): Promise<number>;
  /** A new comp with these items as layers; it is left open. Layer ids in the order given. */
  buildComp(req: CompRequest): Promise<{ compId: number; layers: number[] }>;
}

export interface CanvasPlaceRequest {
  /** Image file, relative to the automation root. */
  rel: string;
  /** Where the image goes on the canvas. */
  box: Box;
  /** cover: fill the box, keep proportions (the overflow is masked); stretch: exactly the box. */
  fit: 'cover' | 'stretch';
  /** Mask the result: to a saved selection (alpha channel name) or to a rectangle. */
  maskChannel?: string;
  maskBox?: Box;
  /** Soften the mask edge by this many pixels, so the change blends into what is around it. */
  feather?: number;
  /** The new layer goes just above this one (default: above the active layer). */
  above?: number;
  name: string;
}

export interface CanvasHost extends HostBase {
  readonly kind: 'canvas';
  /** The folder the host may read and write; every path handed to it is relative to it. */
  readonly root: string;
  /** The visible document, flattened, to `rel` under the root (PNG). */
  exportComposite(rel: string): Promise<void>;
  /** One layer alone (the others hidden for the export, then restored), to `rel` under the root. */
  exportLayer(layerId: number, rel: string): Promise<void>;
  placeImage(req: CanvasPlaceRequest): Promise<number>;
  /** Opens an image as a new document beside the current one, which stays active. */
  openDocument(rel: string): Promise<void>;
  /** Saves the active selection as an alpha channel; returns its bounds. */
  saveSelection(name: string): Promise<Box | null>;
  /** A new layer filled with a neutral colour over `box`. */
  createPlaceholderBox(name: string, box: Box): Promise<number>;
}

export type HostAdapter = TimelineHost | CanvasHost;

export class HostError extends Error {
  readonly unreachable: boolean;
  constructor(message: string, unreachable = false) {
    super(message);
    this.name = 'HostError';
    this.unreachable = unreachable;
  }
}
