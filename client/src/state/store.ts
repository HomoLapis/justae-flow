/**
 * Global UI state via zustand. Persisted slices mirror to localStorage
 * (namespace `justaeflow2.*`) so settings, history, presets and the selected
 * workflow survive panel reloads.
 */

import { create } from 'zustand';
import { lsGet, lsSet } from './persistence';
import type { ProviderId } from '../providers/types';
import type { WorkflowPreset, WorkflowRecord, WorkflowSummary } from '../workflows/library';
import { deriveStoryboardSegments, type Segment } from './segments';
import type { AdjustmentLayerInfo } from '../bridge/extendscript';

export type JobPhase = 'idle' | 'submitting' | 'queued' | 'running' | 'done' | 'error' | 'cancelled';

/** The three things the panel does. */
export type Tab = 'workflow' | 'marker' | 'storyboard';

export interface AttachmentRef {
  /** Field id (`nodeId.field`) this attachment fills. */
  fieldId: string;
  kind: 'image' | 'video' | 'audio';
  /** Absolute local path of the file the user picked / AE captured. */
  localPath: string;
  filename: string;
}

export interface JobState {
  phase: JobPhase;
  id: string | null;
  workflowId: string;
  prompt: string;
  progress: { value: number; max: number };
  message: string;
  previewUrl: string | null;
  resultPath: string | null;
  resultIsVideo: boolean;
  error: string | null;
  startedAt: number | null;
  /** Live cost, when the backend reports one (a metered cloud). */
  costUsd: number | null;
  /**
   * When the server last said anything about this job.
   *
   * The difference between "slow" and "dead" is not visible in a progress bar,
   * and on this hardware it matters: a 260-frame MiniMax-H3 clip took 1 h 27 m
   * and spent the first hour on step zero, emitting nothing. The panel showed a
   * bar at 2% and no clue whether to wait or restart. The age of the last event
   * is the smallest honest answer — a server that is grinding still ticks.
   */
  lastEventAt: number | null;
  /** What that last event was, in plain words. */
  lastEventLabel: string | null;
  /** GPU headroom while it runs, when the backend reports it. */
  device: { name: string | null; freeBytes: number; totalBytes: number } | null;
  /**
   * Which wait this is, on backends that say (a metered cloud): in the queue, starting
   * a GPU (cold start), or running. Null when the backend doesn't tell.
   */
  stage: 'queued' | 'gpu-starting' | 'running' | null;
  /** Where this job runs (Settings ▸ Resources), and whether that bills. */
  resourceId: string | null;
  resourceLabel: string | null;
  /** Credits per hour of GPU time while it executes; null on your own GPU. */
  creditsPerHour: number | null;
  /** When the server says it started executing (v2), ms. */
  execStartedAt: number | null;
  /** Once done: the execution time the server reported, and the credits derived from it (≈). */
  executionMs: number | null;
  derivedCredits: number | null;
  /** Where executionMs came from: execution_ms, started→completed, history (local), or wall (the server reports none). */
  timing: string | null;
  /** What the error offers to do about itself ('run-locally' after a 402). */
  action: string | null;
}

/**
 * One clip that finished, and what it cost — the panel's only source of truth
 * about what this machine can actually chew.
 *
 * Measured on the user's own RTX 5080 (16 GB) with MiniMax-H3, same workflow,
 * same 1280 long side, only the slot length differing:
 *
 *   6.32 s slot → 158 frames →     2 m 53 s
 *   7.16 s slot → 175 frames →  ~25 m        (163 s per sampling step)
 *  10.44 s slot → 260 frames →  1 h 27 m 42 s (271 s per step, 246 MiB VRAM free)
 *
 * Eleven per cent more frames, eight times the time per step. That is not a
 * curve to extrapolate, it is a cliff where the working set stops fitting and
 * the weights start commuting over PCIe — and where it falls depends on the
 * card, the model and the resolution, so no constant in this file could know
 * it. What the panel CAN do is remember the longest slot that came back and
 * say so before the next one is queued. Only successes are recorded: the point
 * is "this much has worked here", not an average.
 */
export interface RunCost {
  /** The slot this clip had to fill, in seconds. */
  slotSeconds: number;
  /** Wall-clock seconds from submit to file on disk. */
  renderSeconds: number;
  at: number;
  /** What the backend billed, when it says (a metered cloud: est_cost_usd at the end). */
  costUsd?: number;
  /** GPU seconds billed (a metered cloud: gpu_elapsed_s). */
  gpuSeconds?: number;
  /** Which GPU ran it (the backend's own key), so estimates compare like with like. */
  gpu?: string;
}

