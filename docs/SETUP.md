# Setup

What you need, where the models come from, and how to run on Comfy's GPUs instead of your own. The full reference
is [the guide](GUIDE.md).

## What you need

- **Node.js 22.18+** and **ffmpeg** on the PATH.
- **EffectCraft 0.11.1+** ([github.com/storytold/effectcraft](https://github.com/storytold/effectcraft)).
- **ComfyUI 0.38+**, reachable over HTTP. The easiest is [ComfyUI Desktop](https://comfy.org/download); a ComfyUI in
  WSL, on another machine or behind a router works too.
- A GPU with **16 GB** for the LTX-2.5 presets; the Wan VACE 14B reframe wants **48 GB or more**, so it is meant for a
  cloud GPU. No GPU at all: see [Comfy Developer Platform](#comfy-developer-platform) below.

## Install

```bash
git clone https://github.com/HomoLapis/justae-flow.git && cd justae-flow
npm run setup        # npm install, build the window
npm run launch       # the server, EffectCraft with its control channel, the Flow window docked beside it
```

On Windows, **JustAE Flow.cmd** does the same with a double-click (`node scripts/launch.ts --shortcut` puts a shortcut
on the desktop). EffectCraft opens its control channel only when it is started with `--control 9877`, so let the
launcher start it; an EffectCraft already open without the channel cannot be joined.

**The panel in EffectCraft.** *Preferences ▸ Scripting & Expressions ▸ Allow Scripts to Write Files and Access
Network*, then *File ▸ Scripts ▸ Install ScriptUI Panel…* → `extensions/effectcraft/JustAE Flow.jsx`, then *Window ▸
JustAE Flow*. The panel shows whether the server and EffectCraft's channel are up, opens the Flow window and adds
marker pairs and placeholders.

Settings are kept in your user folder (`%APPDATA%\JustAE Flow` on Windows, `~/Library/Application Support/JustAE Flow`
on macOS, `~/.config/JustAE Flow` on Linux), never in the project or the repository.

## Your local ComfyUI

The first time, the Workflow tab opens on **Get started**:

1. **Where to run.** It looks for ComfyUI at `http://127.0.0.1:8188`. Another address: *Settings ▸ Resources ▸ Local
   ComfyUI*.
2. **What's ready.** Every preset is checked against your ComfyUI's own list of nodes and model files.
3. **Try it.** *Make a test image* puts a Z-Image-Turbo still in your comp.

### Models

Nothing is downloaded for you. **Workflow ▸ Get the models…** lists what each preset lacks, with the size, the source
and the licence of every file; tick what you want and press *Download selected*. The files go into the models folder
you set in *Settings ▸ Resources* (ComfyUI's `models` folder) and nowhere else, checked against the sha256 Hugging Face
gives for them. Each file can also be fetched by hand from the URL shown, or with comfy-cli.

The presets are official ComfyUI templates, converted to the API format with no hand edits. They use open weights only:

| Preset | Model | Weights licence |
|---|---|---|
| Text / image → video, Extend | LTX-2.5 | LTX-2.x Community License |
| First + last frame → video | MiniMax H3, Wan 2.2 14B | MiniMax H3 open weights (commercial use of local outputs needs MiniMax's licence); Apache-2.0 |
| Reframe (generative) | Wan 2.1 VACE 14B, 1.3B draft | Apache-2.0 |
| Upscale | SeedVR2 3B | Apache-2.0 |
| Cut-out, auto crop | SAM 3 | SAM License (Meta) |
| Stills, image edit, cut-out of a still | Z-Image-Turbo, Qwen-Image-Edit, BiRefNet | Apache-2.0, Apache-2.0, MIT |
| Slow motion | RIFE, FILM | MIT, Apache-2.0 |
| Describe the clip | Qwen3-VL-4B | Apache-2.0 |

**The LTX files are gated on Hugging Face.** Open the model's page (the download list links it), press *Agree and
access* to accept the LTX-2.x Community License, then download. If Hugging Face asks for a token, put one in
*Settings ▸ Resources*; it is kept in `hf-token.txt` in your user folder and sent to huggingface.co only. The LTX
finishing tools (Refine, Archive restore, Deblur, Colorize, Day → Night, Clean plate, LTX Alpha, SDR → HDR) each need
their IC-LoRA from Lightricks' *LTX-2.5 Creative Lab* repos, gated the same way, plus two node packs to install with
ComfyUI Manager: **ComfyUI-LTXVideo** and **ComfyUI-VideoHelperSuite**. RIFE needs **ComfyUI-Frame-Interpolation**.
JustAE Flow never installs node packs; it tells you which one a card is missing.

From a terminal, `npm run verify:workflows -- http://127.0.0.1:8188` prints what your ComfyUI can run and the URL of
every missing file; `npm run verify:finishing http://127.0.0.1:8188` does the same for the LTX finishing tools.

## Comfy Developer Platform

The presets run as they are on Comfy's GPUs. One key, three places to run:

1. **The key.** Create one at [platform.comfy.org ▸ API Keys](https://platform.comfy.org/profile/api-keys) and paste
   it in *Settings ▸ Resources ▸ Comfy account*. The server keeps it in `comfy-api-key.txt` in your user folder; the
   window only ever sees its last four characters.
2. **Comfy Cloud.** Jobs run on an RTX PRO 6000 for credits. Running jobs by API needs an active Comfy Cloud plan: a
   free-tier key can read the service, but every job is refused. *Check* on its card says which presets it can run.
3. **Your own deployment.** A ComfyUI of your own on the platform, with the models you choose, on the GPU you pick.
   Build and deploy it with [comfy-cli](https://docs.comfy.org/) (`comfy build …`, `comfy deploy up … --min 0 --max 1`),
   then paste the endpoint that `comfy deploy status` prints (`https://<deployment>.run.comfy.app`) in *Settings ▸
   Resources ▸ Add a deployment*. JustAE Flow never builds, deploys, starts or stops anything on the platform; it only
   talks to an endpoint you already have. A deployment with `--min 0` scales to zero between jobs and bills the
   worker's start-up with the first job; with `--min 1` it bills while idle.

Then pick **Running on** at the top of the Workflow tab, or set it per task in *Settings ▸ Resources*. Before a run the
Generate button shows an estimate of time and credits, from the GPU's rate and your earlier runs; after it, the time
the job took and the credits derived from it, and later the figure from the hourly billing report. The platform has no
per-job price API, so these numbers are derived, never quoted. The balance shown in the header comes from the billing
report and lags behind real usage.

To try the platform's API against your own machine for free, run `pip install comfy-api-proxy` and start
`comfy-api-proxy` next to your ComfyUI; its address goes in *Settings ▸ Resources* as well.

## Privacy

The server listens on 127.0.0.1 only and talks to what you set up: EffectCraft, your ComfyUI, and, once you add a key,
Comfy Cloud and the deployment addresses you paste. The Workflow tab reads the public Hugging Face API for the sizes
and gating of the preset files. No telemetry, no account of its own.
