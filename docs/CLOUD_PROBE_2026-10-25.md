# Comfy Cloud probe — 25 October 2026

What Comfy Cloud offers this account, measured with `npm run probe:cloud` (`scripts/probe-cloud.ts`) on
25 Oct 2026 at 16:20 UTC: read-only calls, **no job submitted, no credit spent**. Balance and spend figures belong to
the account holder and are not recorded here. Raw answers stay on the machine that ran the probe.

Sources for every endpoint: the v1 Cloud OpenAPI document (`https://docs.comfy.org/openapi-cloud.yaml`, fetched
25 Oct 2026), the Comfy API v2 documentation (docs.comfy.org, *Comfy API v2 Overview*), and `@comfyorg/sdk` 0.5.0
(`dist/sdk/*.d.ts`, `src/sdk/client.ts`). What was not measured is marked DA VERIFICARE.

## 1. Service

| Call | Auth | Answer |
|---|---|---|
| `GET /api/system_stats` | none | 200 · `comfyui_version` **v0.42.5**, `cloud_version` **v0.494.0**, `workflow_templates_version` **0.7.64**; `devices` is empty (the GPU is not reported here: RTX PRO 6000 comes from comfy.org/cloud/pricing) |
| `GET /api/user` | `X-API-Key` | 200 · `{ id, status }` — `status: "active"`. The spec lists only `status`; `id` is also there |
| `GET /api/features` | `X-API-Key` (optional) | 200 · 73 flags, among them `max_upload_size` 104857600 (100 MiB), `supports_preview_metadata` true, `billing_control_enabled`, `free_tier_credits` 0, `comfy_api_base_url` `https://api.comfy.org` |
| `GET /api/jobs?limit=1` (v1) | `X-API-Key` | 200 · `{ jobs: [{ id, status, create_time, execution_start_time, execution_end_time, executor, outputs_count, preview_output, previewable_outputs_count }], pagination: { limit, offset, total, has_more, next_cursor } }` — times in ms |
| `GET /api/object_info` | `X-API-Key` | 200 · **3,835** node classes (9.3 MB); loader nodes list the model files as their options (e.g. `UNETLoader.unet_name` 377, `LoraLoader.lora_name` 652) |
| `GET /api/object_info` | none | 401 `{"code":"UNAUTHORIZED","message":"authentication required"}` |
| `GET /api/experiment/models` | none | 200 · **136** model folders (public, as the spec says) |

## 2. Comfy API v2 with the same key

| Call | Auth | Answer |
|---|---|---|
| `GET /api/v2/jobs?limit=1` | `Authorization: Bearer <key>` | **501** `{"error":{"code":"not_implemented","message":"Comfy Cloud does not list jobs yet"}}` — as the SDK's `listJobs` documentation warns |
| SDK `listJobs({ limit: 1 })` | key passed to `new Comfy({ apiKey })` | `ComfyError` code `not_implemented`, HTTP 501 |
| SDK `jobs.get(<unknown uuid>)` | same | `NotFound` code `job_not_found`, HTTP 404 — the key is accepted (a refused key is 401 `unauthorized`) |

So the v2 surface accepts the key; a "check connection" on Cloud cannot list jobs and uses `GET /api/user` (v1)
instead. JustAE Flow does exactly that.

## 3. Billing: `GET /api/billing/usage/timeseries`

Query parameters, from the spec and tried one by one (all answered 200):

| Query | Range echoed | Notes |
|---|---|---|
| none | 6 months back to the current hour | defaults: `group_by=model`, `granularity=month` |
| `granularity=day` | same | one bucket per day with spend |
| `group_by=product` | same | the only group key seen: `"GPU Hours Product"` |
| `granularity=hour&group_by=endpoint` | from 2026-10-09T00:00Z | hourly reports start later than the 6-month default |
| `starting_on=…&ending_before=…` | as given | RFC 3339 |
| `months=1` | 1 month | smallest default report |
| `granularity=week` | 6 months, **month** | an unknown value is not refused: it falls back to `month` |

Shape of the answer (keys measured; the two marked are not in the OpenAPI document):

```
{ group_by, granularity, starting_on, ending_before,
  as_of,                 ← not in the spec: an RFC 3339 time, the moment of the answer
  attribution_since,     ← not in the spec: 2026-10-09T06:00:00Z on this account (meaning DA VERIFICARE)
  groups:    [ "GPU Hours Product" ],
  buckets:   [ { period_start, period_end, group_key, cost_micros } ],
  breakdown: [ { group_key, cost_micros, share } ],
  summary: { spend_micros,
             balance: { amount_micros, amount_cents,
                        prepaid_balance_micros, prepaid_balance_cents,
                        cloud_credit_balance_micros, cloud_credit_balance_cents,
                        currency } } }
```

- `summary.balance` carries **`*_cents` fields next to the `*_micros` ones, with equal values**. That confirms the
  spec's warning that the `_micros` balance fields are cents. JustAE Flow reads the `_cents` names when present.
- Credits = cents ÷ 100 × 211 (211 credits = 1 $, comfy.org/cloud/pricing).
- `cost_micros` / `spend_micros` are millionths of a dollar (spec). The figures "come from invoices"; on this account
  the last spend bucket was months old, so how quickly a new job appears in them is DA VERIFICARE (measured in
  `docs/TEST_LOG_2026-10-25.md` where a Cloud job was run).

## 4. Node classes on Comfy Cloud

From `GET /api/object_info` (v1, with the key). "Local" is the user's ComfyUI 0.38 (`/api/object_info`, same day).

