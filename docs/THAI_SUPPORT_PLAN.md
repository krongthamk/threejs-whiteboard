# Thai support plan

Research date: 2026-10-02. This is an implementation proposal, not an acceptance report. No Thai implementation or tests have been completed. Apply after the review fixes and F1–F4 so all text blocks use their shared helpers.

## Decision

Retain jsPDF/svg2pdf. Add a shared Thai shaping path, using the exact shipped font to produce glyph IDs, cluster ranges, advances, x/y offsets and outlines. Use those outlines for visible Thai in Three.js, PNG, SVG and PDF, and retain original Unicode in a selectable export text layer. Do not claim Thai support from adding glyph coverage alone.

## Confirmed gaps

- `packages/model/src/text-layout.ts` records x-only character/pair/ligature metrics. It cannot express Thai vertical mark anchors or contextual glyph substitutions; wrapping currently finds spaces or approximate grapheme boundaries rather than Thai words.
- Troika 0.52.5 supports mark/base and mark/mark GPOS but lacks Thai-specific SARA AM decomposition/reordering. Its public TextBuilder accepts one primary URL and one default fallback URL, not an arbitrary list of fonts.
- `packages/app/src/export.ts` registers fonts, but jsPDF's Unicode path maps source characters to cmap glyphs without Thai shaping. Adding a Thai TTF does not repair the visual result.
- Native plaintext editing already preserves composition state; the editor font stack lacks a shipped Thai face.

## Implementation sequence

1. **Font assets.** Ship static regular-weight Noto Sans Thai WOFF and TTF plus OFL under `packages/app/public/fonts/`. For a variable source, instantiate `wght=400`, `wdth=100`. Record release/source URL and hashes. Extend `scripts/build-export-fonts.py`, generated coverage, `ShippedFontFamily`, font resolution, app CSS and export font registration. Preserve existing Latin/Japanese fallback behavior.
2. **Shared shaping.** Add `packages/model/src/thai-shaping.ts`; shape Thai font runs with explicit Thai script/language and LTR direction. Preserve original UTF-16 ranges; do not normalize saved text. Use shaped advances in measurement, auto-size and final line fitting. Cache fonts/outlines and bound text caches. Keep existing Latin/Japanese layout initially.
3. **Word wrapping.** Use `Intl.Segmenter('th', { granularity: 'word' })` for Thai opportunities and grapheme segmentation for Unicode boundaries. Preserve explicit LF, whitespace and mappings; recognize U+200B. Emergency wrapping must not split a shaping cluster or leave a Thai leading vowel isolated. Re-shape final line slices at chosen boundaries.
4. **Canvas/PNG.** Add a Thai renderer adapter, integrated through F1 text-block helpers. Build filled geometry from shaped outlines using Three.js path/shape tools, cache glyph geometry and combine geometry per text handle. Apply shared alignment, baseline, rotation, clipping and rank. Retain lifecycle/readiness/disposal rules. PNG uses this same renderer.
5. **SVG/PDF.** Emit positioned glyph paths for Thai visuals plus original Unicode in aligned text/tspan elements with `fill="none"`, `stroke="none"`; preserve whitespace/font and cluster positioning. Include accessible source labels. Installed svg2pdf 2.8.1 converts text with neither fill nor stroke into invisible PDF text, while visible outlines become PDF vectors. Keep strict coverage checks and selective font embedding. Validate real selection/copy; metadata alone is insufficient. If extraction reorders clusters, investigate `/ActualText` around the original source text layer.
6. **Editing.** Add/load Noto Sans Thai in the native editor stack. Preserve plaintext, native caret/clipboard and composition behavior. Do not insert wrap LF or normalize strings. Exercise ordinary Thai keyboard input as well as composition. F4 mention handling must ignore composing input/Enter.

## Dependency and initialization gate

HarfBuzz JS is a candidate because it provides Thai shaping, glyph positions/clusters and outline access in browser and Node. Upstream source currently identifies `harfbuzzjs` 1.6.2, MIT; the published registry pin has **not** been verified. No dependency has been added. Record the verified version/license/reason in `docs/DEPENDENCY_VERIFICATION.md` when selected.

The model's geometry API is synchronous and used in Node and browsers. HarfBuzz JS initializes WASM with top-level await. Prove production Vite WASM packaging, Node/Vitest imports and font initialization before selecting the integration. A generated embedded copy of the Thai TTF may provide portable font bytes, but changes the current parser-free model architecture. Do not expose a model that temporarily estimates Thai geometry before shaping is ready.

