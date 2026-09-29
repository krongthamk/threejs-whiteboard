# Build Plan: Collaborative three.js Whiteboard

**Date:** 2026-09-29
**Source:** [RESEARCH.md](./RESEARCH.md) (2026-09-29). Section references below (e.g. R§3.4) point into that report.
**Target:** self-hosted, infinite-canvas whiteboard rendered with three.js; freehand, shapes, text, sticky notes, connectors, selection/transform, pan/zoom, undo/redo, export; real-time collaboration for up to 40 concurrent users per board.

**Accepted deployment/benchmark target (2026-09-29):** the user selected this Mac as the initial deployment and benchmark target: Apple M1 Pro, 8 logical cores, 32 GiB memory. This replaces the hardware reference to a “2020-class laptop” in S1 and supplies the initial Phase 5 deployment target. All numeric gates remain unchanged; results must identify this hardware and must not imply validation of another machine.

---

## 1. Decisions locked by the research

These are settled. Re-open only if a Phase 0 spike fails its exit criterion.

| # | Decision | Choice | Why (evidence) |
|---|---|---|---|
| D1 | Do not build on the tldraw SDK | Reference architecture only | tldraw ≥ v4 is source-available; a self-hosted team board is a Production Environment and needs a paid key (R§2.2). Excalidraw is MIT and may be copied from. |
| D2 | Three state scopes from day one | `document` / `session` / `presence` | Presence must never enter persistence or undo history (R§3.3). |
| D3 | Document model — amended after S3 failure | Yjs `Y.Doc`; writer-owned `YKeyValue` arrays of stamped, generation-scoped per-property registers, with the coherent-value rule (§3.2) | Nested maps retain growing metadata under the fixed-board S3 workload, including after snapshot reload. Writer partitioning plateaued through 360,000 diagnostic edits and targeted history/offline tests pass. Native local undo is retained, but requires an explicit clock-preservation adapter. Full replacement fuzz and transport acceptance remain mandatory; see §9. |
| D4 | Transport | WebSocket client-server, one authoritative process per board | Neither reference engine uses WebRTC; 40-peer mesh = 780 connections (R§4.3). |
| D5 | Sync server | Hocuspocus + `extension-database`, pinned to a release containing the #1151 fix | Auth hooks and persistence built in (R§4.2). Pre-fix versions lose data with ≥3 replicas. |
| D6 | Scaling model | Shard by board ID; one node owns a board; no Redis until HA is required | Redis fan-out does not reduce CPU; maintainers recommend sharding for CPU limits (R§4.2). One node is enough for 40 users on one board (R§4.1). |
| D7 | Text rendering and editing — editing fallback selected in S4 | `troika-three-text` (0.52.x) for display; native DOM `contenteditable` overlay for editing; shipped `.woff`/`.ttf`, never `.woff2` | Troika supplies layout/caret geometry; the DOM supplies native selection, clipboard and IME. S4's allowed fallback passed the mixed Latin fixture, native input flows and extended Japanese font/export verification. |
| D8 | Renderer is a thin projection of the document | Observe `Y.Doc` → diff → meshes; renderer holds no authoritative state | Required so sync, undo and export all operate on one model (R§5 step 5). |
| D9 | Export serialises from the document, not the scene graph | PNG via offscreen three.js render; SVG/PDF via a document→SVG serialiser | No evidence-backed path for exporting a three.js scene graph (R§2.4, R§6.4). Model-driven SVG sidesteps it. |
| D10 | Presence broadcast rate | Awareness throttled to 20 Hz per client | R§5 step 3. |

## 2. Open questions and how each is closed

The research left four open questions (R§6). Each gets a time-boxed spike in Phase 0 with a numeric exit criterion. A failed spike changes the plan; a passed spike freezes the decision.

