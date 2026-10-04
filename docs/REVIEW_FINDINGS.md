# Review findings and fix instructions

Generated 2026-09-30 from seven independent review passes over commit `fed369b` (full-repo code review, security audit, three adversarial reviews covering the collaboration model, the app/renderer, and tests/CI/docs, an over-engineering audit, and an independent Codex pass). Every finding below was verified against the code; items marked **reproduced** were triggered by a script during the review.

This file is written for an AI agent to work through. Read the "Working rules" section first.

## Working rules for the fixing agent

- Work through Tier 1 in order, then Tier 2, then Tier 3. Do not start Tier 4 (scope decisions) without an explicit instruction from the user.
- One commit per numbered finding, or per closely related group. Reference the finding number in the commit message.
- Before touching code, run `pnpm typecheck` and `pnpm test` to establish a green baseline. After each fix, run them again plus any test you added.
- `pnpm test` currently rewrites `packages/model/reports/s2-schema2-fuzz.json`. Until finding 6 is fixed, run `git checkout -- packages/model/reports/` after every unit run so that file does not enter your commits.
- Browser suites (`pnpm test:browser`, `pnpm test:app`, `pnpm test:routed`) bind ports 3001, 4175 and 5174. Stop any local deployment first (`launchctl bootout gui/$(id -u)/com.threejs-whiteboard.local`). Never run them in parallel with each other.
- Do not run `pnpm loadtest`, the deploy script, or anything under `packages/loadtest` unless a finding requires it.
- Every fix to a defect gets a regression test. A finding is not done until its test fails on the old code and passes on the new code.
- Keep the README and `packages/server/README.md` truthful. If a fix changes behaviour they describe, update the sentence in the same commit.
- Do not modify anything under `docs/benchmarks`, `packages/loadtest/results`, or `packages/model/reports` except as instructed by finding 6 and finding 19.
- Reviewers verified the following and you should not change them: HMAC session signing and per-packet authorization, CSRF Origin gating, static path-traversal handling, upload magic-byte checks, parameterised SQL, backup manifest verification, compaction clock preservation, and the resource cleanup on unmount and board switch.

Checklist legend: `[ ]` open, `[x]` done. Update the boxes as you go.

---

## Tier 1. Fix before relying on the app

### [x] 1. A storage error inside the Yjs update hook kills the whole server (critical, reproduced)

**Where:** `packages/server/src/server.ts:194-200` (`onChange`), also `:154`; `packages/server/src/store.ts:92-108` (`appendUpdate`, `compact`).

**Problem:** Hocuspocus 4.7.0 calls the `onChange` hook without awaiting it and its hook runner rethrows errors. Any exception from `appendUpdate`, `compact` or `Y.encodeStateAsUpdate` (disk full, `SQLITE_IOERR`, `SQLITE_BUSY`) becomes an unhandled promise rejection. Node's default `--unhandled-rejections=throw` exits the process with code 1, after the update was already applied in memory, broadcast to peers, and acknowledged to the sender. Under the launchd agent (`KeepAlive`, `ThrottleInterval 10`) the server restarts and crash-loops on the next edit while the condition persists. The triggering update is not in the log. Reproduced: a real server with `appendUpdate` stubbed to throw `SQLITE_FULL` on one update exited with code 1.

**Fix:**
1. Wrap the body of `onChange` in try/catch.
2. On failure: log with the board id, mark that document as persistence-failed in a per-document map, and call the existing `resetConnection(...)` path for every connection on that document with a new reason `persistence-failed`, so clients keep their Y.Doc plus IndexedDB replica and resubmit on reconnect. Refuse to unload a document while it is in that state.
3. Make `/ready` return 503 while any document is persistence-failed.
4. In `packages/server/src/index.ts` register `process.on('unhandledRejection', ...)` that logs and begins the existing drain rather than exiting.
5. Add a test in `packages/server/src/server.test.ts` that stubs `store.appendUpdate` to throw once, sends one update through a real provider, and asserts the listener is still accepting connections and the client received the reset reason.
6. Update `packages/server/README.md` "Collaboration and persistence" to describe the behaviour on a storage error.

### [x] 2. Any editor can brick a board for every member, permanently (critical, reproduced)

**Where:** `packages/model/src/document.ts:205-224` (`read`/`readAll` throw on any invalid element), `:261-262` (`delete` calls `readAll` first), `:297-298` (`reorder` calls `readAll`), `:117` (`refresh` trusts `value.stamp.clock` and `JSON.parse(key)`); `packages/app/src/runtime.ts:55-64` (subscriber calls `board.read` inside the Yjs observer); `packages/app/src/minimap.tsx:22` (`readAll` in render); `packages/app/src/main.tsx:6` (no error boundary); `packages/server/src/server.ts:185` (`beforeSync` validates dirty writes only for viewers).

**Problem:** The server persists every editor update with no content validation. An editor client (malicious, buggy, or a build with different validation rules) can push: a writer record whose element fails `assertValidElement` (e.g. `x: 'nope'`), a record whose key is not JSON, a record with a missing stamp, or a foreign `meta.schemaVersion`. After that, on every replica: the exception escapes `Y.applyUpdate` through the runtime subscriber; `readAll` throws forever so delete, reorder, export, copy, select-all and the minimap all fail; the poisoned id cannot be deleted because `delete` projects the whole board first; the minimap throws during React render with no boundary so every member including the owner gets a blank page on reload. No prune or repair command exists. Reproduced in-memory with two replicas.

