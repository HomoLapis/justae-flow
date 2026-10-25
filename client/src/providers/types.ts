/**
 * Provider contract — any ComfyUI backend the plugin can target.
 *
 * Two implementations ship, one per protocol, built from the resources the
 * server keeps (Settings ▸ Resources; providers/registry.ts):
 *   local-comfy   a ComfyUI on this machine / LAN (the classic protocol)
 *   comfy-v2      Comfy API v2 — Comfy Cloud, a deployment, or comfy-api-proxy —
 *                 run by the server through the official SDK (ServerV2Provider)
 *
 * 'comfy-cloud' (the deprecated v1 Cloud API, run from this page) is gone; it
 * stays in the union so history entries written by it still read.
 */

export type ProviderId = 'comfy-cloud' | 'local-comfy' | 'comfy-v2';

/** ComfyUI API-format workflow: flat object keyed by node id. */
export type WorkflowJson = Record<string, ComfyNode>;

export interface ComfyNode {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title?: string };
}

/** One entry of GET /object_info — the node's input schema. */
export interface NodeInfo {
  input?: {
    required?: Record<string, unknown[]>;
    optional?: Record<string, unknown[]>;
  };
  output?: string[];
  output_name?: string[];
  display_name?: string;
  category?: string;
  /**
   * The server's own marker for an endpoint — SaveImage, VHS_VideoCombine and
   * so on. Used to work out which half of a workflow is actually live; see
   * `workflows/graph.ts`.
   */
  output_node?: boolean;
}

export type ObjectInfo = Record<string, NodeInfo>;

export interface UploadResult {
  /** Filename to reference in LoadImage / LoadVideo nodes within the workflow. */
  name: string;
  /**
   * What to put in the node input INSTEAD of the filename, when the backend
   * does not address inputs by name.
   *
   * Comfy API v2 has no `input/` directory to drop a file into: an upload
   * mints an asset with a UUID, and the graph refers to it with
   * `{ __type: "core/ASSET", info: { id } }`. Backends that do take a filename
   * leave this undefined and nothing downstream changes.
   */
  reference?: unknown;
  subfolder?: string;
}

export interface OutputFile {
  filename: string;
  subfolder: string;
  type: 'output' | 'temp';
  /** "images" | "video" | "audio" — node-keyed output bucket */
  bucket: string;
  /** Originating node id in the workflow. */
  nodeId: string;
  /**
   * Where to fetch it, when the backend addresses outputs by URL rather than
   * by filename. Comfy API v2 hands back a signed, expiring asset URL and a
   * UUID; `/api/view?filename=…` does not exist there.
   */
  url?: string;
  /** Comfy API v2's asset id: what `/api/v2/assets/{id}/content` takes once `url` has expired. */
  assetId?: string;
}

export type ProviderEvent =
  | { kind: 'queued' }
  | { kind: 'executing'; nodeId: string | null }
  | { kind: 'progress'; value: number; max: number }
  | { kind: 'preview'; blob: Blob }
  | { kind: 'output'; outputs: OutputFile[] }
  | { kind: 'done' }
  | { kind: 'error'; message: string }
  /**
   * Comfy API v2: the server's own account of the job — its status, when it
   * started executing, and once done the execution time and the credits
   * derived from it. Every poll carries one.
   */
  | { kind: 'meter'; status: string; startedAt: string | null; executionMs: number | null; timing: string | null; derivedCredits: number | null; creditsPerHour: number | null };

export interface SubmitCtx {
  /** Client identifier used for the WS connection. UUID v4 typically. */
  clientId: string;
  /** What the server records in the run history (v2), for later estimates. */
  meta?: { workflowId: string; slotSeconds: number | null; scaleWithSlot: boolean };
  /** Told when a submit is being retried (after checking it didn't land). */
  onRetry?: (attempt: number, max: number, reason: string) => void;
}

export interface ProviderHealth {
  online: boolean;
  message?: string;
}

/**
 * What the GPU has left, while a job is on it.
 *
 * Worth a whole trip to the server because of one measured case: a shot whose
 * slot asked for 260 frames sat at "step 0 of 8" for fifty-five minutes and
 * looked hung. It was not hung — the card had 246 MiB of 16303 free and was
 * re-fetching model weights over PCIe on every block. Nothing on screen could
 * tell that from a crash, and the number that answers it is one HTTP call away.
 */
export interface DeviceStats {
  name: string | null;
  vramFreeBytes: number;
  vramTotalBytes: number;
}

/** A file in the server's `user/default/workflows` tree. */
export interface RemoteWorkflowFile {
  /** Path relative to workflows/, e.g. "video/ltx-i2v.json". */
  path: string;
  size?: number;
  modified?: number;
}

