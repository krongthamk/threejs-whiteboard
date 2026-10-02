# Three.js collaborative whiteboard

A private, self-hosted whiteboard with shapes, pressure-aware drawing, native text editing, bound connectors, images, collaborative cursors, per-user undo, and PNG/SVG/PDF export. The document is a Yjs model; Three.js is its disposable visual projection.

Implementation and measured acceptance evidence are tracked against [the build plan](docs/BUILD_PLAN.md) in [the execution log](docs/EXECUTION_LOG.md). The selected initial benchmark/deployment machine is this Mac (Apple M1 Pro, 32 GiB); local results do not establish performance on other hardware.

## Run locally

Use Node.js 24 or 26+, pnpm 9.15.9, and Chrome for browser tests. The pinned toolchain also accepts Node 22.12+. Development needs two terminals:

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

Use the tool rail or `V` select, `R` rectangle, `O` ellipse, `N` note, `T` text, `C` connector, `P` pen, `E` eraser, and `H` pan. Hold Space to pan, use the wheel/trackpad, or zoom around the pointer. Double-click a text object or sticky note to edit. Escape cancels the active gesture. Native text selection, clipboard and IME stay inside the text editor; each completed edit is one undo step.

Drop or paste PNG/JPEG/WebP images, or use Add images. Original bytes stay in the private asset store; the document carries asset IDs. Images are limited to 20 MiB and the active GPU's maximum texture dimension. Copy/paste preserves element geometry, bindings and ordering between boards; referenced images are copied through authenticated source/destination checks.

Export the board or selection as PNG at 1×–4×, a self-contained SVG, or a single-page vector PDF. Background transparency is optional. PNGs larger than the GPU texture limit are tiled, subject to the browser's final canvas limit (32,767 pixels per side / 100 million pixels). Export reads the document snapshot, excluding selection handles, remote presence, and unfinished gestures. Fonts and image bytes are included in SVG/PDF. Latin and Japanese are the validated shipped font coverage; other scripts need suitable local fonts and equivalent tests. During native text editing, browser font fallback and punctuation spacing can differ from the committed canvas; text, selection and IME remain native. Committed sizing and export use the same measured font runs.

## Verification

```sh
pnpm typecheck
pnpm test
pnpm test:browser
pnpm test:app
pnpm test:routed
node scripts/license-audit.mjs
pnpm --filter @whiteboard/app build
```

`pnpm test:app` builds an isolated test bundle and starts a disposable authenticated server on 3001 plus the app on 5174. Stop the local deployment first to release 3001. Its generated accounts/data never enter deployment storage. `pnpm test:routed` runs the actual app through a two-owner router using separate server instances and shared same-host test SQLite; it checks both owners and reload persistence. S4 uses the separate spike test server on 4175. Install the test browser with `pnpm exec playwright install chrome` if needed.

Ordinary unit and browser runs write current artifacts under ignored `test-results/` using paths anchored to the repository or each Playwright test. Historical reports under `packages/model/reports/`, `spikes/model-kv/reports/` and `docs/benchmarks/` are refreshed only with `RECORD_EVIDENCE=1`; select that flag intentionally when recording replacement evidence.

Performance measurements require a quiet, hardware-accelerated browser. Do not run GPU benchmarks concurrently with browser export/UI tests. The Mac-specific app gate is opt-in:

```sh
RUN_APP_BENCHMARK=1 pnpm test:app
node spikes/renderer/run-benchmark.mjs
pnpm exec tsx packages/loadtest/src/live-model-fuzz.ts
pnpm loadtest
pnpm --filter @whiteboard/loadtest history
```

The live model harness uses three separately authenticated users and 10,000 concurrent pairs. The production load test uses 40 sockets at 5 document operations/s and 20 cursor updates/s for 30 minutes, recording raw samples, exact completion, latency, CPU, memory and persisted convergence. Short smoke tests do not satisfy that gate. Keep the host awake; interrupted or excessive-scheduler-gap runs are failures, not partial passes.

PDF raster inspection in the export suite is opt-in with `VERIFY_PDF=1` and PyMuPDF 1.26.4 installed in `/private/tmp/whiteboard-pdf`; ordinary browser tests still generate and download PDF. Shipped WOFF fonts and their licenses are committed; the TTF PDF containers can be regenerated with `scripts/build-export-fonts.py` and FontTools 4.59.2.

## Architecture and operations

- `packages/model`: coherent element schema, writer-owned causal registers, local Yjs history, geometry, text layout, SVG serialization.
- `packages/renderer`: instanced shapes, merged stroke chunks, lazy Troika text, image textures, transient selection/presence, tiled PNG rendering.
- `packages/app`: native input controller, React UI, camera session state, provider/IndexedDB, clipboard and export.
- `packages/server`: signed sessions, membership checks, SQLite WAL/FULL update log and compaction, private assets, static serving, router, drain and backup/restore.
- `packages/loadtest`: real network fuzz, production workload and history/restore drills.

Read [storage design and measured limits](docs/D3_STORAGE_INVESTIGATION.md), [dependency/license verification](docs/DEPENDENCY_VERIFICATION.md), and [server operations](packages/server/README.md) before changing persistence, pinned Yjs internals, or deployment topology. Schema 1 is rejected rather than silently mutated. Compaction preserves Yjs clocks and offline merge history; it does not erase retired-writer or deleted-generation information.

Use the server's `operations backup` and `operations restore` commands for a coherent SQLite/assets snapshot. Backups include the private session secret and verify hashes plus database integrity on restore. The tested 100,000-update drill records reload/projection time and a full database-plus-image restore. Raw failed baselines remain alongside replacement results so acceptance reports can be audited.
