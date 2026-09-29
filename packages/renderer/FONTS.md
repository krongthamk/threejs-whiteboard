# Shipped Japanese fallback

The renderer configures troika's local default fallback **before the first layout request**. The caller's Inter/IBM Plex Mono font remains primary. Characters unavailable there use `noto-sans-jp-400.woff` from the same URL directory, or the explicit `fallbackFontUrl` option. Troika's font-builder configuration is shared within a page, so renderers on one page must agree on that URL.

The fallback is a regular-weight instance of official Google Fonts **Noto Sans JP**, without glyph subsetting. It contains 16,732 Unicode mappings and is approximately 3.4 MB. It is fetched lazily when text needs it. The application and spike both ship a copy alongside `NotoSansJP-OFL.txt`.

- Source: [Google Fonts Noto Sans JP variable TTF](https://github.com/google/fonts/blob/main/ofl/notosansjp/NotoSansJP%5Bwght%5D.ttf)
- License: [SIL Open Font License 1.1](https://github.com/google/fonts/blob/main/ofl/notosansjp/OFL.txt), copyright 2014–2021 Adobe, reserved font name “Source”. The license is included beside the font.
- Original TTF SHA-256: `c2f3b4d463500a2ddcd3849cded1fceeb9fd6d1c32e6cbecd568453ba50fc68f`
- Shipped WOFF SHA-256: `d7e347e1a204d011ff275d848ef0cf983630cefcf773339e1c74f0b23be53d64`
- Conversion: [build-japanese-font.py](./build-japanese-font.py), FontTools 4.59.2 with skia-pathops 0.9.2, weight axis instantiated at 400; no WOFF2. Contours are unioned during instancing: the variable font's overlapping contours otherwise create visible cuts at Japanese stroke intersections in Troika's SDF output. Character coverage is unchanged.

```sh
python build-japanese-font.py NotoSansJP-variable.ttf noto-sans-jp-400.woff
```

Latin and Japanese are the languages exercised by this prototype. The shipped font does not cover all Unicode, emoji, or every language. Additional scripts need deliberately selected local fonts and equivalent validation before offline support is claimed. Troika can otherwise attempt its upstream Unicode resolver for uncovered characters; those languages are outside the prototype's validated offline coverage.

A local font error or an unavailable unsupported-character fallback must not leave `whenReady()` or PNG export pending forever. A configurable `fontLoadTimeoutMs` (default 15 seconds) rejects readiness with the element ID and a font/coverage error. `getTextError(id)` and `stats().textErrors` expose that failure to the application. Deleting/replacing the element or disposing the renderer cancels its outstanding wait.

`node spikes/renderer/verify-fonts.mjs` runs an external-network-blocked Chromium IME test, waits for committed Japanese to have actual visible troika glyphs, exports a 2× PNG, and verifies an intentionally missing font rejects promptly. Evidence is in `spikes/renderer/artifacts/font-checks.json`; the Japanese screenshot was visually inspected.

The application additionally ships TTF containers for the same three regular-weight fonts for browser PDF export. `scripts/build-export-fonts.py` unwraps the committed WOFF with FontTools 4.59.2; it does not change glyphs, advances, coverage, or licensing. These TTFs are fetched only when PDF export is requested. SVG embeds WOFF; the normal editor continues to load WOFF.