/**
 * A prompt this server has already run — and, with it, the graph ComfyUI
 * itself compiled in order to run it.
 *
 * This is the point of the whole thing. `/history` keeps the submitted prompt
 * as a five-element tuple, and element 2 is the API graph the ComfyUI frontend
 * produced from the editor graph. That conversion is done by ComfyUI's own
 * code, in a current browser, with every custom node the server has installed
 * — so it is right by construction in a way that our `uiconvert.ts` can only
 * approximate. Element 3 carries `extra_pnginfo.workflow`: the editor graph
 * that produced it, which is what the App Mode layout lives in.
 *
 * Getting both, already paired, from a run the user made in the editor is the
 * cheapest correct answer to "why does this workflow fail in the panel but
 * work in ComfyUI".
 */
export interface RecentRun {
  promptId: string;
  /** ComfyUI's own ordering — higher is more recent. */
  queueIndex: number;
  /** The API graph, exactly as executed. */
  api: WorkflowJson;
  /**
   * The editor graph behind it, when the client sent one.
   *
   * Measured on a live server: only runs launched from the ComfyUI browser
   * frontend carry this. API clients — this panel, JustPhotoshop, anything
   * POSTing to /prompt — send the API graph alone, so a run of theirs can still
   * be captured but brings no App Mode layout with it.
   */
  ui: unknown | null;
  /**
   * What the server recorded as the origin of the prompt. `comfyui-frontend`
   * means somebody pressed Run in the editor, which is exactly the run the
   * Workflow tab wants to offer back.
   */
  usageSource: string | null;
  /** Which client submitted it; ours sends a stable id, the browser its own. */
  clientId: string | null;
  /** When the server says it was created, in ms. Null when it doesn't say. */
  createdAt: number | null;
}

/**
 * Read/write access to the server's own workflow store — what the ComfyUI
 * editor's Save/Open dialog uses. Present on every ComfyUI-protocol provider;
 * absent on backends that don't expose /userdata.
 */
export interface RemoteWorkflowStore {
  list(): Promise<RemoteWorkflowFile[]>;
  read(path: string): Promise<unknown>;
  save(path: string, data: unknown): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface VideoProvider {
  readonly id: ProviderId;
  readonly label: string;
  readonly requiresApiKey: boolean;

  /** Cheap reachability check — used by the ProviderPill status dot. */
  health(): Promise<ProviderHealth>;

  /** Upload an image / video / audio. Returns the filename to reference in the workflow. */
  uploadInput(file: Blob, filename: string): Promise<UploadResult>;

  /** Submit a workflow. Returns the prompt_id. */
  submit(workflow: WorkflowJson, ctx: SubmitCtx): Promise<{ jobId: string }>;

  /** Subscribe to job events via WebSocket. Returns an unsubscribe fn. */
  watch(
    jobId: string,
    ctx: SubmitCtx,
    onEvent: (e: ProviderEvent) => void,
  ): () => void;

  /** Fetch the output file list once the job is done (post-WS as a fallback / source of truth). */
  fetchOutputs(jobId: string): Promise<OutputFile[]>;

  /** Download a single output file as a Blob. */
  download(out: OutputFile): Promise<Blob>;

  /** Cancel a queued/running job. */
  cancel(jobId: string): Promise<void>;

  /** How long a finished job executed, as the server reports it (ms), or null. */
  executionMs?(jobId: string): Promise<number | null>;

  /* ─── Capabilities (optional — a backend may not expose them) ─────── */

  /**
   * The node schema catalogue. Required to convert an editor-format ("UI")
   * workflow into the API format /prompt wants, because widget values are
   * positional and only object_info knows the order.
   */
  objectInfo?(): Promise<ObjectInfo>;

  /** The server's workflow folder, when it exposes /userdata. */
  workflows?(): RemoteWorkflowStore | null;

  /**
   * The last few prompts this server ran, newest first — see {@link RecentRun}.
   * Absent on backends whose job history is not the ComfyUI `/history` shape.
   */
  recentRuns?(limit: number): Promise<RecentRun[]>;

  /** What the GPU has left — see {@link DeviceStats}. Null when it won't say. */
  deviceStats?(): Promise<DeviceStats | null>;

  /**
   * URL of the full ComfyUI editor, to hand to the user's own browser (auth
   * already folded into the query string where needed). Null when the backend
   * has no editor to open at all.
   *
   * This used to feed an <iframe> inside the panel, and could not: CEP 12
   * renders in Chromium 99, twelve versions below what the current ComfyUI
   * frontend needs. See bridge/csInterface.ts for the measurements.
   */
  editorUrl?(): string | null;
}
