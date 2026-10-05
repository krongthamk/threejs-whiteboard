# Three.js collaborative whiteboard

A browser whiteboard with shapes, pressure-aware drawing, native text editing, bound connectors, images, collaborative cursors, per-session undo, and PNG/SVG/PDF export. The document is a Yjs model; Three.js is its disposable visual projection.

Implementation and measured acceptance evidence are tracked against [the build plan](docs/BUILD_PLAN.md) in [the execution log](docs/EXECUTION_LOG.md). The selected initial benchmark/deployment machine is this Mac (Apple M1 Pro, 32 GiB); local results do not establish performance on other hardware.

## Browser-only demo (Vercel)

No sign-in, backend, database service, or hosting account for a backend is needed.

```sh
pnpm install --frozen-lockfile
pnpm dev:demo
```

Open http://127.0.0.1:5173. Boards and imported images save in this browser's
IndexedDB; the board list is in localStorage. **Share → Open another tab** tries
anonymous live edits and cursors in the same browser profile and site origin.
Sharing across devices or different browsers is deferred until a relay is available.
Clearing site data removes saved work. PNG/SVG/PDF exports are available; they are
not editable backups. Private browsing may discard data when its windows close.

`pnpm build:demo` creates the static production build. [Vercel setup](docs/VERCEL.md)
is configured in `vercel.json`, with demo mode enabled and no server service.
`pnpm test:demo` exercises local persistence and tab collaboration without a backend.

## Private self-hosted app (optional)

The original authenticated server remains available separately. These instructions
are not needed for the browser-only demo.

### Run locally

