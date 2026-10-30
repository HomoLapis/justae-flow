# Platform builds

Build specs for the Comfy Developer Platform, one folder each: `comfy build push <dir>` uploads the definition (the
builder fetches the models from Hugging Face by URL and checksum; nothing is uploaded from your machine), then
`comfy build release create --target linux/nvidia --watch` and `comfy deploy up <dir> --gpu <class> --region <region>
--min 0 --max 1 --name <name>`. The endpoint `comfy deploy status <dir>` prints goes in *Settings ▸ Resources*.
Each spec starts with `id: null`: the push assigns an id in **your** account and writes it back into the file, so keep
your copy out of commits (or restore the file afterwards).

| Folder | What it holds | GPU | Rows to route to it |
| --- | --- | --- | --- |
| `justae-flow-h3` | MiniMax H3 int8 base, text encoder, both VAEs, the Open-H3 Regenerate 2K refiner LoRA (rank-128 ComfyUI conversion), the LBH latent upscaler pack | 96 GB (RTX PRO 6000) | *Regenerate to 2K*; also the H3 text / image presets |

Policies (`modelPolicy`, `partnerNodePolicy`) are left out on purpose: the platform accepts them only on a Team plan.
