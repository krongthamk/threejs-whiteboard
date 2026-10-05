# Dependency verification

Checked on 2026-09-29.

F3 final dependency audit — 2026-10-05: the authentication, account UI,
provisioning and local test provider add no packages or fonts. The installed
strict SPDX audit passes unchanged; results are under
`test-results/verification/f3-final`. The test provider uses existing Node HTTP
and crypto APIs and is never imported by the production server.

F3 authentication foundation — 2026-10-05: no new packages or font assets.
Google's authorization-code flow uses existing Node fetch/crypto APIs, bounded
direct HTTPS token exchange and strict identity claims. The implementation uses
the direct token-endpoint TLS validation option in
[OIDC Core 3.1.3.7](https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation),
with a fixed production endpoint, redirects disabled and no browser ID-token
input. No JWT signature library or Google SDK is added. Test-provider overrides
are restricted to explicit test mode and a validated loopback origin. Existing
SQLite and image-header dependencies support migration and private avatar files.

F2 final dependency audit — 2026-10-05: the importer, safety checks and native
acceptance coverage add no packages or fonts. The installed strict SPDX audit
passes unchanged; results are recorded under `test-results/verification/f2-final`.
Existing font licenses and pinned image/Yjs dependencies continue to apply.

F2.3 import integration update — 2026-10-05: no new packages or font assets.
The exact update planner reuses pinned Yjs and fractional indexing. The server's
existing bounded update-resource parser is shared from the model package so
client preflight and server admission enforce the same limits. Image crop and
flip normalization uses the existing browser decoding and canvas APIs.

F2.2 Excalidraw converter update — 2026-10-05: no new packages or font assets.
The pure converter reuses the pinned `fractional-indexing` package and the
model's image-header validation. Color parsing uses standard CSS color values
and local arithmetic; it does not import a browser or renderer into the model.
The genuine test scene was created through the official Excalidraw app using
synthetic text and the repository's existing PNG fixture. Its unchanged bytes
and capture provenance are stored with the converter fixtures.

F1 shape text update — 2026-10-05: no packages, dependency versions, or font
assets are added or changed. Shape labels reuse the existing Yjs model, Troika
projection, SVG/PDF export path, and bundled Inter, IBM Plex Mono, and Noto Sans
JP fonts. Their dependencies and licenses remain covered by the installed
dependency audit and the font license records below.

Finding 28 update — 2026-10-05: model element creation and duplication now use
the platform's `crypto.randomUUID()`. The direct `nanoid` 5.1.6 dependency and
its lockfile entries are removed; caller-supplied and historical element IDs
remain unchanged. The separate `nanoid` 3.3.19 entry remains a PostCSS transitive
dependency. This change adds no dependency.

Finding 52 update — 2026-10-05: CI pins Node 26, matching the locally verified
Node 26.8.1 runtime, and `.npmrc` rejects unsupported engines. The actual
`--trace-deprecation` stack located `require("three")` in Troika 0.52.5's UMD
entry point. Vitest now selects Troika text/utils published ESM entry points
and transforms those packages; browser builds already use ESM. The original
seven-test reproduction passes with the warning present under the old config
and absent under the new config. A standalone unsupported-engine install
changes from exit 0 to `ERR_PNPM_UNSUPPORTED_ENGINE`; no dependency versions
changed. Logs are under ignored `test-results/verification/tooling52/`.

Finding 55 update — 2026-10-05: unused direct app dependencies `@fontsource/inter`,
`@fontsource/ibm-plex-mono`, and `y-protocols` are removed. The checked-in licensed
font files remain the application’s font source. Root duplicate type and Yjs
entries are removed; app owns its RBush types, server owns its WebSocket types,
and the retained spikes are a workspace package owning their Yjs/YKeyValue
imports. Tests and spikes resolve the model and renderer through workspace
package exports instead of TypeScript/Vite source aliases. Finding 29 moves
Hocuspocus spike processes to loadtest, which now declares its existing pinned
server dependency. No dependency version changes or new external packages are
introduced.