Google sign-in is temporarily disabled by default, including when OAuth credentials
are present. Use a provisioned username and password. To restore Google later,
set `WHITEBOARD_GOOGLE_ENABLED=1` with the settings in the
[Google configuration guide](packages/server/README.md#google-configuration),
then restart or redeploy the server. Setting it to `0` (or unsetting it) disables
Google again. Existing accounts and boards are preserved.

[`.env.example`](.env.example) lists optional server settings without credentials.
The server reads exported environment variables; it does not automatically load
`.env` files. No Google credentials are needed for local password sign-in.

Use Node.js 26 (the CI runtime), pnpm 9.15.9, and Chrome for browser tests. `.npmrc` enforces the package's allowed Node range (`^22.12.0 || ^24.0.0 || >=26.0.0`) during installation. Current local verification uses Node 26.8.1. Development needs two terminals:

```sh
pnpm install --frozen-lockfile
pnpm --filter @whiteboard/server provision myname
pnpm server
```

The password provisioning command prints a generated password once. Set `WHITEBOARD_PASSWORD` to supply a password of at least 12 characters instead. Operators provision password accounts; Google accounts require an explicit allowlist. There are no anonymous boards or public registration.

Owners can grant, change, or remove another account’s board access through Share. Operators can reset a password with `provision --reset-password <username>` (which revokes that account’s existing sessions), or revoke sessions with `provision --revoke-sessions <username>`. See the [account controls](packages/server/README.md) for deployment data-directory and live-connection behavior.

The server migrates legacy account storage transactionally while preserving existing accounts and schema-2 boards. Sessions include a display name and optional local avatar URL; backups and asset cleanup retain current avatar files.

Configured deployments show **Continue with Google** below the password form. Sign-in returns to the current board, including its query and fragment, with the usual HttpOnly session cookie. Display names appear in presence and profile pictures appear beside Sign out; a failed picture falls back to an initial. The server links verified identities to intended accounts and keeps pictures locally. Password sign-in remains available when Google is disabled or public configuration cannot load. See [Google configuration](packages/server/README.md#google-configuration).

Use `pnpm --filter @whiteboard/server provision --google 'teammate@example.com'` with the deployment's data directory to pre-create a Google account and share a board before its first sign-in. This creates no password and preserves a unique matching existing account. Follow the [operator setup](packages/server/README.md#operator-setup) for OAuth client, private secret file and allowlist settings.

Profiles and avatars are accessible only to their own account or users who share a board with that account. Every member, including a viewer, can read the board's member list through the [members API](packages/server/README.md#http-contract).

```sh
pnpm dev
```

Open [the development app](http://127.0.0.1:5173), sign in, and create a board. The app proxies its authenticated API and WebSocket connection to port 3001. Share a board with another provisioned username as an editor or viewer. `Connected` reports transport synchronization; it is not a separate disk-fsync receipt. Temporary offline edits remain in the current browser's IndexedDB and merge when the provider reconnects. A server capacity or update limit pauses synchronization and retains those edits for export. Retry explicitly after a temporary refusal; an oversized local replica can be exported, then discarded with confirmation to reopen the server's saved board. See [server resource limits](packages/server/README.md#collaboration-resource-limits) for defaults and configuration.

Renaming a board updates its saved title, collaborators’ open headings, rename dialogs, and export filenames.

When a session expires or is revoked, the board returns to sign-in at the same URL. Queued document edits stay on the device and sync after signing in again as the same account. Existing quota or rejected-update blocks still require their explicit recovery action.

The default server data directory is `packages/server/data` when launched through `pnpm server`. Set `WHITEBOARD_DATA_DIR` to an absolute directory to make its location explicit. It contains SQLite, immutable image files, and a private session-signing secret. Treat it as private user data.

## Push to GitHub

The repository includes a GitHub Actions workflow for type checking, unit tests,
dependency license checks, production builds, and browser tests. Google browser
tests use a disposable local provider and need no GitHub secrets or OAuth account.

Before pushing, run:

```sh
pnpm typecheck
pnpm test
VITE_TEST_HOOKS=0 pnpm --filter @whiteboard/app build
node scripts/check-production-hooks.mjs
git status --short
```

Keep runtime data, real `.env` files, passwords, and OAuth secrets local. The
ignore rules cover those files; the committed SQLite fixture contains synthetic
test data. Review new files before staging them.

For a new private repository, after committing the intended changes:

```sh
gh auth login --hostname github.com
gh repo create threejs-whiteboard --private --source=. --remote=origin --push
```

For an existing empty repository, add its URL with
`git remote add origin <repository-url>`, then run `git push -u origin main`.

## Production on this Mac

Build without `VITE_TEST_HOOKS`; production builds contain neither the test document hook nor the anonymous local test route.

```sh
VITE_TEST_HOOKS=0 pnpm --filter @whiteboard/app build
pnpm exec tsx scripts/deploy-local.ts
```

The helper rejects test bundles and port 3001 listeners outside its own launch agent. It provisions an `owner` account if needed, writes its credentials to a mode-0600 file, and starts the app at [127.0.0.1:3001](http://127.0.0.1:3001). Before reporting success it verifies the running launchd PID owns the listener, the served HTML/entry bundles exactly match the selected build, and the saved owner credentials authenticate against the expected database. It revokes that temporary verification session and prints paths/PID/build hash, never the password or token. The same server serves the built app, API, and WebSocket endpoint. Existing data and credentials survive redeployment.

Redeployment drains only this checkout's owned service and waits for its processes and listener to exit. A failed new launch is unloaded rather than left in a restart loop. The helper never force-kills a port owner. Stop the disposable browser-test fixture before deploying; its `/ready` response is not accepted as deployment proof. This is a per-user launch agent: it starts when this macOS user logs in, not before login.

The helper carries explicitly supplied Google settings into its private launch configuration. Prefer a mode-0600 secret file inside the deployment data directory; its contents are not copied into the plist. Supply the settings on each redeploy to keep Google enabled. See [operator setup](packages/server/README.md#operator-setup).

- Data and credentials: `~/Library/Application Support/ThreejsWhiteboard/`
- Launch agent: `~/Library/LaunchAgents/com.threejs-whiteboard.local.plist`
- Logs: `~/Library/Application Support/ThreejsWhiteboard/logs/`
- Stop: `launchctl bootout gui/$(id -u)/com.threejs-whiteboard.local`
- Start again: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.threejs-whiteboard.local.plist`

Provision another account in this deployment's data directory before sharing a board with that username:

```sh
WHITEBOARD_DATA_DIR="$HOME/Library/Application Support/ThreejsWhiteboard" pnpm --filter @whiteboard/server provision teammate
```

The optional deployment smoke (`pnpm exec tsx scripts/verify-local-deployment.ts`) creates a “Welcome to Whiteboard” demonstration board through the real production UI and verifies reload/export without test hooks. After redeploying, `pnpm exec tsx scripts/verify-local-deployment.ts --existing` checks that its exact exported content survived. It reads the private credentials file internally and does not print passwords or tokens.

This initial deployment listens on loopback. For a remote host, configure an HTTPS reverse proxy, approved origins, secure cookies, and a persistent data volume as described in [the server operations guide](packages/server/README.md). Redis and multi-host high availability are not enabled. The board-ID router is available and tested, but a second host requires shared transactional persistence and an explicit ownership transfer; an unhealthy shard is not silently reassigned.

## Editing and export

Use the tool rail or `V` select, `R` rectangle, `O` ellipse, `N` note, `T` text, `C` connector, `P` pen, `E` eraser, and `H` pan. Hold Space to pan, use the wheel/trackpad, or zoom around the pointer. Double-click a text object, sticky note, rectangle, or ellipse to edit its text. The Text tool also edits an existing shape; Enter edits a single selected rectangle or ellipse. Escape cancels an unfinished drawing gesture. In the text editor, Escape, blur, and Cmd/Ctrl+Enter commit valid text as one undo step; active IME composition finishes first. Native selection and clipboard stay inside the editor. If a peer removes the element or editing becomes view only, an explicit notice explains why changed text was not saved.

Shape labels use the shape's existing box. New labels start centered horizontally and vertically; the style panel provides font, size, horizontal alignment, and shape-only vertical alignment. Sticky text stays top-aligned. Empty shapes show a placeholder only while editing, and clearing a label restores an empty shape. Overflowing drafts scroll within a temporary editing area; very small shapes get enough room to edit a line. Saved labels remain clipped to their shape's content rectangle.

Choose **No fill** in the Fill palette to show content beneath a shape while
retaining its outline and label. The shape keeps its usual selection target;
PNG and SVG preserve the transparent interior.

Letter shortcuts follow physical key positions, including with non-Latin keyboard layouts. Board shortcuts yield to focused form controls, buttons, links, and summaries. Viewers can use the Select and Pan buttons; letter tool shortcuts leave their current tool unchanged.

On touch screens, use two fingers to pan or pinch to zoom. Adding the second finger cancels any unfinished drawing or edit gesture, without adding an undo step; navigation also works for viewers.

Undo history belongs to the current browser session. Two tabs signed in as the same account have separate histories, and reloading starts a new history. Concurrent edits to the same text object resolve to one complete draft, so another draft may be replaced. Simultaneous pastes from different sessions can interleave their elements in the stacking order.

The clock-storage update preserves saved schema-2 boards without migration. Reload already-open board tabs after deploying it.

Moving a connector preserves its shape bindings; only free endpoints move directly. Duplicating it with its targets binds the copy to the copied targets. If a target is not copied, the copied endpoint uses the target’s current position (or stored fallback), shifts by the copy offset, and becomes unbound. Shape labels travel with copied shapes, including their source text, font, and alignments. Labels do not change the shape's hit target or selection frame.

Text outside the shipped font coverage remains editable and saved, with a warning that layout may be approximate. PDF export explicitly rejects unsupported characters. The board warns once per unsupported character set during each session.

Drop or paste PNG/JPEG/WebP images, or use Add images. Image bytes stay in the private asset store; the document carries asset IDs. Uploads with EXIF rotation or mirroring are normalized to PNG pixels; legacy photos receive the same correction for SVG/PDF export. Images are limited to 20 MiB, 16,384 pixels per side, 100 million pixels, and the active GPU's maximum texture dimension. The server, importer, and renderer check encoded dimensions before decoding; a mismatched image instance displays a placeholder. Copy/paste preserves element geometry, bindings and ordering between boards; referenced images are copied through authenticated source/destination checks. Mutating requests recheck the current session and permissions after the request body arrives, in the same transaction as the write.

Views are bounded to one million document units from the origin on each axis. The canvas adapts when display pixel density changes, including between monitors, with a pixel ratio capped at two.

Export the board or selection as PNG at 1×–4×, a self-contained SVG, or a single-page vector PDF. Background transparency is optional. PNG export reuses tiles up to 4,096 pixels per side, limited further by the GPU, subject to the browser's final canvas limit (32,767 pixels per side / 100 million pixels). A lost graphics context reports an error and a new export can retry. Export reads the document snapshot, excluding selection handles, remote presence, and unfinished gestures. Only used fonts and referenced image bytes are included in SVG/PDF. Exports retain glyphs too small to display on screen; shape labels remain clipped to their inset boxes. Latin and Japanese are the validated shipped font coverage; other scripts need suitable local fonts and equivalent tests. During native text editing, browser font fallback and punctuation spacing can differ from the committed canvas; text, selection and IME remain native. Committed sizing and export use the same measured font runs.

Closing the export dialog cancels preparation and prevents a late download. Unavailable or corrupt images use placeholders in PNG, SVG and PDF; the completed download keeps the dialog open with a list of affected asset IDs. Valid instances of a shared image remain included.

SVG and PDF report an error when text, IDs, or titles contain characters XML cannot
represent; a failed export leaves the board and undo history unchanged.

PDF export converts 16-bit PNGs with alpha to 8-bit display pixels to preserve
their colors and transparency. Their stored files and standalone SVG bytes stay
unchanged.

Line wrapping keeps grapheme clusters together, including combining accents, emoji sequences, flags and decomposed Hangul. Glyph coverage is still limited to the shipped fonts.

Text, sticky notes, and shape labels allow up to 50,000 UTF-16 units; some emoji count as two. Over-limit insertions are rejected visibly without truncating the existing draft. Layout positioning waits briefly during typing above 5,000 units; camera, resize and peer geometry changes update immediately. Existing saved text above the limit is quarantined with an invalid-item notice, never silently shortened.

The document model rejects incomplete Unicode characters before saving text or pasting clipboard content. Coordinates, stroke widths, and derived element dimensions are limited to one billion document units; font size is limited to 1024. A batch that exceeds these limits is rejected before any element changes. Unsupported document schemas remain available for recovery but cannot be edited, undone, or redone.

## Import from Excalidraw

Add images also accepts `.excalidraw` files. Drop a file on the canvas or paste
Excalidraw clipboard JSON to merge it into the current board. Import requires
edit access and a live connection with existing changes acknowledged. Imported
elements keep their source coordinates when visible; an entirely offscreen
scene moves into the viewport. The app selects and fits the imported elements
and shows a dismissible report of skipped records and conversions. Embedded
images are decoded, cropped after EXIF orientation, and flipped before upload.

Version-2 files and Excalidraw clipboard payloads use these mappings:

| Source content | Imported result and reported changes |
| --- | --- |
| Rectangle, ellipse | Editable native shapes; transparent fills remain unfilled. |
| Diamond | Editable rectangle; the shape substitution is reported. |
| Text and shape-bound text | Editable text or a native shape label. Labels reflow within the shape insets; native font metrics determine wrapping and size. Unsupported or additional container labels remain free text. |
| Fonts | Cascadia becomes IBM Plex Mono; other source fonts become Inter, with shipped Japanese fallback. Font substitutions are listed. |
| Freedraw and line | Native pressure strokes. Freehand pressure is retained; outlines, line routing and width can differ. |
| Arrow | Native straight, curved or elbow connector. Valid target bindings follow the imported targets; native routing, gap projection and arrowhead changes are reported. Missing or invalid targets retain point endpoints. |
| Embedded PNG, JPEG, WebP | Private image assets with validated dimensions; EXIF orientation, crop and flips are baked into uploaded pixels. SVG/GIF, missing files and invalid images are skipped with reasons. |
| Frame or magic frame | Transparent rectangle, with its name when present. Frame membership and clipping are dropped. |
| Groups | Group structure is dropped; the report gives the number of affected groups. |
| Roughness, hatch, dashes, rounded corners | Native geometry, solid fills and solid strokes replace these effects; visible losses are reported. |
| Links and locks | Dropped and reported. |
| Embeddables, iframes, unknown types, malformed elements | Skipped individually with reasons. Deleted source records are omitted. |

The report counts native output elements, so a shape and its absorbed label count
as one. Download the full report to inspect every reason and substitution.
Repeated imports use fresh IDs and create additional copies.

Excalidraw sources are limited to 50 MiB, 10,000 records, and 100 active images.
The app checks the server's actual update and storage limits before writing.
A fitting import takes one undo step. Larger imports use consecutive batches
of at most 500 elements, reduced further to fit byte and resource limits; each
batch takes a separate undo step. Batches wait for server acknowledgements.
If the connection or available capacity changes, import stops and reports
what was added locally and what was acknowledged. An acknowledgement means
server application, not a separate disk-durability receipt. A stopped-import
report records acknowledgements at the time it stopped; retained local changes
can finish syncing after reconnection.

## Verification

Run the commands below from the workspace root. Package `typecheck` scripts explicitly delegate to the root project; model and server `test` scripts run only their package tests with the root Vitest configuration. The root suite also includes maintained command and PDF verification tests in `tests/unit/`.

```sh
pnpm typecheck
pnpm test
pnpm test:browser
pnpm test:app
pnpm test:routed
node scripts/license-audit.mjs
pnpm --filter @whiteboard/app build
```

The license audit requires every SPDX identifier, including every branch of a
compound expression, to appear in the project's explicit allowlist. Unknown or
missing licenses fail. [Dependency verification](docs/DEPENDENCY_VERIFICATION.md)
records the pinned tooling and PDF decoder choices that satisfy this policy.

`pnpm test:app` builds an isolated test bundle and starts a disposable authenticated server on 3001 plus the app on 5174. Stop the local deployment first to release 3001. Its generated accounts/data never enter deployment storage. `pnpm test:routed` runs the actual app through a two-owner router using separate server instances and shared same-host test SQLite; it checks both owners and reload persistence. S4 uses the separate spike test server on 4175. Install the test browser with `pnpm exec playwright install chrome` if needed.

The default app suite checks Google-disabled and unavailable-config password
login. CI also runs the enabled Google flow against an ephemeral local provider,
with separate artifacts and no real Google credentials:

```sh
WHITEBOARD_TEST_GOOGLE=1 PLAYWRIGHT_HTML_OUTPUT_DIR=playwright-report/google-auth pnpm exec playwright test --config playwright.app.config.ts tests/app/google-auth.spec.ts --output test-results/google-auth
```

Run it separately from the other browser suites. The Playwright configuration
sets `NODE_ENV=test` only for the disposable server; leave it unset for the client
build. Both fixture and provider require explicit test mode, and production
ignores the provider override. The tests exercise the actual sign-in link, code
exchange, board return, cookie session, avatar, peer name, refusal and fallback.

Ordinary unit and browser runs write current artifacts under ignored `test-results/` using paths anchored to the repository or each Playwright test. Generated process logs, benchmark traces, screenshots, and PDFs are ignored. Historical audit-linked summary JSON and font metrics evidence remain tracked; new outputs stay local. Historical reports under `packages/model/reports/`, `spikes/model-kv/reports/` and `docs/benchmarks/` are refreshed only with `RECORD_EVIDENCE=1`; select that flag intentionally when recording replacement evidence. Spike builds use the application's public fonts instead of maintaining duplicate copies.

Performance measurements require a quiet, hardware-accelerated browser. Do not run GPU benchmarks concurrently with browser export/UI tests. The app hardware gates run when selected locally or through the macOS `workflow_dispatch` benchmark job, which runs the app and renderer benchmarks sequentially:

```sh
RUN_APP_BENCHMARK=1 pnpm test:app
node spikes/renderer/run-benchmark.mjs
pnpm exec tsx packages/loadtest/src/live-model-fuzz.ts
pnpm loadtest
pnpm --filter @whiteboard/loadtest history
```

The live model harness uses three separately authenticated users and 10,000 concurrent pairs. The production load test uses 40 sockets at 5 document operations/s and 20 cursor updates/s for 30 minutes, recording raw samples, exact completion, latency, CPU, memory and persisted convergence. Short smoke tests do not satisfy that gate. Keep the host awake; interrupted or excessive-scheduler-gap runs are failures, not partial passes.

The macOS browser CI job installs PyMuPDF 1.26.4 and sets `VERIFY_PDF=1`, so PDF text, font, and ink inspection always runs there. To run the same inspection locally, install that version for `python3` and set `VERIFY_PDF=1`; set `PDF_PYTHONPATH` when using a custom installation directory. Without the flag, local browser tests still generate and download PDF. Tile tests always exercise multiple GPU render targets and record why a controlled boundary was needed when the native texture limit exceeds the browser canvas limit. Shipped WOFF fonts and their licenses are committed; the TTF PDF containers can be regenerated with `scripts/build-export-fonts.py` and FontTools 4.59.2.

## Architecture and operations

- `packages/model`: coherent element schema, writer-owned causal registers, local Yjs history, geometry, text layout, SVG serialization.
- `packages/renderer`: instanced shapes, merged stroke chunks, lazy Troika text, image textures, transient selection/presence, tiled PNG rendering.
- `packages/app`: native input controller, React UI, camera session state, provider/IndexedDB, clipboard and export.
- `packages/server`: signed sessions, membership checks, SQLite WAL/FULL update log and compaction, private assets, static serving, router, drain and backup/restore.
- `packages/loadtest`: real network fuzz, production workload and history/restore drills.

The schema-2 model accepts text blocks on rectangles and ellipses.
`BoardDocument.setShapeText(id, text)` stores a label in one undo step without
changing the shape's box; an empty string restores empty props. New labels use
center/middle alignment, while existing labels retain their alignment. Shared
layout metadata provides separate ellipse insets and signed vertical offsets.
The live canvas and PNG/SVG/PDF exports position labels inside those insets and
clip overflow to the content rectangle. Labels follow shape rotation and
stacking order; the renderer retains its ready text mesh during position or
color changes. Font coverage includes stored shape text even when clipped or
hidden: unsupported glyphs produce a warning and prevent PDF export.
The model package also exposes `importExcalidraw(json, options)` for Excalidraw
version-2 files and clipboard envelopes. It returns validated native elements
with fresh IDs, image payloads, and a report of skipped records and lossy
conversions. Bound shape labels and supported arrow bindings remain editable;
image crops and flips are described for the app to bake during asset upload.
Image asset IDs in this pure result are temporary and must be replaced before
insertion. The converter caps source JSON at 50 MiB, raw elements at 10,000 and
active images at 100; file callers must check original bytes before parsing.
`planImport(board, elements, options)` stages exact same-writer transactions
without changing the live document or undo history. It checks framed bytes,
decoded resources, accepted append bytes, and reconnect history against an
authenticated server budget. Callers replay only the first batch synchronously
after `isImportPlanCurrent`; following an await or commit, they fetch a fresh
budget and replan the remaining elements. Staged update bytes are evidence and
must never be applied to the live writer.
Step verification and app integration work are tracked in the
[feature implementation ledger](docs/IMPLEMENTATION_STATUS.md).

Read [storage design and measured limits](docs/D3_STORAGE_INVESTIGATION.md), [dependency/license verification](docs/DEPENDENCY_VERIFICATION.md), and [server operations](packages/server/README.md) before changing persistence, pinned Yjs internals, or deployment topology. Schema 1 is rejected rather than silently mutated. Compaction preserves Yjs clocks and offline merge history; it does not erase retired-writer or deleted-generation information.

Use the server's `operations backup` and `operations restore` commands for a coherent SQLite/assets snapshot. Backups include the private session secret and verify hashes plus database integrity on restore. The tested 100,000-update drill records reload/projection time and a full database-plus-image restore. Historical measurements and retained summary reports remain linked from the acceptance audit; generated raw traces and images stay local.
