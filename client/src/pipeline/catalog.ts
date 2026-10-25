/**
 * The professional workflow library — what each stage of a large-format AI
 * pipeline is for, where it should run, what it needs, and what "draft" and
 * "final" mean for it.
 *
 * A catalog entry is not a workflow file. Graphs depend on the custom nodes a
 * server has installed, and a hand-written graph that "should" work renders
 * something plausible and wrong (README, "Converting workflows"). So an entry
 * names the node types that must exist, how to recognise a matching workflow
 * in the server's library, and presets expressed as `class_type.input` — the
 * panel applies them to whichever matching workflow the user picks, and says
 * which ones it could not find. Input names were read off a live
 * /object_info (ComfyUI 0.38.0, 1 Oct 2026); sources in docs/RESEARCH.md.
 */

export type Target = 'local' | 'cloud' | 'both';
export type Stage = 'generate' | 'keyframes' | 'upscale-video' | 'upscale-still' | 'interpolate' | 'matte';

/** A value set on every node of `node` (regex on class_type) whose input `input` is in the form. */
export interface PresetValue {
  node: string;
  input: string;
  value: string | number | boolean;
  /** Why this value — shown in the UI next to it. */
  why?: string;
}

export interface CatalogEntry {
  id: string;
  name: string;
  stage: Stage;
  /** One or two sentences: what it is for and when to choose it. */
  purpose: string;
  /** Where each tier is meant to run. */
  draftTarget: Target;
  finalTarget: Target;
  /** VRAM, with where the number comes from. */
  vram: { draft: string; final: string; basis: 'measured' | 'declared' | 'estimate' };
  /** Node types that must exist on the server (any one of each group). */
  requires: string[][];
  /** Regexes on workflow file names that likely implement this entry. */
  match: string[];
  /**
   * Which workflow VARIANT suits each tier (regexes on the name). For
   * generation models the draft/final difference is the variant — distilled
   * or turbo vs full — not a step count: forcing 4 steps on a workflow without
   * its turbo LoRA, or cfg 3 on a distilled model, ruins the render.
   */
  variants?: { draft?: string[]; final?: string[] };
  draft: PresetValue[];
  final: PresetValue[];
  /** Short practical notes (limits, licences, order in the chain). */
  notes: string[];
  /** Licence caveat worth saying before a commercial job. */
  licence?: string;
}

