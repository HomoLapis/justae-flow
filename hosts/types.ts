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
