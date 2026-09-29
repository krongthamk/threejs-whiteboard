# Building a Miro / Excalidraw-class Collaborative Whiteboard on three.js

**Research date:** 2026-09-29
**Target:** infinite-canvas whiteboard (freehand, shapes, text, connectors, sticky notes, selection/transform, pan/zoom, undo/redo, export) rendered with three.js, self-hosted, real-time collaborative for teams of up to 40 concurrent users per board.

**Method:** 5 parallel search angles, 21 sources fetched, 100 claims extracted, top 25 adversarially verified with 3 independent votes each. 22 confirmed, 3 refuted, 0 unverified. Every URL cited below was fetched and checked on the research date.

---

## 1. Executive summary

Building this is feasible, but the verified evidence points to two distinct obstacle classes:

1. **three.js has no native 2D text primitive.** Text, sticky notes and in-canvas editing must be built on `troika-three-text`, whose worker-based SDF pipeline is inherently asynchronous and has a per-instance draw-call cost.
2. **Collaboration for 40 users per board is inside what production engines target** (tldraw sync is designed for ~50 editors per room), but you must choose between a server-authoritative rebase / last-write-wins model (Excalidraw's `versionNonce` reconciliation, tldraw's confirmed-vs-pending layers) and a CRDT model (Yjs `Y.Doc` as the authoritative scene, per-property `Y.Map`s, `Y.UndoManager` for per-user undo).

**Recommended path:** WebSocket client-server topology with one authoritative process per board (Hocuspocus or y-websocket, or a per-room Durable-Object-style server), explicit separation of document / session / presence state, a single node per board for 40 users, Redis fan-out only for high availability, and sharding by board ID for CPU limits.

**Licensing is a first-order constraint.** tldraw's SDK is source-available and requires a paid or trial license key for any production deployment since v4.0. Excalidraw is MIT. Treat tldraw as a reference architecture, not a free building block.

**The rendering question (three.js/WebGL vs 2D canvas) was not settled by verified evidence.** The one claim on it was refuted 0-3.

---

## 2. Obstacles

### 2.1 Text rendering in three.js (confidence: high, votes 3-0 / 3-0 / 3-0)

three.js core has no 2D text primitive. The standard solution is `troika-three-text`:

