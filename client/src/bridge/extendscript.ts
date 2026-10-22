/**
 * Typed callers for host/index.jsx functions.
 * Each helper builds the ExtendScript expression and unwraps the JSON envelope.
 */

import { evalJson, esEscape } from './csInterface';

export interface CompInfo {
  name: string;
  width: number;
  height: number;
  duration: number;
  frameRate: number;
  time: number;
  numLayers: number;
  workAreaStart: number;
  workAreaDuration: number;
}

export interface ReadyInfo {
  ready: boolean;
  hasProject: boolean;
  hasActiveComp: boolean;
  activeCompName: string;
  error?: string;
}

export type FitMode = 'none' | 'fit' | 'fill';

export interface ImportResult {
  success: true;
  layerName: string;
  layerIndex: number;
  startTime: number;
  duration: number;
  compName: string;
  sourceWidth?: number;
  sourceHeight?: number;
  compWidth?: number;
  compHeight?: number;
  fitApplied?: { mode: FitMode; scalePercent: number } | null;
}

export interface FrameCapture {
  success: true;
  path: string;
  bytes: number;
  width: number;
  height: number;
  time: number;
  compName: string;
  format: string;
  method: string;
}

export interface MarkerInfo {
  index: number;
  time: number;
  comment: string;
  duration: number;
}

export interface MarkersResult {
  success: true;
  compName: string;
  compDuration: number;
  frameRate: number;
  markers: MarkerInfo[];
}

export interface WorkAreaRender {
  success: true;
  path: string;
  duration: number;
  workAreaStart: number;
  compName: string;
  template: string;
}

export interface AdjustmentLayerInfo {
  index: number;
  name: string;
  inPoint: number;
  outPoint: number;
  duration: number;
  label: number;   // AE label color index (0 = none, 1-16)
  enabled: boolean;
}

export interface AdjustmentLayersResult {
  success: true;
  compName: string;
  frameRate: number;
  /** Total adjustment layers in the comp, visible or hidden. */
  adjustmentCount: number;
  /** Adjustment layers with the eye toggle ON — these become shots (in `layers`). */
  visibleCount: number;
  layers: AdjustmentLayerInfo[];
}

type Maybe<T> = T | { error: string };

export const ae = {
  checkReady: () => evalJson<ReadyInfo>('checkAEReady()'),

  activeComp: () => evalJson<CompInfo | null>('getActiveCompInfo()'),

  projectDir: () => evalJson<{ path: string | null; error?: string }>('getProjectDir()'),

  projectInfo: () => evalJson<{
    isSaved: boolean;
    name: string | null;
    dir: string | null;
    fullPath?: string;
    error?: string;
  }>('getProjectInfo()'),

  tempDir: () => evalJson<{ path: string; error?: string }>('getTempDir()'),

  /** seqFps > 0: a numbered still is imported as a sequence at that rate. */
  importVideo: (filePath: string, layerName = '', fitMode: FitMode = 'none', seqFps = 0): Promise<Maybe<ImportResult>> =>
    evalJson(`importAndAddToTimeline("${esEscape(filePath)}", "${esEscape(layerName)}", "${fitMode}", ${seqFps})`),

  insertVideoAtTime: (
    filePath: string,
    atTime: number,
    layerName = '',
    fitMode: FitMode = 'none',
    labelColor = 0,
    seqFps = 0,
  ): Promise<Maybe<ImportResult>> =>
    evalJson(`insertVideoAtTime("${esEscape(filePath)}", ${atTime}, "${esEscape(layerName)}", "${fitMode}", ${labelColor}, ${seqFps})`),

  trimLayerDuration: (layerIndex: number, durationSec: number): Promise<Maybe<{ success: true; layerName: string; inPoint: number; outPoint: number }>> =>
    evalJson(`trimLayerDuration(${layerIndex}, ${durationSec})`),

  markers: (): Promise<Maybe<MarkersResult>> => evalJson('getCompMarkers()'),

  visibleAdjustmentLayers: (): Promise<Maybe<AdjustmentLayersResult>> =>
    evalJson('getVisibleAdjustmentLayers()'),

  disableAdjustmentLayer: (name: string, inPointSec: number): Promise<Maybe<{ success: boolean; layerName?: string; error?: string }>> =>
    evalJson(`disableAdjustmentLayer("${esEscape(name)}", ${inPointSec})`),

  importImage: (filePath: string, layerName = '', durationSec = 5, fitMode: FitMode = 'none'): Promise<Maybe<ImportResult>> =>
    evalJson(`importImageAndAddToTimeline("${esEscape(filePath)}", "${esEscape(layerName)}", ${durationSec}, "${fitMode}")`),

  captureFrame: (targetPath: string): Promise<Maybe<FrameCapture>> =>
    evalJson(`captureCurrentFrameToFile("${esEscape(targetPath)}")`),

  renderWorkArea: (maxDurationSec = 15): Promise<Maybe<WorkAreaRender>> =>
    evalJson(`renderWorkAreaToFile(${maxDurationSec})`),

  /**
   * Native Save / Open dialogs for shot setups.
   *
   * `path: null` means the user pressed Cancel. That is a normal outcome, not
   * an error, and the caller has to treat it as one — otherwise every dismissed
   * dialog turns into a red message about nothing.
   */
  pickSetupSavePath: (
    defaultName: string, defaultDir: string | null,
  ): Promise<Maybe<{ path: string | null }>> => evalJson(
    `pickSetupSavePath("${esEscape(defaultName)}", ${defaultDir ? `"${esEscape(defaultDir)}"` : 'null'})`,
  ),

  pickSetupOpenPath: (defaultDir: string | null): Promise<Maybe<{ path: string | null }>> =>
    evalJson(`pickSetupOpenPath(${defaultDir ? `"${esEscape(defaultDir)}"` : 'null'})`),
};

export function isErr<T>(r: Maybe<T>): r is { error: string } {
  return typeof r === 'object' && r !== null && 'error' in r;
}
