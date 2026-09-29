# Writer-owned register experiment

Status: candidate **passed** and its representation was integrated as production schema 2 under the explicit D3/D7 amendment. The isolated prototype remains stable for the server experiment. The first full loop completed every assertion but exceeded the original 180-second runner timeout; its failure is preserved in [writer-fuzz-timeout.json](reports/writer-fuzz-timeout.json). A second completion lost its runner status during an environment update. The final run has a durable clean exit and Vitest pass. Transport and memory gates remain separate requirements.

## Representation and rejected alternative

The [official Yjs utility](https://github.com/yjs/y-utility/blob/main/y-keyvalue.js), pinned to `y-utility@0.1.4`, stores JSON key/value records in a Y.Array and removes superseded records. A single shared array did not solve our workload: the server experiment observed linear deleted-struct growth across interleaved writers, and `model.test.ts` preserves two failing assertions for peer-preserving undo. Run those failures explicitly with `rejected-flat.vitest.config.ts`.

`writer-model.ts` instead allocates one array named `element-properties:<Yjs clientID>` per writer. Only that writer inserts its records. A key's candidate values are ordered by `(Lamport clock, writer ID)`, with a deterministic lexical writer tie-break. A complete immutable base record selects an element's type and generation. Generation-scoped overrides keep geometry independent from coherent `style` and `props` values. Deletion writes a null lifecycle record. A missing lifecycle record cannot expose incomplete fields; an old generation cannot overwrite a recreated element.

The Y.Doc remains the authority. Winner caches and in-transaction pending values are projections, not a second stored document. Encoded updates, snapshots, disconnected writers, and native Y.UndoManager remain in use. There is no fresh-document reset, discarded update, or offline-writer eviction.

## Undo and clock behavior

Native Y.UndoManager tracks the local writer array, `LOCAL_ORIGIN`, and zero capture timeout. Undo removes or restores only local candidate values. A peer's value remains available, and redo restores the old stamp rather than creating a new causal write. A per-writer `$clock` ledger survives undo and snapshot reload so new writers advance beyond stamps hidden by undo.

The default ledger write shares the same Yjs transaction as the gesture. A compound move is proven to emit exactly one document update and create one undo step. The documented `deleteFilter` preserves the current ledger during undo. Yjs can merge a field and ledger into a single Item; therefore `beforeTransaction` isolates the current ledger Item with exported `createRelativePositionFromTypeIndex`, `getItemCleanStart`, and `getItemCleanEnd`. The latter two are low-level APIs pinned to Yjs 13.6.33. Their behavior is an explicit upgrade risk covered by clock/undo regressions. `separate-untracked` is retained as an experimental control, not the default or an undocumented extra gesture transaction.

Yjs can change `doc.clientID` after detecting a collision. The adapter checks its captured writer identity before local mutation, undo, or redo and fails closed with a reload error. A regression creates an actual colliding Yjs update, verifies the changed ID, and confirms rejected actions produce no state mutation.

## Targeted proof

`writer-model.test.ts` currently passes 10 tests covering:

- Concurrent move/recolor, concurrent same-property winner undo, and local deletion undo retaining a peer's moved geometry.
- Undo followed by snapshot reload and a fresh writer, with old redo unable to beat the newer peer.
- Equal-clock concurrent creation of different element types, with complete generation selection through undo and redo.
- An offline old writer returning after deletion/recreation and fresh-client reload.
- One transaction/update/undo step for a compound move, and nondecreasing ledger clocks.
- Repeated create/edit/delete/undo/redo and history clearing, with measured retention.
- Actual client-ID collision and rejection before local writes or history actions.

The clean seeded loop is recorded in [writer-fuzz.json](reports/writer-fuzz.json): 10,000 concurrent pairs, 20,000 operations, 818,007 element validations, 47,876 delivered updates, zero invalid elements, and zero divergent pairs. It exercises all 15 operation classes, including 1,281 undo and 86 redo actions, compares raw writer arrays and semantic projections after every concurrent pair, validates derived bounds, and checks monotonic clocks across three clients. Runtime was 361,863 ms; [Vitest JSON](reports/writer-fuzz-vitest.json), [runner status](reports/writer-fuzz-runner-status.json), and [log](reports/writer-fuzz-runner.log) record the pass. Every-pair raw comparison now uses exact JSON serialization, including object ordering, instead of recursively sorting all retained history. No semantic checks or product performance gates were reduced.

## Bounds and outstanding gates

The candidate only claims a potential plateau for repeated edits over a fixed set of writers, element generations, and logical fields with bounded local undo retention. It does **not** claim memory bounded by visible element count. Obsolete generation fields and retired writer arrays are retained for undo and offline merge. [Raw lifecycle measurements](reports/lifecycle-retention.json) show 200 create/delete/recreate cycles leave zero visible elements but 402 live records, 1,800 structs, and a 255,912-byte snapshot. This growth is intentional retained information, not reclaimed by snapshot encoding.

The server agent owns structural and transport measurements. A bare per-writer storage plateau does not establish the stamped adapter's full 360,000-gesture transport result. Fresh writer sessions, large historical documents, and long lifecycle churn need separate load measurements before broader retention claims.

## Production integration

The approved schema 2 integration preserves `create/read/readAll/update/updateMany/updateStyle/move/delete/duplicate/reorder/subscribe`, `meta`, `doc`, and `undoManager`. Callers do not need raw storage containers. Complete mutation batches are validated before Yjs's non-rollback transaction; connector fallback and geometry/export contracts remain intact. Schema 1 is explicitly rejected without mutation.

Production uses an incremental per-key actor-to-value index, active base IDs and a maximum fractional-index cache. Its permanent 10,000-pair run passed with 946,710 validations, zero invalid states/divergence and a 77,423 ms duration; 39 model tests pass across the full run and added storage-regression run. See [S2_MODEL_REPORT.md](../../docs/S2_MODEL_REPORT.md). Renderer, browser, actual transport and long-history measurements are owned by the parent/other agents and are not implied by this result.
