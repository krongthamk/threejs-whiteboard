# S2 — coherent Yjs document model

Measured 2026-09-29 with Yjs 13.6.33, y-utility 0.1.4 and Vitest 5.0.2. **PASS for production schema 2:** 10,000 concurrent operation pairs across three replicas, zero invalid elements, zero divergent pairs. The production adapter preserves the document API and now uses writer-owned registers under the explicit D3/D7 amendment in BUILD_PLAN §9. S3 transport/memory gates are separate and remain unchanged.

## Why schema 2 replaced the passing schema 1 model

The original nested-map schema passed S2, including its two peer-preserving native-history repairs. S3 then measured persistent linear Yjs metadata growth under the exact 40-writer workload and its full run timed out during final synchronization. A single shared YKeyValue array also failed interleaved-writer growth and peer-preserving undo. Those failures triggered the plan's failed-spike exception; they were not removed from the evidence.

The original model's 870,897-validation result remains in [s2-fuzz.json](../packages/model/reports/s2-fuzz.json). Its implementation, tests and report are preserved in [baseline-v1](../spikes/model-kv/baseline-v1). The alternatives, rejected assertions, private-API dependence and retention measurements are documented in [the isolated storage report](../spikes/model-kv/REPORT.md) and [D3_STORAGE_INVESTIGATION.md](D3_STORAGE_INVESTIGATION.md).

## Production representation and API

`BoardDocument` owns the Y.Doc, metadata and native local UndoManager. One YKeyValue array belongs to each actual Yjs writer ID; only that writer inserts its entries. A logical key chooses its greatest `(Lamport clock, writer ID)` value. Each element has a complete immutable base with a generation identifier. Geometry fields are independent generation-scoped registers; `props` and `style` remain coherent JSON values. A lifecycle register selects a base or a deletion marker. Old-generation fields cannot alter a recreated element, and missing lifecycle data cannot expose a partial element.

Reads validate the complete raw projection before deriving geometry and deep-clone JSON so callers cannot mutate CRDT values outside a transaction. Per-key candidate indexes initialize in O(records); ordinary changes inspect only the affected key's candidates. Active element IDs avoid scanning historical generation fields on every read. A maximum fractional-index cache supports bulk creation without repeatedly sorting all elements.

The preserved API includes `create`, `read`, `readAll`, `update`, `updateMany`, `updateStyle`, `move`, `delete`, `duplicate`, `reorder`, `transact`, `subscribe`, `meta`, `undoManager` and `doc`. Subscribers receive affected IDs once per transaction, including the first update from a previously unseen remote writer. Schema 1 documents are explicitly rejected without resetting or changing their contents; this is an incompatible storage schema, not a silent migration.

Local construction initializes missing metadata by default. Provider-backed callers can explicitly use `new BoardDocument(doc, { initializeMetadata: false })` before IndexedDB/network synchronization. This writes no competing title, creation timestamp or schema value and emits no constructor update/history. Existing and subsequently arriving incompatible schemas are rejected before projection reads or mutations. A permanent regression verifies that server metadata and elements arrive unchanged.

Mutation helpers clone and validate complete patches/batches before entering Yjs's non-rollback transaction. Functions, dates, maps, cycles, undefined values, nonfinite numbers and invalid coherent payloads are rejected before a packet or undo step can be produced. Element IDs and types are immutable. Fractional indexes order elements, with deterministic ID comparison and reordering across tied groups.

## Local history and persistent clocks

A gesture uses `LOCAL_ORIGIN`, native Y.UndoManager, `captureTimeout: 0`, and only the local writer's array. Nested helpers share the enclosing transaction. Undo removes/restores local candidate entries, so it can reveal the competing peer value; a causally newer peer write survives local undo and old redo. Undoing deletion restores the original generation with peer geometry and coherent payload changes intact.

The production clock ledger is always written in the same transaction as user fields. The alternative experimental clock mode remains only in the isolated candidate; production does not expose it. A compound gesture is proven to produce one document update and one undo step. The clock persists through undo and encoded snapshot reload so a new writer cannot reuse a stamp hidden by history. The documented UndoManager `deleteFilter` preserves that current clock. **Pinned low-level Yjs dependency:** because adjacent JSON entries can coalesce into one Item, `createRelativePositionFromTypeIndex`, `getItemCleanStart` and `getItemCleanEnd` isolate the ledger before undo. The split helpers are exported low-level Yjs 13.6.33 APIs, so upgrading Yjs requires the full regression suite. The former nested-map StackItem repair is no longer used by production.

History-clear tests inspect the authoritative struct by ID, because array tombstone merging can replace an Item object. They verify that native history releases retained local Items and actual garbage collection removes their content. If Yjs changes `doc.clientID` after a real collision, local mutation, undo and redo fail closed with an explicit reload error before changing state.

