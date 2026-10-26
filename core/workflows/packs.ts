/**
 * The custom-node packs a bundled workflow needs beyond core ComfyUI, and how to get them.
 *
 * A ComfyUI without the pack has no trace of it in its /object_info, so the names cannot be read at run time where
 * they are missing. They were read where they are installed: the `python_module` of each class in the local
 * ComfyUI's /object_info (ComfyUI 0.38.0, 26 Oct 2026: `custom_nodes.ComfyUI-LTXVideo`,
 * `custom_nodes.comfyui-videohelpersuite`), and the pack ids and repositories confirmed in the Comfy registry's API
 * (GET https://api.comfy.org/nodes/<id>, 26 Oct 2026). JustAE Flow never installs a pack: it names it, and the
 * user installs it with ComfyUI Manager. Every other class of the bundled graphs is core ComfyUI (`nodes`,
 * `comfy_extras`), except RIFE VFI (interp-rife, not Featured): its module was read as another pack's on this
 * machine, so its pack is left unnamed here.
 */

export interface NodePack {
  /** The registry id (api.comfy.org/nodes/<id>) — also the name ComfyUI Manager lists. */
  id: string;
  /** What people call it. */
  name: string;
  /** Its source, as the registry gives it. */
  repo: string;
  /** Node classes of the bundled workflows that come from it. */
  classes: string[];
}

export const NODE_PACKS: NodePack[] = [
  {
    id: 'ComfyUI-LTXVideo', name: 'ComfyUI-LTXVideo', repo: 'https://github.com/Lightricks/ComfyUI-LTXVideo',
    classes: ['LTXICLoRALoaderModelOnly', 'LTXAddVideoICLoRAGuide', 'LTXVGetTilingSizes', 'LTXVTiledFusionSampler', 'LTXVVAEForceFloat32', 'LTXVLoadConditioning', 'LTXVHDRDecodePostprocess'],
  },
  {
    id: 'comfyui-videohelpersuite', name: 'ComfyUI-VideoHelperSuite', repo: 'https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite',
    classes: ['VHS_MergeImages', 'VHS_VideoCombine', 'VHS_LoadImages', 'VHS_LoadVideo'],
  },
];

/** The pack a node class comes from, if JustAE Flow knows it. */
export function packOf(classType: string): NodePack | undefined {
  return NODE_PACKS.find((p) => p.classes.includes(classType));
}

/** The packs a graph needs, each with the classes of it the graph uses. */
export function packsOf(classTypes: Iterable<string>): Array<NodePack & { used: string[] }> {
  const out = new Map<string, NodePack & { used: string[] }>();
  for (const c of classTypes) {
    const p = packOf(c);
    if (!p) continue;
    const e = out.get(p.id) ?? { ...p, used: [] };
    if (!e.used.includes(c)) e.used.push(c);
    out.set(p.id, e);
  }
  return [...out.values()];
}