**Fix:**
1. In `BoardDocument.readAll`, skip elements that fail validation instead of throwing. Collect their ids into an `invalidIds: Set<string>` exposed on the document, and emit them through the subscription payload so the app can show a notice.
2. Make `delete(ids)` write a null base for an id when `this.get(baseKey(id)) !== undefined` without projecting the element. Make `reorder` skip invalid ids rather than throwing.
3. In `refresh` and writer discovery, guard `JSON.parse(key)` and the `stamp` shape; ignore malformed records and count them.
4. Add an error boundary component around `EditorBoard` in `packages/app/src/App.tsx` that shows the existing error banner and a "Reload board" action.
5. Server side, in `beforeHandleMessage` or `beforeSync`, decode the incoming update against a throwaway `Y.Doc` clone, run the same record and `meta` validation, and reject the message plus reset the connection (same path as the read-only rejection) when it fails. Do not rely on rolling back an already-applied transaction.
6. Add `operations prune-element <boardId> <elementId>` to `packages/server/src/operations.ts` and `backup-cli.ts`.
7. Tests: model test where replica B pushes a malformed base record and replica A can still `readAll`, `delete('bad')`, and `reorder`; server test that a malformed update from an editor is rejected and the board stays readable; an app test that the error boundary renders.

### [x] 3. No size cap or backpressure on Yjs updates (high, reproduced)

**Where:** `packages/server/src/server.ts:156` (Hocuspocus server construction, no `websocketOptions`), `:194-199` (`onChange` persists verbatim), `packages/server/src/store.ts:103-108` (compaction re-encodes the whole document past 5 MiB).

**Problem:** The ws default `maxPayload` of 100 MiB applies. Every accepted update is written to SQLite and, once the log passes 5 MiB, triggers a full-document re-encode and snapshot rewrite. Reproduced: a single 24 MiB update from an editor was accepted and persisted (snapshot 25,165,936 bytes), harness RSS reached about 580 MiB. Outbound sends never check `bufferedAmount`, and Hocuspocus's idle check uses the last received message, so a slow consumer that sends occasional inbound messages grows server memory without bound. Inbound queues are also unbounded after authentication.

**Fix:**
1. Pass `websocketOptions: { maxPayload: 4 * 1024 * 1024 }` (or a `WHITEBOARD_MAX_UPDATE_BYTES` config value) to the Hocuspocus server.
2. In `beforeHandleMessage`, reject any document update larger than that limit and reset the connection.
3. Add a per-board ceiling (snapshot bytes plus log bytes) in the store; when exceeded, refuse writes with a stateless `board-full` message and log it.
4. Add a per-socket high-water mark check on `bufferedAmount` before broadcasting; terminate sockets that stay above it for more than a few seconds. Drop stale awareness for slow sockets rather than queueing it.
5. Tests: an oversized update is rejected and the log size does not change; a socket that never drains is closed.

### [x] 4. Production deploy keeps Vite dev origins in the CORS allowlist and returns the bearer token (high, reproduced)

**Where:** `packages/server/src/server.ts:21` (default origins include localhost and 127.0.0.1 on 4173, 5173, 5174, 3001), `:66-67` (reflects allowlisted Origin with `Access-Control-Allow-Credentials: true`), `:76` (Bearer requests exempt from Origin check), `:94` (`GET /api/session` returns the raw token); `scripts/deploy-local.ts:109` (launch agent env has no `WHITEBOARD_ORIGINS`); `packages/server/src/config.ts:29`.

**Problem:** The cookie is `SameSite=Lax`, which is same-site with any other server on 127.0.0.1. A page served by any other project's `vite dev` on 5173 can `fetch('http://127.0.0.1:3001/api/session', {credentials:'include'})`, get the token, and then use `Authorization: Bearer` from anywhere for 12 hours. Reproduced with a valid cookie and `Origin: http://localhost:5173`.

**Fix:**
1. In `scripts/deploy-local.ts`, set `WHITEBOARD_ORIGINS` to `http://127.0.0.1:3001,http://localhost:3001` in the launch agent environment.
2. In `createWhiteboardServer`, include the 4173/5173/5174 defaults only when no `staticDirectory` is configured.
3. Stop returning `token` from `GET /api/session` to cookie-authenticated callers; the WebSocket `onAuthenticate` already accepts the cookie. Check `packages/app/src/account.tsx` and `collaboration.ts` for any code path that needs the token and route it through the cookie instead.
4. Test: with a static directory configured, a request with `Origin: http://localhost:5173` gets 403.

### [x] 5. The CI workflow cannot pass on ubuntu-latest (high)

**Where:** `.github/workflows/ci.yml:17-19`; `tests/app/text.spec.ts:26, 105, 110`; `tests/app/assets.spec.ts:38, 71, 98, 172`; 27 `Meta+` occurrences across `tests/app/*.spec.ts` (assets 10, text 6, controller 5, core 3, text-layout 2, collaboration 1).

**Problem:** Native select-all, cut, copy and paste inside the contenteditable and the window clipboard listeners are driven with `Meta+` chords. Linux Chrome only honours Control for these. Two text tests fail deterministically on Linux and three asset tests very probably fail. All committed evidence is from local Mac runs; nothing shows CI has ever run. Additionally every pixel assertion in `image-export.spec.ts`, `export.spec.ts`, `tiles.spec.ts`, `text-layout.spec.ts` and `controller.spec.ts` was tuned on ANGLE/Metal and has never run on SwiftShader.

