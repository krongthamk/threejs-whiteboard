# S3 archived-source comparison

**Evidence retention (October 2026):** Measurements below describe the original historical runs. Generated logs, raw latency/sample files, screenshots, PDFs and auxiliary JSON are no longer tracked. The audit-linked summary JSON and font metrics evidence remain; new run outputs stay local and ignored. Historical measurements were not rerun by this cleanup.

Audited **2026-09-29T19:04:02.862866+00:00**. This is a source snapshot taken while the archived run and model font work were still in progress, not the final source freeze or a performance result.

Archive: `s3-production-2026-09-29T18-46-22.867Z.sources.json`. Manifest SHA256: `b5ceff96b7276528ed343349be09b5637eedd794d21c9b2fae4d37c045f17556`. Every one of its **22 source strings and 22 frozen `.inputs` files** matches its recorded SHA256. The coordinator forks the frozen inputs; dependency directories are shared, and the captured lockfile remains unchanged. All full hashes and byte counts are in source-audit.json.

**18 of 22 current files are identical.** The harness, production worker, benchmark, BoardDocument, schema, geometry, Store, static server and dependency manifests/lockfile are unchanged. Changed files at this timestamp:

| File | Archive SHA256 prefix | Current SHA256 prefix |
|---|---|---|
| `packages/server/src/server.ts` | `37994ffb004c` | `9b311ac53608` |
| `packages/model/src/font-metrics.generated.json` | `0ece43f452a8` | `71030abe5634` |
| `packages/model/src/svg.ts` | `4992f8f19de6` | `58ec9b3e1410` |
| `packages/model/src/text-layout.ts` | `528a293ab431` | `7c3bcdfb3bd2` |

## Workload and unchanged execution paths

The production worker initializes **960 strokes and 320 rectangles** across 40 independent document/provider/socket clients in eight worker processes. Each client performs five mutations per second: **60% 48-point pressure-stroke props replacements, 20% rectangle x/y movement, 20% rectangle style changes**, plus 20 Hz cursor awareness. Stroke bounds change through derived point bounds; the test has no distinct rectangle-resize gesture. All clients use one freshly issued owner session. The workload does not exercise text, images, SVG/PDF export, login renewal, logout, role changes, reconnection or accumulating new writer identities.

Per-message authentication/ACL checks, synchronization, update persistence/compaction, awareness processing and stroke/rectangle model projection are unchanged. `deriveElementGeometry` calls the changed text sizing only for auto-sized text, which the harness never creates. New text-layout and SVG functions therefore do not execute for this mutation mix.

## Added allocations and unexercised controls

- `server.ts:95–103` now disconnects matching live subscriptions on HTTP logout. The harness never calls that endpoint.
- `server.ts:166–176` adds an expiry scalar, an unreferenced timeout and a close callback per active document connection: **40 timers** for this harness. Hocuspocus invokes `connected` once per document connection; `onClose` clears its timer. Scheduling occurs during setup before the measurement reset. The fresh session expires after **12 hours**, so its callbacks do not fire during 30 minutes under the benchmark clock assumptions. There is no added per-packet polling. This establishes allocation count and lifecycle by source inspection, not exact CPU or heap cost.
- The metrics JSON is eagerly imported through the model index even without text. At this snapshot it grows from **61,675 to 697,977 UTF-8 bytes**, a **636,302-byte** source increase. It adds retained module data in the server benchmark and worker processes; source-byte growth is not a measurement of JavaScript heap or RSS. Text computation allocations remain outside the workload.

## Acceptance boundary

The archived run remains direct evidence for its recorded revision and the unchanged mutation/persistence paths. It cannot certify the final revision's CPU, latency or memory measurements: the expiry allocations and expanded font data were absent. A constant retained allocation is distinct from a leak, but source analysis cannot replace the numerical memory gate. Logout/expiry correctness and text behavior also require separate functional tests.

The root agent will freeze the completed source and rerun the unchanged **30-minute** harness for exact-source acceptance. This audit does not waive any gate, count a short run as the memory gate, or claim that the still-running archived experiment passed.