/** What {@link AppState.applySetup} needs: the approved pairing, already made. */
export interface ApplySetupInput {
  mode: 'marker' | 'storyboard';
  /** Segment id → what the saved shot had on it. */
  shots: Array<{
    segmentId: string;
    prompt: string;
    attachments: AttachmentRef[];
    workflowId: string;
    selected: boolean;
  }>;
  /** Workflow id → values / prompt target / field prefs to restore. */
  workflows: Record<string, {
    values: Record<string, string | number | boolean>;
    promptTarget?: string;
    fieldPrefs?: { pinned: string[]; hidden: string[] };
  }>;
}

export interface HistoryEntry {
  id: string;
  prompt: string;
  workflowId: string;
  workflowLabel: string;
  providerId: ProviderId;
  resultPath: string | null;
  resultIsVideo: boolean;
  shotFolder?: string;
  createdAt: number;
  /** What the backend billed for it (a metered cloud), when known. */
  costUsd?: number;
  /** The resource it ran on (Settings ▸ Resources). */
  resourceId?: string;
  resourceLabel?: string;
  /** Credits derived from its execution time at the resource's rate (≈); absent on your own GPU. */
  credits?: number | null;
  /** Execution time the server reported, else wall-clock, seconds. */
  seconds?: number;
}

/**
 * Where workflows run is no longer a page setting: it is the server's
 * resource registry (Settings ▸ Resources), so a key is never in this page's
 * storage. These are the keys the page used to keep; read once at load and
 * handed to the server (lib/resources.ts migrateLegacySettings).
 */
const LEGACY_SETTING_KEYS = ['provider', 'localComfyUrl', 'comfyCloudApiKey', 'comfyV2Target', 'comfyV2Url', 'comfyV2Token', 'comfyV2ProxyToken'] as const;
let legacySettings: Record<string, unknown> | null = null;

/** The legacy backend settings found in local storage at load, once. */
export function takeLegacySettings(): Record<string, unknown> | null {
  const l = legacySettings;
  legacySettings = null;
  return l;
}

export interface Settings {
  outputDir: string;
  defaults: {
    seedMode: 'random' | 'fixed';
    fixedSeed: number;
    autoImport: boolean;
    workAreaMaxDuration: number;
    fitMode: 'none' | 'fit' | 'fill';
    /** Let AE fill canvas size / shot length into the workflow. */
    aeAutoFill: boolean;
  };
  /**
   * The professional pipeline: draft, approve, final.
   * See pipeline/catalog.ts and docs/RESEARCH.md.
   */
  pipeline: {
    /** Draft = smaller canvas (long side capped) and the catalog's draft presets. */
    tier: 'draft' | 'final';
    /** Long side, in px, that a draft is scaled down to (AE canvas kept in proportion). */
    draftLongSide: number;
    /** Delivery profile id (pipeline/catalog.ts OUTPUT_PROFILES). */
    outputProfile: string;
  };
}

const DEFAULT_SETTINGS: Settings = {
  outputDir: '',
  defaults: {
    seedMode: 'random',
    fixedSeed: 0,
    autoImport: true,
    workAreaMaxDuration: 8,
    fitMode: 'none' as 'none' | 'fit' | 'fill',
    aeAutoFill: true,
  },
  pipeline: { tier: 'final', draftLongSide: 1280, outputProfile: 'as-workflow' },
};

/**
 * Defensive hydration — older sessions stored `settings` without fields added
 * since, so merge with the defaults rather than trusting the stored shape.
 *
 */
function hydrateSettings(): Settings {
  const raw = lsGet<Partial<Settings> & {
    defaults?: Partial<Settings['defaults']>;
  }>('settings', DEFAULT_SETTINGS);

  // The old backend fields (and any key among them) stay out of the page's state: the server takes them.
  const rest: Record<string, unknown> = { ...raw };
  const legacy: Record<string, unknown> = {};
  for (const k of LEGACY_SETTING_KEYS) {
    if (k in rest) { legacy[k] = rest[k]; delete rest[k]; }
  }
  if (Object.keys(legacy).length) legacySettings = legacy;

  const merged: Settings = {
    ...DEFAULT_SETTINGS,
    ...(rest as Partial<Settings>),
    defaults: { ...DEFAULT_SETTINGS.defaults, ...(raw.defaults ?? {}) },
    pipeline: { ...DEFAULT_SETTINGS.pipeline, ...((raw as Partial<Settings>).pipeline ?? {}) },
  };
  return merged;
}