**Fix:**
1. Replace every `Meta+` in `tests/app/*.spec.ts` with `ControlOrMeta+` (the pattern `tests/browser/text-spike.spec.ts:147-150` already uses).
2. Split the workflow: keep typecheck, unit tests, license audit and build on `ubuntu-latest`; run the three browser suites on `macos-latest`.
3. Add `timeout-minutes: 45` and a `concurrency` group to the workflow.
4. Add a step after the app build that fails if `packages/app/dist` contains the string `whiteboardConnection` (test hooks leaked into a production bundle).
5. Verify locally with `pnpm test:app` before pushing.

### [x] 6. Test runs rewrite tracked files (high, reproduced)

**Where:** `packages/model/test/fuzz.test.ts:141` (writes `packages/model/reports/s2-schema2-fuzz.json`), `packages/model/test/writer-storage.test.ts:116-117`; Playwright write sites: `tests/app/collaboration.spec.ts:92`, `export.spec.ts:36, 42, 98-100, 108`, `image-export.spec.ts:116-117, 158-159, 190-191`, `pdf.spec.ts:49-53, 85`, `performance.spec.ts:39, 43`, `text-layout.spec.ts:41, 114-117, 162, 190, 228-229`, `tiles.spec.ts:29, 58`.

**Problem:** Paths are cwd-relative and point at tracked directories. `pnpm test` changes `durationMs` in a tracked file on every run. `pnpm test:model` (cwd `packages/model`) writes to `packages/model/packages/model/reports/`; the repo already contains this exact artefact of the pattern at `packages/loadtest/packages/loadtest/results/`. The "raw evidence" linked from `docs/ACCEPTANCE_AUDIT.md` is overwritten by any later run.

