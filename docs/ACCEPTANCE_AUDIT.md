# Build-plan acceptance audit

Audit date: 2026-09-30 (local). Baseline: `ee372ddafd4744f67e1e1b0d467ebf2f608c968b`; scope is the complete implementation, including originally untracked files. This is an evidence map for [BUILD_PLAN.md](BUILD_PLAN.md), not a replacement for its numeric gates. No runtime code changed during this audit.

**Current result:** Phases 0–4 have the implementation and measured evidence below, including the explicit Phase 0 decision-amendment exception. Phase 5 history/operations checks pass. **All planned phases and final acceptance checks are complete on the accepted Mac.** The final exact-source S3, source-frozen unit/browser/build/performance checks and actual production deployment have passed. A passing earlier run is not attributed to later source changes.

## Accepted scope and evidence rules

- The user explicitly selected this **Apple M1 Pro Mac, 8 logical cores, 32 GiB RAM** for the initial benchmark/deployment target. This replaces the original hardware reference, not any numeric threshold. Chrome uses ANGLE Metal on that GPU; measurements do not establish other machines, DPRs or arbitrary competing host load.
- **D3 was formally amended under §9 after S3 failed.** Nested maps retained 432,000 deleted structs at 360,000 edits and failed final synchronization; a shared flat array also failed. Production uses writer-owned stamped registers, coherent JSON `props`/`style`, immutable complete generations and native local undo with a same-transaction clock ledger. The replacement passed semantic proof before adoption. The original failures remain in [D3_STORAGE_INVESTIGATION.md](D3_STORAGE_INVESTIGATION.md) and [S3_LOAD_REPORT.md](S3_LOAD_REPORT.md).
- Native editing uses the expressly allowed **D7 plaintext DOM fallback**. Selection, clipboard, caret and IME are native; one final commit reaches Yjs. Native browser font fallback/punctuation spacing may temporarily differ from committed Troika. The model and committed display/export share deterministic metrics. No native glyph-pixel parity or universal Unicode shaping claim is made; see [TEXT_LAYOUT_REPORT.md](TEXT_LAYOUT_REPORT.md).
- Test counts from successive suites overlap and must not be added. [Final unit JSON](benchmarks/final/unit.json) records the latest complete **85/85** unit/integration cases, including the final shared-atlas lifecycle tests. The application suite separately passes all **51/51** browser cases with PDF raster inspection and the opt-in performance case enabled. S4 passes **8/8** and actual two-shard routing **1/1**. Timed GPU cases are opt-in and cannot be inferred from an ordinary browser-suite pass.

## Phase 0 — spikes and frozen decisions

