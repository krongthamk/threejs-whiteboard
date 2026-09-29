# Build execution log

This file tracks evidence against [BUILD_PLAN.md](BUILD_PLAN.md). A phase is complete only when its exit criteria are demonstrated. On 2026-09-29 the user selected this Mac as the initial deployment and benchmark target. Measurements on this target do not establish performance on other hardware.

## Phase 0 — complete on the selected Mac

- S1: **passed on the selected Mac**. Mixed 5,000 shapes + 2,000 strokes + 500 visible texts: 60 fps; 20,000 shapes: 60 fps; 5,000 off-screen texts add no text meshes, draw calls, or triangles. See [S1_RENDERER_REPORT.md](S1_RENDERER_REPORT.md).
- S2: **original model passed the expanded suite** after fixing native Yjs undo restoration failures. The run includes 10,000 concurrent pairs, 1,306 undos, 82 redos, and 870,897 semantic validations, with zero invalid or divergent states. D3 is nevertheless reopened by the S3 memory failure; any replacement must repeat the semantic and history proof. See [S2_MODEL_REPORT.md](S2_MODEL_REPORT.md).
- S3: **baseline failed**. Exact Hocuspocus 4.7.0 contains the required fix. The full run generated 360,000 operations and 1,440,000 cursor updates but timed out during final client synchronization, with 344,900 acknowledgements at the last observed progress report. No valid final p95 was produced. Independently, repeated edits retain growing nested-map metadata even after snapshot reload. The writer-partitioned schema-2 replacement is integrated after semantic proof. Its full 30-minute transport run passed; the final exact-source authenticated SQLite production run has also passed. See [S3_LOAD_REPORT.md](S3_LOAD_REPORT.md).
- S4: **passed**. Eight browser tests pass from an isolated production bundle, including native Japanese IME, offline shipped glyphs, one-gesture commit, clipboard, PNG/SVG comparison and missing/displaced-text negative controls. See [S4_TEXT_EXPORT_REPORT.md](S4_TEXT_EXPORT_REPORT.md).

BUILD_PLAN §9 now explicitly amends D3 and selects S4's DOM editing fallback. Phase 1 proceeded under the plan's failed-spike decision-amendment exception; this does not waive replacement S2/S3 proof. The clean candidate fuzz rerun passed all 10,000 pairs with 818,007 semantic validations. The integrated schema-2 model also passed its permanent 10,000-pair suite (946,710 validations) and targeted storage/history regression checks. Candidate S3's 10-second smoke passed with 2,000/2,000 acknowledgements, p95 19.64 ms, maximum sampled server CPU 14.88%, and convergence of all 40 clients plus server. The full 30-minute candidate run passed: 360,000 acknowledged operations, 1,440,000 cursor updates, p95 28.247 ms, maximum sampled CPU 18.09% of one core, and flat retained structs throughout the post-warmup window. Phase 1 is complete on the selected Mac. Phase 2 tools and native text flows pass; the updated renderer sustained 60.003 fps with the S1 mixed workload plus images and 40 changing peers. Phase 3 live fuzz, offline recovery and private browser flows passed. The final exact-source authenticated SQLite production run passed all gates: 1,800.001 seconds, 360,000/360,000 acknowledgements, 1,440,000 cursor updates, zero disconnects, p95 36.89 ms, maximum sampled CPU 40.73% of one core, all client/live/persisted states matching, and nine clean child exits.

## Verification ledger

| Requirement | Evidence | Status |
| --- | --- | --- |
| S1 mixed 7,500-element board ≥55 fps; 20,000 shapes ≥30 fps; text culling | [Raw production benchmark](../spikes/renderer/artifacts/s1-results.json), [report](S1_RENDERER_REPORT.md) | Passed on selected Mac |
| S2 10,000 concurrent pairs, 3 clients, convergence and coherent elements | [Integrated schema-2 fuzz](../packages/model/reports/s2-schema2-fuzz.json), [report](S2_MODEL_REPORT.md) | Original and integrated schema-2 models passed |
| S3 40 clients, 5 ops/s, 20Hz awareness for 30 minutes | [Baseline trace](../packages/loadtest/results/s3-2026-09-29T07-38-42.314Z.ndjson), [report](S3_LOAD_REPORT.md) | Baseline failed; revised candidate and final production passed |
| S4 caret/selection/IME and 2× PNG/SVG fixture | [Browser flows](../tests/browser/text-spike.spec.ts), [recorded suite](benchmarks/s4/suite-results.json), [report](S4_TEXT_EXPORT_REPORT.md) | Passed |

## Remaining acceptance checklist

All unchecked items are requirements, not claims about the current implementation. Each phase requires a runnable demo and recorded exit evidence.

### Phase 1