**Fix:**
1. Resolve all output paths from `import.meta.url` (or Playwright's `testInfo.outputPath`) and write to `test-results/<suite>/`, which is already git-ignored and uploaded by CI.
2. Copy into `docs/benchmarks` and `packages/model/reports` only when `RECORD_EVIDENCE=1`, the same gate `tests/browser/text-spike.spec.ts:26` already uses for `RECORD_SPIKE_RESULTS`.
3. `git rm -r packages/loadtest/packages` and add `packages/loadtest/packages/` to `.gitignore`.
4. Verify: `git status --short` is empty after `pnpm test` and after `pnpm test:app`.

---

## Tier 2. Should fix soon

### [x] 7. Adding or removing any element rebuilds the entire projection (high, measured)

**Where:** `packages/renderer/src/index.ts:121` (`orderingChanged` true when `!previous || !value`), `:134` (depth is `rank / n * 100`), `:139`, `:167`, `:199`, `:205-209` (connectors always rebuilt); `packages/renderer/src/strokes.ts:21` (depth baked per vertex).

**Problem:** Any count change invalidates every stroke chunk, shape batch and connector. Measured 863 ms to rebuild the 20 stroke chunks of a 5,000-stroke board, plus a fresh `InstancedMesh` per shape type. This cost is paid on: committing a pen stroke, each eraser hit (`controller.ts:191`), pointerdown and pointerup with every create tool (`controller.ts:120/126/131`, preview ids), undo, redo, paste, duplicate, delete, and every remote peer's add or delete. The renderer README's "a stroke edit replaces only its affected chunk" holds only for in-place edits. `tests/app/performance.spec.ts` measures static FPS only.

**Fix:**
1. Decouple depth from geometry: either a separate per-vertex/per-instance depth attribute updated with `addUpdateRange`, or a stable rank-to-depth mapping that does not change with count (renormalise only when keys run out of headroom).
2. Reuse stroke chunks whose member ids are unchanged; rebuild only chunks containing changed ids.
3. Rebuild connectors only for changed ids and their dependents (the `HitIndex.dependents` map already tracks bindings).
4. Add a benchmark to `tests/app/performance.spec.ts`: commit one stroke on a 5,000-stroke board in under 16 ms of main-thread time, and one eraser sweep hitting 10 strokes under 50 ms.
5. Update `packages/renderer/README.md` to describe the actual invalidation rule.

### [x] 8. Every create-tool pointerdown and every select-all deserialises the whole document (medium, measured)

**Where:** `packages/app/src/controller.ts:90` (`nextIndex` calls `board.readAll()`), called from `:111, :118, :124, :129`; also `:294` (`zoomToFit`), `:316` (Cmd+A), `:68-84` (`selected()` reads each selected id per pointermove and per revision); `packages/app/src/assets.ts:110, 174`; `packages/app/src/minimap.tsx:22`; `packages/app/src/App.tsx:149`; `packages/model/src/document.ts:147-157` (`highestIndex()` is private and already incremental).

**Problem:** `readAll` costs about 160 ms at 10,000 elements (structured clone, validation, geometry derivation, sort). Any shape, stroke, text or connector start lags by that before the first preview frame. After Cmd+A, each pointermove reads every selected element (about 140 ms).

**Fix:**
1. Make `highestIndex()` public on `BoardDocument` and add `nextIndex()` that returns `generateKeyBetween(highestIndex(), null)`. Use it in the controller, assets and clipboard paths.
2. Replace `readAll()` in `zoomToFit`, Cmd+A and the minimap with iteration over `hitIndex.elements`, which the same subscription keeps current.
3. Cache the selection frame in the controller; invalidate only when a selected id changes.
4. Add a unit test that `nextIndex()` matches the previous `readAll().at(-1)` behaviour.

### [x] 9. Board membership can be granted but never revoked (medium)

**Where:** `packages/server/src/server.ts:114-126` (members route only allows editor/viewer), `:68` (`Access-Control-Allow-Methods` has no DELETE); `packages/server/src/store.ts:85` (`setMember`, no `removeMember`); `packages/server/README.md` HTTP table.

**Problem:** A departed collaborator keeps permanent read access to the board, its WebSocket document and every asset, and can copy the board's images into their own boards through `POST /api/boards/<own>/assets/copy`. The operator cannot reset a password or revoke a compromised account's sessions without editing SQLite.

**Fix:**
1. Add `Store.removeMember(boardId, userId)`, `Store.setPassword(username, password)`, `Store.revokeSessions(userId)`.
2. Add `DELETE /api/boards/:id/members/:username` (owner only, refuse removing the owner). After removal call the existing `resetConnection(conn, boardId, null, 'permissions-changed')` path for that user's live connections. Add DELETE to the allowed methods and the preflight.
3. Add `provision --reset-password <username>` and `provision --revoke-sessions <username>` to `packages/server/src/provision.ts`.
4. Add a remove control to the Share dialog in `packages/app/src/App.tsx` (`BoardSettings`), and a client method in `api.ts`.
5. Document the route in `packages/server/README.md`. Tests in `server.test.ts` for removal, owner protection and live reset.

### [x] 10. A PNG decompression bomb crashes every viewer's tab (medium)

**Where:** `packages/app/src/assets.ts:74-76` (`createImageBitmap(blob)` to learn size, then `:83` check), `:163` (`importClipboard` trusts envelope `naturalW/H`); `packages/server/src/server.ts:129-136` (20 MiB plus magic bytes only); `packages/renderer/src/images.ts:99` (viewers fully decode).

**Problem:** A 30,000 by 30,000 solid PNG compresses under 1 MiB. The uploading client decodes 3.6 GB of pixels before rejecting. A user bypassing the client (curl upload with valid magic bytes plus a raw Yjs image element with modest declared size) makes every peer's renderer decode the bomb when it scrolls into view.

**Fix:**
1. Add a shared `packages/model/src/image-header.ts` that reads width and height from PNG IHDR (bytes 16-24), JPEG SOFn markers, and WebP VP8/VP8L/VP8X chunks without decoding.
2. Server: after the magic-byte check, parse the header, reject when either side exceeds 16,384 or the pixel count exceeds 100,000,000, and return `width` and `height` in the upload response.
3. Client: use the header parser before `createImageBitmap`; use the server-returned dimensions for `naturalW/H`.
4. Renderer: before decoding, compare header dimensions with the element's `naturalW/H` and skip with a placeholder on mismatch or over-limit.
5. Tests: server rejects a crafted 30k by 30k IHDR; model unit tests for the three parsers.

### [x] 11. Dragging a text or sticky destroys and re-typesets its mesh every frame (medium)

**Where:** `packages/renderer/src/index.ts:123` (`flush` disposes text for every queued id), `:319` (`createText` on next visible pass), `:344-354` (placeholder until async `sync` completes).

**Problem:** Troika's `Text.sync` is worker-based and never completes inside the same render call, so every pointermove during a drag shows a grey placeholder, on the dragger's screen and every observer's.

**Fix:**
1. In `flush`, diff previous and next element. If only `x`, `y`, `rotation`, `index`, `opacity` or `color` changed, update `mesh.position`, `rotation`, `renderOrder`, `fillOpacity` and `color` in place and keep the handle.
2. Relayout only when `text`, `w`, `fontSize`, `fontFamily`, `align`, `autoSize` or `type` change. When relayout is required, keep the old mesh visible until the replacement's sync callback fires.
3. Test in `tests/app/text.spec.ts`: during a drag, the renderer stats report zero text disposals.

### [x] 12. Lone UTF-16 surrogates silently diverge between replicas (medium, reproduced)

**Where:** `packages/model/src/schema.ts:14` (`assertJson` accepts any string); `packages/app/src/clipboard-model.ts:34` (`validateEnvelope`).

**Problem:** Yjs encodes strings through `TextEncoder`, which replaces a lone surrogate with U+FFFD. The writer's live document keeps the original string while its own IndexedDB reload, the server and every peer hold a different one. Reproduced: local `"x\ud83dy"`, replica `"x�y"`.

**Fix:** In `assertJson`, reject strings where `!value.isWellFormed()` (or normalise with `toWellFormed()` before writing and document that choice). Apply the same check in `validateEnvelope` and in the text editor commit path. Add a unit test with a lone surrogate.

### [x] 13. `update()` validates stale geometry, so a patch can create an element nobody can move or export (medium, reproduced)

**Where:** `packages/model/src/document.ts:225-231` (`preparePatch` asserts the already-derived read merged with the new props); `packages/model/src/geometry.ts:19-27`; `packages/model/src/schema.ts:36` (finite check only, no magnitude bound).

**Problem:** `update(strokeId, { props: { points: [1e308, 0, .5, -1e308, 0, .5] } })` passes. `read()` derives `w = Infinity`, and every later patch on that element throws on every replica; only delete works. `create()` rejects the same input, so the two paths disagree. Huge finite coordinates make `getElementBounds` NaN and `documentToSvg` emits `viewBox="Infinity NaN Infinity NaN"`.

**Fix:**
1. In `preparePatch`, assert `deriveElementGeometry({ ...element, ...prepared })` on the merged element.
2. In `assertValidElement`, bound `|x|`, `|y|`, `|w|`, `|h|` and every stroke point to 1e9 and `fontSize` to 1024.
3. Unit tests for both paths with the reproduction inputs.

### [x] 14. Undo and redo bypass the schema-version gate (medium, reproduced)

**Where:** `packages/model/src/document.ts:67-69` (undo/redo wrappers assert writer identity only); `:173-175` (only `transact` asserts the schema).

**Fix:** Call `this.assertSchemaVersion()` in both wrappers before `assertWriterIdentity()`. Unit test: after a foreign `meta.schemaVersion` arrives, `undo()` throws and emits no update.

### [x] 15. HTTP mutations use permissions captured before the body arrives (medium)

**Where:** `packages/server/src/server.ts:93, 111, 113, 127-136`.

**Problem:** Authentication and board write authorization happen before `jsonBody`/`body` finishes. An editor who starts a rename or upload, is demoted or logged out, then completes the body still gets the mutation committed.

**Fix:** Parse the bounded body first, then re-run `authenticate` and `boardAccess` immediately before the store call, inside one SQLite transaction with the mutation. Keep the early checks as an admission filter. Test: demote between headers and body, assert 403 and no change.

### [x] 16. Sign-in blocks the event loop with synchronous scrypt; throttle is unusable behind a proxy (medium, measured)

**Where:** `packages/server/src/store.ts:43` (`scryptSync`, about 41 ms per call); `packages/server/src/server.ts:81-89` (120 attempts per minute per address, 5 failures per address plus username).

**Fix:**
1. Switch to promisified async `crypto.scrypt` for both verification and the dummy derivation.
2. Lower the per-address cap to 30 per minute and add a global in-flight login limit (for example 4 concurrent derivations).
3. Add an opt-in `WHITEBOARD_TRUSTED_PROXY` setting; when set, key the throttle on the last `X-Forwarded-For` hop. Document it in `packages/server/README.md`.
4. Keep the existing rate-limit tests passing.

### [x] 17. Session expiry leaves the user on a dead board and drops queued edits (medium)

**Where:** `packages/app/src/collaboration.ts:69-76` (token callback), `:133-141, 166-167` (cache discarded on reset); `packages/app/src/App.tsx:83-91`; `packages/server/src/server.ts:94, 172`.

**Problem:** There is no refresh endpoint; `GET /api/session` returns the same token and expiry. At expiry the runtime is destroyed, the board fetch fails with 401, and the user sees an error banner with only Sign out as a way back. The expiry path also sets `discardPersistence`, so edits queued at that instant are dropped with the cache.

**Fix:**
1. In `onPermissionChange`, when the follow-up board fetch returns 401, clear the account state and route to sign-in.
2. Only rotate the local cache epoch for `permissions-changed`; never for `session-expired` or `session-revoked`.
3. Rename the "could not be renewed" copy to describe expiry.
4. Playwright test in `tests/app/collaboration.spec.ts`: force expiry via the test hook and assert the sign-in screen appears and queued edits survive re-login.

### [x] 18. Headline acceptance gates are opt-in, hardware-skipped or manual (medium)

**Where:** `tests/app/pdf.spec.ts:58-99` (behind `VERIFY_PDF=1`), `tests/app/export.spec.ts:106-110` and `tests/app/text-layout.spec.ts:121-139, 163-193` (hard-coded `PYTHONPATH: '/private/tmp/whiteboard-pdf'`); `tests/app/performance.spec.ts:6` (skipped unless `RUN_APP_BENCHMARK=1`); `tests/app/tiles.spec.ts:10, 23` (skips on any 32,768-limit GPU while `docs/benchmarks/final/README.md:9` says "no skips"); `packages/server/src/server.test.ts:91, 95` (sleep 100 ms then assert nothing arrived), `:257` (real 30 s sleep).

**Fix:**
1. Replace the PyMuPDF check with a JS extractor (`pdfjs-dist`) so PDF text, font and ink-bounds assertions run unconditionally; or install `pymupdf==1.26.4` in CI and set `VERIFY_PDF=1`. Honour `PDF_PYTHONPATH` in all three specs meanwhile.
2. In `tiles.spec.ts`, force the limit through the `capabilities.maxTextureSize` override used at `:48` so at least two native tiles are always exercised; record the skip reason in the JSON if the native path is unavailable.
3. In `server.test.ts:85-103`, assert the positive `read-only-write-rejected` stateless message (already used at `:197`) or `provider.hasUnsyncedChanges` staying true, instead of sleeping.
4. Add a `workflow_dispatch` job on `macos-latest` that runs `RUN_APP_BENCHMARK=1 pnpm test:app` and `node spikes/renderer/run-benchmark.mjs`, or state in the README that these gates are never automated.

### [x] 19. About 80 MB of generated run artifacts are tracked (medium)

**Where:** `packages/loadtest/results/` (37 MB, 187 files: 105 `*.latencies.f64le`, 19 `.ndjson`, 10 `.pdf`, 5 `.pid` of dead processes, logs), `docs/benchmarks/` (38 MB, 133 files, 9 logs), `spikes/public/fonts` (3.5 MB byte-duplicates of `packages/app/public/fonts`), `spikes/renderer/artifacts/` (2.3 MB), `packages/model/reports/` (2 MB including a 1.85 MB `.bin`), `packages/loadtest/packages/loadtest/results/` (mis-nested).

**Fix:**
1. `git rm --cached` every `*.pid`, `*.log`, `*.f64le`, `*.ndjson`, run PNG/PDF and the mis-nested directory. Keep only the summary JSON files that `docs/ACCEPTANCE_AUDIT.md` links; list which ones you kept in the commit message.
2. Add to `.gitignore`: `*.pid`, `*.log`, `packages/loadtest/packages/`, `**/results/*.f64le`, `**/results/*.ndjson`, `spikes/**/artifacts/`, `.impeccable/`, `artifacts/`.
3. Point `spikes/vite.config.ts` `publicDir` at `packages/app/public` and delete `spikes/public/fonts`.
4. Fix the links in `docs/ACCEPTANCE_AUDIT.md` and `docs/S3_LOAD_REPORT.md` that pointed at removed files.

---

## Tier 3. Improvements

Work through these after Tier 2. Each is a small, self-contained change.

### Server

- [x] 20. `packages/server/src/server.ts:201` `beforeHandleAwareness` never compares the awareness `userId`/`name` with `context.userId`; a viewer can impersonate the owner's cursor and "editing" label. Overwrite `userId` and derive `name` server-side; drop states that disagree.
- [x] 21. `packages/server/src/router.ts:58` registers downstream close/error cleanup only inside the upstream `upgrade` callback. Register cleanup before starting the upstream request, cancel the pending `ClientRequest` when the client disconnects, add an upgrade timeout, and check downstream socket state before piping.
- [ ] 22. `packages/server/src/server.ts:189` builds `Y.snapshot(document)` for every read-only SyncStep2/Update packet. Cache per document version.
- [ ] 23. `packages/server/src/store.ts:62, 68` and every other method call `db.prepare()` per invocation, and `beforeHandleMessage` (`server.ts:178-184`) re-queries session and role for every awareness packet. Cache prepared statements in the constructor; cache the role per connection and invalidate on the permissions-changed path.
- [x] 24. `packages/server/src/server.ts:111` `boardAccess(boardId, userId, method !== 'GET')` treats HEAD as a write. Use `!['GET','HEAD'].includes(method)`.
- [x] 25. `packages/server/src/server.ts:76` exempts any `Authorization` header from the Origin check while `:35` falls back to the cookie. Require `startsWith('Bearer ')`.
- [ ] 26. `packages/server/src/store.ts:76, 84` `createBoard` seeds `meta.title` into the Yjs doc but `rename` updates only SQLite; live collaborators keep the old title (`App.tsx:123` fetches once). Either drop the seed or update both and render the doc-carried title.
- [ ] 27. `packages/server/src/static.ts:29` sends no CSP, `Referrer-Policy` or `X-Frame-Options`. Add `Content-Security-Policy: default-src 'self'; img-src 'self' blob: data:; worker-src 'self' blob:; connect-src 'self' ws: wss:` (adjust after checking what Troika and Vite need), `Referrer-Policy: same-origin`, `X-Frame-Options: DENY`. `packages/server/src/operations.ts:15` backup SQLite file is 0644 inside a 0700 directory; write it 0600.
- [x] 28. `packages/model/package.json` nanoid 5.1.6 has two high advisories (GHSA-xwg4-73v4-xw9w, GHSA-28wg-ghj8-5hjv). Not exploitable as called, but replace with `crypto.randomUUID()` (already used in `assets.ts` and the server) and drop the dependency.
- [ ] 29. `packages/server/src/spike.ts`, `spike-writer-kv.ts`, `benchmark.ts` are spike processes inside the production server package. Move them under `spikes/` or `packages/loadtest`.

### Model

- [x] 30. `packages/model/src/document.ts:63-80`: every undo of a gesture re-inserts the old `$clock` record while `deleteFilter` keeps the new one, so every connected peer's YKeyValue observer issues its own cleanup delete. With N peers an undo costs 2 + (N-1) persisted packets. Move the clock ledger to a per-writer root `Y.Map` (`clock:<actor>`) written inside the same `doc.transact`, outside the UndoManager scope; this also removes the pinned `getItemCleanStart/End` dependency on Yjs internals. Re-run `pnpm test:model` and the fuzz test after.
- [x] 31. Concurrent whole-text edits to one sticky discard one side (`types.ts:14`, `text-editor.ts:118-130`). Either document this in the README or presence-lock a note while a peer's `editingTextId` is set (the awareness field already exists) and show "X is editing".
- [x] 32. README calls it "per-user undo" but history is per Yjs client and does not survive reload; two tabs of one user have disjoint histories. Change the wording to per-session undo.
- [x] 33. `packages/model/src/document.ts:196-198, 276-281` and `clipboard-model.ts:91-94`: two clients pasting concurrently mint identical fractional keys so groups interleave in z-order. Salt the group floor per client (for example generate the first key between `highest` and `null` then use `generateNKeysBetween` with a client-specific jitter), or document.
- [ ] 34. `packages/model/src/text-layout.ts:212-216, 222-243`: a separator consumed at a wrap makes `renderedToSource[sourceToRendered[line.end]]` return `source.length` when it is the paragraph's last character, collapsing two caret positions. Fix the mapping for consumed trailing separators; add the failing inputs `"\t\t"` at width 40 and `"word word word word "` at width 40 as unit tests. `:46` measures unsupported scripts at one em per code point; surface a warning through the same path as the PDF coverage error.
- [ ] 35. `packages/model/src/document.ts:250-256` moving a connector without its bound target silently converts the binding to a point; `:284-288` duplicating a bound connector without its target leaves the copy bound to the original. Keep the binding on move; shift or unbind on duplicate. Document whichever is chosen.
- [ ] 36. No cap on `props.text` (`schema.ts:46`, `text-editor.ts:63, 128`); the editor re-lays out the whole draft per keystroke. Cap at 50,000 characters in the schema and editor; debounce `position()` for drafts over 5,000 characters.
- [ ] 37. Undo of a cross-board paste (`assets.ts:160-176`) orphans the server-side copied assets and no asset garbage collection exists. Add an `operations gc-assets` command that removes assets not referenced by any board snapshot, and document it.

### App and renderer

- [x] 38. `packages/app/src/runtime.ts:86-92`, `packages/renderer/src/index.ts:394-399`: `webgl.render` runs every animation frame while idle. Add a `needsRender` flag set by `queued.size`, viewport changes, presence, selection, live stroke, Troika sync callbacks and `bindAsset`; skip the frame otherwise.
- [x] 39. `packages/renderer/src/index.ts:412-450`: PNG export allocates one 4x MSAA render target per tile sized up to `maxTextureSize` plus two CPU copies (about 2 GB GPU at 16,384 px). Cap tile edge at 4,096 px, reuse one render target across tiles, and listen for `webglcontextlost` on the export canvas to fail with a message instead of a blank PNG. `tests/app/tiles.spec.ts:48` already validates correctness at small tiles.
- [x] 40. `packages/app/src/export.ts:107-117`: all three fonts (3.5 MB Noto Sans JP) are embedded in every SVG with any text; the `collectExportFonts(root, false)` result at `:117` is discarded. Filter `faces` by the coverage result before `documentToSvg`, as the PDF path at `:129-130` already does.
- [x] 41. `packages/app/src/controller.ts:308-322`: Space is default-prevented at the window so a focused button never activates by keyboard; Backspace on a focused swatch deletes the selection. Early-return from `keyDown` when `event.target` is a `button`, `a`, `summary` or `[role=button]`, or only handle shortcuts when `document.activeElement` is the canvas or `body`.
- [x] 42. `packages/app/src/controller.ts:101, 157`: the second touch pointer is ignored, so tablets cannot pinch-zoom or two-finger pan. Track active pointers; on a second touch pointer cancel the current gesture and drive `zoomAt` from the centroid and distance.
- [ ] 43. `packages/app/src/text-editor.ts:27, 67`, `App.tsx:75`: Escape discards the whole edit with no undo step; peer deletion or read-only switch mid-edit does the same silently. Commit on Escape (Cmd+Enter already commits) or keep the draft for a restore action, and show a notice when an edit is dropped.
- [ ] 44. `packages/app/src/modal.tsx:13`: the native `close` event is not observed. Chromium treats a second Escape without activation as non-cancelable and closes the dialog natively; React state still says open and the export UI is stuck. Listen to `close` and call `onClose()`; cancel an in-flight export through an `AbortSignal`.
- [ ] 45. `packages/app/src/export.ts:111-113`, `packages/renderer/src/index.ts:405`, `images.ts:154-157`: one missing or failing asset blocks export in every format. Render a placeholder, skip the asset, and list failed asset ids in a warning.
- [ ] 46. `packages/app/src/assets.ts:75`, `export.ts:113, 138`: `naturalW/H` come from an EXIF-corrected bitmap but raw JPEG bytes are embedded in the PDF, so portrait phone photos likely export rotated. Normalise orientation on upload (re-encode through a canvas) or apply the EXIF transform in the PDF path. `packages/renderer/src/index.ts:317` drops text under 6 screen px from PNG but keeps it in SVG and PDF; document or align.
- [ ] 47. `packages/app/src/controller.ts:165, 282`, `session.ts:22`: camera position is unbounded (Float32 jitter far from origin). Clamp x and y to ±1e6. `runtime.ts:48` captures `pixelRatio` once; observe `matchMedia('(resolution)')` changes and resize.
- [ ] 48. `packages/renderer/src/index.ts:330-364, 487-492`, `images.ts:52-55, 74`: text and image handles are retained for everything ever seen; display textures are dropped the instant an image leaves the viewport with no hysteresis; `dispose()` never calls `webgl.forceContextLoss()`; `export.ts:99` keeps a second live WebGL renderer after the first PNG export. Add LRU eviction for offscreen handles, a viewport margin for texture retention, force context loss on dispose, and dispose the export renderer after each export.
- [x] 49. `packages/app/src/style.css`: `.tool-hint` 11 px at 3.08:1, `.workspace-label` 9 px at 3.24:1, `.eyebrow` 10 px at 3.03:1, `.empty-board span` 10 px at 2.28:1, `.number-field span` 10 px at 2.81:1, `.minimap-heading` 8 px at 3.24:1, `button:disabled { opacity: .3 }` at 1.58:1, `.board-canvas { outline: none }` on a `tabIndex=0` element. Use greys at or above 4.5:1, no text below 11 px, a visible canvas focus ring, disabled at about .45 opacity with a colour change.
- [x] 50. `packages/app/src/controller.ts:324-327`: letter shortcuts key off `event.key`, so non-Latin layouts get none, and tool shortcuts still switch tools in read-only mode. Use `event.code` for letters (Space and brackets already do) and check `isReadOnly`.

### Tooling and docs

- [ ] 51. `scripts/license-audit.mjs:10` fails only on `/AGPL|UNLICENSED|SEE LICENSE/i` plus two package names; GPL, LGPL, SSPL, BUSL, CC-BY-NC and unknown licenses pass. Switch to an SPDX allowlist (MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, 0BSD, CC0-1.0, Unlicense, OFL-1.1) and fail on anything else or missing.
- [x] 52. Evidence was produced on Node 26.8.1 (`docs/DEPENDENCY_VERIFICATION.md:37`); CI uses Node 24 (`ci.yml:10`); `engines` is unenforced. Pin CI to 26 or add a `[24, 26]` matrix; commit `.npmrc` with `engine-strict=true`. The unit run prints `[THREE_CJS_DEPRECATED] require("three")`; find the caller with `node --trace-deprecation` and fix the import before the next Three release removes it.
- [x] 53. Config and doc drift: `vitest.config.ts:5` includes a non-existent `tests/unit/**`; per-package `typecheck`/`test` scripts in `packages/{model,server,loadtest}/package.json` have no per-package `tsconfig.json` so `tsc` walks up to the root; `docs/S3_LOAD_REPORT.md:17` reproduction command points at the failed `src/run.ts` harness instead of `pnpm loadtest`; `docs/FINAL_REVIEW.md:3` "No intervening commits existed" is stale. Fix each.
- [ ] 54. Thirteen of the fourteen files in `docs/` are one-time build logs with embedded PIDs, hashes and counts. Keep `README.md`, `packages/server/README.md`, `packages/renderer/README.md`, `FONTS.md`, `BUILD_PLAN.md`, `D3_STORAGE_INVESTIGATION.md`, `DEPENDENCY_VERIFICATION.md` and `ACCEPTANCE_AUDIT.md` as living docs. Move the rest under `docs/history/2026-09-29/` with a "snapshot, not maintained" banner at the top of each, and replace `EXECUTION_LOG.md`'s narrative with links.
- [ ] 55. Safe dependency cleanup from the over-engineering audit: remove `@fontsource/inter`, `@fontsource/ibm-plex-mono` and `y-protocols` from `packages/app/package.json` (no imports); remove the root devDependencies `@types/rbush`, `@types/three`, `@types/ws`, `y-utility`, `yjs` that are duplicated in the packages that use them; drop the tsconfig `paths` and `spikes/vite.config.ts` aliases that duplicate each package's `exports`; export `ThreeRenderer` directly and delete the one-implementation `Renderer` interface in `packages/renderer/src/types.ts`; deduplicate the `xml()` escaper shared by `packages/model/src/svg.ts` and `scripts/deploy-local.ts`; replace the hand-rolled grapheme clustering in `text-layout.ts` with `Intl.Segmenter`. Run the full test set after each.

---

## Tier 4. Scope decisions (do not start without instruction)

The over-engineering audit judged the codebase against a one-developer, one-Mac, loopback deployment and proposed removing about 4,500 lines (40 percent of hand-written code). These contradict goals the README currently states, so they are decisions for the owner, not tasks:

- Delete `packages/loadtest` and the server spike processes (1,600 lines, 19 env vars) if the 40-socket production gate is no longer required.
- Delete `spikes/` and `tests/browser/text-spike.spec.ts` once their text and export cases are confirmed covered by `tests/app`. Keep `spikes/text/fixture.ts` (imported by `tests/app/export.spec.ts`) by moving it to `tests/app/`.
- Drop PDF export (jspdf, svg2pdf.js, 6 MB of TTF containers, `scripts/build-export-fonts.py`, `tests/app/pdf.spec.ts`) in favour of print-to-PDF from the self-contained SVG.
- Drop the board-ID sharding router (`router.ts`, `router-cli.ts`, `tests/routed`, `playwright.routed.config.ts`, the `boardId` query check).
- Replace `scripts/deploy-local.ts` (171 lines) with a committed plist and two `launchctl` lines; drop `scripts/verify-local-deployment.ts`.
- Drop the manifest-based backup/restore in favour of `Store.backup` plus a directory copy.
- Drop the live permission-reset protocol and offline IndexedDB persistence if "role changes take effect on reconnect" is acceptable. Behaviour change.
- Consider whether the writer-owned-register CRDT (`document.ts`, 308 lines pinned to Yjs internals) is still justified for one to three peers. A per-element `Y.Map` with `Y.UndoManager` is about 100 lines. A rewrite, not a cut.

---

## Verified and holding (do not spend time re-checking)

Sessions (HMAC-SHA256, constant-time compare, SQLite cross-check, dummy scrypt, logout resets sockets). Authorization on every route and packet; viewers cannot write; non-members get 404; asset copy requires source read and target write. CSRF and CORS gating. Static traversal, encoded dot, backslash, NUL, dotfile and symlink rejection. Upload cap, magic bytes, SVG refusal, 0600 files. Parameterised SQL. Backup manifest regex and hash verification. No secrets tracked. Compaction preserves clocks and offline merge history. Concurrent same-element edits, delete vs move, delete vs rebind, double delete and undo-create-after-peer-edit converge. Fractional index length stays flat. Text layout terminates on adversarial input. rbush is used. All listeners, observers, animation frames, providers and Three.js resources are cleaned up. IME, StrictMode, pointer capture, zoom clamping and reduced motion are handled. Test hooks compile out of production and the deploy script refuses bundles containing them.