/**
 * Are these two shot lists the same as far as the panel is concerned?
 *
 * Compared field by field rather than by reference, because the reads that
 * produce them always allocate. Times are compared at millisecond resolution:
 * After Effects reports them as floats and the last digits jitter, which would
 * otherwise register as a change on every single poll.
 */
function sameSegments(a: Segment[], b: Segment[]): boolean {
  if (a.length !== b.length) return false;
  const ms = (n: number): number => Math.round(n * 1000);
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.id !== y.id || x.label !== y.label || x.labelColor !== y.labelColor) return false;
    if (ms(x.startTime) !== ms(y.startTime) || ms(x.endTime) !== ms(y.endTime)) return false;
  }
  return true;
}

/** Same workflows, same order, same timestamps? */
function sameLibrary(a: WorkflowSummary[], b: WorkflowSummary[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].name !== b[i].name || a[i].modified !== b[i].modified) return false;
  }
  return true;
}

const IDLE_JOB: JobState = {
  phase: 'idle',
  id: null,
  workflowId: '',
  prompt: '',
  progress: { value: 0, max: 1 },
  message: '',
  previewUrl: null,
  resultPath: null,
  resultIsVideo: false,
  error: null,
  startedAt: null,
  costUsd: null,
  lastEventAt: null,
  lastEventLabel: null,
  device: null,
  stage: null,
  resourceId: null,
  resourceLabel: null,
  creditsPerHour: null,
  execStartedAt: null,
  executionMs: null,
  derivedCredits: null,
  timing: null,
  action: null,
};

interface AppState {
  settings: Settings;
  setSettings: (patch: Partial<Settings>) => void;
  setSettingsDefaults: (patch: Partial<Settings['defaults']>) => void;

  job: JobState;
  setJob: (patch: Partial<JobState>) => void;
  resetJob: () => void;

  /* ─── Workflow library ─────────────────────────────────────────── */

  /** Everything the picker can offer — cheap, no parsing. */
  library: WorkflowSummary[];
  setLibrary: (l: WorkflowSummary[]) => void;
  libraryError: string | null;
  setLibraryError: (e: string | null) => void;
  libraryLoading: boolean;
  setLibraryLoading: (v: boolean) => void;

  /** The workflow selected as the default for new shots. */
  active: WorkflowRecord | null;
  setActive: (r: WorkflowRecord | null) => void;
  activeId: string;
  setActiveId: (id: string) => void;

  /**
   * Every workflow that has been read this session, keyed by id. A batch can
   * mix workflows across shots, so more than one has to be resident at once.
   */
  records: Record<string, WorkflowRecord>;
  setRecord: (r: WorkflowRecord) => void;
  /** Why a particular workflow could not be read, keyed by its id. */
  recordErrors: Record<string, string>;
  setRecordError: (id: string, message: string | null) => void;

  /**
   * Which workflow each shot uses. Absent = the default one. This is what
   * makes "a different model for this one clip" a dropdown on the row rather
   * than a mode switch.
   *
   * Session state, NOT persisted — and that is a fix, not an omission. It used
   * to be written to localStorage keyed by segment id, and a marker segment's
   * id is `seg-0`, `seg-1`… by position with no comp in the key. So `seg-0` of
   * every comp in every project was one entry: open a different comp and its
   * first shot already had somebody else's model selected, silently. Carrying
   * these across sessions is what setup files are for, and they record the slot
   * rather than its index.
   */
  shotWorkflows: Record<string, string>;
  setShotWorkflow: (segId: string, workflowId: string) => void;
  /** Put a shot back on the default workflow. */
  clearShotWorkflow: (segId: string) => void;

  /** The row currently opened for editing. */
  expandedShotId: string | null;
  setExpandedShotId: (id: string | null) => void;

  /**
   * Field values, keyed by workflow then field. Shared across shots that use
   * the same workflow — steps and sampler are a property of the workflow, not
   * of a clip; the prompt and the attachments are per shot.
   */
  values: Record<string, Record<string, string | number | boolean>>;
  setValue: (workflowId: string, fieldId: string, v: string | number | boolean) => void;
  setValues: (workflowId: string, v: Record<string, string | number | boolean>) => void;
  /** Fields where the user took over from the AE auto-fill. */
  unlockedFields: string[];
  toggleFieldLock: (fieldId: string) => void;
  resetFieldLocks: () => void;