- [x] Workspace and in-memory Y.Doc schema, with isolated document/session/presence scopes.
- [x] Orthographic renderer, grid, space-drag/wheel/trackpad pan and cursor-centered 2%–6400% zoom.
- [x] Instanced rectangles, ellipses, stickies: create, move, resize handles, rotate.
- [x] Click/shift-click/marquee selection using rbush and precise type tests; selection UI layer.
- [x] Gesture-level local undo/redo, deletion, duplication, nudge and fractional z-order.
- [x] Camera session persists in localStorage.
- [x] 5,000-shape pan/zoom ≥55fps on accepted target.
- [x] Every document mutation undoable; hard document reload leaves no stale render state.

### Phase 2

- [x] Pressure-aware freehand outline, simplified input points, 256-stroke chunks, dynamic live preview, whole-stroke eraser.
- [x] Text/sticky editing: caret, selection, clipboard, IME, auto-size and one commit per blur; shipped fonts, sync gate and LOD.
- [x] Straight/elbow connectors, snapping, binding resolution and move/delete rerouting.
- [x] Stroke/fill/width/opacity/font style controls.
- [x] 2,000 strokes + 500 visible texts satisfy S1 budget; all editor browser flows pass.


### Phase 3

- [x] Re-check dependency/licence facts in BUILD_PLAN §8.
- [x] Signed session tokens, membership ACLs and enforced viewer read-only access.
- [x] Hocuspocus + SQLite database extension persistence and board create/list API.
- [x] Provider wiring, offline queue, reconnect and two-browser conflicts.
- [x] Awareness-only named cursors, remote selections, soft text edit indicator; on-change updates capped at 20 Hz.
- [x] Two-user undo isolation.
- [x] Live-server model fuzz convergence.
- [x] Thirty-second offline reconnect loses no local changes.

### Phase 4

- [x] PNG selection/page export at 1×–4×, transparent option, render-target tiling above texture limit.
- [x] Document-driven SVG with embedded fonts; PDF path selected from S4 fidelity evidence.
- [x] Drag/drop and paste images through external asset storage; assetId-only documents and thumbnail textures.
- [x] Cross-board clipboard JSON with asset references.
- [x] Minimap and zoom-to-fit.
- [x] Per-region fixture snapshots compare PNG/SVG with the on-screen renderer within a documented tolerance.

### Phase 5

- [x] Re-check dependency/licence facts in BUILD_PLAN §8.
- [x] Run full S3 on accepted deployment target with actual production persistence and payloads; record CPU, memory, bandwidth and awareness rates.
- [x] Snapshot compaction at 5 MB or 10,000 updates, update-log GC, six-month busy-board simulation.
- [x] Board-ID sharding router, health checks and graceful deployment drain.
- [x] Per-board connections, update/awareness rates and persistence latency observability.
- [x] Backups and verified restore drill.
- [x] 100,000 historical updates load in <2 s after compaction.
- [x] Optional Redis enabled only if an uptime target requires it; otherwise explicitly omitted.

### Final verification

- [x] Production build, typecheck, model/unit suite, browser flows, relevant integration/operations checks.
- [x] Licence audit in CI excludes tldraw/@y/hub and disallowed dependency licences.
- [x] Setup, demo, self-hosting, backup/restore and benchmark commands documented.
- [x] Independent standards and specification review; findings resolved.
- [x] Requirement-by-requirement completion audit using authoritative artifacts and measured results.

## Phase 1 / Phase 2 application evidence — 2026-09-29

The production application with schema 2 passed 18 browser checks (25.5 seconds), including all seven core UI flows, five native-text flows, five gesture/concurrency flows, and the explicit 5,000-shape performance gate. The selected Mac sustained **60.002 fps over 360 animation frames**, with 5,000 actual document elements, three draw calls, zero page errors and 236 ms fixture preparation. Raw intervals, hardware and GPU from that run are preserved in [the prior performance reference](benchmarks/final/pre-final-reference/application-performance.json). The [captured application](benchmarks/phase1/5000-shapes.png) was visually inspected.

The additional Phase 2 controller suite passed **9/9 browser flows in 13.6 seconds** (five retained Phase 1 plus four new pressure pen, eraser, text-tool and bound-connector cases). Its focused controller/geometry unit suite passed 19/19. These counts overlap the earlier application run; they must not be added as distinct test cases. The text regression preserves intentional trailing blank lines while removing Chromium's final caret placeholder after native cut/paste.

Reproduce core UI checks with `pnpm test:app`; the target-specific performance gate is opt-in with `RUN_APP_BENCHMARK=1 pnpm test:app`. Public builds have no document test hook or anonymous local-board route.

## Phase 3 application and model evidence — 2026-09-29