Replacing jsPDF with pdf-lib/fontkit is not an established shortcut: pdf-lib's custom-font encoder emits glyph IDs while discarding positioning, and Thai shaper support in fontkit requires separate verification. No PDF dependency replacement is proposed.

## Required acceptance cases

| Area | Cases and assertions |
| --- | --- |
| Shaping | `ภาษาไทย`, `ประเทศไทย`, `สวัสดีครับ`, `น้ำ`, `กำ`, `ค่ำ`, `ปี่`, `ปู่`, `ญุ`, `ฐุ`, `กิ่`, `กุ้`; reference rendering with exact Noto Sans Thai bytes; inspect stacked marks, ascenders/descenders and SARA AM. |
| Unicode | Original U+0E33 and explicitly encoded U+0E4D/U+0E32 sequences remain distinct and round-trip unchanged; digits `๐๑๒๓๔๕๖๗๘๙`, `฿`, `ๆ`, `ฯ`; no normalized/substituted source stored. |
| Layout | `Hello ภาษาไทย 日本語 123` with Inter/Mono; word wrapping without spaces, U+200B, LF/trailing LF, narrow boxes and unknown long words; no internal cluster breaks; monotonic UTF-16 mappings and existing Latin/JP regressions. |
| Editor | Native input, selection/deletion, clipboard, composition, blur/reopen, undo and peer updates; no mention acceptance during composition. |
| Text surfaces | Text, sticky, rect/ellipse labels, person names/mentions; left/center/right, rotation, fixed width and auto-size. |
| Exports | PNG/SVG/PDF regional comparisons including marks; standalone SVG selection/copy; PDF extraction/search/copy preserves original source, without duplicate extraction; onscreen/offscreen, cold/warm, tiled and small-text export; failed-font retry. |
| Runtime | Production WASM/CSP/local asset resolution, Node import, bounded caches, disposal and many-label performance; no external font requests. |

Suggested test ownership: model cases in `packages/model/test/text-layout.test.ts`; editor/rendering in new `tests/app/thai.spec.ts`; selectable/vector exports in `tests/app/pdf.spec.ts` and `tests/app/export.spec.ts`. Update README and `docs/TEXT_LAYOUT_REPORT.md` with measured scope. Existing Latin/JP SDF performance evidence does not establish Thai outline-rendering performance.

## Unproven tradeoffs

- Runtime WASM/font initialization in the synchronous model remains unproven.
- `Intl.Segmenter` dictionaries vary with ICU/runtime versions; this does not promise identical wrapping across arbitrary releases. A pinned dictionary is needed if that guarantee is required.
- Outline geometry changes Thai from SDF to filled-vector text. Small-mark readability, antialiasing, zoom quality and geometry cost must pass measured gates; otherwise use an SDF adapter consuming the same shape plan.
- Invisible SVG/PDF source text is a source-backed feasible path, but selection, copy, extraction order and viewer behavior have not been tested. Neither outlines alone nor metadata meet selectable-export requirements.

## Primary sources

- [Unicode line breaking](https://www.unicode.org/reports/tr14/): Thai needs language-dependent word analysis.
- [HarfBuzz Thai shaper](https://raw.githubusercontent.com/harfbuzz/harfbuzz/main/src/hb-ot-shaper-thai.cc): SARA AM decomposition/reordering and mark handling.
- [HarfBuzz JS API/examples](https://github.com/harfbuzz/harfbuzzjs), [package/version/license](https://raw.githubusercontent.com/harfbuzz/harfbuzzjs/main/package.json), [initialization](https://raw.githubusercontent.com/harfbuzz/harfbuzzjs/main/src/index.ts).
- [Official Noto Sans Thai metadata](https://raw.githubusercontent.com/google/fonts/main/ofl/notosansthai/METADATA.pb): v2.002/source commit and width/weight axes; [OFL license](https://raw.githubusercontent.com/google/fonts/main/ofl/notosansthai/OFL.txt).
- [Troika font documentation](https://github.com/protectwise/troika/blob/main/packages/troika-three-text/README.md): WOFF supported, WOFF2 unsupported. Specific limitations above were read from the installed 0.52.5 `FontParser.js`/`TextBuilder.js`.
- [jsPDF Unicode encoding](https://raw.githubusercontent.com/parallax/jsPDF/master/src/modules/utf8.js), [invisible text rendering](https://raw.githubusercontent.com/parallax/jsPDF/master/src/jspdf.js). svg2pdf behavior was read from installed 2.8.1 `getTextRenderingMode`.
- [pdf-lib custom font encoding](https://raw.githubusercontent.com/Hopding/pdf-lib/master/src/core/embedders/CustomFontEmbedder.ts): glyph encoding is not equivalent to applying all shaped positions.
