/**
 * A lossless master save, added to a graph at submit time.
 *
 * Most current templates (LTX-2.5, MiniMax H3) end in core SaveVideo, whose
 * codecs on this server are H.264 and AV1 only — no setting makes them a
 * master. So when a lossless output profile is chosen and the graph has no
 * VHS_VideoCombine to switch, the panel adds one beside each SaveVideo, fed by
 * the same frames, frame rate and audio as the CreateVideo that SaveVideo
 * reads. The original save stays (it is the quick preview); the panel then
 * prefers the lossless file.
 *
 * Only the submitted copy of the graph changes — never the workflow file.
 */
import type { WorkflowJson } from '../providers/types';

type Link = [string, number];
const isLink = (v: unknown): v is Link => Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'number';

export interface LosslessResult {
  workflow: WorkflowJson;
  added: string[];
  /** Why nothing could be added, when nothing was. */
  reason?: string;
}

export function addLosslessSave(api: WorkflowJson, format: 'video/ffv1-mkv' | 'video/16bit-png', prefix = 'JustAE/master'): LosslessResult {
  const wf: WorkflowJson = JSON.parse(JSON.stringify(api)) as WorkflowJson;
  const added: string[] = [];
  let n = 0;
  for (const [id, node] of Object.entries(api)) {
    if (node.class_type !== 'SaveVideo') continue;
    const src = node.inputs.video;
    if (!isLink(src)) continue;
    const create = api[src[0]];
    if (!create || create.class_type !== 'CreateVideo') continue;
    const images = create.inputs.images;
    if (!isLink(images)) continue;
    const newId = `jae_master_${id}_${n++}`;
    wf[newId] = {
      class_type: 'VHS_VideoCombine',
      inputs: {
        images,
        frame_rate: create.inputs.fps ?? 24,
        loop_count: 0,
        filename_prefix: prefix,
        format,
        pingpong: false,
        save_output: true,
        ...(create.inputs.audio !== undefined && create.inputs.audio !== null ? { audio: create.inputs.audio } : {}),
      },
      _meta: { title: 'JustAE lossless master' },
    };
    added.push(newId);
  }
  return added.length
    ? { workflow: wf, added }
    : { workflow: wf, added, reason: 'no SaveVideo ← CreateVideo pair to attach a lossless save to' };
}

export const LOSSLESS_EXT = /\.(mkv|png|tiff?|exr)$/i;
