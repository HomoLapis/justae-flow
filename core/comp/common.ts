/**
 * What every Comp tab tool shares: the source it is given, its options, the
 * plan it answers with, and the small words and checks the cards use. Kept apart
 * from the tool list (tools.ts) so the LTX finishing tools (finishing-tools.ts)
 * can be defined beside it without a circular import.
 */

import type { WorkflowManifest } from '../workflows/manifest.ts';
import type { TilingRequest, TilingSizes } from '../finishing/sizes.ts';

/** What a tool's plan may get beyond the source and options. */
export interface ToolExtra {
  prompt?: string;
  tiling?: (r: TilingRequest) => TilingSizes | null;
}

export type SourceKind = 'workArea' | 'comp' | 'layer';

/** The input a run would get, as the host describes it now. */
export interface SourceInfo {
  kind: SourceKind;
  /** What it is: a video (a clip, or a render of the comp), a still, or nothing with a file (a solid, text). */
  media: 'video' | 'image' | 'none';
  width: number;
  height: number;
  fps: number;
  /** Seconds a run covers: a render of the comp stops at the cap. */
  seconds: number;
  /** Seconds asked for, before the cap. */
  requested: number;
  /** The comp's or the layer's name. */
  name: string;
  /** Where it sits in the comp, seconds: the work area, the whole comp, or the layer's in and out points. */
  span?: [number, number];
  /** The comp's own length and frame rate (a layer source has its own fps above). */
  compSeconds?: number;
  compFps?: number;
}

export type ToolOptions = Record<string, string | number | boolean>;

export interface ToolPlan {
  ok: boolean;
  /** Why it cannot run on this source, in words. */
  reason?: string;
  /** The bundled workflow the run uses (routing: its task's row in Settings ▸ Resources). */
  workflowId: string;
  /** The jobs the run submits, as the run history names them, for the estimate (seconds: what each covers). */
  jobs: Array<{ workflowId: string; seconds: number | null }>;
  /** What the run makes, said before it runs. */
  makes: string;
  output?: { width: number; height: number; seconds: number; fps?: number };
  notes: string[];
  warnings: string[];
  /** The primary button. */
  action: string;
  /**
   * The text the workflow needs, if any. `optional`: an empty field runs with `fallback` (the LTX "Look": the card's
   * own generic look). `lint`: the server checks it on every plan request (the LTX "Look": no subjects named).
   */
  prompt?: { label: string; placeholder: string; optional?: boolean; fallback?: string; lint?: string };
  /** Free-text choices beside the prompt (Colorize's colours, Clean plate's "also remove"), kept in the options. */
  fields?: Array<{ key: string; label: string; placeholder: string; advanced?: boolean }>;
  /** LTX finishing: the time it should take on this machine, from the tile count and measured runs (with "≈" and its basis). */
  estimate?: { seconds: number; line: string };
  /** Card params (the "@" ones are the app's own settings, not node fields). */
  params: ToolOptions;
  /** One card per tool, variant and source: re-runs of the same thing are its versions. */
  variant: string;
  /** Choices the card offers that come from the workflow itself (a node's own options, from object_info). */
  choices?: Record<string, string[]>;
  /** A pack (the Social pack): the runs it queues, in order, each with its own plan. */
  members?: Array<{ tool: string; options: ToolOptions; plan: ToolPlan }>;
  /** Extend: the motion it carries on from — the source's last frames that guide the model (none: one frame). */
  motion?: { frames: number; seconds: number };
}

export interface ToolDef {
  id: string;
  name: string;
  /** One line under the name. */
  promise: string;
  icon: string;
  sources: SourceKind[];
  /** The defaults of its choices. */
  defaults: ToolOptions;
  /** false: the source is not rendered (Extend only takes its last frame), so the render cap does not apply. */
  renders?: boolean;
  /** The family the Comp tab lists it under ('ltx': LTX finishing, after the other tools). */
  family?: 'ltx';
  /** LTX finishing: the IC-LoRAs a run of it needs (core/finishing/models.ts LoraId); greyed with where to get them when absent. */
  loras?: string[];
  /** A licence line the card carries (every LTX finishing card: the LTX-2.x Community License). */
  licence?: { line: string; url: string };
  /** A card that is listed but cannot run, with why (to be verified: its model card does not say how, or a file is not where the node reads). */
  unavailable?: string;
  /**
   * `extra.prompt`: the card's text as typed now (the LTX "Look" is checked on every plan). `extra.tiling`: the LTX
   * pack's sizes the server has (LTXVGetTilingSizes, asked on the local ComfyUI) — without it a tiled LTX card says its
   * sizes come at run time.
   */
  plan(src: SourceInfo, options: ToolOptions, manifest: (id: string) => WorkflowManifest | undefined, extra?: ToolExtra): ToolPlan;
}


export const fmt = (s: number): string => `${(Math.round(s * 10) / 10).toFixed(1)} s`;
export const what = (src: SourceInfo): string => (src.kind === 'layer' ? 'clip' : src.kind === 'workArea' ? 'work area' : 'comp');

export function needsVideo(src: SourceInfo): string | undefined {
  if (src.media === 'video') return undefined;
  if (src.media === 'image') return 'This tool works on video: the selected layer is a still. Pick a clip, the work area or the whole comp.';
  return 'The selected layer has no footage file (a solid, text or a shape): pick a clip, the work area or the whole comp.';
}

export function opt<T extends string | number | boolean>(o: ToolOptions, k: string, allowed: readonly T[], fallback: T): T {
  const v = o[k] as T;
  return allowed.includes(v) ? v : fallback;
}
