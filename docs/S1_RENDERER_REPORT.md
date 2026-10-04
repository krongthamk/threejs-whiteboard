# S1 renderer benchmark

**Evidence retention (October 2026):** Measurements below describe the original historical runs. Generated logs, raw latency/sample files, screenshots, PDFs and auxiliary JSON are no longer tracked. The audit-linked summary JSON and font metrics evidence remain; new run outputs stay local and ignored. Historical measurements were not rerun by this cleanup.

**Result: passed on the user-approved initial Mac target, 2026-09-29.** The user explicitly selected this Mac in place of the original “2020-class laptop” reference. This run does not establish performance on other hardware.

The final measured renderer keeps the planned three.js architecture. No Canvas 2D, glyph-atlas, or rasterized-text fallback is needed for these gates.

## Evidence

- [Raw final measurements and assertions](benchmarks/s1/s1-results.json), including browser/GPU identity and timestamps. `passed: true`, no browser errors.
- Mixed-board screenshot, visually inspected for actual rendered shapes, strokes, and text.
- [Reproducible runner](../spikes/renderer/run-benchmark.mjs) and [browser fixture](../spikes/renderer/main.ts).
- [Renderer API and color policy](../packages/renderer/README.md).

Target: Apple M1 Pro, 8 logical cores, 32 GiB memory, Darwin 25.6.0. Installed Chrome **154.0.8037.58**, headless, reports **ANGLE Metal Renderer: Apple M1 Pro**. This is hardware rendering, not SwiftShader. Viewport is 1440 × 1000 CSS pixels; the actual drawing buffer is **1440 × 928**, DPR 1. The maximum texture size is 16,384.

Each scenario runs from an isolated production Vite bundle on localhost port 4174, so development-server reloads cannot invalidate the run. After geometry/text preparation and **90 warmup frames**, it samples **600 animation frames** while continuously changing camera position. Text layout completes before sampling. The measured display cadence caps at approximately 60 fps; these numbers do not estimate uncapped throughput.

## Results

| Fixture | Required | Measured fps | p95 render CPU | Draw calls | Triangles | Result |
|---|---:|---:|---:|---:|---:|---|
| 5,000 shapes + 2,000 strokes + 500 visible texts | ≥55 fps | 60.00 | 9.20 ms | 511 | 144,289 | Pass |
| 20,000 shapes | ≥30 fps | 60.00 | 0.80 ms | 3 | 40,000 | Pass |
| 500 visible texts | ≥55 fps | 60.00 | 8.40 ms | 500 | 5,900 | Pass |
| 5,000 shapes, no off-screen texts | Baseline | 60.00 | 0.30 ms | 3 | 10,000 | Pass |
| 5,000 shapes + 5,000 off-screen texts | No added text rendering/layout | 60.00 | 0.40 ms | 3 | 10,000 | Pass |

Both visible-text scenarios retain **exactly 500 visible texts on every sampled frame**. They are above the six-screen-pixel LOD threshold. Off-screen text produces **zero troika instances**, zero extra draw calls, and zero extra triangles. The R-tree prunes those entries before mesh creation and layout. Document/index storage still consumes memory; “zero cost” here means no text layout or GPU work, rather than literally no storage or CPU instructions. The measured median query/render difference was +0.10 ms, within timer/noise granularity.

The fixture is deliberately dense: equal mixtures of rectangles, ellipses, and blank stickies, pressure-aware short strokes with 16 input samples each, and 500 labels. The board spans roughly 1,600 × 800 document units. Shapes/strokes use opaque styles; this result does not establish the same budget for thousands of individually sorted translucent elements, much longer freehand paths, DPR 2/4, or arbitrary fonts/scripts.

## Implementation and additional checks

- Orthographic camera, document coordinates, 2%–6400% zoom, and camera-only pan/zoom.
- Opaque shape types use three SDF instanced batches with per-instance fill, border, dimensions, and rotation. MSAA alpha-to-coverage preserves opaque edge coverage. Shape moves update existing instance attributes; unrelated text/stroke edits preserve those batches.
- Shared model `perfect-freehand` outlines feed earcut triangulation. The 2,000-stroke fixture uses eight chunks of at most 256 strokes. A targeted edit among 513 strokes changes exactly one chunk.
- Troika **0.52.5**, shipped `.woff` fonts, shared font metrics and wrapping, `sync()`-gated visibility, placeholders, viewport indexing, and six-pixel text LOD. Editor offsets map between original UTF-16 text and inserted wrap breaks.
- Connector paths use shared document geometry; arrowheads use shared instanced geometry. Translucent primitives and text follow global fractional-index order across types.
- The projection can be replaced from document data. A hard replacement with an empty document clears element, shape, stroke-chunk, and text-instance counts, including while text is syncing.
- Offscreen PNG export uses a cloned camera, tiled `WebGLRenderTarget`s, readback, row flipping, and straight-alpha PNG encoding. The regression verifies exact 2× dimensions.

Pixel assertions also caught and fixed a genuine export discrepancy: a default sRGB render target blended translucency in linear light, unlike the on-screen unlit board/SVG. The renderer now consistently composites CSS/sRGB component values without changing global three.js color management. **50% red over opaque blue is `[128, 0, 128, 255]` both on screen and in PNG.** Transparent red exports as straight-alpha **`[255, 0, 0, 128]`**, avoiding dark premultiplied-alpha edges. These assertions remain in the runner.

All nine targeted projection/export assertions pass, and `pnpm exec tsc --noEmit` passes. S4 owns the broader caret/IME and PNG-versus-SVG fixture suite. S1 alone does not prove those separate exit criteria or the later application phases.

## Reproduce

```sh
pnpm install --frozen-lockfile
node spikes/renderer/run-benchmark.mjs
```

The runner builds its own static bundle, starts and closes its own preview server/browser, and exits nonzero if any numeric gate, visibility invariant, browser error, or regression assertion fails. For projection/export regression checks without another timed benchmark:

```sh
CHECKS_ONLY=1 node spikes/renderer/run-benchmark.mjs
```

The source-frozen final rerun completed at approximately 19:34:30 UTC on 2026-09-29 after the shared text-atlas export fix. The earlier reference is preserved in pre-final measurements. D7 (troika text) and the three.js portion of D8 remain supported on this initial deployment target.