| Question (R§6) | Spike | Exit criterion | If it fails |
|---|---|---|---|
| Q1 three.js vs Canvas 2D at realistic board sizes | S1 Renderer benchmark | ≥ 55 fps while panning a board of 5,000 shapes + 2,000 strokes + 500 text objects on a 2020-class laptop; ≥ 30 fps at 20,000 shapes | Ship a Canvas 2D renderer behind the same `Renderer` interface; keep everything else. |
| Q1b troika ceiling at 500+ text instances | S1 (same harness) | 500 visible text meshes ≥ 55 fps; culling brings 5,000 off-screen texts to zero cost | Render text via a glyph-atlas `InstancedMesh` of our own, or rasterise text to `CanvasTexture` sprites at low zoom. |
| Q2 Yjs per-property vs element-LWW | S2 Model fuzz test | 10,000 random concurrent op pairs across 3 simulated clients converge with zero semantically invalid elements under the coherence rule | Switch D3 to element-LWW (copy `reconcile.ts`). |
| Q3 Server cost for 40 users | S3 Load test | 40 headless clients drawing at 5 ops/s + 20 Hz cursors on one node: p95 op round-trip < 150 ms, CPU < 70 % of one core, memory growth flat over 30 min | Tune awareness rate, batch updates, or split awareness onto its own channel. |
| Q4 Strokes, bound connectors, export representation | S4 Text editor + export prototype | Caret, selection, IME input work inside a troika text; PNG at 2× and SVG of a mixed board round-trip visually | Fall back to a DOM `contenteditable` overlay positioned over the canvas for editing. |

## 3. Architecture

### 3.1 Runtime topology

```
Browser                                   Server (one process per shard)
┌──────────────────────────────┐          ┌──────────────────────────────┐
│ UI chrome (React)            │          │ Hocuspocus                   │
│ Tools / input controller     │  WS      │  onAuthenticate  → board ACL │
│ Session store (camera, tool) │◄────────►│  extension-database → SQLite │
│ Y.Doc (document scope)       │          │       or Postgres            │
│ Awareness (presence scope)   │          │  awareness relay             │
│ Renderer: three.js ortho cam │          └──────────────────────────────┘
│ Hit-test index (rbush)       │          Router: board_id → shard (consistent hash)
│ Export: PNG (three) SVG (doc)│          Asset store: images (S3-compatible / disk)
└──────────────────────────────┘
```

### 3.2 Document schema (Yjs)

```
doc.getMap('meta')       { title, createdAt, schemaVersion }
doc.getArray('element-properties:' + writerId)
  → YKeyValue<StampedValue> for this writer's element lifecycle and property registers
```

Every projected element has these logical fields. Storage uses an immutable complete base plus generation-scoped property overrides; callers use `BoardDocument`, not raw CRDT containers:

| Key | Type | Notes |
|---|---|---|
| `id` | string | nanoid |
| `type` | `'rect' \| 'ellipse' \| 'sticky' \| 'text' \| 'stroke' \| 'connector' \| 'image'` | |
| `x`, `y`, `w`, `h` | number | axis-aligned box in world units |
| `rotation` | number | radians |
| `index` | string | fractional index for z-order (`fractional-indexing`); no `Y.Array` for ordering |
| `style` | JSON | `{ stroke, fill, strokeWidth, opacity, fontFamily, fontSize, ... }` — written as one value |
| `props` | JSON | type-specific payload, written as one value (see below) |