## Reproduction and clean results

```sh
pnpm exec vitest run packages/model/test --disableConsoleIntercept
pnpm exec tsc --noEmit
```

The permanent fuzz uses seed `334462` (`0x51a7e`), three fixed replica IDs, and exactly two concurrent local operations before delivery for every pair. It varies packet ordering and repeats packets, drains cleanup updates until quiescence, compares complete raw writer arrays and coherent projections after every pair, and checks nondecreasing local clocks. Every visible element is schema-validated; additional assertions verify exact derived stroke boxes, finite resolved connector endpoints, valid fractional indexes, and finite nonnegative bounds. The suite requires all 15 operation classes and exactly 20,000 operations; undo histories are periodically cleared.

[Production raw result](../packages/model/reports/s2-schema2-fuzz.json):

- 10,000 concurrent pairs; 20,000 operations; 946,710 validated elements.
- Zero invalid elements and zero divergent pairs; 47,954 delivered updates.
- All 15 classes, including 1,320 undo actions and 78 redo actions.
- Fuzz duration 77,423 ms; four-file run 29 tests passed in 77.65 seconds.
- Ten additional permanent storage tests passed separately, for **39 passing tests** across five files. TypeScript check passed.

Production cleanup subsequently removed the unsupported clock-mode option. Its two duplicate control-mode cases remain in the isolated prototype; the same supported-mode assertions remain permanent. Two provider-metadata cases were added, so the current suite still contains 39 cases. All 33 affected document/history/storage cases passed after those changes, and TypeScript passed. The text tests and full fuzz evidence above remain unchanged; authenticated live coverage is recorded separately in PHASE3_MODEL_REPORT.md, with exact source hashes for its loaded implementation.

Durable full-run evidence: [Vitest JSON](../packages/model/reports/s2-schema2-vitest.json), [runner exit status](../packages/model/reports/s2-schema2-runner-status.json), and [runner log](../packages/model/reports/s2-schema2-runner.log). The isolated candidate also has a clean 10,000-pair pass with 818,007 validations and exit code 0. Its initial 180-second timeout failure and subsequent lost runner-status incident are retained; neither was mislabeled a clean suite pass. The final candidate run preserved every-pair raw equality while replacing recursively sorted raw serialization with stricter exact JSON ordering comparison.

The targeted tests cover peer-preserving same-property undo, independent move/recolor, deletion/restoration, repeated redo/undo, history clearing/GC, equal-clock ties, concurrent different-type creation, offline old generations returning after fresh reload, collision rejection, batched validation, immutable reads, transaction subscriptions, one-step gestures, 1,000-element bulk ordering, schema rejection, geometry, SVG, fonts and caret mappings.

## Retention limits

Bounded hot edits over fixed writers, generations and logical fields do **not** imply memory bounded by visible element count. Obsolete generations and retired writer arrays are retained to preserve undo and disconnected replicas. The isolated measurement of 200 create/edit/delete/undo/redo cycles leaves zero visible elements but 402 logical records, 1,800 structs and a 255,912-byte snapshot. Production repeats this measurement in [schema2-lifecycle-retention.json](../packages/model/reports/schema2-lifecycle-retention.json). Neither ordinary snapshot encoding nor this adapter discards retired writers or old generations. Writer churn, long lifecycle histories and the full S3 transport workload require their own measured gates.

## Shared geometry, text and export

Stroke triplets use world coordinates; reads derive their boxes from coherent points. Text with automatic sizing derives its box from coherent text and style. Bound connectors store a deterministic fallback in the same coherent props value. Normal deletion detaches known bindings at the latest visible endpoint in the deletion transaction; undo restores target and binding. A concurrently created binding resolves a missing target through its stored fallback, giving every replica the same result.

The pure `documentToSvg` helper shares stroke outlines, connector arrows, sticky corners, geometry and explicit line wrapping with the renderer. It safely escapes markup, resolves assets through a callback, and embeds supplied font data. Its text family list includes the resolved Inter/IBM Plex Mono family and locally supplied Noto Sans JP fallback.

Font metrics are generated from the exact shipped Inter/IBM Plex Mono WOFF bytes with troika 0.52.5's parser and checked SHA-256 hashes. Independent browser measurement of 60 strings/sizes found maximum width error **0.0003052 px** and zero mismatches in six real DOM wrapping cases; [raw browser evidence](../packages/model/reports/font-metrics-browser.json) is retained. Unsupported scripts use deterministic fallback advances. UTF-16 source/render mappings preserve caret positions across inserted and consumed wraps. Regenerate with `node packages/model/scripts/generate-font-metrics.mjs`; verify with the spike server running and `node packages/model/scripts/verify-font-metrics.mjs`.

This report establishes S2 and the model integration evidence. It does not claim S3 acceptance, universal bounded retention, browser performance gates, or completion of later phases.