  /**
   * Which fields the user wants up front, and which they never want to see,
   * per workflow.
   *
   * The panel ranks fields by reading the graph, and reading a graph is a
   * guess: on a 115-node workflow it settles on fifteen, and it cannot know
   * that this particular user only ever touches three of them, or that the one
   * they need most sits in "All controls". This is the escape hatch, and it is
   * per workflow rather than global because the answer is different for each
   * one. Persisted — curating a form is work, and doing it again every session
   * would be worse than not offering it.
   */
  fieldPrefs: Record<string, { pinned: string[]; hidden: string[] }>;
  toggleFieldPin: (workflowId: string, fieldId: string) => void;
  toggleFieldHidden: (workflowId: string, fieldId: string) => void;
  resetFieldPrefs: (workflowId: string) => void;

  /**
   * Which text field the prompt is written into, per workflow.
   *
   * Absent = whatever the inspector decided. Set only when the user corrects
   * it, and persisted, because correcting the same workflow every session
   * would be worse than not being able to correct it at all.
   */
  promptTargets: Record<string, string>;
  setPromptTarget: (workflowId: string, fieldId: string) => void;

  /** Saved per-workflow values, reused the next time it's picked. */
  presets: Record<string, WorkflowPreset>;
  savePreset: (workflowId: string, preset: WorkflowPreset) => void;
  clearPreset: (workflowId: string) => void;

  /**
   * Has the user sent the ComfyUI editor to their browser this session?
   *
   * Session-only, and deliberately not a claim about whether that window is
   * still open — the panel cannot see a browser it launched. What it is good
   * for is knowing whether anything might be changing the workflow folder
   * behind our back, which decides whether the folder watcher runs.
   */
  editorOpened: boolean;
  setEditorOpened: (v: boolean) => void;

  /* ─── Shots ────────────────────────────────────────────────────── */

  segments: Segment[];
  setSegments: (s: Segment[]) => void;
  selectedSegmentIds: string[];
  toggleSelectedSegment: (id: string) => void;
  selectAllSegments: () => void;
  clearSelectedSegments: () => void;
  activeSegmentId: string | null;
  setActiveSegmentId: (id: string | null) => void;

  storyboardSegments: Segment[];
  syncStoryboardLayers: (layers: AdjustmentLayerInfo[], adjustmentTotal: number) => void;
  selectedStoryboardIds: string[];
  toggleSelectedStoryboard: (id: string) => void;
  selectAllStoryboard: () => void;
  clearSelectedStoryboard: () => void;
  activeStoryboardId: string | null;
  setActiveStoryboardId: (id: string | null) => void;
  storyboardInfo: { count: number; adjustmentTotal: number; error?: string } | null;
  setStoryboardInfo: (info: { count: number; adjustmentTotal: number; error?: string } | null) => void;

  /** Per-shot prompt overrides, keyed by Segment.id. */
  segmentPrompts: Record<string, string>;
  setSegmentPrompt: (id: string, prompt: string) => void;

  /** Per-shot attachments, keyed by Segment.id then field id. */
  segmentAttachments: Record<string, AttachmentRef[]>;
  setSegmentAttachment: (segId: string, fieldId: string, att: Omit<AttachmentRef, 'fieldId'> | null) => void;

  /** A one-off shot at the playhead, when the comp has no markers. */
  playheadPrompt: string;
  setPlayheadPrompt: (s: string) => void;
  playheadAttachments: AttachmentRef[];
  setPlayheadAttachment: (fieldId: string, att: Omit<AttachmentRef, 'fieldId'> | null) => void;
  usePlayheadFallback: boolean;
  setUsePlayheadFallback: (v: boolean) => void;

  clearAllAttachments: () => void;

  history: HistoryEntry[];
  pushHistory: (entry: HistoryEntry) => void;
  clearHistory: () => void;

  /**
   * Clips that finished, keyed by `workflowId::resourceId` — see {@link RunCost}.
   * Keyed by both because the same graph on a rented GPU and on the laptop's
   * card are not the same question. (Keys written before resources used the
   * provider id: `local-comfy` is read as the local resource.)
   */
  runCosts: Record<string, RunCost[]>;
  recordRunCost: (workflowId: string, resourceId: string, cost: RunCost) => void;
  /** The resource each workflow last ran on, so a row's "longest that came back" asks the right machine. */
  lastResource: Record<string, string>;