Finding 51 update — 2026-10-05: the audit now accepts only MIT, ISC,
BSD-2-Clause, BSD-3-Clause, Apache-2.0, 0BSD, CC0-1.0, Unlicense and OFL-1.1
identifiers. Valid SPDX `AND`/`OR` expressions and parentheses are supported,
but **every identifier in every branch must be allowlisted**. An approved OR
alternative does not excuse an unapproved branch. Missing, unknown, malformed,
exception-bearing and noncanonical expressions fail, as do the existing tldraw
and `@y/hub` package exclusions. No license exceptions were added. This follows
the [SPDX expression grammar](https://spdx.github.io/spdx-spec/v2.3/SPDX-license-expressions/)
with the stricter project policy applied to each identifier.

The installed dependency graph previously failed that policy on Lightning CSS
(MPL-2.0), DOMPurify (MPL-2.0 OR Apache-2.0) and pako (MIT AND Zlib). Tooling now
uses Vite **7.3.6** (MIT) and `@vitejs/plugin-react-swc` **4.3.3** (MIT), removing
the Lightning CSS dependency. The SWC binary's `Apache-2.0 AND MIT` expression
contains only approved identifiers. Vite 7.3 is an
[upstream maintained release line](https://vite.dev/releases); Vitest **5.0.2**
is retained and supports Vite 7. The exact dependency graph is locked.

Two overrides are scoped to jsPDF **4.2.1**. Its `fast-png` decoder is pinned to
**8.0.0** (MIT), which uses `fflate` (MIT) instead of pako. jsPDF uses its decode
API, whose image dimensions, samples and CRC option remain compatible; fast-png
8's encoder-option change is outside that call path. Its optional DOMPurify
dependency is removed because the board exporter uses SVG, never HTML strings.
An exact Vite alias resolves that optional import to a local module which throws
if called, so the unused HTML converter fails explicitly in development and
production. It does not substitute an identity function for sanitization.
The [jsPDF optional-dependency guidance](https://github.com/parallax/jsPDF/blob/v4.2.1/README.md#optional-dependencies)
documents the separate HTML path; the
[fast-png changelog](https://github.com/image-js/fast-png/blob/v8.0.0/CHANGELOG.md)
records the compressor change. Native PDF text/font/ink and image checks,
development SVG/PNG PDF export, and explicit HTML-converter rejection cover the
application’s export paths. Future jsPDF upgrades must recheck these scoped
overrides rather than silently broadening them.

The compatibility tests also reproduced a jsPDF 4.2.1 byte-order defect in
16-bit gray-alpha/RGBA PNGs with both the old 6.4 and new 8.0 decoder. Board PDF
export now converts only those images through the browser's validated pixel
path; standalone SVG and stored image bytes remain unchanged. Nine independent
PNG fixtures verify decoder samples, seven verify direct PDF color/mask streams,
and the native 16-bit-alpha test checks actual PDF raster colors and transparency
against the browser. This avoids modifying upstream jsPDF or pretending its
direct 16-bit-alpha API is correct.

Hocuspocus server, provider, and database extension are pinned to **4.7.0**.
The [official v4.7.0 release](https://github.com/ueberdosis/hocuspocus/releases/tag/v4.7.0)
explicitly includes [PR #1152](https://github.com/ueberdosis/hocuspocus/pull/1152),
which fixes [issue #1151](https://github.com/ueberdosis/hocuspocus/issues/1151).
The release tag is `6ddc75775b22fea83fab15cb7c8f9c84a45556f6`; the PR was merged as
`7fb9086` on 2026-09-09. `npm view @hocuspocus/provider@4.7.0 version gitHead`
returned that release version and full tag hash. The exact `4.7.0` database
extension also exists in the registry. npm returned Yjs `13.6.33` and ws `8.22.0`.

The defect is specifically Redis sync-reply routing: replies must reach their
requesting replica rather than every replica. The initial deployment uses one
authoritative process per board and no Redis. This pin is not a claim that HA
has been validated; three-replica regression testing remains mandatory before
enabling Redis. Every replica must use the same patched version.

## Phase 3 recheck — 2026-09-29

The root agent repeated registry and primary-source checks before Phase 3:
`npm view @hocuspocus/server version` returned `4.7.0`, and
`npm view troika-three-text version` returned `0.52.5`. The
[official Hocuspocus release](https://github.com/ueberdosis/hocuspocus/releases/tag/v4.7.0)
remains the latest release and explicitly includes PR #1152. Our pinned-version
integration and load tests cover the exercised behaviors; this does not establish
that every upstream regression is absent.

The [official Troika text README](https://github.com/protectwise/troika/tree/main/packages/troika-three-text)
states that `.woff` fonts are supported and `.woff2` is unsupported. The
[tldraw licensing page](https://tldraw.dev/community/license) still distinguishes
development defaults from a production license key requirement. This project
does not import tldraw code. `@y/hub` is unnecessary for the selected single-node
deployment and remains excluded; its license/stability must be checked if a
future HA design proposes it. `better-sqlite3` is pinned to `13.0.3`; its native
module was built and loaded successfully on the selected Mac with Node 26.8.1.

## Phase 5 recheck — 2026-09-29

Repeated registry queries during the production acceptance run again returned
Hocuspocus `4.7.0` and Troika `0.52.5`. The
[official Hocuspocus release](https://github.com/ueberdosis/hocuspocus/releases/tag/v4.7.0)
still displays Latest and includes PR #1152. The
[official Troika font documentation](https://protectwise.github.io/troika/troika-three-text/#font)
continues to list TTF/OTF/WOFF and explicitly excludes WOFF2. The
[tldraw licensing page](https://tldraw.dev/community/license) still limits its
default terms to development and requires an active trial, commercial, or hobby
key in production. No tldraw or `@y/hub` dependency was introduced. Local
regression and load evidence supports only its stated tested scope; no claim
that every possible upstream regression is absent is made.
