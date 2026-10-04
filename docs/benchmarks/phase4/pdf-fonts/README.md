# PDF font and alignment regression

**Evidence retention (October 2026):** Measurements below describe the original historical runs. Generated logs, raw latency/sample files, screenshots, PDFs and auxiliary JSON are no longer tracked. The audit-linked summary JSON and font metrics evidence remain; new run outputs stay local and ignored. Historical measurements were not rerun by this cleanup.

`VERIFY_PDF=1 pnpm exec playwright test --config playwright.app.config.ts tests/app/pdf.spec.ts` passed **3/3 tests in 14.5 seconds** on 2026-09-29 UTC, using the production application build and installed Chrome. `pnpm exec tsc --noEmit` also passed. PyMuPDF 1.26.4 independently extracted and rasterized the PDFs; its Python path can be set through `PDF_PYTHONPATH`.

The fixture contains `Plan €•…— Ā 日本語 end` in Inter and IBM Plex Mono, each centered and right aligned. The test deliberately prevents the browser's ordinary Noto CSS URL from loading, while allowing local export font bytes. It verifies that explicit measurement faces have loaded, extracts the exact strings and registered fonts, and compares the first PDF with a subsequent export.

| Line | PDF versus SVG ink-bound difference | PNG versus SVG ink-bound difference |
|---|---:|---:|
| Inter, centered | 1 output pixel | 1 output pixel |
| Inter, right aligned | 0 | 0 |
| Mono, centered | 1 output pixel | 1 output pixel |
| Mono, right aligned | 0 | 0 |

Rasters are at 2× CSS resolution. The unchanged assertion allows two output pixels; ink is defined by all RGB channels being below 160. These are independent ink-bound comparisons, not a general per-pixel or antialias-neighborhood guarantee. Exact text extraction and the font assigned to each run separately catch absent/replaced text. Cold and warm PDF pixels are identical. The PDF raster, SVG raster, and PNG projection were visually inspected: glyphs, punctuation, baseline, and alignment are intact. All external HTTP requests were blocked, and no page errors were observed.

Three measured causes were fixed:

1. A Unicode cutoff incorrectly sent Inter's `€•…—` to Noto, but sent `Ā` to a primary font that lacks that codepoint. Exact cmap coverage is now generated from the shipped TTFs, with SHA-256 hashes checked by the regression. PDF errors explicitly for an unsupported glyph, such as U+1F984, and a subsequent supported export still succeeds.
2. Registering a TTF with jsPDF does not load the browser font used by svg2pdf's width measurement. An isolated centered 32 px Noto line started at x=144.6484 before the CSS font loaded and x=151.4880 afterward. Export now loads and awaits the exact measurement `FontFace` before conversion, with a 15-second failure bound and a retryable cache.
3. Native SVG font fallback differs from the pinned Troika resolver. Chrome can synthesize absent `Ā` from Inter's `A` plus combining macron: the initial mixed line measured 375.28125 CSS px, versus 372.65912 for explicit cmap-based runs. Also, Troika 0.52.5 carries a resolved font into subsequent characters when that font covers them, including whitespace and subsequent lines. After Noto fallback, a Latin suffix can therefore remain Noto. Both application SVG and PDF exports now use explicit spans matching this rule. The retained intermediate failure shows up to 50 output pixels of PNG/SVG mismatch before the carry rule was applied.

The font policy is coupled deliberately to Troika 0.52.5 and must be rechecked when upgrading it. Shared model wrapping and geometry are unchanged. The application exporter embeds local fonts; this test does not claim universal Unicode support or alter the pure model SVG serializer. The second regression additionally verifies carry across a newline and unsupported-glyph failure/recovery. The third serves malformed TTF bytes with HTTP 200, then repairs the response: font decoding rejects, both failed face and byte-cache entries are evicted, and the second export re-fetches and succeeds.

Regenerate coverage without touching existing TTF files:

```sh
python3 scripts/build-export-fonts.py --coverage-only
```

Running that script without the flag regenerates TTF containers from the shipped WOFF files and then their coverage. It requires FontTools 4.59.2. Normal builds use the committed files and require no Python font toolchain.