export const CATALOG: CatalogEntry[] = [
  {
    id: 'ltx25-i2v',
    name: 'LTX-2.5 · image/keyframes → video + audio',
    stage: 'generate',
    purpose: 'General-purpose shot generation with synchronised audio. Native high resolution with 2× latent upscalers; the best open choice for a 4K final.',
    draftTarget: 'local', finalTarget: 'cloud',
    vram: { draft: '16 GB with int8 + offload', final: '48–80 GB (bf16, 4K)', basis: 'estimate' },
    requires: [['LTXVImgToVideo', 'EmptyLTXVLatentVideo', 'LTXVAddGuide']],
    match: ['ltx.?2[._-]?5', 'ltx'],
    variants: { draft: ['distill', 'single.?stage'], final: ['two.?stage', 'dev', 'upsampl'] },
    // Distilled LTX workflows use a fixed ManualSigmas schedule at cfg 1, so no
    // step/cfg preset is safe across variants (measured on the local server).
    draft: [],
    final: [],
    notes: [
      'Frames must satisfy n % 8 == 1 (97, 121…); sides multiples of 32 — the panel snaps to 32.',
      'For 4K: render at half size and add the ×2 latent spatial upscaler (LTXVLatentUpsampler) rather than sampling 4K directly.',
    ],
    licence: 'LTX-2.x Community License: free under $10M annual revenue; above that a paid agreement.',
  },
  {
    id: 'minimax-h3-flf',
    name: 'MiniMax H3 · first + last frame (keyframes)',
    stage: 'keyframes',
    purpose: 'Transitions and shots defined by their opening and closing frames — the storyboard-to-motion workhorse; strongest at camera and subject continuity between two approved frames.',
    draftTarget: 'local', finalTarget: 'cloud',
    vram: { draft: '16 GB int8: fine up to ~158 frames at 1280 long side; beyond that it spills to PCIe (25 min → 1 h 27 min)', final: '80 GB for bf16', basis: 'measured' },
    requires: [['MiniMaxH3ImageToVideo']],
    match: ['h3.*(fl|first|last|fflf|key)', 'minimax.?h3'],
    variants: { draft: ['4x.?speed', 'turbo', 'fast'], final: ['refine', 'detail', 'full'] },
    draft: [],
    final: [],
    notes: [
      'Open weights generate at a 768 px short edge, 24 fps, ~15 s — upscale for large format (SeedVR2).',
      'Prompts are structured (see the prompt assistant): alignment line, then multimodal description / soundscape / music.',
      'Some H3 workflows run on ComfyCloud API nodes (no local sampler): they match by name but render on Comfy servers and are billed there.',
    ],
    licence: 'Commercial use of locally generated outputs needs a MiniMax commercial licence (sold by Comfy); included on Comfy Cloud.',
  },
  {
    id: 'minimax-h3-ref',
    name: 'MiniMax H3 · reference → video',
    stage: 'generate',
    purpose: 'Carry a subject, motion or voice from reference images/clips into a new shot — character and product consistency across a sequence.',
    draftTarget: 'local', finalTarget: 'cloud',
    vram: { draft: '16 GB int8 (keep under ~150 frames)', final: '80 GB bf16', basis: 'measured' },
    requires: [['MiniMaxH3ReferenceToVideo']],
    match: ['h3.*(ref|r2v)', 'minimax.*ref'],
    variants: { draft: ['4x.?speed', 'turbo', 'fast'], final: ['refine', 'detail'] },
    draft: [],
    final: [],
    notes: ['Same resolution limits as the keyframe variant.'],
    licence: 'As MiniMax H3 above.',
  },
  {
    id: 'wan22-flf',
    name: 'Wan 2.2 · first + last frame',
    stage: 'keyframes',
    purpose: 'Keyframe-to-keyframe motion under Apache 2.0 — the licence-safe alternative for client work when H3 licensing is not in place.',
    draftTarget: 'local', finalTarget: 'cloud',
    vram: { draft: '16 GB with 14B fp8 + offload (5B fits easily)', final: '48–80 GB (14B bf16, 720p)', basis: 'estimate' },
    requires: [['WanFirstLastFrameToVideo']],
    match: ['wan.*(flf|first|last)', 'wan2\.?2'],
    variants: { draft: ['lightning', 'lightx', 'distill', '5b'], final: ['14b'] },
    draft: [],
    final: [],
    notes: ['Native 720p — plan an upscale stage for anything large.'],
    licence: 'Apache 2.0.',
  },
  {
    id: 'seedvr2-upscale',
    name: 'SeedVR2 · temporal video upscale (4K / 8K)',
    stage: 'upscale-video',
    purpose: 'The final upscale for sequences: one-step diffusion restoration that sees neighbouring frames, so detail does not flicker. Use it — not an image upscaler — on video.',
    draftTarget: 'local', finalTarget: 'cloud',
    vram: { draft: '8–16 GB: 3B GGUF/fp8 with BlockSwap + VAE tiling', final: '40–80 GB: 7B fp16, large batches', basis: 'declared' },
    requires: [['SeedVR2VideoUpscaler']],
    match: ['seedvr'],
    draft: [
      { node: '^SeedVR2VideoUpscaler$', input: 'batch_size', value: 5, why: '4n+1; the minimum that turns temporal consistency on' },
      { node: '^SeedVR2VideoUpscaler$', input: 'temporal_overlap', value: 1 },
    ],
    final: [
      { node: '^SeedVR2VideoUpscaler$', input: 'batch_size', value: 49, why: '4n+1 — ideally the whole shot; raise to the shot length when VRAM allows' },
      { node: '^SeedVR2VideoUpscaler$', input: 'temporal_overlap', value: 4, why: 'hides seams between batches' },
      { node: '^SeedVR2VideoUpscaler$', input: 'color_correction', value: 'lab' },
    ],
    notes: [
      '`resolution` is the target short side: 2160 for UHD, 4320 for 8K; any value divisible by 2.',
      'Upscale before interpolating, so the interpolator does not invent detail the upscaler then sharpens.',
    ],
    licence: 'Apache 2.0.',
  },
  {
    id: 'flashvsr-preview',
    name: 'FlashVSR · fast 4× video upscale',
    stage: 'upscale-video',
    purpose: 'Quick 4× streaming upscale to judge a shot at size on the wall before paying for the SeedVR2 final.',
    draftTarget: 'local', finalTarget: 'local',
    vram: { draft: '≥ 12 GB', final: '≥ 12 GB', basis: 'declared' },
    requires: [['WanVideoFlashVSRDecoderLoader', 'FlashVSRNode', 'FlashVSR']],
    match: ['flashvsr'],
    draft: [], final: [],
    notes: ['On this server FlashVSR is only present through the WanVideo wrapper (and a hosted API node).'],
    licence: 'Apache 2.0.',
  },
  {
    id: 'rife-50p',
    name: 'RIFE 4.x · 25 → 50 fps',
    stage: 'interpolate',
    purpose: 'Double the frame rate for 50p LED playback, or retime. Fast, low VRAM; good on most AI shots.',
    draftTarget: 'local', finalTarget: 'local',
    vram: { draft: '4–8 GB', final: '4–8 GB', basis: 'estimate' },
    requires: [['RIFE VFI']],
    match: ['(^|[^a-z])rife([^a-z]|$)', '(^|[^a-z])vfi([^a-z]|$)', 'interpolat'],
    draft: [
      { node: '^RIFE VFI$', input: 'multiplier', value: 2 },
      { node: '^RIFE VFI$', input: 'fast_mode', value: true },
    ],
    final: [
      { node: '^RIFE VFI$', input: 'multiplier', value: 2 },
      { node: '^RIFE VFI$', input: 'fast_mode', value: false },
      { node: '^RIFE VFI$', input: 'ensemble', value: true },
    ],
    notes: ['Set the output frame rate (VHS frame_rate) to double the source.'],
  },
  {
    id: 'gimm-interp',
    name: 'GIMM-VFI · interpolation for complex motion',
    stage: 'interpolate',
    purpose: 'When RIFE tears on occlusions, fast hands or crossing objects: slower, better motion estimation, 2–4×.',
    draftTarget: 'local', finalTarget: 'local',
    vram: { draft: '8–12 GB', final: '8–12 GB', basis: 'estimate' },
    requires: [['GIMMVFI_interpolate']],
    match: ['gimm'],
    draft: [{ node: '^GIMMVFI_interpolate$', input: 'interpolation_factor', value: 2 }, { node: '^GIMMVFI_interpolate$', input: 'ds_factor', value: 0.5 }],
    final: [{ node: '^GIMMVFI_interpolate$', input: 'interpolation_factor', value: 2 }, { node: '^GIMMVFI_interpolate$', input: 'ds_factor', value: 1 }],
    notes: ['ds_factor < 1 trades flow accuracy for speed — fine for drafts, not for finals.', 'Licence: S-Lab License 1.0 (GIMM-VFI) — non-commercial use only; the Comp tab offers RIFE and FILM instead.'],
  },
  {
    id: 'sam3-matte',
    name: 'SAM 3 → (MatAnyone 2) · video alpha',
    stage: 'matte',
    purpose: 'Isolate a subject over a whole shot from a text prompt, for compositing over LED backgrounds. SAM 3 tracks; MatAnyone 2 refines hair and motion blur into a real matte.',
    draftTarget: 'local', finalTarget: 'local',
    vram: { draft: '8–12 GB', final: '12–16 GB with MatAnyone 2', basis: 'estimate' },
    requires: [['SAM3_VideoTrack'], ['SAM3_TrackToMask']],
    match: ['sam.?3', 'matt(e|ing)([^a-z]|$)', '(^|[^a-z])alpha([^a-z]|$)', 'rmbg'],
    draft: [{ node: '^SAM3_VideoTrack$', input: 'detect_interval', value: 4, why: 'detect every 4th frame, track between' }],
    final: [{ node: '^SAM3_VideoTrack$', input: 'detect_interval', value: 1 }],
    notes: [
      'MatAnyone 2 is NOT installed on the local server — without it the matte is a hard mask (fine for rigid objects, not hair).',
      'Save the result as 16-bit PNG with alpha (output profile "PNG 16-bit sequence").',
    ],
  },
  {
    id: 'smart-upscale-still',
    name: 'Smart Upscaler · keyframes, plates, references (stills only)',
    stage: 'upscale-still',
    purpose: 'LLM-guided tiled upscale of a single image — for the first/last frames you feed a keyframe model, matte plates and reference boards. Never on a sequence: each frame would get different invented detail and flicker.',
    draftTarget: 'local', finalTarget: 'local',
    vram: { draft: '12–16 GB (~13 GB of models)', final: '12–16 GB', basis: 'declared' },
    requires: [['SmartUpscaledTilePlanner']],
    match: ['smart.?upscal', 'hallett'],
    draft: [{ node: '^SmartUpscaledTilePlanner$', input: 'scale_factor', value: 2 }],
    final: [
      { node: '^SmartUpscaledTilePlanner$', input: 'scale_factor', value: 4 },
      { node: '^SmartUpscaledTilePlanner$', input: 'overlap', value: 64, why: 'wider overlap hides joins at 4×' },
    ],
    notes: ['Upscale keyframes BEFORE the keyframe-to-video model, so it starts from clean, large frames.'],
    licence: 'MIT (the node pack); the image model it drives has its own licence.',
  },
];