Two production application browser tests passed in 45.6 seconds. They exercise private sign-in, board create/share/list/rename, owner/editor collaboration, rendered named presence, peer-preserving undo, a measured 30-second socket outage with local and remote edits, reload durability, viewer controls and outsider denial. [Browser flows](../tests/app/collaboration.spec.ts), [captured private board](benchmarks/phase3/private-board.png). Native core and text suites also passed after provider wiring.

The independently authenticated live model suite passed 10,000 concurrent pairs / 20,000 operations, 771,378 semantic validations and zero invalid or divergent states. SQLite reload matched the authoritative result after 21,285 updates and two automatic compactions. The actual measured offline interval was 30,001.094 ms. See [PHASE3_MODEL_REPORT.md](PHASE3_MODEL_REPORT.md).

Incoming awareness is coalesced to the latest state per animation frame before renderer and roster projection; outgoing changing presence is throttled to one update per 50 ms. This avoids treating 40 users' 800 incoming packets per second as 800 React/render passes.

## Integrated renderer and review regressions — 2026-09-30 local

The updated mixed renderer passed at **60.003 fps over 600 frames**, including 5,000 shapes, 2,000 strokes, 500 texts, 16 images and 40 changing peer cursors / 80 labels. All 21 correctness assertions passed with no external requests or page errors. Earlier slower runs and their unresolved host variability are retained in [MEDIA_PRESENCE_REPORT.md](../packages/renderer/MEDIA_PRESENCE_REPORT.md); the passing run does not establish performance under arbitrary competing host load.

Five new production-browser regressions passed in 9.8 seconds: delayed board responses cannot replace a newer route; a downgraded editor discards rejected queued changes and cannot replay them after regrant/reload; minimap viewport follows canvas resize; PNG crosses the actual GPU texture boundary without seams or vertical inversion; controlled 64-pixel tiles match untiled pixels exactly across both axes, including translucent overlap. The small forced limit is a separate geometry control, not a claim about hardware capabilities. [Native tiling](benchmarks/phase4/native-tiles.json), [controlled tiling](benchmarks/phase4/controlled-tiles.json).

The native text suite also passed the untouched-editor blur regression: a peer's intervening text commit survives when the local user makes no text change.

## Phase 5 history and operations evidence

The six-month simulation uses **180 simulated days**, two new writers per day and 300 gestures per writer: **108,000 actual updates**, plus three reconnect updates. It includes 900 delete/recreate cycles, 106 visible elements and a day-zero offline writer merging after final compaction. Raw and semantic hashes converge, stale-generation edits remain excluded, subsequent clocks advance, and backup restore matches. Three reload-plus-projection measurements were **163.93 / 147.01 / 146.90 ms**, all below 2 seconds on an OS-cache-warm local filesystem. Snapshot storage grew from 770,902 bytes at day 30 to 4,473,987 at day 180 before reconnect; offline-safe retention is not an indefinite churn-memory bound. [Operations report](../packages/server/OPERATIONS_REPORT.md).

The production S3 attempts interrupted by host sleep are failures, with raw evidence preserved. An uninterrupted reference run then passed all 360,000 acknowledgements, with p95 35.45 ms, maximum sampled CPU 40.32% of one core and matching persisted state. Review changed runtime code after that run was frozen, so it is reference evidence only. The subsequent final exact-source run passed and is tracked separately in the load report.

## Phase 4 export and images

The application suite passed **43 browser tests in 1.5 minutes**, with the opt-in performance case excluded; later review fixes still receive their own regression checks. Six image/clipboard flows cover original PNG/JPEG/WebP bytes, drag/drop, native paste, cross-board binding/asset remapping, atomic undo, invalid dimensions/bytes, upload failure, board closure and clipboard failure. Three image/export flows additionally validate native 2,048-pixel detail rather than thumbnail export, rotated translucent images, embedded original bytes, and connector cap/join alpha. The opaque image fixture has alpha 255 at every pixel; its image region has zero PNG/SVG/screen mismatch and zero ink-bound error. Missing/mirrored-image and flattened-cap controls fail independently. [Image comparison](benchmarks/phase4/images/comparison.json).

The PDF path uses browser svg2pdf.js plus jsPDF, exact shipped font cmaps and explicitly loaded measurement faces. Three PDF tests pass, including mixed-font centered/right text, cold/warm raster equality, unsupported-glyph recovery and malformed-font retry. Independent PDF/SVG/PNG ink bounds differ by at most one output pixel in the fixed-width fixture. [PDF report](benchmarks/phase4/pdf-fonts/README.md). The final specification review found and corrected mixed Japanese/Latin autosize metrics. All 26 model widths exactly match actual Troika layout; native IME/caret/one-gesture behavior passes. Mixed punctuation and repeated-ligature PNG/SVG/PDF comparisons pass the unchanged visual tolerances, with identical long-line ink bounds. The plaintext native editor can temporarily use different font fallback and punctuation spacing; committed geometry is deterministic. See [TEXT_LAYOUT_REPORT.md](TEXT_LAYOUT_REPORT.md).