  /**
   * Put a loaded setup into the panel, in one go.
   *
   * One action rather than a loop of setters, for two reasons. A shot list of
   * thirty would otherwise be a hundred separate store writes and as many
   * renders. And more importantly it is one decision: the user approved THIS
   * plan, so either all of it lands or none of it does — a half-applied setup
   * with some rows restored and some not is worse than no restore at all,
   * because it looks like it worked.
   *
   * Only the matched slots are touched. Slots the setup says nothing about keep
   * whatever the user has already typed into them.
   */
  applySetup: (input: ApplySetupInput) => void;

  tab: Tab;
  setTab: (t: Tab) => void;

  settingsOpen: boolean;
  setSettingsOpen: (v: boolean) => void;
  historyOpen: boolean;
  setHistoryOpen: (v: boolean) => void;
}

export const useApp = create<AppState>((set) => ({
  settings: hydrateSettings(),
  setSettings: (patch) => set((s) => {
    const next = { ...s.settings, ...patch };
    lsSet('settings', next);
    return { settings: next };
  }),
  setSettingsDefaults: (patch) => set((s) => {
    const next = { ...s.settings, defaults: { ...s.settings.defaults, ...patch } };
    lsSet('settings', next);
    return { settings: next };
  }),

  job: IDLE_JOB,
  setJob: (patch) => set((s) => ({ job: { ...s.job, ...patch } })),
  resetJob: () => set({ job: IDLE_JOB }),

  library: [],
  /**
   * Replacing the list with an equal one is a no-op.
   *
   * Every read allocates a new array, and React compares by identity. An
   * effect keyed on `library` therefore re-ran on every refresh, and one of
   * those effects calls refresh again when it fails — which spun the panel
   * into a loop that hammered the server and made the picker impossible to
   * use. Comparing the contents ends it at the source.
   */
  setLibrary: (library) => set((s) => (sameLibrary(s.library, library) ? {} : { library })),
  libraryError: null,
  setLibraryError: (libraryError) => set((s) => (s.libraryError === libraryError ? {} : { libraryError })),
  libraryLoading: false,
  setLibraryLoading: (libraryLoading) => set((s) => (s.libraryLoading === libraryLoading ? {} : { libraryLoading })),

  active: null,
  setActive: (active) => set({ active }),
  activeId: lsGet<string>('activeWorkflowId', ''),
  setActiveId: (activeId) => { lsSet('activeWorkflowId', activeId); set({ activeId }); },

  records: {},
  setRecord: (r) => set((s) => ({ records: { ...s.records, [r.id]: r } })),
  recordErrors: {},
  setRecordError: (id, message) => set((s) => {
    if ((s.recordErrors[id] ?? null) === message) return {};
    const next = { ...s.recordErrors };
    if (message) next[id] = message; else delete next[id];
    return { recordErrors: next };
  }),

  shotWorkflows: {},
  setShotWorkflow: (segId, workflowId) => set((s) => ({
    shotWorkflows: { ...s.shotWorkflows, [segId]: workflowId },
  })),
  clearShotWorkflow: (segId) => set((s) => {
    const next = { ...s.shotWorkflows };
    delete next[segId];
    return { shotWorkflows: next };
  }),

  expandedShotId: null,
  setExpandedShotId: (expandedShotId) => set({ expandedShotId }),

  values: {},
  setValue: (workflowId, fieldId, v) => set((s) => ({
    values: { ...s.values, [workflowId]: { ...(s.values[workflowId] ?? {}), [fieldId]: v } },
  })),
  setValues: (workflowId, v) => set((s) => ({ values: { ...s.values, [workflowId]: v } })),
  unlockedFields: [],
  toggleFieldLock: (fieldId) => set((s) => ({
    unlockedFields: s.unlockedFields.includes(fieldId)
      ? s.unlockedFields.filter((f) => f !== fieldId)
      : [...s.unlockedFields, fieldId],
  })),
  resetFieldLocks: () => set({ unlockedFields: [] }),

  fieldPrefs: lsGet<Record<string, { pinned: string[]; hidden: string[] }>>('fieldPrefs', {}),
  toggleFieldPin: (workflowId, fieldId) => set((s) => {
    const cur = s.fieldPrefs[workflowId] ?? { pinned: [], hidden: [] };
    const pinned = cur.pinned.includes(fieldId)
      ? cur.pinned.filter((x) => x !== fieldId)
      : [...cur.pinned, fieldId];
    // Pinning something that was hidden means the user changed their mind
    // about it, not that they want it in both lists at once.
    const hidden = cur.hidden.filter((x) => x !== fieldId);
    const next = { ...s.fieldPrefs, [workflowId]: { pinned, hidden } };
    lsSet('fieldPrefs', next);
    return { fieldPrefs: next };
  }),
  toggleFieldHidden: (workflowId, fieldId) => set((s) => {
    const cur = s.fieldPrefs[workflowId] ?? { pinned: [], hidden: [] };
    const hidden = cur.hidden.includes(fieldId)
      ? cur.hidden.filter((x) => x !== fieldId)
      : [...cur.hidden, fieldId];
    const pinned = cur.pinned.filter((x) => x !== fieldId);
    const next = { ...s.fieldPrefs, [workflowId]: { pinned, hidden } };
    lsSet('fieldPrefs', next);
    return { fieldPrefs: next };
  }),
  resetFieldPrefs: (workflowId) => set((s) => {
    const next = { ...s.fieldPrefs };
    delete next[workflowId];
    lsSet('fieldPrefs', next);
    return { fieldPrefs: next };
  }),

  promptTargets: lsGet<Record<string, string>>('promptTargets', {}),
  setPromptTarget: (workflowId, fieldId) => set((s) => {
    const next = { ...s.promptTargets, [workflowId]: fieldId };
    lsSet('promptTargets', next);
    return { promptTargets: next };
  }),

  presets: lsGet<Record<string, WorkflowPreset>>('presets', {}),
  savePreset: (workflowId, preset) => set((s) => {
    const next = { ...s.presets, [workflowId]: preset };
    lsSet('presets', next);
    return { presets: next };
  }),
  clearPreset: (workflowId) => set((s) => {
    const next = { ...s.presets };
    delete next[workflowId];
    lsSet('presets', next);
    return { presets: next };
  }),

  editorOpened: false,
  setEditorOpened: (editorOpened) => set({ editorOpened }),

  segments: [],
  setSegments: (segments) => set((s) => {
    // The timeline is re-read about once a second, and every read builds fresh
    // objects. Handing those to React unconditionally re-renders every row on
    // every tick — which is what made the text appear to twitch. If nothing
    // about the shots actually changed, change nothing.
    if (sameSegments(s.segments, segments)) return {};

    // Garbage-collect per-shot state for shots that no longer exist, keeping
    // BOTH marker and storyboard ids so one poll never wipes the other's work.
    const keep = new Set([...segments, ...s.storyboardSegments].map((seg) => seg.id));
    const prune = <T,>(map: Record<string, T>): Record<string, T> => {
      const next: Record<string, T> = {};
      for (const [k, v] of Object.entries(map)) if (keep.has(k)) next[k] = v;
      return next;
    };
    return {
      segments,
      selectedSegmentIds: s.selectedSegmentIds.filter((id) => keep.has(id)),
      activeSegmentId: s.activeSegmentId && keep.has(s.activeSegmentId)
        ? s.activeSegmentId
        : (segments[0]?.id ?? null),
      segmentPrompts: prune(s.segmentPrompts),
      segmentAttachments: prune(s.segmentAttachments),
    };
  }),

  selectedSegmentIds: [],
  toggleSelectedSegment: (id) => set((s) => ({
    selectedSegmentIds: s.selectedSegmentIds.includes(id)
      ? s.selectedSegmentIds.filter((x) => x !== id)
      : [...s.selectedSegmentIds, id],
  })),
  selectAllSegments: () => set((s) => ({ selectedSegmentIds: s.segments.map((seg) => seg.id) })),
  clearSelectedSegments: () => set({ selectedSegmentIds: [] }),
  activeSegmentId: null,
  setActiveSegmentId: (activeSegmentId) => set({ activeSegmentId }),

  storyboardSegments: [],
  syncStoryboardLayers: (layers, adjustmentTotal) => set((s) => {
    const segs = deriveStoryboardSegments(layers);
    if (sameSegments(s.storyboardSegments, segs)
        && s.storyboardInfo?.adjustmentTotal === adjustmentTotal) {
      return {};   // same placeholders as last tick — don't disturb the UI
    }
    const newIds = segs.map((sg) => sg.id);
    const newIdSet = new Set(newIds);
    const prevIds = new Set(s.storyboardSegments.map((sg) => sg.id));
    // Preserve the user's ticks; auto-include shots that just appeared.
    const kept = s.selectedStoryboardIds.filter((id) => newIdSet.has(id));
    const appeared = newIds.filter((id) => !prevIds.has(id));
    return {
      storyboardSegments: segs,
      selectedStoryboardIds: [...kept, ...appeared],
      activeStoryboardId: s.activeStoryboardId && newIdSet.has(s.activeStoryboardId)
        ? s.activeStoryboardId
        : (newIds[0] ?? null),
      storyboardInfo: { count: segs.length, adjustmentTotal },
    };
  }),
  selectedStoryboardIds: [],
  toggleSelectedStoryboard: (id) => set((s) => ({
    selectedStoryboardIds: s.selectedStoryboardIds.includes(id)
      ? s.selectedStoryboardIds.filter((x) => x !== id)
      : [...s.selectedStoryboardIds, id],
  })),
  selectAllStoryboard: () => set((s) => ({ selectedStoryboardIds: s.storyboardSegments.map((x) => x.id) })),
  clearSelectedStoryboard: () => set({ selectedStoryboardIds: [] }),
  activeStoryboardId: null,
  setActiveStoryboardId: (activeStoryboardId) => set({ activeStoryboardId }),
  storyboardInfo: null,
  setStoryboardInfo: (storyboardInfo) => set({ storyboardInfo }),

  segmentPrompts: {},
  setSegmentPrompt: (id, prompt) => set((s) => ({
    segmentPrompts: { ...s.segmentPrompts, [id]: prompt },
  })),

  segmentAttachments: {},
  setSegmentAttachment: (segId, fieldId, att) => set((s) => {
    const current = s.segmentAttachments[segId] ?? [];
    const filtered = current.filter((a) => a.fieldId !== fieldId);
    const next = att ? [...filtered, { fieldId, ...att }] : filtered;
    return { segmentAttachments: { ...s.segmentAttachments, [segId]: next } };
  }),

  playheadPrompt: '',
  setPlayheadPrompt: (playheadPrompt) => set({ playheadPrompt }),
  playheadAttachments: [],
  setPlayheadAttachment: (fieldId, att) => set((s) => {
    const filtered = s.playheadAttachments.filter((a) => a.fieldId !== fieldId);
    return { playheadAttachments: att ? [...filtered, { fieldId, ...att }] : filtered };
  }),
  usePlayheadFallback: false,
  setUsePlayheadFallback: (usePlayheadFallback) => set({ usePlayheadFallback }),

  clearAllAttachments: () => set({ segmentAttachments: {}, playheadAttachments: [] }),

  history: lsGet<HistoryEntry[]>('history', []),
  pushHistory: (entry) => set((s) => {
    const next = [entry, ...s.history].slice(0, 50);
    lsSet('history', next);
    return { history: next };
  }),
  clearHistory: () => { lsSet('history', []); set({ history: [] }); },

  runCosts: lsGet<Record<string, RunCost[]>>('runCosts', {}),
  recordRunCost: (workflowId, resourceId, cost) => set((s) => {
    const key = runCostKey(workflowId, resourceId);
    // Twelve is plenty to know the ceiling and small enough that localStorage
    // never becomes a thing anyone has to think about.
    const next = { ...s.runCosts, [key]: [cost, ...(s.runCosts[key] ?? [])].slice(0, 12) };
    lsSet('runCosts', next);
    const lastResource = { ...s.lastResource, [workflowId]: resourceId };
    lsSet('lastResource', lastResource);
    return { runCosts: next, lastResource };
  }),
  lastResource: lsGet<Record<string, string>>('lastResource', {}),

  applySetup: (input) => set((s) => {
    const prompts = { ...s.segmentPrompts };
    const attachments = { ...s.segmentAttachments };
    const shotWorkflows = { ...s.shotWorkflows };
    const touched = new Set<string>();
    const ticked: string[] = [];

    for (const shot of input.shots) {
      touched.add(shot.segmentId);
      prompts[shot.segmentId] = shot.prompt;
      attachments[shot.segmentId] = shot.attachments;
      if (shot.workflowId) shotWorkflows[shot.segmentId] = shot.workflowId;
      else delete shotWorkflows[shot.segmentId];
      if (shot.selected) ticked.push(shot.segmentId);
    }

    /*
     * Ticks: the setup decides for the slots it matched, and only those.
     *
     * A slot the file never mentions keeps whatever tick it has. Replacing the
     * whole selection would silently un-tick shots the user had just prepared
     * by hand alongside the ones being restored.
     */
    const previous = input.mode === 'storyboard' ? s.selectedStoryboardIds : s.selectedSegmentIds;
    const selected = [...previous.filter((id) => !touched.has(id)), ...ticked];

    const values = { ...s.values };
    const promptTargets = { ...s.promptTargets };
    const fieldPrefs = { ...s.fieldPrefs };
    for (const [workflowId, w] of Object.entries(input.workflows)) {
      values[workflowId] = { ...w.values };
      if (w.promptTarget) promptTargets[workflowId] = w.promptTarget;
      if (w.fieldPrefs) fieldPrefs[workflowId] = w.fieldPrefs;
    }
    lsSet('promptTargets', promptTargets);
    lsSet('fieldPrefs', fieldPrefs);

    return {
      segmentPrompts: prompts,
      segmentAttachments: attachments,
      shotWorkflows,
      values,
      promptTargets,
      fieldPrefs,
      ...(input.mode === 'storyboard'
        ? { selectedStoryboardIds: selected }
        : { selectedSegmentIds: selected }),
    };
  }),

  tab: 'marker',
  setTab: (tab) => set({ tab }),

  settingsOpen: false,
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  historyOpen: false,
  setHistoryOpen: (historyOpen) => set({ historyOpen }),
}));

