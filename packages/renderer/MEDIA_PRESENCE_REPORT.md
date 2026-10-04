# Image and presence renderer acceptance

**Evidence retention (October 2026):** Measurements below describe the original historical runs. Generated logs, raw latency/sample files, screenshots, PDFs and auxiliary JSON are no longer tracked. The audit-linked summary JSON and font metrics evidence remain; new run outputs stay local and ignored. Historical measurements were not rerun by this cleanup.

The renderer passed its image/presence checks and sustained **60.00 fps** on the user-approved Mac target with the S1 mixed workload plus 16 images and 40 moving remote peers. This is renderer acceptance; server fan-out, authentication, application collaboration, and export controls have separate integration tests.

## Measured fixture

Recorded on 2026-09-29 UTC in a production Vite build, installed Chrome 154.0.8037.58 headless, ANGLE Metal on Apple M1 Pro, 8 logical cores and 32 GiB memory. The rendered canvas was 1440 × 928 CSS pixels at DPR 1. There were 90 warmup frames and 600 measured frames. Camera position and zoom changed every frame; all 40 peers' cursors changed **every frame**, exercising 60 complete snapshots per second. This exceeds the rate of changed peer entries expected after coalescing 40 clients sending awareness at 20 Hz.

| Workload / result | Measured value |
|---|---:|
| Instanced opaque shapes | 5,000 |
| Chunked strokes | 2,000 |
| Visible document texts, minimum across all frames | 500 |
| Visible images with distinct asset IDs | 16 |
| Remote cursors and selection frames | 40 |
| Remote name + editing labels | 80 |
| Mean frame rate | 60.0024 fps |
| Frame interval p95 / maximum | 16.8 / 16.8 ms |
| Presence update + camera update + render CPU p95 | 12.9 ms |
| Draw calls / triangles | 863 / 148,793 |
| GPU textures / geometries | 17 / 634 |
| Pending document text, image, and presence layouts at finish | 0 |

The original S1 requirement for this mixed fixture is at least 55 fps. This extension meets it while retaining all 500 visible document texts. Images were 256 × 256 source bitmaps displayed as 80 × 80 document boxes; they were decoded before timing. The measurement does not claim the same throughput for arbitrary image counts, large image decoding during a frame, DPR 2, different hardware, or more than 40 remote peers.

Evidence: raw measured report, mixed screenshot. The screenshot was inspected; cursor names and editing badges are visible, with expected label overlap in the deliberately dense fixture.

## Correctness and resource checks

The final measured report passes all 21 assertions, with no page errors or external HTTP requests. The separate focused report records the prior 20-assertion run before the awareness coalescing check was added.

- A 1024 × 512 source uses a 64-pixel display thumbnail. A 4× export of its 256 × 128 document box preserves alternating one-source-pixel stripes that cannot exist in the thumbnail. The display texture is restored afterward. The full-source PNG was visually inspected.
- Two element copies of the same asset share a display texture. Newly offscreen images allocate no image handles or texture work; textures from previously visible images are released offscreen and load correctly on return.
- Independently expected quadrant colors verify texture orientation and 90° rotation. A half-opacity red image over blue is `[128, 0, 128, 255]` on screen and in PNG. A higher half-opacity green shape yields `[64, 128, 64, 255]`. Half-alpha red stored inside an image exports as straight-alpha `[255, 0, 0, 128]`.
- Forty peers load local-font name labels and an editing indicator. Thirty cursor updates preserve peer group and frame geometry identities. Presence makes no change to the exported PNG bytes. Clearing peers removes their primitives; repeated create/render/clear cycles retain four GPU geometries and two textures, matching the pre-cycle baseline. Shared font atlas allocation is retained by Troika.
- Eight hundred `setPresence` callbacks leave the scene unchanged until `render()`. That render applies only the last snapshot. Cursor-only changes also skip unchanged frame and label geometry. Thus the incoming awareness callback rate does not determine geometry rebuild frequency.
- A resolver that never settles rejects in approximately 122 ms with a configured 120 ms timeout. Invalid image bytes reject. Disposal cancels pending image work without stale handles, pending promises, or page errors.

The tests use actual Chrome WebGL rendering and native `ImageBitmap` decoding. They do not substitute canvas-drawn images for the renderer's output. PNG pixels are read independently through Canvas 2D for assertions.

## Failed runs and diagnosis

Two earlier 60-snapshot runs failed the frame budget and are retained: 50.28 fps with an overlapping app export browser run, and 35.43 fps with no managed test browser present at launch. The latter had a 757 ms maximum CPU frame. The absence of another test browser did not mean the user's other applications or operating-system work were idle. These records are not used as passing acceptance evidence.

After the session's long interruption, a diagnostic control series measured the original mixed fixture, 40 peers with fixed zoom, 40 peers with changing zoom, hidden presence with the same update workload, and the original fixture again. Every case sustained 60 fps. Presence snapshot processing was at most about 0.1 ms at p95; zoom-related presence updates were about 0.3 ms. WebGL draw submission was the main measured cost: roughly 8.4 ms at p95 for the base fixture and 11.7 ms with visible peers.

The exact full acceptance command then passed at 60.003 fps **without changing runtime code between the failed run, diagnostic controls, and passing rerun**. This establishes a passing measured workload and shows the earlier slowdown was not reproducible in that control series; it does not establish a specific application-code root cause for the slow runs. Performance under arbitrary competing system load remains unproven. The renderer change independently verified here is awareness coalescing, not a claimed repair of those unexplained timing outliers.

The diagnostic-only `spikes/renderer/diagnose-media.mjs` wraps methods inside its test page, writes the control artifact, and leaves production source uninstrumented. It requires the media bundle built by the normal check command.

## Interface and limitations

Presence is ephemeral and capped at 40 peers; names are bounded at 80 characters. Each peer gets a fixed number of reused primitives. The latest awareness snapshot is projected at most once per render. Multiple selections have one enclosing frame, and editing text gets a separate labeled frame. Presence font loading has a bounded deadline and does not block ordinary document rendering. PNG export waits for current document and presence text synchronization across renderer instances because Troika shares an atlas and can expose cached glyphs before their SDF generation finishes; a font deadline rejects a waiting export. Optional viewport data is carried for application navigation, not drawn as another frame.

Image source references remain immutable model fields. The optional resolver owns its URLs; the renderer owns decoded bitmaps and GPU textures. It releases offscreen/disposed resources and closes late decode results. Source dimensions must fit `getMaxImageDimension()` for full-resolution export. Larger sources fail explicitly. Output tiling handles large exported boards, but does not tile a single oversized source image into multiple GPU textures. Upload validation in the application should use the active renderer limit.

The display renderer can contain transient gesture `applyDiff` overrides. Application export therefore uses a separate cached renderer fed only committed document snapshots. `exportPng` itself excludes selection, presence, grid, and the separate active pen preview.

Reproduce focused checks:

```sh
node spikes/renderer/run-media-checks.mjs
```

Include the mixed frame measurement:

```sh
MEDIA_BENCHMARK=1 node spikes/renderer/run-media-checks.mjs
```

Both build an isolated production bundle under ignored `spikes/renderer/dist/media`, serve port 4174, close their browser/server, and write their artifacts. `pnpm exec tsc --noEmit` also passes after integration.

The final source-frozen rerun at approximately 19:35 UTC on 2026-09-29 also passed all 21 assertions, with 60.0024 fps, 12.9 ms p95 CPU, no page errors or external requests, after shared document/presence atlas readiness was integrated. Final command log. The prior passing reference remains in `docs/benchmarks/final/pre-final-reference/`.