/* ── delivery / output profiles ─────────────────────────────────────────── */

export interface OutputProfile {
  id: string;
  label: string;
  description: string;
  /** Applied to the workflow's save node when it has one. */
  preset: PresetValue[];
  /**
   * Made locally from the downloaded file with ffmpeg, then imported instead.
   * Only meaningful from a lossless source — the panel says so otherwise.
   */
  master?: 'prores4444' | 'png16';
}

export const OUTPUT_PROFILES: OutputProfile[] = [
  {
    id: 'as-workflow',
    label: 'As the workflow saves it',
    description: 'No change to the save node — fine for drafts, usually H.264.',
    preset: [],
  },
  {
    id: 'png16',
    label: 'PNG 16-bit sequence (lossless, alpha)',
    description: 'The workflow also saves a 16-bit FFV1 (added beside SaveVideo when needed); the panel extracts a PNG 16-bit sequence from it and imports that as the clip. Verified on ComfyUI 0.38: VHS FFV1 is gbrap16le.',
    preset: [{ node: '^VHS_VideoCombine$', input: 'format', value: 'video/ffv1-mkv' }],
    master: 'png16',
  },
  {
    id: 'prores4444-master',
    label: 'ProRes 4444 master (lossless source)',
    description: 'Same 16-bit FFV1 save; the panel writes a ProRes 4444 .mov with alpha (yuva444p10le, 12-bit decode) and imports that.',
    preset: [{ node: '^VHS_VideoCombine$', input: 'format', value: 'video/ffv1-mkv' }],
    master: 'prores4444',
  },
];

export function catalogEntry(id: string): CatalogEntry | undefined {
  return CATALOG.find((e) => e.id === id);
}

export function outputProfile(id: string): OutputProfile {
  return OUTPUT_PROFILES.find((p) => p.id === id) ?? OUTPUT_PROFILES[0];
}
