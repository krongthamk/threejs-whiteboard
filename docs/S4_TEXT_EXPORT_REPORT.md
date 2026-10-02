# S4 — Text editing and export prototype

**Result: passed on the user-selected Mac target, 2026-09-29.** The final production-isolated Chrome suite passed **8 tests in 8.6 seconds**, with no uncaught browser errors. [Recorded suite results](./benchmarks/s4/suite-results.json) identify Chrome 154.0.8037.58 and the final timestamp, 08:22:48 UTC. TypeScript checking also passes. The later source-frozen full rerun passed **8/8 in 10.7 seconds** on 2026-09-29 at 19:31 UTC; see [final suite JSON](benchmarks/final/s4.json). The prototype measurements below retain their original recorded timestamps.

The development prototype is `http://127.0.0.1:4173/text/` after `pnpm dev:spikes`. Tests build an isolated production bundle and serve it on port 4175, preventing development-server reloads from changing a measurement.

## Editing decision and proof

Use the plan’s DOM `contenteditable` overlay fallback. Troika supplies text rendering, caret positions, and selection geometry, but no native editing element or IME session. The overlay supplies those browser semantics. The draft remains local to the editor; blur commits the complete value in one document transaction and Escape discards it. Rendering remains a disposable projection of the document.

The browser suite verifies native typing, initial selection, caret movement, cut/paste, blur, one undo step, undo/redo, Escape cancellation, and composition whose blur precedes composition end. A separate Chromium `Input.imeSetComposition`/`Input.insertText` flow uses Japanese candidate input through the native editing pipeline. It then waits for actual troika synchronization, verifies **three visible glyphs for 日本語**, and completes both PNG and SVG export with external HTTP requests blocked. [Japanese proof](./benchmarks/s4/japanese-offline.json) records **zero external requests**, zero text errors, and two embedded WOFF fonts in the SVG.

An audit caught a genuine gap in the original test: asserting the committed document string did not prove its glyphs rendered. Inter’s Latin subset cannot display Japanese, and troika otherwise consults its external Unicode font resolver. The prototype now ships a lazy local Noto Sans JP fallback with its OFL license. Its original variable-font contours produced visible cuts at stroke intersections in troika; the regular-weight WOFF derivative now unions those contours without removing characters. [Font provenance, conversion, coverage, and hashes](../packages/renderer/FONTS.md) document the exact asset.

A missing font/layout now rejects readiness and export after a bounded timeout (15 seconds by default). A focused missing-font test verifies a configured 250 ms deadline rejects in approximately 251 ms and exposes the element’s error. [Font failure evidence](../spikes/renderer/artifacts/font-checks.json) retains that separate regression.

These results cover Chromium desktop input and the shipped Latin/Japanese fonts. They do not establish support for every OS IME, mobile keyboard, script, or emoji. Additional offline language coverage needs additional local fonts and equivalent checks.

## Export evidence

The mixed fixture contains a bordered rectangle and ellipse, sticky text, standalone text, a pressure-sensitive stroke, and a bound elbow connector. PNG uses offscreen three.js readback at **1800 × 1120**, exactly 2× the 900 × 560 document bounds. SVG serializes the document with shared geometry and embedded font data, then is independently decoded by Chrome.

- [Mixed-board PNG](./benchmarks/s4/mixed-board@2x.png), [SVG](./benchmarks/s4/mixed-board.svg), and [SVG raster](./benchmarks/s4/svg-raster@2x.png).
- [Japanese PNG](./benchmarks/s4/japanese-offline@2x.png), [self-contained SVG](./benchmarks/s4/japanese-offline.svg), and [SVG raster](./benchmarks/s4/japanese-svg-raster@2x.png).
- [Comparison metrics](./benchmarks/s4/comparison.json), [negative controls](./benchmarks/s4/negative-controls.json), and [prototype screenshot](./benchmarks/s4/prototype.png).

The recorded PNGs and SVG rasters were visually inspected. The Japanese comparison also caught an SVG rasterization race: Chrome’s `image.decode()` could resolve before the large embedded font was ready, yielding missing text on the first draw. The comparator now explicitly awaits `FontFace.load()` for each embedded font URL before rasterization; it does not use an arbitrary delay or silently retry until pixels pass.

The renderer also corrected an actual color-space discrepancy between offscreen PNG and screen/SVG blending. Its explicit unlit 2D policy gives **[128, 0, 128, 255]** for 50% red over opaque blue on screen and in PNG. Transparent red is encoded as straight-alpha **[255, 0, 0, 128]**. [S1 regression evidence](../spikes/renderer/artifacts/s1-results.json) verifies these exact pixels.

## Tolerances and measured results

The comparator retains direct pixel errors and separately measures an antialias allowance:

1. Foreground is the union of pixels with any RGB channel below 245 in either image. A direct mismatch has a maximum RGB-channel difference greater than **48/255**.
2. The antialias comparison permits a symmetric **one-output-pixel neighborhood**, or **0.5 CSS pixels at 2×**. Both directions must find a color within the same 48/255 threshold.
3. Mean absolute RGB-channel error over the full image must be below **5/255**. Each fixture region’s remaining foreground mismatch must be below **18%**. Non-text regions must also pass the direct 18% threshold.
4. Independent ink masks isolate each text object: the fixture’s navy ink has every RGB channel below **160**. All four PNG/SVG ink-box edges must agree within **one output pixel**. This is checked separately from neighborhood matching.

| Region | Direct foreground mismatch | After antialias allowance | Maximum ink-box edge difference |
|---|---:|---:|---:|
| Shapes and connector | 0.85% | 0.36% | — |
| Sticky | 0.72% | 0.32% | 1 output pixel |
| Latin standalone text | 19.58% | 8.92% | 1 output pixel |
| Freehand stroke | 0.00% | 0.00% | — |
| Japanese standalone text | 21.70% | 16.95% | 0 output pixels |

The mixed fixture’s mean channel error is **0.289/255**; the Japanese fixture’s is **0.216/255**. The direct text mismatch is explicitly retained and is not described as a direct-pixel pass. SDF and native font rasterization remain visibly close rather than pixel-identical.

Negative controls use the same comparison: removing the Latin text produces **93.10%** remaining mismatch and an absent SVG ink box; shifting it **1 CSS pixel** produces **36.82%** mismatch and a **3-output-pixel** box difference; shifting it **8 CSS pixels** produces **73.22%** mismatch and a **17-output-pixel** box difference. All controls fail. Neighborhood matching alone is not a universal displacement guarantee, and these tolerances prove the recorded fixtures rather than every possible document.

## Reproduce

```sh
RECORD_EVIDENCE=1 pnpm exec playwright test tests/browser/text-spike.spec.ts
```

The suite writes current artifacts under `test-results/browser/`; `RECORD_EVIDENCE=1` also copies them into `docs/benchmarks/s4/`. The suite always fails on uncaught browser errors, missing/unsynchronized Japanese glyphs, external Japanese font requests, wrong PNG dimensions, or the visual gates above. S4 is complete within this prototype scope; the separate S1/S2/S3 gates and later application phases remain independent obligations. Phase 4 must extend export verification to selection, transparency, tiling, images, and the selected PDF path.