- Generates a signed-distance-field glyph atlas **on the fly** from real font files (`.ttf`, `.otf`, `.woff`). **`.woff2` is not supported.**
- All font parsing, SDF generation and glyph layout run in a **web worker**, so every text update is asynchronous. Text is not visible until `sync()` completes. Handle via `sync()` callbacks or the `synccomplete` event. `useWorker: false` is still asynchronous.
- **Each `Text` object is its own mesh.** Frame rate degrades at roughly 500+ instances (troika issue #117 documents the per-instance draw-call cost).
- It ships `getCaretAtPoint()` and `getSelectionRects()` as building blocks for an in-canvas editor with caret and selection highlighting. Callers must convert raycast hits to the text's local plane. **The library does not implement editing itself.**
- Current version: 0.52.5, published July 2026.

Sources:
- https://github.com/protectwise/troika/blob/main/packages/troika-three-text/README.md
- https://github.com/protectwise/troika/issues/117

### 2.2 Licensing (confidence: high, votes 3-0 / 2-1 / 3-0)

- The **tldraw SDK is source-available, not open source.** Since the v4.0 license change (LICENSE.md commit `e455ab83`, 2025-09-17, still current) the default license prohibits use in *Production Environments*, defined as any deployment on servers, cloud platforms or web applications that provides functionality to end users, customers or the public. Only internal, non-public development / staging is free.
- A self-hosted collaborative board for a 40-person team is a Production Environment under that definition.
- Production use needs a License Key: a free 100-day trial, a commercial license (independently reported at about USD 6,000 / year per team), or a discretionary watermarked hobby license for non-commercial projects, which an internal company tool would generally not qualify for.
- Without a key the SDK **stops rendering after five seconds** in production.
- tldraw 3.x packages remain available under the prior watermark license.
- **Excalidraw is MIT-licensed** and can be copied from freely.

Sources:
- https://github.com/tldraw/tldraw/blob/main/LICENSE.md
- https://tldraw.dev/community/license
- https://tldraw.dev/sdk-features/license-key
- https://tldraw.dev/blog/tldraw-sdk-4-0
- https://tldraw.dev/releases/v4.0.0

### 2.3 Conflict resolution is a design choice, not a library pick

Both proven open whiteboards avoid general-purpose CRDTs for canvas data. tldraw's sync announcement states "general-purpose CRDTs aren't built for canvas data." See section 3 for the three viable models and their trade-offs.

### 2.4 Rendering strategy is unsettled

The only claim comparing Canvas 2D to WebGL ("Canvas 2D is the default for mainstream whiteboard libraries and WebGL is only warranted at tens of thousands of elements") was **refuted 0-3**. No verified source covered:

- whether an instanced / batched WebGL renderer beats a 2D canvas with viewport culling for typical Miro-style boards
- freehand stroke tessellation
- instancing and culling strategies
- PNG / SVG / PDF export from a three.js scene graph

Expect to build stroke geometry, hit testing and export yourself, and benchmark early.

### 2.5 The "40 users" number is soft

tldraw sync targets about 50 editors per room on a single Cloudflare Durable Object. That figure is README / marketing copy, not a published benchmark, and an older README said ~30. No verified source gave CPU, memory, bandwidth or awareness-message-rate figures for 40 live cursors on one node.

---

## 3. Reference architectures

### 3.1 Excalidraw: element-level LWW without a CRDT (confidence: high, votes 3-0 / 3-0)

- **Transport:** Socket.IO over WebSocket. Chosen over Firebase for auto-reconnection, binary `ArrayBuffer` support (end-to-end-encrypted payloads) and rooms to scope broadcasts. Current `Portal.tsx` uses `socket.io-client` 4.7.2 and emits encrypted buffers to rooms.
- **Conflict resolution** (still in `reconcile.ts` on master):
  - merge local and incoming element sets by ID union
  - tombstone deletions with an `isDeleted` flag
  - keep the highest per-element `version`
  - break ties deterministically with the lower `versionNonce`, so one peer wins on every client
  - elements currently being edited locally are always kept
  - ordering uses fractional indices
- **Persistence:** Firebase / Firestore was retained for encrypted scene persistence (`firebase` 11.3.1 is still a dependency). The Socket.IO relay is **not** the only stateful component; the "stateless relay" claim was refuted 1-2.
- Open issues #3537 and #7161 confirm no CRDT is used.

Sources:
- https://plus.excalidraw.com/blog/building-excalidraw-p2p-collaboration-feature
- https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/data/reconcile.ts
- https://github.com/excalidraw/excalidraw/blob/master/excalidraw-app/collab/Portal.tsx

### 3.2 tldraw sync: server-authoritative push / pull / rebase (confidence: high, votes 3-0 x4)

- Designed for **up to ~50 simultaneous editors per canvas.**
- Not CRDT or OT. Each client keeps a **confirmed-server-state layer** plus a **pending optimistic-edits layer**. On conflict it reverses local changes, applies server diffs, and re-applies pending changes (`TLSyncClient.ts`, `pendingPushRequests` / `clientClock`).
- Server applies **last-write-wins per property** with tombstones and clock ordering.
- Reference deployment: **one Cloudflare Durable Object per room**, reached over WebSockets. The Durable Object owns the WebSocket connections, the in-memory document and SQLite persistence. "There's only ever one authoritative copy of each room's data."
- Scaling is **per room** (one authoritative mini-server per board), not per central server. No WebRTC / P2P.

Sources:
- https://tldraw.dev/features/composable-primitives/multiplayer-collaboration
- https://tldraw.dev/docs/sync
- https://github.com/tldraw/tldraw-sync-cloudflare
- https://github.com/tldraw/tldraw/blob/main/packages/sync-core/src/lib/TLSyncClient.ts
- https://tldraw.dev/starter-kits/multiplayer

### 3.3 tldraw store: three state scopes (confidence: high, vote 3-0)

| Scope | Contents | Persisted | Synced |
|---|---|---|---|
| **document** | shapes, connectors, pages | yes | yes |
| **session** | camera, current page, UI prefs | optional | no |
| **presence** | cursors, selections, awareness | no | yes (instantly) |

`RecordType.ts` on main: `export type RecordScope = 'session' | 'document' | 'presence'`. This maps directly to a collaborative three.js canvas: cursors and selection highlights must be broadcast at high frequency but must not pollute the persisted document or the undo history.

Sources:
- https://tldraw.dev/features/composable-primitives/data-management
- https://tldraw.dev/sdk-features/store
- https://github.com/tldraw/tldraw/blob/main/packages/store/src/lib/RecordType.ts

### 3.4 Yjs as the scene model (confidence: medium, votes 2-1 / 3-0 / 3-0)

If a CRDT is preferred over a custom LWW scheme, Yjs can be the foundation for the whole scene model, not just a sync layer:

- A `Y.Doc` can be the authoritative store for collaboration, persistence (encoded Yjs updates), undo history and headless editing (demonstrated by the `excalidraw-yjs` fork).
- Modeling each element as a **nested per-property `Y.Map`** lets concurrent edits to different properties of the same element merge without overwriting. Empirically verified with yjs 13.6.33: one user moves while another recolors converged to `{x: 100, color: 'red'}`, whereas element-level JSON LWW lost the move.
- `Y.UndoManager` with `trackedOrigins` gives **per-user undo**: remote updates arrive under the provider's origin and are never captured, so a user undoes only their own edits. Default `trackedOrigins = new Set([null])`; "the UndoManager will never overwrite remote changes."

Qualifications:

- Per-property merging can produce **semantically inconsistent elements** (e.g. `width` vs `points` disagreeing). This is why Excalidraw and `y-excalidraw` deliberately sync at element level. The `y-excalidraw` author notes of key-level merges: "I am not sure if this final state is always valid."
- Undo of non-document app state **still needs a JS-side history stack** alongside `Y.UndoManager`. The stronger claim "no own undo stack needed" was refuted 1-2.
- yjs issue #273: same-client multi-origin interleaving within `captureTimeout` can merge stack items (workaround: `captureTimeout: 0`).
- Images should be external assets, not in the document.
- `excalidraw-yjs` itself is a young single-author project (0 stars, v0.5.2, ~3 months old). Its code was inspected and Yjs core behaviour was tested directly, but it is not evidence of production adoption.

Sources:
- https://github.com/alkem-io/excalidraw-yjs
- https://docs.yjs.dev/api/undo-manager
- https://github.com/yjs/yjs/blob/main/src/utils/UndoManager.js
- https://github.com/RahulBadenkal/y-excalidraw
- https://github.com/yjs/yjs/issues/273

---

## 4. Transport, hosting and scaling

### 4.1 y-websocket topology (confidence: high, votes 3-0 / 3-0)

- Centralized client-server: all clients connect to one WebSocket endpoint; the server distributes document updates and awareness (cursor / presence) data.
- **A single server suffices for 40 users on one board.**
- Scaling beyond one server requires either:
  - a **pub/sub layer**, one channel per room (historically `y-redis`, now `@y/hub`, which streams updates through Redis streams and does not keep a `Y.Doc` in memory), or
  - **sharding by consistent hashing** so each document is owned by exactly one server, with a routing proxy and health checking (e.g. etcd).
- The bundled in-memory y-websocket backend is explicitly described as "can't be scaled easily"; the README recommends `@y/hub` (beta, AGPL / proprietary dual license).

Sources:
- https://docs.yjs.dev/ecosystem/connection-provider/y-websocket
- https://github.com/yjs/y-websocket
- https://github.com/yjs/yhub

### 4.2 Hocuspocus scaling paths (confidence: high, votes 3-0 x4)

Hocuspocus is the batteries-included Yjs WebSocket server (auth hooks, database extension). It documents two distinct scaling paths:

- **`extension-redis`** is for **high availability** and for too many connections / too much network traffic. It fans document updates and awareness across instances behind a load balancer via Redis pub/sub. **Every message is processed on every instance holding that document, so it does not reduce CPU load.** Quote: "if you are trying to reduce cpu load by spawning multiple servers, you should not connect them via Redis."
- For **CPU / memory limits** the maintainers' current recommendation is **sharding**: run independent, non-Redis-connected instances and route users by document / board ID.
- The Redis extension does **not persist data**; pair it with `extension-database`.
- The scalability guide is incomplete (contains a `TODO`).
- **Data-loss bug:** versions before the September 2026 fix for issue #1151 (PR #1152, per-instance reply channels) lost data with 3+ replicas (seen on v4.4.0 / v4.6.0). **Pin a patched release.**

Sources:
- https://tiptap.dev/docs/hocuspocus/guides/scalability
- https://tiptap.dev/docs/hocuspocus/server/extensions/redis
- https://github.com/ueberdosis/hocuspocus/blob/main/packages/extension-redis/src/Redis.ts
- https://github.com/ueberdosis/hocuspocus/issues/1151

### 4.3 WebRTC

No verified claim covered WebRTC vs WebSocket trade-offs for this size. Neither Excalidraw nor tldraw uses WebRTC for document sync. A full mesh of 40 peers would be 780 connections; a client-server WebSocket topology is the evidence-backed default.

---

## 5. Recommended build plan

1. **Partition state into three scopes from day one** (document / session / presence, per section 3.3). Presence never enters persistence or undo.
2. **Pick the document model deliberately.**
   - *Yjs route:* one nested `Y.Map` per element with per-property keys; `Y.Array` or fractional index for z-order; `Y.UndoManager` with `trackedOrigins` for per-user undo; a separate JS undo stack for non-document state; images as external assets.
   - *Element-LWW route:* copy Excalidraw's `reconcile.ts` (MIT, ~100 lines): ID-union merge, `isDeleted` tombstones, `version` + `versionNonce`. Whole elements stay self-consistent; concurrent edits to different properties of one element lose one side.
3. **Use WebSocket client-server, not WebRTC.** All clients connect to one authoritative process per board. Hocuspocus (with `extension-database`) or y-websocket. Throttle cursor / awareness broadcasts to ~20 Hz.
4. **Run one node per board; shard by board ID.** Add `extension-redis` only for high availability. Pin a Hocuspocus release that includes the #1151 fix.
5. **Build the three.js layer as a thin renderer over the document.** Observe `Y.Doc` (or reconciled element array) changes and diff into meshes. Orthographic camera for pan / zoom. Instanced meshes for shapes and stickies; batch freehand strokes into merged geometry; viewport culling. Render text with `troika-three-text` and gate visibility on its `sync()` callback.
6. **Prototype the in-canvas text editor and export first.** These are the two areas with no evidence-backed path and the highest chance of forcing an architecture change. If 500+ text objects on screen is realistic for your boards, benchmark three.js against a 2D canvas before committing.

---

## 6. Open questions the research could not settle

1. Practical element-count and text-instance ceiling for a three.js whiteboard, and whether a batched WebGL renderer actually outperforms 2D canvas with viewport culling for typical Miro-style boards.
2. Element-level LWW with `versionNonce` / rebase vs Yjs per-property `Y.Map`s, benchmarked against each other on whiteboard data.
3. Concrete server resource requirements (CPU, memory, bandwidth, awareness-message rate at 40 cursors) for one node serving one 40-user board, and when document size / update history forces Yjs snapshot compaction.
4. Representation of freehand strokes, connectors bound to shapes, and PNG / SVG / PDF export such that they survive both the sync layer and the three.js scene graph.

---

## 7. Refuted claims (kept for transparency)

| Claim | Vote | Why it failed |
|---|---|---|
| Excalidraw's relay server stores no state and does no centralized coordination | 1-2 | Firestore persists encrypted scenes; relay is not the only stateful component |
| `Y.UndoManager` removes the need for an app-side undo stack | 1-2 | Non-document app state still needs a JS history stack |
| Canvas 2D is the default and WebGL is only warranted at tens of thousands of elements | 0-3 | Not supported by the cited source; rendering question remains open |

---

## 8. Time-sensitive facts

- tldraw license terms and pricing changed September 2025 and could change again.
- Hocuspocus multi-instance Redis data-loss bug fixed only September 2026.
- `y-redis` superseded by `@y/hub` (beta).
- `troika-three-text` current as of 0.52.5 (July 2026).

## 9. All sources consulted

Primary
- https://github.com/protectwise/troika/blob/main/packages/troika-three-text/README.md
- https://plus.excalidraw.com/blog/building-excalidraw-p2p-collaboration-feature
- https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/data/reconcile.ts
- https://github.com/excalidraw/excalidraw/blob/master/excalidraw-app/collab/Portal.tsx
- https://tldraw.dev/features/composable-primitives/multiplayer-collaboration
- https://tldraw.dev/features/composable-primitives/data-management
- https://tldraw.dev/sdk-features/store
- https://tldraw.dev/docs/sync
- https://tldraw.dev/starter-kits/multiplayer
- https://github.com/tldraw/tldraw-sync-cloudflare
- https://github.com/tldraw/tldraw/blob/main/packages/sync-core/src/lib/TLSyncClient.ts
- https://github.com/tldraw/tldraw/blob/main/packages/store/src/lib/RecordType.ts
- https://github.com/tldraw/tldraw/blob/main/LICENSE.md
- https://tldraw.dev/community/license
- https://tldraw.dev/sdk-features/license-key
- https://tldraw.dev/blog/tldraw-sdk-4-0
- https://github.com/alkem-io/excalidraw-yjs
- https://docs.yjs.dev/api/undo-manager
- https://github.com/yjs/yjs/blob/main/src/utils/UndoManager.js
- https://docs.yjs.dev/ecosystem/connection-provider/y-websocket
- https://github.com/yjs/y-websocket
- https://github.com/yjs/yhub
- https://tiptap.dev/docs/hocuspocus/guides/scalability
- https://tiptap.dev/docs/hocuspocus/server/extensions/redis
- https://github.com/ueberdosis/hocuspocus/blob/main/packages/extension-redis/src/Redis.ts

Forum / issues
- https://github.com/protectwise/troika/issues/117
- https://github.com/excalidraw/excalidraw/issues/3537
- https://github.com/excalidraw/excalidraw/issues/10063
- https://github.com/yjs/yjs/issues/273
- https://github.com/ueberdosis/hocuspocus/issues/1151
- https://discuss.yjs.dev/t/awareness-update-causes-n-2-messages-which-leads-cpu-issue-on-server/2496
- https://discuss.yjs.dev/t/which-pub-sub-service-to-horizontally-scale-y-websocket/1550
- https://github.com/RahulBadenkal/y-excalidraw

Secondary / blogs (lower weight)
- https://github.com/royalpinto007/awesome-whiteboard
- https://github.com/mizuka-wu/excalidraw-yjs-starter
- https://kanopylabs.com/blog/yjs-vs-automerge-vs-liveblocks
- https://kanopylabs.com/blog/how-to-build-a-real-time-collaboration-whiteboard-app
- https://blog.kevinjahns.de/are-crdts-suitable-for-shared-editing
- https://bloggeek.me/how-many-users-webrtc-call/
- https://velt.dev/blog/yjs-websocket-server-real-time-collaboration
