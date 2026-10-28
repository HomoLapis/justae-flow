# JustAE Flow — the guide

Everything about installing, setting up and using JustAE Flow. The [README](../README.md) has the short version.

- [What it does](#what-it-does) · [Requirements](#requirements) · [Install and run](#install-and-run)
- [Models to download](#models-to-download) · [Resources and credits](#resources-and-credits) · [Your own deployment](#your-own-deployment)
- [Using it](#using-it): [the tabs](#the-tabs), [Featured workflows](#featured-workflows), [the Comp tab](#the-comp-tab), [LTX finishing](#ltx-finishing)
- [How it works](#how-it-works) · [Privacy and network](#privacy-and-network) · [Development](#development) · [Limits and to be verified](#limits-and-to-be-verified) · [Licence](#licence)

## What it does

A panel docked in EffectCraft opens the **Flow window** (the interface of JustAE Flow 2, the After Effects panel
that runs any ComfyUI workflow against the timeline). Four tabs: **Workflow** (any workflow of your ComfyUI, plus a
*Featured* set), **Marker** and **Storyboard** (shots from markers and placeholder layers, generated in series and
placed at their slots), and **Comp** (tools on the whole comp, its work area or a layer). It runs on your local
ComfyUI, your own Comfy API deployment, Comfy Cloud or `comfy-api-proxy` — one platform key for all of Comfy's side.

**Against the Higgsfield plugin for After Effects / Premiere Pro.** Its seven functions, as its page lists them
(higgsfield.ai/plugins/after-effects, copy of 22 Oct 2026; Higgsfield blog, 21 Jul 2026):

| Higgsfield function | What Higgsfield does | JustAE Flow | Status |
|---|---|---|---|
| Generate Video | text → clip on Higgsfield's servers, dropped into the timeline | LTX-2.5 text/image → video with sound, MiniMax H3 and Wan 2.2 first + last frame, or any video workflow of your ComfyUI — per marker pair or placeholder, in series, at its slot | **done** |
| Generate Image | text → still into the timeline | Z-Image-Turbo (or any image workflow) on a placeholder; Qwen-Image-Edit inside a PhotoCraft selection | **done** |
| Reframe | *crops* to 9:16, 16:9, 4:3, 3:4, 21:9, 1:1 with subject tracking | **generates** the space the new format needs (Wan 2.1 VACE outpainting) in 9:16, 4:5, 1:1, 16:9, 21:9, 4:3; the crop with SAM 3 tracking is there too (*Advanced ▸ Crop with tracking*); 3:4 is not offered | **different** |
| Remove Background | alpha key from any clip | SAM 3 tracked matte set as a luma track matte (the clip untouched), ProRes 4444 master with alpha; **LTX Alpha** (Lightricks' Alpha Gen IC-LoRA) for soft edges — hair, smoke, glass; BiRefNet for stills | **done** (SAM 3: hard edges on hair, see limits) |
| Draw to edit | sketch on the frame → inpainting | Wan VACE inpainting from a drawn mask (the official template `video_wan_vace_inpainting` is identified, not built) | **planned** |
| Upscale | "up to 4K or 8K" | SeedVR2 ×2, ×4 in two passes, original colours kept; or **LTX Refine** (LTX-2.5 + Lightricks' Refine Details IC-LoRA, tiled) to Full HD, 4K, or 8K always through 4K; verified here: SeedVR2 to 2160×3840, LTX Refine to Full HD on a 16 GB GPU — LTX 4K/8K planned and validated, not run (hours on 16 GB) | **done** (to 4K; LTX to Full HD) |
| Edit Video | prompt-based editing | Restyle (LTX-2.5 video-to-video or VACE with a reference) is not built; the LTX finishing cards edit in fixed ways — Day → Night, Clean plate, Colorize, Deblur, De-compression, Archive restore | **partly** |

Only here: **LTX finishing** (Lightricks' IC-LoRAs: Archive restore, Deblur, De-compression, Colorize, Clean plate,
Day → Night, with 16-bit masters), **Extend** a shot by 2–5 s carrying on the motion of its last frames, **Slow motion / fps** (RIFE, FILM),
a **Social pack** (several formats, their upscales and masters in one queue), **Describe the clip** (a local
vision-language model writes the prompt from your frames), a **storyboard** built from the timeline's markers and
placeholders with versions and status colours, and an estimate of time and credits under every Generate button.
Higgsfield has things this does not: "Seed audio" (voices, ambience), an MCP bridge and its own model catalogue.

## Requirements

You need: **Node.js 22.18+**; **EffectCraft 0.11.1+**; **ComfyUI 0.38+** with the official templates package (it
ships with ComfyUI), reachable over HTTP; **ffmpeg** on the PATH (masters, Extend, Describe the clip). The LTX-2.5
workflows need a GPU with 16 GB or more; the Wan VACE 14B reframe is meant for a cloud GPU with 48 GB or more.

## Install and run

```bash
git clone https://github.com/HomoLapis/justae-flow.git && cd justae-flow
npm run setup        # npm install + build the UI + enable the pre-commit secret scan
npm run launch       # the server, EffectCraft with its control channel, and the Flow window docked beside it
```

On Windows, double-click **JustAE Flow.cmd** instead (`node scripts/launch.ts --shortcut` puts a shortcut to it on
the desktop). EffectCraft opens its control channel only when started with `--control 9877`, so the launcher starts
it that way; an EffectCraft already open without it cannot be joined — the launcher says so and leaves it alone
(save, close it, launch again). `npm start` runs the server alone on http://127.0.0.1:5199.

**The panel.** In EffectCraft: *Preferences ▸ Scripting & Expressions ▸ Allow Scripts to Write Files and Access
Network*; then *File ▸ Scripts ▸ Install ScriptUI Panel…* → `extensions/effectcraft/JustAE Flow.jsx`; then
*Window ▸ JustAE Flow*. It shows whether the server and EffectCraft's channel are up, opens the Flow window, adds
marker pairs and placeholders, runs the layer tools, and says where they run.

### Get started, in the Flow window

The first time, the **Workflow** tab opens on a **Get started** card with three steps, each checked live:

1. **Where to run.** It looks for your ComfyUI at `http://127.0.0.1:8188` and says what it found (version, GPU). No
   ComfyUI yet: install **ComfyUI Desktop** from [comfy.org/download](https://comfy.org/download) and press *Check
   again*; a ComfyUI elsewhere: put its address in *Settings ▸ Resources*. No GPU: see
   [No GPU: the Comfy Developer Platform](#no-gpu-the-comfy-developer-platform).
2. **What's ready.** "8 of 9 ready on Local ComfyUI · 1 needs models (28.6 GB)": each Featured workflow is checked
   against your ComfyUI's own list of nodes and model files. **Get the missing models** opens the list below.
3. **Try it.** **Make a test image** makes a 512×512 Z-Image-Turbo still on your ComfyUI and places it in the open comp
   at the playhead, as "Flow · test image" (the file is kept in the project's `_test` folder). Without Z-Image the
   button says how much it needs ("Get Z-Image first (20.7 GB)").

The card comes back on its own when no resource can take a job, or when fewer than half of the Featured workflows are
ready where the Generate button sends them. *Hide — reopen from Settings* puts it away; *Settings ▸ Get started* and,
when nothing can run, the header pill bring it back.

**Get the models.** You choose what goes on your ComfyUI: the Featured workflows, grouped as on the Workflow tab, each
with a box to tick (nothing is ticked for you; *Start with Z-Image + LTX-2.5 image to video* ticks the suggested pair)
and the files it lacks — name, folder, size, source, licence. A file two workflows share is downloaded and counted once;
the total gives files, gigabytes and the time at your last measured download speed. **Download selected** fetches
only what you ticked, **into the models folder you set** (*Settings ▸ Resources ▸ Local ComfyUI ▸ Models folder*:
ComfyUI's `models` folder, which holds `checkpoints/` and `diffusion_models/`; for Comfy Desktop on Windows the docs
name its shared model library `%LOCALAPPDATA%\Comfy-Desktop\ComfyUI-Shared` — paste it and JustAE Flow uses a
`models` folder inside it if there is one (its exact layout: to be verified); for a ComfyUI in WSL, `\\wsl.localhost\<distro>\home\<user>\ComfyUI\models`). JustAE Flow
writes nowhere else. Each file goes to `<folder>\<directory>\<name>.part`, resumes after an interruption (a Range
request), is checked against the size and the sha256 that Hugging Face gives for it (a mismatch is deleted) and is
renamed when it checks out; then your ComfyUI is read again, and the cards update. If ComfyUI does not list a new file,
restart it or press Refresh in its UI. Every file can also be fetched alone, or copied as a comfy-cli command
(`comfy --workspace "<ComfyUI>" model download --url <url> --relative-path models/<directory> --filename <name>`).
Gated files (the Lightricks LTX-2.5 repos) need their terms accepted on their Hugging Face page first; a Hugging Face
token, if needed, goes in *Settings ▸ Resources* (kept in `hf-token.txt` in your user folder, sent to huggingface.co
only). Custom nodes are never installed by JustAE Flow: the pack is named (LTX Refine needs **ComfyUI-LTXVideo** and
**ComfyUI-VideoHelperSuite**) to install with ComfyUI Manager.

Settings live in your user folder (`%APPDATA%\JustAE Flow`, `~/Library/Application Support/JustAE Flow`,
`~/.config/JustAE Flow`; `JUSTAE_FLOW_HOME` puts them elsewhere), never in the project or the repository;
`.env.example` lists the variables that override them. The PhotoCraft storyboard (http://127.0.0.1:5199/storyboard/)
has its own setup guide. From a terminal, `npm run verify:workflows` lists what your ComfyUI can run and the download
URL of every missing file.

### No GPU: the Comfy Developer Platform

The bundled workflows run as they are on Comfy's platform, with one API key — the Flow window has no setup of its own
for it, only these steps:

1. **The key.** Create one at [platform.comfy.org ▸ API Keys](https://platform.comfy.org/profile/api-keys) and paste it
   once in *Settings ▸ Resources ▸ Comfy account*. The server keeps it in `comfy-api-key.txt` in your user folder; the
   window only ever gets back whether one is set and its last four characters.
2. **Comfy Cloud** (`https://cloud.comfy.org`) then runs jobs on an RTX PRO 6000 for credits — an active Comfy Cloud
   plan is required for jobs by API (a free-tier key reads the service but every job is refused with 403). *Check* in
   its card reads which bundled workflows it has.
3. **Or your own deployment** of the workflows you need, on the GPU you pick: see
   [Your own deployment](#your-own-deployment); add its address in *Settings ▸ Resources ▸ Add a deployment*.
4. **Running on** at the top of the Workflow tab (the same pick as the Generate button) then sends jobs there, and the
   cards say what is known to run there. Costs: [Resources and credits](#resources-and-credits).

### The Flow window, docked

EffectCraft docks only ScriptUI panels — it has no web panels like After Effects' CEP — so Flow 2's interface runs in
an app window of Edge or Chrome. On Windows it opens at EffectCraft's right edge, at full height, with EffectCraft
narrowed to make room, and it follows EffectCraft when it is moved, resized, minimized or restored. Drag it away to
undock it; **Open JustAE Flow** in the panel docks it again and never opens a second one. On macOS and Linux it opens
as a window of its own.

## Models to download

The easy way is in the Flow window: **Workflow ▸ Get the models…** (or *Get them* on a card) lists what each Featured
workflow lacks on your ComfyUI, with sizes, and downloads what you tick into the models folder you set — see
[Get started, in the Flow window](#get-started-in-the-flow-window). The table below is the reference.

All bundled workflows are **official ComfyUI templates** with **open weights**, converted to the API format by
`scripts/build-workflows.ts` (no hand-edited graphs; every node checked in the server's `object_info`). No partner
nodes, no closed APIs.

| Id | Template (comfyui-workflow-templates 0.11.76) | Task | Weights licence |
|---|---|---|---|
| `ltx25-t2v` | `video_ltx2_5_t2v` | text → video with sound | LTX-2.x Community License |
| `ltx25-i2v` | `video_ltx2_5_i2v` | frame under the marker (or an attached image) → video | LTX-2.x Community License |
| `ltx25-extend` | `video_ltx2_5_flf2v` | a clip's last frames (video guide) → the next seconds (Comp ▸ Extend) | LTX-2.x Community License |
| `describe-clip` | `llm_qwen3vl_text_gen` | a few frames → a paragraph for the prompt (local only) | Apache-2.0 (Qwen3-VL-4B) |
| `zimage-t2i` | `image_z_image_turbo` | text → image | Apache-2.0 |
| `seedvr2-upscale` | `utility_seedvr2_3b_int8_upscale_video` | video ×2 restoration upscale | Apache-2.0 |
| `birefnet-rmbg` | `utility_birefnet_remove_background` | still → cut-out with alpha | MIT |
| `sam3-matte` | `utility_video_segment_sam3` | clip + subject name → tracked matte video (luma) | SAM License (Meta) |
| `sam3-reframe` | `utility_video_segment_sam3` | clip + subject name → a small mask per frame, for the auto crop | SAM License (Meta) |
| `vace-reframe` | `video_wan_vace_outpainting` | clip in a new aspect → the space around it generated (VACE 14B, 720p) | Apache-2.0 |
| `vace-reframe-draft` | `video_wan_vace_outpainting` | the same on the 1.3B model, 480p | Apache-2.0 |
| `qwen-edit` | `image_qwen_image_edit_2511_int8` | image + prompt → edited image (PhotoCraft selections) | Apache-2.0 |
| `seedvr2-upscale-image` | `utility_seedvr2_3b_int8_upscale_image` | image restoration upscale | Apache-2.0 |
| `interp-rife` | `utility_video_frame_interpolation` | frames in between (×2, ×4), RIFE VFI in place of the template's interpolator | MIT |
| `interp-film` | `utility_video_frame_interpolation` | the same, the template as it ships (core nodes, FILM) | Apache-2.0 |
| `h3-flf` | `video_minimax_h3_i2v` | first + last frame → video with sound (Featured) | MiniMax H3 open weights; commercial use of local outputs needs MiniMax's licence |
| `wan22-flf` | `video_wan2_2_14B_flf2v` | first + last frame → video (Featured) | Apache-2.0 |

What the build changes, per template: the BiRefNet preview becomes a save; the SAM 3 per-frame detection becomes the
core tracking nodes (`SAM3_VideoTrack` + `SAM3_TrackToMask`) and a save; the VACE graphs cut the clip to one run,
scale and crop it before the padding and swap the template's CausVid LoRA (CC BY-NC 4.0) for lightx2v's Apache-2.0
4-step LoRA (14B) or drop it (1.3B); `interp-rife` puts RIFE VFI (`ComfyUI-Frame-Interpolation`, checkpoint
`rife47.pth`) in place of FrameInterpolate; `h3-flf` wires a second image to the node's `last_frame` and drops the
turbo-LoRA branch (off in the template); `ltx25-extend` replaces the first-frame image with the source's last frames
(LoadVideo → GetVideoComponents → ImageFromBatch → the template's resize, stretched rather than centre-cropped so the
result can be laid back at the source's size, → LTXVPreprocess → LTXVAddGuide at frame 0, strength 1) and removes the
last-frame guide; `describe-clip` feeds a few frames instead of one image. A clip longer than one VACE run (125 frames)
goes in runs that each start from the last 8 frames the one before made, joined in ComfyUI. GIMM-VFI was an
interpolation engine until 25 Oct 2026; its S-Lab License 1.0 is non-commercial, so it is no longer shipped.

Each `workflows/<id>.json` manifest names the node fields the host fills in, the model files with their download URLs,
and the licence. If your ComfyUI has another precision of the same weights, JustAE Flow uses it and says so on the card.
The in-app list downloads only these files, from these URLs (a `blob/` page URL is fetched through its `resolve/`
form, the same file); their sizes, sha256 and gating come from the Hugging Face API (`/api/models/<repo>?blobs=true`,
public, read once a week). Downloads go only into the folder you set in *Settings ▸ Resources*, never anywhere else.

```bash
npm run verify:workflows -- http://127.0.0.1:8188   # what your server can run, and the URLs of what is missing
```

The LTX finishing tools need, besides, the ComfyUI-LTXVideo node pack and the Lightricks IC-LoRAs: see *LTX finishing ▸
What you need on the ComfyUI* (`npm run verify:finishing http://127.0.0.1:8188` lists what is there).

## Resources and credits

**Settings ▸ Resources** lists the places a workflow can run. Everything there is kept by the server in your user
folder — the registry in `resources.json`, the platform API key in `comfy-api-key.txt`, the proxy's token in
`comfy-proxy-token.txt` — never in the project, the repository or the window's storage.

| Resource | Address | Protocol, key | Cost |
|---|---|---|---|
| **Local ComfyUI** | `http://127.0.0.1:8188` | ComfyUI's own HTTP + WebSocket protocol; no key | your GPU |
| **Comfy Cloud** | `https://cloud.comfy.org` | Comfy API v2 for jobs (`Authorization: Bearer`); the v1 Cloud API (`X-API-Key`) for the node catalogue, the model folders and the billing report | credits for GPU time |
| **Deployment** | `https://<deployment>.run.comfy.app` — `comfy deploy status` prints it | Comfy API v2, the same key | credits per second of GPU while a worker runs |
| **Your ComfyUI via [`comfy-api-proxy`](https://docs.comfy.org/development/comfyui-server/api-proxy)** | `http://127.0.0.1:8189` | Comfy API v2; none, or the proxy's `--token` | your GPU |

The key goes over https only, or over plain http to this machine. Running jobs on Comfy Cloud by API needs a paid
Cloud plan (*v1 Cloud API Overview*, "Subscription required"): measured on 25 Oct 2026, a free-tier key reads
billing, nodes and models but every submit is refused with 403 "API key authentication is not available for free tier
accounts". JustAE Flow shows those words, offers to run locally, and stops routing jobs to Cloud until the key changes
or **Check** is pressed. Comfy API v2 runs on the server through the official SDK (`@comfyorg/sdk` 0.5.0): inputs go up
as assets addressed by their blake3 hash, each Generate is one submission under one `Idempotency-Key` (a 429 — queue
full, or a deployment starting a worker — is retried under the same key for up to 10 minutes), the job is polled every
2 seconds, outputs come down through the server.

**Where each task runs.** A table on the same page sets, per task, Local, Cloud, a deployment, the proxy or **Auto**
(defaults: video Auto, image Local, generative reframe Cloud, reframe draft Local, upscale Cloud, matte Local, slow
motion / fps Local, restyle Auto). Auto is Local when the local ComfyUI has the workflow's nodes and models, else the
first other resource that has them; a row on a resource that is not set up falls back to Auto, so without a key
everything stays local. The resource on a **Generate** button overrides the table; each `job.json` records the
resource, why it was chosen, the execution time and the derived credits. What a resource can run is probed and kept
ten minutes: the local ComfyUI's `/api/object_info`; on Comfy Cloud the v1 `/api/object_info` and
`/api/experiment/models/{folder}`. A deployment and the proxy have no node catalogue on v2, so they are "unknown until
a workflow has finished there" (a proxy in front of the local ComfyUI is judged by that ComfyUI). On Comfy Cloud a
platform key reads the service, the node catalogue, the model folders and the billing report, while job submission
needs a paid Cloud plan. Every feature was tested end to end on a local RTX 5080 16 GB, through `comfy-api-proxy` and on
an RTX PRO 6000 deployment.

**Credits, and the billing lag.** When the resource of the next Generate bills, the header shows the account's
balance, read from the v1 billing report `GET /api/billing/usage/timeseries` (`summary.balance`, in **cents** despite
the `_micros` suffix, converted at 211 credits = 1 $; openapi-cloud.yaml and comfy.org/cloud/pricing). That report is
drawn from invoices, not live usage: the balance always carries the time it was read, is read again after every job
on Cloud or a deployment, and when it has not moved yet the window says so. It is cached five minutes.

**Estimates and costs are derived, never stated.** No endpoint returns a job's price (the v2 job carries
`metrics.execution_ms`; SDK `types.gen.d.ts`). So, under every Generate button:

- after a run: execution time × the GPU's rate — Comfy Cloud runs on the RTX PRO 6000, **736.39 credits per GPU hour**;
  a deployment bills at the rate of its GPU: RTX PRO 6000 736.39, H100 1,314.53, H200 1,626.81, B200 2,369.53
  credits/h (comfy.org/cloud/pricing, read 25 Oct 2026) — set in its card — plus what its worker bills around the job
  (below);
- before a run: the fastest and slowest earlier runs of the same workflow on the same resource and GPU, scaled by the
  slot for video, always with "≈" and its basis ("based on 3 runs on RTX PRO 6000"), or the rate alone when there is
  none ("first run: 12.3 cr/min"). A slot longer than any run on record is flagged. When the balance is under twice
  the estimate, a yellow line offers to switch to Local; a `402 insufficient_credits` ends the job with the same offer.

**A deployment's worker bills around the job.** On a scale-to-zero deployment (`--min 0`) the billed GPU time includes
the worker's start-up and model loading, and a 30-second idle window after the job, none of which is in the job's own
timestamps (`started_at` → `completed_at`). On 25 Oct 2026 two cold jobs on an RTX PRO 6000 deployment with 55 GB of
models were billed about twice their execution time, about 265 s more each, while a job cancelled before it started
cost nothing. So the estimate and the derived cost add a start-up allowance when the worker would be cold — default
265 s, idle window included, adjustable per deployment in Settings ▸ Resources — only the idle window when a job ended
there in the last minute, and nothing with `--min 1` or more (that worker bills continuously instead; its card says
how much a day). The hourly billing report lags behind: once it has the hour, each run gets its share of that hour's GPU
amount, pro rata to its derived cost, and History and the result cards show "billed ≈ … cr (hourly report)" in place of
the derived figure.

The run history the estimates come from is `runs.json`, in the same user folder; the billed figures go there too.

### Your own deployment

A deployment bills while a worker runs, not per job: deployed with `--min 0` it scales to zero between jobs (the next
job waits for a worker, and its start-up is billed: see [Resources and credits](#resources-and-credits)); with
`--min 1` a worker stays up and bills while idle — its card says how much a day. A generic recipe with comfy-cli
(docs.comfy.org, *Comfy API Quickstart*; comfy-cli's `comfy-build` and `comfy-deploy` skills):

```bash
pip install -U comfy-cli
comfy build init <dir> --name <name> --models-dir <ComfyUI>/models --custom-nodes-dir <ComfyUI>/custom_nodes
comfy build push
comfy build release create --target linux/nvidia --watch
comfy deploy refs compute          # GPU classes, regions, credits per hour, storage per GB-month
comfy deploy up <dir> --gpu <class> --region <region> --min 0 --max 1 --watch
comfy deploy status <dir>          # its endpoint: Settings ▸ Resources ▸ Add a deployment
comfy deploy stop <dir>            # ends the charge; keeps the endpoint and the staged models
```

Put in the Build only what the heavy tasks need: the models a bundled workflow names are in its manifest
(`workflows/<id>.json` → `models`, each with the URL its template downloads it from) — for example `vace-reframe` and
`seedvr2-upscale`, whose nodes are all core ComfyUI. Costs, as `comfy deploy refs compute` listed them on 25 Oct 2026
(comfy-cli 1.23.0): the GPU per hour while a worker runs (RTX PRO 6000 736.39 credits/h) and network storage for the
staged models at **42.2 credits (0.20 $) per GB per month** — the deployment's card shows it per hour (how storage is
billed in detail: to be verified). JustAE
Flow never builds, releases, deploys, starts, scales or stops anything on the platform: it talks to an endpoint you
already have. On v2 workflows go in API format, there are no live previews, and a deployment has only the nodes and
models of its build. To try v2 for free, run `pip install comfy-api-proxy` and `comfy-api-proxy` next to your ComfyUI.
`npm run probe:cloud` asks Comfy Cloud what it offers this account — read-only, no job, no credit.

A ComfyUI behind a router that asks for a bearer token (for example one you host yourself) also works as the *Local*
address: put its address in **Settings ▸ ComfyUI address** and its token in **Access token** (sent as
`Authorization: Bearer …`, and as `token=` on the WebSocket); a router's GPU menu (`/manager/monitor/pricing`) shows
up in **GPU for jobs**. Describe the clip is not offered on such an address: it runs only on this machine.

## Using it

The Flow window's tabs, then the Comp tab's tools and the LTX finishing cards.

### The tabs

| Tab | What you do in EffectCraft | What Flow does |
|---|---|---|
| **Workflow** | — | *Get started* when it is needed; *Running on* (the Generate button's resource) and the *Featured* workflows in two groups, *Generate* and *Edit & finish*, one status each; then one row for *Your ComfyUI workflows* (searchable; each graph is read and becomes a form, the comp fills size, length and frame rate; *Import file…*, *Refresh*, and the draft / final presets of a production's stages inside) and one for the editor (*Edit in ComfyUI* opens it on the selected workflow; Ctrl+S there saves back to the same file). The draft canvas and the delivery profile are in *Settings ▸ On the timeline* |
| **Marker** | add comp markers in **pairs** around each gap to fill | one shot per pair, in time order; the clip comes out exactly as long as the gap. Or one clip at the playhead |
| **Storyboard** | block the cut out with **adjustment layers** (eye on) | one shot per placeholder: its in and out points are the slot, its label colour comes back on the generated clip, its eye is switched off once the clip is placed |
| **Comp** | open the comp; set a work area or pick a layer if you want | tools on the comp as a whole — see [The Comp tab](#the-comp-tab) |

Every shot row has its own workflow, prompt and inputs (a frame or the work area from the comp, an attached file).
Shots run in series with live progress and previews; each generation gets its own folder next to the project
(`<Project>_JustAE-Flow/<Comp>/shot_001_…/`) with its inputs, output, the workflow that ran and a `job.json` of every
value used. *Save setup / Load setup* keep a shot list as a file; the history lists every run. Using the storyboard:

1. Open a composition. For **Marker**, add markers in pairs around each gap (or *+ Marker pair* in the panel); for
   **Storyboard**, add adjustment layers (*+ Placeholder*), move and trim them.
2. Pick a workflow in the **Workflow** tab — or per shot, in its row.
3. Open a row: the prompt and that workflow's inputs. Fields the comp can fill say *from comp*.
4. **Generate clip** runs the ticked shots in series and places each clip at its slot, in the comp that was open when
   you pressed it.

The panel's **layer tools** work on the selected clip: Cut out a subject (SAM 3, a luma track matte), Reframe
(generate the new space, Wan VACE 14B or the 1.3B draft), Auto crop (SAM 3, Position keyframes that follow the
subject), Upscale ×2 (SeedVR2, laid exactly over the source, which is switched off — not deleted).

### Featured workflows

At the top of the Workflow tab, under *Running on*, in two groups: **Generate** — Z-Image-Turbo (text → image), LTX-2.5
image → video and text → video, MiniMax H3 first + last frame, Wan 2.2 first + last frame — and **Edit & finish** —
Qwen-Image-Edit 2511, SeedVR2 ×2, SAM 3 subject matte, LTX Refine. Each card is one line: the name, what it does, one
status for the resource *Running on* names — **Ready** (every node and model is there, by its probe; on a deployment,
once a run of it finished there), **Missing 2 models · 28.6 GB** (your ComfyUI lacks files: *Get them*), **Needs the
ComfyUI-LTXVideo pack** (custom nodes to install with ComfyUI Manager), **Not on this resource** (Comfy Cloud lacks it,
the resource refuses jobs, or LTX finishing away from your ComfyUI), **Unknown here** (a deployment that never ran it:
v2 has no node list) — and *Use it*, which makes it the workflow of the Marker and Storyboard tabs (with your ComfyUI's
precisions swapped in, e.g. LTX int8 → nvfp4); LTX Refine's opens *Comp ▸ Upscale ▸ LTX Refine*. Behind ▸: the status
on every resource, the files with their sizes and sources, the node packs, and the licence in one line with its link.
MiniMax H3 has *Draft / Final* on its line: *Draft* is its own workflow, the 4-step turbo LoRA the official template
names (`h3-flf-draft`, 4 steps — a quick look, never the final); *Final* is the base model, 20 steps, then a second job
on its result: **+ SeedVR2 ×2** (on the same resource, original colours kept) or **+ LTX Refine** (to Full HD on the
local ComfyUI, with a PNG 16-bit master beside the draft — see *LTX finishing*); its licence line: commercial use of
locally generated outputs needs a MiniMax commercial licence; in the EU: to be verified.

### The Comp tab

The Storyboard makes things *inside* a comp; the Comp tab transforms the comp itself — or its work area, or a layer —
into something new beside it. Nothing in your comp is changed or deleted: a result is a new comp ("*&lt;Comp&gt;* ·
9:16") or a layer above, the original kept.

**Source**: *Work area* (the default when one is set), *Whole comp*, or *Layer*. The work area and the whole comp are
rendered by EffectCraft when the run starts (its render queue, ProRes 422 HQ, never longer than *Settings ▸
Work-area render cap*, default 8 s) into the run's folder and imported, so the result stands on exactly what the
model saw. *Layer* uses the layer's own file: the layer picked when you click the chip, which stays the source while
EffectCraft selects other layers (it selects every result it places); a different selection is offered, never taken.

| Tool | What it runs | What it makes |
|---|---|---|
| **Reframe** — 9:16 · 4:5 · 1:1 · 16:9 · 21:9 · 4:3, *Draft* / *Final* | Wan 2.1 VACE outpainting (`vace-reframe-draft` 1.3B / `vace-reframe` 14B) | a new comp at the delivery size: the generated video fills it, your render or clip on top, untouched, with a soft edge. *Advanced ▸ Crop with tracking* runs the SAM 3 auto crop instead |
| **Upscale** — *Engine*: SeedVR2 (×2, ×4, *Keep original colours*) or **LTX Refine** (Full HD, 4K, 8K, Same size — see *LTX finishing*) | SeedVR2 3B (`seedvr2-upscale`); ×4 is two ×2 passes. LTX Refine: LTX-2.5 + Refine Details, Tiled Fusion (`ltx25-refine`) | a new comp at the target size (stated before the run), your original under it, switched off. 8-bit H.264 (EffectCraft 0.11.1 decodes no other H.264). *Keep original colours* (default) sets SeedVR2's own colour correction to `wavelet` |
| **Cut-out** — *Engine*: SAM 3 or **LTX Alpha** | SAM 3 tracking (`sam3-matte`), the subject named in a word; LTX Alpha: LTX-2.5 + Alpha Gen, no prompt, soft edges (`ltx25-alpha`) | from a layer: a matte above it, set as its luma track matte; from the comp: a new comp with the render and its matte. **Export with alpha** writes a ProRes 4444 `.mov` with ffmpeg |
| **Extend** — +2, 4 or 5 s, "What happens next" | LTX-2.5 with a **video guide** (`ltx25-extend`, from the official template `video_ltx2_5_flf2v`): the source's last 17 frames (0.7 s at 24 fps; 9 when the source is shorter) go in through the core `LTXVAddGuide` at frame 0 of the new clip, and `LTXVCropGuides` takes them off the latent before decoding. From a still (or fewer than 9 frames): LTX-2.5 image-to-video from the last frame (`ltx25-i2v`) | a new layer at the source's out point, above it, at the source's size and frame rate, with its own sound; the card says "continues the last 0.7 s of motion". The model makes guide + 8k new frames (17 + 48 = 65 for 2 s at 24 fps); the guide frames come back first and are trimmed off. A comp too short to hold it is lengthened. Nothing is rendered: the render cap does not apply |
| **Slow motion / fps** — ×2 slow, ×4 slow, *fps → 2 × fps* | `utility_video_frame_interpolation`: RIFE (`interp-rife`, default, MIT) or FILM (`interp-film`, the template as it ships, Apache-2.0) | a new comp: slow motion at the source's rate, (n − 1) × k + 1 frames, the sound left out; or twice the rate for the same length, the sound kept. Your original in it, switched off |
| **Social pack** — any of the six formats, *Draft / Final*, *+ Upscale ×2*, *Masters* | the Reframe of each format in the queue; then, if asked, SeedVR2 ×2 of each result and a master of each last comp | one comp per format (and its ×2 comp); a master per format next to the project (EffectCraft renders ProRes 422 HQ, ffmpeg writes ProRes 4444 or a PNG 16-bit sequence). *Results* shows the pack together |

**Describe the clip** (next to the prompt of Extend, Reframe and Social pack): four frames of the source — the last
3 s for Extend, the whole span for a scene — go to **Qwen3-VL-4B** on your **local** ComfyUI (`describe-clip`, from the
official template `llm_qwen3vl_text_gen`, core `TextGenerate`), which writes what it sees into the prompt for you to
edit (*undo* puts your text back). It is offered only when the model file is on the local ComfyUI and that ComfyUI is
on this machine; nothing leaves it. The frames, the instruction and the answer are kept in `<media>/_describe/`.

Sizes per format — the generation frame follows one rule (`core/reframe/outpaint.ts`, `vaceGenSize`): Wan 2.1's own
frame where the format is its own, otherwise the size with exactly that aspect, both sides multiples of 16, whose
pixel count is nearest to that frame's. The delivery comp is 1080 px on its short side. The model is shown the clip
less a margin where it meets new space (1.5 × the soft edge + 16 px: on the 9:16 draft of 28 Oct the model's bright
line at its edge filled a whole latent row and spilled past it), so whatever it draws at its own edge lies under the
opaque original. The model also gives the clip back a little brighter and more contrasted than it is (measured on the
9:16 Final of 28 Oct: about 4 levels and 5 % on every channel), and the new space around carries the same shift: the
generated video is matched to your clip before it goes into the comp — a gain and an offset per channel that give
the model's copy of the clip your clip's mean and spread (ffmpeg; `<name>_as-generated.mp4` beside it is the model's
own file, and the job's `.job.json` has the values under `colour`).

| Format | Final (14B) | Draft (1.3B) | Comp |
|---|---|---|---|
| 9:16 | 720×1280 | 480×832 | 1080×1920 |
| 4:5 | 832×1040 | 576×720 | 1080×1350 |
| 1:1 | 960×960 | 624×624 | 1080×1080 |
| 16:9 | 1280×720 | 832×480 | 1920×1080 |
| 21:9 (7:3) | 1456×624 | 1008×432 | 2520×1080 |
| 4:3 | 1088×816 | 704×528 | 1440×1080 |

Each card shows the comp's own frame at the playhead next to what it will make, says what the run will make before it
runs, and has the resource chooser and the estimate of the other tabs: each tool routes by its row of *Settings ▸
Resources* (Reframe → *Generative reframe* / *Reframe draft*, Upscale → *Upscale*, Cut-out → *Cut-out / matte*,
Extend → *Generate video*, Slow motion → *Slow motion / fps*, the LTX finishing tools and engines → *LTX finishing*, Local),
and a pick on the card holds for that tool. Technical
choices (seed, crop mode, colour correction) are under *Advanced*, with the workflow and the template it comes from.

**Results** lists the comp's runs: running ones with their phase, a bar and *Cancel*; finished ones with their time,
the credits derived from it where the resource bills, *Open comp*, *Compare* (original ⇄ result by hiding and showing
layers; nothing is deleted) and the versions — the same tool on the same source again makes the next version. Runs
go through one queue, one at a time. **A queued run does not take your comp away**: EffectCraft renders and places
only in the active comp, so a run opens its comp while it works; when it ends, its result stays in front only if you
were on the comp it started from — otherwise the comp you were on comes back and *Results* offers *Open comp*.

Keys: **G** runs the open card, **Esc** cancels the running run, **Tab** compares the last result. Files: everything a
run makes goes into `<project>.justae-flow/<run id>/` next to the `.ecproj` — the render, the result, a picture of
it, the exact graph submitted (`submitted_<time>.api.json`) and the `job.json` (tool, source, sizes, resource, times,
seed, model swaps; for Extend the guide frames and the frames that came back).

### LTX finishing

LTX-2.5 with the IC-LoRAs of Lightricks' **LTX-2.5 Creative Lab** (Hugging Face), in the Comp tab: a second engine on
*Upscale* and on *Cut-out*, and an **LTX finishing** family of cards after the other tools. Each tool is offered only
where its model card documents how the LoRA is driven (input, prompt, strength, extra files, output), read on 25 Oct
2026; a card whose LoRA is not on your local ComfyUI is greyed, with the file and its (gated) Hugging Face page.

| Card | IC-LoRA (strength) | How it runs | What it makes |
|---|---|---|---|
| **Upscale ▸ LTX Refine** — *Full HD · 4K · 8K · Same size*, *Fast scene*, *Master* | Refine Details 1.0 | Tiled Fusion (`LTXVTiledFusionSampler`): one latent canvas, overlapping tiles fused every step, wired as the official `LTX-2.5_V2V_TiledFusion_Upscale` workflow — canvas, tiles and windows from the pack's `LTXVGetTilingSizes` | a new comp at the delivery size, the original under it switched off; the master next to the project |
| **Archive restore** — *Restore · + Refine 30 % · Restore → Refine ×2* | Restore 1.0 (+ Refine Details 0.3 in the same pass) | Tiled Fusion on the pack's Full HD canvas with its qHD tiles (960×544 on 16:9, the Restore card's tile); *Restore → Refine ×2* then Refine on the pack's 4K canvas (twice its Full HD) | the same; Restore also colours monochrome and tinted sources from their content (its card) |
| **Deblur** | Deblur 0.9 file, strength 1.0 | one pass, the official `LTX-2.5_V2V_ICLoRA_Single_Stage_Distilled` chain (CFGGuider 1, euler_ancestral, 8 distilled sigmas, `LTXVCropGuides`), at the source size up to 1920×1088 | the same; defocus only (not motion blur) |
| **De-compression** | Decompression 0.9, 1.0 | the same chain, near the card's 960×544 size by default | compression artefacts removed |
| **Colorize** | Colorization 0.9, 1.0 | the same chain, near 960×544; *Scene* + *Colours* fill the card's `COLORIZE` sentence | natural colour for black-and-white footage |
| **Clean plate** | Clean Plate 1.0, 1.0 | the same chain at the source size; *The empty place* + *Also remove* fill the card's sentence and negative | the background without people and vehicles |
| **Day → Night** | Day-To-Night 0.9, 1.0 | the same chain near the card's 768×448 size | the same shot at night |
| **Cut-out ▸ LTX Alpha** | Alpha Gen 0.9, 1.0, empty prompt | the same chain at the source size (≤ 1920×1088, ≤ 145 frames) | a soft luma matte (white = foreground), set as the layer's luma track matte like SAM 3's; *Export with alpha* works the same |
| **SDR → HDR** | SDR-To-HDR 1.0 + its scene embedding, no prompt | one pass, the chain of the official `LTX-2.5_ICLoRA_SDR_to_HDR_Distilled` workflow its card names for ComfyUI: ACEScct input transform, the scene embedding as the conditioning, float32 decode, `LTXVHDRDecodePostprocess` | an EXR sequence in ACEScg (scene-linear, half float) and an HLG BT.2020 10-bit video next to the project; the comp shows an 8-bit tonemapped preview |

Run on this machine with their own IC-LoRA: Refine (preview tile and Full HD), Restore, LTX Alpha (2 s at 1280×704 in
1:16: a clean white matte of the boat and its sail — and of its reflection in the water), De-compression (once, on a
test pattern) and SDR → HDR (2 s at 1280×704 in 1:52; sky values up to about 10 in the EXR). Deblur, Colorize, Clean plate and Day → Night: their graphs are checked against the local ComfyUI and the
single-pass chain they share has run, but not with their own LoRA.

**The five rules, built into the cards:**

1. **8K goes through 4K.** *8K* is always Refine to 4K, lanczos ×2, then a light 2-step refine of the 8K canvas from the
   encoded image — never 8K in one pass (the Refine card: "8K in one pass invents detail"). The card says so.
2. **Archive: Restore first, then Refine.** *Restore → Refine ×2* orders the passes itself; *+ Refine 30 %* puts both
   LoRAs in one pass (the Restore card allows 0.2–0.3: faster, colour best sequential).
3. **Fast scene** ×2 / ×3: every frame repeated before the model and the copies removed after (JustAE Flow 2 verified
   the frame order ×1–×4; here ×2 and ×3 again, PSNR of each returned frame against its own source).
4. **The prompt is a "Look"** — sharpness, grain, light — **not the subjects**: every tile of a tiled pass receives the
   whole prompt, and a subject named in it can be painted into tiles that do not contain it. The field is optional
   (empty = the card's own generic look); a simple check warns when it names a subject: people, animals, vehicles and
   objects by name, and any word after "a", "the", "two"… that is not a rendering term. It can miss a subject or flag a
   harmless word, and says so. (The single-pass cards are not tiled: their cards *ask* for the scene, in a sentence
   they were trained on, which the card fills in.)
5. **Delivery: a 16-bit master.** PNG 16-bit by default, or EXR 16-bit float; the comp shows an 8-bit H.264 MP4 of the
   same frames (EffectCraft 0.11.1 decodes 8-bit H.264 only) — a preview, never the delivery.

**Sizes and frames come from the LTX pack itself.** Every tiled graph carries the pack's `LTXVGetTilingSizes` node,
wired as its official workflows wire it: it sets the canvas, the tile, the overlap and the temporal window the sampler
uses. JustAE Flow chooses what to ask — the output size, and the pack's **qHD** tile (the nearest of its three tile
sizes to the windows the IC-LoRAs were trained on) — and adds the cards' frames rule and the delivery at the source's
aspect. Before a run the server asks the local ComfyUI for that node's answer (a one-node prompt, cached), so the card
shows the pack's output size and tiles; when the ComfyUI cannot be asked (off, or busy with a long job) the card says
*Sizes from the LTX pack at run time*.

| | |
|---|---|
| Canvas | the pack's: Full HD = 1920 on the long edge, 4K twice that, 8K four times; multiples of 32; delivered at the source's aspect inside it (lanczos): 1920×1088 → 1920×1080, 1344×768 → 1920×1088 → 1904×1088 |
| Tiles | the pack's qHD tile (960×544 on a 16:9 frame; it follows the frame's aspect), its overlap 0.5; blend 0.05, cfg 1, euler, the 8 distilled sigmas (the cards) |
| Tiles per step, from 1920×1080 | Full HD 3×3 = 9 · 4K 7×7 = 49 · 8K 15×15 = 225 |
| Frames | 8n+1, at least 8 copies of the last frame added and cut after (the last frames of an LTX generation lose detail); the pack's window: 97 frames, or the whole clip up to 121 |
| Time | runs measured here, times a tile count made from the pack's tile size and overlap (an approximation: on 53 answers of the pack it matched its grid 49 times, one row over 4 times) |
| Decode | `VAEDecodeTiled` 1024 / 128 / 256 / 32 (the Refine card), or 512 / 64 / 128 / 32 (the official workflows' lower-VRAM setting) on 16 GB |
| Single-pass sizes | Deblur and Clean plate: the source, up to 1920×1088; De-compression and Colorize: shorter side 544; Day → Night: shorter side 448; Alpha and SDR → HDR: the source |

Every card says, before it runs, the pack's sizes and tiles, the frames, and **how long it should take on this
machine**, from the tile count and runs measured here (an RTX 5080 16 GB, the number says so).

**Measured on the RTX 5080 16 GB** (ComfyUI 0.38.0, NVFP4 transformer, Gemma-4 int8, DiffVAE bf16; 25–26 Oct 2026):

| Run (Comp tab, Local) | Source → output | Plan | Execution | Shown before |
|---|---|---|---|---|
| LTX Refine, preview tile | 1280×704 clip, first 41 frames → one 1024×576 tile | 1 tile, 41 → 49 frames, 8 steps | 2:05 (cold) | ≈ 2 min |
| **LTX Refine → Full HD** | 1280×704, 121 frames → 1920×1056, 121 PNG 16-bit (578 MB) + MP4 | 9 tiles, 121 → 129 frames, 2 windows of 97, 144 tile-steps | **14:33** — sampling 11:12, decode 0:46, save 1:51 | ≈ 17 min |
| the same, with the Refine card's decode (1024 / 128 / 256) | same | same | 41:09 — the decode alone 27:11, GPU memory full | ≈ 23 min |
| Archive restore (Restore) | 872×480, H.264 CRF 44, 49 frames → 1920×1056 | 9 tiles of 960×544, 49 → 57 frames, 72 tile-steps | 4:56 | ≈ 8 min |
| De-compression (verify-finishing-run, a test pattern) | 1920×1080, 41 frames → 968×544 | one pass at 960×544, 41 → 49 frames | 1:44 (cold) | — |
| *for comparison:* SeedVR2 ×2 | 1280×704, 121 frames → 2560×1408 | — | 14:44 | — |
| Cut-out ▸ LTX Alpha | 1280×704, 49 frames → a luma matte | one pass at the source size, 49 → 57 frames | 1:16 | ≈ 2 min |
| LTX Refine → Full HD, sizes from the pack (26 Oct) | 1280×704, 49 frames → 1920×1056, 49 PNG 16-bit + MP4 | the pack's 3×3 tiles of 960×544, 49 → 57 frames, one window | 5:42 | ≈ 6 min |
| SDR → HDR | 1280×704, 49 frames → 49 EXR (ACEScg) + HLG video + preview | one pass at the source size, 49 → 57 frames | 1:52 | ≈ 2 min |
| MiniMax H3 *Draft* (4-step turbo), then *+ LTX Refine* (`scripts/verify-h3-chain.ts`: the Featured graphs and `/api/finishing/graph`) | two generated stills → 1344×768, 124 frames → 1890×1080, 124 PNG 16-bit + MP4 | Draft 4 steps; Refine 9 tiles, 124 → 137 frames, 2 windows of 97, 144 tile-steps | Draft 3:57 · Refine 14:48 | Refine ≈ 15 min |

On a card of 16 GB or less the tiled runs decode with the official workflows' low-VRAM tiles (512 / 64 / 128 / 32, their
setting for lower-VRAM machines) instead of the Refine card's 1024 / 128 / 256, which filled the RTX 5080's
memory and took 27 min to decode the Full HD clip above; the two decodes of the same run (same seed) are 35 dB apart,
with no seams. A preview tile keeps the card's decode. Lightricks state a 32 GB minimum for LTX-2.5; with the NVFP4
transformer these runs fit 16 GB. Above Full HD the card warns that it takes hours (4K of a 5 s 720p clip: ≈ 1 h 13 min
by the estimate); 4K and 8K are planned and their graphs validated against the local ComfyUI, not run here.

**A/B on the same 5 s generated clip** (fine detail = std of the luma Laplacian at 1920×1056, colour = mean ΔE76
against the source after a σ 3 blur): SeedVR2 ×2 adds far more detail at this
size (20.4 vs the source's 8.2; sail seams, rigging, leaves — partly invented), LTX Refine to Full HD a little (10.1) and
stays soft; both keep the colours (ΔE 1.3 and 1.6; LTX slightly brighter and ~4 % less saturated, as its card says).
LTX Refine is meant to reach 4K from a ~1080p source (its card: "4K output is the sweet spot"), where each tile sees the
content at the scale it was trained on — not run here. Archive restore on a 480p, CRF 44 copy rebuilt clean detail but
re-imagined the light and colour of a colour source (dawn mist → daylight, a yellow hull, a number on the sail): it is
for archive footage, as its card says.

**Where it runs.** On your local ComfyUI only (the row *Settings ▸ Resources ▸ LTX finishing*, Local by default): a
resource JustAE Flow knows no LTX-2.5 model on — your deployment was built with core nodes, Wan VACE and SeedVR2 — is
refused before anything is sent, with that reason.

**What you need on the ComfyUI:** ComfyUI-LTXVideo 1.1.0 (`LTXVGetTilingSizes`, `LTXVTiledFusionSampler`,
`LTXAddVideoICLoRAGuide`, `LTXICLoRALoaderModelOnly`; for SDR → HDR also `LTXVLoadConditioning`, `LTXVVAEForceFloat32`,
`LTXVHDRDecodePostprocess`), VideoHelperSuite; the LTX-2.5 distilled transformer (NVFP4 or int8 on 16 GB), the Gemma-4
12B text encoder for LTX-2.5, the LTX-2.5 video VAE (`Lightricks/LTX-2.5`); and each IC-LoRA from its repo
(`Lightricks/LTX-2.5-22b-IC-LoRA-<Name>`) — gated: open the page, press "Agree and Access", put the file in
`models/loras` (sub-folders are fine) — except the SDR → HDR scene embedding
(`ltx-2.5-22b-ic-lora-sdr-to-hdr-scene-emb.safetensors`), which goes in `models/embeddings`, where its loader reads. `npm run verify:finishing http://127.0.0.1:8188` lists what is there and checks
every graph against the server, read-only.

**Files.** In `<project>.justae-flow/<run id>/`: the MP4 preview (`<name>_v001.mp4`), the master
(`<name>_v001_png16/<name>_v001_00000.png`… or `_exr16/`), the graph submitted, and the `job.json` with the plan (passes,
canvases, tiles, frames, tile-steps), the files and prompts used, the seed, the estimate and its basis, the time it
took, and the lowest free VRAM seen while it ran. *Reveal PNG 16-bit* in Results opens the folder.

**EXR** is written by `SaveImageAdvanced` as 16-bit float, scene-linear (the sRGB frames linearised, Rec.709
primaries); SDR → HDR writes ACEScg through the pack's own node. EffectCraft 0.11.1 imports an EXR sequence (checked on
26 Oct with the SDR → HDR frames) but not as scene-linear: it shows it as sRGB in an 8 bpc project, highlights above 1.0
clipped, at 30 fps until reinterpreted — the comp keeps the MP4 preview, the EXR is for a colour-managed grade.

**MiniMax H3 ▸ Final ▸ + LTX Refine** (Featured): the base-model H3 clip, then LTX Refine to Full HD on it as a second
job on the local ComfyUI — the pipeline Matt Hallett shows in "LTX Refine & Restore with Native Resolution" (generate
low, refine to 4K; here Full HD, 4K from the Comp tab). The PNG 16-bit master is written beside the draft. *Draft* is
the 4-step turbo LoRA the official template names (`minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16`, from
Comfy-Org/MiniMax-H3; the local file has the same sha256), 4 steps — never Final.

**Licence.** The LTX finishing tools need the ComfyUI-LTXVideo node pack and the Lightricks IC-LoRAs, installed by you
in your ComfyUI — not included here, see their own licences: [ComfyUI-LTXVideo](https://github.com/Lightricks/ComfyUI-LTXVideo),
[LTX-2.x Community License](https://github.com/Lightricks/LTX-2/blob/main/LICENSE-2_x).

## How it works

```
 EffectCraft ──(control channel, JSON lines, 127.0.0.1:9877)──┐
   └ JustAE Flow panel (ScriptUI) ──(HTTP)──┐                 │
                                            │                 │
                         JustAE Flow server (Node, 127.0.0.1:5199)
                         · host bridge: Flow 2's host functions run inside EffectCraft (script.run)
                         · files, HTTP and WebSocket relays for the Flow window (session token)
                         · layer tools, the Comp tab and the PhotoCraft storyboard: engine, queue, versions
                                                               │
 Flow window (React, Flow 2's interface) ──(HTTP + SSE)────────┘──(HTTP/WS, SDK)── ComfyUI, Comfy Cloud, deployments
```

- **The host.** EffectCraft's scripting follows After Effects scripting, so Flow 2's host file
  (`extensions/effectcraft/flow-host.jsx`) runs inside EffectCraft through the control channel's `script.run`:
  markers, adjustment layers, import at a time with the label colour, frame capture (`saveFrameToPng`), work-area
  render, trims, the native dialogs. Differences measured on EffectCraft 0.11.1: the project name (`.ecproj`) and the
  temp folder (`Folder.temp` is null, so renders go into a folder the caller names); a render-queue value it already
  has is refused ("nothing to change"); `renderQueue.item(j)` hands out a new object each call.
- **Files** go through the server, limited to your user folder and the temp folder; **HTTP** to ComfyUI or a cloud API
  goes through a relay (no CORS, no token in a browser request); the ComfyUI **WebSocket** is relayed as server-sent
  events. Every route wants the session token the server writes into the page.
- **Lossless masters** (ProRes 4444, PNG 16-bit), Extend's guide clips and Describe's frames are made with ffmpeg.

```
client/      the Flow window (Flow 2's interface; bridge/ and lib/ are the parts that talk to the server)
extensions/  the EffectCraft panel and the host file
core/        host-independent: ComfyUI client, workflow conversion, manifests, storyboard types, reframe planning, the Comp tab tools
hosts/       one adapter per host app for the engine (effectcraft: a timeline, photocraft: a canvas)
server/      the host bridge and relays, the window dock, the engine (layer tools, Comp tab, PhotoCraft storyboard), settings, HTTP API
workflows/   bundled workflows: <id>.json manifest + <id>.api.json graph
scripts/     launch, build-workflows, verify-workflows, verify-effectcraft, selftest, scan-secrets
```

## Privacy and network

JustAE Flow listens on 127.0.0.1 only. It talks to things of your choosing: your EffectCraft or PhotoCraft (loopback)
and the resources you set up — your ComfyUI, and, once you add the key, Comfy Cloud (jobs, node catalogue, model
folders, billing report) and the deployment addresses you paste. Describe the clip talks only to a ComfyUI on this
machine. The Workflow tab reads the public Hugging Face API for the sizes, sha256 and gating of the bundled
workflows' model files (`/api/models/<repo>?blobs=true`, no account, kept a week), and downloads a model file only when
you press *Download* — from the URL its manifest gives, into the folder you set, with your Hugging Face token if you
gave one. No telemetry, no account of its own, no other network access.

## Development

```bash
npm run typecheck
npm run selftest                 # offline: fake ComfyUI + in-memory hosts, end to end (uses ffmpeg when it is on the PATH)
npm run verify:workflows         # bundled workflows against a live ComfyUI (read-only)
npm run verify:effectcraft       # the storyboard as the engine sees a live EffectCraft
npm run probe:cloud              # what Comfy Cloud offers this account (read-only, no job, no credit)
npm run workflows:build          # regenerate workflows/*.api.json from the official templates
npm run scan:secrets             # also runs as the pre-commit hook
npm run dev                      # UI dev server on :5198 (proxying the API on :5199)
```

## Limits and to be verified

- One host at a time: switch between EffectCraft and PhotoCraft in *Settings ▸ App*. A Flow window for PhotoCraft is
  not in this version (PhotoCraft has its own storyboard page).
- PhotoCraft's control channel passes no pixels in memory: images cross through files in its automation folder.
- Upscale, background removal, subject matte and reframe from a *layer* take the layer's own file; a placeholder or a
  marker cannot feed them.
- The subject matte follows the subject as SAM 3 sees it; hair and motion blur get a hard edge (refine it in
  EffectCraft, or name another subject).
- The auto crop invents no pixels; the generative reframe does, at 720p (14B) or 480p (draft), so the new space is
  softer than the clip in the middle. On a 16 GB GPU the 1.3B draft takes about 6 minutes for 125 frames at 480p, and
  the 14B *Final* minutes per sampling step; one card makes at most four runs (about 20 s at 24 fps).
- The Comp tab renders a work area or comp as ProRes 422 HQ (about 76 Mb/s at 1280×704); Comfy Cloud takes uploads
  up to 100 MiB, so a longer render is refused before it is sent there.
- EffectCraft renders and places only in the active comp: a queued run opens its comp for the time it renders and
  places, then gives the front back (see *Results*).
- Extend carries on the motion of the last 17 frames; motion that started earlier than 0.7 s before the out point is
  seen only through those frames. The frames the model gives back for the guide are not pixel-identical to yours (they
  are trimmed off); at the cut, the level of the new frames can differ slightly from the source's (measured on 25 Oct:
  about 2 levels of 255, as with the single-frame path). Measured at 24 fps; other rates use the same rule (17 + 8k).
- MiniMax H3 *Draft* is the 4-step turbo LoRA the official template names (`h3-flf-draft`), 4 steps — measured
  here on 26 Oct: 1344×768, 5 s (124 frames) in 3:57 from two generated stills; it is never used for *Final*.
- LTX finishing runs on the local ComfyUI only, and on 16 GB above Full HD it takes hours (the card estimates how
  many): 4K and 8K are planned and their graphs validated against the local ComfyUI, not run here. The single-pass
  IC-LoRAs (Deblur, De-compression, Colorize, Clean plate, Day → Night, LTX Alpha) render the whole clip as one extent:
  at the source size and past ~121 frames they are heavier than a Refine tile; De-compression and LTX Alpha were run
  here, the other four were not run with their own LoRA.
- LTX finishing's tile sizes come from the ComfyUI-LTXVideo pack's own node (Refine 960×544 at the qHD tile choice),
  while the Lightricks model cards recommend 1024×576 for Refine; results not compared — to be verified.
- LTX finishing does not deinterlace (the Restore card asks for it on interlaced sources) and does not use Restore's
  reference-image or prefix-frame options; pixel-aspect is taken as square.
- EffectCraft 0.11.1 reads an EXR master as an image sequence but not as scene-linear (sRGB, highlights clipped, 30 fps
  until reinterpreted); the comp keeps the MP4 preview.
- Upscale past 4K is not verified on a 16 GB GPU (the card says so); a Social pack's *+ Upscale ×2* makes 4K comps
  (2160×3840 for 9:16), at the edge of what was verified.
- Storyboards written under the project's former name (`*.shiftfield.json`) are still read, where they are.

**To be verified:** the layout of Comfy Desktop's shared model library (`%LOCALAPPDATA%\Comfy-Desktop\ComfyUI-Shared`:
whether its model folders sit in a `models` folder) and whether a running ComfyUI lists a file downloaded into its
models folder without a restart (not tested: the tests downloaded into a temporary folder ComfyUI does not read; the
Flow window reads `object_info` again and, when the file is not listed, says to restart ComfyUI or press Refresh in
its UI); whether the European Union is covered by MiniMax H3's licence for local outputs; the provenance of
`rife47.pth` (the node pack downloads it from mirrors) and the licence of Comfy-Org's FILM repackaging (its card says
"other"); how a deployment's network storage is billed in detail; the upload limit of a deployment; time and VRAM of a
full VACE 14B *Final* and of a full MiniMax H3 run on a 16 GB GPU; Wan 2.2 first + last frame end to end (its 14B
weights are not on the test machine); whether open weights run on Comfy Cloud count for the challenge's *Open Weights
Only*; the LTX tile on a 4:3 scan (the pack plans 960×736 tiles on 1920×1440, the Restore card 960×544 at 1440 wide).

## Licence

JustAE Flow is free software under the **GNU General Public License v3.0** ([LICENSE](../LICENSE)). Third-party material
and model licences are listed in [NOTICE](../NOTICE); model weights are not included — each manifest names the files and
where the official template downloads them. Read each licence before using outputs commercially. In short:

- **LTX-2.5** (the core video model) and its **IC-LoRAs** (LTX finishing): LTX-2.x Community License (11 Aug 2026):
  commercial use permitted for entities under USD 10M annual revenue (affiliates under common control counted together;
  clients receiving outputs are not the licensee), outputs belong to the user, machine-generated content must be
  disclosed when published — [LICENSE-2_x](https://github.com/Lightricks/LTX-2/blob/main/LICENSE-2_x).
- **SAM 3** (cut-out, auto crop): SAM License (Meta) — royalty-free, commercial use included, with trade-control and
  lawful-use terms; it is an open-weights licence of its own, not an OSI licence.
- **MiniMax H3** (Featured only): commercial use of locally generated outputs needs a MiniMax commercial licence.
- Wan 2.1 / 2.2, SeedVR2, Z-Image-Turbo, Qwen-Image-Edit, Qwen3-VL, FILM: Apache-2.0; RIFE, BiRefNet: MIT.

The name and the JustAE logo are covered by [TRADEMARKS.md](../TRADEMARKS.md), not by the code licence. EffectCraft and
PhotoCraft are products of the ArtCraft Team; JustAE Flow is independent and uses none of their marks. Higgsfield is a
trademark of its owner, named only to describe the comparison; Adobe, After Effects and Premiere Pro are trademarks of
Adobe Inc.
