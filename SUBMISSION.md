# Submission — Comfy "Open Source Higgsfield" challenge

Deadline: **30 October 2026, 9:00 PT (17:00 in Italy)**. Rules page: https://comfy.org/open-source-higgsfield
(read 22 October 2026). Sign-up and submission are two separate forms on that page.

## Checklist

- [ ] Signed up (the first 200 sign-ups get Comfy credits).
- [x] Licence: GPL-3.0, full text in `LICENSE` — the rules require an open-source licence.
- [ ] Author name in `NOTICE`; name/logo wording in `TRADEMARKS.md`.
- [ ] README placeholders filled (tagline, presentation, closing link to JustAE / Homo Lapis).
- [ ] `docs/media/` screenshot or GIF; `examples/` filled with your own SFW outputs (no unlicensed IP or faces).
- [ ] `npm run selftest` green; `npm run verify:workflows` green on the demo machine.
- [ ] Clean install from zero following only the README (new folder, `npm run setup`, `npm start`).
- [ ] `npm run scan:secrets` clean; repository public.
- [ ] Demo video recorded (the page sets no length; keep it short — it is judged on the work, not the editing).
- [ ] Categories chosen in the form (see below), optional link to try it.
- [ ] Post with **#OpenSourceHiggsfield**.

Open questions to settle before submitting (not answered on the rules page):
- How many entries per person — the page does not say. This repo is one entry.
- Whether running open weights on Comfy Cloud counts for *Open Weights Only* — this entry runs locally.

## Categories

- **Best Overall** — every entry is considered.
- **Open Weights Only** — "No partner nodes or closed-source APIs, open-weights models only." Every bundled
  workflow is an official template with open weights and no partner/API node (checked by `npm run selftest`).
- **Most Innovative** — the demo video must explain why. The angle: the first bridge between ComfyUI and the
  open-source After Effects alternative, built on the app's own timeline (markers, placeholders, versions).
- **Bonus: VFX Workflow Built with LTX** — LTX-2.5 is the core video model (text-to-video and image-to-video).

## Demo outline (UX first)

1. **First run, 20 s** — the setup guide connects EffectCraft (`--control 9877`) and ComfyUI, test image.
2. **Markers become a storyboard** — in EffectCraft, three markers with the shots typed as comments; the cards
   appear by themselves, in time order, each sized to the comp and timed to the next marker.
3. **Inside EffectCraft** — the JustAE Flow panel docked in the app: the same cards, prompt, workflow, versions.
4. **A placeholder** — <kbd>M</kbd>, move and scale it in EffectCraft: its box is the shot.
5. **The key moment: generate the series** — select the cards, one workflow for all, <kbd>Ctrl G</kbd>. Markers
   turn yellow → cyan → green on the timeline while the cards show live previews.
6. **The cut is assembled** — scrub the EffectCraft timeline: every clip at its marker, trimmed to the next one;
   the placeholder filled in place, same box, same name.
7. **Never destructive** — <kbd>V</kbd> for a new version, <kbd>Tab</kbd> to swap back; an error turns fuchsia,
   *Retry failed* picks it up.
8. **On a layer** — select a clip → *Use selected layers* → SeedVR2 ×2 lands exactly over it; name a subject →
   SAM 3 cuts it out with a track matte (the clip untouched); *Wan VACE · Reframe 9:16* → a new vertical comp whose
   sky and sand are generated around the original clip, which stays on top untouched.
9. **Same storyboard in PhotoCraft** — switch app in Settings; select the sky, *Card from selection*, "add a striped
   balloon" → a new layer masked to the selection; a placeholder box filled with a generated image; a layer cut out.
10. **The comparison** — the same tools are sold as a subscription inside Adobe; here they are open source,
   inside an open-source compositor, on your own GPU.

## Comparison with the Higgsfield Adobe plugin (from its official pages, read 22 Oct 2026)

| | Higgsfield plugin (Premiere Pro / After Effects) | JustAE Flow |
|---|---|---|
| Host | Adobe Premiere Pro / After Effects 2025+ (subscription) | EffectCraft (open source, MIT OR Apache-2.0) |
| Where it runs | on Higgsfield's servers; needs an internet connection while generating | your ComfyUI — local or your own server |
| Cost | Higgsfield credits, shared with the web platform; commercial rights tied to paid plans | free; your hardware or your own cloud |
| Models | Higgsfield's catalogue | any ComfyUI workflow; bundled: open weights only |
| Timeline integration | the generated file is inserted into the Adobe timeline | storyboard from markers and placeholders, in-place fills, versions, status colours on the timeline |
| Source | closed | open |

Feature parity status (EffectCraft, vs the Premiere Pro / After Effects plugin): Generate AI Video ✔ · Generate AI
Image ✔ · Upscale ✔ · Remove Background (stills ✔, video subjects ✔ — SAM 3) · Reframe ✔ (generative: Wan2.1 VACE outpainting; or crop: SAM 3 tracking + keyframes) ·
Draw to edit, Edit Video — not in this version.

Feature parity status (PhotoCraft, vs the Photoshop plugin): Generate AI Image ✔ (placeholder) · edit inside a
selection ✔ (generative fill) · Remove Background ✔ · Upscale ✔ · Realtime, Mockup Studio, Layer Decompose, Angles,
Shots, Expand, Relight — not in this version · Face Swap, Character Swap, AI Stylist — left out on purpose (the open
models for them carry non-commercial licences, and they work on people's faces).

<!-- PLACEHOLDER (author): post text with #OpenSourceHiggsfield -->