export function runCostKey(workflowId: string, resourceId: string): string {
  return `${workflowId}::${resourceId}`;
}

/* ─── Selectors ──────────────────────────────────────────────────── */

/**
 * The longest slot this workflow has ever filled on this backend, and what it
 * cost. Null until one has.
 *
 * Deliberately the MAXIMUM rather than an average or a fit: the question the
 * shot list asks is "has anything this long ever come back here", and an
 * average would answer a different one.
 */
export function selectProvenCeiling(
  s: AppState, workflowId: string,
): RunCost | null {
  const resource = s.lastResource[workflowId] ?? 'local';
  const legacy: ProviderId = 'local-comfy';
  const runs = s.runCosts[runCostKey(workflowId, resource)]
    ?? (resource === 'local' ? s.runCosts[runCostKey(workflowId, legacy)] : undefined) ?? [];
  let best: RunCost | null = null;
  for (const r of runs) if (!best || r.slotSeconds > best.slotSeconds) best = r;
  return best;
}

/**
 * Stable empty fallbacks. Selectors must NEVER allocate inline — React's
 * useSyncExternalStore requires a referentially stable snapshot when nothing
 * changed, and `?? []` returns a fresh array every call (React error #185).
 */
const EMPTY_ATTACHMENTS: readonly AttachmentRef[] = Object.freeze([]);

