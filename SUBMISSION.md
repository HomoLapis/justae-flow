# Submission — Comfy "Open Source Higgsfield" challenge

Deadline: **30 October 2026, 9:00 PT (17:00 in Italy)**. Rules page: https://comfy.org/open-source-higgsfield
(read 22 October 2026). Sign-up and submission are two separate forms on that page.

## Checklist

- [ ] Signed up (the first 200 sign-ups get Comfy credits).
- [x] Licence: GPL-3.0, full text in `LICENSE` — the rules require an open-source licence.
- [ ] Author name in `NOTICE`; name/logo wording in `TRADEMARKS.md`.
- [ ] README placeholders filled (tagline, presentation, closing link to JustAE / Homo Lapis).
- [ ] `docs/media/` screenshot or GIF; `examples/` filled with your own SFW outputs (no unlicensed IP or faces).
- [x] `npm run selftest` green (437 checks); `npm run verify:workflows` green on the demo machine except `wan22-flf`
      (its two 14B models are not downloaded there); `npm run verify:finishing http://127.0.0.1:8188` green (every LTX
      finishing graph valid against the local ComfyUI).
- [x] No code from ComfyUI-LTXVideo in the repository (26 Oct): the LTX tile sizes come from the pack's own node at run
      time; the pack and the IC-LoRAs are installed by the user, as every other model.
- [x] Clean install from zero following only the README (new folder, `npm run setup`, `npm start`, selftest) — 25 Oct.
- [ ] `npm run scan:secrets` clean; repository public.
- [ ] Demo video recorded (the page sets no length; keep it short — it is judged on the work, not the editing).
- [ ] Categories chosen in the form (see below), optional link to try it.
- [ ] Post with **#OpenSourceHiggsfield**.

Open questions to settle before submitting (not answered on the rules page):
- How many entries per person — the page does not say. This repo is one entry.
- Whether running open weights on Comfy Cloud or a Comfy API deployment counts for *Open Weights Only* — the default
  configuration runs locally.

## What is open source here

Everything in this repository is GPL-3.0: the server (engine, queue, resources, estimates), the Flow window, the
EffectCraft panel and host script, and the build that turns official ComfyUI templates into the bundled workflows.
The host is EffectCraft (MIT OR Apache-2.0); the generation runs on ComfyUI (GPL-3.0) with official templates
(comfyui-workflow-templates, MIT); the bundled models are open weights whose licences are in `NOTICE`. Nothing calls a
closed API or a partner node; the optional cloud is your own Comfy API deployment or Comfy Cloud, reached with your
own key through the official SDK. No telemetry, no account of its own.

## Categories

- **Best Overall** — the whole Higgsfield plugin workflow, open source, inside an open-source After Effects: a comp
  becomes a 9:16, a social pack, a 4K master, a cut-out with alpha, a longer shot — without leaving the timeline.
- **Most Innovative** — the reframe *generates* what Higgsfield's crops away (Wan 2.1 VACE outpainting, with the seam
  measured and fixed); Extend carries the *motion* of the last frames into the new seconds (LTX-2.5 guided by 17
  frames through `LTXVAddGuide`, measured: the camera pan goes on instead of reversing); one queue routes each task to
  the right GPU — local, your deployment, or Comfy Cloud — with an estimate and the credits derived after the run.
- **Open Weights Only** — "No partner nodes or closed-source APIs, open-weights models only." Every bundled workflow is
  an official template with open weights and no partner/API node (checked by `npm run selftest`), and the default
  configuration runs on your local ComfyUI. Caveats to state: SAM 3 (cut-out, auto crop) is under Meta's SAM License —
  open weights, royalty-free with commercial use, but a licence of its own with trade-control and lawful-use terms;
  MiniMax H3 (Featured only) needs MiniMax's commercial licence for commercial use of local outputs; the Cloud and
  deployment resources are optional.
- **Bonus: VFX Workflow Built with LTX** — LTX-2.5 is the core video model: text → video and image → video in the
  Marker and Storyboard tabs, the Comp tab's Extend (official `video_ltx2_5_flf2v` template, core `LTXVAddGuide` /
  `LTXVCropGuides`), and **LTX finishing**: Lightricks' IC-LoRAs as VFX tools on the comp — LTX Refine (Tiled Fusion to
  Full HD / 4K / 8K through 4K, the tile grid the LTX pack itself reports shown before the run), Archive restore
  (Restore, then Refine), Deblur, De-compression, Colorize, Clean plate, Day → Night, LTX Alpha mattes, SDR → HDR (EXR in
  ACEScg + HLG) — with 16-bit PNG or EXR masters, and H3 → LTX Refine as a Final (licence: LTX-2.x Community License, see `NOTICE`).

## Demo script (about 3:45)