| Node class | Used by | Cloud | Local |
|---|---|---|---|
| `SAM3_VideoTrack`, `SAM3_TrackToMask`, `SAM3_Detect` | sam3-matte, sam3-reframe | yes | yes |
| `WanVaceToVideo` | vace-reframe, vace-reframe-draft | yes | yes |
| `SeedVR2Conditioning`, `SeedVR2Preprocess`, `SeedVR2PostProcessing`, `SeedVR2TemporalChunk`, `SeedVR2TemporalMerge` | seedvr2-upscale(-image) (core nodes) | yes | yes |
| `SeedVR2VideoUpscaler` | pipeline catalogue (custom pack) | yes | yes |
| `MiniMaxH3ImageToVideo`, `MiniMaxH3ReferenceToVideo`, `MiniMaxH3AddGuide`, `EmptyMiniMaxH3LatentAV` | H3 (catalogue) | yes | yes |
| `LTXVImgToVideo`, `LTXVImgToVideoInplace`, `EmptyLTXVLatentVideo`, `LTXVAddGuide`, `LTXVLatentUpsampler`, `LTXVDualCFGGuider`, `TextGenerateLTX2Prompt` | ltx25-i2v, ltx25-t2v | yes | yes |
| `RIFE VFI`, `GIMMVFI_interpolate` | pipeline catalogue (interpolation) | yes | yes |
| `WanFirstLastFrameToVideo`, `Wan22ImageToVideoLatent`, `Wan22FunControlToVideo` | Wan 2.2 FLF (catalogue) | yes | yes |
| `RemoveBackground`, `LoadBackgroundRemovalModel` | birefnet-rmbg | yes | yes |
| `TextEncodeQwenImageEditPlus`, `FluxKontextMultiReferenceLatentMethod` | qwen-edit | yes | yes |
| `WanVideoFlashVSRDecoderLoader` | FlashVSR (catalogue) | yes | yes |
| `SmartUpscaledTilePlanner` | Smart Upscaler (catalogue) | **no** | no |

Every node class of every bundled `workflows/*.api.json` exists on Cloud.

## 5. Model files

`GET /api/experiment/models/{folder}` (public); only the files each graph actually names.

| Workflow | Files | On Cloud |
|---|---|---|
| zimage-t2i | qwen_3_4b, ae, z_image_turbo_bf16 | 3/3 |
| ltx25-i2v, ltx25-t2v | LTX-2.5 22B distilled int8, video VAE, audio VAE, Gemma 4 12B int8, Gemma 4 e2b int8, latent spatial upscaler ×2 | 6/6 |
| qwen-edit | Qwen image VAE, Qwen-Image-Edit-2511 Lightning LoRA, qwen_image_edit_2511 int8, Qwen 2.5 VL 7B fp8 | 4/4 |
| sam3-matte, sam3-reframe | sam3.1_multiplex_fp16 | 1/1 |
| seedvr2-upscale, seedvr2-upscale-image | seedvr2_3b_int8_convrot, seedvr2_ema_vae_fp16 | 2/2 |
| birefnet-rmbg | birefnet | 1/1 |
| vace-reframe-draft | wan2.1_vace_1.3B_fp16, umt5_xxl_fp16, wan_2.1_vae | 3/3 |
| vace-reframe (14B) | wan2.1_vace_14B_fp16, umt5_xxl_fp16, wan_2.1_vae, **wan2.1_t2v_14b_lora_rank64_lightx2v_4step** | **3/4** |

The one file missing is the lightx2v 4-step LoRA `vace-reframe` uses instead of the non-commercial CausVid LoRA.
Cloud has other lightx2v distillation LoRAs for Wan 2.1 14B T2V (e.g. `lightx2v_T2V_14B_cfg_step_distill_v2_lora_rank64_bf16.safetensors`,
`Wan21_T2V_14B_lightx2v_cfg_step_distill_lora_rank32.safetensors`); whether one gives the same result in this graph is
DA VERIFICARE. Cloud also has the H3 weights (`minimax_h3_fl2va_pruned_int8_convrot`, `minimax_h3_ref2va_pruned_int8_convrot`),
SeedVR2 3B/7B in several precisions, and the Wan 2.2 i2v and fun-control models.

## 6. What this means

- **Runs on Cloud as-is:** zimage-t2i, ltx25-i2v, ltx25-t2v, qwen-edit, sam3-matte, sam3-reframe, seedvr2-upscale,
  seedvr2-upscale-image, birefnet-rmbg, vace-reframe-draft — every node and model present. "Runs" here means
  present; an actual Cloud run of each is DA VERIFICARE except where `docs/TEST_LOG_2026-10-25.md` records one.
- **Does not run as-is:** vace-reframe (14B), for one LoRA file. JustAE Flow's probe marks it "missing" on Cloud, so
  its Settings row falls back to Auto (Local) instead of failing.
- **SeedVR2 and VACE are on Cloud**, so the plan's §7 question 2 (a deployment for the heavy tasks) is not needed
  for them. A deployment would still be the way to run the 14B reframe with this exact LoRA, or custom nodes Cloud
  does not curate. Its price, from comfy.org/cloud/pricing (Comfy API section, read 25 Oct 2026): GPU time per
  second while a worker runs — RTX PRO 6000 736.39 cr/h (3.49 $/h), H100 1,314.53 cr/h, H200 1,626.81 cr/h, B200
  2,369.53 cr/h — plus storage at 42.20 cr per GB per month for the build; with `--min 1` a worker bills while idle
  (RTX PRO 6000: about 17,673 cr ≈ 84 $ a day). The size of a build with the reframe models is DA VERIFICARE.