export interface ActiveShotState {
  prompt: string;
  attachments: AttachmentRef[];
  scope: 'segment' | 'playhead';
  scopeId: string | null;
  /** The shot being edited, when there is one. */
  segment: Segment | null;
}

/** Prompt/attachments for whichever shot the panel is currently editing. */
export function selectActiveShot(s: AppState): ActiveShotState {
  if (s.tab === 'storyboard') {
    const id = s.activeStoryboardId ?? (s.storyboardSegments[0]?.id ?? null);
    const segment = id ? s.storyboardSegments.find((x) => x.id === id) ?? null : null;
    return {
      prompt: id ? s.segmentPrompts[id] ?? '' : '',
      attachments: id
        ? s.segmentAttachments[id] ?? (EMPTY_ATTACHMENTS as AttachmentRef[])
        : (EMPTY_ATTACHMENTS as AttachmentRef[]),
      scope: 'segment',
      scopeId: id,
      segment,
    };
  }

  if (s.segments.length === 0 || s.usePlayheadFallback) {
    return {
      prompt: s.playheadPrompt,
      attachments: s.playheadAttachments,
      scope: 'playhead',
      scopeId: null,
      segment: null,
    };
  }
  const id = s.activeSegmentId ?? s.segments[0].id;
  const segment = s.segments.find((x) => x.id === id) ?? null;
  return {
    prompt: s.segmentPrompts[id] ?? '',
    attachments: s.segmentAttachments[id] ?? (EMPTY_ATTACHMENTS as AttachmentRef[]),
    scope: 'segment',
    scopeId: id,
    segment,
  };
}

/** The shots the next Generate will run, in timeline order. */
export function selectQueuedShots(s: AppState): Segment[] {
  if (s.tab === 'storyboard') {
    return s.storyboardSegments
      .filter((seg) => s.selectedStoryboardIds.includes(seg.id))
      .sort((a, b) => a.startTime - b.startTime);
  }
  return s.segments
    .filter((seg) => s.selectedSegmentIds.includes(seg.id))
    .sort((a, b) => a.startTime - b.startTime);
}