Prepare before recording: EffectCraft started by `JustAE Flow.cmd` (the Flow window docked), the test project open,
results of the long runs already made (a VACE draft takes ~2 min, Extend ~2 min) so the video can cut from "Run" to
the result; the deployment warm if the upscale is shown live (a cold start takes 1–2 min). Credits on screen are
derived (execution time × the GPU's rate), never a price list.

| Time | Step | What to show on screen |
|---|---|---|
| 0:00–0:15 | **Hook** | EffectCraft with the Flow window docked on the right; a 16:9 sailboat comp. Voice: "Higgsfield's plugin crops your shot to 9:16. This one generates what's missing — open source, inside an open-source After Effects." |
| **0:15–1:50** | **The key moment: the Comp tab** | |
| 0:15–0:45 | Generative **Reframe** vs Higgsfield's crop | Comp tab ▸ Reframe ▸ 9:16, Draft: the card's mock with the generated area hatched, "your comp in the middle, untouched; the space above and below generated at 480×832". Run (cut to the result): the new comp "… · 9:16" 1080×1920 with sky and water generated; press **Tab** to Compare. One line: *Advanced ▸ Crop with tracking* is the crop Higgsfield sells. |
| 0:45–1:05 | **Social pack** | Social pack ▸ 9:16 + 1:1 + 4:5, Masters ProRes 4444: "3 runs, queued one after the other"; Results groups them ("3/3 done", the masters written next to the project); if you moved to another comp meanwhile, it is the one in front when they end. |
| 1:05–1:25 | **Upscale on the deployment, with the credit line** | Upscale ×2: open the resource chooser — "Local · no credits", "&lt;your deployment&gt; (RTX PRO 6000) · ≈ N cr · ✓ ran here"; pick the deployment; the estimate line under the button ("based on 1 run on RTX PRO 6000"); after the run, Results shows the time and "≈ N cr", and the header balance with the time it was read. |
| 1:25–1:40 | **Cut-out with alpha** | Cut-out ▸ "boat" from the layer: the matte above the clip as its luma track matte; **Export with alpha** → *Reveal .mov* → a ProRes 4444 file with alpha in the folder next to the project. |
| 1:40–1:50 | **Extend** (bonus moment) | Extend +2 s: "continues the last 0.7 s of motion"; **✦ Describe the clip** fills the prompt from four frames (local Qwen3-VL, ~20 s); the new layer at the out point. Optional 3 s: `P4_extend_v1_vs_v2_junction.png`, the pan reversing (v1) vs carrying on (v2). |
| 1:50–2:15 | **LTX finishing** (the LTX bonus) | A low-res generated clip (the 1280×704 LTX sailboat) ▸ Upscale ▸ **LTX Refine**: the card shows the tiles (3×3 for Full HD, 7×7 for 4K), the frames (121 → 129, 2 windows of 97), "8K goes through 4K", the "Look" field warning when it names a subject, and the time from the tile count, measured here. Cut to the result comp and the A/B sheet `P5_ab_seedvr2_vs_refine.png` (SeedVR2 keeps the image, LTX rebuilds texture); then **Archive restore** on a 480p, heavily compressed copy: `P5_restore_before_after.png`. Mention: the 4K run is the same card, overnight on a 16 GB GPU — the pipeline Matt Hallett shows (generate low, Refine to 4K). |
| **2:15–3:00** | **Second: the Storyboard series** | In EffectCraft: three adjustment-layer placeholders (`+ Placeholder` in the panel), moved and trimmed; the Storyboard tab lists them as cards in time order; one workflow for all (LTX-2.5), **Generate**: labels turn running → done on the timeline, live previews in the cards; scrub: each clip in its slot, placeholders switched off; **V** for a new version, **Tab** to swap back. |
| **3:00–3:25** | **Third: one key, every GPU** | Settings ▸ Resources: one platform key (only its last four characters shown), Local / Comfy Cloud / the deployment / `comfy-api-proxy`; the task table (reframe Final → deployment, draft → Local); Featured shows "runs on: Local ✓ · Proxy ✓ · deployment ✓ (ran here)". |
| 3:25–3:45 | **Close** | The repository page: GPL-3.0, official templates, open weights, your GPU. "Everything you saw is open source." |

## Comparison with the Higgsfield Adobe plugin (its official pages, read 22 Oct 2026; blog of 21 Jul 2026)

| | Higgsfield plugin (Premiere Pro / After Effects) | JustAE Flow |
|---|---|---|
| Host | Adobe Premiere Pro / After Effects 2025+ (subscription) | EffectCraft (open source, MIT OR Apache-2.0) |
| Where it runs | on Higgsfield's servers; needs an internet connection while generating | your ComfyUI — local, your Comfy API deployment, or Comfy Cloud |
| Cost | Higgsfield credits, shared with the web platform | free on your GPU; on Comfy's GPUs, credits for GPU time, estimated before and derived after each run |
| Models | Higgsfield's catalogue | any ComfyUI workflow; bundled: official templates, open weights only |
| Timeline integration | the generated file is inserted into the Adobe timeline | storyboard from markers and placeholders, in-place fills, versions, status colours; Comp tab results as new comps or layers, never destructive |
| Source | closed | open (GPL-3.0) |

Feature parity (EffectCraft, vs the After Effects / Premiere plugin's seven functions): Generate Video ✔ · Generate
Image ✔ · Reframe — different: generative (Wan 2.1 VACE), crop with tracking also there · Remove Background ✔ (SAM 3
tracked matte, ProRes 4444 alpha; LTX Alpha for soft edges) · Upscale ✔ (SeedVR2 ×2, ×4, to 4K; LTX Refine to Full HD
verified, 4K/8K through 4K planned and validated, not run on 16 GB) · Draw to edit — planned · Edit Video — partly (the
LTX finishing cards: Day → Night, Clean plate, Colorize…). Only here: LTX finishing with 16-bit masters, Extend with
motion guide, Slow motion / fps, Social pack, Describe the clip, the storyboard.

Feature parity (PhotoCraft, vs the Photoshop plugin): Generate AI Image ✔ (placeholder) · edit inside a selection ✔
(generative fill) · Remove Background ✔ · Upscale ✔ · Realtime, Mockup Studio, Layer Decompose, Angles, Shots, Expand,
Relight — not in this version · Face Swap, Character Swap, AI Stylist — left out on purpose (the open models for them
carry non-commercial licences, and they work on people's faces).

<!-- PLACEHOLDER (author): tagline for the form. -->

<!-- PLACEHOLDER (author): post text with #OpenSourceHiggsfield -->