| Requirement / exit | Evidence | Status / boundary |
| --- | --- | --- |
| S1: 5,000 shapes + 2,000 strokes + 500 texts ≥55 fps; 20,000 shapes ≥30 fps | [S1 report](S1_RENDERER_REPORT.md), [raw benchmark](../spikes/renderer/artifacts/s1-results.json) | Pass: both approximately 60 fps on accepted Mac. Production bundle, 90 warmup frames, 600 samples. |
| S1: 500 visible texts ≥55 fps; 5,000 offscreen texts add no text layout/GPU work | Same report and raw culling assertions | Pass: 500 visible every sampled frame; offscreen 0 text instances/draw calls/triangles. Document/index storage is not zero memory. |
| S2: 10,000 concurrent pairs/3 clients, convergence and semantic validity | [S2 report](S2_MODEL_REPORT.md), [schema2 raw result](../packages/model/reports/s2-schema2-fuzz.json), [permanent fuzz](../packages/model/test/fuzz.test.ts) | Pass: 20,000 ops, 946,710 validations, 0 invalid/0 divergent; 15 classes including undo/redo. Latest full unit rerun also passes. |
| S3: 40 clients×5 ops/s+20 Hz cursors, 30 min, p95<150 ms, CPU<70% of one core, flat retained memory | [S3 report](S3_LOAD_REPORT.md), candidate/reference raw reports linked there | Final exact-source production **PASS**: 360,000 acknowledgements, p95 36.89 ms, CPU maximum 40.73%, reviewed fixed-workload memory plateau; candidate and reference retained separately. The initial failure triggered D3, not a relaxed gate. |
| S4: caret/selection/IME plus 2×PNG/SVG mixed-board fidelity | [S4 report](S4_TEXT_EXPORT_REPORT.md), [prototype results](benchmarks/s4/suite-results.json), [extended text report](TEXT_LAYOUT_REPORT.md) | Pass using the planned DOM editing fallback. Three.js remains display/PNG projection. |
| Gate: all pass or affected decision amended before Phase 1 | [Plan§9](BUILD_PLAN.md#9-execution-amendments) | Explicit D3/D7 exception satisfied. Remaining Phase 5 production acceptance was never waived. |

## Phase 1 — single-user core

| Requirement | Implementation and authoritative proof | Status |
| --- | --- | --- |
| Workspace, schema, document scope | Five workspace packages; [model adapter](../packages/model/src/document.ts); [model/history tests](../packages/model/test/model.test.ts) | Verified. Production later adds the provider; local fixture mode is restricted to test builds. |
| Orthographic camera, grid, space-drag/wheel/trackpad pan, cursor-anchored zoom | [Renderer](../packages/renderer/src/index.ts), [controller](../packages/app/src/controller.ts); [core camera flow](../tests/app/core.spec.ts) | Verified; 2%–6400% zoom, camera mutations stay out of Y.Doc. |
| Rect/ellipse/sticky creation, movement, resize, rotation | [Core flows](../tests/app/core.spec.ts), [controller flows](../tests/app/controller.spec.ts) | Verified, including cancellation and concurrent peer changes. |
| Click/shift/marquee selection, R-tree, selection layer/handles | Same browser suites; [hit testing](../packages/app/src/hit-test.ts), [shared geometry tests](../packages/model/test/model.test.ts) | Verified. Precise geometry follows candidate AABB lookup. |
| One-gesture native undo/redo | Model transaction/history tests; core/controller/text/assets browser suites | Verified: preview state is local; commit is one transaction/history item; remote origin is not local history. |
| Delete, duplicate, nudge, fractional z-order | Core browser mutations; model fractional-collision/reorder tests | Verified; ID tie-break and reorder out of ties are deterministic. |
| Local camera persistence | Core camera/reload browser flow; [session store](../packages/app/src/session.ts) | Verified, independent of document history. |
| Exit: 5,000 shapes≥55 fps; undoable mutations; hard reload clears projection | [Application performance](benchmarks/phase1/application-performance.json), S1 reload assertions, core flows | Pass: 60.002 fps/360 frames, 293.1 ms preparation, 5,000 real document elements. Final application performance rerun passed with zero page errors. |

## Phase 2 — freehand, text, connectors

| Requirement | Proof | Status / boundary |
| --- | --- | --- |
| Pressure input, perfect-freehand outline, chunked tessellation, whole-stroke eraser | Controller pen/eraser flows; renderer one-chunk-rebuild assertion; model stroke validation | Verified. Simplified input triplets persist; triangles/live preview do not. |
| Native text/sticky editing, IME, clipboard, auto-size, WOFF, sync-gating, LOD | [Text flows](../tests/app/text.spec.ts), [mixed layout flows](../tests/app/text-layout.spec.ts), [font report](TEXT_LAYOUT_REPORT.md), S1 visibility assertions | Verified with D7 boundary above. 26 actual Troika width cases match the model exactly; source offsets and original text remain intact. |
| Straight/elbow connectors, anchor binding, reroute on move/delete | Controller bound-elbow flow; model binding/deletion/undo tests; image-export cap/join regression | Verified; moving a target needs no connector write; missing targets resolve deterministic captured endpoints. |
| Stroke/fill/width/opacity/font controls | Core/controller flows plus shared renderer styles and undo assertions | Verified, including style draft cancellation and coherent style writes. |
| Exit: 2,000 strokes+500 texts within S1 budget; type/select/cut/paste/IME/blur one-step flows | S1 mixed fixture; native text suite; [integrated media/presence benchmark](../packages/renderer/MEDIA_PRESENCE_REPORT.md) | Pass on accepted Mac. Integrated mixed fixture also includes 16 images and 40 changing peers at 60.0024 fps; host-contention limitations are preserved. |

## Phase 3 — collaboration

| Requirement | Proof | Status / boundary |
| --- | --- | --- |
| Production Hocuspocus, SQLite, signed sessions, ACL, board create/list | [Server integration tests](../packages/server/src/server.test.ts), [server contract](../packages/server/README.md), [browser collaboration](../tests/app/collaboration.spec.ts) | Verified. Viewers cannot write; outsiders cannot read boards/assets. |
| Provider, offline queue, reconnect, two-browser conflict behavior | Browser collaboration suite; [live model report](PHASE3_MODEL_REPORT.md) | Verified through actual authenticated WebSockets, IndexedDB reload and local/peer changes. |
| Awareness-only cursors/names, selections, soft editing indicator | Browser collaboration flow; renderer media/presence assertions; [presence implementation](../packages/renderer/src/presence.ts) | Verified; outgoing changes capped at 20 Hz, incoming projection coalesced per animation frame. Awareness never persists or enters undo. |
| Per-user undo | Two-user browser flow; targeted live/newer-peer/delete-restore cases; permanent history tests | Verified, including newer peer writes surviving local undo/stale redo. |
| S2 extended to a real authenticated server | [Live harness](../packages/loadtest/src/live-model-fuzz.ts), [clean result/exit links](PHASE3_MODEL_REPORT.md) | Pass: 3 distinct users, 10,000 pairs, 20,000 ops, 771,378 validations, 0 invalid/0 divergent; 21,285 server/persisted updates. |
| Exit: convergence, 30 s actual offline, no lost local edits, undo isolation | Same live report and browser flow | Pass: 30,001.094 ms measured socket outage; fresh SQLite raw/projected state matches. History is cleared every 200 fuzz pairs; not an unlimited-history memory test. |
| Review regressions: revocation, expiry, late navigation, role downgrade/regrant | Server 15 cases and browser collaboration suite | Verified for selected single-owner deployment. Passive cross-owner logout invalidation remains a documented multi-owner limitation. |

## Phase 4 — exports, images, polish

| Requirement | Proof | Status / boundary |
| --- | --- | --- |
| PNG selection/content, 1×–4×, transparency, tiling | [Export flows](../tests/app/export.spec.ts), [tiling flows](../tests/app/tiles.spec.ts), [native](benchmarks/phase4/native-tiles.json)/[controlled](benchmarks/phase4/controlled-tiles.json) artifacts | Verified. Actual GPU boundary and independent 64 px two-axis control; overlap/draft excluded; opaque alpha 255 and straight transparent alpha. |
| Pure document SVG, embedded fonts; browser PDF | [Pure serializer](../packages/model/src/svg.ts), [PDF flows](../tests/app/pdf.spec.ts), [font report](TEXT_LAYOUT_REPORT.md) | Verified. Strict unsupported-glyph error, explicit font readiness, retry recovery, positioned punctuation/ligature tokens; original PDF text preserved. |
| Drop/paste→external image upload→assetId; thumbnail display | [Six asset flows](../tests/app/assets.spec.ts), [renderer image report](../packages/renderer/MEDIA_PRESENCE_REPORT.md) | Verified. PNG/JPEG/WebP original bytes, 20 MiB limit, decoded actual GPU dimension limit; atomic failure/close handling. Initial target uses authenticated local-disk storage, not deployed S3. |
| Original image export quality, rotation, opacity, privacy | [Image-export flows](../tests/app/image-export.spec.ts), [comparison](benchmarks/phase4/images/comparison.json), [native detail](benchmarks/phase4/images/native-detail.json) | Verified. Native 2,048 px alternating detail survives low-resolution preview; embedded bytes exact; missing/mirrored controls fail; image-region mismatch 0. |
| Cross-board clipboard JSON+asset references | Asset browser copy/cut/undo flows; [pure clipboard tests](../packages/app/src/clipboard-model.test.ts) | Verified: new IDs/order, translated pressure strokes, internal/external binding handling, source-read/target-edit asset copy; no partial insertion. |
| Minimap, zoom-to-fit | Export/core flows, resize regression | Verified; viewport updates with actual canvas dimensions. |
| Exit: PNG/SVG/screen visual comparison within tolerance | [Mixed comparison](benchmarks/phase4/comparison.json), image comparison,[text/ligature comparison](benchmarks/phase4/mixed-text-layout/ligatures.json) | Pass on measured fixtures: per-region foreground criteria, independent ink bounds and missing/displaced/mirrored controls. No global-whitespace-only acceptance. |

The text comparison uses48 channel levels,0.5 CSS-pixel antialias allowance and 18% foreground mismatch; PNG/SVG text ink bounds≤1 output pixel, PDF/SVG≤2. Image comparisons use≤2% and exact known-pixel/detail checks. The repeated 8-phrase Noto ligature fixture now has identical PNG/SVG/PDF ink bounds, 13.11%/13.50% mismatch, and exact extracted text. This establishes measured tolerance parity, not identical GSUB shaping inside jsPDF. Shared-atlas readiness is also exercised with cold/warm, on/offscreen text; the presence-label extension also passes its focused shared-atlas regression; final consolidated checks pass as recorded below.

## Phase 5 — scale and operate

| Requirement / exit | Proof | Status / boundary |
| --- | --- | --- |
| Full production S3, p95<150 ms, CPU<70% of one core, flat30 min memory; bandwidth/awareness recorded | [Load report](S3_LOAD_REPORT.md), [production reference](../packages/loadtest/results/s3-production-2026-09-29T18-46-22.867Z.json) | Final exact-source **PASS**: 360,000 acked gestures, 1,440,000 cursors, p95=36.89 ms, max CPU 40.73%, 0 disconnects. [Final raw result](../packages/loadtest/results/s3-production-2026-09-29T19-27-40.330Z.json); the earlier linked reference remains separate. |
| Snapshot/update-log compaction at5 MiB or10,000 updates | Server compaction/offline-clock tests; [operations report](../packages/server/OPERATIONS_REPORT.md) | Verified; transactional snapshot/log replacement retains client clocks and offline merge; no reset/epoch discard. |
| 100,000 historical updates load <2 s | [100k history result](../packages/loadtest/results/history-2026-09-29T09-04-08.887Z.json) | Pass: 67.78/42.38/34.96 ms including SQLite read, Yjs apply, model construction and 1,280-element projection; three OS-cache-warm loads. |
| Six-month busy-board simulation | [180-day result](../packages/loadtest/results/churn-2026-09-29T18-41-21.033Z.json), [independent oracle review](../packages/loadtest/results/churn-2026-09-29T18-41-21.033Z.review.json) | Pass for declared accelerated workload: 108,000 updates, 360 fresh session writers, 900 delete/recreate pairs, 106 visible elements; 163.93/147.01/146.90 ms warm reload. Day 0 offline replica merges after final compaction; restore hashes agree. |
| Board-ID router, health, drain | Server router/drain tests; [actual two-owner browser test](../tests/routed/boards.spec.ts),`pnpm test:routed` | Pass 1/1,5.7s: each board reaches its owner and reloads; nonowner connections 0. Same-host separate processes share SQLite/secret. Multi-host shared persistence/HA is not validated. |
| Per-board connection/update/awareness/persistence observability | Membership-protected `/api/metrics`; server integration tests; S3 raw traces | Implemented and exercised. RTT acknowledges server application, not an additional disk-fsync receipt; final persisted hashes are checked separately. |
| Backups and restore | Server online-backup test; history/churn drills; [operations guide](../packages/server/README.md#routing-drain-and-backup-operations) | Pass: database, accounts, assets, secret and hashes; fresh destination; no document clock reset. WAL abrupt-process recovery also tested. |
| Optional Redis HA | [Dependency verification](DEPENDENCY_VERIFICATION.md) | Intentionally omitted; not needed for accepted single-owner target. Patched Hocuspocus 4.7.0 includes #1152; this is not a 3-replica HA certification. |

**Memory/churn boundary:** fixed-writer hot-edit plateau does not mean memory is bounded by visible elements forever. Old generations, retired writer arrays and local history retain data to preserve offline/undo semantics. The180 day drill ends at362 writer arrays, 25,133 records, 35,829 structs and 4,474,701 snapshot bytes for 106 visible elements. No offline writer or old generation is silently discarded. The original 100k drill is a one-writer update-count test; the separate180 day drill adds real writer/lifecycle turnover. Both load measurements are OS-cache-warm, not network/cold-disk/browser startup claims.

## Dependencies, scope and final closure

[D1/D5/pin verification](DEPENDENCY_VERIFICATION.md) and the [license audit log](benchmarks/final/license-audit.log) cover pinned dependencies and exclusion of tldraw/@y/hub. Yjs 13.6.33 is deliberate: the undo ledger uses exported low-level Item split helpers and must rerun full regression tests before upgrading. Generated font files carry source hashes. No Redis, WebRTC, AI, public anonymous board, comments/version-history UI, mobile-native app or embedded tldraw/Excalidraw component was added as v1 scope.

[FINAL_REVIEW.md](FINAL_REVIEW.md) records independent standards/specification review. The two functional findings were the omitted board-ID WebSocket routing key and mixed-script auto-size; both now have concrete fixes and regression evidence. Native editor typography and same-host sharding limits are explicit, not concealed as complete cross-platform/multi-host validation.

### Final acceptance records

| Required final record | Verified status |
| --- | --- |
| Source-frozen production S3 report, raw latency/counter verification, all client/live/persisted hashes,30 min memory trace, clean children/runner exits | **PASS**. Final run `s3-production-2026-09-29T19-27-40.330Z`: 1,800.001 seconds, all 360,000 acknowledgements, 1,440,000 cursors, zero disconnects, matching all client/live/persisted states, nine clean child exits and coordinator/caffeinate exit. All source hashes match. [Independent trace/source evidence](S3_LOAD_REPORT.md). RSS slope +0.2356 and heap +0.0013 MiB/min; stable heap floors and fixed structures support the predeclared gate. Maximum RTT 1,179.97 ms is disclosed; p95 is 36.89 ms. |
| Final production build, typecheck, full unit/browser/S4/routed suites and relevant Mac performance rerun after atlas-gate changes | **PASS**. [Frozen source manifest](benchmarks/final/sources.json) covers 58 runtime/toolchain files; Full unit 85/85; app 51/51 including PDF/performance; S4 8/8; routed 1/1. Final S1/media reruns pass at approximately 60fps. [Consolidated final evidence](benchmarks/final/README.md). |
| Actual Mac production deployment, health/readiness, private login/board/export/reload smoke, verified own process and restart/drain | **PASS**. Actual launch-agent PID95790 owns3001; oldPID95565 exited. Real production UI creates four elements, exports, reloads and signs in from a fresh context; exact SVG survives actual redeploy. [Smoke/restart evidence](benchmarks/deployment/), [independent live audit](benchmarks/deployment/independent.json). |
| Final accepted URL/process configuration, backup location and operational handoff | **PASS**. <http://127.0.0.1:3001>, per-user launch agent, private data/credentials under `~/Library/Application Support/ThreejsWhiteboard/`. Independent coherent backup/restore succeeds in a fresh ignored private directory; no existing data replaced. Configuration and commands are in [README](../README.md). |

Every final row is backed by a completed process and recorded evidence. The original failures, earlier source versions and shortened smoke runs remain distinct from final acceptance.
