/** Shapes of the ComfyUI protocol this app reads and writes. */

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

export interface OutputFile {
  filename: string;
  subfolder: string;
  type: 'output' | 'temp';
  /** "images" | "video" | "audio" — node-keyed output bucket */
  bucket: string;
  /** Originating node id in the workflow. */
  nodeId: string;
  /** Comfy API v2: the output's asset id and its job — v2 has no /api/view to fetch by name. */
  assetId?: string;
  jobId?: string;
}

export type ProviderEvent =
  | { kind: 'queued' }
  | { kind: 'executing'; nodeId: string | null }
  | { kind: 'progress'; value: number; max: number }
  | { kind: 'preview'; blob: Blob }
  | { kind: 'output'; outputs: OutputFile[] }
  | { kind: 'done' }
  | { kind: 'error'; message: string };