The actual browser was additionally tested through two separate Hocuspocus instances behind the board-ID router. A board chosen for each owner accepts a drawn shape and preserves it after reload; metrics show one connection on its owner and zero on the other node. The browser WebSocket includes the same board ID required by routing. This same-host shared-SQLite fixture is an integration proof, not a remote multi-host deployment claim. `pnpm test:routed` passed 1/1 in 5.5 seconds.


## Final source-frozen checks and Mac deployment

The final runtime/toolchain [SHA-256 manifest](benchmarks/final/sources.json) was recorded during final verification and rechecked unchanged after all runs. The full unit/integration suite passed **85/85** across 12 files in 93.89 seconds, including the permanent 10,000-pair fuzz, server persistence/ACL/history checks and shared Troika atlas readiness lifecycle. The final application suite passed **51/51** in 129.35 seconds with `VERIFY_PDF=1 RUN_APP_BENCHMARK=1`; S4 passed **8/8** in 10.7 seconds and actual two-shard routing **1/1** in 5.7 seconds. Typecheck, dependency-license audit and production build passed. [Final raw reports](benchmarks/final/).

The real application performance rerun sustained **60.002 fps** over 360 frames with 5,000 document shapes, three draw calls and zero page errors; preparation took 293.1 ms. Earlier timing references are retained under `benchmarks/final/pre-final-reference/`.

The production build, with test hooks disabled, is deployed at <http://127.0.0.1:3001> through the per-user `com.threejs-whiteboard.local` launch agent. Real UI verification created a four-element Welcome board and found identical SVG hashes after reload, fresh isolated browser login, and an actual redeployment from PID 95565 to 95790. The previous PID exited. Anonymous local mode and test hooks are absent. [Deployment smoke](benchmarks/deployment/local.json), [post-redeployment smoke](benchmarks/deployment/after-redeploy.json), [restart proof](benchmarks/deployment/restart-proof.json). Private data and generated owner credentials live outside the repository under `~/Library/Application Support/ThreejsWhiteboard/`.

A separate controlled unrelated listener returning `ready=true` was correctly refused before any deployment data was created, and it remained alive until the test cleaned up its own process. [Foreign-port control](benchmarks/deployment/foreign-port-control.json). Final S1 and media/presence reruns also passed at approximately 60 fps with every correctness assertion. The independent deployed backup/restore audit also passed: launchd PID ownership, exact served HTML/JS/CSS hashes, private file modes, four-element Welcome board, database integrity and restored account/membership/document/secret equality. The deployed demo has no image assets; prior server/history drills separately verify nonempty assets. [Independent deployment audit](benchmarks/deployment/independent.json). The final full S3 subsequently passed the independent raw-count/source/trace/shutdown review below.


## Final S3 acceptance — all phases complete

The final exact-source authenticated SQLite production run passed all gates: 1,800.001 seconds, 360,000/360,000 acknowledgements, 1,440,000 cursor updates, zero disconnects, p95 36.89 ms, maximum sampled CPU 40.73% of one core, all client/live/persisted states matching, and nine clean child exits. The raw p50/p95/p99/max gesture round trips are 18.07 / 36.89 / 55.22 / 1,179.97 ms; the plan constrains p95, not maximum latency. The longest coordinator scheduler lag was 171.90 ms. This is the frozen final production server/model with signed sessions, authorization, SQLite WAL/FULL logging and 57 automatic compactions; earlier candidate/reference runs are not substituted.

Post-warmup RSS/used-heap slopes are **+0.2356 / +0.0013 MiB/min**. RSS has modest upward drift (five-minute medians 241.85 / 243.78 / 243.93 / 244.02 / 248.07 MiB), explicitly not zero. Heap floors remain 31–33 MiB, medians do not rise monotonically, and all retained/deleted structure counts remain exactly 3,363/1,720. The full curve and five-minute windows were reviewed, including 131 sampled heap drops of at least 5 MiB; no forced GC, resets, trace trimming or unlimited-churn memory claim. This meets the predeclared fixed-workload memory criterion.

[Final result](../packages/loadtest/results/s3-production-2026-09-29T19-27-40.330Z.json), [complete trace review](../packages/loadtest/results/s3-production-2026-09-29T19-27-40.330Z.trace-review.json), [source audit](../packages/loadtest/results/s3-production-2026-09-29T19-27-40.330Z.source-audit.json), [plot](../packages/loadtest/results/s3-production-2026-09-29T19-27-40.330Z.png), [load report](S3_LOAD_REPORT.md), and [requirement audit](ACCEPTANCE_AUDIT.md) provide the completion evidence. All benchmark processes, including the coordinator and caffeinate helper, exited; the installed application remains running intentionally.
