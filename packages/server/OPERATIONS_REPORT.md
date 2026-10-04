# Server operating checks — 2026-09-29

Fifteen integration tests pass on the selected Apple M1 Pro Mac, Node 26.8.1
(included in the final repository 82-test pass):
HTTP session/ACL/CSRF/logout; authorized image copy; WebSocket viewer enforcement,
revocation and restart recovery;
SIGKILL process exit followed by SQLite WAL recovery of committed edits; original-clock compaction/offline merge;
1,000 concurrent schema 2 operation pairs plus peer-safe undo; measured 30-second
offline reconnect; coherent online backup/verified restore; deterministic owner
routing, real HTTP/WebSocket proxying, readiness and drain behavior; 40 distinct
accounts signing in behind one NAT with bounded account/IP failures; live
editor-to-viewer reset, dirty readonly reconnect rejection and safe regrant;
static SPA/font/cache serving and traversal/symlink containment; passive logout
revocation scoped to the exact token, and passive expiry at the signed deadline.

The separate history drill retained 100,000 actual schema 2 updates after a 1,280
mixed-element initialization. Its 60/20/20 stroke/move/style mix generated
83,539,981 update bytes, each committed through SQLite WAL synchronous FULL.
Production thresholds triggered 15 compactions; the final requested compaction
made 16. The final snapshot is 1,089,571 bytes and the log is empty. All 1,280 elements
and the canonical document hash survived reconstruction.

Reload measurements including SQLite read, Yjs apply, model construction and
full projection were 67.781 ms, 42.376 ms, 34.957 ms, all below the 2 s gate. Hashing was
timed separately. These are sequential OS-cache-warm reads, not a cold disk
power-cycle benchmark. The fixture emulates 100,000 historical updates, not six
calendar months or unlimited creation/deletion churn. It uses one writer;
40-writer transport behavior is measured by S3 separately.

The same drill used SQLite's online backup API, included immutable asset bytes
and the session secret, verified file hashes/integrity, restored to a fresh
folder, and reproduced the document hash and exact asset bytes. The integration
test also verifies account/session recovery and rejection of a corrupted backup.

Raw evidence: `../loadtest/results/history-2026-09-29T09-04-08.887Z.json` and its
`.ndjson`; local `.storage`, `.backup`, and `.restored` directories are retained
but ignored by Git. The final exact-source production S3 has also passed, as
documented below; the earlier in-memory candidate alone did not establish
persistence-enabled CPU/latency/memory acceptance.

## Six-month writer and lifecycle churn

`churn-2026-09-29T18-41-21.033Z` completed 180 accelerated daily workloads:
two fresh actual Y.Doc writers per day, 300 gestures per writer, totaling
108,000 actual SQLite-committed updates. Each day deletes/recreates five reused
element IDs, totaling 900 lifecycle pairs. The visible inventory stays at 106:
80 stable shapes, 20 stable strokes, five cycling IDs and an offline-merge probe.
The modular schedule touches 12 stroke IDs, 16 moved shape IDs and 16 distinct
restyled shape IDs; 56 stable IDs remain cold. Strokes have 12 pressure points.
This workload measures churn separately from S3's 48-point stroke workload.
The adjacent independent `.review.json` clarifies hot IDs in the archived
assumption text; raw measurements and archived source are unchanged.

| Simulated day | Actual updates | Nonempty retired writer arrays | Snapshot bytes | Retained structs |
| --- | ---: | ---: | ---: | ---: |
| 30 | 18,000 | 61 | 770,902 | 5,974 |
| 60 | 36,000 | 121 | 1,511,370 | 11,944 |
| 90 | 54,000 | 181 | 2,251,529 | 17,914 |
| 120 | 72,000 | 241 | 2,992,834 | 23,884 |
| 180 | 108,000 | 361 | 4,473,987 | 35,824 |

After final compaction, three complete SQLite-read/Yjs-apply/model-construction/
106-element-projection measurements were **163.93, 147.01 and 146.90 ms**.
All are below 2 s. They are sequential OS-cache-warm reads with hashing excluded.
No timestamp was backdated; this simulates daily work and turnover, not actual
six-month wall-clock aging. It deliberately retains all retired writer arrays
and generations, so growing storage under ongoing churn remains a documented
limitation rather than a bounded-memory claim.

A day-zero replica remained disconnected until after the final compaction and
reload. Its independent x/y movement and the latest online recolor both survived;
its edit to an obsolete generation did not leak into the recreated element.
Raw writer arrays and visible projections agree after reconnect, and the old
writer's next edit advances beyond the observed remote Lamport clock. A verified
backup and fresh-directory restore reproduce both raw and projection hashes.
The final state has 362 nonempty writer arrays (361 retired), 25,133 records,
35,829 retained structs (17,822 deleted), and a 4,474,701-byte snapshot. Of those
records, 362 are clock ledgers, 179 are winning visible-element registers, and
24,592 are other retained records; 1,792 records target obsolete generations.
The result records the backup database SHA256 and all source hashes. Independent
model-agent review found no false-pass issue in these stated oracles.

Reproduce with `pnpm --filter @whiteboard/loadtest churn`. `CHURN_DAYS=2` is only
a diagnostic smoke and reports `passed: false` for the 180-day acceptance gate.

## Final production load acceptance

`s3-production-2026-09-29T19-27-40.330Z` passed the exact 1,800-second workload
with the production authentication, session-expiry timers, permission hooks and
SQLite persistence enabled: 40 independent clients completed 360,000 operations
and acknowledgements, 1,440,000 cursor updates and zero disconnects. Round-trip
p95 was **36.89 ms**, with a disclosed maximum of **1,179.97 ms**; maximum server
CPU was **40.73% of one logical core**. Post-warmup RSS/heap slopes were
**+0.23561 / +0.001261 MiB/min**. The complete memory review records modest RSS
drift while heap floors and CRDT metadata remain stable under the fixed workload.

All 40 client projections match the live server and reloaded SQLite state;
all nine children exited zero, and no benchmark process remains. Independent
raw-data verification passed every assertion. The archived import tree excludes
app/renderer sources and all archived source hashes match the worktree at both
launch and completion. The final source had passed the repository's 82 tests,
including all 15 server/static tests. Optional static serving was disabled in
the load fixture and is covered separately by those HTTP tests.

See the [S3 report](../../docs/history/2026-09-29/S3_LOAD_REPORT.md#final-source-locked-acceptance-run)
for the full workload contract, five-minute memory windows, latency tail,
source audit, plots and preserved failed/reference runs. This passes the stated
production load gate on the selected Mac; the writer/lifecycle storage-growth
limitation measured above remains explicit.
