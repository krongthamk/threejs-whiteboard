# Document storage investigation

Status: adopted as schema 2 under BUILD_PLAN §9's failed-spike amendment after semantic proof. The clean candidate run passed 10,000 concurrent pairs (818,007 validations, 47,876 delivered updates, zero invalid/divergent states). The integrated permanent suite separately passed 10,000 pairs (946,710 validations, 47,954 updates). The original schema-1 source and reports remain preserved. Targeted storage/history tests cover clock isolation, late peer edits, offline replicas, snapshot reload and fail-closed schema rejection. Numeric load-test gates are unchanged; the full candidate 30-minute run passed with 360,000 acknowledged operations and flat post-warmup retained structs; the final exact-source authenticated SQLite production run also passed: 360,000 acknowledged operations, p95 36.89 ms, maximum sampled CPU 40.73%, fixed retained structures and a reviewed heap plateau. RSS drift is documented rather than described as zero.

Artifacts: [integrated model report](../packages/model/reports/s2-schema2-fuzz.json), [candidate reports](../spikes/model-kv/reports/), and [model report](history/2026-09-29/S2_MODEL_REPORT.md).

## Trigger and evidence

S2's expanded 10,000-pair suite passes with the original nested-map model and its history repair. S3 nevertheless fails: its 30-minute run generated all 360,000 operations and 1,440,000 cursor updates, but the clients timed out during final synchronization. The last progress report recorded 344,900 acknowledgements. The final latency distribution and convergence proof were not produced. This is a failed result, not a missing result to discard.

The server's used-heap slope was +3.83 MiB/min and RSS slope +2.79 MiB/min after warmup. Separate deterministic replay isolates a structural cause: on a fixed 1,280-element board, 360,000 operations leave 446,080 Yjs structs, of which 432,000 are deleted. Encoding a snapshot and loading it into a fresh document retains those structs. The approximately 5.21 MB snapshot is larger than the initial 0.413 MB snapshot. Ordinary update-log compaction therefore does not remove this historical metadata. Authoritative traces and diagnostic outputs are linked in [S3_LOAD_REPORT.md](history/2026-09-29/S3_LOAD_REPORT.md).

The original harness runs 40 clients in one Node process. Its shared heap experienced heavy garbage collection. A replacement harness separates eight groups of five clients from the server; it must preserve 40 sockets, each client's exact 5 operations/s and 20 cursor updates/s, complete acknowledgements, and final convergence. This changes the measurement apparatus, not the acceptance criteria. The original failed artifacts remain available.

## Candidate representation

The official [Yjs key-value utility](https://github.com/yjs/y-utility) describes why alternating `Y.Map` keys retain history and offers a `Y.Array`-backed JSON key-value store. Its array scans are a known cost. Our first shared-array experiment still accumulated deleted structs with 40 writers and failed peer-preserving undo cases. It is not the candidate being considered.

The current prototype uses one key-value array per actual Yjs writer ID. A writer modifies only its own array. An immutable element base supplies complete, valid defaults and a generation identifier. Independent property entries use generation-scoped keys; `props` and `style` remain coherent JSON values. Each value carries a Lamport clock and writer tie-breaker. Reads choose the winning register across writers. An element lifecycle register selects its active base or a deletion marker. This keeps concurrent geometry and style changes independent without allowing partial element resurrection.

Native `Y.UndoManager` tracks only the local writer's array and local origin, with `captureTimeout: 0`. Removing a local winning entry can reveal a peer's prior entry instead of erasing that peer's edit. Redo restores the old causal stamp, so it cannot overwrite a causally newer peer update. A persistent clock entry prevents a newly loaded writer from reusing a clock hidden by undo. The clock and user fields are written in the same gesture transaction. The prototype isolates the clock's Yjs Item before undo so the documented [`deleteFilter`](https://docs.yjs.dev/api/undo-manager) can preserve it. That isolation uses exported low-level functions from pinned Yjs 13.6.33 and requires explicit regression coverage before adoption.

This is our proposed use of those primitives, not an upstream guarantee of the whiteboard's correctness or performance.

## Required proof before adoption

- Repeat 10,000 concurrent operation pairs across three clients with semantic validation, randomized delivery, undo/redo, and exact convergence.
- Preserve independent properties and peer edits through winner undo, local deletion undo, and redo after a newer peer edit.
- Verify fresh snapshot reload, offline old writers, equal-clock ties, deletion/recreation generations, and monotonic clock behavior.
- Verify exactly one document update and one undo step for a compound local gesture, with no extra clock packet.
- Repeat the fixed-board 360,000-operation structural diagnostic and the full 30-minute transport workload using the actual stamped representation.
- Measure creation, deletion, and writer churn separately. Bounded repeated edits with fixed writers do not establish bounded memory under unlimited new writers, new elements, generations, or local undo history.
- Preserve the public document/projection contract, validate mutation batches before Yjs transactions, document the pinned low-level dependency, and rerun renderer/text tests after integration.

A successful result can amend D3 and the schema/history sections of the plan. It cannot silently relax S2 or S3, discard offline edits with a fresh-document reset, or claim that ordinary snapshots reclaim information needed by disconnected replicas.
