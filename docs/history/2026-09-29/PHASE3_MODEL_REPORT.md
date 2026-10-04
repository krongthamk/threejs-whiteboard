> Historical snapshot from the 2026-09-29 build; not maintained. Later evidence-retention and link corrections are preserved. See the [current implementation status](../../IMPLEMENTATION_STATUS.md) for ongoing work.

# Phase 3 — authenticated live model verification

**Evidence retention (October 2026):** Measurements below describe the original historical runs. Generated logs, raw latency/sample files, screenshots, PDFs and auxiliary JSON are no longer tracked. The audit-linked summary JSON and font metrics evidence remain; new run outputs stay local and ignored. Historical measurements were not rerun by this cleanup.

Status: **PASS for these Phase 3 model gates**, measured 2026-09-29. The full acceptance run completed all 10,000 pairs, the actual 30-second socket-offline interval, per-user history assertions, and SQLite reload checks. Its process exited with code 0. The earlier shortened infrastructure smoke is explicitly marked `acceptanceRun: false` and is not used as acceptance evidence.

## Measured result

| Check | Full-run result |
| --- | --- |
| Authenticated collaboration users | 3 distinct users |
| Concurrent operation pairs | 10,000 |
| Operations | 20,000 across all 15 required classes |
| Element validations | 771,378; zero invalid elements |
| Divergent pairs | 0 |
| Native undo / redo actions in fuzz | 1,264 / 84 |
| Actual disconnected interval | 30,001.094 ms |
| Server updates / persisted updates | 21,285 / 21,285 |
| Automatic SQLite compactions | 2 |
| Persisted snapshot plus remaining log | 1,847,740 encoded bytes |
| Fuzz runtime | 531,346 ms |
| Overall process runtime | 562.844 seconds; exit code 0 |

Durable evidence: result JSON, process exit, progress/status, runner log, and final persisted Yjs update. The final semantic SHA-256 is `ffe55f5fa68eae28e55486c17d9397ba706a3edb6f4dad7f69fedba57ba7a7b7`.

## Workload and checks

`packages/loadtest/src/live-model-fuzz.ts` starts the real production server on an isolated port and temporary SQLite/assets directory. It provisions separate users through the production Store, signs in through HTTP, creates the board and editor memberships through authenticated HTTP requests, and connects three independently authenticated Hocuspocus clients over real WebSockets. Anonymous access returns 401; an authenticated nonmember receives 404. The client replicas exchange updates only through the production server.

Each seeded pair invokes two clients synchronously before yielding to the network, so neither can receive the other's edit before its own operation. After every pair, the harness waits for provider acknowledgements and exact raw writer-array equality between all three clients and the live server Y.Doc. It then independently checks coherent schema, identity, exact derived stroke geometry, resolved connector endpoints, finite bounds, semantic convergence, and monotonic clocks. All 15 operation classes, including native undo/redo, are required for the full run.

The raw oracle covers live writer-array entries, including their coherent values, lifecycle generations and clocks. It does not compare binary Yjs tombstone layout or board metadata. Local undo histories are cleared every 200 pairs, so this is not an unlimited-history memory test. An independent backend review found no false-convergence or missing-acknowledgement hole: a persistence lag would cause the final reload assertion to fail rather than permit a false pass.

Targeted live scenarios check independent move/recolor through per-user undo, remote writes excluded from an uninvolved user's history, same-property newer-peer preservation through undo and stale redo, concurrent winner undo revealing the peer value, and deletion/restoration preserving a concurrent peer move.

The offline gate disconnects a real client socket and waits until the server reports only two connections. The offline client moves a shared shape and creates a sticky while both peers continue editing. During the measured interval, assertions verify that the socket stays closed and neither side has received the other's disconnected edits. After at least 30 seconds it reconnects through the provider protocol, checks exact convergence, and requires all independent changes to survive.

Finally, the harness reloads the production SQLite snapshot/update log into a fresh read-only model and compares complete raw and semantic state with the live server and clients. It records source hashes, progress logs, final document bytes, a semantic hash, storage/compaction metrics, and an explicit result/status file. A parent process additionally records the actual process exit code; partial progress is never a clean pass.

This run loaded the production model after experimental `clockMode` support had been removed: the ledger always shares the gesture transaction. Its exact model source hash is recorded in the artifact. During the running test, a separate `initializeMetadata: false` constructor option was added for provider-backed startup; it does not change the default path exercised by this run. It and late-arriving schema-1 rejection were independently covered by the permanent document tests. All 33 affected document/history/storage tests and TypeScript passed after that addition. The test does not claim to have loaded a source revision added after its process started.

## Reproduction and scope

Reproduce from the repository root:

```sh
pnpm exec tsx packages/loadtest/src/live-model-fuzz.ts
```

Defaults are 10,000 pairs, a 30,000 ms offline interval, and port 3002. `LIVE_MODEL_PAIRS`, `LIVE_MODEL_OFFLINE_MS`, and `LIVE_MODEL_PORT` permit diagnostic runs. A shortened run is explicitly marked `acceptanceRun: false`. Reports are written beneath `packages/model/reports/phase3-live/` with timestamped names. Test credentials and session secrets are generated for the isolated store and are not logged.

This harness establishes authenticated model/network behavior and persisted-state equivalence. It is not the S3 load benchmark and does not claim its latency/memory gates, browser interaction coverage, or complete Phase 3 acceptance beyond these model checks.