**Coherence rule (answers R§3.4's "semantically inconsistent elements" qualification):** any set of fields that must agree with each other lives under a single key and is always written together. Concretely:

- `stroke.props = { points: number[] /* flat x,y,pressure */ , simplified: boolean }`. `x/y/w/h` are derived on read, never trusted for geometry.
- `text.props = { text: string, align, autoSize }`. `w/h` are trusted only when `autoSize` is false.
- `connector.props = { start: Binding, end: Binding, kind: 'straight' | 'elbow' | 'curve' }` where `Binding = { elementId, nx, ny } | { x, y }` (normalised anchor on the bound element or a free point). Endpoints resolve at render time, so moving a bound shape needs no extra sync.
- `image.props = { assetId, naturalW, naturalH }`. Bytes live in the asset store (R§3.4: images are external assets).

Independent fields stay separate keys so concurrent move (`x`,`y`) and recolor (`style`) both survive.

Each register carries `{ clock, actor }` and a JSON value. The greatest Lamport clock wins, with actor ID breaking ties. A lifecycle register selects the complete base/generation or a deletion marker. A replacement generation ignores the old generation's overrides. Each writer modifies only its own array, preserving Yjs's adjacent-history compression and allowing undo to reveal a peer's register. Deleted generations and retired writers remain available for offline merging and local history; repeated-edit boundedness does not imply unlimited lifecycle churn is free.

Deletion writes a null lifecycle value. Connectors bound to a missing element degrade to their captured resolved free point; known bindings are detached in the deletion gesture. No document reset or epoch replacement may discard offline updates during compaction.

### 3.3 Session scope (not synced, optionally persisted to localStorage)

Camera `{ x, y, zoom }`, active tool, tool options, panel state, snap settings. Plain store (zustand). Undo for this scope, if any, is a small JS stack separate from `Y.UndoManager` (R§7 refuted claim 2).

### 3.4 Presence scope (Yjs awareness)

`{ userId, name, color, cursor: {x,y} | null, selection: string[], editingTextId: string | null, viewport?: Box }`. Throttled to 20 Hz, sent only on change. Rendered in a dedicated `presence` group in the scene, never written to the document.

### 3.5 Undo/redo

`new Y.UndoManager(ownWriterArray, { trackedOrigins: new Set([LOCAL_ORIGIN]), captureTimeout: 0, deleteFilter })`. Every local write goes through `doc.transact(fn, LOCAL_ORIGIN)`; one gesture (a drag, a stroke, a text commit) is exactly one transaction and one undo step. The monotonic clock ledger is part of that transaction and is preserved across undo/redo. An adapter isolates its Yjs Item before undo, using pinned Yjs 13.6.33 low-level exports, so `deleteFilter` excludes only the clock. Regression coverage is required when changing that pin. Undo/redo restores the original causal stamps, so it cannot overwrite a causally newer peer change. Remote changes arrive under the provider origin and are never tracked as this user's gestures.

### 3.6 Renderer

- `OrthographicCamera`; pan/zoom mutate the camera only. World units = document units. Zoom range 2 %–6400 %.
- Layer groups, in draw order: `grid`, `shapes`, `strokes`, `text`, `connectors`, `selectionUI`, `presence`.
- **Shapes and stickies:** one `InstancedMesh` per (type, material variant) with per-instance colour attributes. A rounded-rect SDF fragment shader gives fills, borders and corners without per-shape geometry.
- **Strokes:** `perfect-freehand` produces the outline polygon; `THREE.ShapeUtils.triangulateShape` (earcut) tessellates it. Strokes are packed into merged `BufferGeometry` chunks of ~256 strokes each; editing a stroke rewrites only its chunk. Live drawing uses a separate dynamic geometry until pointer-up.
- **Text:** one troika `Text` per text/sticky element. Visibility is gated on `sync()` completion; a placeholder box is shown until then. Frustum culling and a distance-based LOD (hide text below ~6 px on screen) keep the instance count in check.
- **Connectors:** line geometry rebuilt when either endpoint's element changes; arrowheads from a shared instanced mesh.
- **Diffing:** document adapter observes writer registers → per-element dirty set → one flush per frame. The renderer keeps a `Map<id, RenderHandle>` and never reads back from the scene.
- **Hit testing:** not via raycasting. An `rbush` R-tree over element AABBs in world space, then a precise per-type test (point-in-rotated-rect, distance-to-polyline, troika `getCaretAtPoint` for text). The same index drives viewport culling and marquee selection.

### 3.7 Export

- **PNG:** clone the camera, fit to selection or content bounds, render to a `WebGLRenderTarget` at the requested scale, `readRenderTargetPixels` → canvas → blob. Tiles for exports over the max texture size.
- **SVG:** a pure function `documentToSvg(elements, options)` walking the schema in `index` order. Strokes emit the tessellated outline as a `<path>`; text emits `<text>` with embedded `@font-face`. Nothing touches three.js.
- **PDF:** SVG → PDF in the browser via `svg2pdf.js` + `jspdf`, or server-side via headless Chromium if fidelity demands it. Decide in Phase 4 based on S4 output.

### 3.8 Server

- Hocuspocus with `extension-database` (SQLite via `better-sqlite3` for single-node; Postgres when sharding). `fetch`/`store` hooks persist the encoded update log; compaction to a fresh `Y.encodeStateAsUpdate` snapshot when the log exceeds 5 MB or 10,000 updates.
- `onAuthenticate`: verify a signed session token; look up board membership; `readOnly` for viewers.
- A thin router (nginx `hash $board_id consistent` or a Node proxy) maps `board_id → shard`. Single shard in Phases 1–4; router introduced in Phase 5.
- Asset service: presigned PUT/GET to S3-compatible storage; images are never inlined in the `Y.Doc`.

## 4. Stack and pins

| Concern | Choice |
|---|---|
| Language / build | TypeScript, Vite, pnpm workspace |
| Packages | `packages/model` (schema, Yjs helpers, undo, SVG export), `packages/renderer` (three.js), `packages/app` (React chrome + tools), `packages/server` (Hocuspocus), `packages/loadtest` (headless clients) |
| Rendering | `three` (current stable), `troika-three-text` ≥ 0.52.5 |
| Collaboration | `yjs` ≥ 13.6, `@hocuspocus/server` + `@hocuspocus/provider` + `@hocuspocus/extension-database` — **pin to a release containing PR #1152 (issue #1151 fix, Sept 2026)** |
| Document register storage | `y-utility` **0.1.4**, with Yjs **13.6.33** pinned for the clock/undo adapter; no nested shared values inside key-value records |
| Geometry | `perfect-freehand`, `rbush`, `fractional-indexing`, `nanoid` |
| Fonts | Inter + a mono face, shipped as `.woff` (troika does not read `.woff2`) |
| UI chrome | React 19, zustand for session scope |
| Testing | Vitest (model fuzz), Playwright (editor flows, visual export snapshots), custom load harness |

## 5. Phases

Each phase ends with a demo and its exit criteria met. Estimates assume one to two engineers.

### Phase 0 — De-risk spikes (2 weeks)

Run S1–S4 from §2 in parallel as throwaway code. Deliverables: a benchmark report, a model fuzz suite that becomes a permanent test, a text-editing prototype, a PNG/SVG export prototype. **Gate:** all four exit criteria met, or the affected decision in §1 is amended before Phase 1 starts.

### Phase 1 — Single-user core (3 weeks)

1. Workspace scaffold, schema in `packages/model`, `Y.Doc` in-memory only.
2. Renderer: orthographic camera, pan (space-drag, wheel, trackpad), zoom about cursor, grid.
3. Shapes: rect, ellipse, sticky (instanced). Create, move, resize with handles, rotate.
4. Selection: click, shift-click, marquee; `rbush` index; selection outline and handles in `selectionUI` layer.
5. Undo/redo via `Y.UndoManager`, one transaction per gesture.
6. Keyboard: delete, duplicate, arrow nudge, z-order (bring forward / send back via fractional index).
7. Session persistence of camera to localStorage.

**Exit:** 5,000 shapes pan/zoom at ≥ 55 fps; every mutation is undoable; no renderer state survives a hard document reload.

### Phase 2 — Freehand, text, connectors (3 weeks)

1. Freehand tool: pressure-aware, `perfect-freehand` outline, chunked geometry, eraser (whole-stroke).
2. Text tool and sticky text: in-canvas editor from S4 (caret, selection rects, IME, clipboard, auto-size), font loading with `.woff`, `sync()`-gated visibility, LOD hiding.
3. Connectors: straight and elbow; snapping to shape anchors; bindings resolved at render time; re-route when a bound shape moves or is deleted.
4. Style panel: stroke/fill/width/opacity/font.

**Exit:** 2,000 strokes + 500 texts on screen within the S1 budget; text editing passes the Playwright flow suite (type, select, cut/paste, IME composition, blur commits one undo step).

### Phase 3 — Collaboration (3 weeks)

1. `packages/server`: Hocuspocus, SQLite persistence, `onAuthenticate` with signed tokens, board create/list API.
2. Client provider wiring; offline queue and reconnect; conflict smoke tests with two browsers.
3. Presence: cursors with names, remote selections, "someone is editing this text" lock indicator (soft lock via awareness `editingTextId`, last committer wins).
4. Per-user undo verified across two clients (undo never reverts a peer's change).
5. Model fuzz suite from S2 extended to run against a live server.

**Exit:** two clients converge under the fuzz harness; reconnect after 30 s offline loses no local edits; undo isolation holds.

### Phase 4 — Export, images, polish (2 weeks)

1. PNG export (selection / page, 1×–4×, transparent background option).
2. SVG export from the document serialiser; PDF via svg2pdf or server render.
3. Image elements: drag-drop / paste → asset upload → element referencing `assetId`; thumbnail texture in three.js.
4. Copy/paste between boards (clipboard carries element JSON + asset references).
5. Minimap and zoom-to-fit.

**Exit:** visual snapshot tests compare PNG and SVG exports of a fixture board against the on-screen render within a tolerance.

### Phase 5 — Scale and operate (2–3 weeks)

1. `packages/loadtest`: 40 headless clients (Node `ws` + `yjs`) drawing and moving cursors; run S3 against a staging node and record CPU, memory, bandwidth, awareness message rate (fills R§6.3).
2. Snapshot compaction and update-log GC; measure load time for a 6-month-old busy board.
3. Sharding router by board ID; health checks; graceful drain on deploy.
4. Observability: per-board connection count, update rate, awareness rate, persistence latency.
5. Backups and restore drill for the persistence store.
6. Optional: `extension-redis` for HA only if uptime targets require it, on the pinned post-#1151 release.

**Exit:** S3 criteria met on the deployment target; a board with 100,000 historical updates loads in < 2 s after compaction.

## 6. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| troika per-instance cost caps visible text well below Miro-scale boards | Medium | High | S1 measures it; LOD hiding and culling first; atlas-instanced fallback second; Canvas 2D fallback last. |
| In-canvas text editing (IME, mobile keyboards, accessibility) is a rabbit hole | High | High | S4 first; DOM `contenteditable` overlay fallback is designed in from the start (same commit path into the doc). |
| Per-property merge yields invalid elements | Low with coherence rule | High | S2 fuzz suite runs in CI forever; fallback to element-LWW. |
| Hocuspocus data loss on multi-instance | Low if pinned | Critical | Pin release ≥ #1151 fix; run single-node until Phase 5; test HA with 3 replicas before enabling. |
| 40-user figure unverified for our payloads | Medium | Medium | S3 load test in Phase 5 with real op mix; awareness throttling knobs. |
| Freehand geometry bloat (thousands of strokes → large doc) | Medium | Medium | Store simplified input points, not tessellated triangles; compaction; per-board size alerts. |
| Licence drift (tldraw terms, `@y/hub` AGPL) | Low | Medium | Never import tldraw packages; avoid `@y/hub`; audit `pnpm licenses` in CI. |
| Export fidelity between WebGL and SVG diverges | Medium | Low | Shared style/geometry helpers in `packages/model`; snapshot tests in Phase 4. |

## 7. Out of scope for v1

Comments and threads, version history UI, templates library, mobile-native apps, video/audio, AI features, public/anonymous boards, WebRTC transport, tldraw or Excalidraw component embedding.

## 8. Facts to re-check before Phase 3 and Phase 5

- Hocuspocus latest release still contains the #1151 fix and no regressions (R§8).
- `troika-three-text` version and `.woff2` support status (R§2.1).
- tldraw licence terms, only insofar as we copy patterns, not code (R§2.2).
- `@y/hub` licence and stability if HA beyond Redis is ever needed (R§4.1).

## 9. Execution amendments

Changes to a locked decision require the failed spike and replacement evidence to be recorded here. The target override above is the user's explicit instruction.

On 2026-09-29, S3's original nested-map run failed retained-memory and final synchronization gates. D3 is amended to the writer-owned register design described above. Evidence: 360,000 diagnostic edits plateau at 4,120 retained structs (2,040 deleted) from 10,000 edits onward; ten targeted history/offline/lifecycle/collision tests pass. The full replacement and integrated-model 10,000-pair fuzz suites have passed; the full candidate 30-minute transport run passed; the final exact-source authenticated SQLite production run also passed the unchanged Phase 5 gates (360,000 acknowledgements, p95 36.89 ms, CPU maximum 40.73%, reviewed fixed-workload memory plateau). [D3_STORAGE_INVESTIGATION.md](D3_STORAGE_INVESTIGATION.md) records the failed alternatives, low-level dependency, and measured lifecycle-retention limits. This is a change of implementation design, not a declaration that S3 passed.

S4 selects its planned DOM editing fallback. Troika remains the display/export projection; a local native editor commits once per gesture. The additional Japanese glyph/export checks passed alongside the mixed fixture and native input flows; S4 artifacts record the measured tolerances and negative controls.

These explicit failed-spike amendments satisfy Phase 0's decision-amendment exception so Phase 1 can proceed against the stable document API while replacement acceptance tests finish. No unfinished spike, later phase, or deployment acceptance criterion is waived. The original production model is replaced only after the replacement semantic suite passes; renderer and editor checks then run against the integrated model.
