# Three.js collaborative whiteboard

A private, self-hosted whiteboard with shapes, pressure-aware drawing, native text editing, bound connectors, images, collaborative cursors, per-session undo, and PNG/SVG/PDF export. The document is a Yjs model; Three.js is its disposable visual projection.

Implementation and measured acceptance evidence are tracked against [the build plan](docs/BUILD_PLAN.md) in [the execution log](docs/EXECUTION_LOG.md). The selected initial benchmark/deployment machine is this Mac (Apple M1 Pro, 32 GiB); local results do not establish performance on other hardware.

## Run locally

Use Node.js 26 (the CI runtime), pnpm 9.15.9, and Chrome for browser tests. `.npmrc` enforces the package's allowed Node range (`^22.12.0 || ^24.0.0 || >=26.0.0`) during installation. Current local verification uses Node 26.8.1. Development needs two terminals:

```sh
pnpm install --frozen-lockfile
pnpm --filter @whiteboard/server provision myname
pnpm server
```

The provisioning command prints a generated password once. Set `WHITEBOARD_PASSWORD` to supply a password of at least 12 characters instead. Accounts are provisioned by the operator; there are no anonymous boards or public registration.

Owners can grant, change, or remove another account’s board access through Share. Operators can reset a password with `provision --reset-password <username>` (which revokes that account’s existing sessions), or revoke sessions with `provision --revoke-sessions <username>`. See the [account controls](packages/server/README.md) for deployment data-directory and live-connection behavior.

```sh
pnpm dev
```

Open [the development app](http://127.0.0.1:5173), sign in, and create a board. The app proxies its authenticated API and WebSocket connection to port 3001. Share a board with another provisioned username as an editor or viewer. `Connected` reports transport synchronization; it is not a separate disk-fsync receipt. Temporary offline edits remain in the current browser's IndexedDB and merge when the provider reconnects. A server capacity or update limit pauses synchronization and retains those edits for export. Retry explicitly after a temporary refusal; an oversized local replica can be exported, then discarded with confirmation to reopen the server's saved board. See [server resource limits](packages/server/README.md#collaboration-resource-limits) for defaults and configuration.

Renaming a board updates its saved title, collaborators’ open headings, rename dialogs, and export filenames.

When a session expires or is revoked, the board returns to sign-in at the same URL. Queued document edits stay on the device and sync after signing in again as the same account. Existing quota or rejected-update blocks still require their explicit recovery action.

The default server data directory is `packages/server/data` when launched through `pnpm server`. Set `WHITEBOARD_DATA_DIR` to an absolute directory to make its location explicit. It contains SQLite, immutable image files, and a private session-signing secret. Treat it as private user data.

## Production on this Mac

Build without `VITE_TEST_HOOKS`; production builds contain neither the test document hook nor the anonymous local test route.

```sh
VITE_TEST_HOOKS=0 pnpm --filter @whiteboard/app build
pnpm exec tsx scripts/deploy-local.ts
```

The helper rejects test bundles and port 3001 listeners outside its own launch agent. It provisions an `owner` account if needed, writes its credentials to a mode-0600 file, and starts the app at [127.0.0.1:3001](http://127.0.0.1:3001). Before reporting success it verifies the running launchd PID owns the listener, the served HTML/entry bundles exactly match the selected build, and the saved owner credentials authenticate against the expected database. It revokes that temporary verification session and prints paths/PID/build hash, never the password or token. The same server serves the built app, API, and WebSocket endpoint. Existing data and credentials survive redeployment.

Redeployment drains only this checkout's owned service and waits for its processes and listener to exit. A failed new launch is unloaded rather than left in a restart loop. The helper never force-kills a port owner. Stop the disposable browser-test fixture before deploying; its `/ready` response is not accepted as deployment proof. This is a per-user launch agent: it starts when this macOS user logs in, not before login.

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
Step verification and remaining feature work are tracked in the
[feature implementation ledger](docs/IMPLEMENTATION_STATUS.md).

Read [storage design and measured limits](docs/D3_STORAGE_INVESTIGATION.md), [dependency/license verification](docs/DEPENDENCY_VERIFICATION.md), and [server operations](packages/server/README.md) before changing persistence, pinned Yjs internals, or deployment topology. Schema 1 is rejected rather than silently mutated. Compaction preserves Yjs clocks and offline merge history; it does not erase retired-writer or deleted-generation information.

Use the server's `operations backup` and `operations restore` commands for a coherent SQLite/assets snapshot. Backups include the private session secret and verify hashes plus database integrity on restore. The tested 100,000-update drill records reload/projection time and a full database-plus-image restore. Historical measurements and retained summary reports remain linked from the acceptance audit; generated raw traces and images stay local.
